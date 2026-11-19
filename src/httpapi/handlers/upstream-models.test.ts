/**
 * The `GET /api/upstreams/:id/models` contracts (ADR-011,
 * specs/contracts/gateway-management.md): the operator-triggered live
 * `listModels()` through the named upstream — the management boundary's only
 * request-time upstream contact. Success carries the provider-native,
 * unprefixed catalog plus `fetchedAt` and no credential material; an unknown
 * id is the 404 envelope answered before any upstream contact; a failing
 * upstream (rejection or probe-budget expiry) is the 502 `upstream_error`
 * envelope; and the route sits behind the ADR-007 session gate whenever
 * `auth.enabled` — no exemption of its own.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../../upstreams/registry.ts";
import type { GatewayEnv } from "../../gateway/router.ts";
import { redactedConfigView } from "../../config/redact.ts";
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from "../../config/schema.ts";
import { createApp } from "../app.ts";
import { SESSION_COOKIE } from "../auth.ts";
import { handleUpstreamModels, UPSTREAM_MODELS_TIMEOUT_MS } from "./upstream-models.ts";

/** A real argon2id hash for the gate-flow test (auth.test.ts pattern). */
const OPERATOR_USER = "admin";
const OPERATOR_PASSWORD = "operator-password-31337";
const OPERATOR_HASH = await Bun.password.hash(OPERATOR_PASSWORD, { algorithm: "argon2id" });

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

function entry(id: string): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl: `https://${id}.example/v1`, apiKey: "sk-test" };
}

/** Upstream that counts listModels() calls; answers, rejects, or hangs on demand. */
class ListingUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"];
  listModelsCalls = 0;

  constructor(
    config: UpstreamConfig,
    private readonly behavior: {
      models?: ModelEntry[];
      listError?: Error;
      hang?: boolean;
    } = {},
  ) {
    this.id = config.id;
    this.type = config.type;
  }

  async connect(): Promise<void> {}

  async listModels(): Promise<ModelEntry[]> {
    this.listModelsCalls += 1;
    if (this.behavior.hang === true) {
      return new Promise<ModelEntry[]>(() => {}); // never settles — exercises the probe budget
    }
    if (this.behavior.listError !== undefined) {
      throw this.behavior.listError;
    }
    return this.behavior.models ?? [];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(null, { status: 204 });
  }
}

interface ListingSpec {
  id: string;
  models?: ModelEntry[];
  listError?: Error;
  hang?: boolean;
}

async function registryWith(specs: ListingSpec[]): Promise<{ registry: UpstreamRegistry; upstreams: Map<string, ListingUpstream> }> {
  const entries = specs.map((spec) => entry(spec.id));
  const upstreams = new Map<string, ListingUpstream>(
    specs.map((spec, index) => [spec.id, new ListingUpstream(entries[index] as UpstreamConfig, spec)]),
  );
  const factories: UpstreamFactories = {
    "openai-compatible": (config) => {
      const made = upstreams.get(config.id);
      if (made === undefined) throw new Error(`unexpected upstream id "${config.id}"`);
      return made;
    },
  };
  const registry = await UpstreamRegistry.create(entries, factories, fakeLogger());
  return { registry, upstreams };
}

/** The handler mounted on a minimal app, driven through `app.request`. */
function appWith(
  registry: UpstreamRegistry,
  logger: pino.Logger = fakeLogger(),
  timeoutMs = UPSTREAM_MODELS_TIMEOUT_MS,
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.get("/api/upstreams/:id/models", handleUpstreamModels(registry, logger, timeoutMs));
  return app;
}

interface EnvelopeBody {
  error: { message: string; type: string; param?: string; code?: string };
}

interface ListingBody {
  upstream: string;
  models: ModelEntry[];
  fetchedAt: string;
}

