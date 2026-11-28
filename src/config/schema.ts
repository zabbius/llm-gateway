/**
 * The gateway config file's schema and validation rules
 * (specs/domains/configuration.md).
 *
 * Validation and normalization live in exactly one place — here. A new
 * upstream `type` extends this module with its own required per-type fields
 * and their checks; the loading/reporting machinery in `src/config/load.ts`
 * never grows per-field knowledge.
 *
 * The schema is strict: unknown keys are rejected at every level — root,
 * `server`, `server.tls`, `auth`, per-client, per-model (including the nested
 * `routes`, `balance` and `limits` blocks), per-upstream — so typos fail
 * loudly at startup. Validation is total — every problem of one config is
 * collected and reported together, never the first one only. Cross-block
 * references
 * (`clients[].models` → `models[].alias`, `models[].routes[].upstream` →
 * `upstreams[].id`) are validated in the same pass and fail startup like any
 * other config error.
 */
import type { LogLevel } from "../types.ts";

/**
 * Registered upstream types — one per implemented upstream module
 * (specs/domains/upstreams/README.md). A new upstream module adds its type
 * string here and its validation to `validateGatewayConfig`.
 */
export const UPSTREAM_TYPES = ["openai-compatible"] as const;

export type UpstreamType = (typeof UPSTREAM_TYPES)[number];

/**
 * Upstream id grammar: lowercase letters, digits and hyphens, starting with a
 * letter or digit. The grammar excludes "/" (an id names URL path segments on
 * the management surface — `/api/upstreams/:id/…`), "_" and uppercase, keeping
 * ids conservative and log-safe.
 */
export const UPSTREAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Model alias grammar: any non-empty string without whitespace and without
 * "/" — an alias is the client-facing model id, and "/" is reserved so the
 * id stays a single URL path segment (ADR-009).
 */
export const MODEL_ALIAS_PATTERN = /^[^\s/]+$/;

/** The gateway log-level vocabulary (also `LogLevel` in src/types.ts). */
export const LOG_LEVELS = ["trace", "debug", "info", "warning", "error", "none"] as const;

/**
 * Load-balancing strategies a `models` entry's `balance` block may select
 * between. `"round-robin"` rotates routes in config order and rejects route
 * weights; `"weighted-round-robin"` requires a positive integer `weight` on
 * every route and repeats routes proportionally to their weight.
 */
export const BALANCE_STRATEGIES = ["round-robin", "weighted-round-robin"] as const;

export type BalanceStrategy = (typeof BALANCE_STRATEGIES)[number];

export const DEFAULT_LISTEN = "127.0.0.1:8080";
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * The request-body cap when the config carries no `server.maxRequestBodyBytes`
 * (4 MiB): generous for LLM payloads, bounded for the process. Enforced by the
 * body reader (src/httpapi/body.ts) — an over-limit body is answered 413
 * before `JSON.parse` ever sees it (specs/contracts/client-gateway.md).
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The inclusive upper bound the schema accepts for `server.maxRequestBodyBytes`
 * (the former hard-coded 64 MiB cap): a config above it fails startup instead
 * of silently reopening the per-request buffering surface.
 */
export const MAX_REQUEST_BODY_BYTES_LIMIT = 64 * 1024 * 1024;

/** One provider connection entry of the `upstreams` array. */
export interface UpstreamConfig {
  type: UpstreamType;
  /** ^[a-z0-9][a-z0-9-]*$ — unique across the config; never contains "/" */
  id: string;
  /** absolute http(s) URL including the API root with /v1 (e.g. https://api.openai.com/v1) */
  baseUrl: string;
  /** non-empty; sent upstream as the Bearer credential only */
  apiKey: string;
  /**
 * Optional TLS SPKI pin: base64 (standard alphabet) of the SHA-256 digest
 * of the upstream certificate's SubjectPublicKeyInfo DER — exactly 32 bytes
 * decoded. Absent, `null`, empty or whitespace-only → the system CA pool
 * verifies the upstream certificate (the null rule and the empty-string
 * normalization leave the entry without the key, never with `null` or
 * `""`); otherwise → ONLY the pinned key is accepted (ADR-004). Inert on a
 * plain-http baseUrl. Compute with `tools/tls-fingerprint.ts`.
 */
  tlsFingerprint?: string;
  /**
   * Optional outbound proxy this upstream's requests go through (ADR-017):
   * an `http:` or `socks5:` URL with a non-empty host, an explicit port in
   * 1..65535, no username/password (proxy credentials never enter the
   * config) and no path (beyond `/`), query or fragment. Absent, `null`,
   * empty or whitespace-only → a direct connection (normalized to
   * `undefined`); otherwise stored trimmed. The value is never echoed into
   * a problem line — a pasted `user:pass@host` URL must not reach stderr.
   */
  proxy?: string;
}

/** TLS options of the gateway's own listener (`server.tls` in the config file). */
export interface TlsConfig {
  /**
   * Required whenever the `tls` block is present: TLS is either explicitly
   * on or explicitly off — the block without `enabled` never validates.
   */
  enabled: boolean;
  /** PEM certificate-chain path; required when `enabled` is true */
  cert?: string;
  /** PEM private-key path; required when `enabled` is true */
  key?: string;
}

/**
 * Management-surface auth options (`auth` in the config file, ADR-007):
 * a single config-backed operator identity. The block mirrors the `tls`
 * precedent — `enabled` is required whenever the block is present; the
 * credential fields are required only while `enabled` is true but may stay
 * configured (staged) while `enabled` is false. An absent block means no
 * auth gate: the gateway behaves exactly as before ADR-007.
 */
