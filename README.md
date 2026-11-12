# llm-gateway

An OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each
request to the provider adapter selected by the model-id prefix (`{adapterId}/{model}`),
streaming the answer back. One gateway fronts many upstream LLM providers behind a single
fixed client surface.

## Status

MVP scope implemented:

- `GET /v1/models` — aggregated model list across adapters, ids prefixed `{adapterId}/{model}`;
  a failing adapter degrades its slice, never the whole list
- `POST /v1/chat/completions`, `POST /v1/completions` — proxied to the adapter selected by
  the model-id prefix; SSE streaming passes through chunk-by-chunk, no buffering
- One adapter type: `openai-compatible` (OpenAI-compatible REST API, Bearer auth,
  header whitelist, fixed timeouts, upstream 4xx/5xx relayed as-is)
- JSON config with total validation; pino logging to stderr with credential redaction
- Static SPA served at `/` when `web/dist` exists

Not in the MVP yet: gateway authentication (a documented no-op — the listener binds to
loopback by default, keep it that way), adapter types beyond `openai-compatible`,
request/response transformation beyond the model-id rewrite.

## Requirements

- [Bun](https://bun.sh) (the gateway and the `web/` build)

## Quick start

1. Install dependencies; optionally build the web UI:

   ```sh
   bun install
   (cd web && bun install && bun run build)   # emits web/dist
   ```

2. Create `config.json` (or point the `LLM_GATEWAY_CONFIG` env var at any JSON file):

   ```json
   {
     "listen": "127.0.0.1:8080",
     "logLevel": "info",
     "adapters": [
       {
         "type": "openai-compatible",
         "id": "openai",
         "baseUrl": "https://api.openai.com/v1",
         "apiKey": "sk-..."
       }
     ]
   }
   ```

3. Run:

   ```sh
   bun run start        # bun run src/index.ts
   ```

4. Use it like the OpenAI API, with adapter-prefixed model ids:

   ```sh
   curl http://127.0.0.1:8080/v1/models

   curl http://127.0.0.1:8080/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
   ```

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `listen` | `"host:port"` | `127.0.0.1:8080` | Bind address; IPv6 written as `[::1]:8080` |
| `logLevel` | `trace`, `debug`, `info`, `warning`, `error`, `none` | `info` | `none` silences logging entirely |
| `adapters` | array | — (required) | At least one entry; `id` unique, `^[a-z0-9][a-z0-9-]*$` — never `/` |

Each adapter entry: `type` (registered: `openai-compatible`), `id`, `baseUrl` (absolute
http(s) URL including the API root, e.g. `https://api.openai.com/v1`; one trailing slash
is stripped), `apiKey` (non-empty; sent upstream as the Bearer credential only).

Validation is total: every problem of one config is reported to stderr (one line each)
and the process exits with code 1 before any port is bound. Unknown keys are rejected,
so typos fail loudly at startup.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/models` | Aggregated list; ids rewritten to `{adapterId}/{model}`, `owned_by` set to the adapter id |
| `POST` | `/v1/chat/completions` | Dispatched by the model-id prefix; SSE streaming passthrough |
| `POST` | `/v1/completions` | Same dispatch |
| `GET` | `/*` | Serves `web/dist` when it exists; unmatched paths get the error envelope |

Gateway-generated failures use the OpenAI error envelope — `400 invalid_request_error`,
`404` with `code: "model_not_found"` for an unknown adapter/model, `404` for an unmatched
route, `502 upstream_error`, `504 upstream_timeout` (`src/httpapi/errors.ts` is the single
mapper). Upstream 4xx/5xx responses are relayed as-is.

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
  index.ts      — process entry: the only place that wires config → adapters → app → listener
  types.ts      — shared vocabulary (LogLevel, …)
  config/       — config schema + validation (single place), config-file loading
  logging/      — pino-to-stderr logger with credential redaction
  adapters/     — Adapter contract, registry, the openai-compatible implementation
  gateway/      — model-id prefix routing ({adapterId}/{model})
  httpapi/      — Hono app, routes, the OpenAI error envelope, handlers
web/            — static SPA served at / (React 19, Bootstrap 5, Vite)
specs/          — design contracts; start at specs/INDEX.md
```

Dependencies point downward (`httpapi` → `gateway`/`adapters` → `config`/`logging`);
`src/index.ts` owns all wiring. The full rules: `specs/architecture/layers.md`.

## Specifications

Detailed system specs live in `specs/` — design contracts the code follows:

- Start with `specs/INDEX.md` to find the right document for your task.
- `specs/META.md` defines spec formats and update rules.