describe("handleUpstreamModels (GET /api/upstreams/:id/models)", () => {
  test("success: 200 with the provider-native unprefixed catalog, the upstream id, and fetchedAt", async () => {
    const { registry } = await registryWith([
      {
        id: "alpha",
        models: [
          { id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" },
          { id: "qwen2.5:7b-instruct", object: "model", created: 1, owned_by: "vllm", served_name: "qwen" },
        ],
      },
    ]);
    const app = appWith(registry);
    const before = Date.now();

    const response = await app.request("/api/upstreams/alpha/models");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as ListingBody;
    expect(body.upstream).toBe("alpha");
    // provider-native ids, unprefixed — the {upstreamId}/ prefix is the LLM
    // surface aggregation's job, never this endpoint's
    expect(body.models).toEqual([
      { id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" },
      { id: "qwen2.5:7b-instruct", object: "model", created: 1, owned_by: "vllm", served_name: "qwen" },
    ]);
    // fetchedAt: a parseable ISO-8601 instant within the request window
    expect(body.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const fetchedAtMs = new Date(body.fetchedAt).getTime();
    expect(Number.isNaN(fetchedAtMs)).toBe(false);
    expect(fetchedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fetchedAtMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("no credential material in the success body — neither the upstream apiKey nor baseUrl", async () => {
    const { registry } = await registryWith([
      { id: "alpha", models: [{ id: "m", object: "model", created: 1, owned_by: "openai" }] },
    ]);
    const app = appWith(registry);

    const response = await app.request("/api/upstreams/alpha/models");
    const raw = await response.text();
    expect(raw).not.toContain("sk-test");
    expect(raw).not.toContain(".example/v1");
  });

  test("unknown id: 404 envelope before any upstream contact", async () => {
    const { registry, upstreams } = await registryWith([{ id: "alpha" }]);
    const app = appWith(registry);

    const response = await app.request("/api/upstreams/nope/models");
    expect(response.status).toBe(404);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBeUndefined(); // route-style 404, not model_not_found
    expect(body.error.message).toContain("nope");
    // the registry missed — listModels was never invoked
    expect(upstreams.get("alpha")?.listModelsCalls).toBe(0);
  });

  test("a failing listModels is the 502 api_error/upstream_error envelope, not a thrown 500", async () => {
    const { registry, upstreams } = await registryWith([
      { id: "dead", listError: new Error('upstream "dead" is unreachable: timeout') },
    ]);
    const app = appWith(registry);

    const response = await app.request("/api/upstreams/dead/models");
    expect(response.status).toBe(502);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("upstream_error");
    // log-safe failure fact in the message, upstream named, no credentials
    expect(body.error.message).toContain("dead");
    expect(body.error.message).toContain("unreachable");
    expect(upstreams.get("dead")?.listModelsCalls).toBe(1);
  });

  test("the probe budget bounds the answer: a hanging listModels is the 502 envelope, fast", async () => {
    const { registry } = await registryWith([{ id: "slow", hang: true }]);
    const app = appWith(registry, fakeLogger(), 20);
    const started = Date.now();

    const response = await app.request("/api/upstreams/slow/models");
    const elapsed = Date.now() - started;

    expect(response.status).toBe(502);
    expect(elapsed).toBeLessThan(2000); // the budget, not the forward budget (120s)
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("probe budget");
  });
});

describe("GET /api/upstreams/:id/models behind the ADR-007 gate", () => {
  /** The full app (createApp wiring) over a one-upstream registry. */
  async function fullApp(auth?: { enabled: boolean; user?: string; passwordHash?: string }) {
    const { registry, upstreams } = await registryWith([
      { id: "alpha", models: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" }] },
    ]);
    const entries = [entry("alpha")];
    const configuration = redactedConfigView({
      server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES },
      logLevel: "info",
      upstreams: entries,
    });
    return { app: createApp(registry, fakeLogger(), configuration, { auth }), upstreams };
  }

  test("auth enabled: no cookie gets the 401 authentication_required envelope — the handler never runs", async () => {
    const { app, upstreams } = await fullApp({ enabled: true, user: OPERATOR_USER, passwordHash: OPERATOR_HASH });

    const response = await app.request("/api/upstreams/alpha/models");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("authentication_required");
    expect(body.error.message).not.toContain(OPERATOR_PASSWORD);
    expect(body.error.message).not.toContain(OPERATOR_HASH);
    // the gate stopped the request at the auth stage — no upstream contact
    expect(upstreams.get("alpha")?.listModelsCalls).toBe(0);
  });

  test("auth enabled: login issues the session, the cookie admits the listing", async () => {
    const { app } = await fullApp({ enabled: true, user: OPERATOR_USER, passwordHash: OPERATOR_HASH });

    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: OPERATOR_USER, password: OPERATOR_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const token = (login.headers.get("set-cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";
    expect(token).not.toBe("");

    const admitted = await app.request("/api/upstreams/alpha/models", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(admitted.status).toBe(200);
    const body = (await admitted.json()) as ListingBody;
    expect(body.upstream).toBe("alpha");
    expect(body.models).toEqual([{ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" }]);
  });

  test("auth disabled: the same route answers ungated — 200", async () => {
    const { app } = await fullApp();

    const response = await app.request("/api/upstreams/alpha/models");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListingBody;
    expect(body.upstream).toBe("alpha");
  });
});