export interface AuthConfig {
  /**
   * Required whenever the `auth` block is present: the auth gate is either
   * explicitly on or explicitly off — the block without `enabled` never
   * validates.
   */
  enabled: boolean;
  /** operator login; required (non-empty string) when `enabled` is true */
  user?: string;
  /**
   * argon2id PHC hash of the operator password, generated with
   * `tools/hash-password.ts`; required when `enabled` is true. Verified with
   * `Bun.password.verify` — the plain password never enters the config.
   */
  passwordHash?: string;
}

/** The gateway listener block (`server` in the config file). */
export interface ServerConfig {
  /** "host:port"; omitted → "127.0.0.1:8080" (loopback until gateway-auth lands) */
  listen?: string;
  /**
   * The request-body cap in bytes — an integer in 1..MAX_REQUEST_BODY_BYTES_LIMIT:
   * every parsed JSON body (completions dispatch and `POST /api/login` alike)
   * is read under it, and an over-limit body is answered 413 before parse.
   * Omitted → DEFAULT_MAX_REQUEST_BODY_BYTES (4 MiB).
   */
  maxRequestBodyBytes?: number;
  /** omitted → the listener serves plain HTTP */
  tls?: TlsConfig;
}

/** One client credential entry of the `clients` array. */
export interface ClientConfig {
  /** non-empty; unique across the config; names the entry in the management view and in problem lines */
  name: string;
  /** non-empty; the credential the gateway expects from this client; never logged, masked in the management view */
  apiKey: string;
  /** at least one model alias this client may address; every entry must reference an existing `models[].alias` */
  models: string[];
}

/** One concrete upstream target inside a `models` entry's `routes` array. */
export interface ModelRouteConfig {
  /** non-empty; must reference an existing `upstreams[].id` (validated at startup) */
  upstream: string;
  /** non-empty; the provider-native model name sent upstream in `body.model` */
  model: string;
  /**
   * Positive integer weight: required on every route when the entry's balance
   * strategy is "weighted-round-robin", rejected when it is "round-robin".
   */
  weight?: number;
}

/** Load-balancing options of a `models` entry (`balance` in the config file). */
export interface ModelBalanceConfig {
  /**
   * Required whenever the block is present: the strategy is stated explicitly
   * — the block without `strategy` never validates.
   */
  strategy: BalanceStrategy;
}

/**
 * Optional token-budget limits of a `models` entry (`limits` in the config
 * file). Both keys are optional, but a present block always carries at least
 * one — an empty `limits` block is a config error, never silently ignored.
 * The values are recorded with the entry and surfaced by the management view
 * verbatim (not secret); the config layer only validates and freezes them.
 */
export interface ModelLimitsConfig {
  /** positive integer: the model's context window in tokens */
  context?: number;
  /** positive integer: the model's maximum output in tokens */
  output?: number;
}

/** One aliased, balanced model entry of the `models` array. */
export interface ModelConfig {
  /** client-facing model id; matches MODEL_ALIAS_PATTERN (no "/", no whitespace); unique across the array */
  alias: string;
  /** at least one route; duplicate `upstream`/`model` pairs within one entry are rejected */
  routes: ModelRouteConfig[];
  /** required: how the gateway rotates the routes when this alias is addressed */
  balance: ModelBalanceConfig;
  /** optional limits block; a present block always carries at least one of `context`/`output` */
  limits?: ModelLimitsConfig;
}

/** The config file shape as parsed from JSON. */
export interface GatewayConfig {
  /** listener options; an omitted `server` block means every default */
  server?: ServerConfig;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** omitted → the management surface is ungated (ADR-007) */
  auth?: AuthConfig;
  /** omitted → no client credentials are configured; present → at least one entry, names unique */
  clients?: ClientConfig[];
  /** omitted → no model aliases are configured; present → at least one entry, aliases unique */
  models?: ModelConfig[];
  /** at least one entry; ids unique across the array */
  upstreams: UpstreamConfig[];
}

/** The `server` block after normalization: `listen` and the body cap are always set. */
export interface NormalizedServerConfig extends ServerConfig {
  listen: string;
  maxRequestBodyBytes: number;
}

/** A validated config with every optional field defaulted and baseUrl normalized; the `clients`/`models` blocks are copied entry by entry when present. */
export interface NormalizedGatewayConfig extends GatewayConfig {
  server: NormalizedServerConfig;
  logLevel: LogLevel;
  upstreams: UpstreamConfig[];
}

export type ValidatedConfig =
  | { ok: true; config: NormalizedGatewayConfig }
  | { ok: false; problems: string[] };

/**
 * `listen` grammar: `host:port` — a hostname label/IPv4 address (no colons,
 * no whitespace) or a bracketed IPv6 literal, plus a decimal port. The port
 * range is checked numerically by `isListen`.
 */
const LISTEN_PATTERN =
  /^(\[[0-9A-Fa-f:.]+\]|[0-9A-Za-z]([0-9A-Za-z-]*[0-9A-Za-z])?(\.[0-9A-Za-z]([0-9A-Za-z-]*[0-9A-Za-z])?)*):(?<port>[0-9]{1,5})$/;

/**
 * The exact key sets accepted at each level. Exported for
 * `src/config/example.test.ts`, which keeps `config.example.json` in sync
 * with the schema (specs/domains/configuration.md "Example file"): when a
 * key is added or removed here, the example must follow in the same change.
 */
