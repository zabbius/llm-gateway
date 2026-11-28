/**
 * E2E tests of the upstream management CRUD surface (ADR-014; `src/httpapi/
 * handlers/upstreams.ts`) through `createApp` — the full request path with
 * the runtime configuration store wired:
 *
 *  - reads list masked entries only (`[Configured]`, never the real key);
 *  - create/update run validate → persist → hot-apply: the entry lands on
 *    disk and in the store, the fresh instance is probed within the budget
 *    (a failed probe is data in the answer, not a cancellation), registered,
 *    and the metadata slice follows — an updated upstream serves `/llm/v1`
 *    on the very next request, no restart;
 *  - delete refuses an in-use upstream with the `409 resource_in_use`
 *    envelope (D6) and removes an unreferenced one everywhere (store, disk,
 *    registry, metadata slice);
 *  - the live listing with `discover=1` runs one `listModels()` within the
 *    budget and swaps the alias-metadata slice wholesale before the answer
 *    (retain-last-good on failure — the 502 envelope, store untouched);
 *    without the parameter it is a pure read; an unknown id is the 404
 *    envelope before any contact; the standalone discover mount is gone
 *    (ADR-016);
 *  - rejection paths: 401 without a session (gate on), 400 validation,
 *    404 unknown id.
 *
 * Every credential in these fixtures is synthetic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../../upstreams/registry.ts";
import { createApp, type UiServingOptions } from "../app.ts";
import { redactedConfigView } from "../../config/redact.ts";
import { ConfigStore } from "../../config/store.ts";
import { validateGatewayConfig } from "../../config/schema.ts";
import { MetadataStore } from "../../gateway/metastore.ts";

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
/** A syntactically valid synthetic SPKI pin (base64 of 32 bytes) — never a real key. */
const SYNTHETIC_PIN = "ChVe2KjfNPYd8xw7nslGJTBuGOiOq2cQ0CpI1Fh2WhM=";
/** The fixture client's key: the runtime store wires the management CRUD, so
 * the client gate mounts (ADR-014 D2) and /llm/v1 needs this Bearer value. */
const CLIENT_KEY_CRUD = "sk-client-synthetic-crud";
const OPERATOR_PASSWORD = "operator-synthetic-password";
/** A real argon2id PHC hash of the synthetic operator password (ADR-007). */
const OPERATOR_HASH = await Bun.password.hash(OPERATOR_PASSWORD, { algorithm: "argon2id" });

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "llm-gateway-upstreams-"));

interface FakeSpec {
  /** connect() rejects when set — the create/update probe reports it as data. */
  connectError?: Error;
  /** listModels() rejects when set (a getter works too — read per call). */
  listModelsError?: Error;
  /** listModels() never settles when set — the budget race answers. */
  hangListModels?: boolean;
  /** The listing listModels() answers. */
  models?: ModelEntry[];
}

let instanceSeq = 0;

class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type = "openai-compatible" as const;
  listCalls = 0;
  forwards = 0;
  /** Per-instance identity: the completion answer names it, so a replaced
   * instance is distinguishable from the one it replaced. */
  readonly instance = ++instanceSeq;

  constructor(
    config: UpstreamConfig,
    private readonly spec: FakeSpec = {},
  ) {
    this.id = config.id;
  }

  async connect(): Promise<void> {
    if (this.spec.connectError !== undefined) throw this.spec.connectError;
  }

  async listModels(): Promise<ModelEntry[]> {
    this.listCalls += 1;
    if (this.spec.hangListModels === true) {
      return new Promise<ModelEntry[]>(() => {});
    }
    if (this.spec.listModelsError !== undefined) throw this.spec.listModelsError;
    return this.spec.models ?? [{ id: "qwen2.5:7b-instruct", object: "model", created: 1712267047, owned_by: "ollama" }];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    this.forwards += 1;
    return new Response(JSON.stringify({ id: `chatcmpl-${this.id}-${this.instance}`, choices: [] }), {
      headers: { "content-type": "application/json" },
    });
  }
}

/** The fixture config: `smart` routes to ollama only (so delete-refusal has
 * exactly one referencing model), `openai` is unreferenced (free to delete). */
