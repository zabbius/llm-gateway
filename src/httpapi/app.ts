/**
 * The Hono app — HTTP concerns only (specs/architecture/layers.md):
 *
 *   [1] auth stage        — the request lifecycle's first stage
 *                           (security-model.md): stage 1 (ADR-007) gates
 *                           /api/* with the config-backed session when the
 *                           auth block is enabled — middleware [1b] below;
 *                           stage 2 (ADR-008) gates /llm/v1/* with the
 *                           config-backed client Bearer key when the clients
 *                           block is configured — middleware [1c] below;
 *                           with neither credential class configured the
 *                           stage stays a pass-through placeholder.
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
 *                           management surface: GET /api/status, the
 *                           operator-triggered GET /api/upstreams/:id/models
 *                           (ADR-005, ADR-011), and — when the
 *                           runtime configuration store is wired — the
 *                           management CRUD blocks (ADR-014): the [4d] one
 *                           over the `upstreams` collection (GET/POST
 *                           /api/upstreams, GET/PUT/DELETE
 *                           /api/upstreams/:id and the
 *                           POST /api/upstreams/:id/discover mount) and
 *                           the [4e] one over the `models` collection
 *                           (GET/POST /api/models, GET/PUT/DELETE
 *                           /api/models/:alias) and the [4f] one over the
 *                           `clients` collection (GET/POST /api/clients,
 *                           GET/PUT/DELETE /api/clients/:name) — the
 *                           boundary's runtime write half. Each mount
 *                           carries a `describeRoute` operation description
 *                           as its third argument — a request-time no-op
 *                           read by hono-openapi's route-table
 *                           introspection, never a validator — and the
 *                           [4c] docs namespace serves the result: GET
 *                           /docs/openapi.json (the generated OpenAPI
 *                           document) and GET /docs (the Swagger UI
 *                           shell), deliberately ungated and outside
 *                           every gate prefix.
 *   [5] UI namespace      — ADR-005 fallthrough, in order: GET / answers
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
import { type UpstreamRegistry, type GatewayEnv, createRebuildableRoutingTable } from "../gateway/router.ts";
import type { RedactedGatewayConfig } from "../config/redact.ts";
import type { AuthConfig, ClientConfig, ModelConfig } from "../config/schema.ts";
import type { ConfigStore } from "../config/store.ts";
import { MetadataStore } from "../gateway/metastore.ts";
import { handleModels } from "./handlers/models.ts";
import { handleStatus } from "./handlers/status.ts";
import { handleUpstreamModels } from "./handlers/upstream-models.ts";
import { upstreamManagementHandlers } from "./handlers/upstreams.ts";
import { modelAliasManagementHandlers } from "./handlers/model-aliases.ts";
import { clientManagementHandlers } from "./handlers/clients.ts";
import { handleChatCompletions, handleCompletions } from "./handlers/completions.ts";
import { createAuthGate } from "./auth.ts";
import { createClientAuthGate } from "./client-auth.ts";
import { notFoundResponse, upstreamErrorResponse } from "./errors.ts";
import { SWAGGER_UI_HTML } from "./docs-shell.ts";

/** Frontend build output served under /ui when present (specs/domains/frontend.md). */
export const WEB_DIST_DIR = "web/dist";

/**
 * The generated OpenAPI document served statically at /docs/openapi.json —
 * written by `bun run apidocs` (the build-time generator; specs/decisions/
 * 013-openapi-docs-surface.md). The string mirrors
 * `OPENAPI_ARTIFACT_PATH` in generate-openapi.ts; the openapi.test.ts sync
 * guard asserts the two stay equal. Injectable for tests.
 */
export const OPENAPI_DOC_PATH = "dist/openapi.json";

