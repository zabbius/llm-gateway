# Model Metadata (alias limits and capabilities)

## Purpose

Detects per-model facts — context window, output limit, tool calling, reasoning, temperature, attachments — from raw upstream `/models` listings and folds them, with the operator's manual `limits`, into one client-facing metadata record per configured alias. The detector chain is the 1:1 TypeScript port of the c0wrk first-wins detectors ([ADR-012](../decisions/012-alias-model-metadata.md)); the raw listings come from discovery at start plus on-demand refreshes — the live listing's `discover=1` query parameter ([ADR-011](../decisions/011-management-live-model-listing.md) as amended by [ADR-016](../decisions/016-discover-folded-into-live-listing.md)) and the management CRUD's upstream writes, whose blocking probes seed or clear the affected slice — and the aggregate projects onto the client catalog and the management models reads (`meta`, [gateway-management.md](../contracts/gateway-management.md)) — advisory data the gateway never enforces.

## Key Files

- `src/gateway/modelmetadata.ts` — the first-wins detector chain over one raw listing entry (pure, zero imports); the field contract below
- `src/gateway/metastore.ts` — the per-upstream raw snapshot store: `seed` at start, wholesale `set` on success, retain-last-good on failure, `clear` when an upstream's slice must stop serving (a failed CRUD probe, a replaced instance, a delete)
- `src/gateway/aliasmeta.ts` — `buildAliasMetadata`: the min-rule, the strict AND, the manual-`limits` fold, frozen output
- `src/httpapi/handlers/models.ts` — the catalog projection (`limit` / `capabilities` / `modalities`, absent-when-unknown)
- `src/httpapi/handlers/model-aliases.ts` — the management models CRUD: every managed entry carries `meta`, the aggregate folded per read from the store's current slice ([ADR-014](../decisions/014-runtime-management-crud.md) D4 — `meta` moved here from the retired status inventory)
- `src/httpapi/handlers/upstream-models.ts` — the live listing with its `discover=1` metadata-slice swap (one `listModels()` within the probe budget, retain-last-good wholesale swap before the answer, [ADR-016](../decisions/016-discover-folded-into-live-listing.md))
- `src/httpapi/handlers/upstreams.ts` — the CRUD hot-apply that seeds or clears the affected slice from the blocking probe's outcome ([ADR-014](../decisions/014-runtime-management-crud.md) D8)
- `src/config/schema.ts` — the optional `models[].limits` block (validation, normalization, redacted view)
- `src/upstreams/openai-compatible.ts` — the two-leg startup probe (standard `GET {baseUrl}/models` + LM Studio native leg, merged native-first) that seeds the store, and the single-leg `listModels()` fetch the `discover=1` listing races
- `src/index.ts` — wiring step [4c]: store construction + `seed(registry.status())` after the probes resolve

## Core Types

```ts
/** Partial metadata for one model; "0 == undeclared" on both numbers. */
interface ModelMetadata {
  contextWindow: number;
  outputLimit: number;
  capabilities?: ModelCapabilities;   // absent → inherit
}

interface ModelCapabilities {
  attachment: boolean;                // image/* or application/pdf input declared
  reasoning: boolean;
  temperature: boolean;
  toolCall: boolean;
}

/** One alias's client-facing metadata; an absent field is unknown, not zero. */
interface AliasMetadata {
  contextWindow?: number;             // smallest context window any route can serve
  outputLimit?: number;               // smallest output limit any route can serve
  capabilities?: ModelCapabilities;   // present only when every route fully declared
}

/** The `meta` key of one managed `GET /api/models` entry — JSON null where unknown. */
interface ManagedAliasMeta {
  contextWindow: number | null;
  outputLimit: number | null;
  capabilities: ModelCapabilities | null;
}

/** The operator's manual ground truth — positive integers, tokens. */
interface ModelLimitsConfig {
  context?: number;
  output?: number;
}
```

