# Configuration

## Purpose

Defines the gateway's config file: where it lives, its JSON schema (`listen`, `logLevel`, plus the `upstreams` array), how it is validated at startup, and how validation failures are reported. `config.example.json` is the canonical example of that schema and is kept in sync with `src/config/schema.ts`.

## Key Files

- `src/config/schema.ts` — `GatewayConfig` types and validation rules, including per-type upstream fields
- `src/config/redact.ts` — `redactedConfigView`: the masked management view of the config (`RedactedGatewayConfig`), the only config shape the HTTP layer ever receives
- `src/config/load.ts` — file discovery, read, parse, error aggregation, normalized config out
- `config.example.json` — canonical example config at the repo root: every supported option at its documented default, ready to copy to `config.json`
- `src/config/example.test.ts` — sync enforcement: fails `bun test` when the example drifts from the schema

## Core Types

```ts
type LogLevel = "trace" | "debug" | "info" | "warning" | "error" | "none";

type UpstreamType = "openai-compatible"; // one per implemented upstream module

interface UpstreamConfig {
  type: UpstreamType;
  /** ^[a-z0-9][a-z0-9-]*$ — unique across the config; never contains "/" */
  id: string;
  /** absolute http(s) URL including the API root with /v1 (e.g. https://api.openai.com/v1) */
  baseUrl: string;
  /** non-empty; sent upstream as the Bearer credential only */
  apiKey: string;
  /**
   * optional TLS SPKI pin: base64 (standard alphabet) of SHA-256 over the
   * upstream certificate's SubjectPublicKeyInfo DER (exactly 32 bytes decoded);
   * absent/empty → default system-CA verification; set → ONLY the pinned key
   * is accepted (ADR-005); inert on a plain-http baseUrl;
   * computed with `tools/tls-fingerprint.ts`
   */
  tlsFingerprint?: string;
}

interface GatewayConfig {
  /** "host:port"; omitted → "127.0.0.1:8080" (loopback until gateway-auth lands) */
  listen?: string;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** at least one entry; ids unique across the array */
  upstreams: UpstreamConfig[];
}

/**
 * The masked management view (`redactedConfigView`, src/config/redact.ts):
 * served by `GET /api/configuration` (gateway-management.md). The entry point
 * builds it from the normalized config and hands the plain value to
 * `createApp` — the raw config never crosses into the HTTP layer.
 * `apiKey` is always the fixed mask `[Redacted]` (the logging layer's censor,
 * src/logging/logger.ts); `tlsFingerprint` is the mask when configured,
 * `null` when absent; `baseUrl` is verbatim (not secret). The view is built
 * field by field — the real credential values are never copied into it.
 */
interface RedactedGatewayConfig {
  listen: string;
  logLevel: LogLevel;
  upstreams: Array<{
    type: UpstreamType;
    id: string;
    baseUrl: string;
    apiKey: string; // always "[Redacted]"
    tlsFingerprint: string | null; // "[Redacted]" | null
  }>;
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
      └── clean ─► normalized GatewayConfig ─► logger + UpstreamRegistry
```

## Invariants

