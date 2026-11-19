# Load Balancing

## Purpose

Selects, for every completion request, which of the alias entry's routes serves it (round-robin or weighted round-robin) and tracks per-route health in memory: a pre-first-byte failure counts against the route, enough consecutive failures open it for a cooldown, cooldown expiry yields a single half-open probe, and an alias whose every route is open answers `503 upstream_unavailable` before any upstream contact. Dispatch order is one upstream per attempt: a failing route is marked and the next eligible route takes the request. Requests carrying a session-affinity key (`X-Session-Id` header, else the `user` field — [ADR-010](../decisions/010-session-affinity.md)) stick to one route while it stays eligible.

## Key Files

- `src/gateway/balancer.ts` — the balancer: strategy schedules, selection, per-route health, the session-affinity map, and the failure classifier (`isPreFirstByteFailure`)
- `src/gateway/router.ts` — the routing-table facade (`routes`/`select`/`report`) the HTTP layer consumes
- `src/httpapi/handlers/completions.ts` — the dispatch failover loop: attempt → classify → mark → advance
- `src/httpapi/errors.ts` — `serviceUnavailableResponse`, the `503 upstream_unavailable` envelope

## Core Types

```ts
/** One balance- and health-aware pick the dispatch handler forwards to. */
interface RouteSelection {
  routeId: string;       // "alias|upstream|model" — the health key and the per-request tried-set key
  upstream: Upstream;    // registry hit for the route's upstream
  upstreamModel: string; // what upstream receives in body.model
}

/** The selection + health surface (wrapped by the routing table). */
interface RouteBalancer {
  routesOf(alias): ModelRouteConfig[] | null;               // usable routes, config order; null → 404
  select(alias, tried?, affinityKey?): RouteSelection | null; // affinity pick first; null → nothing eligible → 503
  report(selection, ok, affinityKey?): void;                // the only state-mutating call (health + affinity)
}

/** Failure classification: a route failed before its first byte… */
declare function isPreFirstByteFailure(response: Response): boolean;  // status >= 500 || status === 429

/** Thresholds — module constants, not config (MVP). */
const ROUTE_FAILURE_THRESHOLD = 3;   // consecutive pre-first-byte failures that open a route
const ROUTE_COOLDOWN_MS = 30_000;    // how long an open route stays skipped
const AFFINITY_MAX_ENTRIES = 10_000; // session→route bindings held at most (LRU across all aliases)
```

## Flow

The dispatch loop (alias already resolved, ACL passed, affinity key = `X-Session-Id` header, else `user`, else none):

```
request
   |
   v
loop: select(alias, tried, affinityKey)
   |    affinity binding (alias, key) → routeId — ADR-010:
   |      bound route eligible (untried, healthy)? -> pick it (pointer advances past it;
   |        cooldown expired -> the pick is the half-open probe); ineligible -> keep the
   |        binding, fall through
   |    no key, no binding: scan the strategy schedule from the rotation pointer:
   |      skip slots already tried in this request
   |      skip routes open for cooldown or holding a half-open probe
   |    first eligible slot -> selection; rotation pointer := picked slot + 1
   |    none eligible:
   |      attempts > 0 -> relay the last upstream failure response unchanged
   |      attempts = 0 -> 503 upstream_unavailable (no upstream contact)
   |
   v
forward (fresh request body per attempt — a consumed stream never crosses twice)
   |
   v
isPreFirstByteFailure(response)?
   |-- yes: report(route, false, affinityKey) — a binding naming this route is released;
   |        tried += routeId; loop (next route)
   `-- no:  report(route, true, affinityKey) — re-binds affinityKey → routeId; relay the
            response unchanged — final
```

Per-route health state machine (`routeId = alias|upstream|model`):

```
             N consecutive pre-first-byte failures
   healthy ----------------------------------------> open (cooldown)
      ^                                                 |
      | probe succeeds                                  | cooldown expired
      |                                                v
      +------------------------------------------ half-open (single probe in flight;
              no other attempt may use the route)        other requests skip the route)
                                                        |
                                                        | probe fails
                                                        v
                                                     open (fresh cooldown)
