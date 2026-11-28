/**
 * E2E tests of the client management CRUD surface (ADR-014; `src/httpapi/
 * handlers/clients.ts`) through `createApp` — the full request path with the
 * runtime configuration store wired:
 *
 *  - the mounting generalization: the client gate mounts whenever the store
 *    is wired — an empty registry answers every /llm/v1 request 401
 *    (fail-closed, the surface never opens), which is distinct from the
 *    pre-ADR-014 deployment shape where no clients block is configured at
 *    all and no gate mounts; the first client created over the API admits
 *    immediately (the 0 → 1 transition, no restart);
 *  - reads list masked entries only (`[Configured]`, never the real key);
 *  - create/update/delete run validate → persist → hot-apply: the entry
 *    lands on disk and in the store, and the LLM gate's digest registry is
 *    rebuilt — a new key admits immediately, a changed ACL cuts immediately
 *    (403 on the now-forbidden alias, upstream never contacted), a deleted
 *    key answers 401 invalid_api_key immediately;
 *  - rejection paths: 401 without a session (gate on), 400 validation
 *    (duplicate name, empty/mask-literal apiKey, empty or unknown-alias
 *    models, immutable name, the last-entry rule), 404 unknown name.
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

/** Capturing logger stand-in (client-auth.test.ts pattern) for the
 * no-key-material-in-any-log-line assertions. */
interface CapturedLine {
  level: string;
  msg: string;
  obj: unknown;
}

function capturingLogger(): { logger: pino.Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const emit =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, msg: typeof obj === "string" ? obj : (msg ?? ""), obj });
    };
  const build = (): pino.Logger =>
    ({
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
      child: () => build(),
      flush: (done?: (err?: Error) => void) => done?.(),
    }) as unknown as pino.Logger;
  return { logger: build(), lines };
}

const UPSTREAM_KEY = "sk-upstream-synthetic-clients";
/** The fixture's initial client (present only when the config carries a clients block). */
const CLIENT_KEY = "sk-client-synthetic-initial";
/** The key the create/update tests put into effect at runtime. */
const NEW_CLIENT_KEY = "sk-client-synthetic-runtime";
const OPERATOR_PASSWORD = "operator-synthetic-password";
/** A real argon2id PHC hash of the synthetic operator password (ADR-007). */
const OPERATOR_HASH = await Bun.password.hash(OPERATOR_PASSWORD, { algorithm: "argon2id" });

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "llm-gateway-clients-"));

