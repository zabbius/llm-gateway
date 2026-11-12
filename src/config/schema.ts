/**
 * The gateway config file's schema and validation rules
 * (specs/domains/configuration.md).
 *
 * Validation and normalization live in exactly one place — here. A new
 * upstream `type` extends this module with its own required per-type fields
 * and their checks; the loading/reporting machinery in `src/config/load.ts`
 * never grows per-field knowledge.
 *
 * The schema is strict: unknown top-level keys and unknown per-upstream keys
 * are rejected, so typos fail loudly at startup. Validation is total — every
 * problem of one config is collected and reported together, never the first
 * one only.
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

/** The config file shape as parsed from JSON. */
export interface GatewayConfig {
  /** "host:port"; omitted → "127.0.0.1:8080" (loopback until gateway-auth lands) */
  listen?: string;
  /** omitted → "info" */
  logLevel?: LogLevel;
  /** at least one entry; ids unique across the array */
  upstreams: UpstreamConfig[];
}

/** A validated config with every optional field defaulted and baseUrl normalized. */
export interface NormalizedGatewayConfig extends GatewayConfig {
  listen: string;
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
export const TOP_LEVEL_KEYS: readonly string[] = ["listen", "logLevel", "upstreams"];
export const UPSTREAM_KEYS: readonly string[] = ["type", "id", "baseUrl", "apiKey", "tlsFingerprint"];

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
 * `problems` list in a stable order (top level first, then upstream entries
 * by index); returns the normalized config only when the list stays empty.
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

  const listen = value.listen;
  if (listen !== undefined && (typeof listen !== "string" || !isListen(listen))) {
    problems.push(`listen must be a "host:port" string with a port in 1-65535 (got ${shown(listen)})`);
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

  return {
    ok: true,
    config: {
      listen: typeof listen === "string" ? listen : DEFAULT_LISTEN,
      logLevel: isValidLogLevel(logLevel) ? logLevel : DEFAULT_LOG_LEVEL,
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
