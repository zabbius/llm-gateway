# llm-gateway

An OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each
request to the upstream selected by the model-id prefix (`{upstreamId}/{model}`),
streaming the answer back. One gateway fronts many LLM providers behind a single
fixed client surface.

## Status

MVP scope implemented:

- `GET /llm/v1/models` — aggregated model list across upstreams, ids prefixed `{upstreamId}/{model}`;
  a failing upstream degrades its slice, never the whole list
- `POST /llm/v1/chat/completions`, `POST /llm/v1/completions` — proxied to the upstream selected by
  the model-id prefix; SSE streaming passes through chunk-by-chunk, no buffering
- One upstream type: `openai-compatible` (OpenAI-compatible REST API, Bearer auth,
  header whitelist, fixed timeouts, optional `tlsFingerprint` TLS SPKI pinning,
  upstream 4xx/5xx relayed as-is)
- JSON config with total validation; pino logging to stderr with credential redaction
- Static SPA served at `/` when `web/dist` exists

Not in the MVP yet: gateway authentication (a documented no-op — the listener binds to
loopback by default, keep it that way), upstream types beyond `openai-compatible`,
request/response transformation beyond the model-id rewrite.

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

4. Use it like the OpenAI API, with upstream-prefixed model ids:

   ```sh
   curl http://127.0.0.1:8080/llm/v1/models

   curl http://127.0.0.1:8080/llm/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
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
| `logLevel` | `trace`, `debug`, `info`, `warning`, `error`, `none` | `info` | `none` silences logging entirely |
| `upstreams` | array | — (required) | At least one entry; `id` unique, `^[a-z0-9][a-z0-9-]*$` — never `/` |

Migration: the listener address moved under `server` — a config carrying top-level
`listen` is rejected as an unknown key; write `"server": { "listen": "127.0.0.1:8080" }`
instead ([ADR-007](specs/decisions/007-tls-listener-server-block.md): a pre-release hard
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

Details: `specs/decisions/005-per-upstream-tls-pinning.md` (ADR-005),
`specs/domains/upstreams/openai-compatible.md`.

### TLS listener (HTTPS)

The gateway serves plain HTTP by default. HTTPS is switched on explicitly, with a PEM pair
on disk ([ADR-007](specs/decisions/007-tls-listener-server-block.md)):

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
transport only; it is not client authentication (still a no-op in the MVP — keep the
loopback bind). Details: `specs/architecture/security-model.md`.

A self-signed certificate needs the usual client-side flag:

```sh
curl -k https://127.0.0.1:8080/llm/v1/models
```

Validation is total: every problem of one config is reported to stderr (one line each)
and the process exits with code 1 before any port is bound. Unknown keys are rejected,
so typos fail loudly at startup.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/llm/v1/models` | Aggregated list; ids rewritten to `{upstreamId}/{model}`, `owned_by` set to the upstream id |
| `POST` | `/llm/v1/chat/completions` | Dispatched by the model-id prefix; SSE streaming passthrough |
| `POST` | `/llm/v1/completions` | Same dispatch |
| `GET` | `/*` | Serves `web/dist` when it exists; unmatched paths get the error envelope |

Gateway-generated failures use the OpenAI error envelope — `400 invalid_request_error`,
`404` with `code: "model_not_found"` for an unknown upstream/model, `404` for an unmatched
route, `502 upstream_error`, `502 upstream_tls_error` (TLS verification failed on a pinned
upstream), `504 upstream_timeout` (`src/httpapi/errors.ts` is the single mapper). Upstream
4xx/5xx responses are relayed as-is.

## Development

```sh
bun run typecheck     # tsc --noEmit (strict)
bun test              # unit + e2e tests
bun run dev           # bun --watch src/index.ts
```

Tests live next to the sources (`*.test.ts`); `src/index.test.ts` is the end-to-end smoke
test (a real gateway process against a mock upstream).

The frontend (`web/` — React 19, Bootstrap 5, Vite) builds to `web/dist`, which the
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
  config/       — config schema + validation (single place), config-file loading
  logging/      — pino-to-stderr logger with credential redaction
  upstreams/    — Upstream contract, registry, the openai-compatible implementation,
                  TLS SPKI pinning
  gateway/      — model-id prefix routing ({upstreamId}/{model})
  httpapi/      — Hono app, routes, the OpenAI error envelope, handlers
tools/
  tls-fingerprint.ts — prints (or with --expect verifies) the tlsFingerprint SPKI pin
  generate-tls-cert.sh — self-signed TLS pair for the listener (`server.tls`): cert.pem + key.pem
web/            — static SPA served at / (React 19, Bootstrap 5, Vite)
specs/          — design contracts; start at specs/INDEX.md
```

Dependencies point downward (`httpapi` → `gateway`/`upstreams` → `config`/`logging`);
`src/index.ts` owns all wiring. The full rules: `specs/architecture/layers.md`.

## Specifications

Detailed system specs live in `specs/` — design contracts the code follows:

- Start with `specs/INDEX.md` to find the right document for your task.
- `specs/META.md` defines spec formats and update rules.
