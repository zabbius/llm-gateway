/**
 * E2E tests of the model-alias management CRUD surface (ADR-014 over the
 * ADR-009 `models` collection; `src/httpapi/handlers/model-aliases.ts`)
 * through `createApp` — the full request path with the runtime configuration
 * store wired:
 *
 *  - reads list every configured alias entry — alias, routes
 *    (upstream/model/weight), balance.strategy, limits and the `meta`
 *    aggregate folded from the metadata store's current slice (null where
 *    unknown, the /api/status meta[] convention);
 *  - create/update run validate → persist → routing-table rebuild: the
 *    entry lands on disk and in the store, and the rebuilt table serves the
 *    change on the very next `/llm/v1` request, no restart — a changed
 *    alias dispatches over its new routes immediately, a created alias
 *    turns the dispatch answer from `404 model_not_found` into `403`
 *    (configured, outside the client ACL), a deleted one turns it back
 *    into `404` (specs/contracts/client-gateway.md: unknown alias and
 *    forbidden alias are different answers). The client Bearer gate is
 *    mounted in every store-wired deployment (ADR-014: the clients CRUD
 *    can create the first client at runtime — fail-closed empty registry),
 *    so the `/llm/v1` calls here carry a fixture client's key;
 *  - the rebuild hook itself (createRebuildableRoutingTable) is covered at
 *    the unit level: the stable table object gains the new alias on
 *    `rebuild()` and loses the removed one, without an object swap;
 *  - delete refuses an alias any `clients[].models` entry still names with
 *    the `409 resource_in_use` envelope (D6) and removes an unreferenced
 *    one everywhere (store, disk, routing table); the block's last entry
 *    is the store's 400 refusal;
 *  - rejection paths: 401 without a session (gate on), 400 validation
 *    (duplicate alias, unknown route upstream, alias grammar, duplicate
 *    upstream/model pair, strategy/weight mismatch, limits rules),
 *    404 unknown alias, 400 immutable alias on update.
 *
 * Every credential in these fixtures is synthetic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import type { Upstream, UpstreamConfig, UpstreamStatus, ModelEntry, ProxyRequest } from "../../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../../upstreams/registry.ts";
import { createApp, type UiServingOptions } from "../app.ts";
import { createRebuildableRoutingTable } from "../../gateway/router.ts";
import { redactedConfigView } from "../../config/redact.ts";
import { ConfigStore } from "../../config/store.ts";
import { validateGatewayConfig } from "../../config/schema.ts";
import { MetadataStore } from "../../gateway/metastore.ts";
import type { ModelConfig } from "../../config/schema.ts";

/** Minimal silent stand-in for the root pino logger (app.test.ts pattern). */
function silentLogger(): pino.Logger {
  const noop = (): void => {};
  return {
    child: () => silentLogger(),
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    flush: (done?: (err?: Error) => void) => done?.(),
  } as unknown as pino.Logger;
}

const UPSTREAM_KEY_OPENAI = "sk-upstream-synthetic-openai";
const UPSTREAM_KEY_OLLAMA = "sk-upstream-synthetic-ollama";
const CLIENT_KEY_ACME = "sk-client-synthetic-acme";
const OPERATOR_PASSWORD = "operator-synthetic-password";
/** A real argon2id PHC hash of the synthetic operator password (ADR-007). */
const OPERATOR_HASH = await Bun.password.hash(OPERATOR_PASSWORD, { algorithm: "argon2id" });

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "llm-gateway-model-aliases-"));

interface FakeSpec {
  /** The listing the upstream retains (status()) and listModels() answers. */
  models?: ModelEntry[];
}

/** An aggregator-shaped listing entry: limit > 0 defines the shape match, and the
 * full capabilities declaration is emitted (strict AND) — metadata the detectors read. */
function aggregatorEntry(id: string, context: number, output: number): ModelEntry {
  return {
    id,
    object: "model",
    created: 1712267047,
    owned_by: "synthetic",
    limit: { context, output },
    capabilities: { tools: { supported: true }, reasoning: { supported: true }, temperature: true },
    modalities: { input: ["text"] },
  };
}

