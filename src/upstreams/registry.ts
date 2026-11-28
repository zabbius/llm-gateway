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
 * After startup the registry is read-only from the request path's point of
 * view — but the management boundary's runtime CRUD (ADR-014 D2/D8) writes
 * it through exactly three operations: `add()` (a created config entry),
 * `replace()` (an updated one — a fresh instance under the same id) and
 * `remove()` (a deleted one). Each write constructs through the same
 * factory map, probes within the startup probe budget (a failed probe is
 * data — the mutation still lands), swaps the in-memory maps atomically
 * (one synchronous section on the single-threaded event loop) and refreshes
 * the retained statuses the `GET /api/status` snapshot serves. The alias
 * routing table resolves upstream instances through `find()` at selection
 * time, so a replaced or removed instance hot-applies to `/llm/v1` without
 * a routing-table rebuild or a listener restart. Each of those writes also
 * disposes the instance it retires, and teardown is the registry's one
 * read-side lifecycle call: `dispose()` releases every instance in config
 * order, driven by the entry point before it stops the listener
 * (specs/architecture/data-flow.md).
 *
 * `find()` matches upstream ids
 * exactly (never fuzzy — specs/architecture/data-flow.md anti-patterns),
 * `all()` hands out instances in config order for model aggregation, and
 * `status()` returns the retained probe outcomes in config order
 * (the `GET /api/status` snapshot — specs/contracts/gateway-management.md).
 */
import type pino from "pino";
import type { Upstream, UpstreamConfig, UpstreamFactory, UpstreamStatus, UpstreamType } from "./upstream.ts";

/** The `type` → factory map, injected by the entry point (D1). */
export type UpstreamFactories = Readonly<Record<UpstreamType, UpstreamFactory>>;

/**
 * The budget every runtime probe (add/replace) answers within — the upstream
 * domain's startup probe budget (`CONNECT_PROBE_TIMEOUT_MS`,
 * src/upstreams/openai-compatible.ts) restated here: `connect()` carries the
 * budget internally for the concrete upstream, and this race bounds the
 * registry's wait on top so a hung provider cannot stretch a management
 * request past it. Same restatement the HTTP layer's live facilities make.
 */
export const RUNTIME_PROBE_BUDGET_MS = 10_000;

/**
 * Build one upstream instance through the injected factory map — the shared
 * constructor every registry assembly path (startup `create()` and the
 * runtime `add()` / `replace()` writes) goes through, so the child-logger
 * naming convention (`component: "upstream:<id>"`) and the unknown-type
 * guard live in exactly one place. Concrete classes stay behind the map —
 * the registry never names one (specs/architecture/layers.md invariant 2).
 */
export function buildUpstream(
  entry: UpstreamConfig,
  factories: UpstreamFactories,
  logger: pino.Logger,
): Upstream {
  const factory = factories[entry.type];
  if (factory === undefined) {
    throw new Error(`no upstream factory registered for type "${entry.type}"`);
  }
  return factory(entry, logger.child({ component: `upstream:${entry.id}` }));
}

/**
 * One upstream's probe outcome, retained: runs `connect()` once within the
 * probe budget and folds the instance's own retained startup snapshot in
 * (consulting `status()` exactly once, right after `connect()` resolved —
 * the lifecycle guarantees connect ran before anything else). Never throws:
 * a failed or out-of-budget probe is data (`probe: "failed"` + log-safe
 * `reason`), the same fact the calling path retains and warns about. The
 * warning message names the phase — startup continues past a failed probe;
 * a runtime write lands regardless (the upstream is already persisted).
 */
async function probeUpstream(
  upstream: Upstream,
  logger: pino.Logger,
  timeoutMs: number,
  phase: "startup" | "runtime",
): Promise<UpstreamStatus> {
  let timedOut = false;
  let disarmBudget: (() => void) | undefined;
  const budget = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("probe budget expired"));
    }, timeoutMs);
    timer.unref();
    disarmBudget = () => clearTimeout(timer);
  });

  try {
    await Promise.race([upstream.connect(), budget]);
    disarmBudget?.();
    const models = upstream.status?.()?.models;
    return models === undefined
      ? { id: upstream.id, type: upstream.type, probe: "ok" }
      : { id: upstream.id, type: upstream.type, probe: "ok", models };
  } catch (error) {
    disarmBudget?.();
    const reason = timedOut
      ? `no answer within the probe budget (${timeoutMs}ms)`
      : error instanceof Error
        ? error.message
        : String(error);
    logger.warn(
      { type: upstream.type, id: upstream.id, reason },
      phase === "startup"
        ? "startup probe failed — upstream degraded, startup continues"
        : "probe failed — upstream degraded, the upstream stays registered",
    );
    return { id: upstream.id, type: upstream.type, probe: "failed", reason };
  }
}

