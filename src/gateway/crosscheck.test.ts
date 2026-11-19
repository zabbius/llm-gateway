/**
 * The startup route cross-check contracts (specs/domains/routing.md
 * "Startup route inventory"): a pure, three-state verdict per configured
 * route against the retained startup catalogs — "matched" when the catalog
 * lists the model, "missing" when an ok upstream's catalog does not, and
 * "unknown" whenever there is no catalog to compare against (failed probe,
 * no retained snapshot, or an id absent from the statuses). The verdicts are
 * computed in config order from frozen inputs and freeze their output.
 */
import { describe, expect, test } from "bun:test";
import type { ModelConfig, ModelRouteConfig } from "../config/schema.ts";
import type { UpstreamStatus, ModelEntry } from "../upstreams/upstream.ts";
import { crossCheckRoutes, type RouteHealthEntry } from "./crosscheck.ts";

/** A frozen ok status with the given retained catalog (the registry's shape). */
function ok(id: string, modelIds: string[]): UpstreamStatus {
  const models: ModelEntry[] = modelIds.map((modelId) => ({
    id: modelId,
    object: "model",
    created: 1,
    owned_by: "system",
  }));
  return Object.freeze({
    id,
    type: "openai-compatible",
    probe: "ok",
    models: Object.freeze(models.map((model) => Object.freeze(model))),
  });
}

/** A frozen failed status — the registry retains no catalog for these. */
function failed(id: string, reason = "connection refused"): UpstreamStatus {
  return Object.freeze({ id, type: "openai-compatible", probe: "failed", reason });
}

/** An ok status with no retained snapshot (an upstream that keeps none). */
function okWithoutCatalog(id: string): UpstreamStatus {
  return Object.freeze({ id, type: "openai-compatible", probe: "ok" });
}

/** A minimal models-block entry: one alias over the given routes. */
function alias(name: string, routes: Array<{ upstream: string; model: string }>): ModelConfig {
  return {
    alias: name,
    routes: routes.map((route): ModelRouteConfig => ({ upstream: route.upstream, model: route.model })),
    balance: { strategy: "round-robin" },
  };
}

describe("crossCheckRoutes", () => {
  test("matched: the ok upstream's retained catalog lists the route's model", () => {
    const verdicts = crossCheckRoutes([alias("smart", [{ upstream: "openai", model: "gpt-4o" }])], [
      ok("openai", ["gpt-4o", "gpt-4o-mini"]),
    ]);
    expect([...verdicts]).toEqual([
      { alias: "smart", upstream: "openai", model: "gpt-4o", health: "matched" },
    ]);
  });

  test("missing: an ok upstream's catalog exists but does not list the model", () => {
    const verdicts = crossCheckRoutes([alias("smart", [{ upstream: "openai", model: "gpt-5-turbo" }])], [
      ok("openai", ["gpt-4o", "gpt-4o-mini"]),
    ]);
    expect([...verdicts]).toEqual([
      { alias: "smart", upstream: "openai", model: "gpt-5-turbo", health: "missing" },
    ]);
  });

  test("unknown: a failed probe retains no catalog — no per-route verdict beyond unknown", () => {
    const verdicts = crossCheckRoutes([alias("local", [{ upstream: "vllm", model: "qwen2.5:7b" }])], [
      failed("vllm", 'upstream "vllm" is unreachable: timeout'),
    ]);
    expect([...verdicts]).toEqual([
      { alias: "local", upstream: "vllm", model: "qwen2.5:7b", health: "unknown" },
    ]);
  });

  test("unknown: an ok upstream that retained no snapshot, and an id absent from the statuses", () => {
    const verdicts = crossCheckRoutes(
      [
        alias("a", [{ upstream: "silent", model: "m1" }]),
        alias("b", [{ upstream: "ghost", model: "m2" }]),
      ],
      [okWithoutCatalog("silent")], // "ghost" never appears — defensive
    );
    expect([...verdicts]).toEqual([
      { alias: "a", upstream: "silent", model: "m1", health: "unknown" },
      { alias: "b", upstream: "ghost", model: "m2", health: "unknown" },
    ]);
  });

  test("every route of every alias gets a verdict, in config order", () => {
    const verdicts = crossCheckRoutes(
      [
        alias("smart", [
          { upstream: "openai", model: "gpt-4o" },
          { upstream: "vllm", model: "qwen2.5:7b" },
        ]),
        alias("cheap", [{ upstream: "openai", model: "gpt-4o-mini" }]),
      ],
      [ok("openai", ["gpt-4o", "gpt-4o-mini"]), failed("vllm")],
    );
    expect(verdicts.map((verdict) => `${verdict.alias}:${verdict.upstream}:${verdict.health}`)).toEqual([
      "smart:openai:matched",
      "smart:vllm:unknown",
      "cheap:openai:matched",
    ]);
  });

  test("empty models block — no routes, no verdicts", () => {
    expect([...crossCheckRoutes([], [ok("openai", ["gpt-4o"])])]).toEqual([]);
  });

  test("the output is frozen: entries and the list itself", () => {
    const verdicts = crossCheckRoutes([alias("smart", [{ upstream: "openai", model: "gpt-4o" }])], [
      ok("openai", ["gpt-4o"]),
    ]);
    expect(Object.isFrozen(verdicts)).toBe(true);
    expect(Object.isFrozen((verdicts as readonly RouteHealthEntry[])[0])).toBe(true);
  });
});
