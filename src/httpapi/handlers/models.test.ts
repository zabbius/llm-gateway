/**
 * The `GET /llm/v1/models` alias-metadata projection
 * (specs/domains/routing.md "Alias metadata", specs/contracts/client-gateway.md):
 * entries gain `limit` / `capabilities` / `modalities` only from the metadata
 * store's current slice — folded per request, never contacting an upstream —
 * and an entry without metadata serializes byte-for-byte as the bare
 * four-key OpenAI entry. Retain-last-good: a failed discovery leaves the
 * served entries unchanged.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type pino from "pino";
import type { ModelEntry, Upstream, UpstreamConfig, UpstreamStatus, ProxyRequest } from "../../upstreams/upstream.ts";
import { UpstreamRegistry } from "../../upstreams/registry.ts";
import { type GatewayEnv, type RoutingTable, createRoutingTable } from "../../gateway/router.ts";
import { MetadataStore } from "../../gateway/metastore.ts";
import type { ModelConfig, ModelRouteConfig } from "../../config/schema.ts";
import { handleModels, PROCESS_STARTED_AT } from "./models.ts";

/** Minimal capturing stand-in for the injected pino logger. */
function fakeLogger(): pino.Logger {
  const noop = () => undefined;
  const build = (): pino.Logger =>
    ({
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      child: () => build(),
    }) as unknown as pino.Logger;
  return build();
}

/** The handler mounted on a minimal app, driven through `app.request`. */
function appWith(
  table: RoutingTable,
  models: ModelConfig[],
  store: MetadataStore | undefined,
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.get(
    "/llm/v1/models",
    handleModels(table, fakeLogger(), store === undefined ? undefined : { models, store }),
  );
  return app;
}

/** A routing table that knows only its alias list (the handler's sole use). */
function tableWith(aliases: string[]): RoutingTable {
  return { aliases: () => aliases } as unknown as RoutingTable;
}

/** One `models` block entry: alias → single route (config shape). */
function modelsEntry(
  alias: string,
  upstream: string,
  model: string,
  limits?: { context?: number; output?: number },
): ModelConfig {
  return {
    alias,
    routes: [{ upstream, model } as ModelRouteConfig],
    balance: { strategy: "round-robin" },
    ...(limits !== undefined ? { limits } : {}),
  };
}

/** A raw aggregator-form listing entry: `limit` plus the optional full declaration. */
function aggregatorEntry(
  id: string,
  context: number,
  output: number,
  flags?: { attachment: boolean; reasoning: boolean; temperature: boolean; toolCall: boolean },
): ModelEntry {
  return {
    id,
    object: "model",
    created: 1,
    owned_by: "provider",
    limit: { context, output },
    ...(flags === undefined
      ? {}
      : {
          capabilities: {
            tools: { supported: flags.toolCall },
            reasoning: { supported: flags.reasoning },
            temperature: flags.temperature,
          },
          modalities: { input: flags.attachment ? ["text", "image/png"] : ["text"] },
        }),
  } as ModelEntry;
}

interface CatalogEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  limit?: { context: number; output: number };
  capabilities?: { tools: { supported: boolean }; reasoning: { supported: boolean }; temperature: boolean };
  modalities?: { input: string[] };
}

async function catalog(app: Hono<GatewayEnv>): Promise<{ raw: string; data: CatalogEntry[] }> {
  const response = await app.request("/llm/v1/models");
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { raw, data: (JSON.parse(raw) as { object: string; data: CatalogEntry[] }).data };
}