const OLLAMA_LISTING: ModelEntry[] = [aggregatorEntry("qwen2.5:7b-instruct", 32768, 4096)];
const OPENAI_LISTING: ModelEntry[] = [aggregatorEntry("gpt-4o", 128000, 16384)];

class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type = "openai-compatible" as const;
  forwards = 0;
  /** The provider-native model id of the last forwarded body (`body.model` post-rewrite). */
  lastModel = "";
  /** Whether the last forward carried a parsable JSON body at all. */
  lastBodyParsed = false;

  constructor(
    config: UpstreamConfig,
    private readonly spec: FakeSpec = {},
  ) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}

  /** The retained startup snapshot (Upstream contract): the spec's listing when one is given. */
  status(): UpstreamStatus | undefined {
    if (this.spec.models === undefined) {
      return undefined;
    }
    return { id: this.id, type: this.type, probe: "ok", models: this.spec.models };
  }

  async listModels(): Promise<ModelEntry[]> {
    return this.spec.models ?? [];
  }

  async forward(request: ProxyRequest): Promise<Response> {
    this.forwards += 1;
    if (request.body !== undefined) {
      try {
        const text = await new Response(request.body).text();
        const parsed = JSON.parse(text) as { model?: unknown };
        this.lastModel = typeof parsed.model === "string" ? parsed.model : "";
        this.lastBodyParsed = true;
      } catch {
        this.lastBodyParsed = false;
      }
    }
    return new Response(JSON.stringify({ id: `chatcmpl-${this.id}`, choices: [] }), {
      headers: { "content-type": "application/json" },
    });
  }
}

/** The fixture upstreams, in config order. */
function fixtureUpstreams(): Record<string, unknown>[] {
  return [
    { type: "openai-compatible", id: "openai", baseUrl: "https://openai.example.com/v1", apiKey: UPSTREAM_KEY_OPENAI },
    { type: "openai-compatible", id: "ollama", baseUrl: "https://ollama.example.com/v1", apiKey: UPSTREAM_KEY_OLLAMA },
  ];
}

/** The fixture config. With clients, `acme` may address `smart` — the client
 * Bearer gate is mounted in every store-wired deployment (ADR-014), so the
 * gated /llm/v1 assertions carry acme's key and ride its ACL. */
function fixtureConfig(withClients: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {
    upstreams: fixtureUpstreams(),
    models: [
      {
        alias: "smart",
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
        balance: { strategy: "round-robin" },
      },
    ],
  };
  if (withClients) {
    config.clients = [{ name: "acme", apiKey: CLIENT_KEY_ACME, models: ["smart"] }];
  }
  return config;
}

interface FixtureApp {
  app: ReturnType<typeof createApp>;
  store: ConfigStore;
  registry: UpstreamRegistry;
  metadata: MetadataStore;
  made: Map<string, FakeUpstream>;
  configPath: string;
}

interface GatewayOptions {
  specs?: Map<string, FakeSpec>;
  withClients?: boolean;
  withAuth?: boolean;
}

/** Build one gateway: config file on disk → store → registry of fakes (probed,
 * metadata seeded like the entry point does) → app with the runtime store wired. */
