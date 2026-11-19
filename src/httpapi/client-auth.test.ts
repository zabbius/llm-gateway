/**
 * The client-surface Bearer gate (specs/contracts/client-gateway.md,
 * ADR-008): /llm/v1/* requires a configured client's API key as
 * `Authorization: Bearer <apiKey>` when the `clients` block is configured —
 * missing/foreign/empty credentials answer the 401 authentication_required
 * envelope, unknown keys the 401 invalid_api_key envelope, both before body
 * reads and upstream contact; valid keys pass; /api/* keeps its own ADR-007
 * session gate and stays reachable without a client key; the client's
 * Authorization header still never reaches an upstream; the mounted gate is
 * the only behavior change — no clients block, no gate. Key material — the
 * configured client apiKeys and the presented value — never appears in a
 * response body or a log line.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type pino from "pino";
import type { GatewayEnv } from "../gateway/router.ts";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../upstreams/upstream.ts";
import { UpstreamRegistry } from "../upstreams/registry.ts";
import { createApp, type UiServingOptions } from "./app.ts";
import { redactedConfigView } from "../config/redact.ts";
import { DEFAULT_MAX_REQUEST_BODY_BYTES, type ClientConfig, type ModelConfig } from "../config/schema.ts";
import { bearerTokenOf, clientKeyMatches } from "./client-auth.ts";

/* ------------------------------------------------------------------ */
/* test infrastructure (app.test.ts pattern)                           */
/* ------------------------------------------------------------------ */

interface CapturedLine {
  level: string;
  bindings: Record<string, unknown>;
  obj: unknown;
  msg: string;
}

/** Minimal capturing stand-in for the root pino logger. */
function fakeLogger(): { logger: pino.Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const emit =
    (level: string, bound: Record<string, unknown>) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, bindings: bound, obj, msg: typeof obj === "string" ? obj : (msg ?? "") });
    };
  const build = (bound: Record<string, unknown>): pino.Logger =>
    ({
      trace: emit("trace", bound),
      debug: emit("debug", bound),
      info: emit("info", bound),
      warn: emit("warn", bound),
      error: emit("error", bound),
      fatal: emit("fatal", bound),
      child: (next: Record<string, unknown>) => build({ ...bound, ...next }),
    }) as unknown as pino.Logger;
  return { logger: build({}), lines };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function model(id: string): ModelEntry {
  return { id, object: "model", created: 1712267047, owned_by: "openai" };
}

class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"] = "openai-compatible";
  readonly received: ProxyRequest[] = [];

  constructor(
    config: UpstreamConfig,
    private readonly options: { models?: ModelEntry[] },
  ) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}

  async listModels(): Promise<ModelEntry[]> {
    return this.options.models ?? [];
  }

  async forward(request: ProxyRequest): Promise<Response> {
    this.received.push(request);
    return jsonResponse({ object: "chat.completion" });
  }
}

/** Two configured clients; their keys are the credentials under test. */
const CLIENTS: ClientConfig[] = [
  { name: "ci", apiKey: "sk-client-one", models: ["main"] },
  { name: "batch", apiKey: "sk-client-two", models: ["main"] },
];

/** The alias both clients may address: "main" → upstream alpha, model gpt-4o (ADR-009). */
const MODELS: ModelConfig[] = [
  { alias: "main", routes: [{ upstream: "alpha", model: "gpt-4o" }], balance: { strategy: "round-robin" } },
];

/** A real argon2id hash for the enabled auth block (auth.test.ts pattern). */
const OPERATOR_HASH = await Bun.password.hash("operator-password-31337", { algorithm: "argon2id" });