`MetadataStore` (raw per-upstream `ModelEntry[]` snapshots, `seed`/`set`/`entries`) is typed in [routing.md](./routing.md) "Alias metadata" together with `buildAliasMetadata` and `detectModelMetadata`.

## Behavior

### The detector field contract (1:1 with the c0wrk chain)

`detectModelMetadata(entry)` runs the chain most-specific shape first — **LM Studio → aggregator → OpenAI standard** — and the first matching detector's metadata wins wholesale; a non-object entry and every unmatched shape decline to `undefined`. Chain-wide rules: every number is flatly "0 == undeclared"; no detector ever emits a negative; detectors never pin identity dimensions, so unset fields inherit from aggregation rather than fabricating.

| Detector | Matches on | Fields read | Notes |
| -------- | ---------- | ----------- | ----- |
| LM Studio native (`detectLmStudioMetadata`) | attempts on every object | `loaded_context_length`; `loaded_instances[].config.context_length` (first > 0 wins); `max_context_length` | runtime window first — a non-positive `loaded_context_length` is *unset*, not a decline, so the advertised capacity below still applies; `max_context_length` is claimed only while `max_model_len` is absent/0 (the standard detector owns its priority); outputLimit always 0; no capabilities |
| Aggregator-shaped (`detectAggregatorMetadata`) | `limit.context > 0` — otherwise declines | `limit.context`; `limit.output`; `capabilities.tools.supported`; `capabilities.reasoning.supported`; `capabilities.temperature`; `modalities.input` | output floors at 0, and a declared output ≥ context is contradictory data → 0 (undeclared); capabilities are emitted **only on a full declaration**: the `tools` and `reasoning` sub-objects, the `modalities` block, and the `temperature` key present as a boolean — a partial declaration inherits (omission must not masquerade as authoritative `false`); `attachment` = any `image/*` or `application/pdf` in `modalities.input` |
| OpenAI standard (`detectOpenAIStandardMetadata`) | attempts on every object | first non-zero of `max_model_len` → `max_context_length` → `context_length` | a negative value in the priority chain decides (and declines the entry) instead of promoting a later field; outputLimit 0; no capabilities |

### Aggregation rules (per alias, over its configured routes)