function fixtureConfig(): Record<string, unknown> {
  return {
    upstreams: [
      { type: "openai-compatible", id: "openai", baseUrl: "https://openai.example.com/v1", apiKey: UPSTREAM_KEY_OPENAI },
      { type: "openai-compatible", id: "ollama", baseUrl: "https://ollama.example.com/v1", apiKey: UPSTREAM_KEY_OLLAMA },
    ],
    models: [
      {
        alias: "smart",
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct" }],
        balance: { strategy: "round-robin" },
      },
    ],
    clients: [{ name: "crud", apiKey: CLIENT_KEY_CRUD, models: ["smart"] }],
  };
}

interface FixtureApp {
  app: ReturnType<typeof createApp>;
  store: ConfigStore;
  registry: UpstreamRegistry;
  metadata: MetadataStore;
  specs: Map<string, FakeSpec>;
  configPath: string;
}

/** Build one gateway: config file on disk → store → registry of fakes → app. */
async function gateway(specs: Map<string, FakeSpec> = new Map(), ui: UiServingOptions = {}): Promise<FixtureApp> {
  const dir = join(FIXTURE_DIR, `case-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(fixtureConfig(), null, 2)}\n`, "utf8");
  const validated = validateGatewayConfig(JSON.parse(readFileSync(configPath, "utf8")));
  if (!validated.ok) throw new Error(`invalid fixture config: ${validated.problems.join("; ")}`);
  const store = new ConfigStore(validated.config, configPath);

  const entries = validated.config.upstreams;
  const factories: UpstreamFactories = {
    "openai-compatible": (entry) => {
      const made = new FakeUpstream(entry, specs.get(entry.id));
      return made;
    },
  };
  const logger = silentLogger();
  const registry = await UpstreamRegistry.create(entries, factories, logger);
  const metadata = new MetadataStore();
  const app = createApp(registry, logger, redactedConfigView(validated.config), {
    models: validated.config.models,
    clients: validated.config.clients,
    metadataStore: metadata,
    configStore: store,
    probeBudgetMs: 50,
    ...ui,
  });
  return { app, store, registry, metadata, specs, configPath };
}

/** The real key values must never appear in any response body. */
async function bodyText(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toContain(UPSTREAM_KEY_OPENAI);
  expect(text).not.toContain(UPSTREAM_KEY_OLLAMA);
  expect(text).not.toContain(CLIENT_KEY_CRUD);
  return text;
}

interface Envelope {
  error: { message: string; type: string; code?: string };
}

/* ------------------------------------------------------------------ */
/* reads: masked entries everywhere                                     */
/* ------------------------------------------------------------------ */

describe("GET /api/upstreams and GET /api/upstreams/:id", () => {
  test("lists every configured upstream masked, in config order; the single read mirrors the entry", async () => {
    const { app } = await gateway();

    const list = await app.request("/api/upstreams");
    expect(list.status).toBe(200);
    const listBody = JSON.parse(await bodyText(list)) as { upstreams: { id: string; apiKey: string; tlsFingerprint: string | null }[] };
    expect(listBody.upstreams.map((entry) => entry.id)).toEqual(["openai", "ollama"]);
    for (const entry of listBody.upstreams) {
      expect(entry.apiKey).toBe("[Configured]");
      expect(entry.tlsFingerprint).toBeNull();
    }

    const single = await app.request("/api/upstreams/ollama");
    expect(single.status).toBe(200);
    const singleBody = JSON.parse(await bodyText(single)) as { id: string; baseUrl: string; apiKey: string };
    expect(singleBody.id).toBe("ollama");
    expect(singleBody.baseUrl).toBe("https://ollama.example.com/v1");
    expect(singleBody.apiKey).toBe("[Configured]");
  });

  test("unknown id: the 404 envelope, answered before anything else", async () => {
    const { app } = await gateway();
    const response = await app.request("/api/upstreams/ghost");
    expect(response.status).toBe(404);
    const body = JSON.parse(await bodyText(response)) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("ghost");
  });
});

/* ------------------------------------------------------------------ */
/* create: validate → persist → probe → register → metadata slice       */
/* ------------------------------------------------------------------ */

