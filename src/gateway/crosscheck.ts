/**
 * The startup route cross-check (specs/domains/routing.md "Startup route
 * inventory"): after the registry's startup probes resolve, every configured
 * route — a `models[]` entry's `{upstream, model}` pair — is compared against
 * the upstreams' retained startup catalogs (`UpstreamStatus.models`, folded
 * in by the registry at assembly). Pure and read-only: it consumes the frozen
 * config slice and the frozen registry statuses, produces a three-state
 * verdict per route, and never contacts an upstream.
 *
 * Verdicts:
 *  - "matched" — the route's upstream probed ok and its retained catalog
 *    lists the route's model;
 *  - "missing" — the route's upstream probed ok but its catalog does not
 *    list the model (the startup pipeline warns per route);
 *  - "unknown" — there is no catalog to compare against: the upstream's
 *    probe failed (the single upstream-level warning is already logged by
 *    the registry — no per-route duplication), or an ok upstream retained no
 *    snapshot, or the id is absent from the statuses (defensive — config
 *    validation rejects broken cross-references before startup).
 *
 * Layering (specs/architecture/layers.md): this module imports config types
 * and the upstream contract only — the entry point runs it at startup and
 * the management surface composes its verdicts into `GET /api/status`.
 */
import type { ModelConfig } from "../config/schema.ts";
import type { UpstreamStatus } from "../upstreams/upstream.ts";

/** The three-state health verdict of one configured route. */
export type RouteHealth = "matched" | "missing" | "unknown";

/** One configured route's cross-check verdict, in config order. */
export interface RouteHealthEntry {
  /** The alias entry the route belongs to (`models[].alias`). */
  readonly alias: string;
  /** The route's upstream id (`models[].routes[].upstream`). */
  readonly upstream: string;
  /** The route's provider-native model (`models[].routes[].model`). */
  readonly model: string;
  /** The verdict against the upstream's retained startup catalog. */
  readonly health: RouteHealth;
}

/**
 * Cross-check every configured route against the retained startup catalogs.
 * `aliases` is the validated `models` block (each entry: alias + routes);
 * `registryStatus` is `UpstreamRegistry.status()` — the frozen probe
 * outcomes, each carrying its catalog on an ok probe. The result lists one
 * entry per configured route, in config order, frozen like its inputs.
 */
export function crossCheckRoutes(
  aliases: readonly ModelConfig[],
  registryStatus: readonly UpstreamStatus[],
): readonly RouteHealthEntry[] {
  const statusById = new Map(registryStatus.map((status) => [status.id, status]));
  const entries: RouteHealthEntry[] = [];
  for (const entry of aliases) {
    for (const route of entry.routes) {
      const status = statusById.get(route.upstream);
      const catalog = status?.probe === "ok" ? status.models : undefined;
      const health: RouteHealth =
        catalog === undefined
          ? "unknown"
          : catalog.some((candidate) => candidate.id === route.model)
            ? "matched"
            : "missing";
      entries.push(Object.freeze({ alias: entry.alias, upstream: route.upstream, model: route.model, health }));
    }
  }
  return Object.freeze(entries);
}
