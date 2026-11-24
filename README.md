# llm-gateway

An OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each
request to the upstream selected by the model alias (a configured `models[].alias`),
streaming the answer back. One gateway fronts many LLM providers behind a single
fixed client surface.

## Status

MVP scope implemented:

- `GET /llm/v1/models` — the gateway's alias catalog ([ADR-009](specs/decisions/009-alias-table-routing.md)),
  client-scoped when a `clients` block is configured; no upstream contact
- `POST /llm/v1/chat/completions`, `POST /llm/v1/completions` — the model alias resolves through the config
  `models` table to a balance-selected route; SSE streaming passes through chunk-by-chunk, no buffering
- One upstream type: `openai-compatible` (OpenAI-compatible REST API, Bearer auth,
  header whitelist, fixed timeouts, optional `tlsFingerprint` TLS SPKI pinning,
  upstream 4xx/5xx relayed as-is)
- JSON config with total validation; pino logging to stderr with credential redaction
- Management auth (stage 1): a config-backed cookie session gates `/api/*` — the SPA shows a
  login card ([ADR-007](specs/decisions/007-management-cookie-auth.md))
- Client auth (stage 2): a `clients` config block turns on Bearer auth on the LLM surface —
  `/llm/v1/*` requires `Authorization: Bearer <apiKey>` with a configured client's key
  ([ADR-008](specs/decisions/008-client-bearer-auth.md)); the same block scopes each client to its
  `models` aliases — unknown alias 404, registered but not allowed 403 ([ADR-009](specs/decisions/009-alias-table-routing.md));
  without the block the surface stays open and the loopback bind is the protection