/** Injectable app knobs — tests point `webDistDir` at a fixture dir. */
export interface UiServingOptions {
  /** Frontend build output directory; defaults to WEB_DIST_DIR. */
  webDistDir?: string;
  /**
   * The generated OpenAPI document served at /docs/openapi.json; defaults
   * to OPENAPI_DOC_PATH. Tests point it at a fixture artifact; a missing
   * file answers the envelope 404 with the regenerate hint.
   */
  openApiDocPath?: string;
  /**
   * The validated `auth` block from the config (real values — ADR-007): the
   * only path by which the password hash reaches this layer. Undefined, or
   * `enabled: false`, mounts no gate — behavior identical to before ADR-007.
   */
  auth?: AuthConfig;
  /**
   * The validated `clients` block from the config (real values — ADR-008):
   * the only path by which a client apiKey reaches this layer. Undefined, or
   * empty, mounts no gate — behavior identical to before ADR-008 — unless
   * the runtime configuration store is wired (ADR-014): then the gate mounts
   * regardless, seeded from the store's current clients (an empty registry
   * answers every /llm/v1 request 401 — fail-closed — until the CRUD creates
   * the first client), and every clients mutation hot-applies into it.
   */
  clients?: ClientConfig[];
  /**
   * The validated `models` block from the config (ADR-009): the alias table
   * the routing layer resolves against. Carries no secrets (alias, routes,
   * balance only), but flows through the same entry-point-injected options
   * slice as the credential blocks. Undefined (block absent) → an empty
   * table: no alias resolves and the LLM surface answers 404 everywhere.
   */
  models?: ModelConfig[];
  /**
   * The per-upstream model-metadata store (specs/domains/routing.md "Alias
   * metadata"): the entry point constructs and seeds it from the startup
   * probes; the catalog and status handlers fold its *current* slice into
   * client-facing metadata on every request. Carries no secrets — provider
   * listing entries and their aggregates only. Undefined → the handlers
   * behave exactly as before alias metadata existed: bare catalog entries,
   * an empty `meta[]` section.
   */
  metadataStore?: MetadataStore;
  /**
   * The runtime configuration store (ADR-014 D1): present → the management
   * CRUD mounts (the upstream collection's six routes — ADR-014 D2, the
   * models collection's five, the clients collection's five). Undefined →
   * none of the CRUD routes mount, exactly the pre-ADR-014 behavior
   * (tests, embedded use).
   * The store's real credential values never cross into this layer: reads
   * go through the store's redacted view (`ConfigStore.view`).
   */
  configStore?: ConfigStore;
  /**
   * The probe budget for the management CRUD's blocking probes and the
   * discover mount (ADR-014 D8); defaults to the upstream domain's startup
   * probe budget (10 s). Injectable so tests can shrink the budget.
   */
  probeBudgetMs?: number;
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
  const openApiDocPath = options.openApiDocPath ?? OPENAPI_DOC_PATH;
  const log = logger.child({ component: "http" });
  const app = new Hono<GatewayEnv>();
  // The alias routing table (ADR-009): built at app-construction time (= startup)
  // from the validated models block plus the registry — the HTTP layer only ever
  // reads it. Built through the rebuildable holder: the table object the handlers
  // capture stays stable, while a runtime models mutation (the [4e] CRUD below,
  // ADR-014) constructs a fresh build and atomically swaps it in — the next
  // request resolves the new/changed alias without a restart, and in-flight
  // requests complete against the build that dispatched them. Selection and
  // health live in the route balancer (specs/domains/load-balancing.md); its
  // route transition lines (opened / recovered) log under the router component.
  const routingRef = createRebuildableRoutingTable(options.models ?? [], registry, {
    logger: logger.child({ component: "router" }),
  });
  const routing = routingRef.table;

  // [1] AUTH — the stage marker runs before routing; the stage-1 gate
  // (ADR-007) and the stage-2 client gate (ADR-008) mount below, after the
  // request log. The marker's message names every mounted gate, or the
  // pass-through placeholder when neither credential class is configured.
  // The trace line makes the stage observable in all modes
  // (specs/domains/observability.md — per-request internals).
  const clientsConfig = options.clients;
  // Generalized client-gate mounting (ADR-014 D2): whenever the runtime
  // configuration store is wired — the clients CRUD can create the first
  // client later, and the empty registry answers 401 until it does — or the
  // config carries a non-empty `clients` block (the pre-CRUD shape).
  const clientGateMounted =
    options.configStore !== undefined || (clientsConfig !== undefined && clientsConfig.length > 0);
  const stageGates: string[] = [];
  if (options.auth?.enabled === true) stageGates.push("session gate mounted (ADR-007)");
  if (clientGateMounted) stageGates.push("client Bearer gate mounted (ADR-008)");
  const authStageMessage =
    stageGates.length > 0
      ? `auth stage — ${stageGates.join("; ")}`
      : "auth stage — no-op placeholder (no auth block, no clients)";
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

