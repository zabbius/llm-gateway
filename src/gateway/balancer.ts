/**
 * The route balancer (specs/domains/load-balancing.md): per-alias route
 * selection with health tracking, consumed by the alias routing table
 * (specs/domains/routing.md, ADR-009) and the completions dispatch handlers.
 *
 * Selection: the entry's `balance.strategy` expands its routes into a
 * rotation schedule — `"round-robin"` keeps config order (one slot per
 * route); `"weighted-round-robin"` repeats each route `weight` times
 * (default 1) so a full cycle is proportional to the weights and
 * deterministic within it. Selection scans forward from the schedule's
 * rotation pointer and skips slots that are already tried in the current
 * request or excluded by the route's health state; the picked slot becomes
 * the new pointer. Nothing eligible → null — the dispatch answers `503`.
 *
 * Health (in-memory, per route = per `(alias, upstream, model)` triple): a
 * pre-first-byte failure — the upstream's synthesized 502/504 envelopes, a
 * relayed 5xx, or a relayed 429, i.e. `status >= 500 || status === 429` —
 * counts as a route failure; any other relayed response counts as success
 * (a client-caused 4xx is not the route's fault, and a 200/SSE response
 * means streaming started — there is no failover past the first byte). N
 * consecutive failures open the route for a cooldown; after the cooldown a
 * single half-open probe decides recovery (success closes it again, failure
 * re-opens it). While a half-open probe is in flight the route takes no
 * further attempts. The thresholds are module constants — not configuration
 * — in the MVP; `now` is injected for deterministic tests.
 *
 * Session affinity (ADR-010, specs/domains/load-balancing.md): requests that
 * carry an affinity key — the `X-Session-Id` header, else the OpenAI `user`
 * field, extracted by the dispatch handler — stick to one route. A
 * key→route binding lives in a memory-only LRU map bounded at
 * `AFFINITY_MAX_ENTRIES` entries and dies with the process. A keyed `select`
 * prefers the bound route when it is eligible (healthy, untried) and falls
 * back to the strategy schedule otherwise; every success re-binds the key,
 * and a pre-first-byte failure on the bound route releases the binding — so
 * a keyed request migrates with failover and re-binds wherever it lands.
 * Without a key, selection is the pure strategy choice.
 *
 * Dependencies point downward only (specs/architecture/layers.md): config
 * vocabulary type-only, upstreams exclusively through the interface and the
 * registry; a concrete upstream class never appears here.
 */
import type pino from "pino";
import type { ModelConfig, ModelRouteConfig } from "../config/schema.ts";
import type { Upstream } from "../upstreams/upstream.ts";
import type { UpstreamRegistry } from "../upstreams/registry.ts";

/**
 * Consecutive pre-first-byte failures that open a route for the cooldown.
 * A module constant, not a config key: health tuning is not surface grammar
 * (specs/domains/load-balancing.md, Configuration).
 */
export const ROUTE_FAILURE_THRESHOLD = 3;

/** How long a route stays skipped after opening (ms); a module constant, same rationale. */
export const ROUTE_COOLDOWN_MS = 30_000;

/**
 * Live session→route bindings the affinity map holds at most (ADR-010) —
 * across all aliases, least-recently-used evicted first, so client-supplied
 * keys (`X-Session-Id`, `user`) cannot grow it without bound. A module
 * constant, same rationale as the health thresholds.
 */
export const AFFINITY_MAX_ENTRIES = 10_000;

/** Injectable knobs — tests pin `now`, the threshold, the cooldown, and the affinity bound. */
export interface RouteBalancerOptions {
  /** Transition lines (route opened / recovered) are logged here when given. */
  logger?: pino.Logger;
  /** Wall clock; defaults to Date.now. */
  now?: () => number;
  /** Consecutive failures that open a route; defaults to ROUTE_FAILURE_THRESHOLD. */
  failureThreshold?: number;
  /** Open-route cooldown in ms; defaults to ROUTE_COOLDOWN_MS. */
  cooldownMs?: number;
  /** LRU bound on session→route bindings; defaults to AFFINITY_MAX_ENTRIES. */
  affinityMaxEntries?: number;
}

/** One balance- and health-aware pick the dispatch handler forwards to. */
export interface RouteSelection {
  /**
   * Stable route identity (`alias|upstream|model`): the key the dispatch
   * handler tracks its per-request attempts by and the balancer keys health
   * with — a route is scoped to its alias entry.
   */
  readonly routeId: string;
  /** Registry hit for the route's upstream. */
  readonly upstream: Upstream;
  /** The route's provider-native model id — what upstream receives in `body.model`. */
  readonly upstreamModel: string;
}

