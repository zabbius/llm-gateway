# ADR-009: Alias-table routing (config `models` + per-client ACL)

## Status

Accepted

## Context

Clients speak the OpenAI protocol and select a model by a plain model-ID string, and the id gets baked into client configurations — the scheme is effectively irreversible once clients depend on it. The gateway fronts heterogeneous provider connections ([ADR-001](./001-upstream-per-provider-type.md)), the same upstream model name can be exposed by more than one connection, and the per-client Bearer gate ([ADR-008](./008-client-bearer-auth.md)) needs a per-credential notion of "which models may this client address". One routing decision must therefore settle three things at once: what the public model id is, where balancing lives, and what a client is allowed to see.

A topology-derived id (prefixing the upstream id onto every model name, `{upstreamId}/{model}`) was considered and rejected: it leaks the gateway's internal connection layout into every client — ids carry upstream ids, renaming an upstream remaps every client configuration, model selection stays purely positional with no home for balancing, and the per-client alias lists would key on the same prefixed ids and inherit the coupling. The gateway instead holds a curated model catalog of its own: a top-level `models` array of aliased, load-balanced entries (`alias` → `routes[]` of `(upstream, model, weight?)` with an explicit `balance.strategy`), and a `clients[].models` alias list per client credential. Both are validated at startup with fatal cross-reference checks (`clients[].models[j]` → `models[].alias`, `models[].routes[j].upstream` → `upstreams[].id`).

The client-facing surface is detailed in [Contract: Client <-> Gateway](../contracts/client-gateway.md); the routing behaviour in [Routing domain](../domains/routing.md).

## Decision

The public model id is a configured **alias**:

- `body.model` on both completion endpoints is looked up exactly (no fuzzy matching) in the config `models` table. An alias that is not configured answers `404 model_not_found`; an alias that is configured but not listed in the authenticated client's `clients[].models` answers `403` (`invalid_request_error`, `param: "model"`, no code). Both answers are produced before any upstream contact. Without a client on the request context (no `clients` block and no wired store — [ADR-008](./008-client-bearer-auth.md)) no ACL applies: every configured alias is addressable; with the runtime store wired the gate mounts fail-closed, so every request that reaches the dispatch carries a client and the ACL always applies.
- Resolution selects one route of the alias's entry with the entry's `balance.strategy` — `round-robin` rotates the routes in config order; `weighted-round-robin` rotates a schedule where each route appears `weight` times (proportional over every full cycle, deterministic within it). The selected route names the upstream (resolved through the registry) and the provider-native model id that replaces `body.model` — still the only body transformation (D3).
- `GET /llm/v1/models` stops aggregating upstreams entirely. It serves the gateway's own alias catalog — client-scoped when a clients block is configured — with every entry shaped `{ id: alias, object: "model", created: <process start epoch>, owned_by: "llm-gateway" }`. Upstream catalogs remain visible to operators through the live listing on `/api/*` ([ADR-011](./011-management-live-model-listing.md), its `discover=1` variant per [ADR-016](./016-discover-folded-into-live-listing.md)); the retained startup snapshot feeds the metadata seed and the route inventory, not an HTTP read.
- The routing core (`src/gateway/router.ts`) is a startup-built alias table (`createRoutingTable(models, registry)`) with per-alias rotation state; the table is immutable after construction, a runtime models mutation rebuilds and atomically swaps the whole table ([ADR-014](./014-runtime-management-crud.md)), and a request only advances a counter.

The alias grammar is `/^[^\s/]+$/`: `/` is reserved so a model id is a single URL path segment.

## Consequences

Positive:

- The client-visible namespace is decoupled from connection topology: renaming an upstream, re-balancing routes, or adding a provider is invisible to clients as long as the alias stays.
- Per-client authorization is enforced end to end: an authenticated client can address only the aliases its config entry lists — 404 vs 403 distinguishes "does not exist" from "exists but not for you".
- Balancing becomes a per-alias property with an explicit strategy, instead of one-fixed-route-per-name.
- `/llm/v1/models` is a config read: no request-time upstream contact on the LLM surface at all, and it cannot degrade.

Negative:

- The alias catalog is hand-maintained: exposing a new upstream model requires a config edit — the catalog never mirrors upstream listings automatically.
- The 403 answer reveals, to an authenticated client, that a forbidden alias exists; the message names the model and nothing else (never the client's full alias list).

## Alternatives Considered

- **Prefix the upstream id onto model names and layer ACLs on top** (`clients[].models` listing `{upstreamId}/{model}` ids): rejected — it couples the per-client lists to internal topology (an upstream rename breaks every client entry), keeps the aggregate-list self-description at the cost of leaking provider ids, and leaves balancing without a home in the model id.
- **Fallback to the topology-derived id when the alias is unknown** (dual-mode resolution): rejected — two resolution semantics on one surface double the failure modes and make `model_not_found` ambiguous; a clean cut is possible pre-release (the ADR-005 namespace precedent).
- **Smooth weighted round-robin (nginx-style per-route counters):** rejected for the MVP — the weight-expanded schedule is deterministic, trivially correct, and per-cycle proportional; smooth WRR's finer interleaving buys nothing at gateway route counts and is harder to test.
- **Random / least-outstanding-cost route selection:** rejected — config states round-robin strategies only; non-deterministic selection is untestable without seed injection and hides route health problems that rotation makes visible.
