/**
 * The alias metadata builder (specs/domains/routing.md "Alias metadata"):
 * folds the metadata store's per-upstream snapshots and the config's manual
 * `limits` into one client-facing `AliasMetadata` per configured alias.
 *
 * Pure and read-only: it consumes the validated `models` block and the
 * store's current slice, runs the first-wins detector chain
 * (`src/gateway/modelmetadata.ts`) on each route's raw listing entry, and
 * freezes its output. It contacts no upstream and never mutates the store.
 *
 * Aggregation rules per alias, over its configured routes:
 *  - Each route contributes what `detectModelMetadata` finds in its upstream
 *    snapshot entry (matched by provider-native model id); a route with no
 *    entry — no snapshot, no matching id, or an undetectable shape —
 *    contributes nothing.
 *  - `contextWindow` / `outputLimit` are the element-wise minimum over the
 *    routes that declared the dimension, then the minimum with the entry's
 *    manual `limits` value when one is configured: the alias can land on any
 *    route, so its budget is the smallest budget any route can serve.
 *  - `capabilities` is the strict AND: a flag is true only when every route
 *    declared it true — one route without a full declaration (or without any
 *    metadata) leaves the alias's capabilities undeclared, because the alias
 *    might be served by that route. When every route does fully declare, the
 *    AND is authoritative and false flags are emitted as false.
 *  - An alias with not a single known dimension gets no entry at all —
 *    absent means unknown, never a fabricated zero/false.
 */
import type { ModelConfig } from "../config/schema.ts";
import {
  detectModelMetadata,
  type ModelCapabilities,
  type ModelMetadata,
} from "./modelmetadata.ts";
import type { MetadataStore, ModelSnapshot } from "./metastore.ts";

/** One alias's client-facing metadata; an absent field is unknown, not zero. */
export interface AliasMetadata {
  /** The smallest context window any of the alias's routes can serve. */
  contextWindow?: number;
  /** The smallest output limit any of the alias's routes can serve. */
  outputLimit?: number;
  /** Declared only when every route fully declared its own capabilities. */
  capabilities?: ModelCapabilities;
}

/**
 * Builds the alias → metadata table over the store's current snapshots.
 * Returns a frozen Map: entries and their capabilities objects are frozen,
 * and the map's mutators are shadowed before the map itself is frozen, so
 * `set`/`delete`/`clear` fail loudly instead of corrupting the table.
 */
export function buildAliasMetadata(
  models: readonly ModelConfig[],
  store: MetadataStore,
): ReadonlyMap<string, AliasMetadata> {
  const rows: [string, AliasMetadata][] = [];
  for (const entry of models) {
    const metadata = aggregateEntry(entry, store);
    if (metadata !== undefined) {
      rows.push([entry.alias, metadata]);
    }
  }
  return frozenMap(rows);
}

/** The route's entry in its upstream's current snapshot, by provider-native id. */
function routeEntry(store: MetadataStore, upstream: string, model: string): ModelSnapshot[number] | undefined {
  return store.entries(upstream).find((candidate) => candidate.id === model);
}

/** Aggregates one `models` entry; `undefined` when no dimension is known. */
function aggregateEntry(entry: ModelConfig, store: MetadataStore): AliasMetadata | undefined {
  const routeMetadata = entry.routes.map((route) => {
    const raw = routeEntry(store, route.upstream, route.model);
    return raw === undefined ? undefined : detectModelMetadata(raw);
  });

  const contextWindow = minLimit(
    routeMetadata.map((metadata) => metadata?.contextWindow),
    entry.limits?.context,
  );
  const outputLimit = minLimit(
    routeMetadata.map((metadata) => metadata?.outputLimit),
    entry.limits?.output,
  );
  const capabilities = andCapabilities(routeMetadata);

  if (contextWindow === undefined && outputLimit === undefined && capabilities === undefined) {
    return undefined;
  }
  const metadata: AliasMetadata = {};
  if (contextWindow !== undefined) {
    metadata.contextWindow = contextWindow;
  }
  if (outputLimit !== undefined) {
    metadata.outputLimit = outputLimit;
  }
  if (capabilities !== undefined) {
    metadata.capabilities = Object.freeze(capabilities);
  }
  return Object.freeze(metadata);
}

/**
 * The element-wise minimum over the routes that declared the dimension
 * ("0 == undeclared" per the detector contract, but negative values are
 * declined defensively too), then the minimum with the entry's manual
 * limits value when one is configured.
 */
function minLimit(declared: readonly (number | undefined)[], manual: number | undefined): number | undefined {
  let min: number | undefined;
  for (const value of declared) {
    if (value !== undefined && value > 0) {
      min = min === undefined ? value : Math.min(min, value);
    }
  }
  if (manual !== undefined) {
    min = min === undefined ? manual : Math.min(min, manual);
  }
  return min;
}

/**
 * The strict AND over the routes: a flag is true only when every route
 * declared it true. One route without metadata — or without a full
 * capabilities declaration — leaves the alias's capabilities undeclared;
 * when every route fully declares, the AND is authoritative and false
 * flags are emitted as false.
 */
function andCapabilities(routeMetadata: readonly (ModelMetadata | undefined)[]): ModelCapabilities | undefined {
  if (routeMetadata.length === 0) {
    return undefined;
  }
  const and: ModelCapabilities = { attachment: true, reasoning: true, temperature: true, toolCall: true };
  for (const metadata of routeMetadata) {
    if (metadata === undefined || metadata.capabilities === undefined) {
      return undefined;
    }
    and.attachment = and.attachment && metadata.capabilities.attachment;
    and.reasoning = and.reasoning && metadata.capabilities.reasoning;
    and.temperature = and.temperature && metadata.capabilities.temperature;
    and.toolCall = and.toolCall && metadata.capabilities.toolCall;
  }
  return and;
}

/**
 * A Map that is frozen for real: the mutators are shadowed by throwing own
 * properties before the instance freezes, so `set`/`delete`/`clear` fail
 * loudly while `get`/`has`/iteration stay intact.
 */
function frozenMap<K, V>(rows: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map<K, V>(rows);
  const refuse = () => {
    throw new TypeError("the alias metadata map is frozen");
  };
  for (const name of ["set", "delete", "clear"] as const) {
    Object.defineProperty(map, name, { value: refuse, enumerable: false, configurable: true });
  }
  return Object.freeze(map);
}
