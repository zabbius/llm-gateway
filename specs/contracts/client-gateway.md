# Contract: Client <-> Gateway

## Boundary Rule

External clients depend only on the gateway's OpenAI-compatible HTTP surface, mounted at `/llm/v1/*` — clients set their baseURL to `<host>/llm/v1` (surface namespace: [ADR-005](../decisions/005-gateway-surface-namespace.md)); the gateway depends on upstreams — never the reverse. Everything crossing this boundary is OpenAI protocol: no provider endpoints, no provider-native error formats, no provider SDK types are exposed to clients. The gateway is a pass-through: it rewrites only the `model` field of request bodies (alias → the selected route's provider-native model) and maps gateway-generated failures into the OpenAI error envelope — one shared mapper (`src/httpapi/errors.ts`) serves gateway-generated failures on `/llm/*` and `/api/*` alike (management surface: [gateway-management.md](gateway-management.md)). Clients MUST NOT rely on anything outside the OpenAI schema; the gateway MUST NOT add endpoints, response fields, or body transformations outside this contract without updating this document. This contract is mirrored, never replaced, by a machine-readable projection: the OpenAPI document at `GET /docs/openapi.json` ([ADR-013](../decisions/013-openapi-docs-surface.md), [api-docs.md](../domains/api-docs.md)) is generated at build time (`bun run apidocs`) from the wire-description tables — where the prose and the document disagree, this document wins and the projection is corrected in the same change.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `GET /llm/v1/models` (HTTP) | `src/httpapi/handlers/models.ts` | OpenAI-protocol clients | The gateway's alias catalog ([ADR-009](../decisions/009-alias-table-routing.md)): one entry per configured alias the caller may address, `owned_by` "llm-gateway" — no upstream is contacted; entries may carry the alias's aggregated metadata (`limit` / `capabilities` / `modalities`, [routing.md](../domains/routing.md)) |
| `POST /llm/v1/chat/completions` (HTTP) | `src/httpapi/handlers/completions.ts` | OpenAI-protocol clients | Chat completions; JSON body, or SSE stream when `"stream": true` |
| `POST /llm/v1/completions` (HTTP) | `src/httpapi/handlers/completions.ts` | OpenAI-protocol clients | Legacy completions; same body/stream rules as chat completions |
| OpenAI error envelope (JSON schema) | `src/httpapi/errors.ts` | OpenAI-protocol clients | Single error shape for every gateway-generated failure (unknown or forbidden model, upstream unreachable, missing/invalid client API key) |
| `handleModels` / `handleChatCompletions` / `handleCompletions` (route handlers) | `src/httpapi/handlers/` | HTTP router (internal) | Parse and validate the OpenAI request, resolve `model` against the routing table, enforce the per-client alias ACL, map errors per Error Propagation |

### Authentication (Bearer API key)

When the config carries a `clients` block, every `/llm/v1/*` request must present `Authorization: Bearer <apiKey>` with a key matching one configured client ([ADR-008](../decisions/008-client-bearer-auth.md)); the Bearer scheme is matched case-insensitively and the comparison is timing-safe (SHA-256 digests through `timingSafeEqual`, `src/httpapi/client-auth.ts`). A missing, foreign-scheme, or empty credential answers the 401 `authentication_required` envelope; an unknown key answers the 401 `invalid_api_key` envelope (Error Propagation below). Both answers are produced before any body read or upstream contact, never echo key material, and carry no `WWW-Authenticate` — OpenAI SDK clients configure the header statically. Without a `clients` block no gate mounts: the surface answers unauthenticated, exactly as before ADR-008. The gate authenticates the client only — it never forwards the header upstream (see Data Flow rules), and a client key is not a management session: it authenticates nothing on `/api/*` ([gateway-management.md](gateway-management.md)). The authenticated identity also scopes what the client may address: the per-client alias ACL (`clients[].models`) is enforced on every model id the client sends ([ADR-009](../decisions/009-alias-table-routing.md)).

### Model id scheme (alias)

The model id on this boundary is a configured **alias** — a `models[].alias` value from the gateway config ([ADR-009](../decisions/009-alias-table-routing.md)):

