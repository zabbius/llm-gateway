/**
 * The entry point's startup contracts (specs/architecture/data-flow.md
 * "Startup Flow", specs/architecture/layers.md):
 *
 * - in-process wiring: probes run sequentially, in config order, BEFORE the
 *   listener serves; a failed probe is a warning and startup continues; the
 *   registry is fully populated; parseListen decodes every listen grammar
 *   shape the schema accepts.
 * - subprocess smoke (the real process, real factory map, mock upstreams):
 *   the new client flow end to end — client Bearer key → alias → balanced
 *   mock upstreams on GET /llm/v1/models (per-key catalog) and POST
 *   /llm/v1/chat/completions, the management surface behind the cookie gate,
 *   startup lines on stderr, stdout stays empty, key material never appears,
 *   SIGTERM shuts down cleanly.
 * - invalid config: every problem on stderr, exit code 1, no port bound.
 * - TLS: https e2e with a throwaway self-signed cert (skipped when openssl is
 *   absent); tls enabled but a PEM file missing → clear stderr line, exit 1,
 *   no port bound.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import type { Upstream, UpstreamConfig, UpstreamStatus, ModelEntry, ProxyRequest } from "./upstreams/upstream.ts";
import type { UpstreamFactories } from "./upstreams/registry.ts";
import { parseListen, startGateway, type GatewayHandles } from "./index.ts";

/** A guaranteed-free loopback port (bind an ephemeral server, close it). */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("ephemeral server reported no port");
  return port;
}

/** Write a config file into a fresh temp dir; returns the path (caller cleans up). */
function tempConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-index-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function cleanupConfig(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}

/** Capturing fake upstream: records probe execution, never touches the network. */
class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"];

  constructor(
    config: UpstreamConfig,
    private readonly logger: pino.Logger,
    private readonly connectResult: "ok" | "throw" = "ok",
  ) {
    this.id = config.id;
    this.type = config.type;
  }

  async connect(): Promise<void> {
    if (this.connectResult === "throw") {
      throw new Error("probe exploded");
    }
    this.logger.info({ probe: "ran" }, "startup probe ok");
  }

  async listModels(): Promise<ModelEntry[]> {
    return [{ id: `${this.id}-model`, object: "model", created: 1, owned_by: this.id }];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(JSON.stringify({ echo: this.id }), {
      headers: { "content-type": "application/json" },
    });
  }
}

/** Factories whose upstreams record probe order in the shared `probes` array. */
function fakeFactories(
  probes: string[],
  throwing: ReadonlySet<string> = new Set(),
): UpstreamFactories {
  return {
    "openai-compatible": (entry, logger) => {
      const upstream = new FakeUpstream(entry, logger, throwing.has(entry.id) ? "throw" : "ok");
      const traced: Upstream = {
        id: upstream.id,
        type: upstream.type,
        connect: async () => {
          probes.push(entry.id);
          await upstream.connect();
        },
        listModels: () => upstream.listModels(),
        forward: (request) => upstream.forward(request),
      };
      return traced;
    },
  };
}

function configJson(
  listen: string,
  upstreams: UpstreamConfig[],
  models: Array<{ alias: string; upstream: string; model: string }> = [],
  clients: Array<{ name: string; apiKey: string; models: string[] }> = [],
): Record<string, unknown> {
  return {
    server: { listen },
    logLevel: "none",
    upstreams,
    ...(models.length > 0
      ? {
          models: models.map((route) => ({
            alias: route.alias,
            routes: [{ upstream: route.upstream, model: route.model }],
            balance: { strategy: "round-robin" },
          })),
        }
      : {}),
    ...(clients.length > 0 ? { clients } : {}),
  };
}

/**
 * The e2e client credential: production wiring always constructs the runtime
 * store, and since the clients CRUD (ADR-014) the client gate mounts over it
 * even before the first client exists — every /llm/v1 request below carries
 * this Bearer value, admitted by the `clients` block each affected fixture
 * configures.
 */
const E2E_CLIENT_KEY = "sk-e2e-client-value";

function e2eClient(models: string[]): { name: string; apiKey: string; models: string[] } {
  return { name: "e2e", apiKey: E2E_CLIENT_KEY, models };
}

