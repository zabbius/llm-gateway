# Configuration

## Purpose

Defines the gateway's config file: where it lives, its JSON schema (`listen`, `logLevel`, plus the `adapters` array), how it is validated at startup, and how validation failures are reported.

## Key Files

- `src/config/schema.ts` — `GatewayConfig` types and validation rules, including per-type adapter fields
- `src/config/load.ts` — file discovery, read, parse, error aggregation, normalized config out

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

## Configuration

### File location

1. `LLM_GATEWAY_CONFIG` env var, if set — the only path tried;
2. otherwise `./config.json` relative to the process working directory.

A missing file is a startup error naming the path that was tried.

### Schema

```json
{
  "listen": "127.0.0.1:8080",
  "logLevel": "info",
  "adapters": [
    {
      "type": "openai-compatible",
      "id": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-…"
    }
  ]
}
```

| Field | Required | Rules |
| ----- | -------- | ----- |
| `listen` | no (default `"127.0.0.1:8080"`) | string `"host:port"`, valid host and port range |
| `logLevel` | no (default `info`) | one of `trace, debug, info, warning, error, none` |
| `adapters` | yes | array with at least one entry |
| `adapters[].type` | yes | a registered `AdapterType` (MVP: `openai-compatible`) |
| `adapters[].id` | yes | `^[a-z0-9][a-z0-9-]*$`, no `/`, unique across the array |
| `adapters[].baseUrl` | yes | absolute `http(s)` URL, including the API root with `/v1` |
| `adapters[].apiKey` | yes | non-empty string |

Unknown top-level keys and unknown per-adapter keys are rejected — the schema is strict, so typos fail loudly at startup.

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
