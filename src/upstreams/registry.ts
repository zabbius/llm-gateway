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
 * `all()` hands out instances in config order for model aggregation, and
 * `status()` returns the retained startup-probe outcomes in config order
 * (the `GET /api/status` snapshot — specs/contracts/gateway-management.md).
 */
import type pino from "pino";
import type { Upstream, UpstreamConfig, UpstreamFactory, UpstreamStatus, UpstreamType } from "./upstream.ts";

/** The `type` → factory map, injected by the entry point (D1). */
export type UpstreamFactories = Readonly<Record<UpstreamType, UpstreamFactory>>;

export class UpstreamRegistry {
  /**
   * Build, connect, and register one upstream per config entry, in config
   * order. Probes run sequentially in that order; each outcome is awaited
   * and retained (`status()` — the health snapshot `GET /api/status` serves,
   * specs/contracts/gateway-management.md), so the registry is fully probed
   * (ok or logged) when `create` resolves — the listener starts only after
   * that (specs/architecture/data-flow.md).
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
    const statuses: UpstreamStatus[] = [];

    for (const entry of entries) {
      const child = logger.child({ component: `upstream:${entry.id}` });
      const upstream = factories[entry.type](entry, child);

      if (byId.has(entry.id)) {
        throw new Error(`duplicate upstream id "${entry.id}" — config validation should have rejected this`);
      }

      let status: UpstreamStatus;
      try {
        await upstream.connect();
        status = { id: entry.id, type: entry.type, probe: "ok" };
      } catch (error) {
        // A failed probe is data, not an error: the reason is the same
        // log-safe string this warning carries (no credential material —
        // upstream-contract.md); startup continues with the upstream marked
        // degraded (specs/architecture/data-flow.md).
        const reason = describe(error);
        child.warn(
          { type: entry.type, id: entry.id, reason },
          "startup probe failed — upstream degraded, startup continues",
        );
        status = { id: entry.id, type: entry.type, probe: "failed", reason };
      }

      byId.set(entry.id, upstream);
      inOrder.push(upstream);
      statuses.push(status);
    }

    return new UpstreamRegistry(byId, inOrder, statuses);
  }

  private constructor(
    private readonly byId: ReadonlyMap<string, Upstream>,
    private readonly inOrder: readonly Upstream[],
    private readonly statuses: readonly UpstreamStatus[],
  ) {}

  /** Exact upstream-id lookup (the router splits the prefix; ids never contain "/"). */
  find(id: string): Upstream | undefined {
    return this.byId.get(id);
  }

  /** Every upstream in config order — feeds the model aggregation. */
  all(): readonly Upstream[] {
    return this.inOrder;
  }

  /**
   * Every retained startup-probe outcome, in config order — the read-only
   * health snapshot the management surface serves (GET /api/status,
   * specs/contracts/gateway-management.md). Frozen at startup: it never
   * contacts an upstream and never changes after `create` resolved.
   */
  status(): readonly UpstreamStatus[] {
    return this.statuses;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
