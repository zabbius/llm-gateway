# Routing

## Purpose

Maps OpenAI-protocol requests onto configured model aliases and, through them, onto the upstream registry. The LLM surface mounts at `/llm/v1/*` (namespace: [ADR-005](../decisions/005-gateway-surface-namespace.md)); the model namespace is the config's alias table ([ADR-009](../decisions/009-alias-table-routing.md)): a client model id is a `models[].alias`, balanced across the entry's routes by its `balance.strategy` with per-route health tracking ([load-balancing.md](./load-balancing.md)); `GET /llm/v1/models` serves the gateway's own alias catalog, scoped to the authenticated client; the two completion endpoints dispatch as pure pass-through. At startup — after the registry's probes resolve — every configured route is cross-checked against the upstreams' retained startup catalogs (the route inventory below); findings warn and never abort startup, and the verdicts stay log-only startup facts. The table itself is built through a rebuildable holder: a runtime models mutation ([ADR-014](../decisions/014-runtime-management-crud.md)) constructs a fresh build over the freshly persisted block and atomically swaps it in — the next request resolves the new state without a restart, in-flight requests complete against the build that dispatched them, and the rebuild's fresh balancer starts from neutral health and empty session affinity. Alongside dispatch, the routing domain aggregates client-facing model metadata: each alias's raw upstream listings and its manual `limits` fold into one `AliasMetadata` record (the Alias metadata section below); the aggregate projects onto the client surface as the alias catalog entry's optional `limit` / `capabilities` / `modalities` fields and onto the management surface as the `meta` key of every `GET /api/models` entry ([gateway-management.md](../contracts/gateway-management.md)).

## Key Files

- `src/gateway/router.ts` — the alias table (`createRoutingTable`: alias → usable routes → balance- and health-selected route) and the rebuildable holder (`createRebuildableRoutingTable`: the stable table object the handlers capture; `rebuild(models)` swaps a fresh build in atomically — [ADR-014](../decisions/014-runtime-management-crud.md)), plus the per-client ACL helper (`clientMayUse`)
- `src/gateway/balancer.ts` — the route balancer the table wraps: strategies, selection, per-route health, failure classification
- `src/gateway/crosscheck.ts` — the pure route-inventory cross-check (`crossCheckRoutes`: every configured route vs the retained startup catalogs → matched / missing / unknown)
- `src/gateway/modelmetadata.ts` — the first-wins detector chain over one raw listing entry (LM Studio → aggregator → OpenAI-standard; `0 == undeclared`)
- `src/gateway/metastore.ts` — the per-upstream metadata store (`MetadataStore`: seed from the startup probes, wholesale replacement on a successful discovery, retain-last-good on a failed one)
- `src/gateway/aliasmeta.ts` — the pure alias-metadata builder (`buildAliasMetadata`: per-route detection, element-wise minimum with the manual `limits`, strict capability AND)
- `src/httpapi/handlers/models.ts` — `GET /llm/v1/models` alias-catalog handler
- `src/httpapi/handlers/completions.ts` — `POST /llm/v1/chat/completions` and `POST /llm/v1/completions` dispatch handlers (the failover loop)
- `src/httpapi/handlers/model-aliases.ts` — the management models CRUD ([ADR-014](../decisions/014-runtime-management-crud.md)): the store's validate → persist → apply, then `rebuild(models)` over the freshly persisted block

## Core Types