class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type = "openai-compatible" as const;
  forwards = 0;

  constructor(config: UpstreamConfig) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}

  async listModels(): Promise<ModelEntry[]> {
    return [{ id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" }];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    this.forwards += 1;
    return new Response(JSON.stringify({ id: `chatcmpl-${this.id}`, choices: [] }), {
      headers: { "content-type": "application/json" },
    });
  }
}

/** The fixture config; `withClients` false models the deployment whose
 * clients block does not exist yet — the empty-registry state. */
function fixtureConfig(withClients: boolean): Record<string, unknown> {
  return {
    upstreams: [{ type: "openai-compatible", id: "openai", baseUrl: "https://openai.example.com/v1", apiKey: UPSTREAM_KEY }],
    models: [
      {
        alias: "smart",
        routes: [{ upstream: "openai", model: "gpt-4o" }],
        balance: { strategy: "round-robin" },
      },
    ],
    ...(withClients ? { clients: [{ name: "ci", apiKey: CLIENT_KEY, models: ["smart"] }] } : {}),
  };
}

interface FixtureApp {
  app: ReturnType<typeof createApp>;
  store: ConfigStore;
  upstream: FakeUpstream;
  configPath: string;
}

/** Build one gateway: config file on disk → store → registry of fakes → app.
 * `withStore` false is the pre-ADR-014 deployment shape (no runtime CRUD,
 * no management store) — the mounting-distinction control group; its caller
 * reads only `app`. */
async function gateway(
  withClients: boolean,
  ui: UiServingOptions = {},
  withStore = true,
  logger: pino.Logger = silentLogger(),
): Promise<FixtureApp> {
  const dir = join(FIXTURE_DIR, `case-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(fixtureConfig(withClients), null, 2)}\n`, "utf8");
  const validated = validateGatewayConfig(JSON.parse(readFileSync(configPath, "utf8")));
  if (!validated.ok) throw new Error(`invalid fixture config: ${validated.problems.join("; ")}`);
  const store = withStore ? new ConfigStore(validated.config, configPath) : undefined;

  const entries = validated.config.upstreams;
  const upstream = new FakeUpstream(entries[0] as UpstreamConfig);
  const factories: UpstreamFactories = { "openai-compatible": () => upstream };
  const registry = await UpstreamRegistry.create(entries, factories, logger);
  const metadata = new MetadataStore();
  const app = createApp(registry, logger, redactedConfigView(validated.config), {
    models: validated.config.models,
    clients: validated.config.clients,
    metadataStore: metadata,
    ...(store !== undefined ? { configStore: store } : {}),
    ...ui,
  });
  // The control group (withStore false) reads only `app` — the narrowed
  // cast documents that the field is meaningful only for store-wired runs.
  return { app, store: store as ConfigStore, upstream, configPath };
}

/** The real key values must never appear in any response body. */
async function bodyText(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toContain(UPSTREAM_KEY);
  expect(text).not.toContain(CLIENT_KEY);
  expect(text).not.toContain(NEW_CLIENT_KEY);
  return text;
}

interface Envelope {
  error: { message: string; type: string; code?: string };
}

async function createEntry(app: ReturnType<typeof createApp>, body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* the mounting generalization: empty registry = fail-closed            */
/* ------------------------------------------------------------------ */

describe("the client gate over the runtime store (ADR-014 D2)", () => {
  test("an empty registry answers every /llm/v1 request 401 — the surface never opens (distinct from 'block not configured')", async () => {
    const { app } = await gateway(false);

    // The clients block does not exist yet: the store is wired, so the gate
    // mounts with an EMPTY registry and fails closed.
    const response = await app.request("/llm/v1/models");
    expect(response.status).toBe(401);
    const body = JSON.parse(await bodyText(response)) as Envelope;
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("authentication_required");

    // A made-up key matches nothing — invalid_api_key, still closed.
    const wrong = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${NEW_CLIENT_KEY}` } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as Envelope).error.code).toBe("invalid_api_key");
  });

  test("a store-less deployment without a clients block keeps the gate unmounted — the pre-ADR-014 shape", async () => {
    const { app } = await gateway(false, {}, false);

    // No clients block configured AND no runtime store: no gate mounts —
    // behavior identical to before ADR-008. This is the distinction the
    // empty-registry case above is measured against.
    const response = await app.request("/llm/v1/models");
    expect(response.status).toBe(200);
  });

  test("the first client created over the API admits immediately — the 0 → 1 transition, no restart", async () => {
    const { app, store, configPath } = await gateway(false);

    const created = await createEntry(app, { name: "first", apiKey: NEW_CLIENT_KEY, models: ["smart"] });
    expect(created.status).toBe(200);
    const body = JSON.parse(await bodyText(created)) as { client: { name: string; apiKey: string; models: string[] } };
    expect(body.client.name).toBe("first");
    expect(body.client.apiKey).toBe("[Configured]"); // masked — never the value
    expect(body.client.models).toEqual(["smart"]);

    // The very next request admits the new key — the gate's digest registry
    // was rebuilt within the running gateway (D2).
    const admitted = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${NEW_CLIENT_KEY}` } });
    expect(admitted.status).toBe(200);
    const catalog = (await admitted.json()) as { data: Array<{ id: string }> };
    expect(catalog.data.map((entry) => entry.id)).toEqual(["smart"]);

    // D1: the write landed on disk — a restart would reconstruct it.
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      clients: Array<{ name: string; apiKey: string; models: string[] }>;
    };
    expect(persisted.clients).toEqual([{ name: "first", apiKey: NEW_CLIENT_KEY, models: ["smart"] }]);
    expect(store.clients?.map((entry) => entry.name)).toEqual(["first"]);
  });
});

/* ------------------------------------------------------------------ */
/* reads: masked entries everywhere                                     */
/* ------------------------------------------------------------------ */

describe("GET /api/clients and GET /api/clients/:name", () => {
  test("lists every configured client masked, in config order; the single read mirrors the entry", async () => {
    const { app } = await gateway(true);

    const list = await app.request("/api/clients");
    expect(list.status).toBe(200);
    const listBody = JSON.parse(await bodyText(list)) as { clients: Array<{ name: string; apiKey: string; models: string[] }> };
    expect(listBody.clients.map((entry) => entry.name)).toEqual(["ci"]);
    for (const entry of listBody.clients) {
      expect(entry.apiKey).toBe("[Configured]");
      expect(entry.models).toEqual(["smart"]);
    }

    const single = await app.request("/api/clients/ci");
    expect(single.status).toBe(200);
    const singleBody = JSON.parse(await bodyText(single)) as { name: string; apiKey: string };
    expect(singleBody.name).toBe("ci");
    expect(singleBody.apiKey).toBe("[Configured]");
  });

  test("an empty registry answers an empty list; an unknown name is the 404 envelope", async () => {
    const { app } = await gateway(false);

    const empty = await app.request("/api/clients");
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { clients: unknown[] }).clients).toEqual([]);

    const missing = await app.request("/api/clients/ghost");
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("ghost");
  });
});

