# Architecture: Layers

## Context

llm-gateway is an OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each request to the provider upstream selected by the model alias, streaming the answer back. The value of the design is in the seams — HTTP handling, routing, and provider specifics must stay decoupled, because upstreams are added over time while the client-facing HTTP surface stays fixed. This document fixes the layer hierarchy, the dependency direction, and each layer's responsibility, so a new upstream or a new route never requires reworking the core.

Stack on MVP: TypeScript on Bun, Hono as the HTTP framework, JSON configuration.

## Layer Hierarchy

| Layer | Location | Responsibility |
| ----- | ---------------- | -------------- |
| entry point | `src/index.ts` | reads config, constructs upstreams, wires the registry, builds the app, starts the listener |
| Hono app | `src/httpapi/*` | HTTP concerns only: middleware (request logging, error mapping), route mounting, route handlers (`handlers/`: models catalog, completions dispatch, management endpoints), the `/docs` documentation surface ([ADR-013](../decisions/013-openapi-docs-surface.md): the build-time description module `openapi.ts` + generator `generate-openapi.ts`, the runtime-served dep-free shell `docs-shell.ts` and the static artifact mount) |
| gateway router | `src/gateway/router.ts` | alias-table routing ([ADR-009](../decisions/009-alias-table-routing.md)): resolves a model alias to the entry's usable routes, balance- and health-selected through the route balancer; a null resolution leaves the 404 decision to the HTTP layer |
| route balancer | `src/gateway/balancer.ts` | per-alias route selection (round-robin / weighted round-robin) and in-memory per-route health with failover ([load-balancing.md](../domains/load-balancing.md)); wrapped by the routing table, never contacts an upstream itself |
| upstream registry | `src/upstreams/registry.ts` | holds upstream instances keyed by upstream id; exact-match lookup; populated once at startup |
| upstreams | `src/upstreams/*` | speak one provider dialect each; the openai-compatible upstream is a pure pass-through proxy |

Cross-cutting modules importable by every layer:

- shared protocol types: `src/types.ts`
- leveled logging (trace/debug/info/warning/error/none, stderr): `src/logging/logger.ts`

## Dependency Diagram

```
+--------------------------------------------------------------------+
| entry point: src/index.ts                                          |
| reads config, constructs upstreams, wires the registry,            |
| builds the Hono app, starts the listener                           |
+----------------------------------+---------------------------------+
                                   | constructs and wires
                                   v
+--------------------------------------------------------------------+
| HTTP layer (Hono app): src/httpapi                                 |
| middleware (request logging, error mapping), route mounting;       |
| route handlers: models catalog, completions dispatch               |
+----------------------------------+---------------------------------+
                                   | delegates matched requests
                                   v
+--------------------------------------------------------------------+
| gateway core: src/gateway/router.ts + balancer.ts                  |
| alias resolution: alias -> healthy balance-selected route ->       |
| upstream; pre-first-byte failure -> next eligible route            |
+----------------------------------+---------------------------------+
                                   | looks up by upstream id
                                   v
+--------------------------------------------------------------------+
| upstream registry: src/upstreams/registry.ts                       |
| upstream id -> instance; populated at startup, then written only   |
| by the management CRUD's hot-apply (add/replace/remove, ADR-014)   |
+--------------------------------------------------------------------+
                                   | hands out instances
                                   | (always as the interface)
                                   v
+--------------------------------------------------------------------+
| upstream interface: src/upstreams/upstream.ts                      |
| the only upstream shape the core and the registry see              |
+--------------------------------------------------------------------+
                                   | implemented by every upstream
                                   v
+--------------------------------------------------------------------+
| upstreams: src/upstreams/*                                         |
| one provider dialect per upstream                                  |
| MVP: openai-compatible (src/upstreams/openai-compatible.ts)        |
+--------------------------------------------------------------------+
```

## Invariants

Import rules (the dependency contract of the gateway):