function bearerClient(): Record<string, string> {
  return { authorization: `Bearer ${E2E_CLIENT_KEY}` };
}

function entry(id: string, baseUrl = "https://upstream.example/v1"): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl, apiKey: `sk-${id}-secret` };
}

describe("parseListen", () => {
  test("splits loopback, hostname, and bracketed IPv6 forms", () => {
    expect(parseListen("127.0.0.1:8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
    expect(parseListen("localhost:3000")).toEqual({ hostname: "localhost", port: 3000 });
    expect(parseListen("[::1]:443")).toEqual({ hostname: "::1", port: 443 });
    expect(parseListen("[2001:db8::1]:9000")).toEqual({ hostname: "2001:db8::1", port: 9000 });
  });
});

describe("startGateway (in-process wiring)", () => {
  test("probes run sequentially in config order before the listener serves", async () => {
    const port = freePort();
    const path = tempConfig(
      configJson(`127.0.0.1:${port}`, [entry("alpha"), entry("beta")], [
        { alias: "first-alias", upstream: "alpha", model: "alpha-model" },
        { alias: "second-alias", upstream: "beta", model: "beta-model" },
      ], [e2eClient(["first-alias", "second-alias"])]),
    );
    const probes: string[] = [];
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path, factories: fakeFactories(probes) });

      // By the time the listener answers, every probe already ran — and in order.
      const response = await fetch(`http://127.0.0.1:${port}/llm/v1/models`, { headers: bearerClient() });
      expect(response.status).toBe(200);
      expect(probes).toEqual(["alpha", "beta"]);

      const body = (await response.json()) as {
        object: string;
        data: Array<{ id: string; owned_by: string }>;
      };
      expect(body.object).toBe("list");
      expect(body.data.map((m) => `${m.id} ${m.owned_by}`)).toEqual([
        "first-alias llm-gateway",
        "second-alias llm-gateway",
      ]);

      handles.stop();
      await expect(fetch(`http://127.0.0.1:${port}/llm/v1/models`)).rejects.toThrow();
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });

  test("a failed probe warns but does not block startup", async () => {
    const port = freePort();
    const path = tempConfig(
      configJson(`127.0.0.1:${port}`, [entry("alpha"), entry("beta")], [
        { alias: "first-alias", upstream: "alpha", model: "alpha-model" },
        { alias: "second-alias", upstream: "beta", model: "beta-model" },
      ], [e2eClient(["first-alias", "second-alias"])]),
    );
    const probes: string[] = [];
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({
        configPath: path,
        factories: fakeFactories(probes, new Set(["beta"])),
      });

      expect(probes).toEqual(["alpha", "beta"]); // the second probe ran after the first threw
      const response = await fetch(`http://127.0.0.1:${port}/llm/v1/models`, { headers: bearerClient() });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((m) => m.id)).toEqual(["first-alias", "second-alias"]);
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });

  test("real factory map: an unreachable upstream still serves its configured alias", async () => {
    const port = freePort();
    const closed = freePort(); // no listener will ever exist here
    const path = tempConfig(
      configJson(`127.0.0.1:${port}`, [entry("solo", `http://127.0.0.1:${closed}/v1`)], [
        { alias: "solo-alias", upstream: "solo", model: "solo-model" },
      ], [e2eClient(["solo-alias"])]),
    );
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path }); // default (real) factories

      expect(handles.registry.find("solo")?.id).toBe("solo");
      const response = await fetch(`http://127.0.0.1:${port}/llm/v1/models`, { headers: bearerClient() });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { object: string; data: Array<{ id: string }> };
      expect(body.object).toBe("list");
      // The catalog is the gateway's own (ADR-009): the unreachable upstream
      // does not remove its alias from the list.
      expect(body.data.map((m) => m.id)).toEqual(["solo-alias"]);
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });
  test("auth enabled: /api gated by the session cookie — /llm/v1 admits the client key, the shell stays open", async () => {
    const port = freePort();
    const password = "operator-password";
    const passwordHash = Bun.password.hashSync(password, { algorithm: "argon2id" });
    const path = tempConfig({
      ...configJson(`127.0.0.1:${port}`, [entry("alpha")], [{ alias: "admin-alias", upstream: "alpha", model: "m" }], [
        e2eClient(["admin-alias"]),
      ]),
      auth: { enabled: true, user: "admin", passwordHash },
    });
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path, factories: fakeFactories([]) });
      const base = `http://127.0.0.1:${port}`;

      // unauthenticated management read → 401 envelope, no native prompt
      const gated = await fetch(`${base}/api/status`);
      expect(gated.status).toBe(401);
      expect(gated.headers.get("www-authenticate")).toBeNull();
      const gatedBody = (await gated.json()) as { error: { type: string; code: string } };
      expect(gatedBody.error.type).toBe("authentication_error");
      expect(gatedBody.error.code).toBe("authentication_required");

      // the LLM surface admits the client credential (never the session) and
      // the UI redirect stays open
      expect((await fetch(`${base}/llm/v1/models`, { headers: bearerClient() })).status).toBe(200);
      expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(302);

      // login mints the cookie; the cookie admits
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "admin", password }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(cookie.startsWith("llm_gateway_session=")).toBe(true);
      const admitted = await fetch(`${base}/api/status`, { headers: { cookie } });
      expect(admitted.status).toBe(200);
      // the refresh bit: a valid session self-reports, the SPA's Log out survives reloads
      expect(((await admitted.json()) as { authenticated: boolean }).authenticated).toBe(true);

      // the retired whole-view read answers the envelope 404 in every
      // deployment — the masking rule lives on in the CRUD reads instead
      const removed = await fetch(`${base}/api/configuration`, { headers: { cookie } });
      expect(removed.status).toBe(404);
      const removedBody = (await removed.json()) as { error: { type: string; message: string } };
      expect(removedBody.error.type).toBe("invalid_request_error");
      expect(JSON.stringify(removedBody)).not.toContain(passwordHash);

      // logout revokes: the same cookie stops admitting
      const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
      expect(logout.status).toBe(200);
      expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);

      // wrong credentials: delayed 401 invalid_credentials
      const bad = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "admin", password: "wrong-password" }),
      });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_credentials");
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });

  test("clients configured: the config slice gates /llm/v1 with Bearer keys and scopes /models per key", async () => {
    const port = freePort();
    const CLIENT_KEY = "sk-wiring-client-value";
    const path = tempConfig({
      ...configJson(`127.0.0.1:${port}`, [entry("alpha"), entry("beta")], [
        { alias: "first-alias", upstream: "alpha", model: "alpha-model" },
        { alias: "second-alias", upstream: "beta", model: "beta-model" },
      ]),
      clients: [{ name: "wiring", apiKey: CLIENT_KEY, models: ["first-alias"] }],
    });
    const probes: string[] = [];
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path, factories: fakeFactories(probes) });

      // The clients slice reached the gate: no key → 401 envelope before
      // routing; the configured key → admitted.
      const denied = await fetch(`http://127.0.0.1:${port}/llm/v1/models`);
      expect(denied.status).toBe(401);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("authentication_required");
      const admitted = await fetch(`http://127.0.0.1:${port}/llm/v1/models`, {
        headers: { authorization: `Bearer ${CLIENT_KEY}` },
      });
      expect(admitted.status).toBe(200);

      // The models slice reached the routing table: the catalog is the
      // alias list, scoped to this client's `models` ACL.
      const catalog = (await admitted.json()) as { object: string; data: Array<{ id: string }> };
      expect(catalog.object).toBe("list");
      expect(catalog.data.map((m) => m.id)).toEqual(["first-alias"]);
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });

  test("discovery at start: the probes' catalogs seed the metadata store — the catalog gains limit/capabilities, and requests contact no upstream", async () => {
    const port = freePort();
    const path = tempConfig(
      configJson(`127.0.0.1:${port}`, [entry("alpha"), entry("dead")], [
        { alias: "first-alias", upstream: "alpha", model: "alpha-model" },
        { alias: "second-alias", upstream: "dead", model: "dead-model" },
      ], [e2eClient(["first-alias", "second-alias"])]),
    );
    const listing: ModelEntry[] = [
      {
        id: "alpha-model",
        object: "model",
        created: 1,
        owned_by: "alpha",
        limit: { context: 32768, output: 8192 },
        capabilities: { tools: { supported: true }, reasoning: { supported: false }, temperature: true },
        modalities: { input: ["text", "image/png"] },
      },
    ];
    /** Retains its startup catalog (the openai-compatible behavior) and counts its listModels calls. */
    class CatalogUpstream implements Upstream {
      readonly id: string;
      readonly type: UpstreamConfig["type"] = "openai-compatible";
      listModelCalls = 0;
      constructor(config: UpstreamConfig, private readonly catalog: ModelEntry[], private readonly probeFailure?: Error) {
        this.id = config.id;
      }
      async connect(): Promise<void> {
        if (this.probeFailure !== undefined) {
          throw this.probeFailure;
        }
        await this.listModels();
      }
      async listModels(): Promise<ModelEntry[]> {
        this.listModelCalls += 1;
        return this.catalog;
      }
      async forward(_request: ProxyRequest): Promise<Response> {
        return new Response(JSON.stringify({ echo: this.id }), { headers: { "content-type": "application/json" } });
      }
      status(): UpstreamStatus {
        return Object.freeze({
          id: this.id,
          type: this.type,
          probe: "ok" as const,
          models: Object.freeze(this.catalog.map((model) => Object.freeze(model))),
        });
      }
    }
    const healthy = new CatalogUpstream(entry("alpha"), listing);
    const dead = new CatalogUpstream(entry("dead"), [], new Error("connection refused"));
    const factories: UpstreamFactories = {
      "openai-compatible": (config) => (config.id === "alpha" ? healthy : dead),
    };
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path, factories });
      const base = `http://127.0.0.1:${port}`;
      const startupCalls = healthy.listModelCalls;
      expect(startupCalls).toBe(1); // discovery at start, from the probe

      // the seeded alias's catalog entry carries the metadata projection
      const models = await fetch(`${base}/llm/v1/models`, { headers: bearerClient() });
      const list = (await models.json()) as {
        data: Array<{ id: string; limit?: { context: number; output: number }; capabilities?: unknown; modalities?: { input: string[] } }>;
      };
      const first = list.data.find((model) => model.id === "first-alias");
      expect(first?.limit).toEqual({ context: 32768, output: 8192 });
      expect(first?.capabilities).toEqual({ tools: { supported: true }, reasoning: { supported: false }, temperature: true });
      expect(first?.modalities).toEqual({ input: ["text", "image/png"] });
      // the failed probe seeded nothing — its alias stays bare
      const second = list.data.find((model) => model.id === "second-alias");
      expect(second?.limit).toBeUndefined();
      expect(second?.capabilities).toBeUndefined();

      // /api/status: the retired inventory display (meta[] included) is gone —
      // the probe answers the fixed shape, and the seeding stays observable
      // through the catalog projection above
      const status = await fetch(`${base}/api/status`);
      expect(status.status).toBe(200);
      expect((await status.json()) as { status: string; authenticated: boolean }).toEqual({
        status: "ok",
        authenticated: false,
      });

      // none of those requests contacted an upstream
      expect(healthy.listModelCalls).toBe(startupCalls);
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });
});