async function gateway(options: GatewayOptions = {}): Promise<FixtureApp> {
  const { specs = new Map(), withClients = false, withAuth = false } = options;
  const dir = join(FIXTURE_DIR, `case-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(fixtureConfig(withClients), null, 2)}\n`, "utf8");
  const validated = validateGatewayConfig(JSON.parse(readFileSync(configPath, "utf8")));
  if (!validated.ok) throw new Error(`invalid fixture config: ${validated.problems.join("; ")}`);
  const store = new ConfigStore(validated.config, configPath);

  const made = new Map<string, FakeUpstream>();
  const factories: UpstreamFactories = {
    "openai-compatible": (entry) => {
      const instance = new FakeUpstream(entry, specs.get(entry.id));
      made.set(entry.id, instance);
      return instance;
    },
  };
  const logger = silentLogger();
  const registry = await UpstreamRegistry.create(validated.config.upstreams, factories, logger);
  const metadata = new MetadataStore();
  // Discovery at start, exactly like src/index.ts: ok probes that retained a
  // catalog seed that catalog as the upstream's first snapshot.
  metadata.seed(registry.status());

  const ui: UiServingOptions = {
    models: validated.config.models,
    metadataStore: metadata,
    configStore: store,
    probeBudgetMs: 50,
    ...(withClients && validated.config.clients !== undefined ? { clients: validated.config.clients } : {}),
    ...(withAuth ? { auth: { enabled: true, user: "operator", passwordHash: OPERATOR_HASH } } : {}),
  };
  const app = createApp(registry, logger, redactedConfigView(validated.config), ui);
  return { app, store, registry, metadata, made, configPath };
}

/** The real key values must never appear in any response body. */
async function bodyText(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toContain(UPSTREAM_KEY_OPENAI);
  expect(text).not.toContain(UPSTREAM_KEY_OLLAMA);
  expect(text).not.toContain(CLIENT_KEY_ACME);
  return text;
}

interface Envelope {
  error: { message: string; type: string; code?: string };
}

interface ManagedAliasBody {
  alias: string;
  routes: { upstream: string; model: string; weight: number | null }[];
  balance: { strategy: string };
  limits: { context: number | null; output: number | null } | null;
  meta: { contextWindow: number | null; outputLimit: number | null; capabilities: Record<string, boolean> | null };
}

/** The default catalog listing: smart → ollama/qwen2.5:7b-instruct, round-robin. */
const SMART_ENTRY = {
  alias: "smart",
  routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
  balance: { strategy: "round-robin" },
};

/** The gated-catalog request — acme's Bearer key (the gate is mounted in every
 * store-wired deployment; the catalog is ACL-scoped, ADR-009). */
const ACME = { headers: { authorization: `Bearer ${CLIENT_KEY_ACME}` } };

/** A chat completions request body for the given alias. */
function chatBody(model: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY_ACME}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  };
}

/* ------------------------------------------------------------------ */
/* reads: list + detail carry the full entry shape with meta           */
/* ------------------------------------------------------------------ */

describe("GET /api/models and GET /api/models/:alias", () => {
  test("list carries alias, routes, balance, limits and the meta aggregate; detail mirrors it", async () => {
    const { app } = await gateway({
      specs: new Map([
        ["ollama", { models: OLLAMA_LISTING }],
        ["openai", { models: OPENAI_LISTING }],
      ]),
    });

    const list = await app.request("/api/models");
    expect(list.status).toBe(200);
    const listBody = JSON.parse(await bodyText(list)) as { models: ManagedAliasBody[] };
    expect(listBody.models).toHaveLength(1);
    const entry = listBody.models[0] as ManagedAliasBody;
    expect(entry.alias).toBe("smart");
    expect(entry.routes).toEqual([{ upstream: "ollama", model: "qwen2.5:7b-instruct", weight: null }]);
    expect(entry.balance).toEqual({ strategy: "round-robin" });
    expect(entry.limits).toBeNull();
    // The aggregate over the seeded slice: the route's aggregator-shaped
    // listing entry declares context 32768 / output 4096 and full capabilities.
    expect(entry.meta.contextWindow).toBe(32768);
    expect(entry.meta.outputLimit).toBe(4096);
    expect(entry.meta.capabilities).toEqual({ attachment: false, reasoning: true, temperature: true, toolCall: true });

    const detail = await app.request("/api/models/smart");
    expect(detail.status).toBe(200);
    const detailBody = JSON.parse(await bodyText(detail)) as ManagedAliasBody;
    expect(detailBody).toEqual(entry);
  });

  test("unknown dimensions serve null, never fabricated zeros; unknown alias is the 404 envelope", async () => {
    const { app } = await gateway(); // no specs: no metadata known at all

    const list = await app.request("/api/models");
    const listBody = JSON.parse(await bodyText(list)) as { models: ManagedAliasBody[] };
    expect(listBody.models[0]?.meta).toEqual({ contextWindow: null, outputLimit: null, capabilities: null });

    const missing = await app.request("/api/models/ghost");
    expect(missing.status).toBe(404);
    const body = JSON.parse(await bodyText(missing)) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("ghost");
  });
});