export class UpstreamRegistry {
  /**
   * Build, connect, and register one upstream per config entry, in config
   * order. Probes run sequentially in that order; each outcome is awaited
   * and retained (`status()` — the health snapshot `GET /api/status` serves,
   * specs/contracts/gateway-management.md), so the registry is fully probed
   * (ok or logged) when `create` resolves — the listener starts only after
   * that (specs/architecture/data-flow.md).
   *
   * The factory map is retained: the management boundary's runtime writes
   * (`add` / `replace`) construct their instances through the same map, so
   * concrete upstream classes never leave the entry point's wiring.
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
    const registry = new UpstreamRegistry(byId, inOrder, statuses, factories, logger);

    for (const entry of entries) {
      if (byId.has(entry.id)) {
        throw new Error(`duplicate upstream id "${entry.id}" — config validation should have rejected this`);
      }
      const upstream = buildUpstream(entry, factories, logger);
      const status = await probeUpstream(upstream, logger.child({ component: `upstream:${entry.id}` }), RUNTIME_PROBE_BUDGET_MS, "startup");
      byId.set(entry.id, upstream);
      inOrder.push(upstream);
      statuses.push(Object.freeze(status));
    }

    return registry;
  }

  private constructor(
    private readonly byId: Map<string, Upstream>,
    private readonly inOrder: Upstream[],
    private readonly statuses: UpstreamStatus[],
    private readonly factories: UpstreamFactories,
    startupLogger: pino.Logger,
  ) {
    this.startupLogger = startupLogger;
  }

  /**
   * Runtime write (ADR-014 D8): construct the upstream for a just-created
   * config entry, probe it within the startup probe budget, and register it.
   * A failed probe is data — the mutation still lands (the retained status
   * carries `probe: "failed"` and its log-safe reason), exactly as a
   * config-file edit with a currently-down provider lands at startup. The
   * probe is awaited here (blocking, sequential — one write at a time on the
   * event loop), so the caller's answer carries the probe outcome.
   * Duplicate ids throw defensively — the management handler pre-checks
   * existence, so reaching this point with a duplicate is a wiring bug.
   */
  async add(entry: UpstreamConfig, timeoutMs: number = RUNTIME_PROBE_BUDGET_MS): Promise<UpstreamStatus> {
    if (this.byId.has(entry.id)) {
      throw new Error(`duplicate upstream id "${entry.id}" — the management handler must pre-check existence`);
    }
    const logger = this.loggerFor(entry.id);
    const upstream = buildUpstream(entry, this.factories, logger);
    const status = await probeUpstream(upstream, logger, timeoutMs, "runtime");
    this.byId.set(entry.id, upstream);
    this.inOrder.push(upstream);
    this.statuses.push(Object.freeze(status));
    return status;
  }

  /**
   * Runtime write (ADR-014 D2/D8): swap a fresh instance in under an
   * existing id — the updated config entry replaces the old instance and
   * its retained status in place (config order preserved). The next
   * selection resolves the new instance through `find()`, so the change
   * hot-applies to `/llm/v1` without a restart. Same probe-and-land
   * semantics as `add`. Unknown ids throw defensively — the handler
   * pre-checks existence (the 404 path).
   */
  async replace(id: string, entry: UpstreamConfig, timeoutMs: number = RUNTIME_PROBE_BUDGET_MS): Promise<UpstreamStatus> {
    const index = this.inOrder.findIndex((upstream) => upstream.id === id);
    if (index === -1) {
      throw new Error(`no upstream with id "${id}" — the management handler must pre-check existence`);
    }
    const logger = this.loggerFor(entry.id);
    const upstream = buildUpstream(entry, this.factories, logger);
    const status = await probeUpstream(upstream, logger, timeoutMs, "runtime");
    const replaced = this.byId.get(id);
    this.byId.set(id, upstream);
    this.inOrder[index] = upstream;
    this.statuses[index] = Object.freeze(status);
    // the old instance's own resources (a proxy bridge's listener, ADR-017) end with it
    replaced?.dispose?.();
    return status;
  }

  /**
   * Runtime write: drop an upstream instance and its retained status.
   * Routes whose schedules still name the id resolve to nothing through
   * `find()` and are skipped live by the balancer (defensive path) — the
   * routing-table rebuild over the new config remains the caller's follow-up
   * (the config store applies it). Unknown ids throw defensively, like
   * `replace`. Returns whether a row was removed.
   */
  remove(id: string): boolean {
    const index = this.inOrder.findIndex((upstream) => upstream.id === id);
    if (index === -1) {
      return false;
    }
    const removed = this.inOrder[index];
    this.byId.delete(id);
    this.inOrder.splice(index, 1);
    this.statuses.splice(index, 1);
    // the instance's own resources (a proxy bridge's listener, ADR-017) end with it
    removed?.dispose?.();
    return true;
  }

  /**
   * Teardown: call `dispose()` on every registered upstream, in config
   * order — the shutdown path the entry point drives before it stops the
   * listener (`GatewayHandles.stop()`, specs/architecture/data-flow.md), and
   * the same release a runtime `replace`/`remove` gives the instance it
   * retires. Upstreams without the hook are untouched; an implementation's
   * `dispose()` is idempotent and never throws (the interface contract), so
   * a repeated call is harmless. Nothing is unregistered — the id/order maps
   * keep their contents; only the instances' own resources (a `socks5://`
   * proxy's bridge listener, ADR-017) end here.
   */
  dispose(): void {
    for (const upstream of this.inOrder) {
      upstream.dispose?.();
    }
  }

  /** The per-upstream child logger — the startup naming convention. */
  private loggerFor(id: string): pino.Logger {
    return this.startupLogger.child({ component: `upstream:${id}` });
  }

  /** The root logger `create()` was given (retained for runtime writes' child loggers). */
  private readonly startupLogger: pino.Logger;

  /** Exact upstream-id lookup (the router splits the prefix; ids never contain "/"). */
  find(id: string): Upstream | undefined {
    return this.byId.get(id);
  }

  /** Every upstream in config order — feeds the model aggregation. */
  all(): readonly Upstream[] {
    return this.inOrder;
  }

  /**
   * Every retained probe outcome, in config order — the read-only
   * health snapshot the management surface serves (GET /api/status,
   * specs/contracts/gateway-management.md). Each outcome (and any retained
   * model catalog inside it) is frozen at assembly, the list handed out is
   * a frozen copy — runtime writes swap rows through `add`/`replace`/`remove`
   * without ever exposing a mutable internal — and nothing here ever
   * contacts an upstream.
   */
  status(): readonly UpstreamStatus[] {
    return Object.freeze([...this.statuses]);
  }
}
