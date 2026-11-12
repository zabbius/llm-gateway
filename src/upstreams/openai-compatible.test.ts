/**
 * OpenAICompatibleUpstream against a mock upstream (Bun.serve).
 *
 * Covers the delegation acceptance criteria: header whitelist (client
 * Authorization and hop-by-hop never reach upstream), URL building,
 * SSE relayed chunk-by-chunk without buffering (cancel aborts upstream),
 * upstream 4xx JSON relayed as-is, 502/502-empty synthesis, 504 on timeout,
 * and connect() probe failures surfacing to the registry as a rejection with
 * a log-safe reason (the registry warns and retains the outcome).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type pino from "pino";
import type { ProxyRequest } from "./upstream.ts";
import {
  OpenAICompatibleUpstream,
  type OpenAICompatibleTimeouts,
} from "./openai-compatible.ts";

/** Minimal capturing stand-in for the injected pino child logger. */
function fakeLogger(bindings: Record<string, unknown> = {}): {
  logger: pino.Logger;
  lines: Array<{ level: string; bindings: Record<string, unknown>; obj: unknown; msg: string }>;
} {
  const lines: Array<{ level: string; bindings: Record<string, unknown>; obj: unknown; msg: string }> = [];
  const emit =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, bindings, obj, msg: typeof obj === "string" ? obj : (msg ?? "") });
    };
  const build = (bound: Record<string, unknown>): pino.Logger =>
    ({
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
      child: (next: Record<string, unknown>) => build({ ...bound, ...next }),
    }) as unknown as pino.Logger;
  return { logger: build(bindings), lines };
}

const API_KEY = "sk-upstream-secret";

interface CapturedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const servers: Array<{ stop(force?: boolean): void }> = [];

/** Start a mock OpenAI upstream; every request is captured (body read as text). */
function startUpstream(handler: (req: Request, url: URL) => Response | Promise<Response>): {
  requests: CapturedRequest[];
  baseUrl: string;
} {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const body = await req.text();
      requests.push({ path: new URL(req.url).pathname, method: req.method, headers, body });
      return handler(req, new URL(req.url));
    },
  });
  servers.push(server);
  return { requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

afterEach(() => {
  for (const server of servers) server.stop(true);
  servers.length = 0;
});

function makeUpstream(baseUrl: string, timeouts: OpenAICompatibleTimeouts = {}): {
  upstream: OpenAICompatibleUpstream;
  lines: ReturnType<typeof fakeLogger>["lines"];
} {
  const { logger, lines } = fakeLogger();
  const upstream = new OpenAICompatibleUpstream(
    { type: "openai-compatible", id: "openai", baseUrl, apiKey: API_KEY },
    logger,
    timeouts,
  );
  return { upstream, lines };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function proxyRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    path: "chat/completions",
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: streamOf(JSON.stringify({ model: "gpt-4o", stream: true })),
    ...overrides,
  };
}

/** An SSE upstream response delivering the given chunks `gapMs` apart. */
function sseResponse(chunks: string[], gapMs: number, extraHeaders: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (gapMs > 0) await Bun.sleep(gapMs);
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...extraHeaders },
  });
}

const OPENAI_ERROR_BODY = JSON.stringify({
  error: { message: "invalid api key", type: "invalid_request_error", code: "invalid_api_key" },
});