- Static SPA served at `/ui/*` when `web/dist` exists (`/` redirects to `/ui`)
- Alias model metadata ([ADR-012](specs/decisions/012-alias-model-metadata.md)): context/output limits and capability flags
  detected from upstream `/models` listings (LM Studio's native API included), aggregated per alias —
  min-rule limits, strict-AND capabilities — with the optional per-alias `limits` block, projected onto
  `GET /llm/v1/models` entries (optional `limit`/`capabilities`/`modalities`) and the `meta` aggregate on
  `GET /api/models`; advisory data the gateway never enforces, refreshed on operator demand via
  `POST /api/upstreams/:id/discover` and the CRUD's synchronous probes
- Runtime management CRUD ([ADR-014](specs/decisions/014-runtime-management-crud.md)): create/update/delete
  upstreams, model aliases, and clients over the session-gated API — every mutation validates with the
  startup grammar, writes `config.json` back (temp file + atomic rename), and hot-applies into the running
  gateway without a restart; deletes of referenced resources answer `409 resource_in_use`
- `/docs` surface ([ADR-013](specs/decisions/013-openapi-docs-surface.md)): the build-time OpenAPI document
  at `GET /docs/openapi.json` (`bun run apidocs`) and the Swagger UI shell at `GET /docs`

Not in the MVP yet: upstream types beyond `openai-compatible`, request/response
transformation beyond the model-id rewrite.

## Requirements

- [Bun](https://bun.sh) (the gateway and the `web/` build)
- `openssl` on PATH — only for `tools/generate-tls-cert.sh` (self-signed TLS pair generation)

## Quick start

1. Install dependencies; optionally build the web UI:

   ```sh
   bun install
   (cd web && bun install && bun run build)   # emits web/dist
   ```

2. Create `config.json` (or point the `LLM_GATEWAY_CONFIG` env var at any JSON file).
   [`config.example.json`](config.example.json) is a ready-to-copy starting point that
   covers every supported option (the optional `tlsFingerprint` appears as a placeholder
   pin):

   ```sh
   cp config.example.json config.json   # then edit the apiKey values
   ```

3. Run:

   ```sh
   bun run start        # bun run src/index.ts
   ```

4. Use it like the OpenAI API, with the model aliases defined in your config:

   ```sh
   curl http://127.0.0.1:8080/llm/v1/models

   curl http://127.0.0.1:8080/llm/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
   ```

## Configuration

[`config.example.json`](config.example.json) contains every supported option (the optional
`tlsFingerprint` shown as a placeholder pin — replace it with the output of
`tools/tls-fingerprint.ts` for a pinned upstream) and is kept in sync with the schema by
`src/config/example.test.ts` (field descriptions and rules: `specs/domains/configuration.md`).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `server.listen` | `"host:port"` | `127.0.0.1:8080` | Bind address; IPv6 written as `[::1]:8080` |
| `server.tls` | object | — (no `tls` block → plain HTTP) | Listener TLS: `enabled` (boolean, required in the block), `cert` / `key` (PEM file paths, required when enabled) — see "TLS listener" below |
| `server.maxRequestBodyBytes` | integer (bytes) | `4194304` (4 MiB) | Request-body cap: every parsed JSON body (LLM surface and login alike) is read under it, an over-limit body is answered `413 request_too_large` before parsing; schema-bounded at `67108864` (64 MiB) |
| `auth` | object | — (no `auth` block → the management surface is ungated) | Management auth: `enabled` (boolean, required in the block), `user` + `passwordHash` (required when enabled) — see "Management auth" below |
| `clients` | array | — (no `clients` block → no client is configured, the LLM surface is ungated) | Client credentials: each entry has `name` (unique), `apiKey` (non-empty; never logged), `models` (aliases this client may address — every entry must name a defined `models[].alias`); a configured block enables the client Bearer gate on `/llm/v1/*` ("Client auth" below) |
| `models` | array | — (no `models` block → no alias is configured) | Aliased, load-balanced models: each entry has `alias` (unique, client-facing model id, never `/`), `routes` (each: `upstream` naming an existing upstream id, `model`, optional `weight`), `balance.strategy` (`round-robin` or `weighted-round-robin` — weights required on every route under the weighted strategy), optional `limits` (`context` / `output` positive integers in tokens — the operator's ground truth, folded into the alias's advertised limits by min, [ADR-012](specs/decisions/012-alias-model-metadata.md)) |
| `logLevel` | `trace`, `debug`, `info`, `warning`, `error`, `none` | `info` | `none` silences logging entirely |
| `upstreams` | array | — (required) | At least one entry; `id` unique, `^[a-z0-9][a-z0-9-]*$` — never `/` |

Migration: the listener address moved under `server` — a config carrying top-level
`listen` is rejected as an unknown key; write `"server": { "listen": "127.0.0.1:8080" }`
instead ([ADR-006](specs/decisions/006-tls-listener-server-block.md): a pre-release hard
cut, no alias).

Each upstream entry: `type` (registered: `openai-compatible`), `id`, `baseUrl` (absolute
http(s) URL including the API root, e.g. `https://api.openai.com/v1`; one trailing slash
is stripped), `apiKey` (non-empty; sent to the provider API as the Bearer credential only),
optional `tlsFingerprint` (TLS SPKI pin — see "TLS pinning" below).

### TLS pinning (self-signed / internal upstreams)

An upstream entry accepts an optional `tlsFingerprint`: the TLS SPKI pin of the provider's
certificate — `base64(SHA-256(SPKI DER))`, one line, printed by the bundled tool:

```sh
bun tools/tls-fingerprint.ts https://llm.lan:8443/v1
# → K4vmDE8v8SKXajayPc4yMc49GIvJEHyUF8mRo7bu/EM=
```

With a pin set, the upstream accepts **only** the pinned key: every pinned request opens its
own TLS connection, checks the served certificate's SPKI pin before any byte — hence any
credential — is written, and refuses the connection on a mismatch. No certificate chain is
required: self-signed and internal-PKI certificates work even when the server presents its
leaf without intermediates, and the pin survives certificate renewal on the same key pair.
A pin mismatch surfaces to clients as `502 upstream_tls_error`; the field is inert on a
plain-http `baseUrl`, and without it the default system-CA verification applies. `--expect`
verifies a configured pin against the live endpoint (exit non-zero on mismatch):

```sh
bun tools/tls-fingerprint.ts --expect 'K4vmDE8v8SKXajayPc4yMc49GIvJEHyUF8mRo7bu/EM=' https://llm.lan:8443/v1
```

Details: `specs/decisions/004-per-upstream-tls-pinning.md` (ADR-004),
`specs/domains/upstreams/openai-compatible.md`.

### TLS listener (HTTPS)

The gateway serves plain HTTP by default. HTTPS is switched on explicitly, with a PEM pair
on disk ([ADR-006](specs/decisions/006-tls-listener-server-block.md)):

```json
{
  "server": {
    "listen": "127.0.0.1:8080",
    "tls": { "enabled": true, "cert": "./tls/cert.pem", "key": "./tls/key.pem" }
  }
}
```

`tools/generate-tls-cert.sh` generates a matching self-signed pair (server-auth
certificate, unencrypted `600`-mode key):

```sh
tools/generate-tls-cert.sh                       # → ./tls/cert.pem + ./tls/key.pem (localhost)
tools/generate-tls-cert.sh --hostname llm.lan --san 10.0.0.5 --out-dir ./tls
```

A TLS-enabled gateway never falls back to plain HTTP: both PEM files are read at startup,
before the port binds — a missing or unreadable file exits with code 1. TLS encrypts the
transport only; it is not client authentication — the management surface is gated by the
config-backed session ("Management auth" below), and the LLM surface is gated by the
configured `clients` block ("Client auth" below); a surface without its gate still relies
on the loopback/private bind. Details: `specs/architecture/security-model.md`.

A self-signed certificate needs the usual client-side flag:

```sh
curl -k https://127.0.0.1:8080/llm/v1/models
```

Validation is total: every problem of one config is reported to stderr (one line each)
and the process exits with code 1 before any port is bound. Unknown keys are rejected,
so typos fail loudly at startup.

### Management auth (`/ui` login)

Stage 1 of gateway auth gates the management surface: with `auth.enabled`, every `/api/*`
request needs a session cookie — the SPA swaps to a login card, and non-browser clients
authenticate with one login call:

```sh
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"user": "admin", "password": "…"}' http://127.0.0.1:8080/api/login
curl -b cookies.txt http://127.0.0.1:8080/api/status
```

The credentials live in the config's top-level `auth` block — the password only ever
appears as an argon2id PHC hash, generated by the bundled tool:

```sh
printf 'your-password' | bun tools/hash-password.ts --user admin --stdin
# →
#   "auth": {
#     "enabled": true,
#     "user": "admin",
#     "passwordHash": "$argon2id$v=19$…"
#   }
```

Without a flag the tool prompts for the password with hidden input; it also accepts an
explicit `--password '…'` — avoid it: a command-line password lands in the shell history
and is readable by every local user in process listings (`ps`, `/proc/<pid>/cmdline`)
while the tool runs. The tool prints a warning whenever `--password` is used.

Paste the block into `config.json` (beside `logLevel`) and restart — sessions are
in-memory, so a restart logs everyone out (fail-closed). What is gated and what is not:

- **Gated**: everything under `/api/*` — the `GET /api/status` probe, the CRUD collections
  (`/api/upstreams`, `/api/models`, `/api/clients` and their item routes), the live listing
  `GET /api/upstreams/:id/models`, and `POST /api/upstreams/:id/discover` —
  `401 authentication_error` without a valid session (the two auth actions are the only exemptions).
- **Open**: the SPA shell itself (`/ui/*` — static, data-free) and the root redirect; the
  LLM surface `/llm/v1/*` is gated only when a `clients` block is configured ("Client auth"
  below) — without one, keep the loopback/private bind as the protection.

`POST /api/logout` revokes the session; failed logins answer after a fixed delay;
`config.example.json` ships the block with `enabled: false` so a copied example still
boots. Details: [ADR-007](specs/decisions/007-management-cookie-auth.md),
`specs/contracts/gateway-management.md`.

### Client auth (`/llm/v1` Bearer keys)

Stage 2 of gateway auth gates the LLM surface: with a top-level `clients` block configured,
every `/llm/v1/*` request must present `Authorization: Bearer <apiKey>` matching one
configured client ([ADR-008](specs/decisions/008-client-bearer-auth.md)) — the exact header
every OpenAI SDK already sends when you set its `apiKey`. A missing or malformed credential
answers the 401 `authentication_required` envelope, an unknown key the 401
`invalid_api_key` envelope — both before the request body is read or an upstream is
contacted, and neither ever echoes a key value. Verification is timing-safe (SHA-256
digests compared with `timingSafeEqual`).

```json
{
  "clients": [
    { "name": "ci",     "apiKey": "sk-client-ci-31337",    "models": ["fast"] },
    { "name": "batch",  "apiKey": "sk-client-batch-31337", "models": ["fast", "smart"] }
  ]
}
```

(`models` entries must reference aliases defined in the `models` block — startup fails
otherwise.)

Key rules, mirroring the operator side:

- Keys live in the config file only — never logged, never echoed, masked as `[Configured]`
  in the management view.
- A client key authenticates `/llm/v1/*` only: it is not an operator session and opens
  nothing on `/api/*`; a session cookie likewise authenticates nothing on the LLM surface.
- Without a `clients` block no gate mounts: the surface answers unauthenticated — keep the
  loopback/private bind in that mode.
- `clients[].models` is enforced at request time ([ADR-009](specs/decisions/009-alias-table-routing.md)): an alias outside
  the client's list answers 403; an alias that is not configured answers 404. Without a
  `clients` block no client authenticates, and every configured alias is addressable.

Details: [ADR-008](specs/decisions/008-client-bearer-auth.md),
`specs/contracts/client-gateway.md`.

### Managing the gateway over HTTP

With a session cookie, the same authenticated surface that reports on the gateway
reconfigures it — every mutation is validated with the startup grammar, persisted to
`config.json` (temp file + atomic rename), and hot-applied without a restart
([ADR-014](specs/decisions/014-runtime-management-crud.md)):

```sh
# create an upstream (the provider is probed synchronously; a failed probe is data, not a cancellation)
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"type": "openai-compatible", "id": "llama-box", "baseUrl": "http://llm.lan:8080/v1", "apiKey": "sk-…"}' \
  http://127.0.0.1:8080/api/upstreams

# refresh one provider's catalog into the alias-metadata store (retain-last-good on failure)
curl -b cookies.txt -X POST http://127.0.0.1:8080/api/upstreams/llama-box/discover

# reads serve masked credentials; an update that omits apiKey keeps the stored one
curl -b cookies.txt http://127.0.0.1:8080/api/upstreams
curl -b cookies.txt http://127.0.0.1:8080/api/models
```

Deletes of referenced resources answer `409 resource_in_use` — an upstream named by a model
route, a client whose alias ACL names a model, a model alias itself; resolve the references
in the order you choose. The machine-readable mirror of the whole surface lives at
`GET /docs/openapi.json` ([ADR-013](specs/decisions/013-openapi-docs-surface.md)).

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/llm/v1/models` | The alias catalog: `{ id: alias, object: "model", created: <process start>, owned_by: "llm-gateway" }`, scoped to the client's aliases when clients are configured; entries gain optional `limit` / `capabilities` / `modalities` when the alias's detected metadata knows a dimension ([ADR-012](specs/decisions/012-alias-model-metadata.md)) |
| `POST` | `/llm/v1/chat/completions` | Alias resolved to a balance-selected route; `body.model` rewritten to the route's upstream model; SSE streaming passthrough |
| `POST` | `/llm/v1/completions` | Same dispatch |
| `GET` | `/api/status` | The mount probe `{ status: "ok", authenticated }` — session-gated when `auth.enabled` (see "Management auth") |
| `GET` | `/api/upstreams`, `/api/models`, `/api/clients` | The CRUD collection reads: every configured entry in config order, credentials masked as `[Configured]`; `/api/models` entries carry the `meta` aggregate ([ADR-012](specs/decisions/012-alias-model-metadata.md)) |
| `POST` | `/api/upstreams`, `/api/models`, `/api/clients` | Create: validated with the startup grammar, persisted to `config.json` (temp file + atomic rename), hot-applied without a restart ([ADR-014](specs/decisions/014-runtime-management-crud.md)); an upstream create/update probes the provider synchronously within the startup budget — a failed probe is reported as data, the mutation still lands |
| `PUT` | `/api/upstreams/:id`, `/api/models/:alias`, `/api/clients/:name` | Update: the same validate → persist → apply pass; an absent `apiKey` keeps the stored credential, the mask literal `[Configured]` is rejected as a value |
| `DELETE` | `/api/upstreams/:id`, `/api/models/:alias`, `/api/clients/:name` | Delete: a target referenced by live configuration answers `409 resource_in_use` and nothing is removed with it — no cascades |
| `GET` | `/api/upstreams/:id/models` | The operator-triggered live listing ([ADR-011](specs/decisions/011-management-live-model-listing.md)): one `listModels()` within the probe budget, `{ upstream, models, fetchedAt }`; unknown id `404`, failed listing `502` |
| `POST` | `/api/upstreams/:id/discover` | The per-upstream discover mount ([ADR-014](specs/decisions/014-runtime-management-crud.md)): re-reads the provider catalog into the alias-metadata slice, retain-last-good on failure; always `200` with `{ upstream, ok, reason? }` |
| `POST` | `/api/login`, `/api/logout` | The auth actions: mint / revoke the session cookie |
| `GET` | `/docs/openapi.json`, `/docs` | The build-time OpenAPI document and the Swagger UI shell ([ADR-013](specs/decisions/013-openapi-docs-surface.md)); static protocol metadata, no gate |
| `GET` | `/ui/*`, `/` | The static SPA mount (root `302` → `/ui`); unmatched paths get the error envelope |

All `/llm/v1/*` rows are Bearer-gated when a `clients` block is configured — 401 envelope
without a valid client key (see "Client auth" above).

Gateway-generated failures use the OpenAI error envelope — `400 invalid_request_error`,
`401` for a missing or unknown credential (either gate), `403` for an alias outside the
client's ACL, `404` with `code: "model_not_found"` for an unknown alias, `404` for an
unmatched route, `409 resource_in_use` for a delete of a referenced resource, `502
upstream_error`, `502 upstream_tls_error` (TLS verification failed on a pinned upstream),
`503 upstream_unavailable` (no healthy route for the alias), `504 upstream_timeout`
(`src/httpapi/errors.ts` is the single mapper). Upstream 4xx/5xx responses are relayed
as-is.

## Development

```sh
bun run typecheck     # tsc --noEmit (strict)
bun test              # unit + e2e tests
bun run dev           # bun --watch src/index.ts
```

Tests live next to the sources (`*.test.ts`); `src/index.test.ts` is the end-to-end smoke
test (a real gateway process against a mock upstream).

The frontend (`web/` — React 19, Bootstrap 5 via `react-bootstrap`, Vite) builds to `web/dist`, which the
gateway serves at `/`:

```sh
cd web && bun run dev     # vite dev server
cd web && bun run build   # emits web/dist
```

## Layout

```
src/
  index.ts      — process entry: the only place that wires config → upstreams → app → listener
  types.ts      — shared vocabulary (LogLevel, …)
  config/       — config schema + validation (single place), config-file loading,
                  the runtime store (CRUD write-back + hot apply)
  logging/      — pino-to-stderr logger with credential redaction
  upstreams/    — Upstream contract, registry, the openai-compatible implementation,
                  TLS SPKI pinning
  gateway/      — alias-table routing (ADR-009): alias → balance-selected route → upstream;
                  balancer (health, failover, session affinity), metadata store, detector port
  httpapi/      — Hono app, routes, the OpenAI error envelope, handlers (completions,
                  the management CRUD, live listing, discover), the /docs mount
tools/
  tls-fingerprint.ts — prints (or with --expect verifies) the tlsFingerprint SPKI pin
  hash-password.ts — generates the `auth` block: argon2id hash + ready-to-paste snippet
  generate-tls-cert.sh — self-signed TLS pair for the listener (`server.tls`): cert.pem + key.pem
web/            — static SPA served at /ui (React 19, Bootstrap 5 via react-bootstrap, Vite)
specs/          — design contracts; start at specs/INDEX.md
```

Dependencies point downward (`httpapi` → `gateway`/`upstreams` → `config`/`logging`);
`src/index.ts` owns all wiring. The full rules: `specs/architecture/layers.md`.

## Specifications

Detailed system specs live in `specs/` — design contracts the code follows:

- Start with `specs/INDEX.md` to find the right document for your task.
- `specs/META.md` defines spec formats and update rules.
