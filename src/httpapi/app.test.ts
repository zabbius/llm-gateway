/**
 * The HTTP surface end to end, driven through `app.request`
 * (specs/contracts/client-gateway.md): the alias catalog on GET
 * /llm/v1/models, alias dispatch against mock upstreams (body.model rewritten
 * to the selected route's model), the 400/403/404/413/502/504 error table,
 * unchanged relay (incl. unbuffered SSE), auth stage preceding routing, ≥1
 * log line per request, the GET /api/status health probe
 * (specs/contracts/gateway-management.md), and the /ui
 * namespace serving — root 302 redirect, static assets, SPA fallback,
 * envelope-404 fallthrough (ADR-005, specs/domains/frontend.md).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../upstreams/registry.ts";
import { OpenAICompatibleUpstream } from "../upstreams/openai-compatible.ts";
import { createApp, type UiServingOptions } from "./app.ts";
import { writeOpenApiArtifact } from "./generate-openapi.ts";
import { redactedConfigView } from "../config/redact.ts";
import { MetadataStore } from "../gateway/metastore.ts";
import { DEFAULT_MAX_REQUEST_BODY_BYTES, type ClientConfig, type ModelConfig } from "../config/schema.ts";
import { PROCESS_STARTED_AT } from "./handlers/models.ts";

/* ------------------------------------------------------------------ */
/* test infrastructure                                                 */
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

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function model(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return { id, object: "model", created: 1712267047, owned_by: "openai", ...overrides };
}

type Responder = (request: ProxyRequest) => Response | Promise<Response>;

class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"] = "openai-compatible";
  readonly received: ProxyRequest[] = [];

  constructor(
    config: UpstreamConfig,
    private readonly options: {
      models?: ModelEntry[];
      modelsError?: Error;
      respond?: Responder;
      connectError?: Error;
    },
  ) {
    this.id = config.id;
  }

  async connect(): Promise<void> {
    if (this.options.connectError !== undefined) {
      throw this.options.connectError;
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    if (this.options.modelsError !== undefined) {
      throw this.options.modelsError;
    }
    return this.options.models ?? [];
  }

  async forward(request: ProxyRequest): Promise<Response> {
    this.received.push(request);
    return this.options.respond?.(request) ?? jsonResponse({ object: "chat.completion" });
  }
}

interface UpstreamSpec {
  id: string;
  models?: ModelEntry[];
  modelsError?: Error;
  respond?: Responder;
  connectError?: Error;
  /** Credential material the redacted configuration view must mask away. */
  apiKey?: string;
  tlsFingerprint?: string;
}

/** One alias → single route model entry for the routing table (ADR-009). */
function aliasTo(
  alias: string,
  upstream: string,
  model: string,
  overrides: Partial<ModelConfig> = {},
): ModelConfig {
  return {
    alias,
    routes: [{ upstream, model }],
    balance: { strategy: "round-robin" },
    ...overrides,
  };
}

/** Build a registry of fake upstreams plus the app wired to it. */
async function gateway(
  specs: UpstreamSpec[],
  logger: pino.Logger,
  ui: UiServingOptions = {},
  models: ModelConfig[] = [],
) {
  const entries: UpstreamConfig[] = specs.map((spec) => ({
    type: "openai-compatible",
    id: spec.id,
    baseUrl: `https://${spec.id}.example/v1`,
    apiKey: spec.apiKey ?? "sk-test",
    ...(spec.tlsFingerprint !== undefined ? { tlsFingerprint: spec.tlsFingerprint } : {}),
  }));
  const upstreams = new Map<string, FakeUpstream>(
    specs.map((spec, index) => [spec.id, new FakeUpstream(entries[index] as UpstreamConfig, spec)]),
  );
  const factories: UpstreamFactories = {
    "openai-compatible": (entry) => {
      const made = upstreams.get(entry.id);
      if (made === undefined) throw new Error(`unexpected upstream id "${entry.id}"`);
      return made;
    },
  };
  const registry = await UpstreamRegistry.create(entries, factories, logger);
  // The entry point builds the redacted view from the same entries and hands
  // it to createApp — the raw config never crosses into the HTTP layer.
  const configuration = redactedConfigView({
    server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES },
    logLevel: "info",
    ...(ui.clients !== undefined ? { clients: ui.clients } : {}),
    ...(models.length > 0 ? { models } : {}),
    upstreams: entries,
  });
  return { app: createApp(registry, logger, configuration, { ...ui, models }), upstreams };
}