export const TOP_LEVEL_KEYS: readonly string[] = ["server", "logLevel", "auth", "clients", "models", "upstreams"];
export const SERVER_KEYS: readonly string[] = ["listen", "maxRequestBodyBytes", "tls"];
export const TLS_KEYS: readonly string[] = ["enabled", "cert", "key"];
export const AUTH_KEYS: readonly string[] = ["enabled", "user", "passwordHash"];
export const CLIENT_KEYS: readonly string[] = ["name", "apiKey", "models"];
export const MODEL_KEYS: readonly string[] = ["alias", "routes", "balance", "limits"];
export const MODEL_ROUTE_KEYS: readonly string[] = ["upstream", "model", "weight"];
export const BALANCE_KEYS: readonly string[] = ["strategy"];
export const LIMITS_KEYS: readonly string[] = ["context", "output"];
export const UPSTREAM_KEYS: readonly string[] = ["type", "id", "baseUrl", "apiKey", "tlsFingerprint", "proxy"];

/**
 * A PHC-format password hash prefix (ADR-007): `$argon2id$…` / `$argon2i$…` /
 * `$argon2d$…` (Bun's default) or `$2a$…` / `$2b$…` / `$2y$…` (bcrypt). The
 * startup check is prefix-level only — the deep check happens at the first
 * verify; the tools/hash-password.ts generator always produces a matching
 * string.
 */
const PASSWORD_HASH_PATTERN = /^\$(?:argon2(?:id|i|d)|2[aby])\$/;

/**
 * True when `value` looks like a PHC-format password hash the runtime can
 * verify (`Bun.password.verify` auto-detects the format). A syntactically
 * wrong hash fails config validation — typos fail loudly at startup, never
 * at the first login attempt (specs/domains/configuration.md).
 */
export function isValidPasswordHash(value: string): boolean {
  return value.length > 0 && PASSWORD_HASH_PATTERN.test(value);
}

/**
 * A TLS fingerprint pin: base64 (standard alphabet, optional padding) whose
 * decoding is exactly 32 bytes — the SHA-256 digest of the upstream
 * certificate's SPKI DER (ADR-004). Comparison is whitespace-tolerant: the
 * normalized form strips every whitespace character before validation.
 */
const TLS_FINGERPRINT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Normalize an upstream `tlsFingerprint` value: absent, `null`, empty or
 * whitespace-only → `undefined` (no pin — the grammar's own "no pin", never
 * an empty string on the entry); a string → stripped of every whitespace
 * character (a pin pasted with line wraps still matches). Exported so
 * `src/config/store.ts` applies the same normalization to its runtime
 * writes as the startup loader does.
 */
export function normalizeTlsFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const pin = value.replace(/\s+/g, "");
  return pin.length > 0 ? pin : undefined;
}

/**
 * True when `value` is an acceptable `tlsFingerprint` input: the empty or
 * whitespace-only string (no pin), or a base64 (standard alphabet) string
 * decoding to exactly 32 bytes. A syntactically wrong pin fails config
 * validation — typos fail loudly at startup, never at the first request
 * (specs/domains/configuration.md).
 */
export function isValidTlsFingerprint(value: string): boolean {
  const normalized = normalizeTlsFingerprint(value);
  if (normalized === undefined) return true;
  if (!TLS_FINGERPRINT_PATTERN.test(normalized)) return false;
  return Buffer.from(normalized, "base64").length === 32;
}

/** True when `value` is one of the six config log levels. */
export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** True when `value` is a usable model alias: non-empty, no "/", no whitespace. */
export function isValidModelAlias(value: string): boolean {
  return value.length > 0 && MODEL_ALIAS_PATTERN.test(value);
}

/** True when `value` is a positive integer (route weights, limits values). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** True when `value` is a positive integer route weight (weighted round-robin). */
export function isPositiveWeight(value: unknown): value is number {
  return isPositiveInteger(value);
}

/** True when `value` is a `"host:port"` string with a port in 1–65535. */
export function isListen(value: string): boolean {
  const match = LISTEN_PATTERN.exec(value);
  if (!match) return false;
  const port = Number(match.groups?.port ?? Number.NaN);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * True when `value` is a usable request-body cap: an integer in
 * 1..MAX_REQUEST_BODY_BYTES_LIMIT (bytes). A syntactically wrong cap fails
 * config validation — typos fail loudly at startup, never at the first
 * oversized request (specs/domains/configuration.md).
 */
export function isValidMaxRequestBodyBytes(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REQUEST_BODY_BYTES_LIMIT
  );
}

/** True when `value` parses as an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Strip a single trailing slash from a baseUrl (a spec-level normalization:
 * upstream URLs are built as `baseUrl + "/" + path`, and one trailing slash
 * would produce a double slash). `"…/v1/"` → `"…/v1"`; `"…/v1//"` → `"…/v1/"`.
 */
export function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** The proxy schemes an upstream `proxy` may name (ADR-017). */
export const PROXY_SCHEMES = ["http:", "socks5:"] as const;

/**
 * Normalize an upstream `proxy` value: absent, `null`, empty or
 * whitespace-only → `undefined` (a direct connection); a string → trimmed.
 * Exported so `src/config/store.ts` can apply the same normalization to its
 * runtime writes as the startup loader does.
 */
export function normalizeProxy(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The port written in a proxy URL's authority, or `undefined` when none was.
 * Read from the string rather than `URL.port`: the parser drops a port that
 * equals the scheme's default (`http://proxy:80` → `port === ""`), and the
 * grammar requires the port to be stated explicitly.
 */
function explicitPort(value: string): string | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) return undefined;
  const authority = value.slice(schemeEnd + 3).split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return /^(.*):([0-9]+)$/.exec(hostPort)?.[2];
}

