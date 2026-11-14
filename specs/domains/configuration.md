# Configuration

## Purpose

Defines the gateway's config file: where it lives, its JSON schema (the `server` listener block — `listen`, `tls` — plus `logLevel`, the `auth` block ([ADR-008](../decisions/008-management-cookie-auth.md)) and the `upstreams` array), how it is validated at startup, and how validation failures are reported. `config.example.json` is the canonical example of that schema and is kept in sync with `src/config/schema.ts`.

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

interface ServerConfig {
  /** "host:port"; omitted → "127.0.0.1:8080" (loopback until gateway-auth lands) */
  listen?: string;
  /** omitted → the listener serves plain HTTP */
  tls?: TlsConfig;
}

interface TlsConfig {
  /** required whenever the block is present: TLS is explicitly on or off (ADR-007) */
  enabled: boolean;
  /** PEM certificate-chain path; required when enabled is true */
  cert?: string;
  /** PEM private-key path; required when enabled is true */
  key?: string;
}

/**
 * Management-surface auth (ADR-008): one config-backed operator identity.
 * `enabled` is required whenever the block is present; `user` and
 * `passwordHash` are required only while enabled is true but may stay
 * staged while it is false. An omitted block means the /api/* surface is
 * ungated — behavior identical to before ADR-008.
 */
interface AuthConfig {
  /** required whenever the block is present: the gate is explicitly on or off */
  enabled: boolean;
  /** operator login; required (non-empty) when enabled is true */
  user?: string;
  /**
   * argon2id PHC hash of the operator password; required when enabled is
   * true. Prefix-validated at startup (argon2id/argon2i/argon2d/2a/2b/2y);
   * verified at login with Bun.password.verify. Generated with
   * `tools/hash-password.ts`; never echoed into a problem line.
   */
  passwordHash?: string;
}

interface GatewayConfig {
  /** listener options; an omitted server block means every default */
  server?: ServerConfig;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** omitted → the /api/* surface is ungated (ADR-008) */
  auth?: AuthConfig;
  /** at least one entry; ids unique across the array */
  upstreams: UpstreamConfig[];
}

/**
 * The masked management view (`redactedConfigView`, src/config/redact.ts):
 * served by `GET /api/configuration` (gateway-management.md). The entry point
 * builds it from the normalized config and hands the plain value to
 * `createApp` — the raw config never crosses into the HTTP layer.
 * `apiKey` is always the fixed mask `[Configured]` (`CONFIGURED_MASK`,
 * src/config/redact.ts); `tlsFingerprint` is the mask when configured,
 * `null` when absent; `baseUrl` is verbatim (not secret). `auth.passwordHash`
 * is the same mask when configured, `null` when absent (ADR-008). The view is
 * built field by field — the real credential values are never copied into it.
 */
interface RedactedTlsConfig {
  enabled: boolean;
  cert: string | null; // verbatim PEM path — not secret; null when absent
  key: string | null; // verbatim PEM path — not secret; null when absent
}