describe("handleModels — alias metadata projection", () => {
  test("no metadata anywhere: entries serialize byte-for-byte as the bare four-key OpenAI entry", async () => {
    const store = new MetadataStore();
    const app = appWith(tableWith(["fast", "slow"]), [modelsEntry("fast", "up", "m1"), modelsEntry("slow", "up", "m2")], store);

    const { raw } = await catalog(app);
    expect(raw).toBe(
      `{"object":"list","data":[{"id":"fast","object":"model","created":${PROCESS_STARTED_AT},"owned_by":"llm-gateway"},{"id":"slow","object":"model","created":${PROCESS_STARTED_AT},"owned_by":"llm-gateway"}]}`,
    );
  });

  test("no store wired: the catalog answers exactly as before metadata existed", async () => {
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], undefined);
    const { raw, data } = await catalog(app);
    expect(raw).toBe(
      `{"object":"list","data":[{"id":"fast","object":"model","created":${PROCESS_STARTED_AT},"owned_by":"llm-gateway"}]}`,
    );
    expect(data[0]?.limit).toBeUndefined();
    expect(data[0]?.capabilities).toBeUndefined();
    expect(data[0]?.modalities).toBeUndefined();
  });

  test("a known context window adds limit { context, output: 0 } when the output limit is undeclared", async () => {
    const store = new MetadataStore();
    store.set("up", [aggregatorEntry("m1", 8192, 0)]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], store);

    const { data } = await catalog(app);
    expect(data[0]?.limit).toEqual({ context: 8192, output: 0 });
    // limits only — the four-flag gate keeps capabilities absent
    expect(data[0]?.capabilities).toBeUndefined();
    expect(data[0]?.modalities).toBeUndefined();
  });

  test("a declared output rides along; the entry's manual limits apply their minimum", async () => {
    const store = new MetadataStore();
    store.set("up", [aggregatorEntry("m1", 8192, 4096)]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1", { context: 100000, output: 2048 })], store);

    const { data } = await catalog(app);
    // context: min(8192 discovered, 100000 manual); output: min(4096 discovered, 2048 manual)
    expect(data[0]?.limit).toEqual({ context: 8192, output: 2048 });
  });

  test("a non-aggregator listing (OpenAI-standard window) also yields limit with output 0", async () => {
    const store = new MetadataStore();
    store.set("up", [{ id: "m1", object: "model", created: 1, owned_by: "provider", max_model_len: 4096 } as ModelEntry]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], store);

    const { data } = await catalog(app);
    expect(data[0]?.limit).toEqual({ context: 4096, output: 0 });
  });

  test("the full four-flag declaration adds capabilities + modalities, mapped onto the wire shape", async () => {
    const store = new MetadataStore();
    store.set("up", [
      aggregatorEntry("m1", 8192, 2048, { attachment: true, reasoning: true, temperature: false, toolCall: true }),
    ]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], store);

    const { data } = await catalog(app);
    expect(data[0]?.capabilities).toEqual({
      tools: { supported: true },
      reasoning: { supported: true },
      temperature: false, // authoritative false — every route declared it
    });
    expect(data[0]?.modalities).toEqual({ input: ["text", "image/png"] });
    // key order stays stable: base keys first, then the metadata projection
    expect(Object.keys(data[0] as CatalogEntry)).toEqual([
      "id",
      "object",
      "created",
      "owned_by",
      "limit",
      "capabilities",
      "modalities",
    ]);
  });

  test("attachment undeclared: modalities list text only", async () => {
    const store = new MetadataStore();
    store.set("up", [
      aggregatorEntry("m1", 8192, 0, { attachment: false, reasoning: false, temperature: true, toolCall: false }),
    ]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], store);

    const { data } = await catalog(app);
    expect(data[0]?.capabilities).toEqual({
      tools: { supported: false },
      reasoning: { supported: false },
      temperature: true,
    });
    expect(data[0]?.modalities).toEqual({ input: ["text"] });
  });

  test("one route without a full declaration leaves capabilities absent — limits still aggregate", async () => {
    const store = new MetadataStore();
    store.set("a", [aggregatorEntry("m1", 8192, 2048, { attachment: true, reasoning: true, temperature: true, toolCall: true })]);
    store.set("b", [{ id: "m2", object: "model", created: 1, owned_by: "provider", max_model_len: 4096 } as ModelEntry]);
    const app = appWith(
      tableWith(["mixed"]),
      [
        {
          alias: "mixed",
          routes: [
            { upstream: "a", model: "m1" } as ModelRouteConfig,
            { upstream: "b", model: "m2" } as ModelRouteConfig,
          ],
          balance: { strategy: "round-robin" },
        },
      ],
      store,
    );

    const { data } = await catalog(app);
    // context: element-wise min over declaring routes (8192, 4096); output:
    // only route a declared one — b contributes nothing, not a kill
    expect(data[0]?.limit).toEqual({ context: 4096, output: 2048 });
    expect(data[0]?.capabilities).toBeUndefined(); // strict AND: b never declared
    expect(data[0]?.modalities).toBeUndefined();
  });

  test("a failed discovery changes nothing — retain-last-good serves the previous snapshot", async () => {
    const store = new MetadataStore();
    store.set("up", [aggregatorEntry("m1", 8192, 2048)]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], store);

    const before = await catalog(app);
    expect(store.set("up", undefined)).toBe(false); // the failed re-discovery
    const after = await catalog(app);
    expect(after.raw).toBe(before.raw);
  });

  test("a successful discovery refreshes the entries on the next request — the slice is read per request", async () => {
    const store = new MetadataStore();
    store.set("up", [aggregatorEntry("m1", 8192, 0)]);
    const app = appWith(tableWith(["fast"]), [modelsEntry("fast", "up", "m1")], store);

    const before = await catalog(app);
    expect(before.data[0]?.limit).toEqual({ context: 8192, output: 0 });

    expect(store.set("up", [aggregatorEntry("m1", 32768, 8192)])).toBe(true);
    const after = await catalog(app);
    expect(after.data[0]?.limit).toEqual({ context: 32768, output: 8192 });
  });
});

