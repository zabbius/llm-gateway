# AGENTS.md

llm-gateway is an OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway resolves each request's `model` against its alias table (config `models`: an alias → load-balanced routes of upstream/model pairs, ADR-009), forwards it to the selected upstream with the model rewritten to the route's provider-native name, and streams the answer back. One gateway fronts many LLM providers behind a single fixed client surface.

- **Stack (MVP):** TypeScript on Bun, Hono as the HTTP framework, JSON configuration, pino logging to stderr.
- **Status:** MVP implemented — OpenAI surface `GET /llm/v1/models` (serves the gateway's alias catalog, scoped to the authenticated client), `POST /llm/v1/chat/completions`, `POST /llm/v1/completions` (alias routing with round-robin/weighted-round-robin balancing, health-based failover and session affinity — ADR-009/011), the `openai-compatible` upstream (optional `tlsFingerprint` SPKI pinning; optional per-upstream outbound `proxy` — `http://` through Bun's `fetch`, `socks5://` through a loopback HTTP→SOCKS5 bridge; a proxy failure is `502 upstream_proxy_error` — ADR-017), SSE passthrough, management API — the session-gated `GET /api/status` probe, the runtime CRUD over `/api/upstreams`, `/api/models`, `/api/clients` (validate → persist `config.json` → hot-apply without a restart, masked reads, `409 resource_in_use` on referenced deletes — ADR-014), the operator-triggered live listing `GET /api/upstreams/:id/models` with its `discover=1` metadata-slice swap (ADR-011 as amended by ADR-016), the `/docs` surface (build-time OpenAPI document + Swagger UI shell — ADR-013), SPA shell with a left dock menu (`web/dist` served at `/ui/*`, `/` redirects to `/ui` — namespace scheme in `specs/decisions/005-gateway-surface-namespace.md`), graceful shutdown (`registry.dispose()` before the listener stops — a `socks5://` bridge ends with its upstream). Gateway auth is implemented in two stages (ADR-007/009): a cookie-session gate on `/api/*` when the `auth` block is enabled (adds `POST /api/login`, `POST /api/logout`) and a per-client Bearer gate on `/llm/v1/*` when a non-empty `clients` block is configured; with neither credential class configured the auth stage stays a no-op placeholder. The listener binds loopback by default (`127.0.0.1:8080`). The specs under `specs/` are design contracts: their source paths are verified against the code, and any code↔spec drift is fixed in the same change that caused it.

## Specifications

Detailed system specs live in `specs/`. Before making structural changes, read the relevant spec; after a structural change, update the affected specs in the same change:

- Start with `specs/INDEX.md` to find the right document for your task.
- `specs/META.md` defines spec formats and update rules.

## Code map