```ts
/** Client-facing model id: a configured alias (`models[].alias`, /^[^\s/]+$/). */
type AliasModelId = string;

/** One balance- and health-selected pick (specs/domains/load-balancing.md). */
interface RouteSelection {
  routeId: string;       // "alias|upstream|model" — health key + the dispatch tried-set key
  upstream: Upstream;    // registry hit for the selected route's upstream
  upstreamModel: string; // the route's provider-native model — what upstream receives in body.model
}

/** "gpt-4o-fast" (routes: [{upstream: "openai", model: "gpt-4o-mini"}, …])
    → routes(alias): the usable config-order routes (null when the alias is
    not configured — the dispatch handler then answers 404 model_not_found
    without any upstream contact); select(alias, tried?, affinityKey?): the next eligible
    RouteSelection per the balance strategy and route health — a session-affinity binding
    for the key wins first ([ADR-010](../decisions/010-session-affinity.md)) — (null when
    nothing is eligible — the dispatch answers 503 upstream_unavailable). */
declare function createRoutingTable(
  models: readonly ModelConfig[],
  registry: UpstreamRegistry,
  options?: RouteBalancerOptions,   // the balancer's knobs (logger, clock, thresholds, affinity bound) — tests inject them; production takes the defaults
): RoutingTable;   // .aliases(): config order; .routes(alias); .select(alias, tried?, affinityKey?); .report(selection, ok, affinityKey?)

/** The rebuildable holder the HTTP layer captures (ADR-014): one stable
    RoutingTable object delegating every call to the *current* build;
    rebuild(models) constructs a fresh createRoutingTable over the given
    (freshly persisted, normalized) block and replaces the internal
    reference in one assignment — atomic on the single-threaded event loop.
    A fresh build carries a fresh balancer: neutral route health and an
    empty session-affinity map (ADR-014 D9). */
declare function createRebuildableRoutingTable(
  models: readonly ModelConfig[],
  registry: UpstreamRegistry,
  options?: RouteBalancerOptions,   // forwarded to every build — the same knobs createRoutingTable takes
): RebuildableRoutingTable;   // .table: RoutingTable; .models: current block; .rebuild(models)

/** The per-client ACL: an authenticated client may address only the aliases
    in its clients[].models; no client on the request context (no gate
    mounted — a store-less embedding with no clients block) means no ACL —
    every configured alias is addressable. */
declare function clientMayUse(client: GatewayClient | undefined, alias: string): boolean;

/** The three-state health verdict of one configured route against its
    upstream's retained startup catalog. */
type RouteHealth = "matched" | "missing" | "unknown";

/** One configured route's verdict, in config order — what the startup
    pipeline warns from and counts on its info line; the verdicts are
    log-only (the status probe answers the fixed `{ status, authenticated }`
    pair and carries no inventory). */
interface RouteHealthEntry {
  alias: string;   // the owning models[].alias
  upstream: string; // models[].routes[].upstream
  model: string;   // models[].routes[].model
  health: RouteHealth;
}

/** Pure startup cross-check (runs once in src/index.ts, after the registry's
    probes): every configured route vs the retained startup catalogs.
    "matched" — the ok upstream's catalog lists the model; "missing" — an ok
    upstream's catalog does not (a per-route startup warning); "unknown" — no
    catalog to compare against (probe failed, no retained snapshot, or the id
    absent from the statuses) and no per-route warning. Consumes only frozen
    inputs, contacts no upstream, freezes its output. */
declare function crossCheckRoutes(
  aliases: readonly ModelConfig[],
  registryStatus: readonly UpstreamStatus[],
): readonly RouteHealthEntry[];

/** Envelope for gateway-generated errors — OpenAI-native; constructed in
    `src/httpapi/errors.ts`, the single mapper for `/llm/*` and `/api/*`
    alike (the full status/type/code table is the Error Propagation table in
    contracts/client-gateway.md). */
interface GatewayError {
  error: {
    message: string;
    type: "invalid_request_error" | "authentication_error" | "api_error";
    param?: string;   // "model" on model_not_found and on the 403 denial
    code?: "model_not_found" | "request_too_large" | "resource_in_use"           // invalid_request_error
          | "authentication_required" | "invalid_api_key" | "invalid_credentials" // authentication_error — the two gates
          | "upstream_error" | "upstream_timeout" | "upstream_tls_error" | "upstream_proxy_error" | "upstream_unavailable";  // api_error; absent on the 400 and 403 answers and the no-code 404
  };
}
```

Alias metadata types:

```ts
/** One alias's client-facing metadata; an absent field is unknown, not zero. */
interface AliasMetadata {
  contextWindow?: number;           // the smallest context window any of the alias's routes can serve
  outputLimit?: number;             // the smallest output limit any of the alias's routes can serve
  capabilities?: ModelCapabilities; // present only when every route fully declared its own capabilities
}

/** buildAliasMetadata(models, store): folds the store's per-upstream snapshots
    and the entries' manual limits into alias → AliasMetadata — a frozen Map
    holding an entry only for aliases with at least one known dimension. */
declare function buildAliasMetadata(
  models: readonly ModelConfig[],
  store: MetadataStore,
): ReadonlyMap<string, AliasMetadata>;

/** Per-upstream raw `ModelEntry` snapshots — the discovery side of alias
    metadata (discovery at start, retain-last-good; see Alias metadata). */
