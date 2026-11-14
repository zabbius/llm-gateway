/**
 * The Hono app — HTTP concerns only (specs/architecture/layers.md):
 *
 *   [1] auth stage        — the request lifecycle's first stage
 *                           (security-model.md): stage 1 (ADR-008) gates
 *                           /api/* with the config-backed session when the
 *                           auth block is enabled — middleware [1b] below;
 *                           auth off (or /llm/v1, /ui, /) → the stage stays
 *                           a pass-through placeholder (stage-2 TODO).
 *   [2] request logging   — ≥1 log line per request: method, path, upstream
 *                           id (when dispatch resolved one), status,
 *                           duration (data-flow.md request lifecycle).
 *   [3] error mapping     — the ONLY place exceptions become HTTP status
 *                           codes (layers.md structural invariant): anything
 *                           uncaught maps to a 502 upstream_error envelope
 *                           and is logged at error level.
 *   [4] route mounting    — GET /llm/v1/models, POST /llm/v1/chat/completions,
 *                           POST /llm/v1/completions (a single OpenAI surface —
 *                           never provider-specific routes) plus the
 *                           management surface GET /api/status and
 *                           GET /api/configuration (ADR-006).
 *   [5] UI namespace      — ADR-006 fallthrough, in order: GET / answers
 *                           302 -> /ui (independent of the build output);
 *                           then, only when the frontend build output
 *                           (`web/dist`, D7) exists, every /ui/* request
 *                           walks static file -> SPA fallback (unmatched
 *                           GET/HEAD serves web/dist/index.html — React
 *                           owns everything beyond /ui) -> envelope 404.
 *                           Unmatched paths outside /ui and all non-GET/HEAD
 *                           methods skip straight to the envelope 404.
 *                           Absent build → only the redirect is mounted.
 *
 * Layering (specs/architecture/layers.md invariant 3): this module imports
 * the gateway core only — the upstream registry reaches `createApp` as a
 * type-only re-export through `src/gateway/router.ts`, instances flow in
 * from the entry point as plain values, and no upstream lookup happens here.
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pino from "pino";
import { type UpstreamRegistry, type GatewayEnv } from "../gateway/router.ts";
import type { RedactedGatewayConfig } from "../config/redact.ts";
import type { AuthConfig } from "../config/schema.ts";
import { handleModels } from "./handlers/models.ts";
import { handleStatus } from "./handlers/status.ts";
import { handleConfiguration } from "./handlers/configuration.ts";
import { handleChatCompletions, handleCompletions } from "./handlers/completions.ts";
import { createAuthGate } from "./auth.ts";
import { notFoundResponse, upstreamErrorResponse } from "./errors.ts";

/** Frontend build output served under /ui when present (specs/domains/frontend.md). */
export const WEB_DIST_DIR = "web/dist";

/** Injectable app knobs — tests point `webDistDir` at a fixture dir. */
export interface UiServingOptions {
  /** Frontend build output directory; defaults to WEB_DIST_DIR. */
  webDistDir?: string;
  /**
   * The validated `auth` block from the config (real values — ADR-008): the
   * only path by which the password hash reaches this layer. Undefined, or
   * `enabled: false`, mounts no gate — behavior identical to before ADR-008.
   */
  auth?: AuthConfig;
}

/** Build the gateway app: routes mounted, middleware ordered, errors mapped.
 * `configuration` is the redacted config view the entry point built
 * (src/config/redact.ts) — the raw config never reaches this layer. */
