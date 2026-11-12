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
`logger.child({ component: "router" | "http" | "config" | "adapter:<id>" })`.

## Flow

```
router / http / adapters / config
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
| `trace` | per-request internals: prefix parse, resolved upstream URL, header decisions |
| `debug` | request received (method, path), adapter resolved, upstream status + duration, models aggregated (count) |
| `info` | startup: config loaded, adapter probe results (connected / degraded), listening address; shutdown |
| `warning` | degraded but continuing: client aborted mid-stream, upstream answered slowly, startup probe failed (adapter degraded) |
| `error` | request failed (upstream unreachable/timeout → `504 upstream_timeout`; non-JSON upstream → `502 upstream_error`; TLS pin verification failed on a pinned upstream → `502 upstream_tls_error`), unhandled exception, startup validation failure |
| `none` | nothing — the logger is silent |

Config uses the gateway vocabulary (`warning`, `none`); the mapping to pino's `warn`/`silent` spellings lives in exactly one place — the level table above.

## Invariants

- All log output goes to stderr; stdout stays empty for the whole process lifetime.
- There is exactly one root logger per process; its level is fixed at startup from `logLevel` and never changes at runtime in the MVP.
- `logLevel: "none"` suppresses every line.
- No file appenders exist — the gateway never opens a log file.
- Secrets — `apiKey` values and `Authorization` headers — never appear in any log line.
- Request and response bodies are never logged in the MVP (metadata only), so SSE payloads never reach the log stream.
- Each log line is a single JSON object (pino default format).

## Configuration

`logLevel` from the gateway config — see [Configuration](./configuration.md) for the file location, schema, and validation; omitted → `info`. Raw JSON lines are the shipping format; humans pipe stderr through a pretty-printer locally (e.g. `pino-pretty`) — the gateway itself never formats for humans and never writes files.

## Extension Points

- Per-request correlation: a request id enters as a child-logger binding when request logging lands — call sites stay unchanged.
- Per-adapter log isolation already works via `component: "adapter:<id>"` children.
- Swapping the transport (e.g. a future OpenTelemetry bridge) touches only `src/logging/logger.ts`, not call sites.

## Related Specs

- [Configuration](./configuration.md) — `logLevel` schema and validation
- [Adapter contract](./adapters/adapter-contract.md) — adapter-side events logged on this pipeline
- [OpenAI-compatible adapter](./adapters/openai-compatible.md) — the redaction rules this domain enforces