- An alias matches the grammar `^[^\s/]+$` (no whitespace, no `/` — a model id is a single URL path segment) and is unique across the config.
- Resolution is exact: the alias names one `models` entry, whose balance-selected route names the upstream and the provider-native model id that replaces `body.model` upstream. Whether the upstream actually knows that model name is the upstream's verdict — the request is forwarded regardless.
- A request `model` that is not a configured alias, or a configured alias the authenticated client is not allowed to address, never reaches an upstream — both are answered by the gateway itself (see Error Propagation).
- `GET /llm/v1/models` returns the OpenAI list shape over the gateway's own catalog — one entry per configured alias the caller may address, `created` fixed to the process start epoch, `owned_by` always "llm-gateway". An entry may additionally carry the alias-metadata projection ([routing.md](../domains/routing.md) "Alias metadata"), present only where the gateway's aggregate knows the dimension:

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o-fast",
      "object": "model",
      "created": 1712267047,
      "owned_by": "llm-gateway",
      "limit": { "context": 128000, "output": 16384 },
      "capabilities": { "tools": { "supported": true }, "reasoning": { "supported": false }, "temperature": true },
      "modalities": { "input": ["text"] }
    }
  ]
}
```

- The alias-metadata projection rules: `limit` (`{ context, output }`) appears only when the alias's aggregated context window is known — `context` is positive, `output` is `0` when the output limit is not declared (the wire contract's "0 == undeclared"); `capabilities` (`tools.supported`, `reasoning.supported`, `temperature`) appears together with `modalities` (`input`: `["text"]`, plus `"image/png"` when image input is declared) and only when every route of the alias made the full four-flag capability declaration — the strict AND, so an all-false block is authoritative when every route declared false. An alias with no known metadata serializes exactly the four base keys — unknown never serializes as a fabricated `0` or `false`. The projection is folded from in-memory state (the entry-point-seeded metadata store's current slice) on every request: no upstream is contacted, a successful discovery is visible on the next request, and a failed one changes nothing (retain-last-good).

### Session affinity (X-Session-Id)

A completion request may carry a session-affinity key ([ADR-010](../decisions/010-session-affinity.md)): the `X-Session-Id` request header when present and non-empty, else the OpenAI `user` body field when a non-empty string, else no key — keyless requests are served by the pure balancer choice. A keyed request is served, best-effort, by the route that served its earlier requests: every success re-binds the key, a pre-first-byte failure on the bound route releases it (the session migrates with failover and re-binds wherever it lands), and an unhealthy bound route is skipped for the request without dropping the binding. Bindings live in memory only, bounded (`AFFINITY_MAX_ENTRIES`, `src/gateway/balancer.ts`), and die on restart; a routing-table rebuild — a runtime models mutation hot-applied without a restart ([ADR-014](../decisions/014-runtime-management-crud.md) D9) — drops them together with the old build's route health, and keys re-bind wherever the next requests land — affinity is a routing optimization, never a guarantee: this contract adds only the recognized request header, with no response changes and no endpoint changes. The `X-Session-Id` header is still forwarded upstream best-effort (it is not in the drop list).

## Initialization

At startup the gateway process reads the JSON config, constructs the upstreams and the upstream registry (see [gateway-upstream.md](gateway-upstream.md#initialization)), then binds the HTTP listener and routes `GET /llm/v1/models`, `POST /llm/v1/chat/completions`, and `POST /llm/v1/completions` to the handlers above — the `/api/*` management routes mount on the same app before static serving ([gateway-management.md](gateway-management.md)). Until the listener is bound, the endpoints do not exist (connection refused). Config errors (unknown upstream `type`, duplicate `id`) abort startup — a degraded gateway never listens (see [security-model.md](../architecture/security-model.md)).

## Data Flow Across Boundary

Direction: client → gateway (request), gateway → client (response or stream). Three flows:

Non-streaming completion:

```
client ── POST /llm/v1/chat/completions {"model": "gpt-4o-fast", ...} ──▶ gateway
gateway   resolve alias → balance-selected route (upstream, upstreamModel);
          enforce the per-client alias ACL
gateway   body.model := route's provider-native model
gateway ── forward ──▶ upstream ──▶ provider      (see gateway-upstream.md)
gateway ◀─ upstream response ── upstream ◀─ provider
client ◀─ 200, upstream body byte-for-byte ── gateway
```

Streaming completion (`"stream": true`):

```
client ── POST ... {"stream": true} ──▶ gateway
gateway ── forward ──▶ upstream ──▶ provider
client ◀─ 200, Content-Type: text/event-stream ── gateway
client ◀─ SSE bytes forwarded verbatim, incl. `data: [DONE]` ── gateway
```

Model listing:

```
client ── GET /llm/v1/models ──▶ gateway
gateway   the gateway's alias catalog, filtered to the caller's aliases
          when a clients block is configured; each entry may carry the
          alias-metadata projection (limit / capabilities / modalities)
          folded from the metadata store's current slice
client ◀─ 200, { object: "list", data: [...entries...] } ── gateway
```

Rules that hold for every flow:

- Response bodies are forwarded unchanged. The MVP does not rewrite the response `model` field back into the alias — re-aliasing response payloads is a deliberate non-goal and a contract change if introduced.
- Streaming is a pure pass-through: the gateway does not parse or re-serialize SSE events, flushes every upstream chunk immediately (no whole-stream buffering), and aborts the upstream request when the client disconnects. See [openai-compatible.md](../domains/upstreams/openai-compatible.md).
- Only `Content-Type` and `Accept` carry a contract across this boundary; other client headers are forwarded best-effort, and hop-by-hop headers (`Connection`, `Transfer-Encoding`, …) are never forwarded. The `X-Session-Id` header is additionally read at the edge for session affinity ([ADR-010](../decisions/010-session-affinity.md), Session affinity below) and still forwarded best-effort. The client's `Authorization` header is not part of this boundary — it is dropped at the edge (next bullet).
- Authorization policy: when the `clients` block is configured, the client authenticates with `Authorization: Bearer <apiKey>` at the gateway edge ([ADR-008](../decisions/008-client-bearer-auth.md), Authentication above); the gate consumes that header, and it is never forwarded upstream. Without a `clients` block the header is simply dropped at the edge as before. In both modes the upstream authenticates with `Authorization: Bearer <apiKey>` taken from its own upstream config (see [gateway-upstream.md](gateway-upstream.md)) — client-supplied credentials never travel upstream.
- `GET /llm/v1/models` is answered entirely from the routing table's current build plus the in-memory alias-metadata fold (`buildAliasMetadata` over the metadata store's current slice, against the store's current `models` block): no upstream is contacted, so the endpoint cannot degrade — it lists config or the config was empty. With a clients block the list is scoped to the authenticated client's aliases ([ADR-009](../decisions/009-alias-table-routing.md)), and a runtime models mutation ([ADR-014](../decisions/014-runtime-management-crud.md)) is visible here on the next request without a restart.
- Request bodies are read under a hard size cap: the dispatch buffers the JSON to read `model`, so a body beyond the cap (`MAX_BODY_BYTES`, `src/httpapi/body.ts`) is answered 413 before any upstream contact and never reaches an upstream.

## Error Propagation

Every gateway-generated error is returned as an OpenAI-compatible error envelope with an HTTP status:

```json
{
  "error": {
    "message": "The model 'nope' does not exist",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

| Failure | Status | `error.type` | `error.code` | Source |
| ------- | ------ | ------------ | ------------ | ------ |
| `/llm/v1/*` with a configured `clients` block: no Bearer credential (missing header, foreign scheme, empty credential) | 401 | `authentication_error` | `authentication_required` | gateway ([ADR-008](../decisions/008-client-bearer-auth.md)) |
| `/llm/v1/*` with a configured `clients` block: Bearer key matches no configured client | 401 | `authentication_error` | `invalid_api_key` | gateway ([ADR-008](../decisions/008-client-bearer-auth.md)) |
| `model` is a configured alias the authenticated client is not allowed to address | 403 | `invalid_request_error` | none (`param: "model"`) | gateway ([ADR-009](../decisions/009-alias-table-routing.md)) |
| `model` is not a configured alias | 404 | `invalid_request_error` | `model_not_found` | gateway ([ADR-009](../decisions/009-alias-table-routing.md)) |
| Malformed JSON body / body without `model` | 400 | `invalid_request_error` | provider-style message, no `code` | gateway |
| Request body over the gateway's configured size cap (`server.maxRequestBodyBytes` — default 4 MiB, validated in `src/config/schema.ts`, enforced in `src/httpapi/body.ts`) | 413 | `invalid_request_error` | `request_too_large` | gateway |
| Management-surface CRUD delete whose target live configuration still references — an upstream named by a `models[].routes[]` entry, a model named by a client's alias ACL ([ADR-014](../decisions/014-runtime-management-crud.md) D6, no cascades) | 409 | `invalid_request_error` | `resource_in_use` | gateway ([gateway-management.md](gateway-management.md)) |
| Known upstream, upstream returned 4xx/5xx | upstream status | upstream value (proxied) | upstream value (proxied) | provider |
| Upstream returned non-JSON / empty error body | 502 | `api_error` | `upstream_error` | gateway-synthesized |
| Upstream unreachable, connect/response timeout (non-streaming) | 504 | `api_error` | `upstream_timeout` | gateway-synthesized |
| TLS verification failure on a pinned upstream (`tlsFingerprint` configured) | 502 | `api_error` | `upstream_tls_error` | gateway-synthesized |
| Every route of the addressed alias currently unhealthy (open cooldown, or its half-open probe in flight) | 503 | `api_error` | `upstream_unavailable` | gateway ([load-balancing.md](../domains/load-balancing.md)) |

Rules:

- The gateway never wraps an already-OpenAI-shaped upstream error in another envelope — upstream error status + body pass through byte-for-byte. A relayed 5xx or 429 additionally fails the route over to the alias's next eligible route first ([load-balancing.md](../domains/load-balancing.md)); the client sees that upstream failure only when no eligible route remains — relayed byte-for-byte then. Client-caused 4xx never trigger failover.
- `upstream_tls_error` exists only on pinned upstreams (a configured `tlsFingerprint` — [ADR-004](../decisions/004-per-upstream-tls-pinning.md)): the message states the fact of the pin mismatch and never certificate material; without a pin, a TLS failure maps to `upstream_timeout`.
- A mid-stream failure never becomes a JSON error: once the SSE response has started, only SSE bytes flow; the gateway ends the stream (aborts upstream, closes the response) and logs. JSON errors are possible only before the first byte of the response.
- The envelope mapper is shared across gateway surfaces: gateway-generated failures on the management prefix `/api/*` — the status probe, the runtime CRUD (its `400` validation answers and `409 resource_in_use` refusals included) — use the same shape via the same `src/httpapi/errors.ts` — see [gateway-management.md](gateway-management.md).
- No error responses on this boundary use any format other than the envelope above.

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Model id scheme (aliases, [ADR-009](../decisions/009-alias-table-routing.md))** is coupled to the `models` config block, the per-client ACL (`clients[].models`), `GET /llm/v1/models`' catalog, model lookup in the router, and every doc/config example. Changing the alias grammar, the resolution semantics, or the ACL rule requires updating this contract, [gateway-upstream.md](gateway-upstream.md) (the model-rewrite rule), [routing.md](../domains/routing.md), and README/config examples. The scheme is effectively irreversible once clients persist aliases — changing it passes the ADR bar (see META.md Update Protocol) and rewrites [ADR-009](../decisions/009-alias-table-routing.md) in place first.
2. **Endpoint set and paths (`/llm/v1/models`, `/llm/v1/chat/completions`, `/llm/v1/completions`)** — OpenAI clients hardcode protocol paths relative to a fixed baseURL, here `<host>/llm/v1`. The namespace split (LLM `/llm/v1/*`, management `/api/*`, SPA `/ui/*`) is fixed by [ADR-005](../decisions/005-gateway-surface-namespace.md), decided pre-release and cut in place: path edits are direct edits to the affected contracts (no aliases, no supersede chains), with the namespace decision itself recorded in the ADR. Adding, removing, or renaming endpoints — or moving the mount point post-release — passes the ADR bar and updates [data-flow.md](../architecture/data-flow.md) and this contract.
3. **Error envelope fields (`error.message` / `error.type` / `error.param` / `error.code`) and the status mapping table** — clients parse them; any change breaks every client and must update `src/httpapi/errors.ts` and this contract together.
4. **Authorization contract** (clients configured → Bearer required at the edge; the client `Authorization` never forwarded; upstream auth is the upstream's config `apiKey` — [ADR-008](../decisions/008-client-bearer-auth.md)) — changing the gate (scheme rules, 401 codes, the gating condition) or changing which credentials reach upstreams changes the security posture: update [security-model.md](../architecture/security-model.md) and [gateway-upstream.md](gateway-upstream.md) in the same change. The per-client alias ACL is enforced ([ADR-009](../decisions/009-alias-table-routing.md): 403 semantics, catalog scoping); relaxing or re-scoping it (e.g. requiring keys unconditionally, changing the 403 rule) is client-visible and passes the ADR bar first.
5. **Streaming pass-through rule** (no parsing, no buffering, verbatim bytes, disconnect aborts upstream) — replacing it with parsed/re-serialized streaming changes latency and backpressure behavior; update [openai-compatible.md](../domains/upstreams/openai-compatible.md) and this contract together.
6. **Response-body pass-through rule** (no `model` rewrite in responses) — introducing response transformations is a contract change: update this contract before implementing.
7. **Catalog entry shape** — the base four keys (`id`, `object`, `created`, `owned_by`) and the optional alias-metadata projection (`limit`, `capabilities`, `modalities`) are the routing domain's aggregate surfaced to clients: their presence rules, key names, or wire meanings (`0 == undeclared`, the full-four-flag gate) are pinned by this contract and [routing.md](../domains/routing.md) "Alias metadata" together — adding fields is additive, renaming or removing one, or changing when it appears, is client-visible and updates both documents in the same change.
8. **The machine-readable mirror** (`GET /docs/openapi.json` — [ADR-013](../decisions/013-openapi-docs-surface.md), [api-docs.md](../domains/api-docs.md)) — an OpenAPI projection of this contract generated at build time: any endpoint, shape, or status-mapping change above updates its `describeRoute` config, the `OPENAPI_ROUTES` row, and the zod schema in `src/httpapi/openapi.ts` in the same change, then `bun run apidocs` regenerates `dist/openapi.json` — the sync guard (document ≡ `OPENAPI_ROUTES` ≡ the mounted surface, `src/httpapi/openapi.test.ts`) fails until all three agree, and the prose contract stays authoritative wherever the projection disagrees.
