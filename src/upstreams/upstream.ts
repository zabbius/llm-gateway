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
  /**
   * The model catalog the upstream retained from its own startup probe — a
   * frozen, immutable snapshot of the provider's model list at startup
   * (provider-native unprefixed ids, exactly as `listModels()` reports
   * them). Present only when `probe` is `"ok"` and the upstream retains its
   * probe result; a failed probe retains no catalog. Never credential or
   * config material.
   */
  readonly models?: readonly ModelEntry[];
}

/**
 * The uniform upstream surface (specs/domains/upstreams/upstream-contract.md).
 * `connect()` runs exactly once per upstream at startup, before any
 * `forward()` / `listModels()` call; it resolves when the probe succeeded and
 * rejects with a log-safe reason when it did not — the registry records the
 * outcome (`UpstreamStatus`), logs the warning naming the entry's type and
 * id, and startup continues either way. `forward()` relays status, headers,
 * and body as received and never fabricates a success response. The optional
 * `discover()` re-probes the provider on demand for a fresh model snapshot
 * and never writes the startup snapshot.
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

  /**
   * The startup snapshot this upstream retained from its own `connect()`
   * run, when it keeps one. The registry folds it into the status it
   * retains, consulting it exactly once — right after `connect()` resolved
   * (the lifecycle guarantees connect ran before anything else). It is
   * never a second probe and is never consulted again after startup.
   * Upstreams that retain no snapshot simply leave the method out.
   */
  status?(): UpstreamStatus | undefined;

  /**
   * Optional on-demand re-probe: fetch a fresh model snapshot from the
   * provider right now, re-running the same legs the startup probe ran.
   * It never writes the startup snapshot (`status()` keeps exactly what
   * `connect()` retained) and rejects with a log-safe reason when the
   * probe fails. Implementations that cannot re-probe leave the method
   * out — callers must treat it as optional.
   */
  discover?(): Promise<readonly ModelEntry[]>;

  /** Provider-native model list; ids unprefixed — aggregation adds "{id}/". */
  listModels(): Promise<ModelEntry[]>;

  /** Pure pass-through of one OpenAI-protocol request (incl. SSE streams). */
  forward(request: ProxyRequest): Promise<Response>;

  /**
   * Release what the instance owns that outlives a request — the loopback
   * listener of a `socks5://` outbound proxy's bridge (ADR-017). Optional:
   * an upstream without such resources leaves it out. Idempotent and never
   * throws. The registry calls it when a runtime CRUD write replaces or
   * removes the instance (ADR-014) and, in config order, on every instance
   * at shutdown (`UpstreamRegistry.dispose()`, driven by the entry point's
   * `stop()` before the listener closes) — a `socks5://` upstream's bridge
   * listener ends with the gateway, taking its in-flight proxied streams
   * with it; the replacement of a runtime swap already receives new
   * requests.
   */
  dispose?(): void;
}

/**
 * Constructor of one upstream implementation, selected by the config entry's
 * `type`. The `type` → factory map is injected by the entry point (the only
 * place concrete upstream classes are named — specs/architecture/layers.md,
 * invariant 2); the registry performs the dispatch.
 */
export type UpstreamFactory = (entry: UpstreamConfig, logger: pino.Logger) => Upstream;
