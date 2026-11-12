/**
 * Shared cross-cutting types: the gateway log-level vocabulary and the
 * OpenAI-protocol shapes pinned by specs/contracts/client-gateway.md.
 *
 * The gateway is a pass-through proxy: request/response bodies cross the
 * boundary essentially unchanged (only `model` is rewritten), so the protocol
 * surface typed here is deliberately minimal — the fields the gateway itself
 * reads or rewrites, plus the envelopes it must produce.
 */

/**
 * The gateway's log-level vocabulary (specs/domains/observability.md).
 *
 * Config uses these spellings; the mapping onto pino's spellings
 * (`warning` → `warn`, `none` → `silent`) lives in exactly one place —
 * `PINO_LEVEL` in `src/logging/logger.ts`.
 */
export type LogLevel = "trace" | "debug" | "info" | "warning" | "error" | "none";

/**
 * One entry of the `GET /v1/models` list. Provider-provided entry fields pass
 * through unchanged, except `id` (rewritten to `<upstreamId>/<model>`) and
 * `owned_by` (set to `upstreamId`) — hence the open index signature.
 */
export interface ModelEntry {
  /** Public model id: `<upstreamId>/<model>` (ADR-002 prefix scheme). */
  id: string;
  object: "model";
  created: number;
  /** The upstream id that serves this model. */
  owned_by: string;
  [field: string]: unknown;
}

/** The OpenAI list envelope returned by `GET /v1/models`. */
export interface ModelList {
  object: "list";
  data: ModelEntry[];
}

/**
 * Every gateway-generated failure is returned as this OpenAI-compatible error
 * envelope. Upstream errors that are already OpenAI-shaped pass through
 * byte-for-byte and are never wrapped in another envelope.
 */
export interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

/**
 * OpenAI completion request body (`/v1/chat/completions`, `/v1/completions`).
 * The gateway reads and rewrites only `model`; every other field is forwarded
 * upstream verbatim.
 */
export interface CompletionRequestBody {
  model: string;
  [field: string]: unknown;
}