declare class MetadataStore {
  /** The ok startup probes' retained catalogs become the initial snapshots. */
  seed(registryStatus: readonly UpstreamStatus[]): void;
  /** Wholesale replacement on a successful discovery (true); a failed one
      (`entries === undefined`) mutates nothing and returns false. */
  set(upstreamId: string, entries: readonly ModelEntry[] | undefined): boolean;
  /** The current frozen slice for the builder ([] when nothing is known). */
  entries(upstreamId: string): readonly ModelEntry[];
  /** The runtime CRUD's counterpart to seed(): drop one upstream's slice
      entirely — a deleted upstream, or an updated one whose fresh probe
      retained no catalog, stops serving alias metadata. */
  clear(upstreamId: string): void;
}

/** detectModelMetadata(entry): the first-wins detector chain over one raw
    listing entry (LM Studio → aggregator → OpenAI-standard); unmatched
    shapes decline to undefined (`src/gateway/modelmetadata.ts`). */
declare function detectModelMetadata(entry: unknown): ModelMetadata | undefined;
```

Resolution rules:

- alias is not configured → `404` `model_not_found`;
- alias is configured but not in the authenticated client's `clients[].models` → `403` (`invalid_request_error`, `param: "model"`, no code) — existence and permission are different answers ([ADR-009](../decisions/009-alias-table-routing.md));
- no `clients` block → no ACL: `clientMayUse(undefined, alias)` is true for every configured alias. Whether a request reaches that check unauthenticated is the gate's question, not the ACL's: with the runtime configuration store wired (every production start) the client gate mounts even over an empty registry and answers `401` fail-closed until the CRUD creates the first client ([ADR-014](../decisions/014-runtime-management-crud.md)); only a store-less embedding with no `clients` block serves the surface ungated ([ADR-008](../decisions/008-client-bearer-auth.md));
- route selection follows the entry's `balance.strategy` restricted to healthy routes ([load-balancing.md](./load-balancing.md)): `round-robin` rotates the routes in config order; `weighted-round-robin` rotates a weight-expanded schedule (each route appears `weight` times — proportional over every full cycle, deterministic within it); a route opened by consecutive pre-first-byte failures is skipped for its cooldown, then retried once as a half-open probe; a request carrying a session-affinity key (`X-Session-Id` header, else `user` — [ADR-010](../decisions/010-session-affinity.md)) is served by its bound route first, falling back to the strategy when that route is ineligible;
- a pre-first-byte upstream failure (synthesized 502/504/502-TLS/502-proxy, relayed 5xx, relayed 429) marks the route and the dispatch advances to the entry's next eligible route; failover exhausted within the request relays the last upstream failure unchanged, and an alias whose every route is open answers `503` `upstream_unavailable` without any upstream contact ([load-balancing.md](./load-balancing.md));
- upstream unreachable / timed out → `504` `upstream_timeout`; a non-JSON upstream error body → `502` `upstream_error`; a TLS verification failure on a pinned upstream → `502` `upstream_tls_error` ([ADR-004](../decisions/004-per-upstream-tls-pinning.md)); the upstream's configured proxy refusing or failing the connection → `502` `upstream_proxy_error` ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) — all four synthesized by the upstream as a `Response` (`forward()` never rejects; specs/contracts/gateway-upstream.md). An unexpected rejection maps through the app's error middleware to a `502` `api_error` envelope;
- whether the upstream knows the selected route's model name is the upstream's verdict — the route's model text is forwarded verbatim and the upstream answer relayed unchanged.

Endpoint map:

| Endpoint | Handling |
| -------- | -------- |
| `GET /llm/v1/models` | catalog: routing-table aliases (client-scoped when a clients block is configured) → `{ id, object: "model", created: <process start epoch>, owned_by: "llm-gateway" }` per alias, plus the metadata projection (Alias metadata below) where the alias's aggregate knows a dimension → `{ "object": "list", "data": [...] }` — no upstream contact |
| `POST /llm/v1/chat/completions` | `routes(body.model)` (404 when null) → ACL check → the failover loop ([load-balancing.md](./load-balancing.md)): `select` → `upstream.forward({ path: "chat/completions", … })` with `body.model` = the route's model, advancing on pre-first-byte failures; every route open → `503 upstream_unavailable` |
| `POST /llm/v1/completions` | same as chat/completions with `path: "completions"` |
| `POST` / `PUT` / `DELETE` on `/api/models` (management CRUD) | the store's validate → persist → apply ([ADR-014](../decisions/014-runtime-management-crud.md) D1), then `rebuild(models)` over the freshly persisted block — the new/changed/deleted alias is visible to the catalog and the dispatch on the very next request; a referenced delete answers `409 resource_in_use` before anything moves ([gateway-management.md](../contracts/gateway-management.md)) |

## Alias metadata

One alias's client-facing metadata is aggregated, not stored: every route's raw upstream listing entry (matched in the upstream's snapshot by provider-native model id) runs through the detector chain, and the route results fold with the entry's manual `limits` into one `AliasMetadata`. The build is pure and read-only — it consumes the store's current slice, contacts no upstream, and freezes its output. The dedicated domain doc [model-metadata.md](./model-metadata.md) carries the normative detail: the detector field contract (1:1 with the c0wrk chain, [ADR-012](../decisions/012-alias-model-metadata.md)), the surface shapes, and the discovery endpoint contract.

Discovery model (where the snapshots come from):

- at startup, after the registry's probes resolve, every ok probe's retained catalog seeds that upstream's snapshot (discovery at start); failed probes — and ok probes whose upstream retains no catalog — seed nothing;
- the operator refreshes one upstream's snapshot on demand through the live listing's `discover=1` query parameter — `GET /api/upstreams/:id/models?discover=1`, one `listModels()` within the startup probe budget, no retries ([ADR-011](../decisions/011-management-live-model-listing.md) as amended by [ADR-016](../decisions/016-discover-folded-into-live-listing.md); [gateway-management.md](../contracts/gateway-management.md)): a success swaps the slice wholesale before the answer, a failure or expired budget leaves the last good snapshot serving (retain-last-good) and surfaces as the listing's `502` envelope;
- the management CRUD's upstream writes keep the slices honest without an operator round: a create/update whose blocking probe succeeded with a retained catalog seeds the fresh slice; anything else — a failed probe, no retained catalog, a delete — clears it ([ADR-014](../decisions/014-runtime-management-crud.md) D8);
- an on-demand refresh replaces an upstream's snapshot wholesale when it succeeds; an empty listing is a fact, not a failure ("provider lists zero models"); a failed refresh never touches the store: the last good snapshot keeps serving, so a broken re-discovery cannot degrade alias metadata.

Aggregation rules per alias:

- limits — `contextWindow` / `outputLimit` are the element-wise minimum over the routes that declared the dimension, then the minimum with the entry's manual `limits` value when one is configured: the alias can land on any route, so its budget is the smallest budget any route can serve;
- capabilities — the strict AND: a flag is true only when every route declared it true; one route without a full capabilities declaration — or without any metadata at all — leaves the alias's capabilities undeclared. When every route fully declares, the AND is authoritative and false flags are emitted as false;
- an alias with not a single known dimension gets no entry at all — absent means unknown, never a fabricated zero or an all-false block.

Client-facing projection (where the aggregate surfaces — both folds run per request, read-only, no upstream contact):

- the alias catalog (`GET /llm/v1/models`, `src/httpapi/handlers/models.ts`): an entry whose alias has a known context window gains `limit: { context, output }` — `context` positive, `output` `0` when the output limit is not declared (the c0wrk wire contract's "0 == undeclared"); the `capabilities` (`tools.supported` ← tool-call flag, `reasoning.supported` ← reasoning flag, `temperature` verbatim) + `modalities` (`input`: `["text"]`, plus `"image/png"` when image input is declared) pair appears only on the full four-flag declaration the strict AND yields. An alias without any known metadata serializes byte-for-byte as the bare four-key OpenAI entry ([client-gateway.md](../contracts/client-gateway.md));
- the management surface (`GET /api/models` and its single-entry read, `src/httpapi/handlers/model-aliases.ts`): every managed alias entry carries `meta` — `{ contextWindow, outputLimit, capabilities }` with JSON `null` where the aggregate is unknown and the strict-AND four-flag object verbatim where it is declared ([gateway-management.md](../contracts/gateway-management.md));
- both folds read the store's *current* slice against the store's current `models` block — a successful `discover=1` listing (or a CRUD write whose blocking probe retained a catalog) is visible on the next read; a failed one changes nothing (retain-last-good).

```
store.seed(registry.status())                    (startup, after the probes resolve)
  └ ok probe with a retained catalog → the upstream's initial snapshot
