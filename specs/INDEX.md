# INDEX

Navigation for the specification system. One glance to find the right document for a task; formats and update rules live in [META.md](./META.md).

## Task → Spec

| Task | Read first | Also relevant |
| ---- | ---------- | ------------- |
| Start working on the project (understand the system) | [architecture/layers.md](./architecture/layers.md), [architecture/data-flow.md](./architecture/data-flow.md) | [META.md](./META.md), this INDEX |
| Add an adapter for a NEW provider type | [domains/adapters/README.md](./domains/adapters/README.md), [domains/adapters/adapter-contract.md](./domains/adapters/adapter-contract.md) | [contracts/gateway-upstream.md](./contracts/gateway-upstream.md), [decisions/001-adapter-per-provider-type.md](./decisions/001-adapter-per-provider-type.md), [decisions/002-model-id-prefix-routing.md](./decisions/002-model-id-prefix-routing.md), [domains/configuration.md](./domains/configuration.md) |
| Add a connection of an EXISTING type (e.g. another OpenAI-compatible provider) | [domains/adapters/openai-compatible.md](./domains/adapters/openai-compatible.md) | [domains/configuration.md](./domains/configuration.md), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) |
| Change the routing scheme (model-id prefix, dispatch) | [domains/routing.md](./domains/routing.md), [decisions/002-model-id-prefix-routing.md](./decisions/002-model-id-prefix-routing.md) | [contracts/client-gateway.md](./contracts/client-gateway.md), [architecture/data-flow.md](./architecture/data-flow.md) |
| Change the client-facing OpenAI surface (endpoints, error envelope, model list shape) | [contracts/client-gateway.md](./contracts/client-gateway.md) | [domains/routing.md](./domains/routing.md), [architecture/data-flow.md](./architecture/data-flow.md) |
| Change upstream interaction (paths, headers, timeouts, retries) | [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) | [domains/adapters/adapter-contract.md](./domains/adapters/adapter-contract.md), [domains/adapters/openai-compatible.md](./domains/adapters/openai-compatible.md) |
| Change the config file schema (add a field, new adapter type fields) | [domains/configuration.md](./domains/configuration.md) | [config.example.json](../config.example.json) (keep in sync — enforced by test), [architecture/data-flow.md](./architecture/data-flow.md) (startup), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (adapter entries) |
| Change log levels or logging behavior | [domains/observability.md](./domains/observability.md), [decisions/004-pino-stderr-logging.md](./decisions/004-pino-stderr-logging.md) | [domains/configuration.md](./domains/configuration.md) (`logLevel`) |
| Change the startup / wiring sequence | [architecture/data-flow.md](./architecture/data-flow.md), [architecture/layers.md](./architecture/layers.md) | [domains/configuration.md](./domains/configuration.md) |
| Touch credentials, key handling, or log redaction | [architecture/security-model.md](./architecture/security-model.md) | [domains/observability.md](./domains/observability.md), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (Authorization policy) |
| Work on the frontend (SPA stub) | [domains/frontend.md](./domains/frontend.md) | — |
| Decide whether a change needs an ADR, or record one | [META.md](./META.md) (Update Protocol → ADR bar) | [decisions/_template.md](./decisions/_template.md), existing ADRs in `decisions/` |
| Create or restructure a spec document | [META.md](./META.md) (formats, Greenfield Rule) | this INDEX (keep the listing current) |

## Layer Dependency Graph

Condensed from [architecture/layers.md](./architecture/layers.md) — the authoritative diagram with planned source paths. Dependencies point strictly downward; no layer imports upward, and no import cycles exist.

```
+------------------------------------------------------------------+
| entry point                                                      |
| reads config, constructs adapters, wires the registry,           |
| builds the app, starts the listener                              |
+--------------------------------+---------------------------------+
                                 | constructs and wires
                                 v
+------------------------------------------------------------------+
| HTTP layer (Hono app)                                            |
| middleware (request logging, error mapping), route mounting      |
+--------------------------------+---------------------------------+
                                 | delegates matched requests
                                 v
+------------------------------------------------------------------+
| gateway core                                                     |
| OpenAI endpoints: /v1/models aggregation,                        |
| completions dispatch by adapter-id prefix                        |
+--------------------------------+---------------------------------+
                                 | looks up by adapter id
                                 v
+------------------------------------------------------------------+
| adapter registry                                                 |
| adapter id -> instance; populated at startup, read-only after    |
+--------------------------------+---------------------------------+
                                 | hands out instances
                                 | (always as the interface)
                                 v
+------------------------------------------------------------------+
| adapter interface                                                |
| the only adapter shape the core and the registry see             |
+--------------------------------+---------------------------------+
                                 | implemented by every adapter
                                 v
+------------------------------------------------------------------+
| adapters                                                         |
| one upstream provider dialect per adapter;                       |
| MVP: openai-compatible (pure pass-through proxy)                 |
+------------------------------------------------------------------+

Cross-cutting (importable by every layer, import nothing but shared types):
shared protocol types, leveled logging (pino to stderr).
```

Related cross-layer boundaries: [contracts/client-gateway.md](./contracts/client-gateway.md) (client ↔ gateway) and [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (gateway ↔ provider upstream).

## File Listing

```
specs/
├── META.md                                      spec formats and update rules
├── INDEX.md                                     this file
│
├── architecture/
│   ├── layers.md                                layer hierarchy, import rules, responsibilities
│   ├── data-flow.md                             startup and per-request lifecycle, failure exits
│   └── security-model.md                        trust boundaries, key storage, log redaction
│
├── domains/
│   ├── adapters/
│   │   ├── README.md                            provider adapter domain overview
│   │   ├── adapter-contract.md                  the Adapter interface, connect → serve lifecycle
│   │   └── openai-compatible.md                 MVP adapter: pure proxy to an OpenAI-compatible upstream
│   ├── routing.md                               prefix routing, model aggregation, dispatch
│   ├── configuration.md                         config file location, JSON schema, startup validation
│   ├── observability.md                         leveled pino logging to stderr
│   └── frontend.md                              SPA stub (React + Bootstrap), reserved page names
│
├── contracts/
│   ├── client-gateway.md                        HTTP client <-> gateway (OpenAI protocol)
│   └── gateway-upstream.md                      provider adapters <-> upstream provider APIs
│
└── decisions/
    ├── _template.md                             ADR template
    ├── 001-adapter-per-provider-type.md         adapter per provider connection, common interface
    ├── 002-model-id-prefix-routing.md           public model id = {adapterId}/{model}
    ├── 003-hono-http-framework.md               Hono on Bun, edge-only handlers
    └── 004-pino-stderr-logging.md               pino, JSON lines to stderr, no file logger
```

All 16 spec files (3 architecture + 7 domain + 2 contracts + 4 ADRs) are listed above, alongside META.md, this INDEX, and the ADR template. After adding or removing a spec file, update this listing — see [META.md](./META.md), Update Protocol.