function completionRequest(
  modelId: string,
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(authorization === undefined ? {} : { authorization }),
      "x-custom": "keep-me",
      ...extraHeaders,
    },
    body: JSON.stringify({ model: modelId, temperature: 0.5, stream: false }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `GET /llm/v1/models` (ADR-009) — the gateway's alias catalog: no upstream
 * is contacted, entries carry the alias id, the process start epoch, and
 * owned_by "llm-gateway"; with a clients block the list is scoped to the
 * authenticated client's aliases.
 */

describe("GET /llm/v1/models", () => {
  test("the alias catalog: config order, OpenAI shape, owned_by llm-gateway, created = process start", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(
      [
        { id: "alpha", models: [model("gpt-4o")] },
        { id: "bravo", models: [model("davinci")] },
      ],
      logger,
      {},
      [
        aliasTo("fast", "alpha", "gpt-4o"),
        aliasTo("embed", "alpha", "text-embed"),
        aliasTo("legacy", "bravo", "davinci"),
      ],
    );

    const response = await app.request("/llm/v1/models");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const list = (await response.json()) as {
      object: string;
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    expect(list.object).toBe("list");
    expect(list.data).toEqual([
      { id: "fast", object: "model", created: PROCESS_STARTED_AT, owned_by: "llm-gateway" },
      { id: "embed", object: "model", created: PROCESS_STARTED_AT, owned_by: "llm-gateway" },
      { id: "legacy", object: "model", created: PROCESS_STARTED_AT, owned_by: "llm-gateway" },
    ]);
  });

  test("no upstream contact: an unreachable upstream's alias is still listed, and no warnings are logged", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway(
      [{ id: "broken", modelsError: new Error("upstream down") }],
      logger,
      {},
      [aliasTo("fast", "broken", "gpt-4o")],
    );

    const response = await app.request("/llm/v1/models");
    expect(response.status).toBe(200);
    const list = (await response.json()) as { object: string; data: Array<{ id: string }> };
    expect(list.data.map((entry) => entry.id)).toEqual(["fast"]);
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(0);
  });

  test("client-scoped: a configured clients block lists only the authenticated client's aliases", async () => {
    const { logger } = fakeLogger();
    const clients: ClientConfig[] = [
      { name: "ci", apiKey: "sk-client-one", models: ["fast"] },
      { name: "batch", apiKey: "sk-client-two", models: ["legacy", "embed"] },
    ];
    const { app } = await gateway(
      [
        { id: "alpha", models: [model("gpt-4o")] },
        { id: "bravo", models: [model("davinci")] },
      ],
      logger,
      { clients },
      [
        aliasTo("fast", "alpha", "gpt-4o"),
        aliasTo("embed", "alpha", "text-embed"),
        aliasTo("legacy", "bravo", "davinci"),
      ],
    );

    const first = await app.request("/llm/v1/models", { headers: { authorization: "Bearer sk-client-one" } });
    expect(first.status).toBe(200);
    const firstList = (await first.json()) as { data: Array<{ id: string }> };
    expect(firstList.data.map((entry) => entry.id)).toEqual(["fast"]);

    const second = await app.request("/llm/v1/models", { headers: { authorization: "Bearer sk-client-two" } });
    expect(second.status).toBe(200);
    const secondList = (await second.json()) as { data: Array<{ id: string }> };
    // config order of the models table, filtered to the client's aliases
    expect(secondList.data.map((entry) => entry.id)).toEqual(["embed", "legacy"]);
  });

  test("a wired metadataStore projects the aggregated metadata onto the catalog entries", async () => {
    const { logger } = fakeLogger();
    const store = new MetadataStore();
    store.set("alpha", [
      {
        id: "gpt-4o",
        object: "model",
        created: 1,
        owned_by: "openai",
        limit: { context: 128000, output: 16384 },
        capabilities: { tools: { supported: true }, reasoning: { supported: true }, temperature: false },
        modalities: { input: ["text", "image/png"] },
      },
    ]);
    const { app } = await gateway([{ id: "alpha", models: [model("gpt-4o")] }], logger, { metadataStore: store }, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    // the catalog entry carries the wire projection
    const response = await app.request("/llm/v1/models");
    expect(response.status).toBe(200);
    const list = (await response.json()) as {
      data: Array<{
        id: string;
        limit?: { context: number; output: number };
        capabilities?: { tools: { supported: boolean }; reasoning: { supported: boolean }; temperature: boolean };
        modalities?: { input: string[] };
      }>;
    };
    expect(list.data[0]?.id).toBe("fast");
    expect(list.data[0]?.limit).toEqual({ context: 128000, output: 16384 });
    expect(list.data[0]?.capabilities).toEqual({
      tools: { supported: true },
      reasoning: { supported: true },
      temperature: false,
    });
    expect(list.data[0]?.modalities).toEqual({ input: ["text", "image/png"] });
  });
});

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

describe("POST /llm/v1/chat/completions and /llm/v1/completions", () => {
  test("rewrites body.model to the selected route's model (the only transformation), relays headers minus credentials, response unchanged", async () => {
    const { logger } = fakeLogger();
    const upstreamBody = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ message: { content: "hello" } }],
    });
    const respond: Responder = () =>
      new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": "application/json", "x-upstream-marker": "yes" },
      });
    const { app, upstreams } = await gateway([{ id: "alpha", respond }], logger, {}, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("fast"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-marker")).toBe("yes");
    expect(await response.text()).toBe(upstreamBody);

    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    const received = upstreams.get("alpha")?.received[0];
    if (received === undefined) throw new Error("upstream was not called");
    expect(received.path).toBe("chat/completions");
    expect(received.method).toBe("POST");
    const forwarded = await new Response(received.body).json();
    expect(forwarded).toEqual({ model: "gpt-4o", temperature: 0.5, stream: false });
    expect(received.headers["content-type"]).toBe("application/json");
    expect(received.headers["x-custom"]).toBe("keep-me");
    expect(received.headers["authorization"]).toBeUndefined();
  });

  test("legacy /llm/v1/completions forwards the completions upstream path", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger, {}, [
      aliasTo("davinci-legacy", "alpha", "davinci"),
    ]);

    const response = await app.request("/llm/v1/completions", completionRequest("davinci-legacy"));
    expect(response.status).toBe(200);
    const received = upstreams.get("alpha")?.received[0];
    if (received === undefined) throw new Error("upstream was not called");
    expect(received.path).toBe("completions");
    const forwarded = (await new Response(received.body).json()) as { model: string };
    expect(forwarded.model).toBe("davinci");
  });

  test("the route's model name is forwarded verbatim — whether the upstream knows it is the upstream's verdict", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "no such model" } }, 404);
    const { app, upstreams } = await gateway([{ id: "alpha", respond }], logger, {}, [
      aliasTo("fast", "alpha", "does-not-exist"),
    ]);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("fast"));
    expect(response.status).toBe(404); // relayed from the upstream, NOT model_not_found from the gateway
    const body = (await response.json()) as { error: { code?: string } };
    expect(body.error.code).toBeUndefined(); // upstream's own envelope, byte-for-byte semantics
    const received = upstreams.get("alpha")?.received[0];
    if (received === undefined) throw new Error("upstream was not called");
    const forwarded = (await new Response(received.body).json()) as { model: string };
    expect(forwarded.model).toBe("does-not-exist");
  });

  test("SSE streams pass through unbuffered: chunks arrive progressively, never end-loaded", async () => {
    const { logger } = fakeLogger();
    const encoder = new TextEncoder();
    const respond: Responder = () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          await sleep(60);
          controller.enqueue(encoder.encode("data: second\n\n"));
          await sleep(60);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const { app } = await gateway([{ id: "alpha", respond }], logger, {}, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("fast"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no response body");
    const decoder = new TextDecoder();
    const arrivals: Array<{ at: number; text: string }> = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      arrivals.push({ at: performance.now(), text: decoder.decode(next.value) });
    }
    expect(arrivals.map((arrival) => arrival.text).join("")).toContain("data: [DONE]");
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    // the second chunk must not have been buffered until the stream ended
    const second = arrivals[1];
    const first = arrivals[0];
    if (second === undefined || first === undefined) throw new Error("missing chunks");
    expect(second.at - first.at).toBeGreaterThanOrEqual(40);
  });
});