GET /api/upstreams/:id/models?discover=1 ── success ── set(id, listing) → wholesale swap (frozen)
                                        └── failed ─── store untouched (retain-last-good)
upstream CRUD write ── probe ok + retained catalog ── set(id, catalog)
                 └── otherwise (failed probe, delete) ── clear(id)
buildAliasMetadata(models, store)                (pure, frozen output)
  └ per route: detectModelMetadata(entry in store.entries(route.upstream))
      ├ limits: element-wise min over declaring routes → min with the manual limits
      ├ capabilities: strict AND — a flag true only when every route declared true
      └ no known dimension → no entry for the alias
```

## Flow

Dispatch on `/llm/v1/chat/completions` (alias `gpt-4o-fast` → route `openai`/`gpt-4o-mini`, round-robin selected):

```
Client                          Gateway                                   Upstream
  │ POST /llm/v1/chat/completions  │                                         │
  │ { "model": "gpt-4o-fast" }     │                                         │
  │───────────────────────────────►│ parse body                              │
  │                                │ table.routes("gpt-4o-fast") — else 404  │
  │                                │ clientMayUse(client, alias) — else 403  │
  │                                │ failover loop (load-balancing.md):      │
  │                                │   table.select("gpt-4o-fast", tried,    │
  │                                │     affinityKey) — session affinity     │
  │                                │     (ADR-010) picks first               │
  │                                │     ├ balance strategy picks the route  │
  │                                │     │  among healthy ones               │
  │                                │     └ route → upstream "openai",        │
  │                                │       upstreamModel "gpt-4o-mini"       │
  │                                │ body.model := "gpt-4o-mini"             │
  │                                │ upstream.forward("chat/completions") ───►│
  │                                │◄──────── response / SSE stream ─────────│
  │                                │ pre-first-byte failure (5xx/429)?       │
  │                                │   mark route, try next eligible route   │
  │◄─── relayed unchanged ─────────│ everything open → 503 upstream_unavailable