/* ------------------------------------------------------------------ */
/* create: validate → persist → rebuild                                */
/* ------------------------------------------------------------------ */

describe("POST /api/models", () => {
  test("create lands on disk and in the store, and the dispatch immediately sees the alias as configured", async () => {
    const { app, made, configPath, store } = await gateway({
      withClients: true,
      specs: new Map([
        ["ollama", { models: OLLAMA_LISTING }],
        ["openai", { models: OPENAI_LISTING }],
      ]),
    });

    // Before the create: the alias does not resolve — 404 model_not_found.
    const before = await app.request("/llm/v1/chat/completions", chatBody("fast"));
    expect(before.status).toBe(404);
    expect(((await before.json()) as Envelope).error.code).toBe("model_not_found");

    const created = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "fast",
        routes: [{ upstream: "openai", model: "gpt-4o" }],
        balance: { strategy: "round-robin" },
        limits: { context: 64000 },
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = JSON.parse(await bodyText(created)) as ManagedAliasBody;
    expect(createdBody.alias).toBe("fast");
    expect(createdBody.routes).toEqual([{ upstream: "openai", model: "gpt-4o", weight: null }]);
    expect(createdBody.limits).toEqual({ context: 64000, output: null });
    // The meta aggregate folds the route's own listing entry (128000) and then
    // takes the minimum with the entry's manual limits (64000) — the alias can
    // only serve what its smallest budget allows.
    expect(createdBody.meta.contextWindow).toBe(64000);

    // The store (and through it the disk) carries the new entry.
    expect(store.findModel("fast")).toBeDefined();
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
      models: { alias: string }[];
    };
    expect(onDisk.models.map((entry) => entry.alias)).toEqual(["smart", "fast"]);

    // After the create, the very next dispatch sees the alias as configured —
    // the 404 flipped to 403 (configured, but outside acme's ACL, ADR-009).
    const after = await app.request("/llm/v1/chat/completions", chatBody("fast"));
    expect(after.status).toBe(403);
    expect(((await after.json()) as Envelope).error.message).toContain("fast");

    // The management list carries it at once; the /llm/v1 catalog stays
    // ACL-scoped (fast is not acme's to address).
    const list = await app.request("/api/models");
    const listBody = JSON.parse(await bodyText(list)) as { models: { alias: string }[] };
    expect(listBody.models.map((entry) => entry.alias)).toEqual(["smart", "fast"]);
    const catalog = await app.request("/llm/v1/models", ACME);
    expect(catalog.status).toBe(200);
    const catalogBody = JSON.parse(await bodyText(catalog)) as { data: { id: string }[] };
    expect(catalogBody.data.map((entry) => entry.id)).toEqual(["smart"]);

    // No upstream was contacted on any of these resolution checks.
    expect(made.get("openai")?.forwards).toBe(0);
    expect(made.get("ollama")?.forwards).toBe(0);
  });

  test("duplicate alias, unknown route upstream, alias grammar, duplicate route pair: the 400 envelope, nothing persisted", async () => {
    const { app, store, configPath } = await gateway();

    const duplicate = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SMART_ENTRY),
    });
    expect(duplicate.status).toBe(400);
    expect(((await duplicate.json()) as Envelope).error.message).toContain("duplicate");

    const unknownUpstream = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "fast",
        routes: [{ upstream: "ghost", model: "m" }],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(unknownUpstream.status).toBe(400);
    expect(((await unknownUpstream.json()) as Envelope).error.message).toContain("ghost");

    const badGrammar = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "has space",
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(badGrammar.status).toBe(400);

    const duplicatePair = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "fast",
        routes: [
          { upstream: "ollama", model: "qwen2.5:7b-instruct" },
          { upstream: "ollama", model: "qwen2.5:7b-instruct" },
        ],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(duplicatePair.status).toBe(400);
    expect(((await duplicatePair.json()) as Envelope).error.message).toContain("duplicate route");

    // Nothing landed: the store and the disk still hold only `smart`.
    expect(store.findModel("fast")).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { models: { alias: string }[] };
    expect(onDisk.models.map((entry) => entry.alias)).toEqual(["smart"]);
  });

  test("strategy/weight mismatch and limits rules: the 400 envelope", async () => {
    const { app } = await gateway();

    // Weight present under plain round-robin.
    const weightWithout = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "fast",
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct", weight: 2 }],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(weightWithout.status).toBe(400);
    expect(((await weightWithout.json()) as Envelope).error.message).toContain("weight");

    // Weighted strategy without the required weight.
    const missingWeight = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "fast",
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
        balance: { strategy: "weighted-round-robin" },
      }),
    });
    expect(missingWeight.status).toBe(400);
    expect(((await missingWeight.json()) as Envelope).error.message).toContain("weight");

    // Empty limits block, and non-positive limits.
    for (const limits of [{}, { context: 0 }, { output: -3 }]) {
      const badLimits = await app.request("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          alias: "fast",
          routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
          balance: { strategy: "round-robin" },
          limits,
        }),
      });
      expect(badLimits.status).toBe(400);
    }
  });
});

