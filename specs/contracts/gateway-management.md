# Contract: Management Clients <-> Gateway

## Boundary Rule

The management API is a strictly read-only observation surface mounted at `/api/*` (namespace: [ADR-006](../decisions/006-gateway-surface-namespace.md)): it reports gateway state (upstream probe outcomes, sanitized configuration) and never mutates it — no endpoint on this boundary writes config, restarts upstreams, or triggers any action. No key material ever crosses this boundary: `apiKey` and `tlsFingerprint` values are replaced by a fixed mask before serialization, and no request header, body, or query parameter can widen what is returned. The boundary serves any HTTP client in plain JSON — the SPA and alternative non-browser clients (curl, monitoring, scripts) consume it identically; there are no sessions and no browser-only affordances. Not allowed: write operations, credential exposure, provider (LLM) traffic on this prefix, or a second error format.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `GET /api/status` (HTTP) | `src/httpapi/handlers/status.ts` | SPA, operators, non-browser clients | Upstream health snapshot: every configured upstream with its startup-probe outcome, in config order |
| `GET /api/configuration` (HTTP) | `src/httpapi/handlers/configuration.ts` | SPA, operators, non-browser clients | Sanitized effective configuration: `listen`, `logLevel`, upstream entries with credentials masked |
| OpenAI error envelope (JSON schema) | `src/httpapi/errors.ts` | every client of this boundary | Single error shape for gateway-generated failures — the same mapper the LLM surface uses (see Error Propagation) |

`GET /api/status` → `200`:

```json
{
  "upstreams": [
    { "id": "openai-main", "type": "openai-compatible", "probe": "ok" },
    { "id": "vllm-local", "type": "openai-compatible", "probe": "failed", "reason": "connect timeout after 10000ms" }
  ]
}
```

- `upstreams[]` appears in config order; `id` and `type` mirror the config entries.
- `probe` is the retained startup-probe outcome: `"ok"` or `"failed"`. On `"failed"`, `reason` (string) states the failure fact (e.g. timeout, connection refused) and never echoes credential or config material; on `"ok"` the field is absent.

`GET /api/configuration` → `200`:

```json
{
  "listen": "127.0.0.1:8080",
  "logLevel": "info",
  "upstreams": [
    {
      "type": "openai-compatible",
      "id": "openai-main",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "[Configured]",
      "tlsFingerprint": "[Configured]"
    }
  ]
}
```

- `apiKey` is always the fixed mask literal `"[Configured]"` — the view's own constant (`CONFIGURED_MASK`, `src/config/redact.ts`), deliberately distinct from the logging layer's censor (`"[Redacted]"`, `REDACT_CENSOR`, `src/logging/logger.ts`) — so presence (a key is configured) is visible while the value never is.
- `tlsFingerprint` is the fixed mask when configured, `null` when absent; `baseUrl` is returned verbatim (it is not secret — every client request already carries it).

## Initialization

At startup the entry point builds the Hono app and mounts the management routes on the `/api/*` prefix **before** static serving is attached (`src/httpapi/app.ts`), alongside the LLM surface at `/llm/v1/*` ([client-gateway.md](client-gateway.md)) — the SPA mount can never shadow an `/api` route. The endpoints exist as soon as the listener is bound; they depend on no upstream being reachable: `GET /api/status` reads the probe outcomes the registry retained during startup (`src/upstreams/registry.ts`, step [5] of the startup flow in [data-flow.md](../architecture/data-flow.md)), and `GET /api/configuration` reads the already-validated in-memory config. Both answer even when every probe failed.

## Data Flow Across Boundary

Direction: client → gateway (`GET`, no request body), gateway → client (JSON `200`). Both responses are constructed from in-memory state — the retained probe outcomes and the parsed config — with no upstream calls and no file reads at request time. Serialization is the only transformation: credentials are masked by `redactedConfigView` (`src/config/redact.ts`) at the entry point, before the redacted view is handed to the HTTP layer — the handler serializes an already-masked value, so key material never reaches the response serializer. Given the same config and probe outcomes, both endpoints are deterministic; there is no per-request state.

```
client ── GET /api/status ────────────▶ gateway
gateway   registry: per-upstream retained probe outcome (no upstream contact)
client ◀─ 200 {"upstreams": [...]} ─── gateway

client ── GET /api/configuration ─────▶ gateway
gateway   redacted view built at the entry point (credentials masked in the config domain)
client ◀─ 200 {"listen", "logLevel", "upstreams": [...]} ─ gateway
```

## Error Propagation

Gateway-generated errors on this boundary use the OpenAI error envelope, produced by the single shared mapper `src/httpapi/errors.ts` — the management surface never defines a second error format (the mapper serves gateway-generated failures on `/llm/*` and `/api/*` alike; shape and status table: [client-gateway.md](client-gateway.md#error-propagation)). A request to an unknown `/api/*` path is answered `404` with the envelope; an unexpected handler failure maps to `502` `api_error` by the app's error middleware. No upstream failures propagate onto this boundary: both endpoints read only in-memory gateway state and never contact an upstream.

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Response shapes** (`upstreams[]` field names, the `probe` enum `"ok" | "failed"`, the `reason` presence rule, the `listen` / `logLevel` keys) — the SPA and every external consumer parse them. Any field add/rename/reshape updates this contract and the SPA consumers in the same change.
2. **The masking rule** (`apiKey` always the fixed mask `"[Configured]"`; `tlsFingerprint` mask-or-`null`) — weakening it in any way (partial reveal, conditional omission of the mask) exposes credential material and contradicts the security model ([security-model.md](../architecture/security-model.md)); it requires an ADR plus a security-model update, never a silent change.
3. **The read-only boundary rule** — adding a mutating endpoint (`POST`/`PUT`/`DELETE` on `/api/*`) changes the trust posture of the whole prefix: it requires an ADR and updates to [security-model.md](../architecture/security-model.md) and [data-flow.md](../architecture/data-flow.md) before implementation.
4. **The `/api/*` prefix itself** — fixed by [ADR-006](../decisions/006-gateway-surface-namespace.md); moving or re-prefixing it re-cuts every consumer and requires a new ADR first.
5. **New management endpoints** extend this contract first — the API spec leads, the UI follows ([frontend.md](../domains/frontend.md)) — and are mounted before static serving so the SPA never shadows them.
