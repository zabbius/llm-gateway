# ADR-012: Alias model metadata — detected limits and capabilities

## Status

Accepted

## Context

Clients speaking the OpenAI protocol benefit from knowing a model's effective budget before spending it: the context window, the output limit, and whether tool calling, reasoning, temperature control, and attachments are supported. Providers publish these facts in their `/models` listings — but in diverging shapes: the OpenAI standard fields (`max_model_len` and self-hosted extensions), LM Studio's richer native REST API (`/api/v0/models`), and aggregator-style `{limit, capabilities, modalities}` entries. Meanwhile the gateway's alias table ([ADR-009](./009-alias-table-routing.md)) hides one or more routes behind a single client-facing alias, so no single upstream's numbers describe the alias: the balancer may land any request on any route.

Two building blocks already existed: the c0wrk deployment runs a field-tested first-wins detector chain over raw listing entries (`core/modelmetadata_detectors.go`), and the config gained a per-alias manual `limits` block as the operator's ground truth ([configuration.md](../domains/configuration.md)). The open questions were architectural, not mechanical: where do the raw snapshots come from and who may refresh them, how per-route facts fold into one alias record, what a failed refresh may cost, and whether the gateway enforces the numbers or merely publishes them.

The ADR bar is met: the decision is cross-cutting (config → upstreams → gateway core → both HTTP surfaces), hard to reverse once clients start consuming catalog fields, and every aggregation rule had a real alternative rejected as unsafe, not just different.

## Decision

1. **The detector chain is the c0wrk port, 1:1.** `src/gateway/modelmetadata.ts` reproduces the c0wrk first-wins chain verbatim in semantics — most-specific shape first (LM Studio → aggregator-shaped → OpenAI standard), the first matching detector's partial metadata wins wholesale, unmatched shapes decline to `undefined`. The flat contract stays exactly c0wrk's: numbers are "0 == undeclared", detectors never emit negatives, a declared output at or above the window is contradictory data treated as undeclared, and capabilities are emitted only on a **full declaration** (both `tools` and `reasoning` sub-objects, the `modalities` block, and a presence-checked boolean `temperature` key) — omission inherits rather than masquerading as authoritative `false`. The ported test table is c0wrk's test table. The field contract is normative in [model-metadata.md](../domains/model-metadata.md).
2. **Discovery at start, refresh on demand.** Raw per-upstream listings live in the metadata store, seeded once at startup from the ok probes' retained catalogs (`MetadataStore.seed`, wiring step [4c]); refresh is operator-triggered only — the live listing's `discover=1` variant `GET /api/upstreams/:id/models?discover=1` ([ADR-011](./011-management-live-model-listing.md) as amended by [ADR-016](./016-discover-folded-into-live-listing.md)) and the CRUD create/update blocking probes' seed-or-clear of the affected upstream's slice ([ADR-014](./014-runtime-management-crud.md) D8). No background polling, no per-request refresh: every upstream contact stays explicit and attributable.
3. **Retain-last-good on failure.** The store swaps a snapshot wholesale only on success — an empty listing is a fact ("provider lists zero models"), a failed discovery (rejection or budget expiry) mutates nothing, so a broken provider can only leave metadata stale, never degrade it.
4. **Limits aggregate by the min-rule.** `contextWindow` / `outputLimit` are the element-wise minimum over the routes that declared the dimension: the alias can land on any route, so its honest budget is the smallest budget any route can serve.
5. **Manual `limits` join the min, they do not override.** A configured `models[].limits` value participates in the same minimum as one more declaring source: a manual number can only lower the advertised budget, never raise it past what detection found, and a manual-only alias (no detected data at all) still works. The operator's ground truth bounds the aggregate; it does not outrank it.
6. **Capabilities aggregate by strict AND.** A flag is true only when every route fully declared it true; one route without a full declaration — or without any metadata — leaves the alias's capabilities undeclared (absent/null, not all-false). When every route fully declares, the AND is authoritative and `false` flags are emitted as `false`: an alias that can land on a non-tool route must not advertise tools.
7. **Metadata is informational.** The aggregate projects onto the client catalog (`GET /llm/v1/models` entries gain optional `limit` / `capabilities` / `modalities`, absent-when-unknown) and the management surface (the `meta` aggregate on every `GET /api/models` entry, JSON `null` where unknown, [ADR-014](./014-runtime-management-crud.md) D4). The gateway **enforces nothing** with it: no truncation, no rejection, no payload rewrite beyond the model-id rewrite it already performs — clients and operators read the numbers as advice.

