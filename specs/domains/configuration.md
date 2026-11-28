# Configuration

## Purpose

Defines the gateway's config file: where it lives, its JSON schema (the `server` listener block — `listen`, `maxRequestBodyBytes`, `tls` — plus `logLevel`, the `auth` block ([ADR-007](../decisions/007-management-cookie-auth.md)), the `clients` array, the `models` array and the `upstreams` array — whose optional per-upstream outbound `proxy` is [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)), how it is validated at startup, how validation failures are reported, and how the three mutable collections are validated and written back at runtime ([ADR-014](../decisions/014-runtime-management-crud.md)). `config.example.json` is the canonical example of that schema and is kept in sync with `src/config/schema.ts`.

## Key Files

- `src/config/schema.ts` — `GatewayConfig` types and validation rules, including per-type upstream fields and the `clients`/`models` blocks with their cross-block references
- `src/config/schema.test.ts` — unit tests for the schema's validation rules, focused on the `clients`/`models` blocks (freeze, unknown keys, cross-references, strategy/weight consistency)
- `src/config/redact.ts` — `redactedConfigView`: the masked management view of the config (`RedactedGatewayConfig`), the only config shape the HTTP layer ever receives
- `src/config/load.ts` — file discovery, read, parse, error aggregation, normalized config out
- `src/config/store.ts` — the runtime configuration store ([ADR-014](../decisions/014-runtime-management-crud.md) D1): the holder of the current normalized config whose `upstreams` / `models` / `clients` collections the management boundary mutates — every mutation is a synchronous validate → persist → apply pass writing `config.json` back (sibling temp file + atomic rename)
- `src/config/store.test.ts` — unit tests for the store's write rules (keep-existing credentials and proxy, clear-on-null, mask-literal rejection, immutable identity keys, reference refusals, last-entry rules, atomic persist, value-free problem lines)
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
   * absent/empty → default system-CA verification (an empty or whitespace-only
   * value is normalized away — the entry never carries ""); set → ONLY the
   * pinned key is accepted (ADR-004); inert on a plain-http baseUrl;
   * computed with `tools/tls-fingerprint.ts`
   */
  tlsFingerprint?: string;
  /**
   * optional outbound proxy the upstream's requests go through (ADR-017):
   * an http: or socks5: URL with a non-empty host, an explicit port in
   * 1-65535, no username/password and no path (beyond "/"), query or
   * fragment; absent / null / empty / whitespace-only → a direct
   * connection (no key in the normalized config); otherwise stored trimmed;
   * the value is never echoed into a problem line
   */
  proxy?: string;
}

interface ServerConfig {
  /** "host:port"; omitted → "127.0.0.1:8080" (the loopback default) */
  listen?: string;
  /**
   * the request-body cap in bytes — an integer in 1..67108864 (64 MiB
   * at most): every parsed JSON body (completions dispatch
   * and POST /api/login alike) is read under it and an over-limit body is
   * answered 413 before parse; omitted → 4194304 (4 MiB)
   */
  maxRequestBodyBytes?: number;
  /** omitted → the listener serves plain HTTP */
  tls?: TlsConfig;
}

interface TlsConfig {
  /** required whenever the block is present: TLS is explicitly on or off (ADR-006) */
  enabled: boolean;
  /** PEM certificate-chain path; required when enabled is true */
  cert?: string;
  /** PEM private-key path; required when enabled is true */
  key?: string;
}

/**
 * Management-surface auth (ADR-007): one config-backed operator identity.
 * `enabled` is required whenever the block is present; `user` and
 * `passwordHash` are required only while enabled is true but may stay
 * staged while it is false. An omitted block means the /api/* surface is
 * ungated.
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

/**
 * Load-balancing strategies a `models` entry may select between. `round-robin`
 * rotates routes in config order (weights rejected); `weighted-round-robin`
 * repeats routes proportionally to their weight (weight required everywhere).
 */
type BalanceStrategy = "round-robin" | "weighted-round-robin";

