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
 * `server`, `server.tls`, `auth`, per-upstream — so typos fail loudly at
 * startup. Validation is total — every problem of one config is collected and
 * reported together, never the first one only.
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
 * letter or digit. The grammar excludes "/" (the model-id prefix separator,
 * ADR-002), "_" and uppercase, so an id can never collide with the public
 * `<upstreamId>/<model>` scheme.
 */
export const UPSTREAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The gateway log-level vocabulary (also `LogLevel` in src/types.ts). */
export const LOG_LEVELS = ["trace", "debug", "info", "warning", "error", "none"] as const;

export const DEFAULT_LISTEN = "127.0.0.1:8080";
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

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
   * decoded. Absent or empty → the system CA pool verifies the upstream
   * certificate; non-empty → ONLY the pinned key is accepted (ADR-005).
   * Inert on a plain-http baseUrl. Compute with `tools/tls-fingerprint.ts`.
   */
  tlsFingerprint?: string;
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
 * Management-surface auth options (`auth` in the config file, ADR-008):
 * a single config-backed operator identity. The block mirrors the `tls`
 * precedent — `enabled` is required whenever the block is present; the
 * credential fields are required only while `enabled` is true but may stay
 * configured (staged) while `enabled` is false. An absent block means no
 * auth gate: the gateway behaves exactly as before ADR-008.
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
  /** omitted → the listener serves plain HTTP */
  tls?: TlsConfig;
}

/** The config file shape as parsed from JSON. */
export interface GatewayConfig {
  /** listener options; an omitted `server` block means every default */
  server?: ServerConfig;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** omitted → the management surface is ungated (ADR-008) */
  auth?: AuthConfig;
  /** at least one entry; ids unique across the array */
  upstreams: UpstreamConfig[];
}

/** The `server` block after normalization: `listen` is always set. */
export interface NormalizedServerConfig extends ServerConfig {
  listen: string;
}

/** A validated config with every optional field defaulted and baseUrl normalized. */
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
export const TOP_LEVEL_KEYS: readonly string[] = ["server", "logLevel", "auth", "upstreams"];
export const SERVER_KEYS: readonly string[] = ["listen", "tls"];
export const TLS_KEYS: readonly string[] = ["enabled", "cert", "key"];
export const AUTH_KEYS: readonly string[] = ["enabled", "user", "passwordHash"];
export const UPSTREAM_KEYS: readonly string[] = ["type", "id", "baseUrl", "apiKey", "tlsFingerprint"];

/**
 * A PHC-format password hash prefix (ADR-008): `$argon2id$…` / `$argon2i$…` /
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
 * certificate's SPKI DER (ADR-005). Comparison is whitespace-tolerant: the
 * normalized form strips every whitespace character before validation.
 */
