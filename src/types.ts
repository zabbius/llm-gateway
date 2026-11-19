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
 * One entry of the `GET /llm/v1/models` list (ADR-009): the gateway's own
 * alias catalog, not an upstream aggregation. Every entry is gateway-shaped:
 * `id` is a configured alias, `created` is the process start epoch, and
 * `owned_by` is "llm-gateway".
 *
 * Alias metadata (specs/domains/routing.md "Alias metadata"): when the
 * routing domain's aggregated `AliasMetadata` knows something about the
 * alias, the entry gains the optional projection below — `limit` only when
 * the context window is known (context > 0 required; `output` is 0 when the
 * output limit is not declared, the c0wrk wire contract's "0 == undeclared"),
 * and `capabilities` / `modalities` only together, only when every route of
 * the alias made the full four-flag declaration. An alias with no known
 * metadata serializes exactly the four base keys — absent means unknown,
 * never a fabricated zero or false.
 */
export interface ModelEntry {
  /** Public model id: a configured alias from the `models` block (ADR-009). */
  id: string;
  object: "model";
  /** The process start epoch (seconds) — one fixed timestamp per process. */
  created: number;
  /** Always "llm-gateway": the catalog is the gateway's own. */
  owned_by: string;
  /** The aggregated token budget — present only when the context window is known. */
  limit?: ModelEntryLimit;
  /** The capability declaration — present only on the full four-flag declaration. */
  capabilities?: ModelEntryCapabilities;
  /** The declared input modalities — present exactly when `capabilities` is. */
  modalities?: ModelEntryModalities;
  [field: string]: unknown;
}

/** The aggregated token budget on a catalog entry (the c0wrk wire contract). */
export interface ModelEntryLimit {
  /** Positive: the alias's smallest context window any route can serve. */
  context: number;
  /** 0 when the output limit is not declared — "0 == undeclared" on the wire. */
  output: number;
}

/**
 * The capability declaration on a catalog entry — present only when the
 * alias's routes made the full four-flag declaration (strict AND over the
 * routes; all-false is authoritative when every route declared false).
 */
export interface ModelEntryCapabilities {
  tools: { supported: boolean };
  reasoning: { supported: boolean };
  temperature: boolean;
}

/** The declared input modalities: `"text"`, plus `"image/png"` when image input is declared. */
export interface ModelEntryModalities {
  input: string[];
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
