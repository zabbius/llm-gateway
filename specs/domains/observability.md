# Observability

## Purpose

Leveled logging for the whole gateway: exactly one process-wide logger (pino), writing JSON lines to stderr, with its level taken from `logLevel` in the config. No file logger — durability belongs to the environment that collects stderr.

## Key Files

- `src/logging/logger.ts` — pino bootstrap: level mapping, stderr destination, child-logger factory

## Core Types

```ts
type LogLevel = "trace" | "debug" | "info" | "warning" | "error" | "none";

/** config vocabulary → pino levels (pino spells them "warn" / "silent") */
const PINO_LEVEL: Record<LogLevel, string> = {
  trace: "trace",
  debug: "debug",
  info: "info",
  warning: "warn",
  error: "error",
  none: "silent",
};

/** the single process-wide logger; components get children of it */
declare function createLogger(level: LogLevel): pino.Logger;
// pino({ level: PINO_LEVEL[level] }, pino.destination({ dest: 2, sync: false }))
```

Component loggers are children of the root logger, bound as
`logger.child({ component: "router" | "http" | "config" | "upstream:<id>" })`.

## Flow

```
router / http / upstreams / config
   │ log.debug/info/warning/error(obj, msg)
   ▼
root pino logger ── level gate (from config.logLevel)
   │ enabled → one JSON line
   ▼
stderr (fd 2) ──► environment's log collection (out of gateway scope)
```

### Level semantics

| Level | Emitted content |
| ----- | --------------- |
| `trace` | per-request internals; the auth stage emits one trace line per request (method, path) — its message names the pass-through placeholder when auth is off, or the mounted session gate when auth is on (ADR-008) |
| `debug` | request handled (method, path, status, duration, resolved upstream id), upstream resolved on completions dispatch (upstream id, upstream model, upstream path), models aggregated (count), auth events (login succeeded / login failed; a management request without a valid session — 401) |
| `info` | startup: config loaded, upstream probe results (connected / degraded), listening address with the TLS fact (`tls: true|false` — never PEM contents); shutdown |
| `warning` | degraded but continuing: startup probe failed (upstream degraded, startup continues), model list failed for one upstream (its entries drop out, the list still answers 200) |
| `error` | request failed (upstream unreachable/timeout → `504 upstream_timeout`; non-JSON upstream → `502 upstream_error`; TLS pin verification failed on a pinned upstream → `502 upstream_tls_error`), unhandled exception, startup validation failure, TLS certificate/key file missing or unreadable (before the port binds; the path is named, its contents never logged), listen bind failure (process exits) |
| `none` | nothing — the logger is silent |

Config uses the gateway vocabulary (`warning`, `none`); the mapping to pino's `warn`/`silent` spellings lives in exactly one place — the level table above.

## Invariants

- All log output goes to stderr; stdout stays empty for the whole process lifetime.
- There is exactly one root logger per process; its level is fixed at startup from `logLevel` and never changes at runtime in the MVP.
- `logLevel: "none"` suppresses every line.
- No file appenders exist — the gateway never opens a log file.
- Secrets — `apiKey` and `passwordHash` values and `Authorization` headers — never appear in any log line (the censor covers the header shapes and the credential config field names, `src/logging/logger.ts`).
- Request and response bodies are never logged in the MVP (metadata only), so SSE payloads never reach the log stream.
- Each log line is a single JSON object (pino default format).

## Configuration

`logLevel` from the gateway config — see [Configuration](./configuration.md) for the file location, schema, and validation; omitted → `info`. Raw JSON lines are the shipping format; humans pipe stderr through a pretty-printer locally (e.g. `pino-pretty`) — the gateway itself never formats for humans and never writes files.

## Extension Points

- Per-request correlation: a request id enters as a child-logger binding when request logging lands — call sites stay unchanged.
- Per-upstream log isolation already works via `component: "upstream:<id>"` children.
- Swapping the transport (e.g. a future OpenTelemetry bridge) touches only `src/logging/logger.ts`, not call sites.

## Related Specs

- [Configuration](./configuration.md) — `logLevel` schema and validation
- [Upstream contract](./upstreams/upstream-contract.md) — upstream-side events logged on this pipeline
- [OpenAI-compatible upstream](./upstreams/openai-compatible.md) — the redaction rules this domain enforces
