/**
 * Alias-metadata builder contracts (specs/domains/routing.md "Alias
 * metadata"): per-route detection over the store's snapshots, the
 * element-wise minimum per dimension with the manual `limits` folded in,
 * the strict capability AND, no entry for an alias with no known dimension,
 * and a frozen output table.
 */
import { describe, expect, test } from "bun:test";
import type { ModelConfig } from "../config/schema.ts";
import type { ModelEntry } from "../upstreams/upstream.ts";
import { buildAliasMetadata } from "./aliasmeta.ts";
import { MetadataStore } from "./metastore.ts";

/** A full aggregator-style listing entry; every capability declared true unless overridden. */
function aggregatorEntry(
  id: string,
  context: number,
  output: number,
  flags: { tools?: boolean; reasoning?: boolean; temperature?: boolean; attachment?: boolean } = {},
): ModelEntry {
  return {
    id,
    object: "model",
    created: 1,
    owned_by: "provider",
    limit: { context, output },
    capabilities: {
      tools: { supported: flags.tools ?? true },
      reasoning: { supported: flags.reasoning ?? true },
      temperature: flags.temperature ?? true,
    },
    modalities: { input: (flags.attachment ?? true) ? ["text", "image/png"] : ["text"], output: ["text"] },
  };
}

/** A bare OpenAI-standard listing entry: context only, no capabilities. */
function standardEntry(id: string, context: number): ModelEntry {
  return { id, object: "model", created: 1, owned_by: "provider", context_length: context };
}

/** An entry no detector matches — no known dimension. */
function opaqueEntry(id: string): ModelEntry {
  return { id, object: "model", created: 1, owned_by: "provider" };
}

/** One `models` config entry. */
function aliasEntry(
  alias: string,
  routes: { upstream: string; model: string }[],
  limits?: { context?: number; output?: number },
): ModelConfig {
  return {
    alias,
    routes,
    balance: { strategy: "round-robin" },
    ...(limits === undefined ? {} : { limits }),
  };
}

/** A store seeded exactly like the startup pipeline seeds it. */
function seeded(...upstreams: { id: string; models: ModelEntry[] }[]): MetadataStore {
  const store = new MetadataStore();
  store.seed(
    upstreams.map(({ id, models }) => ({
      id,
      type: "openai-compatible" as const,
      probe: "ok" as const,
      models: Object.freeze(models),
    })),
  );
  return store;
}

describe("buildAliasMetadata — limits", () => {
  test("multi-route minimum is taken element-wise, independently per dimension", () => {
    const store = seeded(
      { id: "a", models: [aggregatorEntry("m1", 8000, 2000)] },
      { id: "b", models: [standardEntry("m2", 16000)] }, // declares context only
    );
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }, { upstream: "b", model: "m2" }])],
      store,
    );
    const meta = table.get("alias");
    expect(meta?.contextWindow).toBe(8000);
    expect(meta?.outputLimit).toBe(2000); // only the route that declared output contributes
    expect(meta?.capabilities).toBeUndefined(); // the standard route declared nothing
  });

  test("the manual limits value caps the discovered minimum when smaller", () => {
    const store = seeded({ id: "a", models: [aggregatorEntry("m1", 128000, 16384)] });
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }], { context: 4096, output: 512 })],
      store,
    );
    expect(table.get("alias")?.contextWindow).toBe(4096);
    expect(table.get("alias")?.outputLimit).toBe(512);
  });

  test("a larger manual value loses to the discovered minimum", () => {
    const store = seeded({ id: "a", models: [aggregatorEntry("m1", 8000, 2000)] });
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }], { context: 128000, output: 16384 })],
      store,
    );
    expect(table.get("alias")?.contextWindow).toBe(8000);
    expect(table.get("alias")?.outputLimit).toBe(2000);
  });

  test("manual limits alone carry an alias whose routes declare nothing", () => {
    const store = seeded({ id: "a", models: [opaqueEntry("m1")] });
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }], { context: 4096 })],
      store,
    );
    const meta = table.get("alias");
    expect(meta?.contextWindow).toBe(4096);
    expect(meta?.outputLimit).toBeUndefined();
    expect(meta?.capabilities).toBeUndefined();
  });

  test("a partial manual block (output only) fills only its own dimension", () => {
    const store = seeded({ id: "a", models: [standardEntry("m1", 16000)] });
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }], { output: 4096 })],
      store,
    );
    expect(table.get("alias")?.contextWindow).toBe(16000);
    expect(table.get("alias")?.outputLimit).toBe(4096);
  });
});

