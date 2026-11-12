# ADR-006: Gateway Surface Namespace (`/llm/v1`, `/api`, `/ui`)

## Status

Accepted

## Context

The gateway has grown from a single-purpose OpenAI proxy into a host with three distinct HTTP surfaces: the LLM OpenAI protocol, a management API (upstream status, sanitized configuration — see [gateway-management.md](../contracts/gateway-management.md)), and the SPA ([frontend.md](../domains/frontend.md)). The MVP serves them interleaved at the root: LLM paths at `/v1/*`, the SPA at `/`. Nothing in that flat root namespace says which prefix speaks which protocol, the management API has no namespace of its own, and the SPA occupies `/` so it cannot own a route subtree for client-side navigation.

The path layout is effectively irreversible once clients depend on it: an OpenAI client's `baseURL` is baked into every deployment that uses the gateway (the same permanence that made model ids semi-stable in [ADR-002](./002-model-id-prefix-routing.md)). The gateway is pre-release with no users, so a clean cut of the namespace is possible now and will never be cheaper. Per the frontend rule ([frontend.md](../domains/frontend.md)), the API spec leads and the UI follows — this ADR fixes the server namespaces first; the SPA's routing scheme follows it.

The decision is scoped to the URL namespace only. The model-id prefix scheme `{upstreamId}/{model}` ([ADR-002](./002-model-id-prefix-routing.md)) is orthogonal and unchanged.

## Decision

One top-level prefix per surface, mounted on the Hono app (`src/httpapi/app.ts`):

- **LLM OpenAI surface: `/llm/v1/*`.** Clients set their baseURL to `<host>/llm/v1`; the endpoints are `GET /llm/v1/models`, `POST /llm/v1/chat/completions`, `POST /llm/v1/completions` ([client-gateway.md](../contracts/client-gateway.md)).
- **Management API: `/api/*`** at the root prefix — `GET /api/status`, `GET /api/configuration` ([gateway-management.md](../contracts/gateway-management.md)). Plain JSON, read-only, no session state: consumable by the SPA and equally by alternative non-browser clients.
- **SPA: `/ui/*` only.** Static assets mount under `/ui`; routes beyond `/ui/*` do not exist server-side — they are handled client-side by React. The root `/` serves a `302` redirect to `/ui`.

The cut is clean: no aliases, no compatibility shims, no redirects from the old `/v1/*` paths. Existing contracts are edited in place — pre-release, with owner approval — so no supersede chains are created, and [client-gateway.md](../contracts/client-gateway.md) documents the new paths directly.

## Consequences

Positive:

- Every surface owns an unambiguous prefix: routing, logging, and any future per-surface policy (auth, rate limits) key on the first path segment instead of path-by-path exceptions.
- OpenAI clients keep working unmodified behind one stable baseURL (`<host>/llm/v1`); a future OpenAI protocol version bump has room (`/llm/v2`).
- The management API is addressable by any HTTP client — monitoring, curl, scripts — without loading a browser or the SPA.
- The SPA owns its whole `/ui/*` subtree; deep links are real URLs resolved client-side, and the gateway never invents per-route server handling for them.
- New top-level namespaces can be added later without re-cutting any existing surface.

Negative:

- Every existing client config, doc example, and README snippet using `/v1/*` or the root-served SPA must change in this same release — done in place, since no users exist yet.
- The baseURL is no longer bare the host; OpenAI SDK users must configure the full `/llm/v1` prefix.
- A client bookmarking `/` now lands on a redirect instead of the SPA document — one extra round trip on the first visit.

## Alternatives Considered

- **Keep `/v1` at the root**: rejected — the root prefix would belong to one specific protocol family while management endpoints still need their own root anyway, leaving three surfaces interleaved at `/` with no separation rule; and an OpenAI protocol version bump would have no namespace room to move into.
- **Temporary aliases (`/v1/*` → `/llm/v1/*`)**: rejected — there are no existing clients to migrate (pre-release); aliases double the route table and every doc example, and removing an alias later is by definition the breaking change it was meant to avoid.
- **`/v1/gateway/*` for management endpoints**: rejected — it couples the management API's path space to the OpenAI protocol version; management is not OpenAI protocol and must not move when that protocol versions.
- **`/gateway/*` as the management prefix**: rejected — a second non-LLM top-level prefix fragments the machine-facing namespace; `/api/*` is the conventional, self-describing root for JSON management surfaces.
- **`/v1/status` (management under the OpenAI version prefix)**: rejected — it hides a management endpoint inside the LLM protocol's namespace, exactly the interleaving this ADR exists to remove.
- **`/ui/api/*` for management endpoints**: rejected — it couples the management API's lifetime and mount point to the SPA's; management must serve non-browser clients that never load the SPA.
- **Hash routing in the SPA** (SPA stays at `/`, views change `#/...` fragments): rejected — fragment routes are not real URLs: they are invisible to the server, unshareable as clean links, and keep the SPA glued to the root path this decision frees.
- **State-only navigation** (SPA views switch with no URL change): rejected — pages become unbookmarkable and unshareable; client-side routing over the reserved `/ui/*` subtree gives the SPA real URLs at zero server-side cost.