/**
 * True when `value` is a usable outbound proxy URL (ADR-017): it parses with
 * `new URL`, its scheme is `http:` or `socks5:`, its host is non-empty, it
 * carries an explicit port in 1..65535, and it carries no username/password,
 * no path (beyond `/`), no query and no fragment. A syntactically wrong
 * proxy fails config validation — typos fail loudly at startup, never at
 * the first request.
 */
export function isValidProxyUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!(PROXY_SCHEMES as readonly string[]).includes(url.protocol)) return false;
  if (url.hostname === "") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  if (url.search !== "" || url.hash !== "") return false;
  const port = Number(explicitPort(value));
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Copy a normalized `proxy` into an upstream entry — only when one is
 * configured; an absent/null/empty value yields no key at all.
 */
function normalizedProxy(value: unknown): { proxy: string } | {} {
  const trimmed = normalizeProxy(value);
  return trimmed !== undefined ? { proxy: trimmed } : {};
}

/**
 * Copy a normalized `tlsFingerprint` into an upstream entry — only when a
 * pin is configured; an absent value or an empty / whitespace-only string
 * (the grammar's own "no pin") yields no key at all.
 */
function normalizedTlsFingerprint(value: unknown): { tlsFingerprint: string } | {} {
  const pin = normalizeTlsFingerprint(value);
  return pin !== undefined ? { tlsFingerprint: pin } : {};
}

/**
 * Validate and normalize a parsed config value. Collects every problem —
 * unknown keys, grammar violations, missing keys, duplicate ids/aliases,
 * broken cross-block references — into one `problems` list in a stable order
 * (top level first, then the `server` block, then the `auth` block, then
 * client entries, model entries (with their nested `routes`, `balance` and
 * `limits` blocks) by index, then upstream entries by index, then the
 * cross-block reference problems); returns the normalized config only when
 * the list stays empty. A key written as JSON `null` is not set at any level
 * (`withoutNulls`): an optional key takes its default, a required key is
 * reported missing — while the strict-key pass runs over the raw object, so
 * an unknown key is reported even when its value is `null`. The returned
 * config is deep-frozen: the validated shape is immutable for the process
 * lifetime — the config is read exactly once per start and never reloaded.
 */
