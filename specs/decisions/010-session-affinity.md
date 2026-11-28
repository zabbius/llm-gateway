# ADR-010: Session affinity on the completion surface

## Status

Accepted

## Context

With alias-table routing ([ADR-009](./009-alias-table-routing.md)) and the route balancer (`specs/domains/load-balancing.md`), consecutive requests for one alias rotate across its routes. Some upstream workloads are session-shaped: conversation context cached at a provider, per-route warm state, or paid session establishment. Clients cannot get continuity from a rotation that changes routes per request, but sticky routing must not fight the health machinery (a session must never be pinned to a failing route) and must not extend the OpenAI-protocol surface with new response fields or endpoints.

## Decision

Completion requests may carry a **session-affinity key**, resolved in fixed priority:

1. the `X-Session-Id` request header, when present and non-empty;
2. else the OpenAI `user` request body field, when a non-empty string;
3. else no key — the request is served by the pure balancer choice.

A key binds to the route that served it: **every success re-binds** key → route; a **pre-first-byte failure on the bound route releases the binding**, so the request migrates with failover and re-binds wherever it lands. A sticky pick is an actual selection: it requires the bound route to be eligible (not tried in this request, healthy per the breaker) and advances the rotation pointer like any other pick; an ineligible bound route falls through to the strategy schedule without dropping the binding.

Bindings live only in memory, in an LRU map bounded at `AFFINITY_MAX_ENTRIES = 10_000` entries across all aliases (module constant in `src/gateway/balancer.ts`) — client-supplied keys cannot grow it without bound — and **die on restart**: affinity is a best-effort optimization, never a guarantee, and the gateway advertises no session semantics beyond sticky-while-possible.

The `X-Session-Id` header is recognized at the gateway edge; it is not in the drop list and crosses into the upstream layer best-effort like any other client header — the openai-compatible upstream's outbound whitelist relays only `Content-Type`/`Accept` to the provider, so the header never reaches a provider ([gateway-upstream.md](../contracts/gateway-upstream.md)).

## Consequences

Positive:

- Session-shaped workloads get same-route continuity while every health, cooldown, and failover rule of the balancer stays in force.
- No config keys, no new endpoints, no response changes: the surface addition is one recognized request header plus a documented `user` fallback.
- The LRU bound caps memory regardless of key cardinality or length.

Negative:

- Affinity is best-effort: restart, eviction, cooldown-driven skips, and failover silently move sessions; clients that require hard pinning cannot rely on it.
- Keyless requests and differently-keyed requests share the rotation, so affinity does not reserve route capacity.
- A client cycling many session ids can evict other clients' bindings (bounded impact: they simply re-rotate).

## Alternatives Considered

- **Cookie-based affinity (`Set-Cookie`)** — rejected: setting cookies is a response transformation on the OpenAI surface, exactly what `specs/contracts/client-gateway.md` forbids outside this contract; it would also split affinity between the LLM and management surfaces ([ADR-007](./007-management-cookie-auth.md) covers management auth only).
- **Client-IP hashing** — rejected: NAT/proxy setups collapse many clients into one address (over-stickiness) and mobile clients change addresses (false misses); the IP is also not something the OpenAI protocol exposes as a session concept.
- **Config-driven key fields (list of headers/fields to try)** — rejected for the MVP: no demonstrated need beyond the two OpenAI-native candidates; the fixed priority keeps the surface grammar stable. Promoting it to config later is a deliberate contract change (see Extension Points in `specs/domains/load-balancing.md`).
- **Consistent-hash ring over sessions** — rejected: it distributes keys across routes without honoring the balancer's health state, and the MVP has a single process; per-key LRU binding achieves stickiness with simpler failure semantics.

## Related Specs

- [Load balancing](../domains/load-balancing.md) — the balancer's affinity map, selection order, and invariants
- [Client <-> Gateway contract](../contracts/client-gateway.md) — the `X-Session-Id` header on the completion surface
- [ADR-009](./009-alias-table-routing.md) — the alias table whose routes the bindings point at