/** Build the app wired to one fake upstream, with or without a clients block. */
async function gateway(
  clients: ClientConfig[] | undefined,
  logger: pino.Logger,
  options: Omit<UiServingOptions, "clients"> = {},
): Promise<{ app: Hono<GatewayEnv>; upstream: FakeUpstream }> {
  const entries: UpstreamConfig[] = [
    { type: "openai-compatible", id: "alpha", baseUrl: "https://alpha.example/v1", apiKey: "sk-upstream" },
  ];
  const upstream = new FakeUpstream(entries[0] as UpstreamConfig, { models: [model("gpt-4o")] });
  const registry = await UpstreamRegistry.create(entries, { "openai-compatible": () => upstream }, logger);
  // The entry point builds the redacted view from the same entries and hands
  // it to createApp — the raw config never crosses into the HTTP layer.
  const configuration = redactedConfigView({
    server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES },
    logLevel: "info",
    ...(clients !== undefined ? { clients } : {}),
    upstreams: entries,
  });
  return { app: createApp(registry, logger, configuration, { clients, ...options, models: options.models ?? MODELS }), upstream };
}

function completionRequest(modelId: string, authorization?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({ model: modelId, stream: false }),
  };
}

async function envelopeOf(response: Response): Promise<{
  status: number;
  contentType: string;
  wwwAuthenticate: string | null;
  body: { error: { message: string; type: string; code?: string } };
}> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    wwwAuthenticate: response.headers.get("www-authenticate"),
    body: (await response.json()) as { error: { message: string; type: string; code?: string } },
  };
}

/** No captured log line may carry any credential material under test. */
function noLineContains(lines: CapturedLine[], secrets: string[]): void {
  for (const line of lines) {
    const serialized = JSON.stringify(line);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  }
}

/* ------------------------------------------------------------------ */
/* credential helpers                                                  */
/* ------------------------------------------------------------------ */

describe("clientKeyMatches / bearerTokenOf", () => {
  test("equal keys match; different keys and lengths do not, without throwing", () => {
    expect(clientKeyMatches("sk-client-one", "sk-client-one")).toBe(true);
    expect(clientKeyMatches("sk-client-one", "sk-client-two")).toBe(false);
    expect(clientKeyMatches("short", "a-much-longer-configured-key")).toBe(false);
    expect(clientKeyMatches("", "sk-client-one")).toBe(false);
  });

  test("bearerTokenOf — Bearer scheme required, case-insensitive, token trimmed; else null", () => {
    expect(bearerTokenOf(undefined)).toBeNull();
    expect(bearerTokenOf("Basic sk-client-one")).toBeNull();
    expect(bearerTokenOf("Bearer")).toBeNull();
    expect(bearerTokenOf("Bearer ")).toBeNull();
    expect(bearerTokenOf("Bearer   ")).toBeNull();
    expect(bearerTokenOf("Bearer sk-client-one")).toBe("sk-client-one");
    expect(bearerTokenOf("bearer sk-client-one")).toBe("sk-client-one");
    expect(bearerTokenOf("  Bearer   sk-client-one  ")).toBe("sk-client-one");
  });
});

/* ------------------------------------------------------------------ */
/* the gate: 401s before body read / upstream contact                  */
/* ------------------------------------------------------------------ */