const TLS_FINGERPRINT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strip every whitespace character (a pin pasted with line wraps still matches). */
export function normalizeTlsFingerprint(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * True when `value` is a usable TLS fingerprint pin: the empty string (no
 * pin), or a base64 (standard alphabet) string decoding to exactly 32 bytes.
 * A syntactically wrong pin fails config validation — typos fail loudly at
 * startup, never at the first request (specs/domains/configuration.md).
 */
export function isValidTlsFingerprint(value: string): boolean {
  const normalized = normalizeTlsFingerprint(value);
  if (normalized.length === 0) return true;
  if (!TLS_FINGERPRINT_PATTERN.test(normalized)) return false;
  return Buffer.from(normalized, "base64").length === 32;
}

/** True when `value` is one of the six config log levels. */
export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** True when `value` is a `"host:port"` string with a port in 1–65535. */
export function isListen(value: string): boolean {
  const match = LISTEN_PATTERN.exec(value);
  if (!match) return false;
  const port = Number(match.groups?.port ?? Number.NaN);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
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

/**
 * Validate and normalize a parsed config value. Collects every problem —
 * unknown keys, grammar violations, missing keys, duplicate ids — into one
 * `problems` list in a stable order (top level first, then the `server`
 * block, then the `auth` block, then upstream entries by index); returns the
 * normalized config only when the list stays empty.
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

  const server = value.server;
  if (server !== undefined && !isPlainObject(server)) {
    problems.push("server must be a JSON object");
  }

  if (isPlainObject(server)) {
    for (const key of Object.keys(server)) {
      if (!SERVER_KEYS.includes(key)) {
        problems.push(`server: unknown key "${key}" (valid keys: ${SERVER_KEYS.join(", ")})`);
      }
    }

    const listen = server.listen;
    if (listen !== undefined && (typeof listen !== "string" || !isListen(listen))) {
      problems.push(`server.listen must be a "host:port" string with a port in 1-65535 (got ${shown(listen)})`);
    }

    const tls = server.tls;
    if (isPlainObject(tls)) {
      for (const key of Object.keys(tls)) {
        if (!TLS_KEYS.includes(key)) {
          problems.push(`server.tls: unknown key "${key}" (valid keys: ${TLS_KEYS.join(", ")})`);
        }
      }

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
    } else if (tls !== undefined) {
      problems.push("server.tls must be a JSON object");
    }
  }

  const auth = value.auth;
  if (auth !== undefined && !isPlainObject(auth)) {
    problems.push("auth must be a JSON object");
  }

  if (isPlainObject(auth)) {
    for (const key of Object.keys(auth)) {
      if (!AUTH_KEYS.includes(key)) {
        problems.push(`auth: unknown key "${key}" (valid keys: ${AUTH_KEYS.join(", ")})`);
      }
    }

    const enabled = auth.enabled;
    if (enabled === undefined) {
      problems.push('auth: missing required key "enabled"');
    } else if (typeof enabled !== "boolean") {
      problems.push(`auth: enabled must be a boolean (got ${shown(enabled)})`);
    }

    // user/passwordHash are required only while auth is enabled — a staged
    // block (enabled: false) may carry them for later. The passwordHash value
    // is never echoed into a problem line — it must never reach stderr or any
    // log (specs/architecture/security-model.md, ADR-008).
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

  const logLevel = value.logLevel;
  if (logLevel !== undefined && !isValidLogLevel(logLevel)) {
    problems.push(`logLevel must be one of: ${LOG_LEVELS.join(", ")} (got ${shown(logLevel)})`);
  }

  const upstreams = value.upstreams;
  if (!Array.isArray(upstreams) || upstreams.length === 0) {
    problems.push("upstreams must be an array with at least one upstream entry");
    return { ok: false, problems };
  }

  const seenIds = new Map<string, number[]>();

  upstreams.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`upstreams[${index}] must be a JSON object`);
      return;
    }

    for (const key of Object.keys(entry)) {
      if (!UPSTREAM_KEYS.includes(key)) {
        problems.push(`upstreams[${index}]: unknown key "${key}" (valid keys: ${UPSTREAM_KEYS.join(", ")})`);
      }
    }

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
    // same way it stays free of apiKey. A pin on a plain-http baseUrl stays
    // valid but is inert (ADR-005).
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
  });

  for (const [id, indexes] of seenIds) {
    if (indexes.length > 1) {
      problems.push(`duplicate upstream id "${id}" (entries ${indexes.join(", ")})`);
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const serverBlock: NormalizedServerConfig = {
    listen: isPlainObject(server) && typeof server.listen === "string" ? server.listen : DEFAULT_LISTEN,
  };
  if (isPlainObject(server) && isPlainObject(server.tls)) {
    serverBlock.tls = {
      enabled: server.tls.enabled as boolean,
      ...(typeof server.tls.cert === "string" ? { cert: server.tls.cert } : {}),
      ...(typeof server.tls.key === "string" ? { key: server.tls.key } : {}),
    };
  }

  const authBlock: AuthConfig | undefined = isPlainObject(auth)
    ? {
        enabled: auth.enabled as boolean,
        ...(typeof auth.user === "string" ? { user: auth.user } : {}),
        ...(typeof auth.passwordHash === "string" ? { passwordHash: auth.passwordHash } : {}),
      }
    : undefined;

  return {
    ok: true,
    config: {
      server: serverBlock,
      logLevel: isValidLogLevel(logLevel) ? logLevel : DEFAULT_LOG_LEVEL,
      ...(authBlock !== undefined ? { auth: authBlock } : {}),
      upstreams: (upstreams as Record<string, unknown>[]).map((entry) => ({
        type: entry.type as UpstreamType,
        id: entry.id as string,
        baseUrl: normalizeBaseUrl(entry.baseUrl as string),
        apiKey: entry.apiKey as string,
        ...(typeof entry.tlsFingerprint === "string"
          ? { tlsFingerprint: normalizeTlsFingerprint(entry.tlsFingerprint) }
          : {}),
      })),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a rejected value for a problem line; strings are quoted. */
function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
