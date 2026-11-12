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

/**
 * The uniform upstream surface (specs/domains/upstreams/upstream-contract.md).
 * `connect()` runs exactly once per upstream at startup, before any
 * `forward()` / `listModels()` call; it never rejects — a failed probe is
 * logged (warning naming the entry's type and id) and startup continues.
 * `forward()` relays status, headers, and body as received and never
 * fabricates a success response.
 */
export interface Upstream {
  /** Config identity: unique routing namespace. */
  readonly id: string;
  /** Implementation discriminator; selects the constructor in the factory map. */
  readonly type: UpstreamType;

  /** Startup phase. Called once; probes the upstream. Never rejects. */
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