/** One client credential entry. */
interface ClientConfig {
  /** non-empty; unique across the config; names the entry in the management view and in problem lines */
  name: string;
  /** non-empty; the credential the gateway expects from this client; never logged, masked in the management view */
  apiKey: string;
  /** at least one model alias this client may address; every entry must reference an existing models[].alias */
  models: string[];
}

/** One concrete upstream target inside a models entry. */
interface ModelRouteConfig {
  /** non-empty; must reference an existing upstreams[].id */
  upstream: string;
  /** non-empty; the provider-native model name sent upstream in body.model */
  model: string;
  /** positive integer; required on every route under weighted-round-robin, rejected under round-robin */
  weight?: number;
}

/** Load-balancing options of a models entry; strategy is required when the block is present. */
interface ModelBalanceConfig {
  strategy: BalanceStrategy;
}

/**
 * Optional token-budget limits of a models entry. Both keys are optional,
 * but a present block always carries at least one — an empty `limits` block
 * never validates. The values are recorded with the entry and surfaced by
 * the management view verbatim (not secret); the config layer only
 * validates and freezes them.
 */
interface ModelLimitsConfig {
  /** positive integer: the model's context window in tokens */
  context?: number;
  /** positive integer: the model's maximum output in tokens */
  output?: number;
}

/** One aliased, balanced model entry. */
interface ModelConfig {
  /** client-facing model id; non-empty, no "/" and no whitespace (a model id is a single URL path segment); unique across the array */
  alias: string;
  /** at least one route; duplicate upstream/model pairs within one entry are rejected */
  routes: ModelRouteConfig[];
  /** required: how the gateway rotates the routes when this alias is addressed */
  balance: ModelBalanceConfig;
  /** optional limits block; a present block always carries at least one of context/output */
  limits?: ModelLimitsConfig;
}

interface GatewayConfig {
  /** listener options; an omitted server block means every default */
  server?: ServerConfig;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** omitted → the /api/* surface is ungated (ADR-007) */
  auth?: AuthConfig;
  /** omitted → no client credentials are configured; present → at least one entry, names unique */
  clients?: ClientConfig[];
  /** omitted → no model aliases are configured; present → at least one entry, aliases unique */
  models?: ModelConfig[];
  /** at least one entry; ids unique across the array */
  upstreams: UpstreamConfig[];
}

/**
 * The masked management view (`redactedConfigView`, src/config/redact.ts):
 * served by the management CRUD reads through the runtime store's
 * `ConfigStore.view` (gateway-management.md). The store rebuilds the view
 * from its current snapshot on demand, so a read after a mutation serves
 * the mutated, masked state. Every `apiKey` (upstream or client) is always
 * the fixed mask `[Configured]` (`CONFIGURED_MASK`, src/config/redact.ts);
 * `tlsFingerprint` is the mask when the normalized entry carries the key,
 * `null` when absent — an empty or whitespace-only configured value is
 * normalized away at load and on every management write, so it never reaches
 * the entry (or the view) as `""`;
 * `baseUrl` and `proxy` are verbatim (not secret — the proxy grammar admits
 * no userinfo). `auth.passwordHash` is the same mask
 * when configured, `null` when absent (ADR-007). The view is built field by
 * field — the real credential values are never copied into it.
 */
interface RedactedTlsConfig {
  enabled: boolean;
  cert: string | null; // verbatim PEM path — not secret; null when absent
  key: string | null; // verbatim PEM path — not secret; null when absent
}