Type-only imports (`import type`, type-only re-exports) carry shared vocabulary across layers with no runtime coupling; the numbered rules below govern runtime imports. The production type-only edges: HTTP-layer modules import registry and upstream vocabulary directly from `src/upstreams/*` and the redacted-view type from `src/config/redact.ts`; `src/upstreams/upstream.ts` re-exports `UpstreamConfig`/`UpstreamType` from `src/config/schema.ts`; the gateway core re-exports the `UpstreamRegistry` type for the `createApp` signature.

1. Dependencies point strictly downward: entry point → Hono app → gateway core → upstreams. A layer imports only layers below it plus cross-cutting modules; upward imports and import cycles never occur.
2. Only the entry point reads the config file and names concrete upstream classes. Every other layer receives already-constructed instances or interfaces; concrete upstream imports live in exactly one place — the startup wiring in `src/index.ts`.
3. At runtime the Hono app (`src/httpapi/app.ts`) imports the gateway core only — never the registry, an upstream, or the config loader; its registry and config references are the type-only vocabulary above (injected instances arrive from the entry point).
4. The gateway core and the registry reference upstreams exclusively through the upstream interface (`src/upstreams/upstream.ts`); a concrete upstream name never appears in core code.
5. Upstreams import only upstream-layer modules (the shared interface, sibling helpers such as `src/upstreams/tls-pinning.ts`) and cross-cutting modules (shared types, logging); their only config touch is the type-only vocabulary re-export above, and they never import the HTTP layer, the router, or the registry.
6. The upstream interface sits at the bottom of the graph: at runtime it imports only shared types (its config-vocabulary re-export is type-only), and both the core and the upstreams depend on it.
7. Cross-cutting modules (`src/types.ts`, `src/logging/logger.ts`) are imported by any layer and import no project module except shared types.

Structural invariants:

- The process has exactly one entry point; all wiring happens there.
- The registry is the only holder of upstream instances; it is written exclusively during startup and read without mutation at request time.
- The Hono app is the only place that maps errors to HTTP status codes.
- The upstream interface is the only upstream shape visible outside `src/upstreams/`.
- The wire-contract description module (`src/httpapi/openapi.ts`, the `/docs` surface — [ADR-013](../decisions/013-openapi-docs-surface.md)) is a **build-time** HTTP-layer module: the OpenAPI document is compiled from its `OPENAPI_ROUTES` / `ROUTE_DESCRIPTIONS` tables by `generate-openapi.ts` (`bun run apidocs`), the gateway never imports it, and `hono-openapi` + `zod` are devDependencies. The module imports only within the layer (plus its descriptive dependencies) — a wire description never depends on the modules whose behavior it documents (no `config/`, `gateway/`, or `upstreams/` import) — and it stays descriptive: it validates no request and mutates no response. The runtime's one docs module, `docs-shell.ts` (the Swagger UI shell constant), is dependency-free by design, and `app.ts` serves the generated `dist/openapi.json` statically.

## Anti-Patterns

- Importing a concrete upstream inside the router or registry code to "call one provider quickly" — every upstream call goes through the interface and every lookup goes through the registry; a hardcoded upstream breaks alias routing.
- Passing the whole config object down into the router or upstreams — each component receives only its own slice (its upstream entry, its log level); global config knowledge couples every layer to the config schema.
- Putting provider-specific fixups (header renames, body massaging, credential header format) into the router — the router stays provider-agnostic; dialects live in upstreams.
- Mounting provider-specific routes directly on the Hono app (`app.route("/acme", ...)`) — clients keep a single OpenAI surface; provider selection happens only via the model alias.
- Upstreams importing Hono types or client-facing helpers — upstreams face the provider, not the client.
- Making decisions in the entry point beyond wiring (choosing an upstream per request, rewriting model lists) — the entry point constructs and starts; it does not serve requests.
- A registry mutated at request time (upstreams registered lazily per request) — upstreams exist from startup on.