  // [1b] AUTH GATE (ADR-007) — the stage-1 implementation of the auth stage:
  // when the config enables auth, /api/* requires a valid session cookie
  // (POST /api/login and POST /api/logout excepted); /llm/v1, /ui, and /
  // are not this gate's surface (the stage-2 client gate mounts separately
  // below). Mounted after the
  // request-log middleware so 401 answers are logged like every request
  // (≥1 line each), and before every route handler — the stage still
  // precedes routing (specs/architecture/data-flow.md). With auth off
  // nothing here mounts: behavior identical to before ADR-007, and the
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
        // The request-body cap is server metadata from the same redacted view
        // (`server.maxRequestBodyBytes` — not secret), like `listen` and TLS.
        maxBodyBytes: configuration.server.maxRequestBodyBytes,
      },
      logger,
    );
    app.post("/api/login", gate.login);
    app.post("/api/logout", gate.logout);
    app.use("/api/*", gate.middleware);
  }

  // [1c] CLIENT AUTH GATE (ADR-008) — the stage-2 implementation of the
  // auth stage: every /llm/v1/* request requires `Authorization: Bearer
  // <apiKey>` matching one configured client (timing-safe SHA-256 digests —
  // client-auth.ts); a missing credential answers the 401
  // authentication_required envelope, an unknown key the 401
  // invalid_api_key envelope — both from the single error mapper, before
  // routing, before any body read, before any upstream contact. The /api/*
  // session gate above is a separate credential class on a separate surface
  // and is untouched. The gate mounts when the config carries a non-empty
  // `clients` block — and, generalized for the runtime CRUD (ADR-014 D2),
  // whenever the configuration store is wired: the clients collection can
  // create its first entry at runtime, so the gate mounts already in the
  // empty-registry state and answers every request 401 — fail-closed; the
  // LLM surface never opens because the registry is (or became) empty. That
  // is distinct from a deployment with no clients block at all and no store
  // (the pre-ADR-014 shape): nothing mounts there, exactly the behavior
  // before ADR-008. The gate instance is retained below: the [4f] clients
  // CRUD hot-applies every mutation into it. Mounted after the request-log
  // middleware so 401 answers are logged like every request (≥1 line each).
  // The gate consumes the client's Authorization header — it is still never
  // forwarded upstream: the upstream attaches its own credential from its
  // config (openai-compatible.ts header whitelist).
  const clientAuthGate =
    options.configStore !== undefined || (clientsConfig !== undefined && clientsConfig.length > 0)
      ? createClientAuthGate(
          // The store is the single source of truth once wired: its current
          // clients (an empty registry when no block exists yet) seed the
          // gate; without a store the validated config slice is the input.
          (options.configStore !== undefined ? options.configStore.clients : clientsConfig) ?? [],
          logger,
        )
      : undefined;
  if (clientAuthGate !== undefined) {
    app.use("/llm/v1/*", clientAuthGate.middleware);
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
  // (ADR-005, specs/contracts/client-gateway.md). Clean cut: no /v1 aliases.
  // GET /llm/v1/models serves the gateway's alias catalog (ADR-009), scoped
  // to the authenticated client when the client gate is mounted; the
  // completion endpoints resolve body.model as an alias against the routing
  // table and enforce the per-client ACL. The catalog handler folds the
  // metadata store's current slice into its entries when a store is wired
  // (specs/domains/routing.md "Alias metadata") — never an upstream contact.
  // With the runtime store wired, the CRUD mounts below close over this
  // hoisted const (narrowing into closures needs a const binding).
  const runtimeStore = options.configStore;
  const aliasMetadata =
    options.metadataStore === undefined
      ? undefined
      : {
          // With the runtime store wired, fold the store's *current* models
          // block per request (ADR-014: a models mutation is visible in the
          // catalog's metadata projection immediately); otherwise the
          // startup snapshot — there is nothing to rebuild against.
          models: runtimeStore !== undefined ? () => runtimeStore.config.models ?? [] : options.models ?? [],
          store: options.metadataStore,
        };
  app.get(
    "/llm/v1/models",
    handleModels(routing, logger, aliasMetadata),
  );
  // The completions handlers read their bodies under the configured cap
  // (`server.maxRequestBodyBytes` — flows in through the redacted view, as
  // the auth gate's login cap does above).
  app.post(
    "/llm/v1/chat/completions",
    handleChatCompletions(routing, logger, configuration.server.maxRequestBodyBytes),
  );
  app.post(
    "/llm/v1/completions",
    handleCompletions(routing, logger, configuration.server.maxRequestBodyBytes),
  );

  // [4b] Management surface (ADR-005, specs/contracts/gateway-management.md)
  // — gateway observation for the SPA, operators, and scripts. Mounted with
  // the API routes, before static serving: the SPA mount can never shadow an
  // /api route. GET /api/status is the always-200 health probe — the SPA's
  // mount probe reads its `authenticated` bit; every deeper fact (probe
  // outcomes, the route inventory) is a startup log line, not HTTP body
  // material. GET /api/upstreams/:id/models (ADR-011) is the boundary's
  // operator-triggered live upstream contact: the listing invokes
  // listModels() on the named upstream within the probe budget and answers
  // the catalog, or the 404 / 502 envelope otherwise.
  app.get(
    "/api/status",
    handleStatus(authConfig?.enabled === true),
  );
  app.get(
    "/api/upstreams/:id/models",
    handleUpstreamModels(registry, logger),
  );
  // The management CRUD handlers' metadata slices (the upstream handlers
  // seed/clear the per-upstream slice; the alias reads fold it into `meta`)
  // share the option's store. No options store (tests) → one private empty
  // store: they mutate nothing observable, exactly the option's documented
  // fallback behavior.
  const discoveryStore = options.metadataStore ?? new MetadataStore();

  // [4d] Management CRUD (ADR-014) — the runtime write half of the
  // boundary, mounted as one block after the observation mounts ([4b]),
  // before static serving: the SPA mount can never shadow an /api route.
  // Mounted only when the runtime configuration store is wired (production
  // always wires it; the option's absence keeps the pre-ADR-014 surface).
  // Every mutation is the store's validate → persist → apply (the config
  // file stays the single source of truth, ADR-014 D1) followed by the
  // runtime hot-apply: construct through the registry's retained factory
  // map, probe within the startup probe budget (a failed probe is data in
  // the response, never a cancellation — D8), swap the instance into the
  // registry, and seed/clear the upstream's metadata slice. The upstream
  // routes hot-apply to `/llm/v1` without a restart: the balancer resolves
  // upstream instances through the registry at selection time. Responses
  // carry the store's redacted view only — masks, never credential values
  // (D7).
  if (options.configStore !== undefined) {
    const upstreamApi = upstreamManagementHandlers({
      store: options.configStore,
      registry,
      metadata: discoveryStore,
      logger,
      maxBodyBytes: configuration.server.maxRequestBodyBytes,
      ...(options.probeBudgetMs !== undefined ? { probeBudgetMs: options.probeBudgetMs } : {}),
    });
    app.get("/api/upstreams", upstreamApi.list);
    app.post("/api/upstreams", upstreamApi.create);
    app.get("/api/upstreams/:id", upstreamApi.get);
    app.put("/api/upstreams/:id", upstreamApi.update);
    app.delete("/api/upstreams/:id", upstreamApi.remove);
    app.post("/api/upstreams/:id/discover", upstreamApi.discover);
  }

  // [4e] Management CRUD — the models collection (ADR-014): the runtime
  // write half over the ADR-009 alias entries, mounted as one block after
  // the upstream CRUD, before static serving (the SPA mount can never shadow
  // an /api route), under the same config-store condition as [4d]. Every
  // mutation is the store's validate → persist → apply (D1: the alias
  // grammar, uniqueness, the route upstream cross-reference, the
  // strategy/weight consistency and the limits rules are all the store's)
  // followed by the routing-table rebuild: a fresh createRoutingTable over
  // the freshly persisted block, atomically swapped into the stable table
  // object the /llm/v1 handlers hold — the catalog and the dispatch see the
  // new/changed/deleted alias on their very next request, in-flight
  // requests complete against the build that dispatched them. DELETE
  // refuses an alias any client's `models` still names with the `409`
  // `resource_in_use` envelope (D6) and the block's last entry with the
  // store's 400. Reads carry the redacted view plus the `meta` aggregate
  // over the metadata store's current slice — no upstream contact.
  if (runtimeStore !== undefined) {
    const modelsApi = modelAliasManagementHandlers({
      store: runtimeStore,
      routing: routingRef,
      metadata: discoveryStore,
      logger,
      maxBodyBytes: configuration.server.maxRequestBodyBytes,
    });
    app.get("/api/models", modelsApi.list);
    app.post("/api/models", modelsApi.create);
    app.get("/api/models/:alias", modelsApi.get);
    app.put("/api/models/:alias", modelsApi.update);
    app.delete("/api/models/:alias", modelsApi.remove);
  }

  // [4f] Management CRUD — the clients collection (ADR-014): the runtime
  // write half over the ADR-008 client entries, mounted as one block after
  // the models CRUD, before static serving (the SPA mount can never shadow
  // an /api route), under the same config-store condition as [4d]/[4e].
  // Every mutation is the store's validate → persist → apply (D1: the name
  // grammar and uniqueness, the non-empty apiKey with the mask literal
  // rejected (D7), the models cross-reference into the alias table — all
  // the store's) followed by the gate hot-apply: the [1c] gate's digest
  // registry is rebuilt from the store's current clients, so the next
  // /llm/v1 request already sees it — a new key admits, a changed ACL cuts,
  // a removed key answers invalid_api_key, no restart (D2). DELETE needs no
  // resource_in_use class: no configuration entry references a client (the
  // reverse direction — a model alias a client's ACL names — is the models
  // surface's own delete guard); the store's one refusal is the block's
  // last-entry rule, answered 400. Reads carry the redacted view — masks,
  // never credential values (D7). The gate is defined whenever this block
  // is (the [1c] mounting condition implies it): reaching the contrary is a
  // wiring bug and fails loudly.
  if (runtimeStore !== undefined) {
    if (clientAuthGate === undefined) {
      throw new Error("the client auth gate must be mounted whenever the config store is wired — wiring bug");
    }
    const clientsApi = clientManagementHandlers({
      store: runtimeStore,
      gate: clientAuthGate,
      logger,
      maxBodyBytes: configuration.server.maxRequestBodyBytes,
    });
    app.get("/api/clients", clientsApi.list);
    app.post("/api/clients", clientsApi.create);
    app.get("/api/clients/:name", clientsApi.get);
    app.put("/api/clients/:name", clientsApi.update);
    app.delete("/api/clients/:name", clientsApi.remove);
  }

  // [4c] Docs namespace — the documenting surface, mounted after the routes
  // it documents. GET /docs/openapi.json serves the OpenAPI 3.1 document
  // generated at BUILD time: `bun run apidocs` (generate-openapi.ts)
  // compiles it from the OPENAPI_ROUTES / ROUTE_DESCRIPTIONS tables of the
  // build-only openapi.ts into dist/openapi.json, and this mount reads the
  // artifact per request — exactly the SPA index.html pattern (no caching
  // layer in the MVP). The server never generates: a missing (or corrupt)
  // artifact answers the envelope 404 with the regenerate hint. GET /docs
  // serves the Swagger UI shell (docs-shell.ts — the only docs module the
  // runtime imports; pinned unpkg assets loaded by the operator's browser)
  // pointed at that document. The namespace is deliberately outside every
  // gate prefix — the auth stage passes it through untouched (SECURITY.md
  // surface statement: no-gate rationale — static protocol metadata, no
  // credential or configuration material; same class as /ui, ADR-005).
  // Nothing else is mounted under /docs, so unknown /docs/* paths fall
  // through to the envelope 404 below.
  app.get("/docs/openapi.json", async (c) => {
    try {
      const artifact = await readFile(openApiDocPath, "utf8");
      return c.json(JSON.parse(artifact) as Record<string, unknown>);
    } catch {
      return notFoundResponse(
        "The OpenAPI document is not generated yet — run `bun run apidocs` to write dist/openapi.json.",
      );
    }
  });
  app.get("/docs", (c) => c.html(SWAGGER_UI_HTML));

  // [5] UI namespace (ADR-005) — one top-level prefix per surface; the
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
    // deep links are real URLs resolved client-side (ADR-005). index.html
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
