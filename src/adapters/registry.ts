/**
 * The adapter registry — the adapter domain's aggregate root
 * (specs/domains/adapters/README.md).
 *
 * Constructed exactly once at startup: one adapter per config entry, built by
 * the factory selected through the injected `type` → factory map (the entry
 * point owns the map — the registry only dispatches on `type`). Every
 * instance's `connect()` probe runs here, before the gateway starts
 * listening; a failed probe is logged as a warning naming the entry's
 * `(type, id)` and never blocks startup (specs/architecture/data-flow.md).
 *
 * After startup the registry is read-only: `find()` matches adapter ids
 * exactly (never fuzzy — specs/architecture/data-flow.md anti-patterns),
 * `all()` hands out instances in config order for model aggregation.
 */
import type pino from "pino";
import type { Adapter, AdapterConfig, AdapterFactory, AdapterType } from "./adapter.ts";

/** The `type` → factory map, injected by the entry point (D1). */
export type AdapterFactories = Readonly<Record<AdapterType, AdapterFactory>>;

export class AdapterRegistry {
  /**
   * Build, connect, and register one adapter per config entry, in config
   * order. Probes run sequentially in that order; each outcome is awaited,
   * so the registry is fully probed (ok or logged) when `create` resolves —
   * the listener starts only after that (specs/architecture/data-flow.md).
   *
   * Duplicate ids are rejected defensively — the config loader already fails
   * startup on them, so reaching this point with a duplicate is a wiring bug.
   */
  static async create(
    entries: readonly AdapterConfig[],
    factories: AdapterFactories,
    logger: pino.Logger,
  ): Promise<AdapterRegistry> {
    const byId = new Map<string, Adapter>();
    const inOrder: Adapter[] = [];

    for (const entry of entries) {
      const child = logger.child({ component: `adapter:${entry.id}` });
      const adapter = factories[entry.type](entry, child);

      if (byId.has(entry.id)) {
        throw new Error(`duplicate adapter id "${entry.id}" — config validation should have rejected this`);
      }

      try {
        await adapter.connect();
      } catch (error) {
        // A well-behaved adapter never rejects (adapter-contract.md); this
        // catch keeps a misbehaving future implementation non-fatal too.
        child.warn(
          { type: entry.type, id: entry.id, reason: describe(error) },
          "startup probe failed — adapter degraded, startup continues",
        );
      }

      byId.set(entry.id, adapter);
      inOrder.push(adapter);
    }

    return new AdapterRegistry(byId, inOrder);
  }

  private constructor(
    private readonly byId: ReadonlyMap<string, Adapter>,
    private readonly inOrder: readonly Adapter[],
  ) {}

  /** Exact adapter-id lookup (the router splits the prefix; ids never contain "/"). */
  find(id: string): Adapter | undefined {
    return this.byId.get(id);
  }

  /** Every adapter in config order — feeds the model aggregation. */
  all(): readonly Adapter[] {
    return this.inOrder;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