/* ------------------------------------------------------------------ */
/* update: wholesale replacement, immediate effect on dispatch         */
/* ------------------------------------------------------------------ */

describe("PUT /api/models/:alias", () => {
  test("re-pointing the routes takes effect on the very next dispatch; meta recomputes", async () => {
    const { app, made } = await gateway({
      withClients: true,
      specs: new Map([
        ["ollama", { models: OLLAMA_LISTING }],
        ["openai", { models: OPENAI_LISTING }],
      ]),
    });

    const updated = await app.request("/api/models/smart", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routes: [{ upstream: "openai", model: "gpt-4o" }],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = JSON.parse(await bodyText(updated)) as ManagedAliasBody;
    expect(updatedBody.routes).toEqual([{ upstream: "openai", model: "gpt-4o", weight: null }]);
    // The aggregate now folds the openai route's listing entry.
    expect(updatedBody.meta.contextWindow).toBe(128000);
    expect(updatedBody.meta.outputLimit).toBe(16384);

    // The rebuilt table serves the changed entry on the very next request —
    // the relay lands on openai with the provider-native rewrite.
    const dispatch = await app.request("/llm/v1/chat/completions", chatBody("smart"));
    expect(dispatch.status).toBe(200);
    expect(made.get("openai")?.forwards).toBe(1);
    expect(made.get("openai")?.lastBodyParsed).toBe(true);
    expect(made.get("openai")?.lastModel).toBe("gpt-4o");
    expect(made.get("ollama")?.forwards).toBe(0);
  });

  test("a null body value is the key not set: a null alias is inherited, a null weight is unweighted, null limits fall away", async () => {
    const { app } = await gateway();

    const cleared = await app.request("/api/models/smart", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: null,
        routes: [{ upstream: "openai", model: "gpt-4o", weight: null }],
        balance: { strategy: "round-robin" },
        limits: null,
      }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = JSON.parse(await bodyText(cleared)) as ManagedAliasBody;
    expect(clearedBody.alias).toBe("smart");
    expect(clearedBody.routes).toEqual([{ upstream: "openai", model: "gpt-4o", weight: null }]);
    expect(clearedBody.limits).toBeNull();

    // a null single limit falls away; the view reports the absent dimension as null
    const partial = await app.request("/api/models/smart", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routes: [{ upstream: "openai", model: "gpt-4o", weight: 1 }],
        balance: { strategy: "weighted-round-robin" },
        limits: { context: null, output: 4096 },
      }),
    });
    expect(partial.status).toBe(200);
    expect((JSON.parse(await bodyText(partial)) as ManagedAliasBody).limits).toEqual({ context: null, output: 4096 });
  });

  test("unknown alias is the 404 envelope before any validation; a differing body alias is refused (immutable)", async () => {
    const { app } = await gateway();

    const missing = await app.request("/api/models/ghost", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }], balance: { strategy: "round-robin" } }),
    });
    expect(missing.status).toBe(404);

    const rename = await app.request("/api/models/smart", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "renamed",
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(rename.status).toBe(400);
    expect(((await rename.json()) as Envelope).error.message).toContain("immutable");
  });
});

