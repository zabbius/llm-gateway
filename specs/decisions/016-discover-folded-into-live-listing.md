# ADR-016: Discover folds into the live model listing

## Status

Accepted

## Context

The management surface carried two operator-triggered facilities over the same upstream call: the [ADR-011](./011-management-live-model-listing.md) live listing (`GET /api/upstreams/:id/models`, a pure read answering `{ upstream, models, fetchedAt }`) and the [ADR-014](./014-runtime-management-crud.md) D4 discover mount (`POST /api/upstreams/:id/discover`, the same one `listModels()` within the same probe budget, swapping the alias-metadata slice wholesale on success — retain-last-good on failure — and answering the always-200 report `{ upstream, ok, reason? }`). The UI surfaced them as two buttons per upstream card (Load models / Discover). The facilities share one fetch, one budget, and one goal — seeing the provider's current catalog — and the split only forced operators to click twice: first to see the listing, then to refresh the metadata the Models section's `meta` aggregate folds.

## Decision

The discover mount folds into the live listing as a query parameter:

- `GET /api/upstreams/:id/models?discover=1` performs the discovery before the answer: the fetched catalog swaps the upstream's alias-metadata slice wholesale (an empty listing included), retain-last-good on failure — a failed listing leaves the last good snapshot serving and surfaces as the endpoint's own `502` `upstream_error` envelope.
- Without the parameter the listing stays a pure read ([ADR-011](./011-management-live-model-listing.md) exactly).
- The `POST /api/upstreams/:id/discover` mount is removed; its always-200 `{ upstream, ok, reason? }` report and the UI's separate Discover button (and inline verdict) go with it. The SPA's Load models button is the one affordance, calling the listing with `discover=1`.

The listing's response shape is unchanged: `{ upstream, models, fetchedAt }`. This supersedes the discover-mount decision ([ADR-014](./014-runtime-management-crud.md) D4) and amends the [ADR-011](./011-management-live-model-listing.md) listing's "nothing here mutates gateway state" property: the `discover=1` variant's sanctioned metadata-store swap is the listing's one mutation.

## Consequences

- One button, one click: Load models both shows the catalog and refreshes the metadata minima the Models section folds on its next read.
- One failure path: a failing discovery surfaces as the listing's existing `502` envelope (the card's error state) instead of a separate verdict.
- The sanctioned request-time upstream contacts on `/api/*` shrink to the listing (pure and `discover=1`) and the CRUD blocking probes.
- `POST /api/upstreams/:id/discover` answers the `404` envelope for every method; the OpenAPI document loses the operation and documents the `discover` query parameter instead ([ADR-013](./013-openapi-docs-surface.md) mirror).

## Alternatives Considered

- **Keep both mounts** — rejected: two buttons and two endpoints over one fetch invited drift between them and made the metadata refresh an easy step to skip.
- **Always discover (no parameter)** — rejected: the Models section's route-row dropdown fetches the same endpoint on every editor visit; a metadata write per dropdown open would violate the boundary's no-untriggered-side-effect posture ([ADR-012](./012-alias-model-metadata.md) rejects background re-discovery for the same reason).
- **Discover verdict in the listing answer** (`{ ..., discover: { ok, reason? } }`) — rejected: the `502` envelope already names the failure, and a nested verdict would re-introduce the data-not-error duality the merge removes.