```

Alias catalog on `GET /llm/v1/models`:

```
client ── GET /llm/v1/models ──► gateway
gateway   table.aliases() (config order)
            └ client authenticated? → keep only aliases in its clients[].models
          every kept alias → { id: alias, object: "model",
                               created: <process start epoch>,
                               owned_by: "llm-gateway" }
          + buildAliasMetadata(models, store).get(alias) → limit / capabilities /
            modalities, present only where the aggregate knows (per-request fold,
            no upstream contact; absent metadata → exactly the four base keys)
client ◀─ { "object": "list", "data": [...] }   (no upstream contact — cannot degrade)
```

Startup route inventory (runs once in the entry point, after the registry's probes resolve and before the listener binds — step [5b] of the startup flow in [data-flow.md](../architecture/data-flow.md)):

```
registry.create() ──► probe outcomes frozen (each ok probe carries its retained catalog)
gateway   crossCheckRoutes(models, registry.status())     (pure, frozen inputs)
            └ per route {alias → upstream/model}:
                catalog lists the model    → "matched"
                catalog lacks the model    → "missing" → one warn line per route
                no catalog to compare against → "unknown" → silent (the upstream's
                                            single probe warning already covers it)
gateway   info line: route counts (matched / missing / unknown)
startup continues — findings never abort (warn-never-abort)
the verdicts stay log-only startup facts — no HTTP surface serves them
```

## Invariants

- Every client-visible model id is a configured alias; aliases match `^[^\s/]+$` (no whitespace, no `/`) and are unique across the config — a model id is a single URL path segment.
- Resolution is exact: no fuzzy or prefix matching ("gpt" never resolves "gpt-4o-fast").
- `GET /llm/v1/models` returns one flat list — entries are never grouped or nested, the list preserves config order, and it is answered entirely from the routing table: no upstream is contacted, so it never degrades.
- With a `clients` block configured, the catalog lists only the authenticated client's aliases, and a completion request for an alias outside that set answers `403` before any upstream contact; an unconfigured alias answers `404` the same way.
- The only transformation routing makes on a dispatching request is replacing `body.model` with the selected route's provider-native model; the remaining bytes are forwarded as received.
- Route selection is deterministic per alias (config-order rotation; weight-expanded schedule for weighted round-robin) and advances only on actual selections — session-affinity picks included ([ADR-010](../decisions/010-session-affinity.md)); health restricts the candidate set but never reorders it ([load-balancing.md](./load-balancing.md)).
- Dispatch responses are relayed unchanged — status, headers, and body (including SSE); routing never rewrites them. Failover advances only before the first byte; once a response streams (or is otherwise servable) it is final.
- `/llm/v1/chat/completions` and `/llm/v1/completions` share the same resolution path; only the forwarded upstream `path` differs.
- The startup route inventory cross-checks every configured route against the upstreams' retained startup catalogs and only warns: a verified-missing model warns once per route, and a route without a comparable catalog (failed probe, no retained snapshot, or an id absent from the statuses) reports `"unknown"` and stays silent — the upstream's single startup-probe warning covers it. The verdicts are log-only startup facts.
- Inventory findings never abort startup; the gateway serves regardless of the verdicts.
- A runtime models mutation rebuilds the table wholesale ([ADR-014](../decisions/014-runtime-management-crud.md) D2/D9): a fresh `createRoutingTable` build over the freshly persisted block is atomically swapped into the stable holder object — in-flight requests complete against the build that dispatched them, the next request resolves the new state without a restart, and the rebuild's fresh balancer starts from neutral route health and an empty session-affinity map (stale verdicts or bindings describing a prior configuration are never carried over).
- Alias metadata snapshots are keyed by upstream id and hold raw unprefixed entries; the store only ever swaps a snapshot whole: a failed discovery mutates nothing (retain-last-good), and a successful one replaces the snapshot atomically on the single-threaded event loop.
- `buildAliasMetadata` is a pure function of the frozen config slice and the store's current snapshots: it never contacts an upstream, never mutates the store, and returns a frozen table in which an absent field means unknown — never a fabricated `0` or an all-false capability block.
- An alias metadata record exists only when at least one dimension is known: limits aggregate as the element-wise minimum over the declaring routes and then with the entry's manual `limits`; capability flags aggregate as the strict AND — true only when every route declared true.
- The metadata projection is absent-when-unknown everywhere: a catalog entry without a known context window carries no `limit` key, one without the full four-flag declaration carries no `capabilities`/`modalities`, a bare alias serializes exactly the four OpenAI keys, and a management `meta` key reports JSON `null` for every unknown dimension — never a fabricated value. Both folds read the store's current slice per request, contact no upstream, and a failed refresh leaves what they serve unchanged.

## Configuration

Routing's model namespace is the config's `models` block: every entry's `alias` becomes addressable, its `routes[]` name the serving `(upstream, model)` pairs, and its `balance.strategy` selects the rotation. Cross-block references are validated at startup (`routes[].upstream` → `upstreams[].id`, `clients[].models` → `models[].alias`), so a routing table built at startup always resolves. An absent `models` block leaves the table empty: no alias resolves and the LLM surface answers `404 model_not_found` everywhere. See [Configuration](./configuration.md).

## Extension Points

- A new OpenAI-protocol endpoint (e.g. `/llm/v1/embeddings`) adds a handler that reuses `createRoutingTable`'s `routes`/`select` and the ACL helper; the registry and upstreams need no changes.
- A new balance strategy extends `BALANCE_STRATEGIES` (`src/config/schema.ts`) and the schedule expansion in `src/gateway/balancer.ts` — the HTTP layer is untouched.
- Route-level auth or quotas — future cross-cutting concerns attach between request parsing and `select`; the client ACL (ADR-009) already occupies that seam.
- A new provider listing shape adds one detector to the chain in `src/gateway/modelmetadata.ts` (most-specific shape first); alias metadata picks it up per route with no other change — `detectModelMetadata` stays the only parsing seam between raw listings and aggregated metadata.

## Related Specs

- [Load balancing](./load-balancing.md) — the strategies, health state, and failure classification behind `select`/`report`
- [Upstreams](./upstreams/README.md) — the registry routing resolves upstreams through
- [Upstream contract](./upstreams/upstream-contract.md) — what `forward()` does with a dispatched request, and the retained startup catalogs the route inventory compares against
- [Configuration](./configuration.md) — source of the alias table (`models`, `clients[].models`)
- [Client <-> Gateway contract](../contracts/client-gateway.md) — the client-facing id scheme, the `/models` shape, and the 401/403/404 table
- [Management Clients <-> Gateway contract](../contracts/gateway-management.md) — the management CRUD the rebuild serves (`POST`/`PUT`/`DELETE` on `/api/models`) and the `meta` key the managed entries carry
- [ADR-014: runtime management CRUD](../decisions/014-runtime-management-crud.md) — the rebuildable holder, the hot-apply, and the health/affinity reset the rebuild causes
- [Observability](./observability.md) — per-request log lines emitted on this path, plus the startup inventory's warn/info lines
