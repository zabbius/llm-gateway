# Architecture: Layers

## Context

llm-gateway is an OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each request to the provider upstream selected by the model-id prefix, streaming the answer back. The value of the design is in the seams — HTTP handling, routing, and provider specifics must stay decoupled, because upstreams are added over time while the client-facing HTTP surface stays fixed. This document fixes the layer hierarchy, the dependency direction, and each layer's responsibility, so a new upstream or a new route never requires reworking the core.

Stack on MVP: TypeScript on Bun, Hono as the HTTP framework, JSON configuration.

## Layer Hierarchy

| Layer | Location | Responsibility |
| ----- | ---------------- | -------------- |
| entry point | `src/index.ts` | reads config, constructs upstreams, wires the registry, builds the app, starts the listener |
| Hono app | `src/httpapi/app.ts` | HTTP concerns only: middleware (request logging, error mapping), route mounting |
| gateway router | `src/gateway/router.ts` | OpenAI-protocol endpoints: aggregates `GET /llm/v1/models`, dispatches `POST /llm/v1/chat/completions` by upstream-id prefix |
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
| HTTP layer (Hono app): src/httpapi/app.ts                          |
| middleware (request logging, error mapping), route mounting        |
+----------------------------------+---------------------------------+
                                   | delegates matched requests
                                   v
+--------------------------------------------------------------------+
| gateway core: src/gateway/router.ts                                |
| GET /llm/v1/models aggregation, POST /llm/v1/chat/completions dispatch |
+----------------------------------+---------------------------------+
                                   | looks up by upstream id
                                   v
+--------------------------------------------------------------------+
| upstream registry: src/upstreams/registry.ts                       |
| upstream id -> instance; populated at startup, read-only after     |
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
| MVP: openai-compatible upstream (src/upstreams/openai-compatible.ts)|
+--------------------------------------------------------------------+
```

## Invariants

Import rules (the dependency contract of the gateway):

1. Dependencies point strictly downward: entry point → Hono app → gateway core → upstreams. A layer imports only layers below it plus cross-cutting modules; upward imports and import cycles never occur.
2. Only the entry point reads the config file and names concrete upstream classes. Every other layer receives already-constructed instances or interfaces; concrete upstream imports live in exactly one place — the startup wiring in `src/index.ts`.
3. The Hono app (`src/httpapi/app.ts`) imports the gateway core only; it never imports the registry or any upstream.
4. The gateway core and the registry reference upstreams exclusively through the upstream interface (`src/upstreams/upstream.ts`); a concrete upstream name never appears in core code.
5. Upstreams import only the upstream interface and cross-cutting modules (shared types, logging); they never import the HTTP layer, the router, the registry, or the config loader.
6. The upstream interface sits at the bottom of the graph: it imports only shared types, and both the core and the upstreams depend on it.
7. Cross-cutting modules (`src/types.ts`, `src/logging/logger.ts`) are imported by any layer and import no project module except shared types.

Structural invariants:

- The process has exactly one entry point; all wiring happens there.
- The registry is the only holder of upstream instances; it is written exclusively during startup and read without mutation at request time.
- The Hono app is the only place that maps errors to HTTP status codes.
- The upstream interface is the only upstream shape visible outside `src/upstreams/`.

## Anti-Patterns

- Importing a concrete upstream inside the router or registry code to "call one provider quickly" — every upstream call goes through the interface and every lookup goes through the registry; a hardcoded upstream breaks prefix routing.
- Passing the whole config object down into the router or upstreams — each component receives only its own slice (its upstream entry, its log level); global config knowledge couples every layer to the config schema.
- Putting provider-specific fixups (header renames, body massaging, credential header format) into the router — the router stays provider-agnostic; dialects live in upstreams.
- Mounting provider-specific routes directly on the Hono app (`app.route("/acme", ...)`) — clients keep a single OpenAI surface; provider selection happens only via the model-id prefix.
- Upstreams importing Hono types or client-facing helpers — upstreams face the provider, not the client.
- Making decisions in the entry point beyond wiring (choosing an upstream per request, rewriting model lists) — the entry point constructs and starts; it does not serve requests.
- A registry mutated at request time (upstreams registered lazily per request) — upstreams exist from startup on.
