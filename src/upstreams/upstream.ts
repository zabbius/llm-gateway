/**
 * The upstream interface — the only upstream shape the gateway core and the
 * registry see (specs/domains/upstreams/upstream-contract.md, invariant 6 of
 * specs/architecture/layers.md: this module imports shared types only and
 * both the core and every upstream depend on it).
 *
 * `UpstreamConfig` / `UpstreamType` are re-exported (type-only) from the config
 * schema: the configuration domain owns the config-file grammar — validation
 * and normalization live in exactly one place (`src/config/schema.ts`) — and
 * the upstream domain consumes that slice. No runtime dependency on the config
 * loader is created.
 */
import type pino from "pino";

export type { UpstreamConfig, UpstreamType } from "../config/schema.ts";
import type { UpstreamConfig, UpstreamType } from "../config/schema.ts";

/**
 * One upstream model entry, as an upstream reports it — ids are UNPREFIXED
 * provider-native ids; the `{upstreamId}/` prefix and the `owned_by` rewrite
 * happen in the routing aggregation, not in upstreams. Provider-native extra
 * fields ride along unchanged (open index signature).
 */
export interface ModelEntry {
  /** Provider-native model id; aggregation adds the "{upstreamId}/" prefix. */
  id: string;
  object: "model";
  /** Passed through from upstream; defaults to 0 when absent. */
  created: number;
  /** Passed through from upstream; rewritten by the aggregation. */
  owned_by: string;
  [field: string]: unknown;
}

/**
 * One OpenAI-protocol request handed to `forward()` by the router. The body
 * is relayed as received — streamed, never buffered whole. The router has
 * already de-prefixed `body.model`; the upstream attaches its own credentials
 * (the client's `Authorization` never reaches an upstream's outbound request).
 */
export interface ProxyRequest {
  /** Upstream path relative to baseUrl: "chat/completions", "completions", "models". */
  path: string;
  method: "GET" | "POST";
  /** Client body relayed as received — streamed, never buffered whole. */
  body?: ReadableStream<Uint8Array>;
  /** Relay headers (Content-Type, Accept, …); the upstream attaches its own credentials. */
  headers: Record<string, string>;
}

/** The outcome of one upstream's one-shot startup probe (`connect()`). */
export type UpstreamProbe = "ok" | "failed";

/**
 * The outcome of one upstream's one-shot startup probe (`connect()`), as the
 * registry retains it and the management surface serves it (`GET /api/status`,
 * specs/contracts/gateway-management.md). Config identity plus the probe fact
 * only — never credential or config material; `reason` (a log-safe failure
 * fact, the same string the startup warning carries) exists only when
 * `probe` is `"failed"`.
 */
export interface UpstreamStatus {
  /** Config identity: unique routing namespace. */
  readonly id: string;
  /** Implementation discriminator; mirrors the config entry's `type`. */
  readonly type: UpstreamType;
  /** Whether the one-shot startup probe succeeded. */
  readonly probe: UpstreamProbe;
  /** Log-safe failure fact (why the probe failed); absent when `probe` is `"ok"`. */
  readonly reason?: string;
}

/**
 * The uniform upstream surface (specs/domains/upstreams/upstream-contract.md).
 * `connect()` runs exactly once per upstream at startup, before any
 * `forward()` / `listModels()` call; it resolves when the probe succeeded and
 * rejects with a log-safe reason when it did not — the registry records the
 * outcome (`UpstreamStatus`), logs the warning naming the entry's type and
 * id, and startup continues either way. `forward()` relays status, headers,
 * and body as received and never fabricates a success response.
 */
export interface Upstream {
  /** Config identity: unique routing namespace. */
  readonly id: string;
  /** Implementation discriminator; selects the constructor in the factory map. */
  readonly type: UpstreamType;

  /**
   * Startup phase. Called once; probes the upstream. Resolves when the probe
   * succeeded; rejects with a log-safe reason when it did not (the registry
   * retains the outcome and startup continues — never fatal).
   */
  connect(): Promise<void>;

  /** Provider-native model list; ids unprefixed — aggregation adds "{id}/". */
  listModels(): Promise<ModelEntry[]>;

  /** Pure pass-through of one OpenAI-protocol request (incl. SSE streams). */
  forward(request: ProxyRequest): Promise<Response>;
}

/**
 * Constructor of one upstream implementation, selected by the config entry's
 * `type`. The `type` → factory map is injected by the entry point (the only
 * place concrete upstream classes are named — specs/architecture/layers.md,
 * invariant 2); the registry performs the dispatch.
 */
export type UpstreamFactory = (entry: UpstreamConfig, logger: pino.Logger) => Upstream;