describe("buildAliasMetadata — capabilities", () => {
  test("the strict AND emits all-true only when every route declares true", () => {
    const store = seeded(
      { id: "a", models: [aggregatorEntry("m1", 8000, 2000)] },
      { id: "b", models: [aggregatorEntry("m2", 9000, 3000, { attachment: false })] },
    );
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }, { upstream: "b", model: "m2" }])],
      store,
    );
    expect(table.get("alias")?.capabilities).toEqual({
      attachment: false, // declared false by a fully-declaring route — authoritative
      reasoning: true,
      temperature: true,
      toolCall: true,
    });
  });

  test("a route with no capabilities declaration leaves the alias's capabilities undeclared", () => {
    const store = seeded(
      { id: "a", models: [aggregatorEntry("m1", 8000, 2000)] },
      { id: "b", models: [standardEntry("m2", 9000)] }, // context only — nothing declared
    );
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }, { upstream: "b", model: "m2" }])],
      store,
    );
    const meta = table.get("alias");
    expect(meta?.capabilities).toBeUndefined();
    expect(meta?.contextWindow).toBe(8000); // limits still aggregate
  });

  test("a route with an undetectable entry kills the AND too", () => {
    const store = seeded(
      { id: "a", models: [aggregatorEntry("m1", 8000, 2000)] },
      { id: "b", models: [opaqueEntry("m2")] },
    );
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }, { upstream: "b", model: "m2" }])],
      store,
    );
    expect(table.get("alias")?.capabilities).toBeUndefined();
  });

  test("every route declaring false yields an authoritative all-false block", () => {
    const store = seeded(
      { id: "a", models: [aggregatorEntry("m1", 8000, 2000, { tools: false, reasoning: false, temperature: false })] },
      { id: "b", models: [aggregatorEntry("m2", 9000, 3000, { tools: false, reasoning: false, temperature: false })] },
    );
    const table = buildAliasMetadata(
      [aliasEntry("alias", [{ upstream: "a", model: "m1" }, { upstream: "b", model: "m2" }])],
      store,
    );
    expect(table.get("alias")?.capabilities).toEqual({
      attachment: true, // image input declared by both
      reasoning: false,
      temperature: false,
      toolCall: false,
    });
  });
});

describe("buildAliasMetadata — route matching and absence", () => {
  test("routes match by (upstream id, provider-native model id) pairs", () => {
    const store = seeded({ id: "a", models: [aggregatorEntry("m1", 8000, 2000)] });
    const table = buildAliasMetadata(
      [
        aliasEntry("hit", [{ upstream: "a", model: "m1" }]),
        aliasEntry("wrong-upstream", [{ upstream: "other", model: "m1" }]),
        aliasEntry("wrong-model", [{ upstream: "a", model: "nope" }]),
        aliasEntry(
          "mixed",
          [{ upstream: "a", model: "m1" }, { upstream: "a", model: "nope" }],
        ),
      ],
      store,
    );
    expect(table.get("hit")?.contextWindow).toBe(8000);
    expect(table.has("wrong-upstream")).toBe(false);
    expect(table.has("wrong-model")).toBe(false);
    // The unmatched route contributes nothing — but also kills the AND.
    const mixed = table.get("mixed");
    expect(mixed?.contextWindow).toBe(8000);
    expect(mixed?.capabilities).toBeUndefined();
  });

  test("an alias with no known dimension gets no entry at all", () => {
    const store = seeded(
      { id: "a", models: [opaqueEntry("m1")] },
      { id: "b", models: [] }, // a successful discovery that listed zero models
    );
    const table = buildAliasMetadata(
      [
        aliasEntry("opaque", [{ upstream: "a", model: "m1" }]),
        aliasEntry("empty-catalog", [{ upstream: "b", model: "m2" }]),
        aliasEntry("no-snapshot", [{ upstream: "never-seeded", model: "m3" }]),
      ],
      store,
    );
    expect(table.size).toBe(0);
  });

  test("an absent models block builds an empty table", () => {
    const store = seeded({ id: "a", models: [aggregatorEntry("m1", 8000, 2000)] });
    expect(buildAliasMetadata([], store).size).toBe(0);
  });

  test("each alias aggregates independently; config order is preserved", () => {
    const store = seeded(
      { id: "a", models: [aggregatorEntry("m1", 8000, 2000)] },
      { id: "b", models: [standardEntry("m2", 16000)] },
    );
    const table = buildAliasMetadata(
      [aliasEntry("z-alias", [{ upstream: "a", model: "m1" }]), aliasEntry("a-alias", [{ upstream: "b", model: "m2" }])],
      store,
    );
    expect([...table.keys()]).toEqual(["z-alias", "a-alias"]);
    expect(table.get("z-alias")?.capabilities).toEqual({
      attachment: true,
      reasoning: true,
      temperature: true,
      toolCall: true,
    });
    expect(table.get("a-alias")?.contextWindow).toBe(16000);
  });

  test("building consumes the store read-only", () => {
    const store = seeded({ id: "a", models: [aggregatorEntry("m1", 8000, 2000)] });
    buildAliasMetadata([aliasEntry("alias", [{ upstream: "a", model: "m1" }])], store);
    expect(store.entries("a")).toHaveLength(1);
  });
});

describe("buildAliasMetadata — frozen output", () => {
  test("the table, its entries, and capability blocks are frozen", () => {
    const store = seeded({ id: "a", models: [aggregatorEntry("m1", 8000, 2000)] });
    const table = buildAliasMetadata([aliasEntry("alias", [{ upstream: "a", model: "m1" }])], store);
    expect(Object.isFrozen(table)).toBe(true);
    const meta = table.get("alias");
    expect(Object.isFrozen(meta)).toBe(true);
    expect(Object.isFrozen(meta?.capabilities)).toBe(true);
    expect(() => (table as Map<string, unknown>).set("alias", {})).toThrow(TypeError);
    expect(table.size).toBe(1);
  });
});
