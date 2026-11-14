# Contract: Client <-> Gateway

## Boundary Rule

External clients depend only on the gateway's OpenAI-compatible HTTP surface, mounted at `/llm/v1/*` — clients set their baseURL to `<host>/llm/v1` (surface namespace: [ADR-006](../decisions/006-gateway-surface-namespace.md)); the gateway depends on upstreams — never the reverse. Everything crossing this boundary is OpenAI protocol: no provider endpoints, no provider-native error formats, no provider SDK types are exposed to clients. The gateway is a pass-through: it rewrites only the `model` field of request bodies (prefix add/strip) and maps gateway-generated failures into the OpenAI error envelope — one shared mapper (`src/httpapi/errors.ts`) serves gateway-generated failures on `/llm/*` and `/api/*` alike (management surface: [gateway-management.md](gateway-management.md)). Clients MUST NOT rely on anything outside the OpenAI schema; the gateway MUST NOT add endpoints, response fields, or body transformations outside this contract without updating this document.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `GET /llm/v1/models` (HTTP) | `src/httpapi/handlers/models.ts` | OpenAI-protocol clients | Aggregated flat model list: entries from every upstream, each `id` rewritten to `<upstreamId>/<model>`, `owned_by` set to `upstreamId` |
| `POST /llm/v1/chat/completions` (HTTP) | `src/httpapi/handlers/completions.ts` | OpenAI-protocol clients | Chat completions; JSON body, or SSE stream when `"stream": true` |
| `POST /llm/v1/completions` (HTTP) | `src/httpapi/handlers/completions.ts` | OpenAI-protocol clients | Legacy completions; same body/stream rules as chat completions |
| OpenAI error envelope (JSON schema) | `src/httpapi/errors.ts` | OpenAI-protocol clients | Single error shape for every gateway-generated failure (unknown model, unknown upstream, upstream unreachable) |
| `handleModels` / `handleChatCompletions` / `handleCompletions` (route handlers) | `src/httpapi/handlers/` | HTTP router (internal) | Parse and validate the OpenAI request, delegate to the router + upstream registry, map errors per Error Propagation |

### Model id scheme (prefix)

The model id on this boundary is always `<upstreamId>/<model>`:

- `upstreamId` — the `id` of a configured upstream (see [gateway-upstream.md](gateway-upstream.md)), matching `[a-z0-9][a-z0-9-]*`.
- The **first** `/` is the separator; the remainder is the provider-native model id and is passed upstream verbatim.
- A request `model` without a `/`, or whose prefix does not match any configured upstream, never reaches an upstream — it is answered by the gateway itself (see Error Propagation).
- `GET /llm/v1/models` returns the OpenAI list shape; provider-provided entry fields pass through unchanged, except `id` (prefixed) and `owned_by` (set to `upstreamId`):

```json
{
  "object": "list",
  "data": [
    {
      "id": "openai-main/gpt-4o-mini",
      "object": "model",
      "created": 1712267047,
      "owned_by": "openai-main"
    }
  ]
}
```

## Initialization