/** The selection + health surface the routing table exposes to dispatch. */
export interface RouteBalancer {
  /**
   * The alias's usable routes in config order — null when the alias is not
   * configured or none of its routes' upstreams exist in the registry (the
   * config loader rejects broken cross-references at startup, so the second
   * case is defensive only). Pure: reads no state.
   */
  routesOf(alias: string): readonly ModelRouteConfig[] | null;
  /**
   * Pick the next eligible route: a live affinity binding for `affinityKey`
   * (session affinity, ADR-010) wins when the bound route is eligible — not
   * tried in this request, healthy per the state machine; otherwise, and
   * whenever no key is given, the scan runs forward from the rotation
   * pointer, skipping slots whose routeId is in `tried` (this request
   * already failed there) or whose health excludes them (open cooldown,
   * half-open probe in flight). The pointer advances to the picked slot —
   * an affinity pick is an actual selection like any other. Null → nothing
   * eligible; the pointer stays untouched and the dispatch answers `503`.
   */
  select(alias: string, tried?: ReadonlySet<string>, affinityKey?: string): RouteSelection | null;
  /**
   * Record one attempt's outcome — the only state-mutating call. With
   * `affinityKey`: a success binds the key to the selection's route (re-bound
   * on every success, LRU-refreshed); a pre-first-byte failure releases the
   * binding when it names the failed route, so the key migrates with
   * failover and re-binds wherever the request lands.
   */
  report(selection: RouteSelection, ok: boolean, affinityKey?: string): void;
}

/**
 * The failure classification (specs/domains/load-balancing.md): a response
 * that proves the route failed before its first byte — synthesized
 * 502/504/502-TLS envelopes, a relayed 5xx, or a relayed 429 — fails the
 * route; everything else (including 4xx like 400/404, and 200/SSE) counts
 * the attempt as healthy and is relayed to the client unchanged.
 */
export function isPreFirstByteFailure(response: Response): boolean {
  return response.status >= 500 || response.status === 429;
}

interface ScheduleSlot {
  readonly route: ModelRouteConfig;
  readonly routeId: string;
}

/** Per-alias rotation state: the strategy-expanded schedule plus the pointer. */
interface Schedule {
  readonly slots: readonly ScheduleSlot[];
  /** Index of the next slot the scan starts at. */
  next: number;
}

/** Per-route health state (in-memory, process lifetime). */
interface RouteHealth {
  /** Consecutive pre-first-byte failures; any success resets to 0. */
  failures: number;
  /** Epoch ms until which the route stays open (0 = closed). */
  openUntil: number;
  /** True while the single half-open probe is in flight. */
  probeInFlight: boolean;
}

/** Log fields for a route's transition lines. */
interface RouteFacts {
  alias: string;
  upstreamId: string;
  model: string;
}

/**
 * Build the balancer over the validated `models` block and the upstream
 * registry. Routes whose upstream is missing from the registry are dropped
 * at build time — unreachable through normal startup (the config loader
 * fails on broken cross-references) but fail-closed if a balancer is ever
 * built by hand. An entry left without usable routes contributes nothing:
 * `routesOf` answers null and the dispatch handler treats the alias as
 * unconfigured (404).
 */