export function createApp(
  registry: UpstreamRegistry,
  logger: pino.Logger,
  configuration: RedactedGatewayConfig,
  options: UiServingOptions = {},
): Hono<GatewayEnv> {
  const webDistDir = options.webDistDir ?? WEB_DIST_DIR;
  const log = logger.child({ component: "http" });
  const app = new Hono<GatewayEnv>();

  // [1] AUTH — the stage marker runs before routing; the stage-1 gate
  // (ADR-008) mounts below, after the request log. When auth is off the
  // marker's message names the pass-through placeholder (the whole stage);
  // when auth is on it names the mounted session gate. The trace line makes
  // the stage observable in both modes (specs/domains/observability.md —
  // per-request internals).
  const authStageMessage =
    options.auth?.enabled === true
      ? "auth stage — session gate mounted (ADR-008)"
      : "auth stage — no-op placeholder (gateway-auth TODO)";
  app.use("*", async (c, next) => {
    log.trace(
      { method: c.req.method, path: c.req.path },
      authStageMessage,
    );
    await next();
  });

  // [2] Request logging — one line per handled request, after the chain
  // produced its response. upstreamId is set by dispatch handlers via the
  // GatewayEnv binding; unset for non-dispatching routes.
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    log.debug(
      {
        method: c.req.method,
        path: c.req.path,
        upstreamId: c.get("upstreamId"),
        status: c.res.status,
        durationMs,
      },
      "request handled",
    );
  });

  // [1b] AUTH GATE (ADR-008) — the stage-1 implementation of the auth stage:
  // when the config enables auth, /api/* requires a valid session cookie
  // (POST /api/login and POST /api/logout excepted); /llm/v1, /ui, and /
  // pass ungated until the stage-2 Bearer contract. Mounted after the
  // request-log middleware so 401 answers are logged like every request
  // (≥1 line each), and before every route handler — the stage still
  // precedes routing (specs/architecture/data-flow.md). With auth off
  // nothing here mounts: behavior identical to before ADR-008, and the
  // auth endpoints do not exist (unknown POST → envelope 404).
  const authConfig = options.auth;
  if (authConfig?.enabled === true) {
    const gate = createAuthGate(
      {
        // The schema requires user + passwordHash whenever enabled is true
        // (specs/domains/configuration.md); the fallbacks are unreachable in
        // production and merely fail closed (an empty credential verifies
        // against nothing).
        user: authConfig.user ?? "",
        passwordHash: authConfig.passwordHash ?? "",
        secureCookies: configuration.server.tls?.enabled === true,
      },
      logger,
    );
    app.post("/api/login", gate.login);
    app.post("/api/logout", gate.logout);
    app.use("/api/*", gate.middleware);
  }

  // [3] Error mapping — the single place a thrown error becomes an HTTP
  // status (specs/architecture/layers.md). Well-behaved upstreams never
  // reject (they answer relayed or synthesized 502/504 Responses), so
  // reaching this handler means an unexpected failure on the gateway side;
  // per the client-gateway contract every gateway-generated failure uses the
  // OpenAI envelope, and the status is 502 api_error/upstream_error. The
  // internal error text is logged, never leaked to the client.
  app.onError((error, c) => {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(
      { method: c.req.method, path: c.req.path, reason },
      "unhandled error — mapping to 502 upstream_error envelope",
    );
    return upstreamErrorResponse("The gateway failed to process the request.");
  });

  // [4] Routes — the OpenAI surface, mounted at the /llm/v1 namespace
  // (ADR-006, specs/contracts/client-gateway.md). Clean cut: no /v1 aliases.
  app.get("/llm/v1/models", handleModels(registry, logger));
  app.post("/llm/v1/chat/completions", handleChatCompletions(registry, logger));
  app.post("/llm/v1/completions", handleCompletions(registry, logger));

  // [4b] Management surface (ADR-006, specs/contracts/gateway-management.md)
  // — read-only gateway observation for the SPA, operators, and scripts.
  // Mounted with the API routes, before static serving: the SPA mount can
  // never shadow an /api route. GET /api/status reports the retained
  // startup-probe outcomes (always 200 — a failed probe is data, not an
  // error); GET /api/configuration serves the redacted view the entry point
  // built — the raw config and its key material never reach this layer.
  app.get("/api/status", handleStatus(registry, authConfig?.enabled === true));
  app.get("/api/configuration", handleConfiguration(configuration));

  // [5] UI namespace (ADR-006) — one top-level prefix per surface; the
  // fallthrough chain is root redirect -> static file -> index.html ->
  // envelope. The redirect is mounted unconditionally: it must not depend
  // on the build output. The /ui mounts exist only when the build output
  // does. Mounted after the API routes so /llm and /api always win.
  app.get("/", (c) => c.redirect("/ui", 302));
  if (existsSync(webDistDir)) {
    // Static assets: /ui/icon.svg -> <webDistDir>/icon.svg. The /ui path
    // prefix is rewritten away — the mount namespace is /ui, the dist root
    // is not nested under it. Unknown files fall through via next().
    app.use("/ui/*", serveStatic({
      root: webDistDir,
      rewriteRequestPath: (path) => path.replace(/^\/ui/, "") || "/",
    }));
    // SPA fallback: any /ui/* request serveStatic did not answer (GET/HEAD
    // only) gets the SPA document — React owns everything beyond /ui, so
    // deep links are real URLs resolved client-side (ADR-006). index.html
    // is read per request: no caching layer in the MVP. A document missing
    // since startup answers plain-text 404/500 — this is the HTML surface,
    // not the API: no upstream was involved, so neither the envelope nor
    // the 502 upstream_error mapping applies. Other methods skip into the
    // envelope notFound below.
    app.on(["GET", "HEAD"], "/ui/*", async () => {
      try {
        const html = await readFile(join(webDistDir, "index.html"), "utf8");
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        const status = code === "ENOENT" ? 404 : 500;
        return new Response(`SPA document unavailable (HTTP ${status})\n`, {
          status,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    });
  }

  // Every gateway-generated error uses the OpenAI envelope — including
  // unmatched routes (specs/contracts/client-gateway.md rules).
  app.notFound((c) => notFoundResponse(`Route not found: ${c.req.method} ${c.req.path}`));

  return app;
}
