/**
 * The single process-wide logger (specs/domains/observability.md, ADR-004).
 *
 * - JSON lines, exclusively to stderr (fd 2); stdout stays empty forever.
 * - Level comes from the gateway config vocabulary (`LogLevel`); the mapping
 *   onto pino's spellings lives here and nowhere else.
 * - A fixed set of sensitive fields is redacted before any line is emitted,
 *   at every level including trace (specs/architecture/security-model.md).
 *
 * Components never build their own logger: they take children of the root —
 * `root.child({ component: "router" | "http" | "config" | "upstream:<id>" })`.
 */
import pino from "pino";
import type { LogLevel } from "../types.ts";

/** config vocabulary → pino levels (pino spells them "warn" / "silent"). */
export const PINO_LEVEL: Record<LogLevel, string> = {
  trace: "trace",
  debug: "debug",
  info: "info",
  warning: "warn",
  error: "error",
  none: "silent",
};

/**
 * Sensitive field names redacted from every log line. The names are a fixed
 * set: header shapes (bare, under `headers`, or under a request handle's
 * `headers`) and credential config fields (bare or one level deep — e.g.
 * `{ auth: { passwordHash } }` or an upstream entry).
 */
const REDACT_PATHS: readonly string[] = [
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "token",
  "apiKey",
  "passwordHash",
  "*.apiKey",
  "*.passwordHash",
  "headers.authorization",
  "headers.x-api-key",
  "headers.api-key",
  "headers.cookie",
  "headers.token",
  "*.headers.authorization",
  "*.headers.x-api-key",
  "*.headers.api-key",
  "*.headers.cookie",
  "*.headers.token",
];

/** Replacement written in place of every redacted value. */
export const REDACT_CENSOR = "[Redacted]";

/**
 * Create the root logger. Call once at startup with the configured level
 * and pass it (or its children) to every component.
 */
export function createLogger(level: LogLevel): pino.Logger {
  return pino(
    {
      level: PINO_LEVEL[level],
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    },
    pino.destination({ dest: 2, sync: false }),
  );
}