export function createRouteBalancer(
  models: readonly ModelConfig[],
  registry: UpstreamRegistry,
  options: RouteBalancerOptions = {},
): RouteBalancer {
  const now = options.now ?? Date.now;
  const threshold = options.failureThreshold ?? ROUTE_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? ROUTE_COOLDOWN_MS;
  const affinityLimit = options.affinityMaxEntries ?? AFFINITY_MAX_ENTRIES;
  const log = options.logger;

  const schedules = new Map<string, Schedule>();
  const health = new Map<string, RouteHealth>();
  const facts = new Map<string, RouteFacts>();

  /**
   * Session affinity (ADR-010): composite key `alias + "\n" + sessionKey` →
   * routeId, LRU-ordered (Map insertion order; delete+set refreshes recency).
   * The alias grammar (`^[^\s/]+$`, `src/config/schema.ts`) excludes
   * whitespace, so the separator makes the composite injective on
   * (alias, key). Memory-only: dies with the process.
   */
  const affinity = new Map<string, string>();

  /** Bind (or re-bind) key → routeId, evicting the least-recently-used entries past the bound. */
  function bindAffinity(alias: string, key: string, routeId: string): void {
    const composite = `${alias}\n${key}`;
    affinity.delete(composite); // re-binding an existing key refreshes its recency
    while (affinity.size >= affinityLimit) {
      const oldest = affinity.keys().next();
      if (oldest.done) break; // defensive: the map cannot be empty past a positive bound
      affinity.delete(oldest.value);
    }
    affinity.set(composite, routeId);
  }

  /** A usable affinity key: present and non-empty (an empty key is no key). */
  function keyIsUsable(key: string | undefined): key is string {
    return key !== undefined && key.length > 0;
  }

  for (const entry of models) {
    const usable = entry.routes.filter((route) => registry.find(route.upstream) !== undefined);
    const expanded =
      entry.balance.strategy === "weighted-round-robin"
        ? usable.flatMap((route) => Array.from({ length: route.weight ?? 1 }, () => route))
        : usable;
    if (expanded.length === 0) continue;
    schedules.set(
      entry.alias,
      {
        slots: expanded.map((route) => {
          const routeId = `${entry.alias}|${route.upstream}|${route.model}`;
          facts.set(routeId, { alias: entry.alias, upstreamId: route.upstream, model: route.model });
          return { route, routeId };
        }),
        next: 0,
      },
    );
  }

  function healthOf(routeId: string): RouteHealth {
    let state = health.get(routeId);
    if (state === undefined) {
      state = { failures: 0, openUntil: 0, probeInFlight: false };
      health.set(routeId, state);
    }
    return state;
  }

  /** True when the route may take an attempt at time `at`. */
  function eligible(state: RouteHealth | undefined, at: number): boolean {
    if (state === undefined) return true;
    if (state.openUntil > at) return false; // open — cooling down
    if (state.probeInFlight) return false; // half-open occupied by the single probe
    return true;
  }

  return {
    routesOf(alias: string): readonly ModelRouteConfig[] | null {
      const schedule = schedules.get(alias);
      if (schedule === undefined) return null;
      // Collapse the weight expansion back to the usable config-order list.
      const seen = new Set<string>();
      const routes: ModelRouteConfig[] = [];
      for (const slot of schedule.slots) {
        if (seen.has(slot.routeId)) continue;
        seen.add(slot.routeId);
        routes.push(slot.route);
      }
      return routes;
    },

    select(alias: string, tried: ReadonlySet<string> = new Set<string>(), affinityKey?: string): RouteSelection | null {
      const schedule = schedules.get(alias);
      if (schedule === undefined) return null;
      const at = now();
      const count = schedule.slots.length;

      // Session affinity (ADR-010): a live binding naming an eligible slot
      // wins before the strategy scan. An ineligible bound route (tried here,
      // open, half-open-occupied) falls through to the scan without dropping
      // the binding — only a failure of the bound route itself releases it.
      if (keyIsUsable(affinityKey) && affinityLimit > 0) {
        const composite = `${alias}\n${affinityKey}`;
        const boundRouteId = affinity.get(composite);
        if (boundRouteId !== undefined) {
          const index = schedule.slots.findIndex((slot) => slot.routeId === boundRouteId);
          if (index >= 0) {
            const slot = schedule.slots[index] as ScheduleSlot;
            const state = health.get(slot.routeId);
            const upstream = registry.find(slot.route.upstream);
            if (!tried.has(slot.routeId) && eligible(state, at) && upstream !== undefined) {
              affinity.delete(composite);
              affinity.set(composite, boundRouteId); // a served hit refreshes LRU recency
              schedule.next = (index + 1) % count;
              if (state !== undefined && state.openUntil > 0 && state.openUntil <= at) {
                // Cooldown expired: this affinity pick is the half-open single probe.
                state.probeInFlight = true;
              }
              return { routeId: slot.routeId, upstream, upstreamModel: slot.route.model };
            }
          }
        }
      }

      for (let step = 0; step < count; step++) {
        const index = (schedule.next + step) % count;
        const slot = schedule.slots[index] as ScheduleSlot;
        if (tried.has(slot.routeId)) continue;
        const state = health.get(slot.routeId);
        if (!eligible(state, at)) continue;
        const upstream = registry.find(slot.route.upstream);
        if (upstream === undefined) continue; // defensive: the schedule only holds registry-filtered routes
        schedule.next = (index + 1) % count;
        if (state !== undefined && state.openUntil > 0 && state.openUntil <= at) {
          // Cooldown expired: this attempt is the half-open single probe.
          state.probeInFlight = true;
        }
        return { routeId: slot.routeId, upstream, upstreamModel: slot.route.model };
      }
      return null;
    },

    report(selection: RouteSelection, ok: boolean, affinityKey?: string): void {
      // Session affinity bookkeeping (ADR-010): the alias comes from the
      // balancer's own route facts (never parsed out of the routeId — aliases
      // may contain any non-whitespace character). Bind on success; on
      // failure release only a binding that names the failed route, so a
      // schedule-scanned attempt does not evict a stale-but-unfailed binding.
      const boundAlias = facts.get(selection.routeId)?.alias;
      if (keyIsUsable(affinityKey) && affinityLimit > 0 && boundAlias !== undefined) {
        const composite = `${boundAlias}\n${affinityKey}`;
        if (ok) {
          bindAffinity(boundAlias, affinityKey, selection.routeId);
        } else if (affinity.get(composite) === selection.routeId) {
          affinity.delete(composite);
        }
      }

      const state = healthOf(selection.routeId);
      if (ok) {
        const wasOpen = state.openUntil > 0;
        state.failures = 0;
        state.openUntil = 0;
        state.probeInFlight = false;
        if (wasOpen) {
          log?.info({ ...facts.get(selection.routeId) }, "route recovered — half-open probe succeeded, route closed");
        }
        return;
      }
      state.failures += 1;
      state.probeInFlight = false;
      const at = now();
      const wasOpen = state.openUntil > at;
      if (state.failures >= threshold) {
        state.openUntil = at + cooldownMs;
        if (!wasOpen) {
          log?.warn(
            { ...facts.get(selection.routeId), failures: state.failures, cooldownMs },
            "route marked unhealthy — cooldown started, selection skips it",
          );
        }
      }
    },
  };
}
