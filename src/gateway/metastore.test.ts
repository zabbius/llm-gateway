/**
 * MetadataStore contracts (specs/domains/routing.md "Alias metadata"):
 * startup seeding from ok probes only, wholesale snapshot replacement on a
 * successful discovery, retain-last-good on a failed one, and frozen slices
 * handed out to consumers.
 */
import { describe, expect, test } from "bun:test";
import type { ModelEntry, UpstreamStatus } from "../upstreams/upstream.ts";
import { MetadataStore } from "./metastore.ts";

/** One raw listing entry, the way an upstream reports it. */
function entry(id: string, contextLength?: number): ModelEntry {
  return contextLength === undefined
    ? { id, object: "model", created: 1, owned_by: "provider" }
    : { id, object: "model", created: 1, owned_by: "provider", context_length: contextLength };
}

/** One retained startup-probe outcome. */
function status(id: string, probe: "ok" | "failed", models?: ModelEntry[]): UpstreamStatus {
  const base: UpstreamStatus = { id, type: "openai-compatible", probe, ...(probe === "failed" ? { reason: "boom" } : {}) };
  return models === undefined ? base : { ...base, models: Object.freeze(models) };
}

describe("MetadataStore", () => {
  test("seed folds in the catalogs of ok probes that retained one", () => {
    const store = new MetadataStore();
    store.seed([
      status("a", "ok", [entry("m1"), entry("m2")]),
      status("b", "ok"), // ok but no retained catalog — seeds nothing
      status("c", "failed"), // failed probe — seeds nothing
      status("d", "failed", [entry("m3")]), // defensively: a failure carries no usable catalog
    ]);
    expect(store.entries("a").map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(store.entries("b")).toEqual([]);
    expect(store.entries("c")).toEqual([]);
    expect(store.entries("d")).toEqual([]);
    expect(store.entries("never-seeded")).toEqual([]);
  });

  test("seeded snapshots are frozen and detached from the status they came from", () => {
    const models = [entry("m1")];
    const store = new MetadataStore();
    store.seed([status("a", "ok", models)]);
    const snapshot = store.entries("a");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    // A copy, not the status's (already frozen) array — the store owns its slice.
    expect(snapshot).not.toBe(models);
    expect(store.entries("a")).toHaveLength(1);
  });

  test("a successful set replaces the snapshot wholesale and returns true", () => {
    const store = new MetadataStore();
    store.seed([status("a", "ok", [entry("old"), entry("gone")])]);
    expect(store.set("a", [entry("fresh")])).toBe(true);
    expect(store.entries("a").map((model) => model.id)).toEqual(["fresh"]);
  });

  test("a successful set with an empty listing replaces too — zero models is a fact", () => {
    const store = new MetadataStore();
    store.seed([status("a", "ok", [entry("m1")])]);
    expect(store.set("a", [])).toBe(true);
    expect(store.entries("a")).toEqual([]);
  });

  test("a failed set mutates nothing — retain-last-good", () => {
    const store = new MetadataStore();
    store.seed([status("a", "ok", [entry("good")])]);
    expect(store.set("a", undefined)).toBe(false);
    expect(store.entries("a").map((model) => model.id)).toEqual(["good"]);
  });

  test("a failed set on an unknown upstream stays unknown — nothing to retain", () => {
    const store = new MetadataStore();
    expect(store.set("a", undefined)).toBe(false);
    expect(store.entries("a")).toEqual([]);
  });

  test("an unseeded upstream's first successful set installs its snapshot", () => {
    const store = new MetadataStore();
    expect(store.set("a", [entry("m1")])).toBe(true);
    expect(store.entries("a").map((model) => model.id)).toEqual(["m1"]);
  });

  test("set snapshots are frozen and detached from the listing handed in", () => {
    const store = new MetadataStore();
    const listing = [entry("m1")];
    store.set("a", listing);
    const snapshot = store.entries("a");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    listing.push(entry("injected"));
    expect(store.entries("a")).toHaveLength(1);
  });

  test("re-seeding over a replaced snapshot applies the seed's outcome per upstream", () => {
    const store = new MetadataStore();
    store.seed([status("a", "ok", [entry("old")])]);
    store.set("a", [entry("re-discovered")]);
    store.seed([status("a", "failed")]);
    expect(store.entries("a").map((model) => model.id)).toEqual(["re-discovered"]);
  });
});