```

## Invariants

- Selection is deterministic per alias: `round-robin` rotates routes in config order; `weighted-round-robin` expands each route `weight` times (default 1), so a full cycle is proportional to the weights and repeats exactly; the rotation pointer advances only on an actual selection and stays untouched when nothing is eligible.
- Health is keyed per route (`alias|upstream|model`), lives in memory for the process lifetime, is never persisted, never shared across aliases, and resets on restart. A routing-table rebuild — a runtime models mutation hot-applied without a restart ([ADR-014](../decisions/014-runtime-management-crud.md) D9) — starts every route from the neutral state: the old bookkeeping described routes of a prior configuration, so stale verdicts are never carried across a rebuild. Weighted copies of one route share a single health state.
- Only pre-first-byte failures count (`status >= 500 || status === 429` — synthesized 502/504/502-TLS envelopes, relayed 5xx, relayed 429); a client-caused 4xx (400/401/404, …) leaves health untouched, is relayed unchanged, and triggers no failover.
- Once a servable response is handed back (including a `200` SSE stream), the answer is final — no failover after the first streamed byte.
- An alias whose every route is open answers `503 upstream_unavailable` without any upstream contact; failover exhausted within one request relays the last upstream failure response byte-for-byte — upstream bodies pass through untouched.
- The thresholds are module constants (`ROUTE_FAILURE_THRESHOLD`, `ROUTE_COOLDOWN_MS`, `AFFINITY_MAX_ENTRIES`); the config grammar carries no health or affinity keys.
- Session affinity ([ADR-010](../decisions/010-session-affinity.md)): the key is the `X-Session-Id` header when present and non-empty, else the `user` body field when a non-empty string, else none; bindings are keyed per (alias, key), live in a memory-only LRU map of at most `AFFINITY_MAX_ENTRIES` entries across all aliases, and die on restart. A routing-table rebuild ([ADR-014](../decisions/014-runtime-management-crud.md) D9) drops them together with the old build's health state, and keys re-bind wherever the next requests land.
- Every success re-binds the key to the route that served it; a pre-first-byte failure releases the binding only when it names the failed route — a keyed request whose bound route is unhealthy takes the schedule's pick without losing the binding, and a keyed request migrates with failover, re-binding wherever it lands.
- A keyless request, and any select with no eligible binding, is the pure strategy choice — affinity never reorders or reserves the schedule; an affinity pick is an actual selection and advances the rotation pointer like any other.
- The balancer holds no credentials and no config beyond the validated `models` slice and registry-resolved upstream instances.

## Configuration

Route weights and the strategy come from the `models` block's `balance` strategy (grammar in [Configuration](./configuration.md)): `weight` is required to be a positive integer on every route under `weighted-round-robin` and defaults to 1 when absent. The health thresholds live as constants in `src/gateway/balancer.ts` (`ROUTE_FAILURE_THRESHOLD = 3`, `ROUTE_COOLDOWN_MS = 30_000`) and are deliberately not config keys in the MVP, as is the session-affinity bound (`AFFINITY_MAX_ENTRIES = 10_000`, [ADR-010](../decisions/010-session-affinity.md)).

## Extension Points

- A new balance strategy extends `BALANCE_STRATEGIES` (`src/config/schema.ts`) plus the schedule expansion in `createRouteBalancer`; the dispatch loop and the HTTP layer stay untouched.
- Configurable thresholds: promote the constants into the `balance` block — a config-schema change that also updates `config.example.json` and [configuration.md](./configuration.md) in the same change.
- Exposing health (breaker states, failure counts) on the management surface reads the balancer's state map — a [gateway-management.md](../contracts/gateway-management.md) change; today no HTTP surface serves balancer state (the status probe is the fixed `{ status, authenticated }` pair, and the ADR-014 CRUD answers carry one-shot probe reports, not breaker state).
- Strategies with other inputs (least-connections, P2C) replace the schedule scan in `select`; `report` stays the single outcome channel.
- Configurable affinity: other key sources (cookie, additional headers) or a config-promoted map bound are client-surface changes ([client-gateway.md](../contracts/client-gateway.md)) plus an `affinity` extraction change in the dispatch handler — an ADR first ([ADR-010](../decisions/010-session-affinity.md) fixed the MVP key priority).

## Related Specs

- [Routing](./routing.md) — the alias table this balancer backs (existence, ACL, catalog)
- [Data flow](../architecture/data-flow.md) — where selection and failover sit in the request lifecycle
- [Upstream contract](./upstreams/upstream-contract.md) — what `forward()` answers (the classification's input)
- [Client <-> Gateway contract](../contracts/client-gateway.md) — the `503 upstream_unavailable` envelope, the relay rules, and the `X-Session-Id` header
- [ADR-010](../decisions/010-session-affinity.md) — the session-affinity decision: key priority, binding lifecycle, bounded map
- [ADR-014](../decisions/014-runtime-management-crud.md) — the runtime CRUD whose models mutations rebuild the table: the health/affinity reset is D9's consequence
- [Configuration](./configuration.md) — the `balance` block and route weight grammar
