/**
 * The upstream registry — the upstream domain's aggregate root
 * (specs/domains/upstreams/README.md).
 *
 * Constructed exactly once at startup: one upstream per config entry, built by
 * the factory selected through the injected `type` → factory map (the entry
 * point owns the map — the registry only dispatches on `type`). Every
 * instance's `connect()` probe runs here, before the gateway starts
 * listening; a failed probe is logged as a warning naming the entry's
 * `(type, id)` and never blocks startup (specs/architecture/data-flow.md).
 *
 * After startup the registry is read-only: `find()` matches upstream ids
 * exactly (never fuzzy — specs/architecture/data-flow.md anti-patterns),
 * `all()` hands out instances in config order for model aggregation.
 */
import type pino from "pino";
import type { Upstream, UpstreamConfig, UpstreamFactory, UpstreamType } from "./upstream.ts";

/** The `type` → factory map, injected by the entry point (D1). */
export type UpstreamFactories = Readonly<Record<UpstreamType, UpstreamFactory>>;

export class UpstreamRegistry {
  /**
   * Build, connect, and register one upstream per config entry, in config
   * order. Probes run sequentially in that order; each outcome is awaited,
   * so the registry is fully probed (ok or logged) when `create` resolves —
   * the listener starts only after that (specs/architecture/data-flow.md).
   *
   * Duplicate ids are rejected defensively — the config loader already fails
   * startup on them, so reaching this point with a duplicate is a wiring bug.
   */
  static async create(
    entries: readonly UpstreamConfig[],
    factories: UpstreamFactories,
    logger: pino.Logger,
  ): Promise<UpstreamRegistry> {
    const byId = new Map<string, Upstream>();
    const inOrder: Upstream[] = [];

    for (const entry of entries) {
      const child = logger.child({ component: `upstream:${entry.id}` });
      const upstream = factories[entry.type](entry, child);

      if (byId.has(entry.id)) {
        throw new Error(`duplicate upstream id "${entry.id}" — config validation should have rejected this`);
      }

      try {
        await upstream.connect();
      } catch (error) {
        // A well-behaved upstream never rejects (upstream-contract.md); this
        // catch keeps a misbehaving future implementation non-fatal too.
        child.warn(
          { type: entry.type, id: entry.id, reason: describe(error) },
          "startup probe failed — upstream degraded, startup continues",
        );
      }

      byId.set(entry.id, upstream);
      inOrder.push(upstream);
    }

    return new UpstreamRegistry(byId, inOrder);
  }

  private constructor(
    private readonly byId: ReadonlyMap<string, Upstream>,
    private readonly inOrder: readonly Upstream[],
  ) {}

  /** Exact upstream-id lookup (the router splits the prefix; ids never contain "/"). */
  find(id: string): Upstream | undefined {
    return this.byId.get(id);
  }

  /** Every upstream in config order — feeds the model aggregation. */
  all(): readonly Upstream[] {
    return this.inOrder;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