/* ------------------------------------------------------------------ */
/* gateway-side failures — no upstream contact                         */
/* ------------------------------------------------------------------ */

describe("gateway-generated errors", () => {
  test("404 model_not_found for an unconfigured alias — upstream never called", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger, {}, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    for (const bad of ["nope", "fast/suffixed", "FAST"]) {
      const response = await app.request("/llm/v1/chat/completions", completionRequest(bad));
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: Record<string, string> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("model");
      expect(body.error.code).toBe("model_not_found");
      expect(body.error.message).toContain(bad);
    }
    expect(upstreams.get("alpha")?.received).toHaveLength(0);
  });

  test("403 for a configured alias the authenticated client is not allowed to address — upstream never called", async () => {
    const { logger } = fakeLogger();
    const clients: ClientConfig[] = [
      { name: "ci", apiKey: "sk-client-one", models: ["fast"] },
    ];
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger, { clients }, [
      aliasTo("fast", "alpha", "gpt-4o"),
      aliasTo("secret", "alpha", "gpt-4o-secret"),
    ]);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("secret", "Bearer sk-client-one"));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: Record<string, string> };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("model");
    expect(body.error.message).toContain("secret");
    expect(upstreams.get("alpha")?.received).toHaveLength(0);

    // the same client reaches its own alias fine
    const allowed = await app.request("/llm/v1/chat/completions", completionRequest("fast", "Bearer sk-client-one"));
    expect(allowed.status).toBe(200);
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
  });

  test("403 distinguishes from 404: an unconfigured alias stays 404 even for an authenticated client", async () => {
    const { logger } = fakeLogger();
    const clients: ClientConfig[] = [
      { name: "ci", apiKey: "sk-client-one", models: ["fast"] },
    ];
    const { app } = await gateway([{ id: "alpha" }], logger, { clients }, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("nope", "Bearer sk-client-one"));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("model_not_found");
  });

  test("400 invalid_request_error (no code) for malformed JSON, non-object body, missing or non-string model", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger);

    const post = (raw: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    for (const raw of ["{not json", "[]", JSON.stringify({ temperature: 1 }), JSON.stringify({ model: 7 })]) {
      const response = await app.request("/llm/v1/chat/completions", post(raw));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBeUndefined();
      expect(typeof body.error.message).toBe("string");
    }
    expect(upstreams.get("alpha")?.received).toHaveLength(0);
  });

  test("413 request_too_large when the body exceeds the gateway cap — no upstream contact", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger);

    const response = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1) },
      body: JSON.stringify({ model: "fast" }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("request_too_large");
    expect(upstreams.get("alpha")?.received).toHaveLength(0);
  });

  test("413 honors the configured server.maxRequestBodyBytes, not just the default", async () => {
    const { logger } = fakeLogger();
    const entries: UpstreamConfig[] = [
      { type: "openai-compatible", id: "capped", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test" },
    ];
    const registry = await UpstreamRegistry.create(
      entries,
      { "openai-compatible": (entry, child) => new OpenAICompatibleUpstream(entry, child) },
      logger,
    );
    const app = createApp(
      registry,
      logger,
      redactedConfigView({
        server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: 32 },
        logLevel: "info",
        upstreams: entries,
      }),
      { models: [aliasTo("fast", "capped", "gpt-4o")] },
    );

    // 40 declared bytes — over the configured 32-byte cap, far under the default
    const response = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "40" },
      body: JSON.stringify({ model: "fast" }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("request_too_large");
  });

  test("502 upstream_error envelope relayed from a real upstream when the upstream answers non-JSON", async () => {
    const { logger } = fakeLogger();
    const upstream = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") return jsonResponse({ data: [] });
        return new Response("<html>gateway exploded</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        });
      },
    });
    try {
      const entries: UpstreamConfig[] = [
        {
          type: "openai-compatible",
          id: "real",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "sk-test",
        },
      ];
      const registry = await UpstreamRegistry.create(
        entries,
        { "openai-compatible": (entry, child) => new OpenAICompatibleUpstream(entry, child) },
        logger,
      );
      const app = createApp(registry, logger, redactedConfigView({ server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES }, logLevel: "info", models: [aliasTo("fast", "real", "gpt-4o")], upstreams: entries }), {
        models: [aliasTo("fast", "real", "gpt-4o")],
      });

      const response = await app.request("/llm/v1/chat/completions", completionRequest("fast"));
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body.error.type).toBe("api_error");
      expect(body.error.code).toBe("upstream_error");
    } finally {
      upstream.stop(true);
    }
  });

  test("504 upstream_timeout envelope relayed from a real upstream when the upstream is unreachable", async () => {
    const { logger } = fakeLogger();
    // port 1: nothing listens there — connect() degrades with a warning, per-request forward synthesizes 504
    const entries: UpstreamConfig[] = [
      { type: "openai-compatible", id: "dead", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test" },
    ];
    const registry = await UpstreamRegistry.create(
      entries,
      { "openai-compatible": (entry, child) => new OpenAICompatibleUpstream(entry, child) },
      logger,
    );
    const app = createApp(registry, logger, redactedConfigView({ server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES }, logLevel: "info", models: [aliasTo("dead-alias", "dead", "gpt-4o")], upstreams: entries }), {
      models: [aliasTo("dead-alias", "dead", "gpt-4o")],
    });

    const response = await app.request("/llm/v1/chat/completions", completionRequest("dead-alias"));
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("upstream_timeout");
    expect(body.error.message).toContain("unreachable");
  });

  test("an upstream contract violation (forward rejecting) becomes a mapped 502 envelope, logged at error level", async () => {
    const { logger, lines } = fakeLogger();
    const respond: Responder = () => {
      throw new Error("upstream contract violated");
    };
    const { app } = await gateway([{ id: "alpha", respond }], logger, {}, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    const response = await app.request("/llm/v1/chat/completions", completionRequest("fast"));
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("upstream_error");
    // the internal reason is logged, never leaked into the envelope
    expect(JSON.stringify(body)).not.toContain("contract violated");
    const errors = lines.filter((line) => line.level === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(errors[0]?.obj)).toContain("upstream contract violated");
  });
});