describe("OpenAICompatibleUpstream", () => {
  test("builds the upstream URL as baseUrl + '/' + path", async () => {
    const { requests, baseUrl } = startUpstream(() => Response.json({ ok: true }));
    const { upstream } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    await response.text();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/chat/completions");
    expect(requests[0]?.method).toBe("POST");
  });

  test("sends exactly one credential — config apiKey Bearer; client Authorization never forwarded; only Content-Type/Accept relayed", async () => {
    const { requests, baseUrl } = startUpstream(() => Response.json({ ok: true }));
    const { upstream } = makeUpstream(baseUrl);

    await upstream.forward(
      proxyRequest({
        headers: {
          authorization: "Bearer client-secret",
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-custom": "must-not-relay",
          te: "trailers",
        },
      }),
    );

    const headers = requests[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers.authorization).not.toBe("Bearer client-secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-custom"]).toBeUndefined();
    expect(headers.te).toBeUndefined(); // hop-by-hop — never relayed
  });

  test("relays upstream response headers minus hop-by-hop", async () => {
    const { baseUrl } = startUpstream(() =>
      Response.json({ ok: true }, { headers: { "x-request-id": "req-1" } }),
    );
    const { upstream } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    await response.text();

    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
  });

  test("relays a non-streaming 2xx response byte-for-byte, request body included", async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
    const { requests, baseUrl } = startUpstream(() =>
      new Response(payload, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { upstream } = makeUpstream(baseUrl);

    const sent = JSON.stringify({ model: "gpt-4o", stream: false });
    const response = await upstream.forward(proxyRequest({ body: streamOf(sent) }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe(payload);
    expect(requests[0]?.body).toBe(sent);
  });

  test("relays an upstream 4xx JSON error as-is — status and body untouched", async () => {
    const { baseUrl } = startUpstream(() =>
      new Response(OPENAI_ERROR_BODY, { status: 401, headers: { "content-type": "application/json" } }),
    );
    const { upstream } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe(OPENAI_ERROR_BODY);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("synthesizes 502 upstream_error for a non-JSON error body (HTML)", async () => {
    const { baseUrl } = startUpstream(() =>
      new Response("<html>gateway error</html>", { status: 500, headers: { "content-type": "text/html" } }),
    );
    const { upstream, lines } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    const parsed = (await response.json()) as { error: { type: string; code: string; message: string } };

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(parsed.error.type).toBe("api_error");
    expect(parsed.error.code).toBe("upstream_error");
    expect(parsed.error.message).toContain("openai");
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  test("synthesizes 502 upstream_error for an empty error body", async () => {
    const { baseUrl } = startUpstream(() => new Response("", { status: 503 }));
    const { upstream } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    const parsed = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(parsed.error.code).toBe("upstream_error");
  });

  test("synthesizes 504 upstream_timeout when the upstream stalls past the forward budget", async () => {
    const { baseUrl } = startUpstream(async () => {
      await Bun.sleep(400);
      return Response.json({ late: true });
    });
    const { upstream } = makeUpstream(baseUrl, { forwardMs: 80 });

    const response = await upstream.forward(proxyRequest());
    const parsed = (await response.json()) as { error: { type: string; code: string; message: string } };

    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(parsed.error.type).toBe("api_error");
    expect(parsed.error.code).toBe("upstream_timeout");
    expect(parsed.error.message).toBe(`upstream "openai" is unreachable: timeout`);
  });

  test("streams SSE chunk-by-chunk without buffering — chunks arrive as the upstream sends them", async () => {
    const { baseUrl } = startUpstream(() => sseResponse(["data: a\n\n", "data: b\n\n", "data: c\n\n"], 90));
    const { upstream } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: Array<{ at: number; text: string }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({ at: Date.now(), text: decoder.decode(value) });
    }

    expect(arrivals.map((a) => a.text)).toEqual(["data: a\n\n", "data: b\n\n", "data: c\n\n"]);
    const gap = (arrivals[1]?.at ?? 0) - (arrivals[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(50); // chunks did NOT arrive together
    const total = (arrivals[2]?.at ?? 0) - (arrivals[0]?.at ?? 0);
    expect(total).toBeLessThan(2 * 90 + 120); // incremental, not end-loaded
  });

  test("ends the SSE stream cleanly after the idle budget — no error, no later chunks", async () => {
    const { baseUrl } = startUpstream(() => sseResponse(["data: a\n\n", "data: b-never-seen\n\n"], 600));
    const { upstream } = makeUpstream(baseUrl, { streamIdleMs: 100 });

    const response = await upstream.forward(proxyRequest());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: a\n\n");

    const started = Date.now();
    const second = await reader.read();
    const elapsed = Date.now() - started;

    expect(second.done).toBe(true); // ended, not errored — no JSON after SSE started
    expect(elapsed).toBeLessThan(450);
  });

  test("client disconnect aborts the upstream request", async () => {
    let upstreamAborted = false;
    const chunks: string[] = Array.from({ length: 40 }, (_, i) => `data: chunk-${i}\n\n`);
    const { baseUrl } = startUpstream((req) => {
      req.signal.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return sseResponse(chunks, 50);
    });
    const { upstream } = makeUpstream(baseUrl);

    const response = await upstream.forward(proxyRequest());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    const deadline = Date.now() + 1500;
    while (!upstreamAborted && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(upstreamAborted).toBe(true);
  });

  test("connect() rejects with a log-safe reason when the probe fails — the registry logs the warning and retains the outcome", async () => {
    const { baseUrl } = startUpstream(() =>
      new Response("<html>boom</html>", { status: 500, headers: { "content-type": "text/html" } }),
    );
    const { upstream, lines } = makeUpstream(baseUrl);

    await expect(upstream.connect()).rejects.toThrow("500");

    // the warning belongs to the registry (it retains the probe outcome for
    // GET /api/status) — the upstream itself stays silent on failure
    expect(lines.some((line) => line.level === "warn")).toBe(false);
  });

  test("connect() applies the probe budget — a stalled probe times out into a rejection", async () => {
    const { baseUrl } = startUpstream(async () => {
      await Bun.sleep(400);
      return Response.json({ data: [] });
    });
    const { upstream, lines } = makeUpstream(baseUrl, { connectProbeMs: 80 });

    const started = Date.now();
    await expect(upstream.connect()).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeLessThan(350);

    expect(lines.some((line) => line.level === "warn")).toBe(false);
  });

  test("connect() logs info on a successful probe", async () => {
    const { baseUrl } = startUpstream(() =>
      Response.json({ object: "list", data: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "system" }] }),
    );
    const { upstream, lines } = makeUpstream(baseUrl);

    await expect(upstream.connect()).resolves.toBeUndefined();

    const info = lines.find((line) => line.level === "info");
    expect(info).toBeDefined();
    expect((info?.obj as { models: number }).models).toBe(1);
    expect(lines.some((line) => line.level === "warn" || line.level === "error")).toBe(false);
  });

  test("listModels() returns provider-native unprefixed entries with Authorization from config", async () => {
    const upstreamList = {
      object: "list",
      data: [{ id: "gpt-4o", object: "model", created: 1700000000, owned_by: "system", scope: "chat" }],
    };
    const { requests, baseUrl } = startUpstream(() => Response.json(upstreamList));
    const { upstream } = makeUpstream(baseUrl);

    const models = await upstream.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("gpt-4o"); // unprefixed — no "openai/" prefix here
    expect(models[0]?.object).toBe("model");
    expect(models[0]?.created).toBe(1700000000);
    expect(models[0]?.owned_by).toBe("system");
    expect(models[0]?.scope).toBe("chat"); // provider extras pass through

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe("/v1/models");
    expect(request?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers.accept).toBe("application/json");
  });
});