describe("the /llm/v1/* client Bearer gate (clients configured)", () => {
  test("no Authorization header — 401 authentication_required envelope, no WWW-Authenticate", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    const response = await app.request("/llm/v1/models");
    const envelope = await envelopeOf(response);
    expect(envelope.status).toBe(401);
    expect(envelope.contentType).toContain("application/json");
    expect(envelope.wwwAuthenticate).toBeNull();
    expect(envelope.body.error.type).toBe("authentication_error");
    expect(envelope.body.error.code).toBe("authentication_required");
    expect(envelope.body.error.message).toContain("Authorization");
    expect(envelope.body.error.message).not.toContain("sk-client-one");
    noLineContains(lines, ["sk-client-one", "sk-client-two"]);
  });

  test("foreign scheme, empty credential — the same 401 authentication_required", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Token sk-client-one"]) {
      const response = await app.request("/llm/v1/models", { headers: { authorization } });
      const envelope = await envelopeOf(response);
      expect(envelope.status).toBe(401);
      expect(envelope.body.error.code).toBe("authentication_required");
    }
  });

  test("unknown Bearer key — 401 invalid_api_key; the answer echoes no key material", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    const response = await app.request("/llm/v1/models", {
      headers: { authorization: "Bearer sk-wrong-value" },
    });
    const envelope = await envelopeOf(response);
    expect(envelope.status).toBe(401);
    expect(envelope.body.error.type).toBe("authentication_error");
    expect(envelope.body.error.code).toBe("invalid_api_key");
    expect(envelope.body.error.message).not.toContain("sk-wrong-value");
    expect(envelope.body.error.message).not.toContain("sk-client-one");
    expect(envelope.body.error.message).not.toContain("sk-client-two");
    // The presented value appears in no captured log line either.
    noLineContains(lines, ["sk-wrong-value", "sk-client-one", "sk-client-two"]);
  });

  test("the gate answers before the body is read or parsed — no key, broken JSON body still 401", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    const response = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const envelope = await envelopeOf(response);
    expect(envelope.status).toBe(401);
    expect(envelope.body.error.code).toBe("authentication_required");
  });

  test("a valid client key passes on every /llm/v1 route; both configured keys work", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    const models = await app.request("/llm/v1/models", {
      headers: { authorization: "Bearer sk-client-one" },
    });
    expect(models.status).toBe(200);
    const list = (await models.json()) as { object: string; data: ModelEntry[] };
    expect(list.object).toBe("list");
    expect(list.data.map((entry) => entry.id)).toEqual(["main"]);

    const completions = await app.request("/llm/v1/chat/completions", completionRequest("main", "Bearer sk-client-two"));
    expect(completions.status).toBe(200);

    // Scheme matching is case-insensitive per RFC 9110.
    const lowerScheme = await app.request("/llm/v1/models", {
      headers: { authorization: "bearer sk-client-one" },
    });
    expect(lowerScheme.status).toBe(200);
  });

  test("a valid key on /llm/v1/models does not open /api/* — the surfaces keep separate gates", async () => {
    const { logger } = fakeLogger();
    // Both gates mounted: the management session gate (ADR-007) and the
    // client Bearer gate (ADR-008).
    const { app } = await gateway(CLIENTS, logger, {
      auth: { enabled: true, user: "admin", passwordHash: OPERATOR_HASH },
    });

    // No session exists: the management gate answers before any client key
    // could matter — a client credential is not an operator session.
    const status = await app.request("/api/status", {
      headers: { authorization: "Bearer sk-client-one" },
    });
    expect(status.status).toBe(401);
    const body = (await status.json()) as { error: { code: string } };
    expect(body.error.code).toBe("authentication_required");
  });
});

/* ------------------------------------------------------------------ */
/* the rest of the gateway is untouched                                */
/* ------------------------------------------------------------------ */

describe("the client gate leaves the rest of the gateway intact", () => {
  test("/api/* stays reachable without any client credential — the gate covers the LLM surface only", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    const status = await app.request("/api/status");
    expect(status.status).toBe(200);
    const body = (await status.json()) as { status: string; authenticated: boolean };
    expect(body).toEqual({ status: "ok", authenticated: false });
  });

  test("the presented Authorization still never reaches the upstream", async () => {
    const { logger } = fakeLogger();
    const { app, upstream } = await gateway(CLIENTS, logger);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("main", "Bearer sk-client-one"));
    expect(response.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    const forwarded = upstream.received[0] as ProxyRequest;
    expect(forwarded.path).toBe("chat/completions");
    expect(Object.keys(forwarded.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  test("without a clients block no gate mounts — /llm/v1 answers without any credential", async () => {
    const { logger } = fakeLogger();
    const { app, upstream } = await gateway(undefined, logger);

    const models = await app.request("/llm/v1/models");
    expect(models.status).toBe(200);

    const completions = await app.request("/llm/v1/chat/completions", completionRequest("main"));
    expect(completions.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
  });

  test("401 answers are logged like every request — and no log line carries key material", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway(CLIENTS, logger);

    await app.request("/llm/v1/models");
    await app.request("/llm/v1/models", { headers: { authorization: "Bearer sk-wrong-value" } });

    const rejected = lines.filter(
      (line) =>
        line.level === "debug" &&
        line.msg === "request handled" &&
        (line.obj as { path?: string; status?: number }).path === "/llm/v1/models" &&
        (line.obj as { status?: number }).status === 401,
    );
    expect(rejected.length).toBe(2);
    noLineContains(lines, ["sk-client-one", "sk-client-two", "sk-wrong-value"]);
  });
});
