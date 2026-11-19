/**
 * Alias-table routing (specs/domains/routing.md, ADR-009): a client model id
 * is a configured **alias**. The
 * gateway resolves the alias against the config's `models` array, and the
 * entry's route — balance- and health-selected by the route balancer
 * (specs/domains/load-balancing.md) — names the upstream (through the
 * registry) and the provider-native model id passed upstream in `body.model`.
 *
 * Resolution is exact (no fuzzy alias matching — "gpt" never matches
 * "gpt-4o"; specs/architecture/data-flow.md anti-patterns) and synchronous:
 * the table is built once at startup from the validated config, upstream
 * instances are captured at build time, and a request only advances the
 * balancer's per-alias rotation pointer, health state, and session-affinity
 * bindings (ADR-010). An unregistered
 * alias resolves to no routes — the HTTP layer answers `404
 * model_not_found`; ACL enforcement (who may address which alias) is
 * `clientMayUse`, consumed by the dispatch handlers.
 *
 * Upstreams are referenced exclusively through the interface
 * (specs/architecture/layers.md invariant 4); the registry type is imported
 * type-only.
 */
import type { ModelConfig, ModelRouteConfig } from "../config/schema.ts";
import type { UpstreamRegistry } from "../upstreams/registry.ts";
import { createRouteBalancer, type RouteBalancerOptions, type RouteSelection } from "./balancer.ts";

export type { RouteSelection, RouteBalancerOptions };

/**
 * The Hono Env binding of the HTTP layer (ADR-002: Hono edge-only handlers).
 * Dispatch handlers publish the resolved upstream id here so the app's
 * request-log middleware can include it in the per-request log line without
 * parsing request bodies itself; the client auth gate (ADR-008) publishes the
 * authenticated client here so the handlers can enforce the per-client alias
 * ACL. Lives in the gateway core — not in `src/httpapi/app.ts` — so the
 * import graph stays acyclic: the HTTP layer imports the gateway core, never
 * the reverse.
 */
export interface GatewayEnv {
  Variables: {
    /** Upstream id resolved for this request; unset when routing failed before dispatch. */
    upstreamId?: string;
    /**
     * The authenticated client (ADR-008): set by the client Bearer gate on a
     * match; unset whenever no `clients` block is configured — then no ACL
     * applies and every configured alias is addressable.
     */
    client?: GatewayClient;
  };
}

/** The authenticated client identity the dispatch handlers see. */
export interface GatewayClient {
  /** Client entry name (verbatim from the config). */
  name: string;
  /** The aliases this client may address (`clients[].models` from the config). */
  allowedModels: readonly string[];
}

/** The startup-built alias table the HTTP layer resolves against. */
export interface RoutingTable {
  /** Every configured alias, in config order (`GET /llm/v1/models` order). */
  aliases(): readonly string[];
  /**
   * The alias's usable routes in config order — null when the alias is not
   * configured or none of its routes' upstreams exist in the registry (the
   * config loader rejects broken cross-references at startup, so the second
   * case is defensive only). Pure existence lookup: reads no state — the
   * 404 decision at the HTTP layer.
   */
  routes(alias: string): readonly ModelRouteConfig[] | null;
  /**
   * Balance- and health-aware route selection (specs/domains/load-balancing.md):
   * with `affinityKey` (session affinity, ADR-010) the bound route wins when
   * eligible; otherwise the next route the alias may be served by, skipping
   * `tried` route ids (this request already failed there) and
   * health-excluded routes. Null → nothing eligible — the dispatch answers
   * `503`.
   */
  select(alias: string, tried?: ReadonlySet<string>, affinityKey?: string): RouteSelection | null;
  /** Record one attempt's outcome against the selected route's health (and, with a key, the affinity map). */
  report(selection: RouteSelection, ok: boolean, affinityKey?: string): void;
}

/**
 * Build the alias table from the validated config's `models` array and the
 * upstream registry. Route selection and health live in the route balancer
 * (specs/domains/load-balancing.md) this table wraps: `round-robin` rotates
 * the routes in config order; `"weighted-round-robin"` rotates a schedule
 * where each route appears `weight` times (default 1) — proportional over
 * every full cycle, deterministic within it.
 */