/* ------------------------------------------------------------------ */
/* load balancing (specs/domains/load-balancing.md)                    */
/* ------------------------------------------------------------------ */

describe("load balancing", () => {
  function multiAlias(routes: Array<{ upstream: string; model: string }>): ModelConfig {
    return { alias: "dual", routes, balance: { strategy: "round-robin" } };
  }

  test("a pre-first-byte failure fails over to the next route — the client sees the healthy route's answer", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "alpha is down" } }, 500);
    const { app, upstreams } = await gateway(
      [
        { id: "alpha", respond },
        { id: "bravo" },
      ],
      logger,
      {},
      [multiAlias([{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
    );

    const response = await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string };
    expect(body.object).toBe("chat.completion");
    // both routes were attempted, alpha first (config order)
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    const bravoReceived = upstreams.get("bravo")?.received[0];
    if (bravoReceived === undefined) throw new Error("failover route was not called");
    const forwarded = await new Response(bravoReceived.body).json();
    expect(forwarded).toEqual({ model: "m-bravo", temperature: 0.5, stream: false });
  });

  test("a relayed 429 fails over; a client-caused 4xx relays without failover", async () => {
    const { logger } = fakeLogger();
    const rated: Responder = () => jsonResponse({ error: { message: "rate limited" } }, 429);
    const { app, upstreams } = await gateway(
      [
        { id: "alpha", respond: rated },
        { id: "bravo" },
        { id: "charlie", respond: () => jsonResponse({ error: { message: "bad key" } }, 401) },
        { id: "delta" },
      ],
      logger,
      {},
      [
        multiAlias([{ upstream: "alpha", model: "m" }, { upstream: "bravo", model: "m" }]),
        { alias: "badreq", routes: [{ upstream: "charlie", model: "m" }, { upstream: "delta", model: "m" }], balance: { strategy: "round-robin" } },
      ],
    );

    const limited = await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    expect(limited.status).toBe(200); // the 429 failed over to bravo
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    expect(upstreams.get("bravo")?.received).toHaveLength(1);

    const bad = await app.request("/llm/v1/chat/completions", completionRequest("badreq"));
    expect(bad.status).toBe(401); // relayed unchanged — the upstream's verdict
    expect(upstreams.get("charlie")?.received).toHaveLength(1);
    expect(upstreams.get("delta")?.received).toHaveLength(0); // no failover on a client-caused 4xx
  });

  test("after the failure threshold the route is skipped without contact until it recovers", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "alpha is down" } }, 500);
    const { app, upstreams } = await gateway(
      [
        { id: "alpha", respond },
        { id: "bravo" },
      ],
      logger,
      {},
      [multiAlias([{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
    );

    // Three consecutive requests each fail on alpha first (failover to bravo
    // answers 200) — the third failure crosses the default threshold (3).
    for (let i = 0; i < 3; i++) {
      const response = await app.request("/llm/v1/chat/completions", completionRequest("dual"));
      expect(response.status).toBe(200);
    }
    expect(upstreams.get("alpha")?.received).toHaveLength(3);
    expect(upstreams.get("bravo")?.received).toHaveLength(3);

    // From here selection skips alpha outright: bravo serves without alpha
    // being contacted again.
    const fourth = await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    expect(fourth.status).toBe(200);
    expect(upstreams.get("alpha")?.received).toHaveLength(3);
    expect(upstreams.get("bravo")?.received).toHaveLength(4);
  });

  test("503 upstream_unavailable when every route of the alias is open — no upstream contact", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "solo is down" } }, 500);
    const { app, upstreams } = await gateway(
      [{ id: "solo", respond }],
      logger,
      {},
      [{ alias: "solo-alias", routes: [{ upstream: "solo", model: "m" }], balance: { strategy: "round-robin" } }],
    );

    // The first requests relay the upstream's failure (single route: failover
    // exhausts immediately); the third opens the route.
    for (let i = 1; i <= 3; i++) {
      const response = await app.request("/llm/v1/chat/completions", completionRequest("solo-alias"));
      expect(response.status).toBe(500);
      expect(upstreams.get("solo")?.received).toHaveLength(i);
    }

    const refused = await app.request("/llm/v1/chat/completions", completionRequest("solo-alias"));
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body.error.message).toContain("solo-alias");
    expect(upstreams.get("solo")?.received).toHaveLength(3); // refused without contact
  });

  test("no failover once streaming started — a truncated stream relays as received", async () => {
    const { logger } = fakeLogger();
    const encoder = new TextEncoder();
    const streamer: Responder = () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          controller.close(); // stream starts, then dies without [DONE]
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { app, upstreams } = await gateway(
      [
        { id: "alpha", respond: streamer },
        { id: "bravo" },
      ],
      logger,
      {},
      [multiAlias([{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
    );

    const response = await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("data: first");
    expect(text).not.toContain("[DONE]");
    // the 200 counted as a healthy attempt: the failover sibling was never contacted
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    expect(upstreams.get("bravo")?.received).toHaveLength(0);
  });

  test("exhausted failover relays the last upstream failure unchanged", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "no capacity" } }, 503);
    const { app, upstreams } = await gateway(
      [
        { id: "alpha", respond },
        { id: "bravo", respond },
      ],
      logger,
      {},
      [multiAlias([{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
    );

    const response = await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    expect(response.status).toBe(503); // the upstream's own 503, relayed byte-for-byte
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.message).toBe("no capacity"); // NOT the gateway envelope
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    expect(upstreams.get("bravo")?.received).toHaveLength(1);
  });
});

describe("session affinity (ADR-010)", () => {
  function dualAlias(): ModelConfig {
    return {
      alias: "dual",
      routes: [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }],
      balance: { strategy: "round-robin" },
    };
  }

  test("the same X-Session-Id lands on one healthy route across requests; other sessions follow the rotation", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }, { id: "bravo" }], logger, {}, [dualAlias()]);

    for (let i = 0; i < 3; i++) {
      const response = await app.request(
        "/llm/v1/chat/completions",
        completionRequest("dual", undefined, { "x-session-id": "sess-1" }),
      );
      expect(response.status).toBe(200);
    }
    expect(upstreams.get("alpha")?.received).toHaveLength(3); // stuck to the first route it was served by
    expect(upstreams.get("bravo")?.received).toHaveLength(0);

    const other = await app.request(
      "/llm/v1/chat/completions",
      completionRequest("dual", undefined, { "x-session-id": "sess-2" }),
    );
    expect(other.status).toBe(200);
    expect(upstreams.get("bravo")?.received).toHaveLength(1); // an unbound session follows the schedule
    expect(upstreams.get("alpha")?.received).toHaveLength(3);

    await app.request("/llm/v1/chat/completions", completionRequest("dual", undefined, { "x-session-id": "sess-1" }));
    expect(upstreams.get("alpha")?.received).toHaveLength(4); // sess-1 still stuck
    expect(upstreams.get("bravo")?.received).toHaveLength(1);
  });

  test("the user field binds when no header is present; the header wins when both are given", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }, { id: "bravo" }], logger, {}, [dualAlias()]);
    const post = (body: object, headers: Record<string, string> = {}) =>
      app.request("/llm/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify(body),
      });

    await post({ model: "dual", user: "u-9" }); // unbound: rotation picks alpha, binds (dual, "u-9")
    await post({ model: "dual", user: "u-9" }); // affinity: alpha again
    await post({ model: "dual", user: "u-9" }, { "x-session-id": "sess-H" }); // header wins: unbound → rotation → bravo
    await post({ model: "dual" }, { "x-session-id": "sess-H" }); // header-only session: stuck to bravo
    await post({ model: "dual", user: "u-9" }); // the user binding survived: alpha

    expect(upstreams.get("alpha")?.received).toHaveLength(3);
    expect(upstreams.get("bravo")?.received).toHaveLength(2);
  });

  test("a pre-first-byte failure releases the binding — the session migrates with failover", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "alpha is down" } }, 500);
    const { app, upstreams } = await gateway(
      [{ id: "alpha", respond }, { id: "bravo" }],
      logger,
      {},
      [dualAlias()],
    );

    const first = await app.request(
      "/llm/v1/chat/completions",
      completionRequest("dual", undefined, { "x-session-id": "sess-1" }),
    );
    expect(first.status).toBe(200); // alpha failed 500 pre-first-byte → failover served by bravo
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    expect(upstreams.get("bravo")?.received).toHaveLength(1);

    const second = await app.request(
      "/llm/v1/chat/completions",
      completionRequest("dual", undefined, { "x-session-id": "sess-1" }),
    );
    expect(second.status).toBe(200);
    expect(upstreams.get("alpha")?.received).toHaveLength(1); // the session moved: alpha is not retried first
    expect(upstreams.get("bravo")?.received).toHaveLength(2);
  });

  test("no key — the pure balancer choice, one request per route", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }, { id: "bravo" }], logger, {}, [dualAlias()]);

    await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    await app.request("/llm/v1/chat/completions", completionRequest("dual"));
    expect(upstreams.get("alpha")?.received).toHaveLength(1);
    expect(upstreams.get("bravo")?.received).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* management surface                                                  */