describe("startGateway (subprocess, real process)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");

  interface MockUpstream {
    port: number;
    stop(): void;
    seen: Array<{ path: string; authorization: string | undefined; model: unknown }>;
  }

  /** Minimal OpenAI-compatible upstream: records each request it receives. */
  function mockUpstream(): MockUpstream {
    const seen: MockUpstream["seen"] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization") ?? undefined;
        let model: unknown = undefined;
        if (request.method === "POST") {
          const body = (await request.json()) as { model?: unknown };
          model = body.model;
        }
        seen.push({ path: url.pathname, authorization, model });
        if (request.method === "GET" && url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "test-model", object: "model", created: 1, owned_by: "mockup" }],
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
          return Response.json({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          });
        }
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      },
    });
    const port = server.port;
    if (port === undefined) throw new Error("mock upstream reported no port");
    return { port, stop: () => server.stop(true), seen };
  }

  function spawnGateway(configPath: string): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, LLM_GATEWAY_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Narrow the spawned process's piped stream (typed as a union by Bun). */
  function piped(stream: ReturnType<typeof Bun.spawn>["stdout"]): ReadableStream<Uint8Array> {
    if (!(stream instanceof ReadableStream)) throw new Error("expected a piped stream");
    return stream;
  }

  /** Path of openssl, or null when the system has none (the https e2e skips). */
  const OPENSSL = Bun.which("openssl");

  /**
   * Generate a throwaway self-signed certificate/key pair with openssl into
   * `dir` (test-only material; the caller deletes the directory). Returns the
   * two file paths the config references.
   */
  async function selfSignedCert(dir: string): Promise<{ cert: string; key: string }> {
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    const proc = Bun.spawnSync(
      ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : "";
      throw new Error(`openssl failed (code ${proc.exitCode}):\n${stderr}`);
    }
    return { cert, key };
  }

  async function waitUntilReady(
    url: string,
    proc: ReturnType<typeof Bun.spawn>,
    timeoutMs: number,
    init: BunFetchRequestInit = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        const stderr = await new Response(piped(proc.stderr)).text();
        throw new Error(`gateway process exited early (code ${proc.exitCode}):\n${stderr}`);
      }
      try {
        const response = await fetch(url, init);
        if (response.ok) return;
      } catch {
        // not listening yet — poll again
      }
      await Bun.sleep(100);
    }
    throw new Error(`gateway did not become ready within ${timeoutMs}ms: ${url}`);
  }

  test("end-to-end smoke: client Bearer key → alias → balanced upstreams, per-key /models, /api behind the cookie gate", async () => {
    const CLIENT_KEY = "sk-smoke-client-value";
    const OTHER_KEY = "sk-other-client-value";
    const UPSTREAM_KEY_A = "sk-upstream-a-secret";
    const UPSTREAM_KEY_B = "sk-upstream-b-secret";
    const upstreamA = mockUpstream();
    const upstreamB = mockUpstream();
    const password = "operator-password";
    const passwordHash = Bun.password.hashSync(password, { algorithm: "argon2id" });
    const port = freePort();
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}` },
      logLevel: "info",
      auth: { enabled: true, user: "admin", passwordHash },
      clients: [
        { name: "smoke", apiKey: CLIENT_KEY, models: ["smoke-alias"] },
        { name: "other", apiKey: OTHER_KEY, models: ["other-alias"] },
      ],
      models: [
        {
          alias: "smoke-alias",
          routes: [
            { upstream: "mock-a", model: "test-model" },
            { upstream: "mock-b", model: "test-model" },
          ],
          balance: { strategy: "round-robin" },
        },
        {
          alias: "other-alias",
          routes: [{ upstream: "mock-a", model: "test-model" }],
          balance: { strategy: "round-robin" },
        },
      ],
      upstreams: [
        { type: "openai-compatible", id: "mock-a", baseUrl: `http://127.0.0.1:${upstreamA.port}/v1`, apiKey: UPSTREAM_KEY_A },
        { type: "openai-compatible", id: "mock-b", baseUrl: `http://127.0.0.1:${upstreamB.port}/v1`, apiKey: UPSTREAM_KEY_B },
      ],
    });
    const proc = spawnGateway(path);
    const stdoutText = new Response(piped(proc.stdout)).text();
    const stderrText = new Response(piped(proc.stderr)).text();
    const base = `http://127.0.0.1:${port}`;
    const bearer = (key: string): Record<string, string> => ({
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    });
    const chatCount = (upstream: MockUpstream): number =>
      upstream.seen.filter((s) => s.path === "/v1/chat/completions").length;
    try {
      // Login-less: the LLM surface wants a client Bearer key, never a session.
      await waitUntilReady(`${base}/llm/v1/models`, proc, 15_000, {
        headers: { authorization: `Bearer ${CLIENT_KEY}` },
      });

      // No credential and an unknown credential: the client gate answers 401
      // before routing, with distinct envelope codes.
      const noKey = await fetch(`${base}/llm/v1/models`);
      expect(noKey.status).toBe(401);
      expect(((await noKey.json()) as { error: { code: string } }).error.code).toBe("authentication_required");
      const wrongKey = await fetch(`${base}/llm/v1/models`, {
        headers: { authorization: "Bearer sk-not-configured" },
      });
      expect(wrongKey.status).toBe(401);
      expect(((await wrongKey.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");

      // GET /llm/v1/models — the alias catalog scoped to the presenting key
      // (ADR-009 per-client ACL): each client sees only its own aliases.
      const smokeModels = await fetch(`${base}/llm/v1/models`, { headers: bearer(CLIENT_KEY) });
      expect(smokeModels.status).toBe(200);
      const smokeCatalog = (await smokeModels.json()) as {
        object: string;
        data: Array<{ id: string; owned_by: string; object: string; created: number }>;
      };
      expect(smokeCatalog).toEqual({
        object: "list",
        data: [{ id: "smoke-alias", object: "model", created: expect.any(Number), owned_by: "llm-gateway" }],
      });
      const otherModels = await fetch(`${base}/llm/v1/models`, { headers: bearer(OTHER_KEY) });
      expect(otherModels.status).toBe(200);
      expect(((await otherModels.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual([
        "other-alias",
      ]);

      // POST /llm/v1/chat/completions — dispatch resolves the alias and the
      // round-robin schedule rotates the alias's two routes.
      for (let i = 0; i < 4; i++) {
        const chatResponse = await fetch(`${base}/llm/v1/chat/completions`, {
          method: "POST",
          headers: bearer(CLIENT_KEY),
          body: JSON.stringify({ model: "smoke-alias", messages: [{ role: "user", content: "ping" }] }),
        });
        expect(chatResponse.status).toBe(200);
        const chat = (await chatResponse.json()) as { choices: Array<{ message: { content: string } }> };
        expect(chat.choices[0]?.message.content).toBe("pong");
      }
      // Balanced: the four requests rotated evenly across the two routes.
      expect(chatCount(upstreamA)).toBe(2);
      expect(chatCount(upstreamB)).toBe(2);

      // Each upstream saw its own config credential and the de-prefixed
      // provider model — never the client's Bearer key.
      for (const [upstream, upstreamKey] of [
        [upstreamA, UPSTREAM_KEY_A],
        [upstreamB, UPSTREAM_KEY_B],
      ] as const) {
        for (const seen of upstream.seen) {
          expect(seen.authorization).toBe(`Bearer ${upstreamKey}`);
          if (seen.path === "/v1/chat/completions") expect(seen.model).toBe("test-model");
        }
      }

      // The per-client ACL (403) and an unknown alias (404) — both answered
      // without any upstream contact.
      const forbidden = await fetch(`${base}/llm/v1/chat/completions`, {
        method: "POST",
        headers: bearer(CLIENT_KEY),
        body: JSON.stringify({ model: "other-alias", messages: [{ role: "user", content: "ping" }] }),
      });
      expect(forbidden.status).toBe(403);
      expect(chatCount(upstreamA) + chatCount(upstreamB)).toBe(4); // no upstream saw the denied requests
      const unknown = await fetch(`${base}/llm/v1/chat/completions`, {
        method: "POST",
        headers: bearer(CLIENT_KEY),
        body: JSON.stringify({ model: "ghost-alias", messages: [{ role: "user", content: "ping" }] }),
      });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("model_not_found");

      // The management surface stays behind the cookie gate (ADR-007) — the
      // flow unchanged — and the two credential classes stay separate: the
      // session cookie does not admit /llm/v1, the client key does not
      // admit /api.
      const gated = await fetch(`${base}/api/status`);
      expect(gated.status).toBe(401);
      expect(((await gated.json()) as { error: { code: string } }).error.code).toBe("authentication_required");
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "admin", password }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(cookie.startsWith("llm_gateway_session=")).toBe(true);
      const admitted = await fetch(`${base}/api/status`, { headers: { cookie } });
      expect(admitted.status).toBe(200);
      expect(((await admitted.json()) as { authenticated: boolean }).authenticated).toBe(true);
      expect((await fetch(`${base}/llm/v1/models`, { headers: { cookie } })).status).toBe(401);
      expect((await fetch(`${base}/api/status`, { headers: bearer(CLIENT_KEY) })).status).toBe(401);
      const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
      expect(logout.status).toBe(200);
      expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);

      // Startup logging is asserted after shutdown: only then do the piped
      // streams reach EOF and deliver their full contents.
      proc.kill();
      expect(await proc.exited).toBe(0);

      const stderr = await stderrText;
      expect(stderr).toContain('"config loaded');
      expect(stderr).toContain('"id":"mock-a"');
      expect(stderr).toContain('"id":"mock-b"');
      expect(stderr).toContain('"type":"openai-compatible"');
      expect(stderr.split("startup probe ok").length - 1).toBe(2);
      expect(stderr).toContain('"gateway listening"');
      expect(stderr).toContain("shutdown requested");
      // No credential material anywhere: neither class's keys nor the hash.
      for (const secret of [CLIENT_KEY, OTHER_KEY, UPSTREAM_KEY_A, UPSTREAM_KEY_B, passwordHash]) {
        expect(stderr).not.toContain(secret);
      }
      // stdout stays empty forever (observability.md).
      expect((await stdoutText).trim()).toBe("");
    } finally {
      proc.kill();
      await proc.exited.catch(() => undefined);
      upstreamA.stop();
      upstreamB.stop();
      cleanupConfig(path);
    }
  }, 30_000);

  test("route inventory: a missing model warns per route, an unreachable upstream stays silent, and the verdicts stay log-only", async () => {
    const apiKey = "sk-inventory-secret-value";
    const upstream = mockUpstream(); // retains the catalog [test-model]
    const port = freePort();
    const closed = freePort(); // no listener will ever exist here — the probe fails
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}` },
      logLevel: "info",
      upstreams: [
        { type: "openai-compatible", id: "mock", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey },
        { type: "openai-compatible", id: "dead", baseUrl: `http://127.0.0.1:${closed}/v1`, apiKey },
      ],
      models: [
        {
          alias: "known",
          routes: [{ upstream: "mock", model: "test-model" }],
          balance: { strategy: "round-robin" },
        },
        {
          alias: "ghost",
          routes: [{ upstream: "mock", model: "missing-model" }],
          balance: { strategy: "round-robin" },
        },
        {
          alias: "offline",
          routes: [
            { upstream: "dead", model: "qwen2.5:7b-instruct" },
            { upstream: "dead", model: "llama3:8b" },
          ],
          balance: { strategy: "round-robin" },
        },
      ],
    });
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      // The server started despite the findings — warn-never-abort.
      await waitUntilReady(`http://127.0.0.1:${port}/api/status`, proc, 15_000);

      // /api/status: the retired three-state route-health display is gone —
      // the probe answers the fixed shape; the verdicts live in the startup
      // logs asserted below.
      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(statusResponse.status).toBe(200);
      const status = (await statusResponse.json()) as { status: string; authenticated: boolean };
      expect(status).toEqual({ status: "ok", authenticated: false });

      proc.kill();
      expect(await proc.exited).toBe(0);

      const stderr = await stderrText;
      // Exactly one per-route warning — the verified-missing model on the ok
      // upstream. The unreachable upstream's two routes stay silent: its
      // single upstream-level probe warning is the only mention of "dead".
      expect(stderr.split("not in the upstream's startup catalog").length - 1).toBe(1);
      expect(stderr).toContain('"alias":"ghost"');
      expect(stderr).toContain('"upstream":"mock"');
      expect(stderr).toContain('"model":"missing-model"');
      expect(stderr).not.toContain('"alias":"offline"');
      expect(stderr).toContain("startup probe failed");
      expect(stderr).toContain("route inventory cross-checked against startup catalogs");
      expect(stderr).not.toContain(apiKey);
    } finally {
      proc.kill();
      await proc.exited.catch(() => undefined);
      upstream.stop();
      cleanupConfig(path);
    }
  }, 30_000);

  test("invalid config: every problem on stderr, exit 1, no port bound", async () => {
    const port = freePort(); // the listen the config WOULD have used
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}` },
      logLevel: "info",
      upstreams: [{ type: "nonexistent-type", id: "x", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }],
    });
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      expect(await proc.exited).toBe(1);

      const stderr = await stderrText;
      expect(stderr).toContain("unknown upstream type");
      expect(stderr).toContain("upstreams[0]");
      expect(stderr).not.toContain('"gateway listening"');

      await expect(fetch(`http://127.0.0.1:${port}/llm/v1/models`)).rejects.toThrow();
    } finally {
      proc.kill();
      cleanupConfig(path);
    }
  }, 15_000);

  // Graceful degradation: without openssl the https surface is skipped, not
  // failed — the rest of the suite still verifies the gateway.
  test.skipIf(OPENSSL === null)("end-to-end over TLS: https models list through the started process", async () => {
    const apiKey = "sk-tls-secret-value";
    const upstream = mockUpstream();
    const port = freePort();
    const dir = mkdtempSync(join(tmpdir(), "gw-index-tls-"));
    const { cert, key } = await selfSignedCert(dir);
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}`, tls: { enabled: true, cert, key } },
      logLevel: "info",
      upstreams: [
        { type: "openai-compatible", id: "mock", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey },
      ],
      models: [
        {
          alias: "tls-alias",
          routes: [{ upstream: "mock", model: "test-model" }],
          balance: { strategy: "round-robin" },
        },
      ],
      clients: [e2eClient(["tls-alias"])],
    });
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      // The test client accepts the self-signed certificate — the fetch-side
      // equivalent of curl -k, scoped to these requests only. Verification
      // stays fully on everywhere else.
      const insecure: BunFetchRequestInit = { tls: { rejectUnauthorized: false } };
      const url = `https://127.0.0.1:${port}/llm/v1/models`;
      await waitUntilReady(url, proc, 15_000, { ...insecure, headers: bearerClient() });

      const modelsResponse = await fetch(url, { ...insecure, headers: bearerClient() });
      expect(modelsResponse.status).toBe(200);
      const models = (await modelsResponse.json()) as {
        object: string;
        data: Array<{ id: string; owned_by: string; object: string; created: number }>;
      };
      expect(models.object).toBe("list");
      expect(models.data).toEqual([
        { id: "tls-alias", object: "model", created: expect.any(Number), owned_by: "llm-gateway" },
      ]);

      proc.kill();
      expect(await proc.exited).toBe(0);

      const stderr = await stderrText;
      expect(stderr).toContain('"gateway listening"');
      // The listening line carries the fact of TLS — never the PEM contents
      // (security-model.md invariant 7).
      expect(stderr).toContain('"tls":true');
      expect(stderr).not.toContain("BEGIN CERTIFICATE");
      expect(stderr).not.toContain("PRIVATE KEY");
      expect(stderr).not.toContain(apiKey);
    } finally {
      proc.kill();
      await proc.exited.catch(() => undefined);
      upstream.stop();
      cleanupConfig(path);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("tls enabled but the certificate file is missing: clear stderr line, exit 1, no port bound", async () => {
    const port = freePort(); // the listen the config WOULD have used
    const dir = mkdtempSync(join(tmpdir(), "gw-index-tls-missing-"));
    const certPath = join(dir, "cert.pem"); // never created
    const keyPath = join(dir, "key.pem"); // never created
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          server: { listen: `127.0.0.1:${port}`, tls: { enabled: true, cert: certPath, key: keyPath } },
          logLevel: "info",
          upstreams: [{ type: "openai-compatible", id: "mock", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }],
        },
        null,
        2,
      ),
    );
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      expect(await proc.exited).toBe(1);

      const stderr = await stderrText;
      expect(stderr).toContain(`tls certificate file not found/readable: ${certPath}`);
      expect(stderr).not.toContain('"gateway listening"');

      await expect(fetch(`http://127.0.0.1:${port}/llm/v1/models`)).rejects.toThrow();
    } finally {
      proc.kill();
      cleanupConfig(path);
    }
  }, 15_000);
});