- The config is read and validated exactly once per process start; there is no hot reload in the MVP.
- A config that fails validation prevents the server from binding any port.
- Every validation problem is reported in the same startup run — the gateway never fails on the first problem and hides the rest.
- Upstream ids are unique across the whole `upstreams` array, independent of `type`.
- The default `listen` binds loopback only; a public interface is a deliberate config choice and stays discouraged while gateway-auth is unimplemented.
- `apiKey` values live in memory only and never appear in logs.
- The management configuration view never carries credential values: `redactedConfigView` (`src/config/redact.ts`) replaces every `apiKey` with the fixed mask `[Redacted]` and a configured `tlsFingerprint` with the same mask — `null` when absent — building the view field by field so the real values are never copied; the entry point builds the view and the raw config never crosses into the HTTP layer ([security-model.md](../architecture/security-model.md), [gateway-management.md](../contracts/gateway-management.md)).
- `tlsFingerprint` values are validated with apiKey-grade output care: a validation problem names the rule without echoing the configured pin (a pin is not a secret, but typo diagnosis never needs the value).
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
| `upstreams` | yes | array with at least one entry | The provider connections the gateway fronts; config order is preserved by the registry |
| `upstreams[].type` | yes | a registered `UpstreamType` (MVP: `openai-compatible`) | Selects the upstream module that speaks the provider's dialect |
| `upstreams[].id` | yes | `^[a-z0-9][a-z0-9-]*$`, no `/`, unique across the array | Stable prefix of the public model ids this connection serves (`{upstreamId}/{model}`) |
| `upstreams[].baseUrl` | yes | absolute `http(s)` URL, including the API root with `/v1` | Upstream API root the upstream proxies to; a single trailing slash is normalized away at load |
| `upstreams[].apiKey` | yes | non-empty string | The secret sent upstream as the Bearer credential; never logged |
| `upstreams[].tlsFingerprint` | no (default: absent) | optional; base64 (standard alphabet, optional padding) decoding to exactly 32 bytes — the SHA-256 digest of the upstream certificate's SPKI DER; surrounding whitespace tolerated, stripped at load | TLS SPKI pin: non-empty → the upstream accepts ONLY the pinned key, fail closed ([ADR-005](../decisions/005-per-upstream-tls-pinning.md)); absent/empty → the system CA pool verifies the upstream; inert on a plain-http `baseUrl`; compute with `tools/tls-fingerprint.ts` |

Unknown top-level keys and unknown per-upstream keys are rejected — the schema is strict, so typos fail loudly at startup.

### Example file

`config.example.json` (repo root, next to `README.md`) is the canonical example config and a copy-paste starting point: copying it to `config.json` yields a valid config. It contains every supported option — optional keys included, each upstream entry showing the optional `tlsFingerprint` as a syntactically valid placeholder pin to be replaced with the real value from `tools/tls-fingerprint.ts` — and one upstream entry per registered upstream `type`. The file is pure JSON — JSON comments and extra description keys would fail the strict validation, so field descriptions live in the schema table above.

The example is part of the schema contract and is updated in the same change as `src/config/schema.ts`:

- a schema key added to, removed from, or renamed (top-level or per-upstream) is reflected in the example in the same change;
- a newly registered upstream `type` gains a sample entry in the same change;
- both rules are enforced by `src/config/example.test.ts`, which validates the example against the schema and asserts exact key coverage — a schema change without the example fails `bun test`.

### Validation errors

All problems for one start are printed to stderr, one error line each (via the logger), then the process exits with code `1`:

- file missing or unreadable — names the path that was tried;
- JSON parse error — names line/column when available;
- `logLevel` invalid — lists the six valid values;
- `listen` malformed — not a `"host:port"` string with a valid port;
- `upstreams` empty or not an array;
- unknown upstream `type` — lists the registered types;
- `id` missing, malformed (grammar `^[a-z0-9][a-z0-9-]*$` — uppercase, `_`, or `/` rejected), or duplicated — duplicates are named;
- `baseUrl` missing or not an absolute `http(s)` URL;
- `apiKey` missing or empty;
- `tlsFingerprint` not a string, or not base64 (standard alphabet) decoding to exactly 32 bytes — the problem line names the key and the rule (naming `tools/tls-fingerprint.ts` as the generator) but never echoes the configured value.

## Extension Points

- A new upstream `type` extends the schema with its own required fields inside `src/config/schema.ts`; validation stays in one place.
- Future: environment-variable interpolation of secrets (`apiKey`) — the file format does not change.

## Related Specs

- [Upstreams](./upstreams/README.md) — the pool built from `upstreams` entries
- [OpenAI-compatible upstream](./upstreams/openai-compatible.md) — `baseUrl` / `apiKey` semantics, and how a configured `tlsFingerprint` is enforced
- [Observability](./observability.md) — consumer of `logLevel`
- [ADR-005: per-upstream TLS SPKI pinning](../decisions/005-per-upstream-tls-pinning.md) — the `tlsFingerprint` semantics this schema validates
