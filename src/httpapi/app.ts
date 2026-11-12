/**
 * The Hono app — HTTP concerns only (specs/architecture/layers.md):
 *
 *   [1] auth stage        — MVP no-op placeholder (D4): gateway-auth is a
 *                           documented TODO; the stage precedes routing and
 *                           no code path skips it (security-model.md).
 *   [2] request logging   — ≥1 log line per request: method, path, adapter
 *                           id (when dispatch resolved one), status,
 *                           duration (data-flow.md request lifecycle).
 *   [3] error mapping     — the ONLY place exceptions become HTTP status
 *                           codes (layers.md structural invariant): anything
 *                           uncaught maps to a 502 upstream_error envelope
 *                           and is logged at error level.
 *   [4] route mounting    — GET /v1/models, POST /v1/chat/completions,
 *                           POST /v1/completions (a single OpenAI surface —
 *                           never provider-specific routes).
 *   [5] SPA stub          — when the frontend build output (`web/dist`,
 *                           D7) exists, it is served at /; API routes take
 *                           precedence. Absent build → skipped entirely.
 *
 * Layering (specs/architecture/layers.md invariant 3): this module imports
 * the gateway core only — the adapter registry reaches `createApp` as a
 * type-only re-export through `src/gateway/router.ts`, instances flow in
 * from the entry point as plain values, and no adapter lookup happens here.
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import type pino from "pino";
import { type AdapterRegistry, type GatewayEnv } from "../gateway/router.ts";
import { handleModels } from "./handlers/models.ts";
import { handleChatCompletions, handleCompletions } from "./handlers/completions.ts";
import { notFoundResponse, upstreamErrorResponse } from "./errors.ts";

/** Frontend build output served at / when present (specs/domains/frontend.md). */
export const WEB_DIST_DIR = "web/dist";

/** Build the gateway app: routes mounted, middleware ordered, errors mapped. */
export function createApp(registry: AdapterRegistry, logger: pino.Logger): Hono<GatewayEnv> {
  const log = logger.child({ component: "http" });
  const app = new Hono<GatewayEnv>();

  // [1] AUTH — no-op placeholder: gateway-auth is a documented TODO
  // (specs/architecture/security-model.md). Runs before routing; the trace
  // line makes the stage observable (specs/domains/observability.md —
  // per-request internals).
  app.use("*", async (c, next) => {
    log.trace(
      { method: c.req.method, path: c.req.path },
      "auth stage — no-op placeholder (gateway-auth TODO)",
    );
    await next();
  });

  // [2] Request logging — one line per handled request, after the chain
  // produced its response. adapterId is set by dispatch handlers via the
  // GatewayEnv binding; unset for non-dispatching routes.
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    log.debug(
      {
        method: c.req.method,
        path: c.req.path,
        adapterId: c.get("adapterId"),
        status: c.res.status,
        durationMs,
      },
      "request handled",
    );
  });

  // [3] Error mapping — the single place a thrown error becomes an HTTP
  // status (specs/architecture/layers.md). Well-behaved adapters never
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

  // [4] Routes — the OpenAI surface (specs/contracts/client-gateway.md).
  app.get("/v1/models", handleModels(registry, logger));
  app.post("/v1/chat/completions", handleChatCompletions(registry, logger));
  app.post("/v1/completions", handleCompletions(registry, logger));

  // [5] SPA stub — mounted after the API routes so /v1/* always wins;
  // unmatched paths fall through serveStatic into the envelope notFound.
  if (existsSync(WEB_DIST_DIR)) {
    app.use("*", serveStatic({ root: WEB_DIST_DIR }));
  }

  // Every gateway-generated error uses the OpenAI envelope — including
  // unmatched routes (specs/contracts/client-gateway.md rules).
  app.notFound((c) => notFoundResponse(`Route not found: ${c.req.method} ${c.req.path}`));

  return app;
}