- Each route contributes what the chain finds in its upstream's current snapshot, matched by **exact provider-native model id**; a route with no snapshot, no matching id, or an undetectable shape contributes nothing.
- **Limits — the min-rule:** `contextWindow` / `outputLimit` are the element-wise minimum over the routes that declared the dimension, then the minimum with the entry's manual `limits` value when one is configured. The alias can land on any route, so its honest budget is the smallest budget any route (or the operator) can serve; manual values join the min — they can only lower it, and a manual-only alias still produces a record ([ADR-012](../decisions/012-alias-model-metadata.md)).
- **Capabilities — strict AND:** a flag is true only when every route fully declared it true; one route without a full declaration — or without any metadata — leaves the alias's capabilities undeclared. When every route fully declares, the AND is authoritative and `false` flags are emitted as `false`.
- An alias with not a single known dimension gets no record at all — absent means unknown, never a fabricated zero or an all-false block. The builder is pure, contacts no upstream, never mutates the store, and returns a frozen table (records, capability blocks, and the map's mutators).

### Surface shapes (both folds run per request, read-only, no upstream contact)

- **The client catalog** (`GET /llm/v1/models`, [client-gateway.md](../contracts/client-gateway.md)): an alias with a known context window gains `limit: { context, output }` — `context` positive, `output` `0` when the output limit is not declared (the "0 == undeclared" wire contract); the pair `capabilities` (`tools.supported`, `reasoning.supported`, `temperature` verbatim) + `modalities` (`input`: `["text"]`, plus `"image/png"` when image input is declared) appears only together, only on the full four-flag declaration the strict AND yields. An alias without metadata serializes byte-for-byte as the bare four-key OpenAI entry; the extra keys follow the base keys so the serialization order is stable.
- **The management surface** (`GET /api/models` and its single-entry read, [gateway-management.md](../contracts/gateway-management.md)): every managed alias entry carries `meta` — `{ contextWindow, outputLimit, capabilities }` with JSON `null` where the aggregate is unknown and the strict-AND four-flag object verbatim where declared, folded from the store's *current* slice against the store's current `models` block. `meta` moved here from the retired `GET /api/status` inventory ([ADR-014](../decisions/014-runtime-management-crud.md) D4). The SPA renders the values read-only ([frontend.md](./frontend.md)).
- Both folds read the store's *current* slice: a successful `discover=1` listing — or an upstream CRUD write whose blocking probe retained a catalog — is visible on the next read; a failed one changes nothing (retain-last-good).

### Discovery (where the snapshots come from)

- **At start** (wiring step [4c]): `MetadataStore.seed(registry.status())` folds every ok startup probe's retained catalog in as that upstream's initial snapshot; failed probes — and ok probes whose upstream retains no catalog — seed nothing.
- **On demand** — two writers, both explicit and both behind the session gate ([ADR-014](../decisions/014-runtime-management-crud.md)):
  - the live listing's `discover=1` query parameter — `GET /api/upstreams/:id/models?discover=1` ([ADR-011](../decisions/011-management-live-model-listing.md) as amended by [ADR-016](../decisions/016-discover-folded-into-live-listing.md); the former `POST /api/upstreams/:id/discover` mount is removed) — one `listModels()` call on the named upstream within the startup probe budget (the listing races its own budget around the interface call, which names no concrete upstream module), no retries; an unknown id is the `404` envelope before any contact. A success swaps the fresh listing in wholesale (an empty listing is a fact, not a failure) before answering `{ upstream, models, fetchedAt }` and logs an info line; a rejection or the expired budget leaves the store untouched (retain-last-good), answers the `502` `upstream_error` envelope with the log-safe reason, and logs a warn.
  - the management CRUD's upstream writes ([ADR-014](../decisions/014-runtime-management-crud.md) D8): a create or update runs the startup-style blocking probe within the same budget — the probe's outcome is data in the write answer (`{ upstream, probe }`), never a cancellation — and its retained catalog seeds the fresh slice on an ok probe; a failed probe, a retained-nothing probe, a delete, or a replaced instance clears the slice (the write replaced the instance the old snapshot described).
- **Snapshot richness:** the startup seeding and the CRUD-probe seeding carry the `openai-compatible` upstream's **two-leg** probe — the standard `GET {baseUrl}/models` leg and the LM Studio native leg merged native-first by exact id (native failures are silently skipped) ([openai-compatible.md](./upstreams/openai-compatible.md)). The `discover=1` listing stores the upstream's `listModels()` answer — for `openai-compatible` that fetch is the **standard leg alone**, so a refresh trades the native-leg extras for the one mandatory interface method every upstream type implements; the upstream's optional `discover()` two-leg re-probe exists on the contract but no management mount consults it.

```
startup:   registry probes resolve
             └─ MetadataStore.seed(registry.status())
                  └─ ok probe + retained catalog → that upstream's initial snapshot
operator:  GET /api/upstreams/:id/models?discover=1
             └─ 404 before contact; one listModels() within the probe budget
                  ├─ ok     → set(id, listing): wholesale swap (empty listing = a fact)
                  │           then 200 { upstream, models, fetchedAt }
                  └─ failed → store untouched (retain-last-good); 502 envelope
CRUD:      upstream create/update ── probe ok + retained catalog ── set(id, catalog)
                              └─ otherwise (failed probe, delete) ── clear(id)
per request (pure folds, no upstream contact):
  detectModelMetadata(raw entry)      — LM Studio → aggregator → standard, first wins
  buildAliasMetadata(models, store)   — limits: min over routes → min with the manual limits
                                      — capabilities: strict AND, undeclared kills the alias's block
             ├─ GET /llm/v1/models → entry.limit / entry.capabilities / entry.modalities (absent when unknown)
             └─ GET /api/models    → entry.meta: { contextWindow|null, outputLimit|null, capabilities|null }
```

## Invariants

- Numbers on detected metadata are flatly "0 == undeclared"; the management surface reports JSON `null` for unknown dimensions; no surface fabricates a value — absent/null always means unknown, and a `false` capability flag is emitted only when every route fully declared it false.
- The detector chain, the builder, and both surface folds are pure: they contact no upstream, read no files, and never mutate the store. The store's only writers are `seed()` (startup), the `discover=1` listing's wholesale swap, and the CRUD hot-apply's seed-or-clear of the affected upstream's slice ([ADR-014](../decisions/014-runtime-management-crud.md) D8).
- A failed refresh never changes what any surface serves (retain-last-good); a successful one replaces the snapshot atomically and wholesale — an empty listing is a fact, not a failure.
- Limits aggregate as the element-wise minimum over declaring routes and then with the manual `limits`; capabilities aggregate as the strict AND gated by full declaration; an alias with no known dimension has no metadata record at all.
- Metadata is advisory ([ADR-012](../decisions/012-alias-model-metadata.md)): no endpoint enforces, truncates, or rewrites a request or response payload because of it.
- No metadata payload — catalog fields or a managed entry's `meta` — can carry credential material.

## Configuration

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `models[].limits.context` | positive integer (tokens) | — (absent → detection only) | The operator's ground truth for the alias's context window; joins the min-rule as one more declaring source |
| `models[].limits.output` | positive integer (tokens) | — (absent → detection only) | Same for the maximum output |

A present block must be an object carrying at least one of the two keys, both positive integers; unknown keys and an empty block are rejected at startup and by every runtime mutation alike (the store runs the same grammar, [configuration.md](./configuration.md)). The block is not secret: the management models CRUD mirrors it verbatim ([gateway-management.md](../contracts/gateway-management.md)).

## Extension Points

- **A new listing shape:** add a detector to the chain in `src/gateway/modelmetadata.ts`, most-specific position first; keep the "0 == undeclared" and no-negative contract and extend the ported test table rather than special-casing consumers.
- **A new upstream type:** implement `listModels()` — the listing's `discover=1` swap and the CRUD blocking probes reuse it, so the new type is discoverable with no further wiring ([upstream-contract.md](./upstreams/upstream-contract.md)); the optional `discover()` two-leg re-probe is an implementation choice no management mount consults.
- **Enforcement:** if the gateway is ever to enforce limits (reject, truncate, count tokens), that is a new ADR — metadata stays advisory until one exists.

## Related Specs

- [routing.md](./routing.md) "Alias metadata" — the routing-domain view: the store/builder types in context of dispatch and the endpoint map
- [ADR-012](../decisions/012-alias-model-metadata.md) — this domain's decision record (detector port, discovery model, min-rule, capability-AND, informativeness)
- [ADR-014](../decisions/014-runtime-management-crud.md) — the runtime CRUD that reshaped the refresh paths: the CRUD probes' seed/clear (D8); its D4 refresh is the listing's `discover=1` swap per [ADR-016](../decisions/016-discover-folded-into-live-listing.md)
- [ADR-011](../decisions/011-management-live-model-listing.md) — the boundary posture of an operator-triggered live upstream call (the listing)
- [ADR-016](../decisions/016-discover-folded-into-live-listing.md) — the discovery folded into the listing's `discover=1` query parameter
- [gateway-management.md](../contracts/gateway-management.md) — the managed entries' `meta` key and the listing's `discover=1` swap on the management boundary
- [client-gateway.md](../contracts/client-gateway.md) — the catalog entry's optional metadata fields
- [configuration.md](./configuration.md) — the `limits` schema and its validation
- [upstreams/openai-compatible.md](./upstreams/openai-compatible.md) — the two-leg startup probe behind the seeded slices
- [frontend.md](./frontend.md) — the SPA's read-only `meta` rendering