describe("POST /api/upstreams", () => {
  test("creates: masked answer with probe ok, entry on disk, in the reads", async () => {
    const specs = new Map<string, FakeSpec>([
      ["extra", { models: [{ id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" }] }],
    ]);
    const { app, configPath } = await gateway(specs);

    const response = await app.request("/api/upstreams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        id: "extra",
        baseUrl: "https://extra.example.com/v1",
        apiKey: "sk-upstream-synthetic-extra",
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(await bodyText(response)) as { upstream: { id: string; apiKey: string }; probe: { ok: boolean } };
    expect(body.upstream.id).toBe("extra");
    expect(body.upstream.apiKey).toBe("[Configured]");
    expect(body.probe.ok).toBe(true);

    // Persisted (D1): the config file carries the new entry.
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { upstreams: { id: string }[] };
    expect(onDisk.upstreams.map((entry) => entry.id)).toEqual(["openai", "ollama", "extra"]);

    // The created instance is live in the registry: the ADR-011 live listing
    // contacts it (the fake counts the call) without any restart.
    const live = await app.request("/api/upstreams/extra/models");
    expect(live.status).toBe(200);
    const liveBody = JSON.parse(await bodyText(live)) as { upstream: string; models: { id: string }[] };
    expect(liveBody.upstream).toBe("extra");
    expect(liveBody.models.map((entry) => entry.id)).toEqual(["gpt-4o"]);

    // The reads reflect the mutation immediately (store view, not the startup snapshot).
    const listed = JSON.parse(await bodyText(await app.request("/api/upstreams"))) as { upstreams: { id: string }[] };
    expect(listed.upstreams.map((entry) => entry.id)).toEqual(["openai", "ollama", "extra"]);
    const detail = JSON.parse(await bodyText(await app.request("/api/upstreams/extra"))) as { id: string; apiKey: string };
    expect(detail.id).toBe("extra");
    expect(detail.apiKey).toBe("[Configured]");
  });

  test("a failed probe is data, not a cancellation: the mutation still lands (D8)", async () => {
    const specs = new Map<string, FakeSpec>([["broken", { connectError: new Error("connect ECONNREFUSED") }]]);
    const { app } = await gateway(specs);

    const response = await app.request("/api/upstreams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        id: "broken",
        baseUrl: "https://broken.example.com/v1",
        apiKey: "sk-upstream-synthetic-broken",
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(await bodyText(response)) as {
      upstream: { id: string };
      probe: { ok: boolean; reason?: string };
    };
    expect(body.probe.ok).toBe(false);
    expect(body.probe.reason).toContain("ECONNREFUSED");

    const listed = JSON.parse(await bodyText(await app.request("/api/upstreams"))) as { upstreams: { id: string }[] };
    expect(listed.upstreams.map((entry) => entry.id)).toContain("broken");
    // the probe outcome lives in the response body itself (D8) — the retired
    // /api/status inventory display no longer restates it
    expect(body.probe.ok).toBe(false);
  });

  test("a create with an empty tlsFingerprint lands as no pin: the answer reads null and the file carries no key", async () => {
    const { app, configPath } = await gateway();

    const response = await app.request("/api/upstreams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        id: "blank-pin",
        baseUrl: "https://blank.example.com/v1",
        apiKey: "sk-upstream-synthetic-blank",
        tlsFingerprint: "",
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(await bodyText(response)) as { upstream: { tlsFingerprint: string | null } };
    expect(body.upstream.tlsFingerprint).toBeNull(); // absent — never the mask, never ""

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { upstreams: Record<string, unknown>[] };
    expect(Object.hasOwn(onDisk.upstreams.find((entry) => entry.id === "blank-pin") ?? {}, "tlsFingerprint")).toBe(false);
  });

  test("a null body value is the key not set over HTTP: null pin/proxy land without keys, a null apiKey keeps on update and is reported missing on create", async () => {
    const { app, configPath } = await gateway();

    // create — null optional keys leave the entry without them
    const created = await app.request("/api/upstreams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        id: "nulls",
        baseUrl: "https://nulls.example.com/v1",
        apiKey: "sk-upstream-synthetic-nulls",
        tlsFingerprint: null,
        proxy: null,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = JSON.parse(await bodyText(created)) as {
      upstream: { tlsFingerprint: string | null; proxy: string | null };
    };
    expect(createdBody.upstream.tlsFingerprint).toBeNull();
    expect(createdBody.upstream.proxy).toBeNull();

    // update — a null apiKey (and a null id) read exactly like omitted ones: the
    // stored credential is kept, the id inherited (D7)
    const update = await app.request("/api/upstreams/nulls", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai-compatible", baseUrl: "https://nulls.example.com/v1", id: null, apiKey: null }),
    });
    expect(update.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { upstreams: Record<string, unknown>[] };
    const entry = onDisk.upstreams.find((candidate) => candidate.id === "nulls") ?? {};
    expect(entry.apiKey).toBe("sk-upstream-synthetic-nulls");
    expect(Object.hasOwn(entry, "tlsFingerprint")).toBe(false);
    expect(Object.hasOwn(entry, "proxy")).toBe(false);

    // create — a null required key is the 400 envelope, reported missing like an absent one
    const refused = await app.request("/api/upstreams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai-compatible", id: "nokey", baseUrl: "https://x.example.com/v1", apiKey: null }),
    });
    expect(refused.status).toBe(400);
    expect((JSON.parse(await bodyText(refused)) as Envelope).error.message).toContain('missing required key "apiKey"');
  });

  test("validation refusals are the 400 envelope and mutate nothing (duplicate id, grammar, mask literal)", async () => {
    const { app, configPath } = await gateway();
    const before = readFileSync(configPath, "utf8");

    const attempts: Record<string, unknown>[] = [
      { type: "openai-compatible", id: "openai", baseUrl: "https://x.example.com/v1", apiKey: "sk-dup" },
      { type: "openai-compatible", id: "Bad_Id", baseUrl: "https://x.example.com/v1", apiKey: "sk-bad" },
      { type: "openai-compatible", id: "masked", baseUrl: "https://x.example.com/v1", apiKey: "[Configured]" },
      { type: "openai-compatible", id: "nokey", baseUrl: "https://x.example.com/v1" },
    ];
    for (const payload of attempts) {
      const response = await app.request("/api/upstreams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      const body = JSON.parse(await bodyText(response)) as Envelope;
      expect(body.error.type).toBe("invalid_request_error");
    }

    expect(readFileSync(configPath, "utf8")).toBe(before);
    const listed = JSON.parse(await bodyText(await app.request("/api/upstreams"))) as { upstreams: { id: string }[] };
    expect(listed.upstreams.map((entry) => entry.id)).toEqual(["openai", "ollama"]);
  });
});

/* ------------------------------------------------------------------ */
/* update: hot-apply — the replaced instance serves /llm/v1             */
/* ------------------------------------------------------------------ */

describe("PUT /api/upstreams/:id", () => {
  test("the updated upstream serves /llm/v1 without a restart — the next request resolves the replacement", async () => {
    const { app } = await gateway();

    // Baseline: the startup instance answers (instance identity in the body).
    const before = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY_CRUD}` },
      body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(before.status).toBe(200);
    const beforeId = ((await before.json()) as { id: string }).id;
    expect(beforeId).toMatch(/^chatcmpl-ollama-\d+$/);

    const response = await app.request("/api/upstreams/ollama", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        id: "ollama",
        baseUrl: "https://moved.example.com/v1",
        // apiKey absent — keep the stored credential (D7).
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(await bodyText(response)) as {
      upstream: { id: string; apiKey: string; baseUrl: string };
      probe: { ok: boolean };
    };
    expect(body.probe.ok).toBe(true);
    expect(body.upstream.baseUrl).toBe("https://moved.example.com/v1");
    expect(body.upstream.apiKey).toBe("[Configured]");

    // No restart: the very next /llm/v1 request resolves the REPLACED
    // instance (the balancer resolves upstreams through the registry at
    // selection time) — a different instance answers under the same alias.
    const after = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY_CRUD}` },
      body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(after.status).toBe(200);
    const afterId = ((await after.json()) as { id: string }).id;
    expect(afterId).toMatch(/^chatcmpl-ollama-\d+$/);
    expect(afterId).not.toBe(beforeId); // a different instance serves the same alias
  });

  test("absent apiKey keeps the stored credential on disk (D7); unknown id is the 404 envelope", async () => {
    const { app, configPath } = await gateway();

    const update = await app.request("/api/upstreams/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai-compatible", id: "openai", baseUrl: "https://changed.example.com/v1" }),
    });
    expect(update.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
      upstreams: { id: string; apiKey: string; baseUrl: string }[];
    };
    const stored = onDisk.upstreams.find((entry) => entry.id === "openai");
    expect(stored?.apiKey).toBe(UPSTREAM_KEY_OPENAI);
    expect(stored?.baseUrl).toBe("https://changed.example.com/v1");

    const unknown = await app.request("/api/upstreams/ghost", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai-compatible", id: "ghost", baseUrl: "https://x.example.com/v1" }),
    });
    expect(unknown.status).toBe(404);
  });

  test("an empty tlsFingerprint is no pin: the answer and the file carry no key — never the mask, never \"\"", async () => {
    const { app, configPath } = await gateway();
    const storedPin = (): unknown =>
      (JSON.parse(readFileSync(configPath, "utf8")) as { upstreams: Record<string, unknown>[] }).upstreams.find((entry) => entry.id === "openai")?.tlsFingerprint;
    const put = (tlsFingerprint: string) =>
      app.request("/api/upstreams/openai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", id: "openai", baseUrl: "https://openai.example.com/v1", tlsFingerprint }),
      });
    const answerPin = async (response: Response): Promise<string | null> =>
      (JSON.parse(await bodyText(response)) as { upstream: { tlsFingerprint: string | null } }).upstream.tlsFingerprint;

    // a set pin answers with the mask (D7: the view never carries the value)
    expect(await answerPin(await put(SYNTHETIC_PIN))).toBe("[Configured]");
    expect(storedPin()).toBe(SYNTHETIC_PIN);

    // the grammar's empty value is "no pin" — it clears the stored pin like an explicit null
    for (const empty of ["", "   "]) {
      expect(await answerPin(await put(SYNTHETIC_PIN))).toBe("[Configured]");
      expect(await answerPin(await put(empty))).toBeNull(); // absent, never the mask
      expect(storedPin()).toBeUndefined(); // the file carries no key at all — never ""
      const list = await app.request("/api/upstreams");
      expect(
        ((await list.json()) as { upstreams: { id: string; tlsFingerprint: string | null }[] }).upstreams.find((entry) => entry.id === "openai")?.tlsFingerprint,
      ).toBeNull();
    }
  });

  test("validation refusals are the 400 envelope and leave disk untouched", async () => {
    const { app, configPath } = await gateway();
    const before = readFileSync(configPath, "utf8");

    const bad = await app.request("/api/upstreams/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai-compatible", id: "ollama", baseUrl: "https://x.example.com/v1", apiKey: "sk-x" }),
    });
    expect(bad.status).toBe(400); // id immutable: body id ≠ path id

    const masked = await app.request("/api/upstreams/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai-compatible", id: "openai", baseUrl: "https://x.example.com/v1", apiKey: "[Configured]" }),
    });
    expect(masked.status).toBe(400);

    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* delete: 409 in-use, otherwise removed everywhere                     */