At startup the gateway process reads the JSON config, constructs the upstreams and the upstream registry (see [gateway-upstream.md](gateway-upstream.md#initialization)), then binds the HTTP listener and routes `GET /llm/v1/models`, `POST /llm/v1/chat/completions`, and `POST /llm/v1/completions` to the handlers above — the `/api/*` management routes mount on the same app before static serving ([gateway-management.md](gateway-management.md)). Until the listener is bound, the endpoints do not exist (connection refused). Config errors (unknown upstream `type`, duplicate `id`) abort startup — a degraded gateway never listens (see [security-model.md](../architecture/security-model.md)).

## Data Flow Across Boundary

Direction: client → gateway (request), gateway → client (response or stream). Three flows:

Non-streaming completion:

```
client ── POST /llm/v1/chat/completions {"model": "openai-main/gpt-4o", ...} ──▶ gateway
gateway   strip prefix → model "gpt-4o"; look up upstream by prefix
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
gateway   fan out: listModels() on every upstream
client ◀─ 200, flat aggregated list, ids prefixed ── gateway
```

Rules that hold for every flow:

- Response bodies are forwarded unchanged. The MVP does not rewrite the response `model` field back into prefixed form — re-adding prefixes to responses is a deliberate non-goal and a contract change if introduced.
- Streaming is a pure pass-through: the gateway does not parse or re-serialize SSE events, flushes every upstream chunk immediately (no whole-stream buffering), and aborts the upstream request when the client disconnects. See [openai-compatible.md](../domains/upstreams/openai-compatible.md).
- Only `Content-Type` and `Accept` carry a contract across this boundary; other client headers are forwarded best-effort, and hop-by-hop headers (`Connection`, `Transfer-Encoding`, …) are never forwarded. The client's `Authorization` header is not part of this boundary — it is dropped at the edge (next bullet).
- Authorization policy: the client's `Authorization` header is dropped at the gateway edge and never forwarded upstream; the upstream authenticates with `Authorization: Bearer <apiKey>` taken from its own upstream config (see [gateway-upstream.md](gateway-upstream.md)). The gateway performs no client authentication in the MVP (see [security-model.md](../architecture/security-model.md)).
- `GET /llm/v1/models` degrades gracefully: an upstream that fails or errors contributes no entries (logged as a warning) while the rest of the list is still returned with status 200.
- Request bodies are read under a hard size cap: the dispatch buffers the JSON to read `model`, so a body beyond the cap (`MAX_BODY_BYTES`, `src/httpapi/body.ts`) is answered 413 before any upstream contact and never reaches an upstream.

## Error Propagation

Every gateway-generated error is returned as an OpenAI-compatible error envelope with an HTTP status:

```json
{
  "error": {
    "message": "The model 'nope/gpt-4o' does not exist",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

| Failure | Status | `error.type` | `error.code` | Source |
| ------- | ------ | ------------ | ------------ | ------ |
| `model` has no `/` or unknown `upstreamId` prefix | 404 | `invalid_request_error` | `model_not_found` | gateway |
| Malformed JSON body / body without `model` | 400 | `invalid_request_error` | provider-style message, no `code` | gateway |
| Request body over the gateway's size cap (`MAX_BODY_BYTES`, 64 MiB — `src/httpapi/body.ts`) | 413 | `invalid_request_error` | `request_too_large` | gateway |
| Known upstream, upstream returned 4xx/5xx | upstream status | upstream value (proxied) | upstream value (proxied) | provider |
| Upstream returned non-JSON / empty error body | 502 | `api_error` | `upstream_error` | gateway-synthesized |
| Upstream unreachable, connect/response timeout (non-streaming) | 504 | `api_error` | `upstream_timeout` | gateway-synthesized |
| TLS verification failure on a pinned upstream (`tlsFingerprint` configured) | 502 | `api_error` | `upstream_tls_error` | gateway-synthesized |

Rules:

- The gateway never wraps an already-OpenAI-shaped upstream error in another envelope — upstream error status + body pass through byte-for-byte.
- `upstream_tls_error` exists only on pinned upstreams (a configured `tlsFingerprint` — [ADR-005](../decisions/005-per-upstream-tls-pinning.md)): the message states the fact of the pin mismatch and never certificate material; without a pin, a TLS failure maps to `upstream_timeout`.
- A mid-stream failure never becomes a JSON error: once the SSE response has started, only SSE bytes flow; the gateway ends the stream (aborts upstream, closes the response) and logs. JSON errors are possible only before the first byte of the response.
- The envelope mapper is shared across gateway surfaces: gateway-generated failures on the management prefix `/api/*` (`/api/status`, `/api/configuration`) use the same shape via the same `src/httpapi/errors.ts` — see [gateway-management.md](gateway-management.md).
- No error responses on this boundary use any format other than the envelope above.

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Prefix scheme (`<upstreamId>/<model>`)** is coupled to `GET /llm/v1/models` aggregation, model lookup in the router, and every doc/config example. Changing the separator or the id grammar requires updating this contract, [gateway-upstream.md](gateway-upstream.md) (de-prefix rule), [routing.md](../domains/routing.md), and README/config examples. The scheme is effectively irreversible once clients persist prefixed ids — changing it passes the ADR bar (see META.md Update Protocol) and requires an ADR first.
2. **Endpoint set and paths (`/llm/v1/models`, `/llm/v1/chat/completions`, `/llm/v1/completions`)** — OpenAI clients hardcode protocol paths relative to a fixed baseURL, here `<host>/llm/v1`. The namespace split (LLM `/llm/v1/*`, management `/api/*`, SPA `/ui/*`) is fixed by [ADR-006](../decisions/006-gateway-surface-namespace.md), decided pre-release and cut in place: path edits are direct edits to the affected contracts (no aliases, no supersede chains), with the namespace decision itself recorded in the ADR. Adding, removing, or renaming endpoints — or moving the mount point post-release — passes the ADR bar and updates [data-flow.md](../architecture/data-flow.md) and this contract.
3. **Error envelope fields (`error.message` / `error.type` / `error.param` / `error.code`) and the status mapping table** — clients parse them; any change breaks every client and must update `src/httpapi/errors.ts` and this contract together.
4. **Authorization policy** (client header dropped at the edge; upstream auth is the upstream's config `apiKey`) — introducing gateway-side client authentication, or changing which credentials reach upstreams, changes the security posture: update [security-model.md](../architecture/security-model.md) and [gateway-upstream.md](gateway-upstream.md) in the same change.
5. **Streaming pass-through rule** (no parsing, no buffering, verbatim bytes, disconnect aborts upstream) — replacing it with parsed/re-serialized streaming changes latency and backpressure behavior; update [openai-compatible.md](../domains/upstreams/openai-compatible.md) and this contract together.
6. **Response-body pass-through rule** (no `model` rewrite in responses) — introducing response transformations is a contract change: update this contract before implementing.
