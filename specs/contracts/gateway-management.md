# Contract: Management Clients <-> Gateway

## Boundary Rule

The management API is a read-only observation surface mounted at `/api/*` (namespace: [ADR-006](../decisions/006-gateway-surface-namespace.md)): it reports gateway state (upstream probe outcomes, sanitized configuration) and never mutates it — the only two non-GET endpoints are the auth actions `POST /api/login` and `POST /api/logout` ([ADR-008](../decisions/008-management-cookie-auth.md)), which issue and revoke the operator session without touching anything the reads report. No key material ever crosses this boundary: `apiKey`, `tlsFingerprint`, and `auth.passwordHash` values are replaced by a fixed mask before serialization (the `server.tls` PEM paths pass verbatim — a path is not secret), and no request header, body, or query parameter can widen what is returned. When `auth.enabled` is true, every `/api/*` request except the two auth actions requires a valid session cookie and otherwise gets the `401` envelope. The boundary serves any HTTP client in plain JSON — the SPA and alternative non-browser clients (curl, monitoring, scripts) consume it identically: one login POST, then the cookie; there are no browser-only affordances (the login card is the SPA's, not the server's). Not allowed: write operations beyond the two auth actions, credential exposure, provider (LLM) traffic on this prefix, or a second error format.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `GET /api/status` (HTTP) | `src/httpapi/handlers/status.ts` | SPA, operators, non-browser clients | Upstream health snapshot: every configured upstream with its startup-probe outcome, in config order |
| `GET /api/configuration` (HTTP) | `src/httpapi/handlers/configuration.ts` | SPA, operators, non-browser clients | Sanitized effective configuration: the `server` block (`listen`, `tls`), `logLevel`, the `auth` state (mask), upstream entries with credentials masked |
| `POST /api/login` (HTTP) | `src/httpapi/auth.ts` | SPA, operators, non-browser clients | Exchange `{ user, password }` for a session cookie; the only way in when `auth.enabled` is true |
| `POST /api/logout` (HTTP) | `src/httpapi/auth.ts` | SPA, operators, non-browser clients | Revoke the presented session and expire the cookie; always `200` |
| Session auth gate (middleware) | `src/httpapi/auth.ts` | every `/api/*` request except the two auth actions | When `auth.enabled`: validate the session cookie, otherwise answer the `401` envelope ([ADR-008](../decisions/008-management-cookie-auth.md)) |
| OpenAI error envelope (JSON schema) | `src/httpapi/errors.ts` | every client of this boundary | Single error shape for gateway-generated failures — the same mapper the LLM surface uses (see Error Propagation) |

`GET /api/status` → `200`:

```json
{
  "upstreams": [
    { "id": "openai-main", "type": "openai-compatible", "probe": "ok" },
    { "id": "vllm-local", "type": "openai-compatible", "probe": "failed", "reason": "connect timeout after 10000ms" }
  ],
  "authenticated": false
}
```

- `upstreams[]` appears in config order; `id` and `type` mirror the config entries.
- `probe` is the retained startup-probe outcome: `"ok"` or `"failed"`. On `"failed"`, `reason` (string) states the failure fact (e.g. timeout, connection refused) and never echoes credential or config material; on `"ok"` the field is absent.
- `authenticated` states whether this request carries a valid session ([ADR-008](../decisions/008-management-cookie-auth.md)): `true` only behind a login — with auth enabled the gate admits only valid sessions, so reaching the handler proves the cookie; with auth off every request is anonymous (`false`). The SPA's mount probe reads it to keep the `Log out` control across page reloads.

`GET /api/configuration` → `200`:

```json
{
  "server": {
    "listen": "127.0.0.1:8080",
    "tls": { "enabled": true, "cert": "./tls/cert.pem", "key": "./tls/key.pem" }
  },
  "logLevel": "info",
  "auth": { "enabled": true, "user": "admin", "passwordHash": "[Configured]" },
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
- `server.listen` is the effective listener address after startup normalization; `server.tls` mirrors the config's `server.tls` block verbatim (`enabled`, PEM paths) and is JSON `null` when the config carries no `tls` block — paths are not secret ([ADR-007](../decisions/007-tls-listener-server-block.md)).
- `auth` is JSON `null` when the config carries no `auth` block; otherwise it mirrors the block: `enabled` verbatim, `user` verbatim (an operator login identifies, it does not authenticate — same reasoning as `baseUrl`; `null` when absent, allowed only while `enabled` is false) and `passwordHash` as the fixed mask when configured, `null` when absent. The hash value itself never crosses this boundary ([ADR-008](../decisions/008-management-cookie-auth.md)).

`POST /api/login` — request `{"user": "...", "password": "..."}` (`application/json` required):

- `200` → `{"authenticated": true}` with `Set-Cookie: llm_gateway_session=<token>` — `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` equal to the session TTL, `Secure` added when the listener serves TLS.
- `401` → the envelope (`authentication_error` / `invalid_credentials`) after a fixed delay; the message never reveals which half failed and never echoes the presented password.
- A non-JSON body or non-string `user` / `password` fields → `400` `invalid_request_error` immediately, without the delay — a malformed request is not a credential attempt.
- A body over the gateway's size cap (`MAX_BODY_BYTES`, `src/httpapi/body.ts`) → `413` `invalid_request_error` code `request_too_large`, also before any credential check.
- Sessions are in-memory: a 32-byte random token, absolute TTL 24h, a store bounded at 64 sessions (oldest evicted), cleared on restart — a restart logs every operator out ([ADR-008](../decisions/008-management-cookie-auth.md)).

`POST /api/logout`:

- `200` → `{"authenticated": false}` with the cookie expired; idempotent — `200` with a fresh expired cookie even when no valid session was presented.

Session gate (runs at the auth stage, before routing — [data-flow.md](../architecture/data-flow.md)):

- With `auth.enabled` true: every `/api/*` path except `POST /api/login` and `POST /api/logout` requires the session cookie; without a valid session the answer is the `401` envelope (`authentication_error` / `authentication_required`) with **no** `WWW-Authenticate` header — the SPA's login card is the only login affordance.
- With auth off (no `auth` block or `enabled: false`): no gate, no cookie checks — the boundary behaves exactly as before ADR-008. The gate never touches `/llm/v1/*`, `/ui/*`, or `/`.

## Initialization

At startup the entry point builds the Hono app and mounts the management routes on the `/api/*` prefix **before** static serving is attached (`src/httpapi/app.ts`), alongside the LLM surface at `/llm/v1/*` ([client-gateway.md](client-gateway.md)) — the SPA mount can never shadow an `/api` route. When `auth.enabled` is true, the entry point also injects the validated `auth` slice (login + password hash) into the auth gate — the only path by which the hash reaches the HTTP layer — and the gate wraps the management routes at the auth stage, before routing ([ADR-008](../decisions/008-management-cookie-auth.md)). The endpoints exist as soon as the listener is bound; they depend on no upstream being reachable: `GET /api/status` reads the probe outcomes the registry retained during startup (`src/upstreams/registry.ts`, step [5] of the startup flow in [data-flow.md](../architecture/data-flow.md)), and `GET /api/configuration` reads the already-validated in-memory config. Both answer even when every probe failed.

## Data Flow Across Boundary

Direction: client → gateway (`GET` without a body; the two auth actions carry a JSON body), gateway → client (JSON `200`, or the `401` envelope at the gate). The read responses are constructed from in-memory state — the retained probe outcomes and the parsed config — with no upstream calls and no file reads at request time; the auth actions read the in-memory auth slice and session store, also with no upstream calls. Serialization is the only transformation on the reads: credentials are masked by `redactedConfigView` (`src/config/redact.ts`) at the entry point, before the redacted view is handed to the HTTP layer — the handler serializes an already-masked value, so key material never reaches the response serializer. Given the same config and probe outcomes, the reads are deterministic; login/logout mutate only the session store.

```
client ── GET /api/status ────────────▶ gateway
gateway   registry: per-upstream retained probe outcome (no upstream contact)
client ◀─ 200 {"upstreams": [...]} ─── gateway

client ── GET /api/configuration ─────▶ gateway
gateway   redacted view built at the entry point (credentials masked in the config domain)
client ◀─ 200 {"server", "logLevel", "auth", "upstreams": [...]} ─ gateway

client ── POST /api/login {"user","password"} ─▶ gateway     (auth.enabled)
gateway   timing-safe verify against the configured hash; session stored in memory
client ◀─ 200 {"authenticated": true} + Set-Cookie ────────── gateway

client ── GET /api/* + Cookie ────────▶ gateway
gateway   session check at the auth stage, before routing
client ◀─ 200 | 401 envelope ─────────── gateway
```

## Error Propagation

Gateway-generated errors on this boundary use the OpenAI error envelope, produced by the single shared mapper `src/httpapi/errors.ts` — the management surface never defines a second error format (the mapper serves gateway-generated failures on `/llm/*` and `/api/*` alike; shape and status table: [client-gateway.md](client-gateway.md#error-propagation)). Auth failures join the same table: an unauthenticated `/api/*` request while `auth.enabled` (except the auth actions) maps to `401` `authentication_error` code `authentication_required`, a failed login to `401` `authentication_error` code `invalid_credentials` — both sent with no `WWW-Authenticate` header, and neither message reveals which credential half failed or echoes the presented password ([ADR-008](../decisions/008-management-cookie-auth.md)). A request to an unknown `/api/*` path is answered `404` with the envelope; an unexpected handler failure maps to `502` `api_error` by the app's error middleware. No upstream failures propagate onto this boundary: both reads and both auth actions touch only in-memory gateway state and never contact an upstream.

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Response shapes** (`upstreams[]` field names, the `probe` enum `"ok" | "failed"`, the `reason` presence rule, the `server` / `logLevel` / `auth` keys) — the SPA and every external consumer parse them. Any field add/rename/reshape updates this contract and the SPA consumers in the same change.
2. **The masking rule** (`apiKey` always the fixed mask `"[Configured]"`; `tlsFingerprint` mask-or-`null`) — weakening it in any way (partial reveal, conditional omission of the mask) exposes credential material and contradicts the security model ([security-model.md](../architecture/security-model.md)); it requires an ADR plus a security-model update, never a silent change.
3. **The read-only boundary rule** — `POST /api/login` and `POST /api/logout` are the only sanctioned mutations, granted by [ADR-008](../decisions/008-management-cookie-auth.md) (which updated [security-model.md](../architecture/security-model.md) and [data-flow.md](../architecture/data-flow.md) before implementation). Any further mutating endpoint (`POST`/`PUT`/`DELETE` on `/api/*`) changes the trust posture of the whole prefix: it requires a new ADR and those same spec updates before implementation.
4. **The `/api/*` prefix itself** — fixed by [ADR-006](../decisions/006-gateway-surface-namespace.md); moving or re-prefixing it re-cuts every consumer and requires a new ADR first.
5. **New management endpoints** extend this contract first — the API spec leads, the UI follows ([frontend.md](../domains/frontend.md)) — and are mounted before static serving so the SPA never shadows them.
6. **The session gate** (cookie name and attributes, the exempted `POST /api/login` / `POST /api/logout`, the `401` codes, the TTL/store constants) — the SPA login flow and every non-browser client depend on it. Any change updates this contract and [frontend.md](../domains/frontend.md) in the same change, and revisits [ADR-008](../decisions/008-management-cookie-auth.md) deliberately when it alters the mechanism itself.