/* ------------------------------------------------------------------ */
/* delete: 409 on the referenced alias, immediate removal otherwise    */
/* ------------------------------------------------------------------ */

describe("DELETE /api/models/:alias", () => {
  test("an alias a client's ACL still names: the 409 resource_in_use envelope, nothing removed", async () => {
    const { app, store } = await gateway({ withClients: true });

    const refused = await app.request("/api/models/smart", { method: "DELETE" });
    expect(refused.status).toBe(409);
    const body = JSON.parse(await bodyText(refused)) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("resource_in_use");
    expect(body.error.message).toContain("acme");

    // The alias is still configured and still addressable.
    expect(store.findModel("smart")).toBeDefined();
    const catalog = await app.request("/llm/v1/models", ACME);
    expect(catalog.status).toBe(200);
    const catalogBody = JSON.parse(await bodyText(catalog)) as { data: { id: string }[] };
    expect(catalogBody.data.map((entry) => entry.id)).toContain("smart");
  });

  test("an unreferenced alias is removed everywhere; the next dispatch answers model_not_found again", async () => {
    const { app, made, configPath, store } = await gateway({ withClients: true });

    // Create a second alias first (the block keeps at least one entry).
    const created = await app.request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alias: "fast",
        routes: [{ upstream: "openai", model: "gpt-4o" }],
        balance: { strategy: "round-robin" },
      }),
    });
    expect(created.status).toBe(200);

    // Configured but outside acme's ACL: 403.
    const whileConfigured = await app.request("/llm/v1/chat/completions", chatBody("fast"));
    expect(whileConfigured.status).toBe(403);

    const removed = await app.request("/api/models/fast", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await bodyText(removed)).toBe(JSON.stringify({ deleted: "fast" }));

    expect(store.findModel("fast")).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { models: { alias: string }[] };
    expect(onDisk.models.map((entry) => entry.alias)).toEqual(["smart"]);

    // The very next dispatch answers 404 model_not_found — the rebuild took
    // the alias out of the table at once.
    const after = await app.request("/llm/v1/chat/completions", chatBody("fast"));
    expect(after.status).toBe(404);
    const envelope = JSON.parse(await bodyText(after)) as Envelope;
    expect(envelope.error.code).toBe("model_not_found");
    expect(made.get("openai")?.forwards).toBe(0);

    // The management list drops it at once too.
    const list = await app.request("/api/models");
    const listBody = JSON.parse(await bodyText(list)) as { models: { alias: string }[] };
    expect(listBody.models.map((entry) => entry.alias)).toEqual(["smart"]);
  });

  test("the block's last remaining entry: the store's 400 refusal", async () => {
    const { app } = await gateway();

    const refused = await app.request("/api/models/smart", { method: "DELETE" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as Envelope).error.message).toContain("at least one");
  });

  test("unknown alias: the 404 envelope before any mutation", async () => {
    const { app } = await gateway();
    const missing = await app.request("/api/models/ghost", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* the rebuild hook: createRebuildableRoutingTable (unit level)        */
/* ------------------------------------------------------------------ */

describe("createRebuildableRoutingTable", () => {
  test("a rebuild makes a new alias selectable and a removed alias gone — the table object stays stable", async () => {
    const factories: UpstreamFactories = {
      "openai-compatible": (entry) => new FakeUpstream(entry, { models: OPENAI_LISTING }),
    };
    const registry = await UpstreamRegistry.create(
      validatedUpstreams(),
      factories,
      silentLogger(),
    );

    const smart: ModelConfig = {
      alias: "smart",
      routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
      balance: { strategy: "round-robin" },
    };
    const fast: ModelConfig = {
      alias: "fast",
      routes: [{ upstream: "openai", model: "gpt-4o" }],
      balance: { strategy: "round-robin" },
    };

    const ref = createRebuildableRoutingTable([smart], registry, {});
    const table = ref.table;
    expect(table.aliases()).toEqual(["smart"]);
    expect(table.select("fast")).toBeNull();

    // The rebuild: a fresh build over the grown block, same stable object.
    ref.rebuild([smart, fast]);
    expect(ref.table).toBe(table);
    expect(table.aliases()).toEqual(["smart", "fast"]);
    const selection = table.select("fast");
    expect(selection?.upstream.id).toBe("openai");
    expect(selection?.upstreamModel).toBe("gpt-4o");
    expect(ref.models.map((entry) => entry.alias)).toEqual(["smart", "fast"]);

    // And the reverse: the removed alias is gone from the same object.
    ref.rebuild([smart]);
    expect(table.aliases()).toEqual(["smart"]);
    expect(table.routes("fast")).toBeNull();
    expect(table.select("fast")).toBeNull();
  });
});

/** The registry entries for the rebuild unit test (config-grammar-valid). */
function validatedUpstreams(): UpstreamConfig[] {
  return [
    { type: "openai-compatible", id: "openai", baseUrl: "https://openai.example.com/v1", apiKey: UPSTREAM_KEY_OPENAI },
    { type: "openai-compatible", id: "ollama", baseUrl: "https://ollama.example.com/v1", apiKey: UPSTREAM_KEY_OLLAMA },
  ];
}

/* ------------------------------------------------------------------ */
/* mounting and auth                                                    */
/* ------------------------------------------------------------------ */

describe("mounting and auth of the models CRUD", () => {
  test("without the runtime store the routes do not mount — the envelope 404", async () => {
    const dir = join(FIXTURE_DIR, `nostore-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, `${JSON.stringify(fixtureConfig(false), null, 2)}\n`, "utf8");
    const validated = validateGatewayConfig(JSON.parse(readFileSync(configPath, "utf8")));
    if (!validated.ok) throw new Error(`invalid fixture config: ${validated.problems.join("; ")}`);
    const logger = silentLogger();
    const factories: UpstreamFactories = {
      "openai-compatible": (entry) => new FakeUpstream(entry),
    };
    const registry = await UpstreamRegistry.create(validated.config.upstreams, factories, logger);
    const app = createApp(registry, logger, redactedConfigView(validated.config), {
      models: validated.config.models,
    });
    const response = await app.request("/api/models");
    expect(response.status).toBe(404);
    expect(((await response.json()) as Envelope).error.type).toBe("invalid_request_error");
  });

  test("auth on: every route answers 401 without a session and serves with one", async () => {
    const { app } = await gateway({ withAuth: true });

    const attempts = [
      { method: "GET", path: "/api/models" },
      { method: "POST", path: "/api/models" },
      { method: "GET", path: "/api/models/smart" },
      { method: "PUT", path: "/api/models/smart" },
      { method: "DELETE", path: "/api/models/smart" },
    ];
    for (const attempt of attempts) {
      const response = await app.request(attempt.path, { method: attempt.method });
      expect(response.status).toBe(401);
      const body = JSON.parse(await bodyText(response)) as Envelope;
      expect(body.error.type).toBe("authentication_error");
      expect(body.error.code).toBe("authentication_required");
    }

    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "operator", password: OPERATOR_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const authorized = await app.request("/api/models", { headers: { cookie } });
    expect(authorized.status).toBe(200);
    const listed = JSON.parse(await bodyText(authorized)) as { models: { alias: string }[] };
    expect(listed.models.map((entry) => entry.alias)).toEqual(["smart"]);
  });
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});