export function validateGatewayConfig(value: unknown): ValidatedConfig {
  const problems: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, problems: ["config root must be a JSON object"] };
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      problems.push(`unknown top-level key "${key}" (valid keys: ${TOP_LEVEL_KEYS.join(", ")})`);
    }
  }

  // Every field read below works on the null-stripped root — a `null` key
  // is as if it had never been written (the docstring's rule).
  const root = withoutNulls(value);

  const rawServer = root.server;
  if (rawServer !== undefined && !isPlainObject(rawServer)) {
    problems.push("server must be a JSON object");
  }

  if (isPlainObject(rawServer)) {
    for (const key of Object.keys(rawServer)) {
      if (!SERVER_KEYS.includes(key)) {
        problems.push(`server: unknown key "${key}" (valid keys: ${SERVER_KEYS.join(", ")})`);
      }
    }

    const server = withoutNulls(rawServer);

    const listen = server.listen;
    if (listen !== undefined && (typeof listen !== "string" || !isListen(listen))) {
      problems.push(`server.listen must be a "host:port" string with a port in 1-65535 (got ${shown(listen)})`);
    }

    const maxRequestBodyBytes = server.maxRequestBodyBytes;
    if (maxRequestBodyBytes !== undefined && !isValidMaxRequestBodyBytes(maxRequestBodyBytes)) {
      problems.push(
        `server.maxRequestBodyBytes must be an integer between 1 and ${MAX_REQUEST_BODY_BYTES_LIMIT} (bytes) (got ${shown(maxRequestBodyBytes)})`,
      );
    }

    const rawTls = server.tls;
    if (isPlainObject(rawTls)) {
      for (const key of Object.keys(rawTls)) {
        if (!TLS_KEYS.includes(key)) {
          problems.push(`server.tls: unknown key "${key}" (valid keys: ${TLS_KEYS.join(", ")})`);
        }
      }

      const tls = withoutNulls(rawTls);

      const enabled = tls.enabled;
      if (enabled === undefined) {
        problems.push('server.tls: missing required key "enabled"');
      } else if (typeof enabled !== "boolean") {
        problems.push(`server.tls: enabled must be a boolean (got ${shown(enabled)})`);
      }

      // cert/key are PEM file paths, not file contents — a problem line names
      // the key and the rule and never echoes the configured path value.
      for (const field of ["cert", "key"] as const) {
        const given = tls[field];
        if (given === undefined) {
          if (enabled === true) {
            problems.push(`server.tls: ${field} is required when tls is enabled`);
          }
        } else if (typeof given !== "string" || given.length === 0) {
          problems.push(`server.tls: ${field} must be a non-empty string path`);
        }
      }
    } else if (rawTls !== undefined) {
      problems.push("server.tls must be a JSON object");
    }
  }

  const rawAuth = root.auth;
  if (rawAuth !== undefined && !isPlainObject(rawAuth)) {
    problems.push("auth must be a JSON object");
  }

  if (isPlainObject(rawAuth)) {
    for (const key of Object.keys(rawAuth)) {
      if (!AUTH_KEYS.includes(key)) {
        problems.push(`auth: unknown key "${key}" (valid keys: ${AUTH_KEYS.join(", ")})`);
      }
    }

    const auth = withoutNulls(rawAuth);

    const enabled = auth.enabled;
    if (enabled === undefined) {
      problems.push('auth: missing required key "enabled"');
    } else if (typeof enabled !== "boolean") {
      problems.push(`auth: enabled must be a boolean (got ${shown(enabled)})`);
    }

    // user/passwordHash are required only while auth is enabled — a staged
    // block (enabled: false) may carry them for later. The passwordHash value
    // is never echoed into a problem line — it must never reach stderr or any
    // log (specs/architecture/security-model.md, ADR-007).
    const user = auth.user;
    if (enabled === true && (user === undefined || typeof user !== "string" || user.length === 0)) {
      problems.push("auth: user must be a non-empty string when auth is enabled");
    }

    const passwordHash = auth.passwordHash;
    if (enabled === true) {
      if (passwordHash === undefined) {
        problems.push("auth: passwordHash is required when auth is enabled");
      } else if (typeof passwordHash !== "string" || !isValidPasswordHash(passwordHash)) {
        problems.push(
          "auth: passwordHash must be a PHC-format hash (argon2id/bcrypt) — generate it with tools/hash-password.ts",
        );
      }
    } else if (passwordHash !== undefined && (typeof passwordHash !== "string" || !isValidPasswordHash(passwordHash))) {
      problems.push(
        "auth: passwordHash must be a PHC-format hash (argon2id/bcrypt) — generate it with tools/hash-password.ts",
      );
    }
  }

  const logLevel = root.logLevel;
  if (logLevel !== undefined && !isValidLogLevel(logLevel)) {
    problems.push(`logLevel must be one of: ${LOG_LEVELS.join(", ")} (got ${shown(logLevel)})`);
  }

  const clients = root.clients;
  if (clients !== undefined && !Array.isArray(clients)) {
    problems.push("clients must be an array of client entries");
  }

  const seenClientNames = new Map<string, number[]>();

  if (Array.isArray(clients)) {
    if (clients.length === 0) {
      problems.push("clients must be an array with at least one client entry");
    }

    clients.forEach((rawEntry, index) => {
      if (!isPlainObject(rawEntry)) {
        problems.push(`clients[${index}] must be a JSON object`);
        return;
      }

      for (const key of Object.keys(rawEntry)) {
        if (!CLIENT_KEYS.includes(key)) {
          problems.push(`clients[${index}]: unknown key "${key}" (valid keys: ${CLIENT_KEYS.join(", ")})`);
        }
      }

      const entry = withoutNulls(rawEntry);

      const name = entry.name;
      if (name === undefined) {
        problems.push(`clients[${index}]: missing required key "name"`);
      } else if (typeof name !== "string" || name.length === 0) {
        problems.push(`clients[${index}]: name must be a non-empty string`);
      } else {
        const indexes = seenClientNames.get(name);
        if (indexes === undefined) {
          seenClientNames.set(name, [index]);
        } else {
          indexes.push(index);
        }
      }

      // The client apiKey value is never echoed into a problem line — it must
      // never reach stderr or any log, exactly like an upstream apiKey
      // (specs/architecture/security-model.md).
      const clientKey = entry.apiKey;
      if (clientKey === undefined) {
        problems.push(`clients[${index}]: missing required key "apiKey"`);
      } else if (typeof clientKey !== "string" || clientKey.length === 0) {
        problems.push(`clients[${index}]: apiKey must be a non-empty string`);
      }

      const clientModels = entry.models;
      if (!Array.isArray(clientModels) || clientModels.length === 0) {
        problems.push(`clients[${index}]: models must be an array with at least one model alias`);
      } else {
        const seenRefs = new Set<string>();
        clientModels.forEach((ref, refIndex) => {
          if (typeof ref !== "string" || ref.length === 0) {
            problems.push(`clients[${index}]: models[${refIndex}] must be a non-empty string naming a models[].alias`);
          } else if (seenRefs.has(ref)) {
            problems.push(`clients[${index}]: duplicate model alias "${ref}" in the models array`);
          } else {
            seenRefs.add(ref);
          }
        });
      }
    });

    for (const [name, indexes] of seenClientNames) {
      if (indexes.length > 1) {
        problems.push(`duplicate client name "${name}" (entries ${indexes.join(", ")})`);
      }
    }
  }

  const models = root.models;
  if (models !== undefined && !Array.isArray(models)) {
    problems.push("models must be an array of model entries");
  }

  const seenAliases = new Map<string, number[]>();

  if (Array.isArray(models)) {
    if (models.length === 0) {
      problems.push("models must be an array with at least one model entry");
    }

    models.forEach((rawEntry, index) => {
      if (!isPlainObject(rawEntry)) {
        problems.push(`models[${index}] must be a JSON object`);
        return;
      }

      for (const key of Object.keys(rawEntry)) {
        if (!MODEL_KEYS.includes(key)) {
          problems.push(`models[${index}]: unknown key "${key}" (valid keys: ${MODEL_KEYS.join(", ")})`);
        }
      }

      const entry = withoutNulls(rawEntry);

      const alias = entry.alias;
      if (alias === undefined) {
        problems.push(`models[${index}]: missing required key "alias"`);
      } else if (typeof alias !== "string" || !isValidModelAlias(alias)) {
        problems.push(
          `models[${index}]: model alias ${shown(alias)} must be a non-empty string without "/" or whitespace ("/" is the upstream-prefix separator)`,
        );
      } else {
        const indexes = seenAliases.get(alias);
        if (indexes === undefined) {
          seenAliases.set(alias, [index]);
        } else {
          indexes.push(index);
        }
      }

      const routes = entry.routes;
      if (!Array.isArray(routes) || routes.length === 0) {
        problems.push(`models[${index}]: routes must be an array with at least one route entry`);
      } else {
        const seenPairs = new Set<string>();
        routes.forEach((rawRoute, routeIndex) => {
          if (!isPlainObject(rawRoute)) {
            problems.push(`models[${index}]: routes[${routeIndex}] must be a JSON object`);
            return;
          }

          for (const key of Object.keys(rawRoute)) {
            if (!MODEL_ROUTE_KEYS.includes(key)) {
              problems.push(
                `models[${index}]: routes[${routeIndex}]: unknown key "${key}" (valid keys: ${MODEL_ROUTE_KEYS.join(", ")})`,
              );
            }
          }

          const route = withoutNulls(rawRoute);

          const routeUpstream = route.upstream;
          if (routeUpstream === undefined) {
            problems.push(`models[${index}]: routes[${routeIndex}]: missing required key "upstream"`);
          } else if (typeof routeUpstream !== "string" || routeUpstream.length === 0) {
            problems.push(
              `models[${index}]: routes[${routeIndex}]: upstream must be a non-empty string naming an upstreams[].id`,
            );
          }

          const routeModel = route.model;
          if (routeModel === undefined) {
            problems.push(`models[${index}]: routes[${routeIndex}]: missing required key "model"`);
          } else if (typeof routeModel !== "string" || routeModel.length === 0) {
            problems.push(
              `models[${index}]: routes[${routeIndex}]: model must be a non-empty string (the provider-native model name)`,
            );
          }

          const weight = route.weight;
          if (weight !== undefined && !isPositiveWeight(weight)) {
            problems.push(`models[${index}]: routes[${routeIndex}]: weight must be a positive integer`);
          }

          if (
            typeof routeUpstream === "string" &&
            routeUpstream.length > 0 &&
            typeof routeModel === "string" &&
            routeModel.length > 0
          ) {
            const pair = `${routeUpstream}/${routeModel}`;
            if (seenPairs.has(pair)) {
              problems.push(`models[${index}]: duplicate route "${pair}" in the routes array`);
            } else {
              seenPairs.add(pair);
            }
          }
        });
      }

      const rawBalance = entry.balance;
      if (rawBalance === undefined) {
        problems.push(`models[${index}]: missing required key "balance"`);
      } else if (!isPlainObject(rawBalance)) {
        problems.push(`models[${index}]: balance must be a JSON object`);
      } else {
        for (const key of Object.keys(rawBalance)) {
          if (!BALANCE_KEYS.includes(key)) {
            problems.push(`models[${index}]: balance: unknown key "${key}" (valid keys: ${BALANCE_KEYS.join(", ")})`);
          }
        }

        const balance = withoutNulls(rawBalance);

        const strategy = balance.strategy;
        if (strategy === undefined) {
          problems.push(`models[${index}]: balance: missing required key "strategy"`);
        } else if (!(BALANCE_STRATEGIES as readonly unknown[]).includes(strategy)) {
          problems.push(
            `models[${index}]: balance: strategy must be one of: ${BALANCE_STRATEGIES.join(", ")} (got ${shown(strategy)})`,
          );
        } else if (Array.isArray(routes)) {
          // Strategy/route-weight consistency: a weighted strategy needs a
          // weight on every route; plain round-robin ignores weights, so a
          // configured weight is a config error, never silently ignored.
          const weighted = strategy === "weighted-round-robin";
          routes.forEach((rawRoute, routeIndex) => {
            // the null-stripped view: a `null` weight is an unweighted route
            const route = isPlainObject(rawRoute) ? withoutNulls(rawRoute) : rawRoute;
            if (!isPlainObject(route)) return;
            if (weighted && route.weight === undefined) {
              problems.push(
                `models[${index}]: routes[${routeIndex}]: weight is required when the balance strategy is "weighted-round-robin"`,
              );
            } else if (!weighted && route.weight !== undefined) {
              problems.push(
                `models[${index}]: routes[${routeIndex}]: weight is only valid when the balance strategy is "weighted-round-robin" (strategy is "round-robin")`,
              );
            }
          });
        }
      }

      const rawLimits = entry.limits;
      if (rawLimits !== undefined) {
        if (!isPlainObject(rawLimits)) {
          problems.push(`models[${index}]: limits must be a JSON object`);
        } else {
          for (const key of Object.keys(rawLimits)) {
            if (!LIMITS_KEYS.includes(key)) {
              problems.push(`models[${index}]: limits: unknown key "${key}" (valid keys: ${LIMITS_KEYS.join(", ")})`);
            }
          }

          const limits = withoutNulls(rawLimits);

          if (Object.keys(limits).length === 0) {
            problems.push(`models[${index}]: limits must carry at least one of "context", "output"`);
          }

          const context = limits.context;
          if (context !== undefined && !isPositiveInteger(context)) {
            problems.push(`models[${index}]: limits: context must be a positive integer`);
          }

          const output = limits.output;
          if (output !== undefined && !isPositiveInteger(output)) {
            problems.push(`models[${index}]: limits: output must be a positive integer`);
          }
        }
      }
    });

    for (const [alias, indexes] of seenAliases) {
      if (indexes.length > 1) {
        problems.push(`duplicate model alias "${alias}" (entries ${indexes.join(", ")})`);
      }
    }
  }

  // Cross-block reference, clients → models: every alias a client lists must
  // be defined in the models block. Checked only against aliases that
  // validated (a broken models block already fails the config on its own).
  if (Array.isArray(clients) && Array.isArray(models)) {
    const aliases = new Set(seenAliases.keys());
    clients.forEach((entry, index) => {
      if (!isPlainObject(entry) || !Array.isArray(entry.models)) return;
      entry.models.forEach((ref, refIndex) => {
        if (typeof ref === "string" && ref.length > 0 && !aliases.has(ref)) {
          problems.push(`clients[${index}]: models[${refIndex}]: unknown model alias "${ref}" — no models[] entry defines it`);
        }
      });
    });
  }

  const upstreams = root.upstreams;
  if (!Array.isArray(upstreams) || upstreams.length === 0) {
    problems.push("upstreams must be an array with at least one upstream entry");
    return { ok: false, problems };
  }

  const seenIds = new Map<string, number[]>();

  upstreams.forEach((rawEntry, index) => {
    if (!isPlainObject(rawEntry)) {
      problems.push(`upstreams[${index}] must be a JSON object`);
      return;
    }

    for (const key of Object.keys(rawEntry)) {
      if (!UPSTREAM_KEYS.includes(key)) {
        problems.push(`upstreams[${index}]: unknown key "${key}" (valid keys: ${UPSTREAM_KEYS.join(", ")})`);
      }
    }

    const entry = withoutNulls(rawEntry);

    const type = entry.type;
    if (type === undefined) {
      problems.push(
        `upstreams[${index}]: missing required key "type" (registered upstream types: ${UPSTREAM_TYPES.join(", ")})`,
      );
    } else if (!(UPSTREAM_TYPES as readonly unknown[]).includes(type)) {
      problems.push(
        `upstreams[${index}]: unknown upstream type ${shown(type)} (registered upstream types: ${UPSTREAM_TYPES.join(", ")})`,
      );
    }

    const id = entry.id;
    if (id === undefined) {
      problems.push(`upstreams[${index}]: missing required key "id"`);
    } else if (typeof id !== "string" || !UPSTREAM_ID_PATTERN.test(id)) {
      problems.push(
        `upstreams[${index}]: upstream id ${shown(id)} must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, hyphens; never "/")`,
      );
    } else {
      const indexes = seenIds.get(id);
      if (indexes === undefined) {
        seenIds.set(id, [index]);
      } else {
        indexes.push(index);
      }
    }

    const baseUrl = entry.baseUrl;
    if (baseUrl === undefined) {
      problems.push(`upstreams[${index}]: missing required key "baseUrl"`);
    } else if (typeof baseUrl !== "string" || !isHttpUrl(baseUrl)) {
      problems.push(
        `upstreams[${index}]: baseUrl ${shown(baseUrl)} must be an absolute http(s) URL including the API root with "/v1"`,
      );
    }

    // The apiKey value is never echoed into a problem line — it must never
    // reach stderr or any log (specs/architecture/security-model.md).
    const apiKey = entry.apiKey;
    if (apiKey === undefined) {
      problems.push(`upstreams[${index}]: missing required key "apiKey"`);
    } else if (typeof apiKey !== "string" || apiKey.length === 0) {
      problems.push(`upstreams[${index}]: apiKey must be a non-empty string`);
    }

    // The problem line names the key and the rule but never echoes the
    // configured value — validation output stays free of pin material the
    // same way it stays free of apiKey. An absent, `null`, empty or
    // whitespace-only value means no pin (the null rule and the empty-string
    // normalization below — the entry never carries `""` or `null`); a pin
    // on a plain-http baseUrl stays valid but is inert (ADR-004).
    const tlsFingerprint = entry.tlsFingerprint;
    if (tlsFingerprint !== undefined) {
      if (typeof tlsFingerprint !== "string") {
        problems.push(
          `upstreams[${index}]: tlsFingerprint must be a string — base64 of the SHA-256 SPKI digest (32 bytes)`,
        );
      } else if (!isValidTlsFingerprint(tlsFingerprint)) {
        problems.push(
          `upstreams[${index}]: tlsFingerprint must be base64 (standard alphabet) decoding to exactly 32 bytes — compute it with tools/tls-fingerprint.ts`,
        );
      }
    }

    // The proxy value is never echoed into a problem line — a pasted
    // `user:pass@host` URL carries credentials that must not reach stderr or
    // any log (specs/architecture/security-model.md, ADR-017). Absent, null,
    // empty or whitespace-only means a direct connection.
    const proxy = entry.proxy;
    if (proxy !== undefined) {
      if (typeof proxy !== "string") {
        problems.push(
          `upstreams[${index}]: proxy must be a string — an http: or socks5: URL with an explicit port, or null for a direct connection`,
        );
      } else {
        const trimmed = normalizeProxy(proxy);
        if (trimmed !== undefined && !isValidProxyUrl(trimmed)) {
          problems.push(
            `upstreams[${index}]: proxy must be an http: or socks5: URL with a non-empty host, an explicit port in 1-65535, no username/password, and no path, query or fragment`,
          );
        }
      }
    }
  });

  for (const [id, indexes] of seenIds) {
    if (indexes.length > 1) {
      problems.push(`duplicate upstream id "${id}" (entries ${indexes.join(", ")})`);
    }
  }

  // Cross-block reference, models → upstreams: every route must name a
  // registered upstream id. Checked only when the upstreams array parsed —
  // otherwise the config already fails on the upstreams problems.
  if (Array.isArray(models)) {
    const upstreamIds = new Set(seenIds.keys());
    models.forEach((entry, index) => {
      if (!isPlainObject(entry) || !Array.isArray(entry.routes)) return;
      entry.routes.forEach((route, routeIndex) => {
        if (!isPlainObject(route)) return;
        const routeUpstream = route.upstream;
        if (typeof routeUpstream === "string" && routeUpstream.length > 0 && !upstreamIds.has(routeUpstream)) {
          problems.push(
            `models[${index}]: routes[${routeIndex}]: unknown upstream "${routeUpstream}" — no upstreams[] entry declares this id`,
          );
        }
      });
    });
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  // The null-stripped views of the two optional blocks — their raw forms
  // served only the strict-key passes above.
  const server = isPlainObject(rawServer) ? withoutNulls(rawServer) : undefined;
  const serverBlock: NormalizedServerConfig = {
    listen: server !== undefined && typeof server.listen === "string" ? server.listen : DEFAULT_LISTEN,
    maxRequestBodyBytes:
      server !== undefined && isValidMaxRequestBodyBytes(server.maxRequestBodyBytes)
        ? server.maxRequestBodyBytes
        : DEFAULT_MAX_REQUEST_BODY_BYTES,
  };
  if (server !== undefined && isPlainObject(server.tls)) {
    serverBlock.tls = {
      enabled: server.tls.enabled as boolean,
      ...(typeof server.tls.cert === "string" ? { cert: server.tls.cert } : {}),
      ...(typeof server.tls.key === "string" ? { key: server.tls.key } : {}),
    };
  }

  const auth = isPlainObject(rawAuth) ? withoutNulls(rawAuth) : undefined;
  const authBlock: AuthConfig | undefined =
    auth !== undefined
      ? {
          enabled: auth.enabled as boolean,
          ...(typeof auth.user === "string" ? { user: auth.user } : {}),
          ...(typeof auth.passwordHash === "string" ? { passwordHash: auth.passwordHash } : {}),
        }
      : undefined;

  const clientsBlock: ClientConfig[] | undefined = Array.isArray(clients)
    ? (clients as Record<string, unknown>[]).map((entry) => ({
        name: entry.name as string,
        apiKey: entry.apiKey as string,
        models: [...(entry.models as string[])],
      }))
    : undefined;

  const modelsBlock: ModelConfig[] | undefined = Array.isArray(models)
    ? (models as Record<string, unknown>[]).map((entry) => ({
        alias: entry.alias as string,
        routes: (entry.routes as Record<string, unknown>[]).map((route) => ({
          upstream: route.upstream as string,
          model: route.model as string,
          ...(typeof route.weight === "number" ? { weight: route.weight } : {}),
        })),
        balance: { strategy: (entry.balance as Record<string, unknown>).strategy as BalanceStrategy },
        ...normalizedLimits(entry.limits),
      }))
    : undefined;

  return {
    ok: true,
    config: deepFreeze({
      server: serverBlock,
      logLevel: isValidLogLevel(logLevel) ? logLevel : DEFAULT_LOG_LEVEL,
      ...(authBlock !== undefined ? { auth: authBlock } : {}),
      ...(clientsBlock !== undefined ? { clients: clientsBlock } : {}),
      ...(modelsBlock !== undefined ? { models: modelsBlock } : {}),
      upstreams: (upstreams as Record<string, unknown>[]).map((entry) => ({
        type: entry.type as UpstreamType,
        id: entry.id as string,
        baseUrl: normalizeBaseUrl(entry.baseUrl as string),
        apiKey: entry.apiKey as string,
        ...normalizedTlsFingerprint(entry.tlsFingerprint),
        ...normalizedProxy(entry.proxy),
      })),
    }),
  };
}