/* ------------------------------------------------------------------ */

describe("GET /api/status", () => {
  test("the health probe: the fixed ok literal, anonymous without the session gate", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger);

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { status: string; authenticated: boolean };
    // exact contract shape (specs/contracts/gateway-management.md): the
    // probe carries the fixed literal plus the session bit — no inventory
    expect(body).toEqual({ status: "ok", authenticated: false });
    // probe outcomes and the route inventory are startup log lines, never
    // body material: the retired sections stay absent
    expect(JSON.stringify(body)).not.toContain("upstreams");
    expect(JSON.stringify(body)).not.toContain("routes");
    expect(JSON.stringify(body)).not.toContain("meta");
  });

  test("always 200 even when a probe failed — the failure is a log line, the HTTP answer is unaffected", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(
      [
        { id: "alpha", models: [model("gpt-4o")] },
        { id: "dead", connectError: new Error("connection refused") },
      ],
      logger,
    );

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string; authenticated: boolean }).toEqual({
      status: "ok",
      authenticated: false,
    });
  });

  test("behind the session gate a valid session reads authenticated: true", async () => {
    // app.ts mounts the probe with the auth-enabled flag: the gate admits
    // only valid sessions, so reaching the handler proves the session — the
    // SPA's Log out control survives reloads on this bit.
    const password = "status-probe-fixture-password";
    const passwordHash = Bun.password.hashSync(password, { algorithm: "argon2id" });
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, {
      auth: { enabled: true, user: "admin", passwordHash },
    });

    // without a session the gate answers first
    const gated = await app.request("/api/status");
    expect(gated.status).toBe(401);

    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "admin", password }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const admitted = await app.request("/api/status", { headers: { cookie } });
    expect(admitted.status).toBe(200);
    expect((await admitted.json()) as { status: string; authenticated: boolean }).toEqual({
      status: "ok",
      authenticated: true,
    });
  });
});