## Consequences

Positive:

- Clients and the SPA can size prompts and pick models without probing providers themselves; richer listings (LM Studio native) are honored without the gateway growing per-provider knowledge — detectors match shapes, not vendors.
- Aggregation is safe by construction: min and strict AND can only under-promise; no discovery state can make the gateway advertise a budget or capability a route cannot serve.
- Freshness without surprise: snapshots refresh only when an operator triggers a refresh run, and a failed run costs nothing (retain-last-good).
- The metadata pipeline's reads are pure folds over in-memory state: detectors, store reads, and both projections never contact an upstream — only the explicit refresh runs (the listing's `discover=1` swap, the CRUD probes) write slices.

Negative:

- Advisory numbers can be stale or wrong; the gateway presents them as data, and clients must not treat them as a contract — enforcement is deliberately out of scope.
- Partial data is the common case: undeclared dimensions surface as absent catalog fields / `null` `meta` values, so consumers must handle unknowns.
- An operator-triggered refresh costs the named upstream one live `/models` call (one probe budget each); automated polling would be client behavior the gateway neither performs nor bounds.
- Two more wire fields on the catalog (`limit`, `capabilities`/`modalities`) are a de-facto client surface — changing their shapes later is a breaking-change item, not a refactor.

## Alternatives Considered

- **Write the gateway's own detection heuristics:** rejected — c0wrk's chain is field-tested against real provider listings; a divergent reimplementation would fork the field contract and silently split bug fixes. The port keeps one contract and one test table.
- **Enforce aggregated limits at the gateway** (reject oversized requests, truncate output, count tokens): rejected — the MVP is a pure proxy and token accounting is provider-specific machinery the gateway deliberately lacks; enforcement would also turn advisory data into a client-visible failure mode. Recorded as a possible future ADR, not a quiet addition.
- **Aggregate limits by max** (advertise the best route's numbers): rejected — the alias can land on any route; the max promises budgets the selected route may not honor. The min is the only answer that is true for every possible selection.
- **Manual `limits` override detection** (operator value replaces detected values): rejected — an override larger than reality would advertise unservable budgets, the exact failure the min-rule exists to prevent; joining the min keeps the operator in control (they can always lower) without letting config out-promise the providers.
- **Capabilities by OR or majority vote:** rejected — any relaxed fold can advertise a capability on a request the balancer serves by a route lacking it; that is a client-visible lie. Strict AND is the only safe fold, and the full-declaration gate is what keeps an undeclared route from voting as a (fabricated) `false`.
- **Background periodic re-discovery:** rejected — untriggered upstream contact from the management boundary contradicts the ADR-011 posture ([ADR-011](./011-management-live-model-listing.md) rejected exactly this for the retained snapshot); freshness stays explicit and attributable.
- **Store aggregated per-alias metadata instead of raw snapshots:** rejected — aggregates go stale the moment config or providers change, and per-alias storage would fork the fold logic from its refresh path; raw snapshots with a pure per-request fold keep one source of truth and make retain-last-good a one-line store rule.
- **Persist metadata to disk** (survive restarts): rejected — the gateway keeps no state beyond the config file; a restart re-seeds from fresh startup probes, which is exactly the freshness disk persistence would erode.
- **A separate discover mount with query-parameter targeting** (`POST /api/upstreams/:id/discover?target=…`): rejected — a target in the query string needs its own validation block (mutual exclusion, unknown/empty/duplicated keys → a `400` class the boundary otherwise lacks on this surface) and hides the target from `c.req.path`, so request-log lines could not distinguish runs without extra log fields; the target belongs in the path. The shipped form ([ADR-016](./016-discover-folded-into-live-listing.md)) keeps the path-carried target of the listing and folds the refresh into one boolean `discover=1` parameter — no target to validate, no new mount.
- **JSON-body targeting** (`{"upstream": "id"}` / `{"alias": "name"}`): rejected for the same `400`-class reason plus a body reader and cap path on mounts that otherwise read no body at all — the contract's "the refresh reads no body" wording stays intact.