/* ------------------------------------------------------------------ */
/* create: validate → persist → hot-apply                               */
/* ------------------------------------------------------------------ */

describe("POST /api/clients", () => {
  test("creates: masked answer, on disk, in the reads — and the key admits /llm/v1 immediately", async () => {
    const { app, store, configPath } = await gateway(true);

    const created = await createEntry(app, { name: "batch", apiKey: NEW_CLIENT_KEY, models: ["smart"] });
    expect(created.status).toBe(200);
    const body = JSON.parse(await bodyText(created)) as { client: { name: string; apiKey: string } };
    expect(body.client.apiKey).toBe("[Configured]");

    // The new key authenticates on the very next request — no restart.
    const admitted = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${NEW_CLIENT_KEY}` } });
    expect(admitted.status).toBe(200);

    // The initial key keeps working — the registry rebuild is additive here.
    const still = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
    expect(still.status).toBe(200);

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as { clients: Array<{ name: string }> };
    expect(persisted.clients.map((entry) => entry.name)).toEqual(["ci", "batch"]);
    expect(store.clients?.map((entry) => entry.name)).toEqual(["ci", "batch"]);
  });

  test("validation refusals are the 400 envelope and mutate nothing (duplicate name, empty/mask apiKey, bad models, unknown key)", async () => {
    const { app, configPath } = await gateway(true);
    const before = readFileSync(configPath, "utf8");

    const refusals: Array<Record<string, unknown>> = [
      { name: "ci", apiKey: NEW_CLIENT_KEY, models: ["smart"] }, // duplicate name
      { name: "batch", apiKey: "", models: ["smart"] }, // empty apiKey
      { name: "batch", apiKey: "[Configured]", models: ["smart"] }, // the mask literal as a credential (D7)
      { name: "batch", apiKey: NEW_CLIENT_KEY, models: [] }, // empty models array
      { name: "batch", apiKey: NEW_CLIENT_KEY, models: ["ghost-alias"] }, // unknown alias
      { name: "batch", apiKey: NEW_CLIENT_KEY, models: ["smart"], extra: true }, // unknown key
    ];
    for (const payload of refusals) {
      const refused = await createEntry(app, payload);
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as Envelope;
      expect(body.error.type).toBe("invalid_request_error");
      expect(typeof body.error.message).toBe("string");
      // Value-free problem lines: no key material ever echoes back.
      expect(body.error.message).not.toContain(NEW_CLIENT_KEY);
    }

    // Disk and store untouched by every refusal.
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("no key material reaches any log line across the whole create flow", async () => {
    const { logger, lines } = capturingLogger();
    const { app } = await gateway(false, {}, true, logger);

    await createEntry(app, { name: "logged", apiKey: NEW_CLIENT_KEY, models: ["smart"] });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(NEW_CLIENT_KEY);
  });
});

/* ------------------------------------------------------------------ */
/* update: the ACL and the credential cut immediately                   */
/* ------------------------------------------------------------------ */

describe("PUT /api/clients/:name", () => {
  test("a changed ACL cuts immediately in a two-alias fixture — 403 on the forbidden alias, the upstream never contacted", async () => {
    const dir = join(FIXTURE_DIR, `case-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "config.json");
    const raw = {
      upstreams: [{ type: "openai-compatible", id: "openai", baseUrl: "https://openai.example.com/v1", apiKey: UPSTREAM_KEY }],
      models: [
        { alias: "smart", routes: [{ upstream: "openai", model: "gpt-4o" }], balance: { strategy: "round-robin" } },
        { alias: "other", routes: [{ upstream: "openai", model: "gpt-4o" }], balance: { strategy: "round-robin" } },
      ],
      clients: [{ name: "ci", apiKey: CLIENT_KEY, models: ["smart", "other"] }],
    };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const validated = validateGatewayConfig(JSON.parse(readFileSync(configPath, "utf8")));
    if (!validated.ok) throw new Error(`invalid fixture config: ${validated.problems.join("; ")}`);
    const store = new ConfigStore(validated.config, configPath);
    const upstream = new FakeUpstream(validated.config.upstreams[0] as UpstreamConfig);
    const logger = silentLogger();
    const registry = await UpstreamRegistry.create(validated.config.upstreams, { "openai-compatible": () => upstream }, logger);
    const app = createApp(registry, logger, redactedConfigView(validated.config), {
      models: validated.config.models,
      clients: validated.config.clients,
      metadataStore: new MetadataStore(),
      configStore: store,
    });

    // Baseline: both aliases pass the ACL.
    for (const alias of ["smart", "other"]) {
      const ok = await app.request("/llm/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY}` },
        body: JSON.stringify({ model: alias, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(ok.status).toBe(200);
    }
    const baselineForwards = upstream.forwards;
    expect(baselineForwards).toBe(2);

    // Narrow the ACL to "smart" only — the update hot-applies.
    const updated = await app.request("/api/clients/ci", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci", models: ["smart"] }),
    });
    expect(updated.status).toBe(200);

    // "other" is now forbidden: 403 before any upstream contact…
    const forbidden = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY}` },
      body: JSON.stringify({ model: "other", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(forbidden.status).toBe(403);
    const envelope = (await forbidden.json()) as Envelope;
    expect(envelope.error.type).toBe("invalid_request_error");
    expect(envelope.error.message).toContain("other");
    expect(upstream.forwards).toBe(baselineForwards); // no contact for the denied request

    // …while the allowed alias keeps answering, and the catalog reflects the
    // narrowed scope on the very next read.
    const allowed = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY}` },
      body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(allowed.status).toBe(200);
    const catalog = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
    const list = (await catalog.json()) as { data: Array<{ id: string }> };
    expect(list.data.map((entry) => entry.id)).toEqual(["smart"]);

    // D1: the narrowed ACL landed on disk.
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as { clients: Array<{ models: string[] }> };
    expect(persisted.clients[0]?.models).toEqual(["smart"]);
    void store;
  });

  test("an absent apiKey keeps the stored credential; a replaced key invalidates the old one immediately", async () => {
    const { app, configPath } = await gateway(true);

    // Absent apiKey (D7): only the models change — the old key keeps working.
    const kept = await app.request("/api/clients/ci", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci", models: ["smart"] }),
    });
    expect(kept.status).toBe(200);
    const keptBody = JSON.parse(await bodyText(kept)) as { client: { apiKey: string } };
    expect(keptBody.client.apiKey).toBe("[Configured]");
    const oldStillWorks = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
    expect(oldStillWorks.status).toBe(200);

    // A null apiKey (and a null name) read exactly like omitted ones — the
    // stored credential is kept, the name inherited (the null rule).
    const nullKept = await app.request("/api/clients/ci", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: null, apiKey: null, models: ["smart"] }),
    });
    expect(nullKept.status).toBe(200);
    const nullKeptBody = JSON.parse(await bodyText(nullKept)) as { client: { name: string; apiKey: string } };
    expect(nullKeptBody.client.name).toBe("ci");
    expect(nullKeptBody.client.apiKey).toBe("[Configured]");
    expect((await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${CLIENT_KEY}` } })).status).toBe(200);

    // A null required list is reported missing like an absent one.
    const nullModels = await app.request("/api/clients/ci", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: null }),
    });
    expect(nullModels.status).toBe(400);
    expect(((await nullModels.json()) as Envelope).error.message).toContain("models must be an array");

    // Replaced apiKey: the NEW key admits…
    const rotated = await app.request("/api/clients/ci", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci", apiKey: NEW_CLIENT_KEY, models: ["smart"] }),
    });
    expect(rotated.status).toBe(200);
    const admitted = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${NEW_CLIENT_KEY}` } });
    expect(admitted.status).toBe(200);

    // …and the OLD key answers invalid_api_key from the very next request on.
    const revoked = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as Envelope).error.code).toBe("invalid_api_key");

    // The rotation landed on disk.
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as { clients: Array<{ apiKey: string }> };
    expect(persisted.clients[0]?.apiKey).toBe(NEW_CLIENT_KEY);
  });

  test("rejection paths: 404 unknown name before validation, the immutable name, an unknown alias, the mask literal", async () => {
    const { app, configPath } = await gateway(true);
    const before = readFileSync(configPath, "utf8");

    const unknown = await app.request("/api/clients/ghost", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ghost", apiKey: NEW_CLIENT_KEY, models: ["smart"] }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Envelope).error.message).toContain("ghost");

    const refusals: Array<Record<string, unknown>> = [
      { name: "renamed", apiKey: CLIENT_KEY, models: ["smart"] }, // name is immutable
      { name: "ci", apiKey: CLIENT_KEY, models: ["ghost-alias"] }, // unknown alias
      { name: "ci", apiKey: "[Configured]", models: ["smart"] }, // the mask literal as a credential (D7)
    ];
    for (const payload of refusals) {
      const refused = await app.request("/api/clients/ci", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(refused.status).toBe(400);
    }

    // Disk untouched by every refusal.
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* delete: the key dies immediately                                     */
/* ------------------------------------------------------------------ */

describe("DELETE /api/clients/:name", () => {
  test("deletes: the deleted key answers 401 invalid_api_key immediately; the entry leaves store, disk and reads", async () => {
    const { app, store, configPath } = await gateway(true);

    // A second client first — a present clients block keeps at least one
    // entry, so the fixture's single client cannot be deleted outright.
    const created = await createEntry(app, { name: "batch", apiKey: NEW_CLIENT_KEY, models: ["smart"] });
    expect(created.status).toBe(200);

    const removed = await app.request("/api/clients/ci", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { deleted: string }).deleted).toBe("ci");

    // The revoked key fails closed on the very next request…
    const revoked = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as Envelope).error.code).toBe("invalid_api_key");

    // …while the surviving client's key keeps admitting, and the reads and
    // the disk reflect the removal.
    const surviving = await app.request("/llm/v1/models", { headers: { authorization: `Bearer ${NEW_CLIENT_KEY}` } });
    expect(surviving.status).toBe(200);
    const listed = await app.request("/api/clients");
    expect(((await listed.json()) as { clients: Array<{ name: string }> }).clients.map((e) => e.name)).toEqual(["batch"]);
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      clients: Array<{ name: string; apiKey: string; models: string[] }>;
    };
    expect(persisted.clients).toEqual([{ name: "batch", apiKey: NEW_CLIENT_KEY, models: ["smart"] }]);
    expect(store.clients?.map((entry) => entry.name)).toEqual(["batch"]);
  });

  test("the last entry of a present block is refused with 400; an unknown name is 404", async () => {
    const { app, configPath } = await gateway(true);
    const before = readFileSync(configPath, "utf8");

    const last = await app.request("/api/clients/ci", { method: "DELETE" });
    expect(last.status).toBe(400);
    const body = (await last.json()) as Envelope;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("last");

    const missing = await app.request("/api/clients/ghost", { method: "DELETE" });
    expect(missing.status).toBe(404);

    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* the ADR-007 session gate over the CRUD surface                       */
/* ------------------------------------------------------------------ */

describe("the ADR-007 session gate over the clients CRUD surface", () => {
  test("every CRUD route answers the 401 envelope without a session; a valid session serves them", async () => {
    const { app } = await gateway(true, {
      auth: { enabled: true, user: "operator", passwordHash: OPERATOR_HASH },
    });

    const attempts: { method: string; path: string }[] = [
      { method: "GET", path: "/api/clients" },
      { method: "POST", path: "/api/clients" },
      { method: "GET", path: "/api/clients/ci" },
      { method: "PUT", path: "/api/clients/ci" },
      { method: "DELETE", path: "/api/clients/ci" },
    ];
    for (const attempt of attempts) {
      const response = await app.request(attempt.path, {
        method: attempt.method,
        ...(attempt.method === "POST" || attempt.method === "PUT"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ci", apiKey: "x", models: ["smart"] }) }
          : {}),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as Envelope;
      expect(body.error.type).toBe("authentication_error");
      expect(body.error.code).toBe("authentication_required");
    }

    // A client Bearer credential is not an operator session: the /llm/v1 key
    // does not admit /api/*.
    const clientKeyOnApi = await app.request("/api/clients", {
      headers: { authorization: `Bearer ${CLIENT_KEY}` },
    });
    expect(clientKeyOnApi.status).toBe(401);

    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "operator", password: OPERATOR_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const authorized = await app.request("/api/clients", { headers: { cookie } });
    expect(authorized.status).toBe(200);
    const listed = JSON.parse(await bodyText(authorized)) as { clients: Array<{ name: string }> };
    expect(listed.clients.map((entry) => entry.name)).toEqual(["ci"]);
  });
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});
