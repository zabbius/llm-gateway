# Architecture: Layers

## Context

llm-gateway is an OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each request to the provider adapter selected by the model-id prefix, streaming the answer back. The value of the design is in the seams — HTTP handling, routing, and provider specifics must stay decoupled, because adapters are added over time while the client-facing HTTP surface stays fixed. This document fixes the layer hierarchy, the dependency direction, and each layer's responsibility, so a new adapter or a new route never requires reworking the core.

Stack on MVP: TypeScript on Bun, Hono as the HTTP framework, JSON configuration.

## Layer Hierarchy

| Layer | Location | Responsibility |
| ----- | ---------------- | -------------- |
| entry point | `src/index.ts` | reads config, constructs adapters, wires the registry, builds the app, starts the listener |
| Hono app | `src/httpapi/app.ts` | HTTP concerns only: middleware (request logging, error mapping), route mounting |
| gateway router | `src/gateway/router.ts` | OpenAI-protocol endpoints: aggregates `GET /v1/models`, dispatches `POST /v1/chat/completions` by adapter-id prefix |
| adapter registry | `src/adapters/registry.ts` | holds adapter instances keyed by adapter id; exact-match lookup; populated once at startup |
| adapters | `src/adapters/*` | speak one upstream provider dialect each; the openai-compatible adapter is a pure pass-through proxy |

Cross-cutting modules importable by every layer:

- shared protocol types: `src/types.ts`
- leveled logging (trace/debug/info/warning/error/none, stderr): `src/logging/logger.ts`

## Dependency Diagram

```
+--------------------------------------------------------------------+
| entry point: src/index.ts                                          |
| reads config, constructs adapters, wires the registry,             |
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
| GET /v1/models aggregation, POST /v1/chat/completions dispatch     |
+----------------------------------+---------------------------------+
                                   | looks up by adapter id
                                   v
+--------------------------------------------------------------------+
| adapter registry: src/adapters/registry.ts                         |
| adapter id -> instance; populated at startup, read-only after      |
+--------------------------------------------------------------------+
                                   | hands out instances
                                   | (always as the interface)
                                   v
+--------------------------------------------------------------------+
| adapter interface: src/adapters/adapter.ts                         |
| the only adapter shape the core and the registry see               |
+----------------------------------+---------------------------------+
                                   | implemented by every adapter
                                   v
+--------------------------------------------------------------------+
| adapters: src/adapters/*                                           |
| one upstream provider dialect per adapter                          |
| MVP: openai-compatible adapter (src/adapters/openai-compatible.ts) |
+--------------------------------------------------------------------+
```

## Invariants

Import rules (the dependency contract of the gateway):

1. Dependencies point strictly downward: entry point → Hono app → gateway core → adapters. A layer imports only layers below it plus cross-cutting modules; upward imports and import cycles never occur.
2. Only the entry point reads the config file and names concrete adapter classes. Every other layer receives already-constructed instances or interfaces; concrete adapter imports live in exactly one place — the startup wiring in `src/index.ts`.
3. The Hono app (`src/httpapi/app.ts`) imports the gateway core only; it never imports the registry or any adapter.
4. The gateway core and the registry reference adapters exclusively through the adapter interface (`src/adapters/adapter.ts`); a concrete adapter name never appears in core code.
5. Adapters import only the adapter interface and cross-cutting modules (shared types, logging); they never import the HTTP layer, the router, the registry, or the config loader.
6. The adapter interface sits at the bottom of the graph: it imports only shared types, and both the core and the adapters depend on it.
7. Cross-cutting modules (`src/types.ts`, `src/logging/logger.ts`) are imported by any layer and import no project module except shared types.

Structural invariants:

- The process has exactly one entry point; all wiring happens there.
- The registry is the only holder of adapter instances; it is written exclusively during startup and read without mutation at request time.
- The Hono app is the only place that maps errors to HTTP status codes.
- The adapter interface is the only adapter shape visible outside `src/adapters/`.

## Anti-Patterns

- Importing a concrete adapter inside the router or registry code to "call one provider quickly" — every adapter call goes through the interface and every lookup goes through the registry; a hardcoded adapter breaks prefix routing.
- Passing the whole config object down into the router or adapters — each component receives only its own slice (its adapter entry, its log level); global config knowledge couples every layer to the config schema.
- Putting provider-specific fixups (header renames, body massaging, credential header format) into the router — the router stays provider-agnostic; dialects live in adapters.
- Mounting provider-specific routes directly on the Hono app (`app.route("/acme", ...)`) — clients keep a single OpenAI surface; provider selection happens only via the model-id prefix.
- Adapters importing Hono types or client-facing helpers — adapters face the upstream, not the client.
- Making decisions in the entry point beyond wiring (choosing an adapter per request, rewriting model lists) — the entry point constructs and starts; it does not serve requests.
- A registry mutated at request time (adapters registered lazily per request) — adapters exist from startup on.