interface RedactedGatewayConfig {
  server: {
    listen: string; // the effective value after startup normalization
    tls: RedactedTlsConfig | null; // null when the config carries no tls block
  };
  logLevel: LogLevel;
  auth: {
    enabled: boolean; // mirrors the config's auth.enabled
    user: string | null; // verbatim operator login — it identifies, it does not authenticate
    passwordHash: string | null; // "[Configured]" when configured, null when absent — the hash never crosses into the view
  } | null; // null when the config carries no auth block
  upstreams: Array<{
    type: UpstreamType;
    id: string;
    baseUrl: string;
    apiKey: string; // always "[Configured]"
    tlsFingerprint: string | null; // "[Configured]" | null
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
      ┌── problems ─► one error line each on stderr ─► exit 1 (no port bound)
      └── clean ─► normalized GatewayConfig ─► logger + UpstreamRegistry
```

## Invariants

- The config is read and validated exactly once per process start; there is no hot reload in the MVP.
- A config that fails validation prevents the server from binding any port.
- Every validation problem is reported in the same startup run — the gateway never fails on the first problem and hides the rest.
- Upstream ids are unique across the whole `upstreams` array, independent of `type`.
- The default `server.listen` binds loopback only; a public interface is a deliberate config choice and stays discouraged while the LLM surface is unauthenticated (stage 1 gates only the management surface — [ADR-008](../decisions/008-management-cookie-auth.md)).
- A `server.tls` block always states `enabled` explicitly — the block without it never validates — and an enabled block requires both PEM paths ([ADR-007](../decisions/007-tls-listener-server-block.md)).
- An `auth` block always states `enabled` explicitly — the block without it never validates — and an enabled block requires `user` and a PHC-format `passwordHash` ([ADR-008](../decisions/008-management-cookie-auth.md)). An absent block or `enabled: false` leaves the management surface ungated: behavior identical to before ADR-008.
- TLS certificate and key files are read at startup, before the port binds: a missing or unreadable PEM file is a fatal startup error — one stderr line naming the path and the reason, exit 1. The paths may appear in logs; the file contents never do ([security-model.md](../architecture/security-model.md)).
- `apiKey` values live in memory only and never appear in logs.
- `auth.passwordHash` values are validated with apiKey-grade output care: a validation problem names the rule without echoing the configured hash.
- The management configuration view never carries credential values: `redactedConfigView` (`src/config/redact.ts`) replaces every `apiKey` with the fixed mask `[Configured]` and a configured `tlsFingerprint` with the same mask — `null` when absent — building the view field by field so the real values are never copied; the entry point builds the view and the raw config never crosses into the HTTP layer ([security-model.md](../architecture/security-model.md), [gateway-management.md](../contracts/gateway-management.md)).
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
| `server` | no | JSON object; unknown keys rejected | Listener options — address and TLS; an omitted block means every default |
| `server.listen` | no (default `"127.0.0.1:8080"`) | string `"host:port"`, valid host and port range | Host and port the listener binds; the default stays on loopback while gateway-auth is unimplemented |
| `server.tls` | no | JSON object with required `enabled`; unknown keys rejected | TLS options of the gateway's own listener; omitted → the listener serves plain HTTP ([ADR-007](../decisions/007-tls-listener-server-block.md)) |
| `server.tls.enabled` | yes (when `server.tls` is present) | boolean | The explicit TLS switch: `true` serves HTTPS, `false` plain HTTP — cert/key may stay configured while disabled |
| `server.tls.cert` | required when `server.tls.enabled` is `true` | non-empty string — PEM certificate-chain path | Read once at startup, before the port binds |
| `server.tls.key` | required when `server.tls.enabled` is `true` | non-empty string — PEM private-key path | Read once at startup, before the port binds; no passphrase support |
| `auth` | no | JSON object with required `enabled`; unknown keys rejected | Management-surface auth options ([ADR-008](../decisions/008-management-cookie-auth.md)): the single config-backed operator identity; omitted → `/api/*` is ungated and the gateway behaves exactly as before |
| `auth.enabled` | yes (when `auth` is present) | boolean | The explicit auth switch: `true` gates `/api/*` behind the session cookie (`POST /api/login` / `POST /api/logout` excepted), `false` keeps the gate off while credentials may stay staged |
| `auth.user` | required when `auth.enabled` is `true` | non-empty string | Operator login; shown verbatim by the management view (it identifies, it does not authenticate) |
| `auth.passwordHash` | required when `auth.enabled` is `true` | PHC-format string — prefix `argon2id` / `argon2i` / `argon2d` / `2a` / `2b` / `2y` | argon2id (default) hash of the operator password — generate with `tools/hash-password.ts`, verify with `Bun.password.verify`; the plain password never enters the config; the value is never echoed into a problem line |
| `logLevel` | no (default `info`) | one of `trace, debug, info, warning, error, none` | Verbosity of the pino logger; `none` silences log output |
| `upstreams` | yes | array with at least one entry | The provider connections the gateway fronts; config order is preserved by the registry |
| `upstreams[].type` | yes | a registered `UpstreamType` (MVP: `openai-compatible`) | Selects the upstream module that speaks the provider's dialect |
| `upstreams[].id` | yes | `^[a-z0-9][a-z0-9-]*$`, no `/`, unique across the array | Stable prefix of the public model ids this connection serves (`{upstreamId}/{model}`) |
| `upstreams[].baseUrl` | yes | absolute `http(s)` URL, including the API root with `/v1` | Upstream API root the upstream proxies to; a single trailing slash is normalized away at load |
| `upstreams[].apiKey` | yes | non-empty string | The secret sent upstream as the Bearer credential; never logged |
| `upstreams[].tlsFingerprint` | no (default: absent) | optional; base64 (standard alphabet, optional padding) decoding to exactly 32 bytes — the SHA-256 digest of the upstream certificate's SPKI DER; surrounding whitespace tolerated, stripped at load | TLS SPKI pin: non-empty → the upstream accepts ONLY the pinned key, fail closed ([ADR-005](../decisions/005-per-upstream-tls-pinning.md)); absent/empty → the system CA pool verifies the upstream; inert on a plain-http `baseUrl`; compute with `tools/tls-fingerprint.ts` |

Unknown keys are rejected at every level — root, `server`, `server.tls`, and per-upstream — so typos fail loudly at startup.

### Example file

`config.example.json` (repo root, next to `README.md`) is the canonical example config and a copy-paste starting point: copying it to `config.json` yields a valid config. It contains every supported option — optional keys included, each upstream entry showing the optional `tlsFingerprint` as a syntactically valid placeholder pin to be replaced with the real value from `tools/tls-fingerprint.ts` — and one upstream entry per registered upstream `type`. The `tls` block ships `enabled: false` with placeholder `./tls/*.pem` paths (the pair `tools/generate-tls-cert.sh` writes), so the copied example still boots as plain HTTP. The `auth` block ships `enabled: false` with a syntactically valid placeholder hash — flip `enabled` to `true` with a real hash from `tools/hash-password.ts` to switch the gate on ([ADR-008](../decisions/008-management-cookie-auth.md)). The file is pure JSON — JSON comments and extra description keys would fail the strict validation, so field descriptions live in the schema table above.

The example is part of the schema contract and is updated in the same change as `src/config/schema.ts`:

- a schema key added to, removed from, or renamed (top-level or per-upstream) is reflected in the example in the same change;
- a newly registered upstream `type` gains a sample entry in the same change;
- both rules are enforced by `src/config/example.test.ts`, which validates the example against the schema and asserts exact key coverage — a schema change without the example fails `bun test`.

### Validation errors

All problems for one start are printed to stderr, one error line each (via the logger), then the process exits with code `1`:

- file missing or unreadable — names the path that was tried;
- JSON parse error — names line/column when available;
- `logLevel` invalid — lists the six valid values;
- unknown top-level key — the valid key set is listed;
- `server` not a JSON object, or an unknown key inside `server` — the valid key set is listed;
- `server.listen` malformed — not a `"host:port"` string with a valid port;
- `server.tls` not a JSON object, or an unknown key inside `server.tls`;
- `server.tls.enabled` missing (a `tls` block without it never validates) or not a boolean;
- `server.tls.cert` / `server.tls.key` missing while TLS is enabled, or not a non-empty string path — a problem line names the field and the rule and never echoes the configured path;
- `auth` not a JSON object, or an unknown key inside `auth`;
- `auth.enabled` missing (an `auth` block without it never validates) or not a boolean;
- `auth.user` missing, empty, or not a string while auth is enabled;
- `auth.passwordHash` missing while auth is enabled, or not a PHC-format hash (argon2id/argon2i/argon2d/2a/2b/2y prefix) — the problem line names the rule and `tools/hash-password.ts` as the generator, never the configured value;
- `upstreams` empty or not an array;
- unknown upstream `type` — lists the registered types;
- `id` missing, malformed (grammar `^[a-z0-9][a-z0-9-]*$` — uppercase, `_`, or `/` rejected), or duplicated — duplicates are named;
- `baseUrl` missing or not an absolute `http(s)` URL;
- `apiKey` missing or empty;
- `tlsFingerprint` not a string, or not base64 (standard alphabet) decoding to exactly 32 bytes — the problem line names the key and the rule (naming `tools/tls-fingerprint.ts` as the generator) but never echoes the configured value.

TLS certificate and key files are read after validation, right before the listener binds ([data-flow.md](../architecture/data-flow.md)): a missing or unreadable PEM file is a separate fatal startup error — one stderr line naming the path and the reason, exit code 1, no port bound.

## Extension Points

- A new upstream `type` extends the schema with its own required fields inside `src/config/schema.ts`; validation stays in one place.
- Future: environment-variable interpolation of secrets (`apiKey`) — the file format does not change.

## Related Specs

- [Upstreams](./upstreams/README.md) — the pool built from `upstreams` entries
- [OpenAI-compatible upstream](./upstreams/openai-compatible.md) — `baseUrl` / `apiKey` semantics, and how a configured `tlsFingerprint` is enforced
- [Observability](./observability.md) — consumer of `logLevel`
- [ADR-005: per-upstream TLS SPKI pinning](../decisions/005-per-upstream-tls-pinning.md) — the `tlsFingerprint` semantics this schema validates
- [ADR-007: listener under a `server` block with explicit TLS](../decisions/007-tls-listener-server-block.md) — the hard break from top-level `listen` and the explicit `tls.enabled` switch this schema enforces
- [ADR-008: cookie-session auth for the management surface](../decisions/008-management-cookie-auth.md) — the `auth` block semantics (`enabled` switch, PHC hash, `tools/hash-password.ts`)