describe("retired management routes", () => {
  test("/api/configuration and the discovery mounts are gone — every method answers the envelope 404", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger);

    const removed: Array<{ path: string; init?: RequestInit }> = [
      { path: "/api/configuration" },
      { path: "/api/discovery" },
      { path: "/api/discovery", init: { method: "POST" } },
      { path: "/api/discovery/upstream/alpha", init: { method: "POST" } },
      { path: "/api/discovery/alias/fast", init: { method: "POST" } },
      { path: "/api/upstreams/alpha/discover" },
      { path: "/api/upstreams/alpha/discover", init: { method: "POST" } },
    ];
    for (const { path, init } of removed) {
      const response = await app.request(path, { ...init, headers: { ...(init?.headers ?? {}) } });
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toContain("application/json");
      const body = (await response.json()) as { error: { message: string; type: string } };
      expect(body.error.type, path).toBe("invalid_request_error");
      expect(body.error.message, path).toContain(path);
    }
  });
});

/* ------------------------------------------------------------------ */
/* UI namespace — root redirect + /ui/* serving (ADR-005)              */
/* ------------------------------------------------------------------ */

/** Distinctive fixture contents — index equality proves the SPA shell. */
const UI_INDEX_HTML = "<!doctype html><title>ui fixture</title>SPA-shell-marker";
const UI_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

