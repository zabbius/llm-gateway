/**
 * The HTTP surface end to end, driven through `app.request`
 * (specs/contracts/client-gateway.md): model aggregation with graceful
 * degradation, prefix dispatch against mock upstreams, the 400/404/502/504
 * error table, unchanged relay (incl. unbuffered SSE), auth stage preceding
 * routing, and ≥1 log line per request.
 */
import { describe, expect, test } from "bun:test";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../upstreams/registry.ts";
import { OpenAICompatibleUpstream } from "../upstreams/openai-compatible.ts";
import { createApp } from "./app.ts";

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
    },
  ) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}

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
}

/** Build a registry of fake upstreams plus the app wired to it. */
async function gateway(specs: UpstreamSpec[], logger: pino.Logger) {
  const entries: UpstreamConfig[] = specs.map((spec) => ({
    type: "openai-compatible",
    id: spec.id,
    baseUrl: `https://${spec.id}.example/v1`,
    apiKey: "sk-test",
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
  return { app: createApp(registry, logger), upstreams };
}

function completionRequest(modelId: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer sk-client-token",
      "x-custom": "keep-me",
    },
    body: JSON.stringify({ model: modelId, temperature: 0.5, stream: false }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* aggregation                                                         */
/* ------------------------------------------------------------------ */

describe("GET /v1/models", () => {
  test("one flat OpenAI list: ids prefixed, owned_by rewritten, config order, extras ride along", async () => {
    const { logger } = fakeLogger();
    const { app } = await gateway(
      [
        {
          id: "alpha",
          models: [
            model("gpt-4o", { max_context: 128000 }),
            model("text-embed", { created: 42, owned_by: "openai-org" }),
          ],
        },
        { id: "bravo", models: [model("davinci", { created: 1, owned_by: "legacy" })] },
      ],
      logger,
    );

    const response = await app.request("/v1/models");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const list = (await response.json()) as { object: string; data: ModelEntry[] };
    expect(list.object).toBe("list");
    expect(list.data.map((entry) => entry.id)).toEqual([
      "alpha/gpt-4o",
      "alpha/text-embed",
      "bravo/davinci",
    ]);
    expect(list.data.map((entry) => entry.owned_by)).toEqual(["alpha", "alpha", "bravo"]);
    expect(list.data[0]?.created).toBe(1712267047);
    expect(list.data[0]?.max_context).toBe(128000);
    expect(list.data[1]?.created).toBe(42);
    expect(list.data[2]?.owned_by).toBe("bravo");
  });

  test("degrades gracefully: a failing upstream contributes no entries, the rest still 200, warning names the upstream id", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway(
      [
        { id: "alpha", models: [model("gpt-4o")] },
        { id: "broken", modelsError: new Error("upstream down") },
        { id: "bravo", models: [model("davinci")] },
      ],
      logger,
    );

    const response = await app.request("/v1/models");
    expect(response.status).toBe(200);
    const list = (await response.json()) as { object: string; data: ModelEntry[] };
    expect(list.object).toBe("list");
    expect(list.data.map((entry) => entry.id)).toEqual(["alpha/gpt-4o", "bravo/davinci"]);

    const warnings = lines.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain("contributes no entries");
    const detail = warnings[0]?.obj as { upstreamId: string; reason: string };
    expect(detail.upstreamId).toBe("broken");
    expect(detail.reason).toBe("upstream down");
  });
});

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

describe("POST /v1/chat/completions and /v1/completions", () => {
  test("de-prefixes body.model (the only transformation), relays headers minus credentials, response unchanged", async () => {
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
    const { app, upstreams } = await gateway([{ id: "alpha", respond }], logger);

    const response = await app.request("/v1/chat/completions", completionRequest("alpha/gpt-4o"));
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

  test("legacy /v1/completions forwards the completions upstream path", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger);

    const response = await app.request("/v1/completions", completionRequest("alpha/davinci"));
    expect(response.status).toBe(200);
    const received = upstreams.get("alpha")?.received[0];
    if (received === undefined) throw new Error("upstream was not called");
    expect(received.path).toBe("completions");
    const forwarded = (await new Response(received.body).json()) as { model: string };
    expect(forwarded.model).toBe("davinci");
  });

  test("an unknown model under a known upstream is forwarded — the upstream owns the verdict", async () => {
    const { logger } = fakeLogger();
    const respond: Responder = () => jsonResponse({ error: { message: "no such model" } }, 404);
    const { app, upstreams } = await gateway([{ id: "alpha", respond }], logger);

    const response = await app.request("/v1/chat/completions", completionRequest("alpha/does-not-exist"));
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
    const { app } = await gateway([{ id: "alpha", respond }], logger);

    const response = await app.request("/v1/chat/completions", completionRequest("alpha/gpt-4o"));
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
  test("404 model_not_found for slash-less, empty-half and unknown-prefix ids — upstream never called", async () => {
    const { logger } = fakeLogger();
    const { app, upstreams } = await gateway([{ id: "alpha" }], logger);

    for (const bad of ["gpt-4o", "nope/gpt-4o", "alpha/", "/gpt-4o"]) {
      const response = await app.request("/v1/chat/completions", completionRequest(bad));
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: Record<string, string> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("model");
      expect(body.error.code).toBe("model_not_found");
      expect(body.error.message).toContain(bad);
    }
    expect(upstreams.get("alpha")?.received).toHaveLength(0);
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
      const response = await app.request("/v1/chat/completions", post(raw));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBeUndefined();
      expect(typeof body.error.message).toBe("string");
    }
    expect(upstreams.get("alpha")?.received).toHaveLength(0);
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
      const registry = await UpstreamRegistry.create(
        [
          {
            type: "openai-compatible",
            id: "real",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            apiKey: "sk-test",
          },
        ],
        { "openai-compatible": (entry, child) => new OpenAICompatibleUpstream(entry, child) },
        logger,
      );
      const app = createApp(registry, logger);

      const response = await app.request("/v1/chat/completions", completionRequest("real/gpt-4o"));
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
    const registry = await UpstreamRegistry.create(
      [{ type: "openai-compatible", id: "dead", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test" }],
      { "openai-compatible": (entry, child) => new OpenAICompatibleUpstream(entry, child) },
      logger,
    );
    const app = createApp(registry, logger);

    const response = await app.request("/v1/chat/completions", completionRequest("dead/gpt-4o"));
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
    const { app } = await gateway([{ id: "alpha", respond }], logger);

    const response = await app.request("/v1/chat/completions", completionRequest("alpha/gpt-4o"));
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
/* cross-cutting: logging, auth order, unmatched routes                */
/* ------------------------------------------------------------------ */

describe("cross-cutting middleware", () => {
  test("every request produces at least one log line, incl. method, path, status", async () => {
    const { logger, lines } = fakeLogger();
    const { app } = await gateway([{ id: "alpha", models: [model("gpt-4o")] }], logger);

    await app.request("/v1/models");
    await app.request("/v1/chat/completions", completionRequest("alpha/gpt-4o"));
    await app.request("/v1/chat/completions", completionRequest("bad-model"));
    await app.request("/nope");

    for (const path of ["/v1/models", "/v1/chat/completions", "/nope"]) {
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

    const response = await app.request("/v2/models");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBeUndefined();
  });
});
