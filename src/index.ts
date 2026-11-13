/**
 * The process entry point (specs/architecture/layers.md): the single place
 * that reads the config file, names concrete upstream classes, wires the
 * registry, builds the Hono app, and starts the listener. It constructs and
 * starts — it never serves requests itself.
 *
 * Startup order is fixed (specs/architecture/data-flow.md): config →
 * upstreams → registry → app → listen. The registry's `create()` awaits every
 * upstream's `connect()` probe before resolving, so the listener never
 * accepts traffic before the registry is populated and every probe has
 * finished (ok or logged). A failed probe is a warning naming the upstream's
 * (type, id) — never fatal (specs/architecture/data-flow.md anti-patterns).
 *
 * Failure reporting: an invalid config has already been fully reported to
 * stderr (one error line per problem, via src/config/load.ts) by the time
 * `loadConfigOrExit` exits with code 1 — before any port is bound. A missing
 * or unreadable TLS certificate/key file and a bind failure (port taken) are
 * logged and exit non-zero as well — also before any port is bound.
 *
 * Startup logging (specs/domains/observability.md, security-model.md
 * invariant 7): config loaded (path + upstream id/type pairs), per-upstream
 * probe results, listening address (with the fact of TLS — never the PEM
 * contents), shutdown. The raw config and key material are never logged.
 */
import { loadConfigOrExit, resolveConfigPath } from "./config/load.ts";
import type { NormalizedGatewayConfig } from "./config/schema.ts";
import { redactedConfigView } from "./config/redact.ts";
import { UpstreamRegistry, type UpstreamFactories } from "./upstreams/registry.ts";
import { OpenAICompatibleUpstream } from "./upstreams/openai-compatible.ts";
import { createApp } from "./httpapi/app.ts";
import { createLogger } from "./logging/logger.ts";
import type { GatewayEnv } from "./gateway/router.ts";
import type { Hono } from "hono";
import type pino from "pino";

/**
 * The `type` → factory map — the ONLY place a concrete upstream class is
 * named (specs/architecture/layers.md invariant 2). A new upstream module
 * adds its type string to `UPSTREAM_TYPES` (src/config/schema.ts) and exactly
 * one entry here; nothing else in the codebase ever sees a concrete class.
 */
const UPSTREAM_FACTORIES: UpstreamFactories = {
  "openai-compatible": (entry, logger) => new OpenAICompatibleUpstream(entry, logger),
};

/** The listener handle returned by `Bun.serve` (kept as a type inference so
 * the annotation follows the installed Bun types). */
export type GatewayServer = ReturnType<typeof Bun.serve>;

/** A running gateway: the wired pieces plus the listener, and how to stop it. */
export interface GatewayHandles {
  readonly config: NormalizedGatewayConfig;
  readonly registry: UpstreamRegistry;
  readonly app: Hono<GatewayEnv>;
  readonly server: GatewayServer;
  readonly logger: pino.Logger;
  /** Close the listener, aborting in-flight connections (tests, shutdown). */
  stop(): void;
}

export interface StartGatewayOptions {
  /**
   * Overrides the config path (`LLM_GATEWAY_CONFIG` env var, else
   * `./config.json`) — used by tests and embedding.
   */
  configPath?: string;
  /**
   * Overrides the real factory map — tests inject fake upstreams; production
   * startup never passes this.
   */
  factories?: UpstreamFactories;
}

/**
 * Parse a validated `listen` value ("host:port") into `Bun.serve` options.
 * A bracketed IPv6 literal ("[::1]:8080") unwraps to the bare address; plain
 * host labels and IPv4 contain no colon, so the last ":" always separates.
 */
export function parseListen(listen: string): { hostname: string; port: number } {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(listen);
  if (bracketed !== null) {
    const [, address = "", rawPort = ""] = bracketed;
    return { hostname: address, port: Number(rawPort) };
  }
  const separator = listen.lastIndexOf(":");
  return { hostname: listen.slice(0, separator), port: Number(listen.slice(separator + 1)) };
}

/**
 * Flush the buffered log destination, then exit — the final startup/shutdown
 * line must survive the exit (the logger's own destination is async).
 * The unref'd timer is a fallback: a stuck flush callback must never hang a
 * shutdown.
 */
function flushAndExit(logger: pino.Logger, code: number): void {
  logger.flush(() => process.exit(code));
  setTimeout(() => process.exit(code), 250).unref();
}

/**
 * Read one PEM file for the TLS listener (certificate or key) — its contents,
 * not its path: Bun's `tls.cert` / `tls.key` expect the PEM text. Runs before
 * the port is bound, so a missing or unreadable file is a fatal startup
 * error: one clear stderr line (path + reason; the path is not secret, the
 * file's contents never are) and exit code 1.
 */
