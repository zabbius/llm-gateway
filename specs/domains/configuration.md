# Configuration

## Purpose

Defines the gateway's config file: where it lives, its JSON schema (`listen`, `logLevel`, plus the `adapters` array), how it is validated at startup, and how validation failures are reported. `config.example.json` is the canonical example of that schema and is kept in sync with `src/config/schema.ts`.

## Key Files

- `src/config/schema.ts` — `GatewayConfig` types and validation rules, including per-type adapter fields
- `src/config/load.ts` — file discovery, read, parse, error aggregation, normalized config out
- `config.example.json` — canonical example config at the repo root: every supported option at its documented default, ready to copy to `config.json`
- `src/config/example.test.ts` — sync enforcement: fails `bun test` when the example drifts from the schema

## Core Types

```ts
type LogLevel = "trace" | "debug" | "info" | "warning" | "error" | "none";

type AdapterType = "openai-compatible"; // one per implemented adapter module

interface AdapterConfig {
  type: AdapterType;
  /** ^[a-z0-9][a-z0-9-]*$ — unique across the config; never contains "/" */
  id: string;
  /** absolute http(s) URL including the API root with /v1 (e.g. https://api.openai.com/v1) */
  baseUrl: string;
  /** non-empty; sent upstream as the Bearer credential only */
  apiKey: string;
}

interface GatewayConfig {
  /** "host:port"; omitted → "127.0.0.1:8080" (loopback until gateway-auth lands) */
  listen?: string;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** at least one entry; ids unique across the array */
  adapters: AdapterConfig[];
}
```

## Flow

```
startup
  env LLM_GATEWAY_CONFIG ──┐
                           ├─► resolve path ─► read ─► JSON.parse
  default ./config.json ───┘                        │
                                                    │ ok
                                                    ▼
                                          validate(GatewayConfig)
      ┌── problems ─► one error line each on stderr ─► exit 1 (no listen)
      └── clean ─► normalized GatewayConfig ─► logger + AdapterRegistry
```

## Invariants

- The config is read and validated exactly once per process start; there is no hot reload in the MVP.
- A config that fails validation prevents the server from binding any port.
- Every validation problem is reported in the same startup run — the gateway never fails on the first problem and hides the rest.
- Adapter ids are unique across the whole `adapters` array, independent of `type`.
- The default `listen` binds loopback only; a public interface is a deliberate config choice and stays discouraged while gateway-auth is unimplemented.
- `apiKey` values live in memory only and never appear in logs.
- `config.example.json` always validates against the schema and includes every supported option at its documented default.

## Configuration

### File location

1. `LLM_GATEWAY_CONFIG` env var, if set — the only path tried;
2. otherwise `./config.json` relative to the process working directory.

A missing file is a startup error naming the path that was tried.

### Schema

The canonical, always-current example lives in `config.example.json` at the repo root (see [Example file](#example-file)); the table below is the authoritative field reference.

| Field | Required | Rules | Description |
| ----- | -------- | ----- | ----------- |
| `listen` | no (default `"127.0.0.1:8080"`) | string `"host:port"`, valid host and port range | Host and port the listener binds; the default stays on loopback while gateway-auth is unimplemented |
| `logLevel` | no (default `info`) | one of `trace, debug, info, warning, error, none` | Verbosity of the pino logger; `none` silences log output |
| `adapters` | yes | array with at least one entry | The provider connections the gateway fronts; config order is preserved by the registry |
| `adapters[].type` | yes | a registered `AdapterType` (MVP: `openai-compatible`) | Selects the adapter module that speaks the provider's dialect |
| `adapters[].id` | yes | `^[a-z0-9][a-z0-9-]*$`, no `/`, unique across the array | Stable prefix of the public model ids this connection serves (`{adapterId}/{model}`) |
| `adapters[].baseUrl` | yes | absolute `http(s)` URL, including the API root with `/v1` | Upstream API root the adapter proxies to; a single trailing slash is normalized away at load |
| `adapters[].apiKey` | yes | non-empty string | The secret sent upstream as the Bearer credential; never logged |

Unknown top-level keys and unknown per-adapter keys are rejected — the schema is strict, so typos fail loudly at startup.

### Example file

`config.example.json` (repo root, next to `README.md`) is the canonical example config and a copy-paste starting point: copying it to `config.json` yields a valid config. It contains every supported option at its documented default and one adapter entry per registered adapter `type`. The file is pure JSON — JSON comments and extra description keys would fail the strict validation, so field descriptions live in the schema table above.

The example is part of the schema contract and is updated in the same change as `src/config/schema.ts`:

- a schema key added to, removed from, or renamed (top-level or per-adapter) is reflected in the example in the same change;
- a newly registered adapter `type` gains a sample entry in the same change;
- both rules are enforced by `src/config/example.test.ts`, which validates the example against the schema and asserts exact key coverage — a schema change without the example fails `bun test`.

### Validation errors

All problems for one start are printed to stderr, one error line each (via the logger), then the process exits with code `1`:

- file missing or unreadable — names the path that was tried;
- JSON parse error — names line/column when available;
- `logLevel` invalid — lists the six valid values;
- `listen` malformed — not a `"host:port"` string with a valid port;
- `adapters` empty or not an array;
- unknown adapter `type` — lists the registered types;
- `id` missing, malformed (grammar `^[a-z0-9][a-z0-9-]*$` — uppercase, `_`, or `/` rejected), or duplicated — duplicates are named;
- `baseUrl` missing or not an absolute `http(s)` URL;
- `apiKey` missing or empty.

## Extension Points

- A new adapter `type` extends the schema with its own required fields inside `src/config/schema.ts`; validation stays in one place.
- Future: environment-variable interpolation of secrets (`apiKey`) — the file format does not change.

## Related Specs

- [Provider Adapters](./adapters/README.md) — the pool built from `adapters` entries
- [OpenAI-compatible adapter](./adapters/openai-compatible.md) — `baseUrl` / `apiKey` semantics
- [Observability](./observability.md) — consumer of `logLevel`