/** Absolute fixture dirs: serveStatic joins any root verbatim (node:path). */
const UI_DIST_FIXTURE = join(import.meta.dir, "..", "..", "web", "dist-fixture");
const UI_DIST_ABSENT = join(import.meta.dir, "..", "..", "web", "dist-absent-fixture");
/** Exists but carries no index.html — the SPA fallback's missing-document path. */
const UI_DIST_EMPTY = join(import.meta.dir, "..", "..", "web", "dist-empty-fixture");

describe("docs namespace: GET /docs and GET /docs/openapi.json", () => {
  /**
   * The build-time artifact (`bun run apidocs`) served through the app via
   * the openApiDocPath option — production reads dist/openapi.json the same
   * way. The fixture lives under web/ next to the UI fixture dirs (distinct
   * from openapi.test.ts's: the files may run concurrently).
   */
  const DOCS_FIXTURE_DIR = join(import.meta.dir, "..", "..", "web", "docs-fixture-app");
  const DOCS_FIXTURE_DOC = join(DOCS_FIXTURE_DIR, "openapi.json");
  const DOCS_ABSENT_DOC = join(DOCS_FIXTURE_DIR, "absent.json");

  beforeAll(async () => {
    await writeOpenApiArtifact(DOCS_FIXTURE_DOC);
  });
  afterAll(() => {
    rmSync(DOCS_FIXTURE_DIR, { recursive: true, force: true });
  });

  /**
   * The thirteen operation paths the artifact always describes — the document
   * is deployment-independent: the auth actions belong to the interface
   * whether or not a given deployment enables the session gate (`:id`/
   * `:alias`/`:name` render as `{id}`/`{alias}`/`{name}` in the OpenAPI
   * document).
   */
  const DESCRIBED_PATHS = [
    "/llm/v1/models",
    "/llm/v1/chat/completions",
    "/llm/v1/completions",
    "/api/status",
    "/api/upstreams",
    "/api/upstreams/{id}",
    "/api/upstreams/{id}/models",
    "/api/models",
    "/api/models/{alias}",
    "/api/clients",
    "/api/clients/{name}",
    "/api/login",
    "/api/logout",
  ];

  test("GET /docs answers 200 text/html — the shell referencing the document route", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { openApiDocPath: DOCS_FIXTURE_DOC });
    const response = await app.request("/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    const html = await response.text();
    expect(html).toContain("/docs/openapi.json");
    expect(html).toContain("swagger-ui-bundle.js");
  });

  test("GET /docs/openapi.json serves the artifact — 200 application/json, OpenAPI 3.x, no upstream contact", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha", models: [model("gpt-4o")] }], logger, {
      openApiDocPath: DOCS_FIXTURE_DOC,
    }, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);
    const response = await app.request("/docs/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const document = (await response.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe("llm-gateway");
    // The artifact describes the full interface — all twenty-three operations,
    // independent of this deployment's auth block: a static document is
    // deployment-independent, and the auth actions' own descriptions state
    // the auth.enabled condition.
    expect(Object.keys(document.paths).sort()).toEqual([...DESCRIBED_PATHS].sort());
    // Serving reads a file — no upstream contact happens.
    expect(upstreams.get("alpha")?.received).toHaveLength(0);
  });

  test("auth enabled: both docs routes answer 200 without a session — the namespace sits outside every gate prefix", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, {
      auth: { enabled: true, user: "admin", passwordHash: "synthetic-fixture-hash-not-a-real-credential" },
      openApiDocPath: DOCS_FIXTURE_DOC,
    });
    // The gate itself is active in this fixture: a gated sibling answers
    // 401 without a cookie, while the docs namespace answers 200.
    const gated = await app.request("/api/status");
    expect(gated.status).toBe(401);

    const html = await app.request("/docs");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");

    const document = await app.request("/docs/openapi.json");
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("application/json");
    // With the auth gate mounted the document gains the auth actions.
    // The document is deployment-independent: the auth actions are
    // described exactly as with the gate off — what this fixture proves is
    // that the docs namespace passes the live gate untouched.
    const body = (await document.json()) as { paths: Record<string, unknown> };
    expect(body.paths["/api/login"]).toBeDefined();
    expect(body.paths["/api/logout"]).toBeDefined();
  });

  test("a missing artifact answers the envelope 404 with the regenerate hint — the server never generates", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { openApiDocPath: DOCS_ABSENT_DOC });
    const response = await app.request("/docs/openapi.json");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("bun run apidocs");
  });

  test("unknown /docs/* paths are not mounted — the envelope 404 fallthrough", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { openApiDocPath: DOCS_FIXTURE_DOC });
    const response = await app.request("/docs/ui-bundle.js");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { type: string; code?: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("UI namespace (ADR-005): GET / redirect and /ui/* serving", () => {
  beforeAll(() => {
    mkdirSync(UI_DIST_FIXTURE, { recursive: true });
    writeFileSync(join(UI_DIST_FIXTURE, "index.html"), UI_INDEX_HTML);
    writeFileSync(join(UI_DIST_FIXTURE, "icon.svg"), UI_ICON_SVG);
    mkdirSync(UI_DIST_EMPTY, { recursive: true });
  });
  afterAll(() => {
    rmSync(UI_DIST_FIXTURE, { recursive: true, force: true });
    rmSync(UI_DIST_EMPTY, { recursive: true, force: true });
  });

  /** Assert the OpenAI error envelope shape and hand back the body. */
  async function expectEnvelope(response: Response): Promise<{ error: Record<string, unknown> }> {
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.type).toBe("invalid_request_error");
    return body;
  }

  test("GET / answers 302 -> /ui, with and without the build output", async () => {
    const { logger } = fakeLogger();
    const served = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_FIXTURE });
    const redirect = await served.app.request("/");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/ui");

    const absent = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_ABSENT });
    const bare = await absent.app.request("/");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe("/ui");
  });

  test("GET /ui serves the SPA document from the build output", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_FIXTURE });

    const response = await app.request("/ui");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(UI_INDEX_HTML);
  });

  test("deep /ui/* routes serve index.html — React owns everything beyond /ui", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_FIXTURE });

    for (const path of ["/ui/status", "/ui/stats", "/ui/admin/upstreams"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toBe(UI_INDEX_HTML);
    }
    // HEAD falls back the same way GET does.
    const head = await app.request("/ui/status", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
  });

  test("a build output whose index.html vanished since startup answers plain-text 404 — no envelope, no 502", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_EMPTY });

    const response = await app.request("/ui/status");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("SPA document unavailable");
  });

  test("existing assets are served from the build output", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_FIXTURE });

    const response = await app.request("/ui/icon.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg");
    expect(await response.text()).toBe(UI_ICON_SVG);
  });

  test("unmatched paths outside /ui keep the envelope — even with the build output present", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_FIXTURE });

    for (const path of ["/llm/v1/nope", "/api/nope", "/v2/models", "/nope"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      await expectEnvelope(response);
    }
  });

  test("non-GET/HEAD requests under /ui/* keep the envelope 404", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_FIXTURE });

    const response = await app.request("/ui/status", { method: "POST" });
    expect(response.status).toBe(404);
    await expectEnvelope(response);
  });

  test("without the build output, /ui/* is not served: envelope 404", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger, { webDistDir: UI_DIST_ABSENT });

    for (const path of ["/ui", "/ui/status"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      await expectEnvelope(response);
    }
  });
});

