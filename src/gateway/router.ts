/**
 * Model-id prefix routing (specs/domains/routing.md, ADR-002): a client model
 * id `"{adapterId}/{model}"` selects the adapter; the remainder — split on
 * the FIRST "/" — is the provider-native model id passed upstream in
 * `body.model`.
 *
 * Resolution is exact (no fuzzy prefix matching — "acme2" never matches
 * "acme"; specs/architecture/data-flow.md anti-patterns) and pure: it either
 * finds a registered adapter or returns null, leaving the 404 decision to the
 * HTTP layer. Adapters are referenced exclusively through the interface
 * (specs/architecture/layers.md invariant 4); the registry type is imported
 * type-only.
 */
import type { Adapter } from "../adapters/adapter.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";

/**
 * The Hono Env binding of the HTTP layer (ADR-003: Hono edge-only handlers).
 * Dispatch handlers publish the resolved adapter id here so the app's
 * request-log middleware can include it in the per-request log line without
 * parsing request bodies itself. Lives in the gateway core — not in
 * `src/httpapi/app.ts` — so the import graph stays acyclic: the HTTP layer
 * imports the gateway core, never the reverse.
 */
export interface GatewayEnv {
  Variables: {
    /** Adapter id resolved for this request; unset when routing failed before dispatch. */
    adapterId?: string;
  };
}

/** One successful prefix resolution. */
export interface RouteResolution {
  /** Registry hit for the prefix (the segment before the first "/"). */
  adapter: Adapter;
  /** Prefix stripped — what upstream receives in `body.model`. */
  upstreamModel: string;
}

/**
 * Resolve `"{adapterId}/{model}"` against the registry. The first "/" is the
 * separator; both halves must be non-empty (leading "/", trailing "/" and
 * slash-less ids are unresolved); the prefix must be a registered adapter id
 * — exact match only. The upstream model may itself contain slashes
 * (provider-native names like "openai/gpt-4o-preview" style ids ride behind
 * the first separator).
 *
 * Returns null when the id does not resolve; the caller answers `404
 * model_not_found` (specs/contracts/client-gateway.md Error Propagation)
 * without any upstream contact.
 */
export function resolveModel(model: string, registry: AdapterRegistry): RouteResolution | null {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return null;
  }
  const adapterId = model.slice(0, separator);
  const upstreamModel = model.slice(separator + 1);
  const adapter = registry.find(adapterId);
  if (adapter === undefined) {
    return null;
  }
  return { adapter, upstreamModel };
}

/**
 * Type-only re-export: the HTTP layer's wiring surface. `src/httpapi/app.ts`
 * may not import the adapter registry (specs/architecture/layers.md
 * invariant 3 — it imports the gateway core only), so the registry type
 * reaches `createApp` through this module. Type-only: no runtime coupling,
 * mirroring the adapter.ts → config/schema.ts pattern.
 */
export type { AdapterRegistry };