- `src/index.ts` — process entry; the only place that wires config → upstreams → registry → app → listener. Concrete upstream classes appear only in its `UPSTREAM_FACTORIES` map; a new upstream module adds one entry there plus its `type` in `src/config/schema.ts`.
- `src/types.ts` — shared vocabulary (`LogLevel`, …).
- `src/config/` — `schema.ts` owns all config validation and normalization (strict keys, every problem collected); `load.ts` resolves the path (`LLM_GATEWAY_CONFIG` env var, else `./config.json`), reads the file, and reports every problem one-per-line to stderr, exit 1 before any port is bound; `store.ts` (the runtime configuration store — every management mutation validates with the startup grammar, writes `config.json` back via a sibling temp file plus atomic rename, then hot-applies into the registry, routing table, client gate, and metadata store, ADR-014 D1/D2); `redact.ts` builds the credential-free config view (credentials masked as `[Configured]`) handed to the HTTP layer for the management reads.
- `src/logging/` — pino → stderr (JSON lines) with credential redaction at every level; components log through child loggers.
- `src/upstreams/` — `upstream.ts` (the Upstream contract), `registry.ts` (exact id → upstream, sequential startup probes whose failures warn but never abort — outcomes are retained for the startup route crosscheck and the log lines; the CRUD's runtime add/replace/remove writes here, ADR-014 D2/D8; `dispose()` releases every instance at shutdown), `openai-compatible.ts` (pure proxy: header whitelist, SSE chunk-by-chunk passthrough, fixed timeouts, 502/504 synthesis, no retries; resolves a configured `proxy` lazily and maps its failures to `upstream_proxy_error`), `tls-pinning.ts` (SPKI pin primitive — the pin check runs over a direct socket or a proxy's CONNECT tunnel alike), `proxy.ts` (the outbound-proxy transport primitives, ADR-017: `parseProxyUrl` defensive re-parse, `resolveProxyTransport` — `http:` as-is, `socks5:` through a bridge — `openConnectTunnel` for the pinned path, `UpstreamProxyError`, `PROXY_DIAL_TIMEOUT_MS`), `socks-bridge.ts` (the per-upstream loopback-only HTTP→SOCKS5 bridge behind a `socks5://` proxy — `Bun.listen` on `127.0.0.1:0`, RFC 1928 no-auth, a marked `502` on a failed dial, stopped by the upstream's `dispose()`).
- `src/gateway/` — `router.ts` (the alias routing table — ADR-009: config `models` alias → routes, built at startup over the upstream registry, rebuildably swapped by a models mutation), `balancer.ts` (route selection per `balance.strategy`, in-memory route health with failover, session affinity — ADR-010), `crosscheck.ts` (startup route inventory: every configured route compared against the retained probe catalogs — warns, never aborts), `metastore.ts` (the alias-metadata store — retain-last-good per-upstream slices, seeded once at startup), `modelmetadata.ts` (the c0wrk detector port: first-wins shape matching over raw `/models` entries).
- `src/httpapi/` — `app.ts` (middleware chain — the auth stage runs first — routes, `/ui` SPA serving with root redirect; stage [4c] serves the docs surface: `GET /docs/openapi.json` reads the build-time artifact, `GET /docs` the Swagger UI shell), `auth.ts` (ADR-007 cookie-session gate for `/api/*`, with `POST /api/login`/`POST /api/logout`), `client-auth.ts` (ADR-008 per-client Bearer gate for `/llm/v1/*` with the per-client alias ACL), `body.ts` (the JSON body reader — the configured `server.maxRequestBodyBytes` cap, default 4 MiB, answered 413 before parse), `errors.ts` (the single OpenAI-envelope error mapper), `openapi.ts` (the wire-contract description module — zod schemas, `describeRoute` configs, the `OPENAPI_ROUTES` table; build-time only: the gateway never imports it, `hono-openapi`/`zod` are devDependencies, ADR-013), `generate-openapi.ts` (the `bun run apidocs` generator: compiles `dist/openapi.json` from the description tables, no handler executes), `docs-shell.ts` (the `SWAGGER_UI_HTML` constant — the one docs module the runtime imports, dependency-free by design), `handlers/` (alias-catalog `GET /llm/v1/models`; completions dispatch — alias resolution, ACL enforcement, balancing/failover, the model rewrite; `/api/status`; the runtime CRUD — `upstreams.ts`, `models.ts`, `model-aliases.ts`, `clients.ts`; the live listing `upstream-models.ts` (`GET /api/upstreams/:id/models?discover=1` — the live listing and the metadata-slice swap in one call, ADR-011 as amended by ADR-016)).
- `web/` — a separate React 19 + Vite package (Bootstrap 5 styled through the `react-bootstrap` component layer, ADR-015); `bun run build` emits `web/dist`, which the gateway serves at `/ui/*` when it exists (`/` redirects to `/ui`).

Dependencies point downward (`httpapi` → `gateway`/`upstreams` → `config`/`logging`) — never upward, never sideways. Full rules: `specs/architecture/layers.md`.

## Commands

- `bun run typecheck` — `tsc --noEmit` (strict); keep it clean.
- `bun test` — unit + e2e tests (`*.test.ts` next to the sources, `src/index.test.ts` for the e2e smoke); add tests for behavior changes.
- `bun run dev` / `bun run start` — run the gateway with watch / without.
- `bun run apidocs` — regenerate the OpenAPI document (`dist/openapi.json`, served at `/docs/openapi.json`) after any API change; `bun run build` runs it (ADR-013, specs/domains/api-docs.md).
- Frontend: `cd web && bun install && bun run build`.

## Invariants worth remembering

- All upstream request/response handling lives in upstreams; the HTTP surface never mutates bodies except the model rewrite (the requested alias resolved to the selected route's provider-native model).
- Every gateway-generated failure uses the OpenAI error envelope (`src/httpapi/errors.ts` is the single mapper); upstream 4xx/5xx bodies pass through untouched.
- A configured `proxy` is a credential-free egress hop (ADR-017): its URL never carries userinfo, no `Proxy-Authorization` is ever sent, the `socks5://` bridge binds `127.0.0.1` only, the pin decision precedes any request byte through the tunnel, and a proxy failure is `502 upstream_proxy_error` — never a relayed response.
- Secrets (`apiKey`, `Authorization`, …) never reach logs or error lines — redaction is in `src/logging/logger.ts`; keep new logged fields on the safe side of it.
- New behavior gets a spec check first: if a contract in `specs/` constrains it, follow the contract or update it deliberately in the same change.

## Security Policy

This project maintains a security policy in [SECURITY.md](./SECURITY.md).
All AI coding agents MUST read and follow SECURITY.md before making changes.
It contains:

- Threat model and trust boundaries (assets, actors, attack surface)
- Secure coding guidelines specific to this project's stack (TypeScript/Bun/Hono/React)
- Hard constraints and forbidden patterns for AI agents
- Vulnerability reporting procedures (GitHub Security Advisories)
- Credential-handling rules: the two-place storage rule, redaction, the auth stage, TLS pinning, and the credential-free outbound proxy

Any code contribution that violates the rules in SECURITY.md will be rejected.