export function createRoutingTable(
  models: readonly ModelConfig[],
  registry: UpstreamRegistry,
  options: RouteBalancerOptions = {},
): RoutingTable {
  const balancer = createRouteBalancer(models, registry, options);

  return {
    aliases: () => models.filter((entry) => balancer.routesOf(entry.alias) !== null).map((entry) => entry.alias),

    routes: (alias: string) => balancer.routesOf(alias),

    select: (alias: string, tried?: ReadonlySet<string>, affinityKey?: string) => balancer.select(alias, tried, affinityKey),

    report: (selection: RouteSelection, ok: boolean, affinityKey?: string) => balancer.report(selection, ok, affinityKey),
  };
}

/**
 * The rebuildable alias table: one stable `RoutingTable` object the HTTP
 * layer's handlers capture at mount time, delegating every call to the
 * *current* build — so the management CRUD's model mutations can swap the
 * build without re-mounting anything.
 *
 * `rebuild()` constructs a fresh table over the given models block and
 * replaces the internal reference in one assignment (Bun's single-threaded
 * event loop makes the swap atomic; no request observes a half-built table).
 * A request already in flight keeps the selection it made and completes
 * against the build that served it — only requests starting after the swap
 * resolve against the new table. Health state starts fresh per rebuild:
 * the ADR-014 hot-apply swapped the upstream instances underneath, so the
 * old health bookkeeping describes routes of a prior configuration.
 */
export interface RebuildableRoutingTable {
  /**
   * The stable table object: hand it to the `/llm/v1` handlers exactly like
   * a `createRoutingTable` build. Every method reads the current build at
   * call time, so a rebuild is visible to the next request without a
   * restart.
   */
  readonly table: RoutingTable;
  /** The models block the current build was made over (the store's snapshot at last rebuild). */
  readonly models: readonly ModelConfig[];
  /**
   * Build a fresh routing table over `models` (same registry, same balancer
   * options) and atomically make it the target of `table`. The models block
   * handed in is the store's freshly persisted, normalized snapshot.
   */
  rebuild(models: readonly ModelConfig[]): void;
}

/**
 * Create the rebuildable alias table over the validated `models` block and
 * the upstream registry. Runtime models CRUD (ADR-014) calls `rebuild()`
 * after each applied mutation; with the CRUD never mounted (no config
 * store wired) the delegating object simply serves its single startup build.
 */
export function createRebuildableRoutingTable(
  models: readonly ModelConfig[],
  registry: UpstreamRegistry,
  options: RouteBalancerOptions = {},
): RebuildableRoutingTable {
  let currentModels = models;
  let current = createRoutingTable(currentModels, registry, options);
  return {
    table: {
      aliases: () => current.aliases(),
      routes: (alias: string) => current.routes(alias),
      select: (alias: string, tried?: ReadonlySet<string>, affinityKey?: string) =>
        current.select(alias, tried, affinityKey),
      report: (selection: RouteSelection, ok: boolean, affinityKey?: string) =>
        current.report(selection, ok, affinityKey),
    },
    get models() {
      return currentModels;
    },
    rebuild(nextModels: readonly ModelConfig[]): void {
      currentModels = nextModels;
      current = createRoutingTable(nextModels, registry, options);
    },
  };
}

/**
 * The per-client alias ACL (ADR-009): an authenticated client may address an
 * alias only when it is listed in that client's `models`. An undefined client
 * means no `clients` block is configured — the surface is then unauthenticated
 * (no gate mounted, ADR-008) and every configured alias is addressable.
 */
export function clientMayUse(client: GatewayClient | undefined, alias: string): boolean {
  return client === undefined || client.allowedModels.includes(alias);
}

/**
 * Type-only re-export: the HTTP layer's wiring surface. `src/httpapi/app.ts`
 * may not import the upstream registry (specs/architecture/layers.md
 * invariant 3 — it imports the gateway core only), so the registry type
 * reaches `createApp` through this module. Type-only: no runtime coupling,
 * mirroring the upstream.ts → config/schema.ts pattern.
 */
export type { UpstreamRegistry };
