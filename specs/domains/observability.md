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
`logger.child({ component: "router" | "http" | "config" | "upstream:<id>" | "auth" | "client-auth" })`.
A `socks5://` proxy's loopback bridge (`src/upstreams/socks-bridge.ts`) has no logger of its own — it receives its owning upstream's child logger at construction, so its lifecycle and dial lines carry that upstream's `component` binding (ADR-017).

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
| `trace` | per-request internals; the auth stage emits one trace line per request (method, path) — its message names every mounted gate (session — ADR-007; client Bearer — ADR-008), or the pass-through placeholder when neither credential block is configured |
| `debug` | request handled (method, path, status, duration, resolved upstream id), alias resolved on completions dispatch (alias, upstream id, upstream model, upstream path, attempt — one line per failover attempt; a 403 denial logs the alias and the client), failover exhausted within a request (alias, attempts), alias catalog served (count, client name when authenticated), auth events (login succeeded / login failed; a management request without a valid session — 401; a client request without a Bearer key or with an unknown key — 401; a client authenticated — client name, never the key); a `socks5://` proxy's bridge tunnel open (target `host:port`, dial ms) and a bridge client-socket error (`err`) — both through the owning upstream's child logger, ADR-017; the LM Studio native probe leg skipped (upstream, reason — the silent skip of the two-leg probe); the live model list fetched (upstream id, entry count) |
| `info` | startup: config loaded, upstream probe ok (connected — the failed case is the warning row), route inventory cross-checked against the retained startup catalogs (matched / missing / unknown counts), listening address with the TLS fact (`tls: true|false` — never PEM contents); a route recovered — the half-open probe succeeded (alias, upstream, model); a `socks5://` proxy's loopback bridge listening (`proxy` scheme/host:port + the loopback `listen` address) and stopped (`proxy` only) — ADR-017, one bridge per such upstream, started with its first outbound call; the management CRUD's hot-apply (upstream created / updated / deleted, model alias created / updated / deleted, client created / updated / removed — each naming the entry; the client digest registry rebuilt); the live listing's `discover=1` run swapping an upstream's metadata slice (ADR-016); shutdown |
| `warning` | degraded but continuing: startup probe failed (upstream degraded, startup continues); a configured route's model absent from its upstream's retained startup catalog (one line per route — alias, upstream, model; startup continues); a pre-first-byte upstream failure failing over (alias, upstream id, upstream model, status, attempt); a route marked unhealthy — cooldown started (alias, upstream, model, failures, cooldownMs); no healthy route for an alias — 503 answered without upstream contact (alias); a `socks5://` bridge's SOCKS dial failed (target, `reason` — the bridge answers its client with a marked `502`, which the upstream then maps, ADR-017); an upstream forward rejected before its first byte — the route marked failed (alias, upstream, the error); the live model listing failed (upstream id, log-safe reason — retain-last-good on `discover=1`) |
| `error` | request failed (upstream unreachable/timeout → `504 upstream_timeout`; non-JSON upstream → `502 upstream_error`; TLS pin verification failed on a pinned upstream → `502 upstream_tls_error`; the upstream's configured outbound proxy refused or failed the connection → `502 upstream_proxy_error`, the line carrying `code`, a value-free `reason`, and the proxy's `{ scheme, host, port }` — never credentials (the grammar admits none) and never request bytes, ADR-017), unhandled exception, startup validation failure, TLS certificate/key file missing or unreadable (before the port binds; the path is named, its contents never logged), listen bind failure (process exits) |
| `none` | nothing — the logger is silent |

Config uses the gateway vocabulary (`warning`, `none`); the mapping to pino's `warn`/`silent` spellings lives in exactly one place — the level table above.

## Invariants

- All log output goes to stderr; stdout stays empty for the whole process lifetime.
- There is exactly one root logger per process; its level is fixed at startup from `logLevel` and never changes at runtime in the MVP.
- `logLevel: "none"` suppresses every line.
- No file appenders exist — the gateway never opens a log file.
- Secrets — `apiKey` and `passwordHash` values and `Authorization` headers — never appear in any log line (the censor covers the header shapes and the credential config field names, `src/logging/logger.ts`). Proxy-related lines are safe by construction: a `proxy` URL carries no userinfo (the config grammar rejects it), so the bridge's `{ proxy, listen }` fields and the `upstream_proxy_error` line's `{ scheme, host, port }` can hold coordinates only — never credentials, never request bytes (ADR-017).
- Request and response bodies are never logged in the MVP (metadata only), so SSE payloads never reach the log stream.
- Each log line is a single JSON object (pino default format), except that the level is rendered as pino's string label — `trace`/`debug`/`info`/`warn`/`error` — instead of the numeric code.

## Configuration

`logLevel` from the gateway config — see [Configuration](./configuration.md) for the file location, schema, and validation; omitted → `info`. Raw JSON lines are the shipping format; humans pipe stderr through a pretty-printer locally (e.g. `pino-pretty`) — the gateway itself never formats for humans and never writes files. Emitted level labels are pino's own spellings (`trace`/`debug`/`info`/`warn`/`error`); the config vocabulary keeps its dictionary in `PINO_LEVEL` (Core Types).

## Extension Points

- Per-request correlation: a request id enters as a child-logger binding when request logging lands — call sites stay unchanged.
- Per-upstream log isolation already works via `component: "upstream:<id>"` children.
- Swapping the transport (e.g. a future OpenTelemetry bridge) touches only `src/logging/logger.ts`, not call sites.

## Related Specs

- [Configuration](./configuration.md) — `logLevel` schema and validation
- [Upstream contract](./upstreams/upstream-contract.md) — upstream-side events logged on this pipeline
- [OpenAI-compatible upstream](./upstreams/openai-compatible.md) — the redaction rules this domain enforces