async function readTlsFileOrExit(
  logger: pino.Logger,
  kind: "certificate" | "key",
  path: string,
): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ path, reason }, `tls ${kind} file not found/readable: ${path} — exiting`);
    flushAndExit(logger, 1);
    // flushAndExit exits the process within milliseconds; this only satisfies
    // control-flow analysis — and keeps a stuck flush a loud crash, not a hang.
    throw new Error(`tls ${kind} file not found/readable: ${path}: ${reason}`);
  }
}

/**
 * Wire and start the gateway: config → upstreams → registry (probes inside) →
 * app → listen. Returns the running handles; the listener accepts traffic
 * only after every probe has finished (ok or logged). Exits the process with
 * code 1 when the config is invalid (every problem already on stderr) or
 * when the configured address cannot be bound.
 */
export async function startGateway(options: StartGatewayOptions = {}): Promise<GatewayHandles> {
  // [1][2] Load + validate. `loadConfigOrExit` reports every problem (one
  // error line each, sync stderr) and exits 1 before anything is bound.
  const configPath = options.configPath ?? resolveConfigPath();
  const config = loadConfigOrExit({ path: configPath });
  const logger = createLogger(config.logLevel);

  // Startup log: the config path and the upstream inventory as (id, type)
  // pairs only — never the raw config, never key material
  // (specs/architecture/security-model.md invariant 7).
  logger.info(
    {
      configPath,
      upstreams: config.upstreams.map(({ id, type }) => ({ id, type })),
    },
    `config loaded — ${config.upstreams.length} upstream(s)`,
  );

  // [3][4][6] Construct one upstream per entry through the factory map,
  // register them, and run the connect() probes — sequentially, in config
  // order; probe failures warn and do not abort (registry.create resolves
  // only once every probe finished).
  const registry = await UpstreamRegistry.create(
    config.upstreams,
    options.factories ?? UPSTREAM_FACTORIES,
    logger,
  );

  // [5] Build the Hono app (routes, middleware, error mapping). The
  // management configuration endpoint receives the redacted view — the mask
  // replaces key material here, at the entry point, before anything crosses
  // into the HTTP layer (specs/architecture/layers.md,
  // specs/architecture/security-model.md).
  const app = createApp(registry, logger, redactedConfigView(config));

  // [7] Bind the configured address — loopback by default
  // (specs/architecture/security-model.md invariant 6). When TLS is enabled,
  // both PEM files are read first, before anything is bound: a missing or
  // unreadable file exits 1 with a clear stderr line. `Bun.serve` receives
  // the PEM contents (`tls.cert` / `tls.key` take text, not paths); only the
  // fact of TLS travels to logs, never the file contents
  // (specs/architecture/security-model.md invariant 7).
  const tlsConfig = config.server.tls;
  let tlsOptions: { cert: string; key: string } | undefined;
  if (tlsConfig?.enabled === true) {
    const { cert, key } = tlsConfig;
    if (cert === undefined || key === undefined) {
      // Unreachable through loadConfigOrExit (the schema requires both paths
      // when tls is enabled) — kept loud in case a future bypass skips it.
      logger.error({}, "tls is enabled but cert/key paths are missing — exiting");
      flushAndExit(logger, 1);
      throw new Error("tls is enabled but cert/key paths are missing");
    }
    tlsOptions = {
      cert: await readTlsFileOrExit(logger, "certificate", cert),
      key: await readTlsFileOrExit(logger, "key", key),
    };
  }

  const { hostname, port } = parseListen(config.server.listen);
  let server: GatewayServer;
  try {
    server =
      tlsOptions === undefined
        ? Bun.serve({ hostname, port, fetch: app.fetch })
        : Bun.serve({ hostname, port, fetch: app.fetch, tls: tlsOptions });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ listen: config.server.listen, reason }, "failed to bind the configured address — exiting");
    flushAndExit(logger, 1);
    // flushAndExit exits the process within milliseconds; this only satisfies
    // control-flow analysis — and keeps a stuck flush a loud crash, not a hang.
    throw new Error(`failed to bind ${config.server.listen}: ${reason}`);
  }

  logger.info({ listen: config.server.listen, tls: tlsOptions !== undefined }, "gateway listening");

  return {
    config,
    registry,
    app,
    server,
    logger,
    stop: () => server.stop(true),
  };
}

/**
 * Production startup: start the gateway, then keep the process alive until
 * SIGINT/SIGTERM close the listener (a shutdown line at info per
 * specs/domains/observability.md). Unexpected wiring failures propagate to
 * the runtime and crash non-zero — failing loudly is the contract.
 */
async function main(): Promise<void> {
  const handles = await startGateway();
  const shutdown = (signal: string): void => {
    handles.logger.info({ signal }, "shutdown requested — closing listener");
    handles.stop();
    flushAndExit(handles.logger, 0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
