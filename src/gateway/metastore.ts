/**
 * The per-upstream model-metadata store (specs/domains/routing.md "Alias
 * metadata"): the raw, unprefixed `ModelEntry[]` listing each upstream
 * reported, kept so alias metadata can be built over the current slice.
 *
 * Lifecycle:
 *  - `seed()` runs once at startup over the registry's retained probe
 *    outcomes — an ok probe that retained a catalog seeds that catalog as
 *    the upstream's first snapshot (discovery at start); failed probes and
 *    ok probes without a retained catalog seed nothing.
 *  - `set()` replaces an upstream's snapshot wholesale — the whole
 *    success-or-nothing rule of on-demand discovery: a successful discovery
 *    hands over the fresh listing and the store swaps it in atomically; a
 *    failed one (signalled by `undefined`) never touches the store, so a
 *    broken re-discovery cannot degrade the last good snapshot
 *    (retain-last-good).
 *
 * Concurrency: the gateway runs on a single-threaded event loop and every
 * method is synchronous — a snapshot swap is one `Map.set`, atomic by
 * construction. Snapshots are copied and frozen on ingest, so handing the
 * slice out through `entries()` cannot leak mutability back into the store.
 *
 * Layering (specs/architecture/layers.md): this module imports the upstream
 * contract types only; the entry point seeds it at startup and the alias
 * metadata builder consumes it.
 */
import type { ModelEntry, UpstreamStatus } from "../upstreams/upstream.ts";

/** One upstream's raw model listing, exactly as the provider reported it. */
export type ModelSnapshot = readonly ModelEntry[];

export class MetadataStore {
  private readonly snapshots = new Map<string, ModelSnapshot>();

  /**
   * Discovery at start: fold every ok startup probe's retained catalog in as
   * that upstream's initial snapshot. Failed probes — and ok probes whose
   * upstream retains no catalog — contribute nothing. Idempotent over the
   * frozen `registry.status()` list the registry hands out.
   */
  seed(registryStatus: readonly UpstreamStatus[]): void {
    for (const status of registryStatus) {
      if (status.probe !== "ok" || status.models === undefined) {
        continue;
      }
      this.set(status.id, status.models);
    }
  }

  /**
   * Wholesale replacement of one upstream's snapshot — the outcome of one
   * discovery attempt. A successful discovery (`entries` is a listing, empty
   * included — "provider lists zero models" is a fact, not a failure) swaps
   * the snapshot in and returns true; a failed discovery (`entries` is
   * `undefined`) mutates nothing and returns false, leaving the last good
   * snapshot serving (retain-last-good). Returns whether the store changed.
   */
  set(upstreamId: string, entries: readonly ModelEntry[] | undefined): boolean {
    if (entries === undefined) {
      return false;
    }
    this.snapshots.set(upstreamId, Object.freeze([...entries].map((entry) => Object.freeze(entry))));
    return true;
  }

  /**
   * Drop one upstream's slice entirely — the runtime CRUD's counterpart to
   * `seed()`: a deleted upstream's metadata must not keep serving alias
   * metadata (its slice names a provider that no longer exists), and an
   * updated upstream whose fresh probe retained no catalog has nothing
   * truthful to serve for the new instance (ADR-014 D2/D8 — the write
   * replaced the instance the old snapshot described). Idempotent: clearing
   * an unknown id is a no-op.
   */
  clear(upstreamId: string): void {
    this.snapshots.delete(upstreamId);
  }

  /**
   * The current slice for one upstream — the frozen snapshot its last
   * successful discovery produced, or `[]` when nothing is known (no seed,
   * no successful discovery yet). Never mutates the store.
   */
  entries(upstreamId: string): ModelSnapshot {
    return this.snapshots.get(upstreamId) ?? [];
  }
}
