# Contract: Management Clients <-> Gateway

## Boundary Rule

The management API is mounted at `/api/*` (namespace: [ADR-005](../decisions/005-gateway-surface-namespace.md)) and serves both observation and — since [ADR-014](../decisions/014-runtime-management-crud.md) — runtime mutation of the gateway's three mutable config collections (`upstreams`, `models`, `clients`). The sanctioned mutations are exactly three kinds: the auth actions `POST /api/login` and `POST /api/logout` ([ADR-007](../decisions/007-management-cookie-auth.md)), which mutate only the in-memory session store; the runtime CRUD over the three collections, each mutation a `validate → persist → apply` pass through the runtime configuration store (`src/config/store.ts`) that writes `config.json` back (a sibling temp file plus an atomic same-directory rename) and only then hot-applies the change into the running gateway — the upstream registry, the routing table ([ADR-009](../decisions/009-alias-table-routing.md)), the client-key digests inside the LLM gate, and the alias-metadata store; and the metadata-store swaps — the live listing's `discover=1` run's retain-last-good snapshot swap ([ADR-016](../decisions/016-discover-folded-into-live-listing.md)) and the CRUD blocking probes' seed-or-clear of the affected upstream's slice. The sanctioned request-time upstream contacts are exactly the operator-triggered live listing `GET /api/upstreams/:id/models` ([ADR-011](../decisions/011-management-live-model-listing.md), its `discover=1` variant included — [ADR-016](../decisions/016-discover-folded-into-live-listing.md)) and the CRUD's synchronous create/update probes ([ADR-014](../decisions/014-runtime-management-crud.md) D8 — one probe budget, a failed probe is data in the answer, never a cancellation); every other read reports state the gateway already holds. Every mutation lands on disk before it lands in memory: a validation problem or a failed write leaves both untouched, so the config file stays the single source of truth a restart reconstructs everything from. No key material ever crosses this boundary on a read: `apiKey`, `tlsFingerprint`, and `auth.passwordHash` values are replaced by a fixed mask before serialization (the store's redacted view, `ConfigStore.view`, `src/config/redact.ts`), and no response ever carries a presented or stored credential; the per-upstream `proxy` URL is not key material (its grammar admits no userinfo, [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) and is served verbatim, `null` when absent. HTTP mutation bodies are the boundary's second credential ingress ([ADR-014](../decisions/014-runtime-management-crud.md): a created or updated key transits a request body into the same two places it exists via the config file — never a third): the transit runs under the session gate, the value never enters a log line, an error message, a validation problem line, or a response body, and an update that omits `apiKey` leaves the stored credential in place while the mask literal `[Configured]` is rejected as a credential value (D7). When `auth.enabled` is true, every `/api/*` request except the two auth actions requires a valid session cookie and otherwise gets the `401` envelope — the mutating endpoints inherit the gate automatically and have no exemption of their own. The boundary serves any HTTP client in plain JSON — the SPA and alternative non-browser clients (curl, monitoring, scripts) consume it identically: one login POST, then the cookie; there are no browser-only affordances (the login card is the SPA's, not the server's). Not allowed: mutations beyond the three sanctioned kinds, credential exposure on reads or in problem lines, LLM completion traffic on this prefix, or a second error format. The surface is described, never governed, by the machine-readable mirror: the OpenAPI document at `GET /docs/openapi.json` ([ADR-013](../decisions/013-openapi-docs-surface.md), [api-docs.md](../domains/api-docs.md)) projects these interfaces from the wire-description tables — a build-time artifact (`bun run apidocs` → `dist/openapi.json`) served statically — where the prose and the document disagree, this contract wins and the projection is corrected in the same change.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `GET /api/status` (HTTP) | `src/httpapi/handlers/status.ts` | SPA, operators, non-browser clients | Health probe: the fixed pair `{ status: "ok", authenticated }` — the SPA's mount probe round trip ([ADR-014](../decisions/014-runtime-management-crud.md) D3); every deeper fact (probe outcomes, the route inventory) stays in the startup log lines |
| `GET /api/upstreams` (HTTP) | `src/httpapi/handlers/upstreams.ts` | SPA, operators, non-browser clients | Every configured upstream through the store's redacted view, in config order — masks only |
| `POST /api/upstreams` (HTTP) | `src/httpapi/handlers/upstreams.ts` | SPA, operators, non-browser clients | Create: validate → persist → apply, then the blocking probe and registry swap ([ADR-014](../decisions/014-runtime-management-crud.md) D2/D8); answers the masked entry plus the probe outcome |
| `GET /api/upstreams/:id` (HTTP) | `src/httpapi/handlers/upstreams.ts` | SPA, operators, non-browser clients | One configured upstream, masked; unknown id → `404` envelope before anything else |
| `PUT /api/upstreams/:id` (HTTP) | `src/httpapi/handlers/upstreams.ts` | SPA, operators, non-browser clients | Update: same sequence with keep-existing credential semantics (D7); the id is immutable |
| `DELETE /api/upstreams/:id` (HTTP) | `src/httpapi/handlers/upstreams.ts` | SPA, operators, non-browser clients | Delete; `409` `resource_in_use` while any `models[].routes[]` entry still names the upstream (D6), `400` for the block's last entry; no cascades |
| `GET /api/upstreams/:id/models` (HTTP) | `src/httpapi/handlers/upstream-models.ts` | SPA, operators, non-browser clients | Operator-triggered live model list of the named upstream ([ADR-011](../decisions/011-management-live-model-listing.md) as amended by [ADR-016](../decisions/016-discover-folded-into-live-listing.md)): one `listModels()` call within the startup probe budget; `?discover=1` swaps the upstream's metadata slice wholesale before the answer (retain-last-good on failure) |
| `GET /api/models` (HTTP) | `src/httpapi/handlers/model-aliases.ts` | SPA, operators, non-browser clients | Every configured alias entry in config order, redacted view plus the `meta` aggregate folded from the metadata store's current slice — no upstream contact |
| `POST /api/models` (HTTP) | `src/httpapi/handlers/model-aliases.ts` | SPA, operators, non-browser clients | Create an alias entry (the [ADR-009](../decisions/009-alias-table-routing.md) grammar is the store's), then the routing-table rebuild; answers the created entry with its `meta` |
| `GET /api/models/:alias` (HTTP) | `src/httpapi/handlers/model-aliases.ts` | SPA, operators, non-browser clients | One configured alias entry with its `meta`; unknown alias → `404` |
| `PUT /api/models/:alias` (HTTP) | `src/httpapi/handlers/model-aliases.ts` | SPA, operators, non-browser clients | Update: `routes` / `balance` / `limits` replaced wholesale (a `null` limits block or single limit leaves the entry without it — the null rule), the alias immutable; the rebuilt table serves the change on the next request |
| `DELETE /api/models/:alias` (HTTP) | `src/httpapi/handlers/model-aliases.ts` | SPA, operators, non-browser clients | Delete; `409` `resource_in_use` while any client's alias ACL names it (D6), `400` for the block's last entry |
| `GET /api/clients` (HTTP) | `src/httpapi/handlers/clients.ts` | SPA, operators, non-browser clients | Every configured client through the store's redacted view (`[]` while no clients block exists) |
| `POST /api/clients` (HTTP) | `src/httpapi/handlers/clients.ts` | SPA, operators, non-browser clients | Create a client entry (requires the key, D7), then the LLM gate's digest-registry swap; the new key admits `/llm/v1` on the next request |
| `GET /api/clients/:name` (HTTP) | `src/httpapi/handlers/clients.ts` | SPA, operators, non-browser clients | One configured client, masked; unknown name → `404` |
| `PUT /api/clients/:name` (HTTP) | `src/httpapi/handlers/clients.ts` | SPA, operators, non-browser clients | Update: `models` replaced wholesale, `apiKey` under the write-body grammar (absent keeps the stored credential; `null` / `""` are refused `400 cannot be cleared`; whitespace-only and the mask literal are rejected — D7, [ADR-018](../decisions/018-uniform-optional-value-write-policy.md)), the name immutable; a changed ACL cuts on the next request |
| `DELETE /api/clients/:name` (HTTP) | `src/httpapi/handlers/clients.ts` | SPA, operators, non-browser clients | Delete; no `409` class exists (nothing references a client), `400` for the block's last entry — removing the block would ungate the LLM surface |
| `POST /api/login` (HTTP) | `src/httpapi/auth.ts` | SPA, operators, non-browser clients | Exchange `{ user, password }` for a session cookie; the only way in when `auth.enabled` is true |
| `POST /api/logout` (HTTP) | `src/httpapi/auth.ts` | SPA, operators, non-browser clients | Revoke the presented session and expire the cookie; always `200` |
| Session auth gate (middleware) | `src/httpapi/auth.ts` | every `/api/*` request except the two auth actions | When `auth.enabled`: validate the session cookie, otherwise answer the `401` envelope ([ADR-007](../decisions/007-management-cookie-auth.md)) |
| OpenAI error envelope (JSON schema) | `src/httpapi/errors.ts` | every client of this boundary | Single error shape for gateway-generated failures — the same mapper the LLM surface uses (see Error Propagation) |

`GET /api/status` → `200` — always, composed entirely from state the gateway already holds, no upstream contact, no file read, no reference to registry or routing state:

```json
{ "status": "ok", "authenticated": true }
```

- `status` is the fixed `"ok"` literal: the process is up and serving. The startup-probe outcomes and the route inventory the read once carried ([ADR-014](../decisions/014-runtime-management-crud.md) D3 shrank it) live on as startup log lines — probe warnings and the crosscheck verdicts (`src/index.ts`) — not as HTTP body material.
- `authenticated` states whether this request carries a valid session ([ADR-007](../decisions/007-management-cookie-auth.md)): `true` only behind a login — with auth enabled the gate admits only valid sessions, so reaching the handler proves the cookie; with auth off every request is anonymous (`false`). The SPA's mount probe reads it to keep the `Log out` control across page reloads.

The upstream collection — `GET /api/upstreams` → `200`:

```json
{
  "upstreams": [
    { "type": "openai-compatible", "id": "openai-main", "baseUrl": "https://api.openai.com/v1", "apiKey": "[Configured]", "tlsFingerprint": "[Configured]", "proxy": null }
  ]
}
```

- Entries mirror the store's redacted view in config order: `type`, `id`, `baseUrl` verbatim (none secret); `apiKey` always the fixed mask literal `"[Configured]"` (`CONFIGURED_MASK`, `src/config/redact.ts` — deliberately distinct from the logging layer's `"[Redacted]"` censor); `tlsFingerprint` the mask when configured, `null` when absent; `proxy` the outbound proxy URL verbatim when configured, `null` when absent — it is not a credential (the grammar admits no userinfo, [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)), which is exactly why it rides the view verbatim while `apiKey` / `tlsFingerprint` stay masked. Both mirrors of this entry carry the same field set: the OpenAPI document's `ManagedUpstreamSchema` / `UpstreamWriteRequestSchema` (`src/httpapi/openapi.ts` — `proxy` a nullable string, optional on the write) and the SPA's `ManagedUpstream` / `UpstreamWriteRequest` types (`web/src/api.ts`), each regenerable or typechecked against this list.
- `GET /api/upstreams/:id` answers the single entry in the same shape (no wrapper); an unknown id is the `404` envelope (`invalid_request_error`, no code) before anything else.

`POST /api/upstreams` / `PUT /api/upstreams/:id` → `200` — the masked entry as it now reads, plus the blocking probe's outcome ([ADR-014](../decisions/014-runtime-management-crud.md) D8):

```json
{
  "upstream": { "type": "openai-compatible", "id": "vllm-local", "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "[Configured]", "tlsFingerprint": null, "proxy": "http://forward-proxy.internal:3128" },
  "probe": { "ok": false, "reason": "connect timeout after 10000ms" }
}
```

- Create requires every field including `apiKey`; update requires every field except the three optional values — `apiKey`, `tlsFingerprint`, `proxy` — which read under the write-body grammar below ([Optional values in a write body — keep / clear / reject](#optional-values-in-a-write-body--keep--clear--reject), [ADR-018](../decisions/018-uniform-optional-value-write-policy.md)): an absent optional value keeps the stored one, `null` and `""` are one clear signal (refused for the required `apiKey`), whitespace-only is a `400` on both create and update, and the mask literal `[Configured]` is rejected. The id is immutable: the path parameter owns it, and renaming means delete + re-create. A malformed proxy value is a `400` whose problem line names the rule and never echoes the value.
- The mutation is the store's `validate → persist → apply` (a validation problem is the `400` envelope with value-free problem lines) followed by the runtime half: construct through the registry's factory map, probe within the startup probe budget (10 s, `RUNTIME_PROBE_BUDGET_MS`), swap the instance into the registry, and seed or clear the upstream's metadata slice — an ok probe with a retained catalog seeds it, anything else clears it (the write replaced the instance the old snapshot described).
- `probe.ok: false` is data, not a cancellation: the mutation has already landed on disk and in memory, exactly as a config-file edit with a currently-down provider lands at startup. `reason` is a log-safe failure fact — never credential or config material.

### Optional values in a write body — keep / clear / reject

The three optional values of an upstream or client write — `apiKey` (a required credential), `tlsFingerprint` (an optional pin, [ADR-004](../decisions/004-per-upstream-tls-pinning.md)) and `proxy` (an optional URL, [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) — read under ONE grammar on both paths that consume them: the FILE (`config.json` at startup, `validateGatewayConfig` in `src/config/schema.ts`) and the WIRE (a `POST` / `PUT` body through `src/config/store.ts`), per [ADR-018](../decisions/018-uniform-optional-value-write-policy.md). Absent, `null` and the exact empty string `""` are the three spellings of "no value"; a whitespace-only string (`trim() === ""` but not `""`) is never a value and never a clear — it is refused; anything else is the field's own grammar. The wire adds the one reading the file cannot have — **keep** on an update, because a body is a patch over a stored entry and the masked view never carries the value back — and answers every refusal as the `400` envelope with a value-free problem line; the file answers with a startup problem (exit 1). One table, both grammars:

| value | `apiKey` — required credential | `tlsFingerprint` — optional pin | `proxy` — optional URL |
| ----- | ------------------------------- | -------------------------------- | ---------------------- |
| absent | file: **problem** (`missing required key`) · wire create: `400` missing · wire update: **keep** the stored key | file: not set (no key on the entry) · wire create: not set · wire update: **keep** the stored pin | file: not set (a direct connection) · wire create: not set · wire update: **keep** the stored proxy |
| `null` | file: **problem** (`must be a non-empty string`) · wire create: `400` missing · wire update: **`400` `cannot be cleared`** | file: not set · wire create: not set · wire update: **clear** (no pin) | file: not set · wire create: not set · wire update: **clear** (direct) |
| `""` (exact) | file: **problem** (`must be a non-empty string`) · wire create: `400` non-empty · wire update: **`400` `cannot be cleared`** | file: not set · wire create: not set · wire update: **clear** — the same signal as `null` | file: not set · wire create: not set · wire update: **clear** — the same signal as `null` |
| whitespace-only | file: **problem** (`must be a non-empty string`) · wire create: `400` `must not be whitespace-only` · wire update: `400` `must not be whitespace-only` | file: **problem** (`must not be whitespace-only`) · wire create: `400` `must not be whitespace-only` · wire update: `400` `must not be whitespace-only` | file: **problem** (`must not be whitespace-only`) · wire create: `400` `must not be whitespace-only` · wire update: `400` `must not be whitespace-only` |
| `[Configured]` (the redacted view's mask literal) | file: **not checked** — a non-empty string like any other · wire: `400` mask literal | file: **not checked** · wire: `400` mask literal | file: **not checked** · wire: `400` — not a URL |
| a real value | file: a non-empty string · wire: a non-empty string, else `400` | file and wire: base64 decoding to the 32-byte SHA-256 SPKI digest after every whitespace character is stripped, else `400` | file and wire: an `http:` / `socks5:` URL with a non-empty host, an explicit port, no userinfo / path / query / fragment, stored trimmed, else `400` |

- **Why a required credential cannot be cleared:** there is no credential-less upstream or client, so the clear signal on an update is refused with a line saying so (`cannot be cleared — send a new value, or omit the field to keep the stored one`); the absent field is the only honest "unchanged". Create requires a key.
- **Why an absent pin / proxy keeps:** dropping a pin silently would widen upstream trust from fail-closed pinning to system-CA verification ([ADR-004](../decisions/004-per-upstream-tls-pinning.md)), and an omitted field must never silently change the egress topology ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)). An empty value normalizes to absent, so a stored entry never carries `tlsFingerprint: ""` or `proxy: ""`.
- **Internal whitespace of a non-empty pin is still stripped:** the whitespace-only rule is about a value that is nothing but whitespace; a pin pasted with line wraps or spaces between groups normalizes to the same digest and still matches, and the proxy is stored trimmed.
- **The mask literal is a wire-only rejection (D7):** the redacted view is the only thing that produces `[Configured]`, so only a client echoing a view back can submit it; the file grammar does not check for it — a hand-edited `config.json` carrying `"apiKey": "[Configured]"` validates as a non-empty string (an odd credential, not a mask violation).
- **Scope — where this rule stops.** It covers exactly the three optional values on upstream and client writes (`POST` / `PUT /api/upstreams`, `POST` / `PUT /api/clients`) and the matching `upstreams[]` / `clients[]` file entries. The identity keys (`type`, `id`, `baseUrl`, `name`, `alias`) are not optional values: on the wire a `null` on one is inherited (the null rule — it reads as omitted: the stored value is kept on an update, missing on a create), and in the file they are required. The wholesale blocks on a model write — `limits` (the block and each single limit) and `weight` — are PUT-replace semantics (a `null` or absent block leaves the entry without it), outside this rule. Every other key follows the null rule ([configuration.md](../domains/configuration.md)): a JSON `null` is the key not set — a `null` required key is the `400` envelope's missing-key problem, a `null` route weight is unweighted.
- **The client's side of the bargain:** `""` on the wire is an explicit clear, so a client that renders an empty form field must omit it, not submit it — trim every field before sending and drop the empty ones. The SPA complies ([frontend.md](../domains/frontend.md): a field rides the body only when its trimmed value is non-empty); any other client MUST do the same.

`DELETE /api/upstreams/:id` → `200` `{"deleted": "openai-main"}`; the refusal classes:

- an unknown id → the `404` envelope before anything else;
- any `models[].routes[]` entry still naming the upstream → `409` `invalid_request_error` code `resource_in_use`, the message naming the referencing models and route indexes (D6 — referential integrity is the operator's to resolve, no cascades);
- the block's last entry → the `400` envelope (the startup validator's shape rule — a present `upstreams` array keeps at least one entry).

On success the instance leaves the registry and its metadata slice is cleared — a deleted upstream's snapshot must not keep serving alias metadata.

`GET /api/upstreams/:id/models[?discover=1]` → `200` (the operator-triggered live listing — [ADR-011](../decisions/011-management-live-model-listing.md) as amended by [ADR-016](../decisions/016-discover-folded-into-live-listing.md), which folds the former discover mount in behind the query parameter):

```json
{
  "upstream": "openai-main",
  "models": [
    { "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "system" }
  ],
  "fetchedAt": "2026-01-01T12:00:00.000Z"
}
```

- `upstream` is the exact configured upstream id; an unknown id is answered `404` with the envelope **before any upstream contact**.
- `models` is the upstream's live, provider-native catalog — unprefixed entries with provider-native extra fields, unlike the client-facing `GET /llm/v1/models` alias catalog ([ADR-009](../decisions/009-alias-table-routing.md)); `fetchedAt` is the ISO-8601 instant the fetch completed.
- One `listModels()` attempt — no retries — bounded by the startup probe budget, not the forward budget; a rejection or an expired budget answers the `502` `api_error` code `upstream_error` envelope naming the upstream id and a log-safe failure fact. The body carries no key material by construction, and the mount has no session-gate exemption.
- `discover=1` ([ADR-016](../decisions/016-discover-folded-into-live-listing.md)) swaps the upstream's metadata slice wholesale before the answer — an empty listing is a fact ("provider lists zero models"); a rejection or an expired budget leaves the store untouched (retain-last-good) and surfaces as the `502` envelope above. Without the parameter the listing is a pure read — nothing mutates. The former `POST /api/upstreams/:id/discover` mount answers the `404` envelope for every method.

The models collection — `GET /api/models` → `200`; `GET /api/models/:alias` answers one entry; `POST /api/models` / `PUT /api/models/:alias` answer the created or updated entry bare:

```json
{
  "alias": "smart",
  "routes": [
    { "upstream": "openai-main", "model": "gpt-4o", "weight": 3 },
    { "upstream": "vllm-local", "model": "qwen2.5:7b-instruct", "weight": null }
  ],
  "balance": { "strategy": "weighted-round-robin" },
  "limits": { "context": 128000, "output": 16384 },
  "meta": { "contextWindow": 128000, "outputLimit": 16384, "capabilities": { "attachment": true, "reasoning": false, "temperature": true, "toolCall": true } }
}
```

- The entry mirrors the store's redacted view (the models block carries no credentials, but the read stays on the one masked shape): `alias`, `routes` (`upstream`, `model` verbatim; `weight` verbatim, `null` when absent), `balance.strategy`, and `limits` mirrored verbatim or `null` when the entry carries none.
- `meta` is the alias-metadata aggregate ([model-metadata.md](../domains/model-metadata.md), [ADR-012](../decisions/012-alias-model-metadata.md)) folded from the metadata store's *current* slice on every read — `contextWindow` / `outputLimit` the element-wise minima over the alias's routes (JSON `null` when unknown) and `capabilities` the strict-AND four-flag object (`null` when not every route fully declared its own): absent means unknown, never a fabricated zero or an all-false block. No upstream contact. A successful `discover=1` listing, or an upstream create/update whose blocking probe retained a catalog, is visible in `meta` on the next read; a failed one changes nothing (retain-last-good). The `meta` key moved here from `GET /api/status` ([ADR-014](../decisions/014-runtime-management-crud.md) D4).
- `GET /api/models` answers `{"models": [ ... ]}` in config order. Create runs the store's full entry grammar — alias grammar and uniqueness, at least one route, every route's `upstream` naming a configured upstream, no duplicate upstream/model pair, strategy/weight consistency, the `limits` rules — then rebuilds the routing table; a validation problem is the `400` envelope. Update replaces `routes` / `balance` / `limits` wholesale with the alias immutable (the path parameter owns it); an unknown alias is the `404` envelope before validation.

`DELETE /api/models/:alias` → `200` `{"deleted": "smart"}`; the refusal classes:

- an unknown alias → `404`;
- any `clients[].models` entry still naming the alias → `409` `resource_in_use` naming the referencing clients (D6);
- the block's last entry → `400` (a present `models` block keeps at least one entry).

On success the alias leaves the routing table on the rebuild — the next `/llm/v1` request answers `404 model_not_found` for it.

The clients collection — `GET /api/clients` → `200` `{"clients": [ ... ]}` (config order, `[]` while no clients block exists); `GET /api/clients/:name` answers the bare masked entry:

```json
{ "name": "local-dev", "apiKey": "[Configured]", "models": ["smart"] }
```

- `name` and `models` verbatim (neither secret); `apiKey` always the fixed mask — a client key is masked exactly like an upstream key, and its value never crosses this boundary on a read.
- `POST /api/clients` / `PUT /api/clients/:name` → `200` `{"client": { ...the masked entry... }}`: create requires the key and every listed alias naming a defined `models[].alias` (the store creates the `clients` block with the first add); update replaces `models` wholesale, reads `apiKey` under the write-body grammar above (absent keeps the stored credential; `null` / `""` are refused `400 cannot be cleared`; whitespace-only and the mask literal are rejected — D7, [ADR-018](../decisions/018-uniform-optional-value-write-policy.md)), and the name stays immutable. The runtime half is the LLM gate's digest-registry swap — a new key admits, a changed ACL cuts, and a replaced key invalidates the old one on the very next `/llm/v1` request, no restart. An empty registry stays fail-closed: before the first client exists the mounted empty gate answers every `/llm/v1` request `401` ([ADR-008](../decisions/008-client-bearer-auth.md)).
- `DELETE /api/clients/:name` → `200` `{"deleted": "local-dev"}`; an unknown name → `404`; the block's last entry → `400` (removing the block would ungate the LLM surface). No `409` class exists — no configuration entry references a client; the reverse direction (a model alias a client's ACL names) is the models surface's own delete guard. The deleted key answers `401 invalid_api_key` from the next request on.

`POST /api/login` — request `{"user": "...", "password": "..."}` (`application/json` required):

- `200` → `{"authenticated": true}` with `Set-Cookie: llm_gateway_session=<token>` — `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` equal to the session TTL, `Secure` added when the listener serves TLS.
- `401` → the envelope (`authentication_error` / `invalid_credentials`) after a fixed delay; the message never reveals which half failed and never echoes the presented password.
- A non-JSON body or non-string `user` / `password` fields → `400` `invalid_request_error` immediately, without the delay — a malformed request is not a credential attempt.
- A body over the gateway's size cap (`server.maxRequestBodyBytes` — enforced by `src/httpapi/body.ts`) → `413` `invalid_request_error` code `request_too_large`, also before any credential check.
- Sessions are in-memory: a 32-byte random token, absolute TTL 24h, a store bounded at 64 sessions (oldest evicted), cleared on restart — a restart logs every operator out ([ADR-007](../decisions/007-management-cookie-auth.md)).

`POST /api/logout`:

- `200` → `{"authenticated": false}` with the cookie expired; idempotent — `200` with a fresh expired cookie even when no valid session was presented.

Session gate (runs at the auth stage, before routing — [data-flow.md](../architecture/data-flow.md)):

- With `auth.enabled` true: every `/api/*` path except `POST /api/login` and `POST /api/logout` requires the session cookie — reads and mutations alike, the CRUD blocks included with no exemption of their own; without a valid session the answer is the `401` envelope (`authentication_error` / `authentication_required`) with **no** `WWW-Authenticate` header — the SPA's login card is the only login affordance.
- With auth off (no `auth` block or `enabled: false`): no gate, no cookie checks — the boundary behaves exactly as before ADR-007 (and the CRUD stays exposed to whoever can reach the listener — the loopback default is the load-bearing control, [security-model.md](../architecture/security-model.md)). The gate never touches `/llm/v1/*`, `/ui/*`, or `/`.

## Initialization

At startup the entry point reads and validates the config, constructs the upstreams and the registry, and builds the Hono app with the management routes mounted on the `/api/*` prefix **before** static serving is attached (`src/httpapi/app.ts`), alongside the LLM surface at `/llm/v1/*` ([client-gateway.md](client-gateway.md)) — the SPA mount can never shadow an `/api` route. When `auth.enabled` is true, the entry point also injects the validated `auth` slice (login + password hash) into the auth gate — the only path by which the hash reaches the HTTP layer — and the gate wraps the management routes at the auth stage, before routing ([ADR-007](../decisions/007-management-cookie-auth.md)). The entry point constructs the runtime configuration store (`ConfigStore`, `src/config/store.ts`) over the normalized config and the path it was loaded from, and hands it to the app: the store's presence mounts the three CRUD blocks ([4d] upstreams, [4e] models, [4f] clients — production always wires it; the option's absence keeps the pre-ADR-014 surface for tests and embedded use), and its redacted view (`ConfigStore.view`) is the only config shape the handlers read — credential values never leave the config domain. The client Bearer gate generalizes with the store: it mounts when the config carries a non-empty `clients` block **or** the store is wired, seeded from the store's current clients — an empty registry answers every `/llm/v1` request `401` (fail-closed) until the clients CRUD creates the first one, and every clients mutation hot-applies into it. The entry point also constructs the metadata store and seeds it from the retained startup probes ("discovery at start", step [4c] of `src/index.ts`), handing it to the app: the models CRUD folds its current slice into `meta`, the metadata store's `discover=1` swap and the CRUD probes are its only request-time writers. The alias routing table is built through the rebuildable holder (`createRebuildableRoutingTable`) — the table object the `/llm/v1` handlers capture stays stable while a models mutation swaps in a fresh build ([ADR-014](../decisions/014-runtime-management-crud.md) D2). The endpoints exist as soon as the listener is bound; the reads depend on no upstream being reachable — `GET /api/status` answers from constants, the CRUD lists from the store's in-memory view — and the live mounts answer their `404` envelopes with no upstream contact.

## Data Flow Across Boundary

Direction: client → gateway (GET/DELETE without a body; POST/PUT carry the entry's JSON body under the configured cap), gateway → client (JSON `200`, or the envelope otherwise). The reads are constructed from in-memory state — the store's redacted view, the metadata store's current slice, the session store — with no upstream contact and, on the read paths, no file access. The mutations are the store's synchronous `validate → write → apply` sequence (no await between validate and apply — two mutations can never interleave on Bun's single-threaded event loop):

```
mutation (POST/PUT/DELETE on /api/upstreams | /api/models | /api/clients)
  │
  ├─ [1] VALIDATE  the candidate entry against the current collections —
  │        the same grammar helpers the startup validator uses
  │        (patterns, strategies, cross-references, uniqueness, last-entry rules);
  │        a problem → 400 envelope (value-free lines), nothing written anywhere
  │
  ├─ [2] PERSIST   read the raw config file, replace ONLY the three mutable
  │        sections (upstreams / models / clients), write a sibling temp file
  │        (`config.json.tmp-<pid>-<random>`, file mode preserved) and rename it
  │        onto the config file — same directory, so the rename is a
  │        same-filesystem atomic replace; hand edits to `server` / `logLevel` /
  │        `auth` survive; a failed read/write → 400 envelope, memory untouched
  │
  ├─ [3] APPLY     rebuild the deep-frozen normalized config in memory —
  │        only after the write succeeded (file and memory never diverge)
  │
  └─ [4] HOT-APPLY the running graph (no restart, no dropped request):
           upstreams  → construct + probe within the budget (outcome is data, D8)
                        → registry swap → metadata slice seed/clear
           models     → fresh routing-table build over the persisted block,
                        atomically swapped into the stable table object;
                        route health and session affinity start from the
                        neutral state (D9 — the old bookkeeping described a
                        prior configuration)
           clients    → the LLM gate's digest registry rebuilt from the store's
                        current clients (one atomic array swap)
```

The one live upstream facility rides the boundary under the same gate: the listing calls `listModels()` on the named upstream exactly once per request; with `discover=1` ([ADR-016](../decisions/016-discover-folded-into-live-listing.md) — the folded former discover mount) the fetched catalog swaps the metadata slice wholesale before the answer — a failure or expired budget leaves it serving (retain-last-good) and surfaces as the listing's `502` envelope with the log-safe reason. Serialization masks on the way out only: the store builds its redacted view fresh after every applied mutation, so a read after a mutation serves the mutated, masked state, and a mutation body's credential value is consumed by the store — it never reaches a handler response, a log line, or a problem line.

```
client ── GET /api/status ────────────▶ gateway
gateway   constants + the gate's verdict — no registry, no routing, no store
client ◀─ 200 {"status": "ok", "authenticated": <bool>} ── gateway

client ── GET /api/{upstreams,models,clients}[/:key] ─▶ gateway
gateway   the store's redacted view (+ the metadata fold on models reads)
client ◀─ 200 masked entries ────────────────────────── gateway   (404 envelope otherwise)

client ── POST/PUT/DELETE /api/{upstreams,models,clients}... ─▶ gateway
gateway   [1] validate ── problem → 400 envelope, stop
          [2] persist (tmp + atomic rename onto config.json) ── failure → 400, stop
          [3] apply (deep-frozen rebuild)
          [4] hot-apply (registry probe+swap | routing rebuild | digest swap)
client ◀─ 200 {upstream, probe} | entry | {client} | {deleted} ── gateway
          (409 resource_in_use before a referenced delete mutates anything)

client ── GET /api/upstreams/:id/models[?discover=1] ─▶ gateway  (ADR-011, ADR-016)
gateway   listModels() on the named upstream, within the probe budget, single attempt
          discover=1: success swaps the metadata slice before the answer
client ◀─ 200 {upstream, models, fetchedAt} ─── gateway     (404 | 502 envelope otherwise)

client ── POST /api/login {"user","password"} ─▶ gateway     (auth.enabled)
gateway   timing-safe verify against the configured hash; session stored in memory
client ◀─ 200 {"authenticated": true} + Set-Cookie ────────── gateway
```

## Error Propagation

Gateway-generated errors on this boundary use the OpenAI error envelope, produced by the single shared mapper `src/httpapi/errors.ts` — the management surface never defines a second error format (the mapper serves gateway-generated failures on `/llm/*` and `/api/*` alike; shape and status table: [client-gateway.md](client-gateway.md#error-propagation)). The failure classes this boundary adds to the shared table:

- `400` `invalid_request_error` (no code) — a validation problem or a failed persist, the message carrying the store's problem lines joined with `"; "`. The lines are value-free by the store's contract: credential-shaped values are never echoed, and persist failures name the path and the errno code without quoting file content — these messages cross into HTTP envelopes, unlike the startup loader's parse errors.
- `409` `invalid_request_error` code `resource_in_use` — a delete whose target live configuration still references ([ADR-014](../decisions/014-runtime-management-crud.md) D6): an upstream named by a `models[].routes[]` entry, a model named by a client's alias ACL. The message names the referencing entries so the operator can act on them; nothing is removed.
- `404` `invalid_request_error` (no code) — an unknown upstream id, model alias, or client name, answered before any validation or upstream contact; likewise an unknown `/api/*` path.
- `401` `authentication_error` code `authentication_required` — an unauthenticated `/api/*` request while `auth.enabled` (except the auth actions), and `invalid_credentials` for a failed login — both with no `WWW-Authenticate` header, neither revealing which credential half failed ([ADR-007](../decisions/007-management-cookie-auth.md)).
- `413` `invalid_request_error` code `request_too_large` — a mutation or login body over the configured cap, before any parse or credential check.
- `502` `api_error` code `upstream_error` — the ADR-011 listing's failing or too-slow `listModels()` (single attempt, probe budget); with `discover=1` the same envelope reports a failed discovery, retain-last-good keeping the previous slice serving ([ADR-016](../decisions/016-discover-folded-into-live-listing.md)). The CRUD probes report their outcome as data for the contrast class. An unexpected handler failure still maps to `502` `api_error` by the app's error middleware.

Every other endpoint touches only in-memory gateway state and never contacts an upstream — no upstream failure can reach them.

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Response shapes** — the SPA and every external consumer parse them: the status probe's `{ status, authenticated }`; the CRUD list wrappers (`{ upstreams }`, `{ models }`, `{ clients }`), the read entries, the write answers (`{ upstream, probe }` for upstreams, the bare managed entry with its `meta` for models, `{ client }` for clients), the delete answers (`{ deleted }`), and the ADR-011 listing's `{ upstream, models, fetchedAt }` (the `discover=1` variant carries the same shape — [ADR-016](../decisions/016-discover-folded-into-live-listing.md)). Any field add/rename/reshape updates this contract, the zod schemas in `src/httpapi/openapi.ts`, and the SPA consumers in the same change.
2. **The masking rule** (`apiKey` always the fixed mask `"[Configured]"`; `tlsFingerprint` mask-or-`null` on reads) — weakening it in any way (partial reveal, conditional omission of the mask) exposes credential material and contradicts the security model ([security-model.md](../architecture/security-model.md)); it requires an ADR plus a security-model update, never a silent change. The mutation-side twins are part of the same rule: absent-`apiKey`-means-keep-existing and the mask-literal rejection (D7) — changing either, or any cell of the write-body grammar table above ([Optional values in a write body — keep / clear / reject](#optional-values-in-a-write-body--keep--clear--reject)), changes what an operator must send to leave a credential untouched or to clear an optional value, an ADR-level decision ([ADR-014](../decisions/014-runtime-management-crud.md), as amended by [ADR-018](../decisions/018-uniform-optional-value-write-policy.md)).
3. **The mutation boundary** — the sanctioned mutations are exactly the auth actions (the session store, [ADR-007](../decisions/007-management-cookie-auth.md)), the ADR-014 CRUD's validate → persist → apply over the three collections, and the metadata-store swaps (the listing's `discover=1` swap, the CRUD probes' seed/clear — [ADR-016](../decisions/016-discover-folded-into-live-listing.md)); the sanctioned request-time upstream contacts are exactly the ADR-011 listing (its `discover=1` variant included) and the CRUD blocking probes. Any further mutating endpoint or upstream contact changes the trust posture of the whole prefix: a new ADR plus the contract-plus-security-model updates land before implementation ([ADR-014](../decisions/014-runtime-management-crud.md) followed its own checklist item this way).
4. **The persist discipline** — write-before-apply, whole-file read with only the three mutable sections replaced, sibling temp file plus same-directory atomic rename, value-free problem lines: these are the properties that keep the config file the single source of truth and `config.json` the only runtime file the gateway writes ([ADR-014](../decisions/014-runtime-management-crud.md) D1, [configuration.md](../domains/configuration.md), [security-model.md](../architecture/security-model.md)). Any change to the sequence (a different write path, an in-memory-first variant, a second written file) is a security-model change first.
5. **The `/api/*` prefix itself** — fixed by [ADR-005](../decisions/005-gateway-surface-namespace.md); moving or re-prefixing it re-cuts every consumer and requires a new ADR first.
6. **New management endpoints** extend this contract first — the API spec leads, and the UI lands in the same change ([ADR-014](../decisions/014-runtime-management-crud.md) D5 removed the "later change" slack: the boundary never presents a mutating API its own operator UI cannot drive); they mount before static serving so the SPA never shadows them, and their `describeRoute` config, `OPENAPI_ROUTES` row, and zod schema join `src/httpapi/openapi.ts` in the same change with `bun run apidocs` regenerating the `/docs` mirror ([ADR-013](../decisions/013-openapi-docs-surface.md), [api-docs.md](../domains/api-docs.md)).
7. **The session gate** (cookie name and attributes, the exempted `POST /api/login` / `POST /api/logout`, the `401` codes, the TTL/store constants) — the SPA login flow and every non-browser client depend on it, and every new endpoint inherits it by living under `/api/*`. Any change updates this contract and [frontend.md](../domains/frontend.md) in the same change, and revisits [ADR-007](../decisions/007-management-cookie-auth.md) deliberately when it alters the mechanism itself.
