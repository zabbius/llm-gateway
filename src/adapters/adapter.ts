/**
 * The adapter interface — the only adapter shape the gateway core and the
 * registry see (specs/domains/adapters/adapter-contract.md, invariant 6 of
 * specs/architecture/layers.md: this module imports shared types only and
 * both the core and every adapter depend on it).
 *
 * `AdapterConfig` / `AdapterType` are re-exported (type-only) from the config
 * schema: the configuration domain owns the config-file grammar — validation
 * and normalization live in exactly one place (`src/config/schema.ts`) — and
 * the adapter domain consumes that slice. No runtime dependency on the config
 * loader is created.
 */
import type pino from "pino";

export type { AdapterConfig, AdapterType } from "../config/schema.ts";
import type { AdapterConfig, AdapterType } from "../config/schema.ts";

/**
 * One upstream model entry, as an adapter reports it — ids are UNPREFIXED
 * provider-native ids; the `{adapterId}/` prefix and the `owned_by` rewrite
 * happen in the routing aggregation, not in adapters. Provider-native extra
 * fields ride along unchanged (open index signature).
 */
export interface ModelEntry {
  /** Provider-native model id; aggregation adds the "{adapterId}/" prefix. */
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
 * already de-prefixed `body.model`; the adapter attaches its own credentials
 * (the client's `Authorization` never reaches an adapter's outbound request).
 */
export interface ProxyRequest {
  /** Upstream path relative to baseUrl: "chat/completions", "completions", "models". */
  path: string;
  method: "GET" | "POST";
  /** Client body relayed as received — streamed, never buffered whole. */
  body?: ReadableStream<Uint8Array>;
  /** Relay headers (Content-Type, Accept, …); the adapter attaches its own credentials. */
  headers: Record<string, string>;
}

/**
 * The uniform adapter surface (specs/domains/adapters/adapter-contract.md).
 * `connect()` runs exactly once per adapter at startup, before any
 * `forward()` / `listModels()` call; it never rejects — a failed probe is
 * logged (warning naming the entry's type and id) and startup continues.
 * `forward()` relays status, headers, and body as received and never
 * fabricates a success response.
 */
export interface Adapter {
  /** Config identity: unique routing namespace. */
  readonly id: string;
  /** Implementation discriminator; selects the constructor in the factory map. */
  readonly type: AdapterType;

  /** Startup phase. Called once; probes the upstream. Never rejects. */
  connect(): Promise<void>;

  /** Provider-native model list; ids unprefixed — aggregation adds "{id}/". */
  listModels(): Promise<ModelEntry[]>;

  /** Pure pass-through of one OpenAI-protocol request (incl. SSE streams). */
  forward(request: ProxyRequest): Promise<Response>;
}

/**
 * Constructor of one adapter implementation, selected by the config entry's
 * `type`. The `type` → factory map is injected by the entry point (the only
 * place concrete adapter classes are named — specs/architecture/layers.md,
 * invariant 2); the registry performs the dispatch.
 */
export type AdapterFactory = (entry: AdapterConfig, logger: pino.Logger) => Adapter;
