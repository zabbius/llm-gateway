# ADR-011: Operator-triggered live model listing on the management surface

## Status

Accepted

## Context

The management boundary's contract states that its reads are constructed from in-memory state with no upstream contact at request time ([gateway-management.md](../contracts/gateway-management.md), Data Flow and Error Propagation). The upstream facts an operator sees passively are the startup probe outcomes and the frozen startup snapshot — both fixed at assembly ([upstream-contract.md](../domains/upstreams/upstream-contract.md)).

That staleness is an operator-facing gap: providers change their model lists (a provider ships a new model, a vLLM instance reloads with different weights), and a snapshot captured at startup — or at a CRUD mutation's blocking probe ([ADR-014](./014-runtime-management-crud.md) D8) — can silently drift away from what the provider answers today. Meanwhile the upstream interface already exposes the exact primitive the operator needs — `listModels()` ([upstream-contract.md](../domains/upstreams/upstream-contract.md)); no read-only management endpoint invokes it.

The ADR bar is met on the contradiction clause: this endpoint deliberately breaks the documented "reads never contact an upstream" invariant, so it is an ADR plus a contract rewrite, never a quiet edit. The invariant is not discarded — it is narrowed to explicit, enumerated exceptions.

## Decision

- **`GET /api/upstreams/:id/models`** — the operator-triggered live `listModels()` through the registry's exact-id lookup and the upstream interface only (no concrete upstream named outside the entry point, [layers.md](../architecture/layers.md)); its `?discover=1` variant additionally swaps the upstream's metadata slice wholesale before the answer ([ADR-016](./016-discover-folded-into-live-listing.md)). It answers `200` with `{ upstream, models, fetchedAt }`: the provider-native entries verbatim — no rewriting, no prefixing; the LLM surface's alias catalog is a different, client-scoped view ([ADR-009](./009-alias-table-routing.md)) — plus an ISO-8601 instant. No credential material can reach the body — the upstream attaches its own `apiKey` server-side, and model entries carry none.
- **The invariant wording (deliberate, in the same change as the endpoint):** "the management reads never contact an upstream" becomes "**the sanctioned request-time upstream contacts on this boundary are the enumerated operator-triggered live facilities**" — this listing (pure, and in its `discover=1` variant swapping the metadata slice, [ADR-016](./016-discover-folded-into-live-listing.md)) and the CRUD create/update blocking probes ([ADR-014](./014-runtime-management-crud.md)). Every other read (`GET /api/status`, the CRUD lists) and both auth actions stay strictly in-memory, and the trust posture is unchanged: every contact is explicit, authenticated, exact-id scoped, budgeted, single-attempt, and credential-free in both directions, and the frozen startup snapshot the passive reads report stays untouched by operator action.
- **Failure contract:** an unknown id is the `404` envelope, answered before any upstream contact; a failing listing — a `listModels()` rejection or the budget expiring — is the `502` `api_error` / `upstream_error` envelope from the single shared mapper, logged at warn as an expected outcome (a degraded upstream is exactly what an operator probes for). One attempt, no retries (the MVP stance, [gateway-upstream.md](../contracts/gateway-upstream.md)).
- **Timeout = the startup probe budget** (10s): an operator refresh must not hang for the forward budget a completions relay may legitimately take. The budget is enforced at the HTTP layer as a race around the interface call — the HTTP layer restates the constant rather than importing it from a concrete upstream module.
- **Behind the ADR-007 gate automatically:** a plain `GET` under `/api/*` with no exemption of its own — when `auth.enabled`, only a valid session reaches the handler ([ADR-007](./007-management-cookie-auth.md)).
- **API spec leads, UI follows** ([gateway-management.md](../contracts/gateway-management.md) Breaking Change Checklist item 5): the contract row and the SPA affordance for the listing ship together — the boundary never presents an endpoint its own operator UI cannot drive ([ADR-014](./014-runtime-management-crud.md) D5 applies the same rule boundary-wide).

## Consequences

Positive:

- Live, per-upstream model catalogs without a restart; the passive reads keep their zero-contact answers.
- On-demand degradation check: the `502` envelope is the operator's probe fact, symmetric with the startup probe's warn-and-continue outcome.
- The boundary stays safe by construction: every upstream contact is explicit, authenticated, exact-id scoped, budgeted, single-attempt, and credential-free in both directions.

Negative:

- A request on `/api/*` can reach out to a provider — any consumer of the boundary (script, monitor, SPA) can trigger provider traffic, not just the LLM surface.
- Upstream failures surface on the management boundary as a `502` response — the "no upstream failures here" property holds for every endpoint except the live facilities.
- Each operator refresh costs the named upstream one `/models` call; automated polling against the endpoint is client behavior the gateway neither performs nor bounds.

## Alternatives Considered

- **Serve only the startup snapshot (no live listing):** rejected — stale by design; freshness would require a process restart, which is precisely the operational friction being removed.
- **Gateway-side automatic refresh (background polling into the metadata store):** rejected — a strictly larger invariant breach: untriggered, periodic upstream contact from the management boundary, with freshness still bounded by the poll interval. The explicit operator action keeps every upstream contact deliberate and attributable.
- **Write live listings into the registry's retained startup snapshot** (a mutating refresh of the frozen facts): rejected — the retained snapshot is the route-inventory crosscheck's frozen baseline ([routing.md](../domains/routing.md)); operator-triggered writes would erase the very facts the crosscheck compares against. Fresh listings belong to the alias-metadata store's retain-last-good slices — exactly where this listing's `discover=1` swap ([ADR-016](./016-discover-folded-into-live-listing.md)) and the CRUD probes write ([ADR-014](./014-runtime-management-crud.md)).
- **Reuse the LLM surface (`GET /llm/v1/models`) and filter client-side:** rejected — the LLM catalog lists the gateway's aliases ([ADR-009](./009-alias-table-routing.md)), is client-ACL-scoped rather than upstream-scoped, and belongs to a different contract ([client-gateway.md](../contracts/client-gateway.md)); the operator needs the named upstream's native view.
- **Have the SPA call providers directly:** rejected — a browser cannot hold the upstream `apiKey`; forwarding provider credentials to the client would contradict the security model ([security-model.md](../architecture/security-model.md)).