/* ------------------------------------------------------------------ */
/* no upstream contact                                                 */
/* ------------------------------------------------------------------ */

/** Counting upstream: lists its catalog once during the probe (the openai-compatible behavior) and records every listModels() call. */
class CountingUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"] = "openai-compatible";
  listModelCalls = 0;

  constructor(config: UpstreamConfig, private readonly catalog: ModelEntry[]) {
    this.id = config.id;
  }

  async connect(): Promise<void> {
    await this.listModels(); // the probe retains the catalog, like the real upstream
  }

  async listModels(): Promise<ModelEntry[]> {
    this.listModelCalls += 1;
    return this.catalog;
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(null, { status: 204 });
  }

  status(): UpstreamStatus {
    return Object.freeze({
      id: this.id,
      type: this.type,
      probe: "ok",
      models: Object.freeze(this.catalog.map((entry) => Object.freeze(entry))),
    });
  }
}

describe("handleModels — no upstream contact", () => {
  test("requests fold the store only: no listModels() call beyond the startup probe", async () => {
    const listing = aggregatorEntry("gpt-4o", 8192, 2048, { attachment: false, reasoning: true, temperature: true, toolCall: false });
    const upstream = new CountingUpstream(
      { type: "openai-compatible", id: "alpha", baseUrl: "https://alpha.example/v1", apiKey: "sk-test" },
      [listing],
    );
    const registry = await UpstreamRegistry.create(
      [{ type: "openai-compatible", id: "alpha", baseUrl: "https://alpha.example/v1", apiKey: "sk-test" }],
      { "openai-compatible": () => upstream },
      fakeLogger(),
    );
    const models = [modelsEntry("fast", "alpha", "gpt-4o")];
    const table = createRoutingTable(models, registry, { logger: fakeLogger() });

    const store = new MetadataStore();
    store.seed(registry.status()); // discovery at start — the probe's retained catalog seeds the store
    const app = appWith(table, models, store);

    const startupCalls = upstream.listModelCalls;
    expect(startupCalls).toBe(1); // exactly the startup probe listed the catalog

    for (let i = 0; i < 3; i += 1) {
      const { data } = await catalog(app);
      expect(data[0]?.limit).toEqual({ context: 8192, output: 2048 });
      expect(data[0]?.capabilities).toEqual({
        tools: { supported: false },
        reasoning: { supported: true },
        temperature: true,
      });
    }
    expect(upstream.listModelCalls).toBe(startupCalls); // the requests added none
  });
});
