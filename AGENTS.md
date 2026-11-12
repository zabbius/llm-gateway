# AGENTS.md

llm-gateway is an OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each request to the upstream selected by the model-id prefix (`{upstreamId}/{model}`), streaming the answer back. One gateway fronts many LLM providers behind a single fixed client surface.

- **Stack (MVP):** TypeScript on Bun, Hono as the HTTP framework, JSON configuration, pino logging to stderr.
- **Status:** MVP implemented — prefix-routed `GET /llm/v1/models`, `POST /llm/v1/chat/completions`, `POST /llm/v1/completions`, the `openai-compatible` upstream, SSE passthrough, read-only management API (`/api/status`, `/api/configuration` with masked secrets), SPA shell with a left dock menu (`web/dist` served at `/ui/*`, `/` redirects to `/ui` — namespace scheme in `specs/decisions/006-gateway-surface-namespace.md`), graceful shutdown. Gateway auth is a documented no-op; the listener binds loopback by default. The specs under `specs/` are design contracts: their source paths are verified against the code, and any code↔spec drift is fixed in the same change that caused it.

## Specifications

Detailed system specs live in `specs/`. Before making structural changes, read the relevant spec; after a structural change, update the affected specs in the same change:

- Start with `specs/INDEX.md` to find the right document for your task.
- `specs/META.md` defines spec formats and update rules.

## Code map

- `src/index.ts` — process entry; the only place that wires config → upstreams → registry → app → listener. Concrete upstream classes appear only in its `UPSTREAM_FACTORIES` map; a new upstream module adds one entry there plus its `type` in `src/config/schema.ts`.
- `src/types.ts` — shared vocabulary (`LogLevel`, …).
- `src/config/` — `schema.ts` owns all config validation and normalization (strict keys, every problem collected); `load.ts` resolves the path (`LLM_GATEWAY_CONFIG` env var, else `./config.json`), reads the file, and reports every problem one-per-line to stderr, exit 1 before any port is bound; `redact.ts` builds the credential-free config view handed to the HTTP layer for `/api/configuration`.
- `src/logging/` — pino → stderr (JSON lines) with credential redaction at every level; components log through child loggers.
- `src/upstreams/` — `upstream.ts` (the Upstream contract), `registry.ts` (exact id → upstream, sequential startup probes whose failures warn but never abort — outcomes are retained for `/api/status`), `openai-compatible.ts` (pure proxy: header whitelist, SSE chunk-by-chunk passthrough, fixed timeouts, 502/504 synthesis, no retries).
- `src/gateway/router.ts` — model-id prefix routing (`{upstreamId}/{model}`).
- `src/httpapi/` — `app.ts` (middleware chain, routes, `/ui` SPA serving with root redirect), `errors.ts` (the single OpenAI-envelope error mapper), `handlers/` (models aggregation; unified completions dispatch; `/api/status`, `/api/configuration`).
- `web/` — a separate React 19 + Vite package; `bun run build` emits `web/dist`, which the gateway serves at `/ui/*` when it exists (`/` redirects to `/ui`).

Dependencies point downward (`httpapi` → `gateway`/`upstreams` → `config`/`logging`) — never upward, never sideways. Full rules: `specs/architecture/layers.md`.

## Commands

- `bun run typecheck` — `tsc --noEmit` (strict); keep it clean.
- `bun test` — unit + e2e tests (`*.test.ts` next to the sources, `src/index.test.ts` for the e2e smoke); add tests for behavior changes.
- `bun run dev` / `bun run start` — run the gateway with watch / without.
- Frontend: `cd web && bun install && bun run build`.

## Invariants worth remembering

- All upstream request/response handling lives in upstreams; the HTTP surface never mutates bodies except the model-id rewrite.
- Every gateway-generated failure uses the OpenAI error envelope (`src/httpapi/errors.ts` is the single mapper); upstream 4xx/5xx bodies pass through untouched.
- Secrets (`apiKey`, `Authorization`, …) never reach logs or error lines — redaction is in `src/logging/logger.ts`; keep new logged fields on the safe side of it.
- New behavior gets a spec check first: if a contract in `specs/` constrains it, follow the contract or update it deliberately in the same change.