/* ------------------------------------------------------------------ */

describe("DELETE /api/upstreams/:id", () => {
  test("an upstream referenced by a model route is refused with 409 resource_in_use (D6) and stays listed", async () => {
    const { app, configPath } = await gateway();
    const before = readFileSync(configPath, "utf8");

    const response = await app.request("/api/upstreams/ollama", { method: "DELETE" });
    expect(response.status).toBe(409);
    const body = JSON.parse(await bodyText(response)) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("resource_in_use");
    expect(body.error.message).toContain("smart");

    expect(readFileSync(configPath, "utf8")).toBe(before);
    const single = await app.request("/api/upstreams/ollama");
    expect(single.status).toBe(200);
  });

  test("an unreferenced upstream is removed from the store, disk, registry and metadata slice", async () => {
    const specs = new Map<string, FakeSpec>([
      ["openai", { models: [{ id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" }] }],
    ]);
    const { app, metadata } = await gateway(specs);
    metadata.set("openai", [{ id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" }]);

    const response = await app.request("/api/upstreams/openai", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await bodyText(response)).toBe(JSON.stringify({ deleted: "openai" }));

    const single = await app.request("/api/upstreams/openai");
    expect(single.status).toBe(404);
    const listed = JSON.parse(await bodyText(await app.request("/api/upstreams"))) as { upstreams: { id: string }[] };
    expect(listed.upstreams.map((entry) => entry.id)).toEqual(["ollama"]);
    // The metadata slice was cleared with the upstream.
    expect(metadata.entries("openai")).toEqual([]);
    // The ADR-011 live listing answers 404 for the removed id — before any
    // contact — proving the registry removal too.
    const live = await app.request("/api/upstreams/openai/models");
    expect(live.status).toBe(404);
  });

  test("unknown id is the 404 envelope; the last upstream cannot be removed (400)", async () => {
    const { app } = await gateway();

    const unknown = await app.request("/api/upstreams/ghost", { method: "DELETE" });
    expect(unknown.status).toBe(404);
  });

  test("the last remaining upstream is refused with the 400 envelope", async () => {
    // A config with exactly one upstream and no models block: nothing
    // references it, but a present upstreams collection keeps at least one
    // entry — the store's refusal, mapped to the 400 envelope.
    const dir = join(FIXTURE_DIR, `case-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "config.json");
    const raw = {
      upstreams: [{ type: "openai-compatible", id: "solo", baseUrl: "https://solo.example.com/v1", apiKey: "sk-upstream-synthetic-solo" }],
    };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const validated = validateGatewayConfig(JSON.parse(readFileSync(configPath, "utf8")));
    if (!validated.ok) throw new Error(`invalid fixture config: ${validated.problems.join("; ")}`);
    const store = new ConfigStore(validated.config, configPath);
    const logger = silentLogger();
    const registry = await UpstreamRegistry.create(validated.config.upstreams, {
      "openai-compatible": (entry) => new FakeUpstream(entry),
    }, logger);
    const app = createApp(registry, logger, redactedConfigView(validated.config), {
      configStore: store,
      probeBudgetMs: 50,
    });

    const response = await app.request("/api/upstreams/solo", { method: "DELETE" });
    expect(response.status).toBe(400);
    const body = JSON.parse(await bodyText(response)) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
  });
});

/* ------------------------------------------------------------------ */
/* the live listing: pure read; discover=1 swaps the slice (ADR-016)    */
/* ------------------------------------------------------------------ */

describe("GET /api/upstreams/:id/models?discover=1", () => {
  test("a successful discovered listing swaps the metadata slice — the alias reads reflect the fresh listing", async () => {
    // The alias `smart` routes to ollama/qwen2.5:7b-instruct — the listing's
    // qwen entry (with max_model_len) is what the alias metadata aggregate
    // folds.
    const specs = new Map<string, FakeSpec>([
      [
        "ollama",
        {
          models: [
            { id: "qwen2.5:7b-instruct", object: "model", created: 1712267047, owned_by: "ollama", max_model_len: 8192 },
          ],
        },
      ],
    ]);
    const { app, metadata } = await gateway(specs);

    /** The `smart` alias entry's aggregate, through the models read. */
    async function smartMeta(): Promise<{ contextWindow: number | null } | undefined> {
      const listed = JSON.parse(await bodyText(await app.request("/api/models"))) as {
        models: Array<{ alias: string; meta: { contextWindow: number | null } }>;
      };
      return listed.models.find((entry) => entry.alias === "smart")?.meta;
    }

    // Before any discovery the slice is empty: the aggregate knows nothing.
    expect((await smartMeta())?.contextWindow).toBeNull();

    const response = await app.request("/api/upstreams/ollama/models?discover=1");
    expect(response.status).toBe(200);
    const body = JSON.parse(await bodyText(response)) as { upstream: string; models: unknown[]; fetchedAt: string };
    expect(body.upstream).toBe("ollama");
    expect(body.models).toHaveLength(1);
    expect(body.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect((await smartMeta())?.contextWindow).toBe(8192);
    expect(metadata.entries("ollama")).toHaveLength(1);
  });

  test("without discover=1 the listing is a pure read — the slice stays empty", async () => {
    const specs = new Map<string, FakeSpec>([
      [
        "ollama",
        {
          models: [
            { id: "qwen2.5:7b-instruct", object: "model", created: 1712267047, owned_by: "ollama", max_model_len: 8192 },
          ],
        },
      ],
    ]);
    const { app, metadata } = await gateway(specs);

    const response = await app.request("/api/upstreams/ollama/models");
    expect(response.status).toBe(200);
    const body = JSON.parse(await bodyText(response)) as { upstream: string; models: unknown[] };
    expect(body.upstream).toBe("ollama");
    expect(body.models).toHaveLength(1);

    // The listing fetched, but nothing was written: the metadata store is
    // untouched, and the alias aggregate stays ignorant.
    expect(metadata.entries("ollama")).toEqual([]);
    const listed = JSON.parse(await bodyText(await app.request("/api/models"))) as {
      models: Array<{ alias: string; meta: { contextWindow: number | null } }>;
    };
    expect(listed.models.find((entry) => entry.alias === "smart")?.meta.contextWindow).toBeNull();
  });

  test("a failing discovered listing answers the 502 envelope and the store stays untouched when nothing was seeded", async () => {
    const specs = new Map<string, FakeSpec>([["openai", { listModelsError: new Error("provider went away") }]]);
    const { app, metadata } = await gateway(specs);

    const response = await app.request("/api/upstreams/openai/models?discover=1");
    expect(response.status).toBe(502);
    const body = JSON.parse(await bodyText(response)) as Envelope;
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("provider went away");
    // Retain-last-good: nothing to retain here, the slice stays empty.
    expect(metadata.entries("openai")).toEqual([]);
  });

  test("retain-last-good: a failing second discovered listing leaves the first serving", async () => {
    let calls = 0;
    // A getter-based spec: the first listModels succeeds, later ones fail —
    // FakeUpstream reads the property per call. The listing carries the
    // qwen entry (with max_model_len) the `smart` route aggregates on.
    const specs = new Map<string, FakeSpec>([
      [
        "ollama",
        {
          get listModelsError(): Error | undefined {
            return calls >= 1 ? new Error("provider went away") : undefined;
          },
          models: [
            { id: "qwen2.5:7b-instruct", object: "model", created: 1712267047, owned_by: "ollama", max_model_len: 8192 },
          ],
        },
      ],
    ]);
    const { app } = await gateway(specs);

    const first = await app.request("/api/upstreams/ollama/models?discover=1");
    expect(first.status).toBe(200);
    calls = 1;

    const second = await app.request("/api/upstreams/ollama/models?discover=1");
    expect(second.status).toBe(502);
    const body = JSON.parse(await bodyText(second)) as Envelope;
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("provider went away");

    // The first listing still serves (retain-last-good) — the alias reads
    // fold the retained slice.
    const listed = JSON.parse(await bodyText(await app.request("/api/models"))) as {
      models: Array<{ alias: string; meta: { contextWindow: number | null } }>;
    };
    expect(listed.models.find((entry) => entry.alias === "smart")?.meta.contextWindow).toBe(8192);
  });

  test("unknown id: the 404 envelope before any upstream contact", async () => {
    const specs = new Map<string, FakeSpec>([["openai", {}]]);
    const { app } = await gateway(specs);

    const response = await app.request("/api/upstreams/ghost/models?discover=1");
    expect(response.status).toBe(404);
  });

  test("the standalone discover mount is gone — every method answers the 404 envelope (ADR-016)", async () => {
    const specs = new Map<string, FakeSpec>([["openai", {}]]);
    const { app } = await gateway(specs);

    for (const method of ["GET", "POST"]) {
      const response = await app.request("/api/upstreams/openai/discover", { method });
      expect(response.status, method).toBe(404);
      const body = JSON.parse(await bodyText(response)) as Envelope;
      expect(body.error.type, method).toBe("invalid_request_error");
    }
  });
});

/* ------------------------------------------------------------------ */
/* the auth gate: 401 without a session, CRUD after login               */
/* ------------------------------------------------------------------ */

describe("the ADR-007 session gate over the CRUD surface", () => {
  test("every CRUD route answers the 401 envelope without a session; a valid session serves them", async () => {
    const { app } = await gateway(new Map(), {
      auth: { enabled: true, user: "operator", passwordHash: OPERATOR_HASH },
    });

    const attempts: { method: string; path: string }[] = [
      { method: "GET", path: "/api/upstreams" },
      { method: "POST", path: "/api/upstreams" },
      { method: "GET", path: "/api/upstreams/openai" },
      { method: "PUT", path: "/api/upstreams/openai" },
      { method: "DELETE", path: "/api/upstreams/openai" },
      { method: "GET", path: "/api/upstreams/openai/models" },
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

    const authorized = await app.request("/api/upstreams", { headers: { cookie } });
    expect(authorized.status).toBe(200);
    const listed = JSON.parse(await bodyText(authorized)) as { upstreams: { id: string }[] };
    expect(listed.upstreams.map((entry) => entry.id)).toEqual(["openai", "ollama"]);
  });
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});
