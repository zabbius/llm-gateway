/**
 * The MVP provider adapter: a pure HTTP proxy in front of any upstream that
 * speaks the OpenAI API (base URL + API key), relaying requests and responses
 * — including SSE streams — unchanged
 * (specs/domains/adapters/openai-compatible.md).
 *
 * Header policy (out): exactly one credential — the configured `apiKey` as a
 * `Bearer` token — plus the client's `Content-Type` and `Accept` relayed.
 * Nothing else from the client request is forwarded: the client's own
 * `Authorization` and hop-by-hop headers never reach upstream, and the apiKey
 * never appears in logs or in any response returned to the client.
 *
 * Failure mapping (never fabricates a success): an upstream 4xx/5xx with a
 * JSON body is relayed byte-for-byte with its original status; an upstream
 * error body that is not relayable JSON (HTML / empty / wrong type) becomes
 * a synthesized `502 upstream_error`; an unreachable upstream or a timeout
 * becomes a synthesized `504 upstream_timeout`. One attempt per client
 * request — no retries in the MVP.
 */
import type pino from "pino";
import type { Adapter, AdapterConfig, ModelEntry, ProxyRequest } from "./adapter.ts";

/** The `listModels()` probe inside `connect()` (startup; non-fatal on expiry). */
export const CONNECT_PROBE_TIMEOUT_MS = 10_000;
/** Non-streaming `forward()` end-to-end; for streams — until response headers arrive. */
export const FORWARD_TIMEOUT_MS = 120_000;
/** Once streaming: maximum silence between SSE chunks (no total cap). */
export const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Test seam for the fixed MVP constants — never populated from config
 * (making the budgets configurable is a contract change,
 * specs/contracts/gateway-upstream.md, Breaking Change Checklist item 7).
 */
export interface OpenAICompatibleTimeouts {
  connectProbeMs?: number;
  forwardMs?: number;
  streamIdleMs?: number;
}

/** Request headers relayed from the client call to upstream (whitelist). */
const RELAYED_REQUEST_HEADERS: readonly string[] = ["content-type", "accept"];

/** Hop-by-hop headers — never forwarded in either direction (RFC 9110 §7.6.1). */
const HOP_BY_HOP_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
];

export class OpenAICompatibleAdapter implements Adapter {
  readonly id: string;
  readonly type: AdapterConfig["type"];

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly logger: pino.Logger;
  private readonly timeouts: Required<OpenAICompatibleTimeouts>;

  constructor(config: AdapterConfig, logger: pino.Logger, timeouts: OpenAICompatibleTimeouts = {}) {
    this.id = config.id;
    this.type = config.type;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.logger = logger;
    this.timeouts = {
      connectProbeMs: timeouts.connectProbeMs ?? CONNECT_PROBE_TIMEOUT_MS,
      forwardMs: timeouts.forwardMs ?? FORWARD_TIMEOUT_MS,
      streamIdleMs: timeouts.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS,
    };
  }

  /**
   * Startup probe: `GET {baseUrl}/models` within the probe budget. Never
   * rejects — the outcome is logged (info on success, warning naming type
   * and id on failure) and startup continues; every upstream call re-attempts
   * the provider, so a degraded adapter still serves requests.
   */
  async connect(): Promise<void> {
    try {
      const models = await this.fetchModels(this.timeouts.connectProbeMs);
      this.logger.info({ models: models.length }, "startup probe ok — upstream reachable");
    } catch (error) {
      this.logger.warn(
        { type: this.type, id: this.id, reason: describe(error) },
        "startup probe failed — adapter degraded, startup continues",
      );
    }
  }

  /**
   * Provider-native model list, ids unprefixed. Failures here degrade the
   * adapter's contribution to `GET /v1/models` (the aggregation catches and
   * logs; the rest of the list still returns 200).
   */
  listModels(): Promise<ModelEntry[]> {
    return this.fetchModels(this.timeouts.forwardMs);
  }