/**
 * True when `value` is a JSON object (not an array, not null). Exported for
 * `src/config/store.ts`, whose per-entry write validators apply the same
 * plain-object gate the startup validator applies.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A shallow copy of a plain object without its `null`-valued keys — the
 * grammar's "null means not set" rule, applied one object at a time: a key
 * written as JSON `null` reads exactly like an omitted key (an optional field
 * takes its default or is cleared, a required one is reported missing) at
 * every level of the config. Keys named in `keep` keep their `null` — the
 * store's optional fields whose explicit clear must not read as "absent from
 * the patch" (an absent pin or proxy on update keeps the stored value, D7).
 * The strict-key pass always runs over the raw object, so an unknown key is
 * reported even when its value is `null`. Exported for `src/config/store.ts`.
 */
export function withoutNulls<T extends Record<string, unknown>>(
  value: T,
  keep: readonly string[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null || keep.includes(key)) result[key] = item;
  }
  return result;
}

/**
 * Copy a validated `limits` block into a normalized model entry — only the
 * known keys, and the block only when it carries at least one of them (an
 * empty block never validates, so the normalized shape stays honest even for
 * a value that failed and is never handed out).
 */
function normalizedLimits(value: unknown): { limits: ModelLimitsConfig } | {} {
  if (!isPlainObject(value)) return {};
  const limits: ModelLimitsConfig = {
    ...(typeof value.context === "number" ? { context: value.context } : {}),
    ...(typeof value.output === "number" ? { output: value.output } : {}),
  };
  return Object.keys(limits).length > 0 ? { limits } : {};
}

/**
 * Freeze `value` and every nested object/array it holds, in place. The
 * validated config is handed out frozen: nothing downstream mutates the
 * startup-derived shape (specs/domains/configuration.md "Invariants").
 * Plain values pass through unchanged. Exported for `src/config/store.ts`,
 * which re-freezes the rebuilt config after every applied runtime mutation
 * so the store hands out the same immutable shape the startup loader does.
 */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  return value;
}

/** Render a rejected value for a problem line; strings are quoted. */
function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