/* ------------------------------------------------------------------ */
/* cross-cutting: logging, auth order, unmatched routes                */
/* ------------------------------------------------------------------ */

describe("cross-cutting middleware", () => {
  test("every request produces at least one log line, incl. method, path, status", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway([{ id: "alpha", models: [model("gpt-4o")] }], logger, {}, [
      aliasTo("fast", "alpha", "gpt-4o"),
    ]);

    await app.request("/llm/v1/models");
    await app.request("/llm/v1/chat/completions", completionRequest("fast"));
    await app.request("/llm/v1/chat/completions", completionRequest("bad-model"));
    await app.request("/nope");

    for (const path of ["/llm/v1/models", "/llm/v1/chat/completions", "/nope"]) {
      const forPath = lines.filter(
        (line) => line.level === "debug" && (line.obj as { path?: string }).path === path,
      );
      expect(forPath.length).toBeGreaterThanOrEqual(1);
    }
    const dispatch = lines.find(
      (line) => (line.obj as { path?: string; upstreamId?: string })?.upstreamId === "alpha",
    );
    expect(dispatch).toBeDefined();
  });

  test("the auth stage runs before routing — its trace line appears even for unmatched routes", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger);

    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    const authLines = lines.filter((line) => line.msg.includes("auth stage"));
    expect(authLines.length).toBe(1);
    expect((authLines[0]?.obj as { path?: string }).path).toBe("/nope");
  });

  test("unmatched routes answer in the OpenAI envelope, not plain text", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway([{ id: "alpha" }], logger);

    // /v1/models must 404 too — clean cut at /llm/v1, no alias (ADR-005).
    // An unknown /api/* path is a 404 envelope as well (gateway-management.md).
    for (const path of ["/v2/models", "/v1/models", "/api/nope"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBeUndefined();
    }
  });
});