interface RedactedGatewayConfig {
  server: {
    listen: string; // the effective value after startup normalization
    maxRequestBodyBytes: number; // the effective request-body cap in bytes after startup normalization — not secret
    tls: RedactedTlsConfig | null; // null when the config carries no tls block
  };
  logLevel: LogLevel;
  auth: {
    enabled: boolean; // mirrors the config's auth.enabled
    user: string | null; // verbatim operator login — it identifies, it does not authenticate
    passwordHash: string | null; // "[Configured]" when configured, null when absent — the hash never crosses into the view
  } | null; // null when the config carries no auth block
  clients: Array<{
    name: string; // verbatim client name — it identifies, it does not authenticate
    apiKey: string; // always "[Configured]" — masked like every other credential
    models: string[]; // verbatim aliases — not secret
  }> | null; // null when the config carries no clients block
  models: Array<{
    alias: string; // verbatim
    routes: Array<{ upstream: string; model: string; weight: number | null }>; // verbatim; weight null when absent
    balance: { strategy: BalanceStrategy }; // mirrors the config's balance block
    limits: { context: number | null; output: number | null } | null; // mirrors the config's optional limits block verbatim (not secret); null when the entry carries none
  }> | null; // null when the config carries no models block
  upstreams: Array<{
    type: UpstreamType;
    id: string;
    baseUrl: string;
    apiKey: string; // always "[Configured]"
    tlsFingerprint: string | null; // "[Configured]" | null
    proxy: string | null; // verbatim proxy URL — not secret (the grammar admits no userinfo); null when absent (ADR-017)
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
                                              + ConfigStore(config, path)

runtime mutation (ADR-014: POST/PUT/DELETE on /api/{upstreams,models,clients})
  validate(candidate, current collections) ── problems ─► 400 envelope, stop
        │ ok
        ▼
  read raw file ─► replace upstreams / models / clients ONLY ─►
  write sibling temp file ─► rename onto config.json (atomic)
        │ write failure ─► 400 envelope (memory untouched)
        ▼
  deep-frozen rebuild of the normalized config ─► hot-apply
  (registry swap | routing rebuild | gate digest swap)
```

## Invariants

- At startup the config is read and validated exactly once per process start; the running gateway reloads nothing implicitly — the only runtime change channel is the management CRUD's write-back ([ADR-014](../decisions/014-runtime-management-crud.md)), which re-validates every mutation through the same grammar before it persists.
- A config that fails validation prevents the server from binding any port.
- Every validation problem is reported in the same startup run — the gateway never fails on the first problem and hides the rest.
- Upstream ids are unique across the whole `upstreams` array, independent of `type`.
- Client names are unique across the whole `clients` array and model aliases are unique across the whole `models` array; an alias is a non-empty string without `/` and without whitespace — a model id is a single URL path segment ([ADR-009](../decisions/009-alias-table-routing.md)).
- Every alias a client lists names a defined `models[].alias`, and every route's `upstream` names a registered `upstreams[].id` — a broken cross-block reference fails startup like any other config error.
- A `balance` block always states `strategy` explicitly — the block without it never validates. An entry with the `weighted-round-robin` strategy carries a positive integer weight on every route; an entry with the `round-robin` strategy rejects route weights.
- A `limits` block, when present, always carries at least one of `context` / `output` — an empty block never validates — and both keys are positive integers when configured; unknown keys inside the block are rejected. The values travel with the entry as-is: the config layer validates and freezes them, the management view mirrors them verbatim (not secret).
- The normalized config returned by validation is deep-frozen; a runtime mutation replaces it wholesale with the freshly validated, frozen snapshot — consumers always read an immutable view ([ADR-014](../decisions/014-runtime-management-crud.md) D2).
- A runtime mutation reaches memory only after its write-back succeeded: the store reads the raw config file, replaces only the three mutable sections, writes a sibling temp file (file mode preserved) and renames it onto the config file — a same-directory, same-filesystem atomic replace — and rebuilds the in-memory snapshot only after that write ([ADR-014](../decisions/014-runtime-management-crud.md) D1). A validation problem or a failed write leaves both disk and memory untouched, and the file on disk and the state in memory never diverge. It is the gateway's only runtime file write.
- A key written as JSON `null` is the key not set at every level of the grammar (`withoutNulls`, `src/config/schema.ts`): an optional key takes its default or stays absent (`logLevel: null` → `info`, `server.tls: null` → plain HTTP, `models[].limits: null` → no limits, a `null` route weight → an unweighted route, `tlsFingerprint: null` → no pin), a required key is reported missing exactly like an absent one, and an array element written as `null` is still a type error — the rule covers keys, not elements. The strict-key pass runs over the raw object, so an unknown key is reported even when its value is `null`.
- The store's write rules ([ADR-014](../decisions/014-runtime-management-crud.md) D6/D7): create requires a key; an absent `apiKey` on an update keeps the stored credential; the null rule is point-applied to every write body — a `null` on a required or inherited key reads as omitted, and a `null` on an optional field (a route weight, a single limit, the `limits` block) leaves the entry without it, the update replacing those wholesale; the literal mask `[Configured]` is rejected wherever a credential-shaped value is expected; an absent `tlsFingerprint` on an update keeps the stored pin, while an explicit `null` — or the grammar's empty / whitespace-only value, normalized to no pin the same way the startup loader normalizes it — clears it; the identifying key of an entry (`upstreams[].id`, `models[].alias`, `clients[].name`) is immutable on update; deleting a resource that live configuration still references is refused with problem lines naming the referencing entries (the management `409 resource_in_use`); a collection that is present keeps at least one entry, and a block absent at startup appears with the first add and then follows the same rule.
- A runtime mutation preserves the config sections it does not manage: `server`, `logLevel` and `auth` survive every write-back verbatim from the raw file; after the first runtime mutation the store, not a hand editor, owns the three mutable sections until the next restart.
- Problem lines the store produces are value-free where it matters: `apiKey` / pin material is never echoed, and persist failures name the path and the errno code without quoting file content — unlike the startup loader's parse errors, these lines can cross into HTTP error envelopes ([gateway-management.md](../contracts/gateway-management.md)).
- The default `server.listen` binds loopback only; a public interface is a deliberate config choice and stays discouraged while the LLM surface is ungated (no clients and no store — [ADR-008](../decisions/008-client-bearer-auth.md)).
- A `server.tls` block always states `enabled` explicitly — the block without it never validates — and an enabled block requires both PEM paths ([ADR-006](../decisions/006-tls-listener-server-block.md)).
- The request-body cap is a startup constant: `server.maxRequestBodyBytes` (default 4 MiB, bounded above at 64 MiB) is validated once and enforced by the body reader (`src/httpapi/body.ts`) on every parsed request. The listener deliberately receives no runtime body limit of its own — a runtime-level rejection would bypass the OpenAI error envelope ([client-gateway.md](../contracts/client-gateway.md)).
- An `auth` block always states `enabled` explicitly — the block without it never validates — and an enabled block requires `user` and a PHC-format `passwordHash` ([ADR-007](../decisions/007-management-cookie-auth.md)). An absent block or `enabled: false` leaves the management surface ungated.
- TLS certificate and key files are read at startup, before the port binds: a missing or unreadable PEM file is a fatal startup error — one stderr line naming the path and the reason, exit 1. The paths may appear in logs; the file contents never do ([security-model.md](../architecture/security-model.md)).
- `apiKey` values (upstream and client) live in memory only and never appear in logs.
- `auth.passwordHash` values are validated with apiKey-grade output care: a validation problem names the rule without echoing the configured hash.
- The management configuration view never carries credential values: `redactedConfigView` (`src/config/redact.ts`) replaces every `apiKey` (upstream or client) with the fixed mask `[Configured]` and a `tlsFingerprint` the normalized entry carries with the same mask — `null` when absent (an empty or whitespace-only configured value is normalized away before the entry exists, so it reads as absent, never as the mask) — building the view field by field so the real values are never copied; the entry point builds the view and the raw config never crosses into the HTTP layer ([security-model.md](../architecture/security-model.md), [gateway-management.md](../contracts/gateway-management.md)).
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
| `server.listen` | no (default `"127.0.0.1:8080"`) | string `"host:port"`, valid host and port range | Host and port the listener binds; the default stays on loopback |
| `server.maxRequestBodyBytes` | no (default `4194304` — 4 MiB) | integer 1–67108864 (bytes) | The request-body cap: every parsed JSON body (completions dispatch and `POST /api/login` alike) is read under it, and an over-limit body is answered `413` `request_too_large` before parse — always as the envelope, since the listener receives no runtime-level body limit (the reader stays the single enforcement point; [client-gateway.md](../contracts/client-gateway.md)) |
| `server.tls` | no | JSON object with required `enabled`; unknown keys rejected | TLS options of the gateway's own listener; omitted → the listener serves plain HTTP ([ADR-006](../decisions/006-tls-listener-server-block.md)) |
| `server.tls.enabled` | yes (when `server.tls` is present) | boolean | The explicit TLS switch: `true` serves HTTPS, `false` plain HTTP — cert/key may stay configured while disabled |
| `server.tls.cert` | required when `server.tls.enabled` is `true` | non-empty string — PEM certificate-chain path | Read once at startup, before the port binds |
| `server.tls.key` | required when `server.tls.enabled` is `true` | non-empty string — PEM private-key path | Read once at startup, before the port binds; no passphrase support |
| `auth` | no | JSON object with required `enabled`; unknown keys rejected | Management-surface auth options ([ADR-007](../decisions/007-management-cookie-auth.md)): the single config-backed operator identity; omitted → `/api/*` is ungated |
| `auth.enabled` | yes (when `auth` is present) | boolean | The explicit auth switch: `true` gates `/api/*` behind the session cookie (`POST /api/login` / `POST /api/logout` excepted), `false` keeps the gate off while credentials may stay staged |
| `auth.user` | required when `auth.enabled` is `true` | non-empty string | Operator login; shown verbatim by the management view (it identifies, it does not authenticate) |
| `auth.passwordHash` | required when `auth.enabled` is `true` | PHC-format string — prefix `argon2id` / `argon2i` / `argon2d` / `2a` / `2b` / `2y` | argon2id (default) hash of the operator password — generate with `tools/hash-password.ts`, verify with `Bun.password.verify`; the plain password never enters the config; the value is never echoed into a problem line |
| `clients` | no | array with at least one entry when present | Client credentials the gateway recognizes; a configured block enables the client Bearer gate on `/llm/v1/*` ([ADR-008](../decisions/008-client-bearer-auth.md)); an omitted block means no client is configured — and because production always wires the runtime store, the gate still mounts there over the empty registry and answers every `/llm/v1/*` request `401` fail-closed until the clients CRUD creates the first entry ([ADR-014](../decisions/014-runtime-management-crud.md)); only a store-less embedding with no block serves the surface ungated |
| `clients[].name` | yes (when `clients` is present) | non-empty string, unique across the array | Entry name shown by the management view and named by problem lines — it identifies, it does not authenticate |
| `clients[].apiKey` | yes (when `clients` is present) | non-empty string | The credential the gateway expects from this client as `Authorization: Bearer <apiKey>`; never logged, masked as `[Configured]` in the management view; the value is never echoed into a problem line |
| `clients[].models` | yes (when `clients` is present) | array with at least one entry of non-empty strings, each unique within the entry | The model aliases this client may address — every entry must reference a defined `models[].alias` or startup fails; the references are validated at startup and the list is enforced at request time — an alias outside it answers `403` ([ADR-009](../decisions/009-alias-table-routing.md)) |
| `models` | no | array with at least one entry when present | Aliased, load-balanced model definitions; an omitted block means no alias is configured |
| `models[].alias` | yes (when `models` is present) | non-empty string without `/` and without whitespace, unique across the array | The client-facing model id this entry defines — addressed directly as `model` in completion requests; `/` is reserved (a model id is a single URL path segment, [ADR-009](../decisions/009-alias-table-routing.md)) |
| `models[].routes` | yes (when `models` is present) | array with at least one entry; duplicate `upstream`/`model` pairs within one entry rejected | The concrete upstream targets the alias is served by, in config order |
| `models[].routes[].upstream` | yes (when the route is present) | non-empty string naming an existing `upstreams[].id` | The upstream the route forwards to — an unknown id fails startup |
| `models[].routes[].model` | yes (when the route is present) | non-empty string | The provider-native model name sent upstream in `body.model` |
| `models[].routes[].weight` | required on every route when the entry's strategy is `weighted-round-robin`; rejected when it is `round-robin` | positive integer | The route's share in weighted round-robin rotation |
| `models[].balance` | yes (when `models` is present) | JSON object with required `strategy`; unknown keys rejected | Load-balancing options of the entry; omitted → the entry never validates (the strategy is always stated explicitly) |
| `models[].balance.strategy` | yes (when `balance` is present) | one of `round-robin, weighted-round-robin` | `round-robin` rotates routes in config order; `weighted-round-robin` repeats routes proportionally to their `weight` |
| `models[].limits` | no | JSON object carrying at least one of `context` / `output`; unknown keys rejected | Optional token-budget limits recorded with the entry; omitted → the entry carries none; an empty block never validates |
| `models[].limits.context` | no (but at least one of `context` / `output` is required when `limits` is present) | positive integer | The model's context window in tokens |
| `models[].limits.output` | no (same rule as `limits.context`) | positive integer | The model's maximum output in tokens |
| `logLevel` | no (default `info`) | one of `trace, debug, info, warning, error, none` | Verbosity of the pino logger; `none` silences log output |
| `upstreams` | yes | array with at least one entry | The provider connections the gateway fronts; config order is preserved by the registry |
| `upstreams[].type` | yes | a registered `UpstreamType` (MVP: `openai-compatible`) | Selects the upstream module that speaks the provider's dialect |
| `upstreams[].id` | yes | `^[a-z0-9][a-z0-9-]*$`, no `/`, unique across the array | Registry key that `models[].routes[].upstream` references to route an alias to this connection ([ADR-009](../decisions/009-alias-table-routing.md)) |
| `upstreams[].baseUrl` | yes | absolute `http(s)` URL, including the API root with `/v1` | Upstream API root the upstream proxies to; a single trailing slash is normalized away at load |
| `upstreams[].apiKey` | yes | non-empty string | The secret sent upstream as the Bearer credential; never logged |
| `upstreams[].tlsFingerprint` | no (default: absent) | optional; base64 (standard alphabet, optional padding) decoding to exactly 32 bytes — the SHA-256 digest of the upstream certificate's SPKI DER; surrounding whitespace tolerated, stripped at load; `null`, an empty or a whitespace-only value is not set — the entry carries no key, never `null` or `""` | TLS SPKI pin: set → the upstream accepts ONLY the pinned key, fail closed ([ADR-004](../decisions/004-per-upstream-tls-pinning.md)); absent/null/empty → the system CA pool verifies the upstream; inert on a plain-http `baseUrl`; compute with `tools/tls-fingerprint.ts` |
| `upstreams[].proxy` | no (default: absent) | optional; `null`, empty or whitespace-only → a direct connection; otherwise an `http:` or `socks5:` URL with a non-empty host, an explicit port in 1–65535, no username/password, and no path (beyond `/`), query or fragment — stored trimmed; an explicit `:80` is accepted (`new URL` elides a default port) | Outbound proxy the upstream's requests go through ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)); absent → a direct connection. Proxy credentials are never admitted — a `user:pass@` URL is a config error and the problem line never echoes the value. An `http:` value is handed to Bun's `fetch({ proxy })` as-is; a `socks5:` value is carried by the gateway's per-upstream loopback HTTP→SOCKS5 bridge (`src/upstreams/socks-bridge.ts`), because Bun 1.4.5's `fetch` rejects the scheme natively (`UnsupportedProxyProtocol`) — the config contract describes the URL space, not one client's capability |

Unknown keys are rejected at every level — root, `server`, `server.tls`, `auth`, per-client, per-model (including the nested `routes`, `balance` and `limits` blocks), and per-upstream — so typos fail loudly at startup.

### Example file

`config.example.json` (repo root, next to `README.md`) is the canonical example config and a copy-paste starting point: copying it to `config.json` yields a valid config. It contains every supported option — optional keys included, each upstream entry showing the optional `tlsFingerprint` as a syntactically valid placeholder pin to be replaced with the real value from `tools/tls-fingerprint.ts`, and the optional `proxy` as `null` (the direct-connection default — set an `http://host:port` URL to route that entry through a forward proxy, [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) — and one upstream entry per registered upstream `type`. The `tls` block ships `enabled: false` with placeholder `./tls/*.pem` paths (the pair `tools/generate-tls-cert.sh` writes), so the copied example still boots as plain HTTP. The `auth` block ships `enabled: false` with a syntactically valid placeholder hash — flip `enabled` to `true` with a real hash from `tools/hash-password.ts` to switch the gate on ([ADR-007](../decisions/007-management-cookie-auth.md)). The `clients` block ships one entry with a placeholder client key, and the `models` block ships two aliases demonstrating both balance strategies — a `weighted-round-robin` entry with weights on every route and a `round-robin` entry without weights — each carrying a `limits` block (both `context` and `output`) to document the optional limits keys — all referencing the sample upstreams, so the copied example validates including the cross-block references. The file is pure JSON — JSON comments and extra description keys would fail the strict validation, so field descriptions live in the schema table above.

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
- `server.maxRequestBodyBytes` not an integer in 1–67108864 (bytes) — the problem line names the bound, never the configured intent;
- `server.tls` not a JSON object, or an unknown key inside `server.tls`;
- `server.tls.enabled` missing (a `tls` block without it never validates) or not a boolean;
- `server.tls.cert` / `server.tls.key` missing while TLS is enabled, or not a non-empty string path — a problem line names the field and the rule and never echoes the configured path;
- `auth` not a JSON object, or an unknown key inside `auth`;
- `auth.enabled` missing (an `auth` block without it never validates) or not a boolean;
- `auth.user` missing, empty, or not a string while auth is enabled;
- `auth.passwordHash` missing while auth is enabled, or not a PHC-format hash (argon2id/argon2i/argon2d/2a/2b/2y prefix) — the problem line names the rule and `tools/hash-password.ts` as the generator, never the configured value;
- `clients` not an array, or an empty array while the block is present;
- a client entry that is not a JSON object, or an unknown key inside one — the valid key set is listed;
- `clients[].name` missing, empty, not a string, or duplicated across entries — duplicates are named;
- `clients[].apiKey` missing or empty — the problem line names the rule and never echoes the configured value;
- `clients[].models` empty or not an array, an entry that is not a non-empty string, a duplicate alias within one entry, or an alias matching no `models[].alias` — the unknown reference is named;
- `models` not an array, or an empty array while the block is present;
- a model entry that is not a JSON object, or an unknown key inside one — the valid key set is listed;
- `models[].alias` missing, malformed (an empty string, or containing `/` or whitespace), or duplicated across entries — duplicates are named;
- `models[].routes` empty or not an array; a route that is not a JSON object, or an unknown key inside one — the valid key set is listed;
- `models[].routes[].upstream` missing, empty, or naming an unknown `upstreams[].id`; `models[].routes[].model` missing or empty; `models[].routes[].weight` not a positive integer, missing under the `weighted-round-robin` strategy, or present under the `round-robin` strategy;
- `models[].balance` missing, not a JSON object, or carrying an unknown key; `models[].balance.strategy` missing or not one of the two registered strategies — the valid values are listed;
- `models[].limits` not a JSON object, carrying an unknown key (the valid key set is listed), empty (neither `context` nor `output`), or a `context` / `output` that is not a positive integer;
- `upstreams` empty or not an array;
- unknown upstream `type` — lists the registered types;
- `id` missing, malformed (grammar `^[a-z0-9][a-z0-9-]*$` — uppercase, `_`, or `/` rejected), or duplicated — duplicates are named;
- `baseUrl` missing or not an absolute `http(s)` URL;
- `apiKey` missing or empty;
- `tlsFingerprint` not a string (a `null` is not set — no problem), or not base64 (standard alphabet) decoding to exactly 32 bytes — the problem line names the key and the rule (naming `tools/tls-fingerprint.ts` as the generator) but never echoes the configured value.
- `proxy` not a string (other than `null`), or not an `http:` / `socks5:` URL with a non-empty host, an explicit port in 1–65535, no username/password and no path, query or fragment — the problem line names the key and the rule but never echoes the configured value (a pasted `user:pass@` URL never reaches stderr); `null`, empty and whitespace-only are valid and mean a direct connection ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)).

TLS certificate and key files are read after validation, right before the listener binds ([data-flow.md](../architecture/data-flow.md)): a missing or unreadable PEM file is a separate fatal startup error — one stderr line naming the path and the reason, exit code 1, no port bound.

### Runtime mutations

Since [ADR-014](../decisions/014-runtime-management-crud.md) the schema's grammar lives in two consumers: the startup loader (read once, problems to stderr, exit 1) and the runtime configuration store (`src/config/store.ts`), which validates every management mutation with the same grammar helpers before persisting it. The store owns exactly the three mutable collections — `upstreams`, `models`, `clients`; `server`, `logLevel` and `auth` are startup-only state the store never writes, and they survive every write-back verbatim from the raw file. The mutation sequence is synchronous `validate → persist → apply`: the candidate entry is checked against the current collections (patterns, uniqueness, cross-block references, strategy/weight consistency, limits rules), the whole config is written to a sibling temp file and atomically renamed onto the config file (file mode preserved), and only a successful write rebuilds the deep-frozen in-memory snapshot the running gateway hot-applies from — registry swap for upstreams (probe within the startup budget, outcome reported as data), routing-table rebuild for models, LLM-gate digest swap for clients. The write rules are D6/D7 of the ADR: create requires a key; an absent `apiKey` on an update keeps the stored credential; the mask literal `[Configured]` is rejected as a credential value; the null rule is point-applied to every write body (a `null` on a required or inherited key reads as omitted, a `null` on an optional field leaves the entry without it); an absent `tlsFingerprint` keeps the stored pin while an explicit `null` (or the grammar's empty / whitespace-only value) clears it — the entry never carries `tlsFingerprint: ""`; an absent `proxy` keeps the stored outbound proxy while an explicit `null` (or the grammar's empty / whitespace-only value) clears it to a direct connection — an omitted field never changes the egress topology silently, and a malformed value is a value-free problem line ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)); identity keys are immutable on update; referenced deletes are refused with problem lines naming the referencing entries; a present collection keeps at least one entry. The problem lines are value-free — they may cross into HTTP envelopes ([gateway-management.md](../contracts/gateway-management.md)), so they never echo credential material or file content.

## Extension Points

- A new upstream `type` extends the schema with its own required fields inside `src/config/schema.ts`; validation stays in one place — the startup loader and the runtime store both consume it, so a runtime-created upstream of the new type validates identically ([ADR-014](../decisions/014-runtime-management-crud.md)).
- Future: environment-variable interpolation of secrets (`apiKey`) — the file format does not change.

## Related Specs

- [Upstreams](./upstreams/README.md) — the pool built from `upstreams` entries
- [OpenAI-compatible upstream](./upstreams/openai-compatible.md) — `baseUrl` / `apiKey` semantics, how a configured `tlsFingerprint` is enforced, and how a configured `proxy` is carried (direct `fetch({ proxy })`, the `socks5://` loopback bridge, the pinned path's CONNECT tunnel)
- [Observability](./observability.md) — consumer of `logLevel`
- [Routing](./routing.md) — the model-id namespace the `models[].alias` grammar feeds into ([ADR-009](../decisions/009-alias-table-routing.md))
- [ADR-004: per-upstream TLS SPKI pinning](../decisions/004-per-upstream-tls-pinning.md) — the `tlsFingerprint` semantics this schema validates
- [ADR-017: per-upstream outbound proxy](../decisions/017-per-upstream-outbound-proxy.md) — the `proxy` grammar this schema validates (http:/socks5: URL, explicit port, no userinfo, value-free problem lines) and the Bun 1.4.5 `fetch({ proxy })` facts behind it
- [ADR-006: listener under a `server` block with explicit TLS](../decisions/006-tls-listener-server-block.md) — the hard break from top-level `listen` and the explicit `tls.enabled` switch this schema enforces
- [ADR-007: cookie-session auth for the management surface](../decisions/007-management-cookie-auth.md) — the `auth` block semantics (`enabled` switch, PHC hash, `tools/hash-password.ts`)
- [ADR-014: runtime management CRUD](../decisions/014-runtime-management-crud.md) — the runtime store: write-back semantics (atomic persist), the D6/D7 write rules, and the hot-apply the mutations feed
