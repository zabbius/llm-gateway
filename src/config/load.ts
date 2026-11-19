/**
 * Startup config loading (specs/domains/configuration.md "Flow" and "File
 * location").
 *
 * The config is read and validated exactly once per process start — there is
 * no hot reload. The path comes from the `LLM_GATEWAY_CONFIG` env var if set
 * (the only path tried), otherwise `./config.json` relative to the process
 * working directory.
 *
 * Failure reporting is total: every problem of one startup attempt is logged
 * as its own error line (via a logger bound to `component: "config"`) before
 * the caller exits with code 1 — the gateway never fails on the first problem
 * and hides the rest. A failed validation therefore happens before any port
 * is bound.
 */
import { readFileSync } from "node:fs";
import pino from "pino";
import {
  validateGatewayConfig,
} from "./schema.ts";
import type { NormalizedGatewayConfig } from "./schema.ts";

/** The env var that overrides the default config path. */
export const CONFIG_ENV_VAR = "LLM_GATEWAY_CONFIG";

/** The config path used when the env var is unset. */
export const DEFAULT_CONFIG_PATH = "./config.json";

/**
 * The problem-reporting surface of the config loader. A child of the root
 * logger bound as `logger.child({ component: "config" })` satisfies it; the
 * tests pass a capturing stub instead.
 */
export interface ConfigProblemLogger {
  error(message: string): void;
}

export interface LoadConfigOptions {
  /** Overrides the env var and the default path — used by tests and embedding. */
  path?: string;
  /** Where problems are reported; defaults to {@link bootstrapConfigLogger}. */
  log?: ConfigProblemLogger;
}

export type ConfigLoadResult =
  | { ok: true; path: string; config: NormalizedGatewayConfig }
  | { ok: false; path: string; problems: string[] };

/** The env var → default path resolution (an empty env value counts as unset). */
export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[CONFIG_ENV_VAR];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_CONFIG_PATH;
}

/**
 * Resolve the config path, read and parse the file, validate and normalize
 * its contents. Problems are logged one line each as they are found, and the
 * full list is also returned to the caller. Never throws.
 */
export function loadConfig(options: LoadConfigOptions = {}): ConfigLoadResult {
  const path = options.path ?? resolveConfigPath();
  const log = options.log ?? bootstrapConfigLogger();

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return fail(log, path, [describeReadError(path, error)]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(log, path, [describeJsonError(path, text, error)]);
  }

  const validated = validateGatewayConfig(parsed);
  if (!validated.ok) {
    return fail(log, path, validated.problems);
  }
  return { ok: true, path, config: validated.config };
}

/**
 * `loadConfig` for the startup wiring in `src/index.ts`: log every problem
 * (already done by `loadConfig`) and exit with code 1 on failure, or return
 * the normalized config.
 */
export function loadConfigOrExit(options: LoadConfigOptions = {}): NormalizedGatewayConfig {
  const result = loadConfig(options);
  if (!result.ok) {
    process.exit(1);
  }
  return result.config;
}

/** Log each problem as one error line, then return the failure result. */
function fail(
  log: ConfigProblemLogger,
  path: string,
  problems: string[],
): ConfigLoadResult {
  for (const problem of problems) {
    log.error(problem);
  }
  return { ok: false, path, problems };
}

/**
 * The pre-config logger. The configured level is not known until the config
 * has loaded, and every line this logger ever emits is a startup failure
 * (error level), so the level is pinned to "error". Its destination is sync:
 * the failure lines must survive the immediate `process.exit(1)` that follows.
 * Redaction is not needed: the messages are constructed here and never embed
 * an apiKey value.
 */
function bootstrapConfigLogger(): pino.Logger {
  return pino({ level: "error" }, pino.destination({ dest: 2, sync: true })).child({
    component: "config",
  });
}

function describeReadError(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") {
    return `config file not found: ${path}`;
  }
  return `config file could not be read: ${path}${code !== undefined ? ` (${code})` : ""}`;
}

/**
 * Describe a JSON parse failure, naming line and column when the engine's
 * error message carries a position.
 * Exported for tests (and reuse): the "names line/column when available"
 * behavior is asserted directly, including with engine messages that do carry
 * a position.
 */
export function describeJsonError(path: string, text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const at = parseErrorPosition(message, text);
  const where = at === undefined ? "" : ` at line ${at.line}, column ${at.column}`;
  return `invalid JSON in ${path}${where}: ${message}`;
}

/**
 * Extract a 1-based line/column from a parse error message. Understands
 * absolute-offset forms ("… at position 42", resolved against the parsed
 * text) and direct "line N, column M" forms; returns undefined when the
 * message carries no position.
 */
function parseErrorPosition(
  message: string,
  text: string,
): { line: number; column: number } | undefined {
  const lineColumn = /line (\d+),? column (\d+)/i.exec(message);
  if (lineColumn !== null) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }
  const offsetMatch = /(?:at )?position (\d+)/i.exec(message);
  if (offsetMatch === null) {
    return undefined;
  }
  const offset = Math.min(Number(offsetMatch[1]), text.length);
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const lastBreak = before.lastIndexOf("\n");
  const column = lastBreak === -1 ? offset + 1 : offset - lastBreak;
  return { line, column };
}