  /**
   * Pure pass-through of one OpenAI-protocol request, streamed end to end.
   * The forward budget covers the call until upstream response headers
   * arrive (for streams) or the whole non-streaming body; once SSE is
   * flowing, only the idle budget applies — a stall longer than it aborts
   * the upstream request and simply ends the client stream (no JSON error
   * after SSE started). A client disconnect cancels the upstream request.
   */
  async forward(request: ProxyRequest): Promise<Response> {
    const controller = new AbortController();
    let forwardTimedOut = false;
    const forwardTimer = setTimeout(() => {
      forwardTimedOut = true;
      controller.abort();
    }, this.timeouts.forwardMs);
    forwardTimer.unref();

    let upstream: Response;
    try {
      upstream = await fetch(this.upstreamUrl(request.path), {
        method: request.method,
        headers: this.outHeaders(request.headers),
        body: request.body,
        signal: controller.signal,
        redirect: "manual",
        ...(request.body === undefined ? {} : { duplex: "half" as const }),
      });
    } catch (error) {
      clearTimeout(forwardTimer);
      return this.unreachableResponse(error, forwardTimedOut);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const isEventStream = contentType.includes("text/event-stream");
    const relayedHeaders = relayedResponseHeaders(upstream.headers);

    if (upstream.status >= 400 && !isJsonContentType(contentType)) {
      clearTimeout(forwardTimer);
      void upstream.body?.cancel();
      this.logger.error(
        { upstreamStatus: upstream.status, code: "upstream_error" },
        "upstream error body is not relayable JSON — synthesizing 502",
      );
      return synthesizedError(
        502,
        "upstream_error",
        `upstream "${this.id}" returned a non-JSON error body (HTTP ${upstream.status})`,
      );
    }

    if (isEventStream) {
      // Streaming: the total budget stops at the headers; an idle watchdog
      // takes over — aborting the upstream request when no chunk arrives in
      // time and ending the client stream gracefully.
      clearTimeout(forwardTimer);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const disarmIdle = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      const armIdle = () => {
        disarmIdle();
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          controller.abort();
        }, this.timeouts.streamIdleMs);
        idleTimer.unref();
      };

      const body = relayBody(upstream, {
        onChunk: armIdle,
        onEnd: disarmIdle,
        gracefulError: true,
        clientCancel: () => {
          disarmIdle();
          controller.abort();
        },
      });
      armIdle();
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: relayedHeaders,
      });
    }

    // Non-streaming: the forward budget stays armed until the body is fully
    // relayed (end-to-end budget) and is cleared the moment the body ends.
    const body = relayBody(upstream, {
      onEnd: () => clearTimeout(forwardTimer),
      gracefulError: false,
      clientCancel: () => {
        clearTimeout(forwardTimer);
        controller.abort();
      },
    });
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: relayedHeaders,
    });
  }

  /** `GET {baseUrl}/models` within `timeoutMs`; shared by probe and serve paths. */
  private async fetchModels(timeoutMs: number): Promise<ModelEntry[]> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    let upstream: Response;
    try {
      upstream = await fetch(this.upstreamUrl("models"), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      clearTimeout(timer);
      throw new Error(`upstream "${this.id}" is unreachable: ${timedOut ? "timeout" : describe(error)}`);
    }

    if (!upstream.ok) {
      clearTimeout(timer);
      void upstream.body?.cancel();
      throw new Error(`model list request failed with HTTP ${upstream.status}`);
    }

    try {
      const parsed = (await upstream.json()) as { data?: unknown };
      const entries = parsed?.data;
      if (!Array.isArray(entries)) {
        throw new Error(`model list response has no "data" array`);
      }
      return entries.map(toModelEntry);
    } finally {
      clearTimeout(timer);
    }
  }

  private upstreamUrl(path: string): string {
    return `${this.baseUrl}/${path}`;
  }

  /**
   * Outbound headers: the configured `apiKey` as the only credential, plus
   * the whitelisted relayed headers. A client-supplied `Authorization` (or
   * any other header) is never forwarded.
   */
  private outHeaders(relayed: Record<string, string>): Record<string, string> {
    const lowerCased = new Map<string, string>();
    for (const [name, value] of Object.entries(relayed)) {
      lowerCased.set(name.toLowerCase(), value);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    for (const name of RELAYED_REQUEST_HEADERS) {
      const value = lowerCased.get(name);
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    return headers;
  }

  /** Upstream unreachable / timed out → synthesized `504 upstream_timeout`. */
  private unreachableResponse(error: unknown, timedOut: boolean): Response {
    const reason = timedOut ? "timeout" : describe(error);
    this.logger.error({ code: "upstream_timeout", reason }, "upstream unreachable — synthesizing 504");
    return synthesizedError(504, "upstream_timeout", `upstream "${this.id}" is unreachable: ${reason}`);
  }
}

/**
 * Relay an upstream body chunk-by-chunk, unbuffered: one `reader.read()` per
 * consumer pull, no reordering, no parsing. `gracefulError` picks the
 * mid-stream failure semantics: SSE streams end cleanly (no JSON error after
 * SSE started); non-streaming bodies surface the error (never a silently
 * truncated 2xx). Client cancellation aborts the upstream request.
 */
function relayBody(
  upstream: Response,
  hooks: {
    onChunk?: () => void;
    onEnd: () => void;
    gracefulError: boolean;
    clientCancel: () => void;
  },
): ReadableStream<Uint8Array> {
  if (upstream.body === null) {
    hooks.onEnd();
    return new ReadableStream<Uint8Array>({ start(controller) {
      controller.close();
    } });
  }
  const reader = upstream.body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          hooks.onEnd();
          controller.close();
          return;
        }
        hooks.onChunk?.();
        controller.enqueue(next.value);
      } catch (error) {
        hooks.onEnd();
        if (hooks.gracefulError) {
          controller.close();
        } else {
          controller.error(error);
        }
        return;
      }
    },
    cancel() {
      hooks.onEnd();
      hooks.clientCancel();
    },
  });
}

/** Upstream response headers relayed unchanged, minus hop-by-hop headers. */
function relayedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream.entries()) {
    if (!HOP_BY_HOP_HEADERS.includes(name.toLowerCase())) {
      headers.append(name, value);
    }
  }
  return headers;
}

/** True when the content-type names JSON (`application/json`, `…+json`). */
function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/**
 * A gateway-generated failure in the OpenAI error envelope
 * (specs/types.ts `ErrorEnvelope` shape; type "api_error" per
 * specs/contracts/gateway-upstream.md error propagation table).
 */
function synthesizedError(status: 502 | 504, code: "upstream_error" | "upstream_timeout", message: string): Response {
  const body = JSON.stringify({ error: { message, type: "api_error", code } });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** Normalize one provider-native model entry; extra fields ride along. */
function toModelEntry(value: unknown): ModelEntry {
  if (typeof value !== "object" || value === null) {
    throw new Error("model list contains a non-object entry");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") {
    throw new Error("model list entry has no string id");
  }
  return {
    ...record,
    id: record.id,
    object: "model",
    created: typeof record.created === "number" ? record.created : 0,
    owned_by: typeof record.owned_by === "string" ? record.owned_by : "",
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
