# INDEX

Navigation for the specification system. One glance to find the right document for a task; formats and update rules live in [META.md](./META.md).

## Task → Spec

| Task | Read first | Also relevant |
| ---- | ---------- | ------------- |
| Start working on the project (understand the system) | [architecture/layers.md](./architecture/layers.md), [architecture/data-flow.md](./architecture/data-flow.md) | [META.md](./META.md), this INDEX |
| Add an upstream for a NEW provider type | [domains/upstreams/README.md](./domains/upstreams/README.md), [domains/upstreams/upstream-contract.md](./domains/upstreams/upstream-contract.md) | [contracts/gateway-upstream.md](./contracts/gateway-upstream.md), [decisions/001-upstream-per-provider-type.md](./decisions/001-upstream-per-provider-type.md), [decisions/009-alias-table-routing.md](./decisions/009-alias-table-routing.md), [domains/configuration.md](./domains/configuration.md) |
| Add a connection of an EXISTING type (e.g. another OpenAI-compatible provider) | [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md) | [domains/configuration.md](./domains/configuration.md), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) |
| Pin a self-signed / internal-PKI upstream (TLS `tlsFingerprint`) | [decisions/004-per-upstream-tls-pinning.md](./decisions/004-per-upstream-tls-pinning.md) | [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md), [domains/configuration.md](./domains/configuration.md), `tools/tls-fingerprint.ts` |
| Change the routing scheme (model aliases, per-client ACL, dispatch) | [domains/routing.md](./domains/routing.md), [decisions/009-alias-table-routing.md](./decisions/009-alias-table-routing.md) | [contracts/client-gateway.md](./contracts/client-gateway.md), [architecture/data-flow.md](./architecture/data-flow.md), [domains/configuration.md](./domains/configuration.md) (`models` schema) |
| Change balancing, route health, or session affinity (strategies, weights, failover, cooldowns, 503 semantics, affinity keys/bindings) | [domains/load-balancing.md](./domains/load-balancing.md), [decisions/010-session-affinity.md](./decisions/010-session-affinity.md) | [domains/routing.md](./domains/routing.md), [architecture/data-flow.md](./architecture/data-flow.md), [contracts/client-gateway.md](./contracts/client-gateway.md) (the 503 envelope, the `X-Session-Id` header), [domains/configuration.md](./domains/configuration.md) (`balance` grammar) |
| Change the client-facing OpenAI surface (endpoints, error envelope, model list shape) | [contracts/client-gateway.md](./contracts/client-gateway.md) | [domains/routing.md](./domains/routing.md), [architecture/data-flow.md](./architecture/data-flow.md), [decisions/005-gateway-surface-namespace.md](./decisions/005-gateway-surface-namespace.md) (surface namespace) |
| Add or change a management endpoint (`/api/*`: the status probe, the runtime CRUD over upstreams/models/clients, the discover mount, the live model listing) | [contracts/gateway-management.md](./contracts/gateway-management.md) | [decisions/005-gateway-surface-namespace.md](./decisions/005-gateway-surface-namespace.md), [decisions/011-management-live-model-listing.md](./decisions/011-management-live-model-listing.md), [decisions/014-runtime-management-crud.md](./decisions/014-runtime-management-crud.md) (runtime CRUD, the mutation ADR), [architecture/data-flow.md](./architecture/data-flow.md) (the startup mount, the mutation lifecycle), [contracts/client-gateway.md](./contracts/client-gateway.md) (shared error envelope), [architecture/security-model.md](./architecture/security-model.md) (credential masking, the atomic persist) |
| Change the machine-readable API documentation (`/docs`: the OpenAPI document `GET /docs/openapi.json` served from the build-time artifact `dist/openapi.json`, the Swagger UI shell `GET /docs`, `bun run apidocs` + `src/httpapi/openapi.ts`) | [domains/api-docs.md](./domains/api-docs.md), [decisions/013-openapi-docs-surface.md](./decisions/013-openapi-docs-surface.md) | [contracts/client-gateway.md](./contracts/client-gateway.md), [contracts/gateway-management.md](./contracts/gateway-management.md) (the mirrored contracts), [decisions/005-gateway-surface-namespace.md](./decisions/005-gateway-surface-namespace.md) (namespace scheme), [architecture/layers.md](./architecture/layers.md) (httpapi ownership) |
| Work on alias model metadata (detectors, the discover mount, aggregation, `meta`) | [domains/model-metadata.md](./domains/model-metadata.md), [decisions/012-alias-model-metadata.md](./decisions/012-alias-model-metadata.md) | [domains/routing.md](./domains/routing.md) ("Alias metadata"), [contracts/gateway-management.md](./contracts/gateway-management.md) (the managed entries' `meta`, the discover mount, the CRUD probes), [contracts/client-gateway.md](./contracts/client-gateway.md) (catalog metadata fields), [domains/configuration.md](./domains/configuration.md) (`limits` schema), [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md) (two-leg probe) |
| Add or change gateway auth (login, sessions, password hashing, client Bearer keys) | [decisions/007-management-cookie-auth.md](./decisions/007-management-cookie-auth.md), [decisions/008-client-bearer-auth.md](./decisions/008-client-bearer-auth.md), [architecture/security-model.md](./architecture/security-model.md) | [contracts/gateway-management.md](./contracts/gateway-management.md) (session gate, auth actions), [contracts/client-gateway.md](./contracts/client-gateway.md) (client Bearer gate on `/llm/v1/*`), [domains/configuration.md](./domains/configuration.md) (`auth` + `clients` schema), [domains/frontend.md](./domains/frontend.md) (SPA login flow), `tools/hash-password.ts` |
| Change upstream interaction (paths, headers, timeouts, retries) | [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) | [domains/upstreams/upstream-contract.md](./domains/upstreams/upstream-contract.md), [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md) |
| Change the config file schema (add a field, new upstream type fields) | [domains/configuration.md](./domains/configuration.md) | [config.example.json](../config.example.json) (keep in sync — enforced by test), [architecture/data-flow.md](./architecture/data-flow.md) (startup), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (upstream entries) |
| Serve the gateway over TLS, or change listener options (address, TLS) | [decisions/006-tls-listener-server-block.md](./decisions/006-tls-listener-server-block.md) | [domains/configuration.md](./domains/configuration.md) (`server` schema), [architecture/data-flow.md](./architecture/data-flow.md) (PEM read before bind), [architecture/security-model.md](./architecture/security-model.md) (TLS ≠ authentication), `tools/generate-tls-cert.sh` |
| Change log levels or logging behavior | [domains/observability.md](./domains/observability.md), [decisions/003-pino-stderr-logging.md](./decisions/003-pino-stderr-logging.md) | [domains/configuration.md](./domains/configuration.md) (`logLevel`) |
| Change the startup / wiring sequence | [architecture/data-flow.md](./architecture/data-flow.md), [architecture/layers.md](./architecture/layers.md) | [domains/configuration.md](./domains/configuration.md) |
| Touch credentials, key handling, or log redaction | [architecture/security-model.md](./architecture/security-model.md) | [domains/observability.md](./domains/observability.md), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (Authorization policy) |
| Work on the frontend (SPA) | [domains/frontend.md](./domains/frontend.md) | [decisions/005-gateway-surface-namespace.md](./decisions/005-gateway-surface-namespace.md) (`/ui/*` mount, client-side routing), [decisions/015-adopt-react-bootstrap.md](./decisions/015-adopt-react-bootstrap.md) (the `react-bootstrap` component layer), [contracts/gateway-management.md](./contracts/gateway-management.md) (the management API the UI consumes) |
| Decide whether a change needs an ADR, or record one | [META.md](./META.md) (Update Protocol → ADR bar) | [decisions/_template.md](./decisions/_template.md), existing ADRs in `decisions/` |
| Create or restructure a spec document | [META.md](./META.md) (formats, update rules) | this INDEX (keep the listing current) |

## Layer Dependency Graph

Condensed from [architecture/layers.md](./architecture/layers.md) — the authoritative diagram with planned source paths. Dependencies point strictly downward; no layer imports upward, and no import cycles exist.

```
+------------------------------------------------------------------+
| entry point                                                      |
| reads config, constructs upstreams, wires the registry,          |
| builds the app, starts the listener                              |
+--------------------------------+---------------------------------+
                                 | constructs and wires
                                 v
+------------------------------------------------------------------+
| HTTP layer (Hono app)                                            |
| middleware (request logging, error mapping), route mounting,     |
| route handlers: models catalog, completions dispatch             |
+--------------------------------+---------------------------------+
                                 | delegates matched requests
                                 v
+------------------------------------------------------------------+
| gateway core                                                     |
| alias routing: alias -> balance-selected route -> upstream       |
+--------------------------------+---------------------------------+
                                 | looks up by upstream id
                                 v
+------------------------------------------------------------------+
| upstream registry                                                |
| upstream id -> instance; populated at startup, then written only |
| by the management CRUD's hot-apply (add/replace/remove, ADR-014) |
+--------------------------------+---------------------------------+
                                 | hands out instances
                                 | (always as the interface)
                                 v
+------------------------------------------------------------------+
| upstream interface                                               |
| the only upstream shape the core and the registry see            |
+--------------------------------+---------------------------------+
                                 | implemented by every upstream
                                 v
+------------------------------------------------------------------+
| upstreams                                                        |
| one provider dialect per upstream;                               |
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
│   ├── upstreams/
│   │   ├── README.md                            upstream domain overview
│   │   ├── upstream-contract.md                 the Upstream interface, connect → serve lifecycle
│   │   └── openai-compatible.md                 MVP upstream: pure proxy to an OpenAI-compatible provider API
│   ├── routing.md                               alias routing, client-scoped model catalog, dispatch, startup route inventory
│   ├── load-balancing.md                        per-alias route selection strategies, in-memory route health, session affinity, failover
│   ├── model-metadata.md                        per-alias limits/capabilities: the detector field contract (c0wrk port), aggregation, surface shapes, the discover mount and the CRUD probes' seed/clear
│   ├── configuration.md                         config file location, JSON schema, startup validation, the runtime store's write-back (ADR-014)
│   ├── observability.md                         leveled pino logging to stderr
│   ├── frontend.md                              SPA shell (React + Bootstrap via react-bootstrap), /ui/* client-side routing + management sections
│   └── api-docs.md                              the /docs documentation surface: build-time OpenAPI artifact + Swagger UI shell, wire-schema module
│
├── contracts/
│   ├── client-gateway.md                        HTTP client <-> gateway (OpenAI protocol)
│   ├── gateway-management.md                    management API <-> operators/SPA (the mutation-capable /api/*: reads, the runtime CRUD write-back, the live upstream facilities)
│   └── gateway-upstream.md                      gateway upstreams <-> upstream provider APIs
│
└── decisions/
    ├── _template.md                             ADR template
    ├── 001-upstream-per-provider-type.md        upstream per provider connection, common interface
    ├── 002-hono-http-framework.md               Hono on Bun, edge-only handlers
    ├── 003-pino-stderr-logging.md               pino, JSON lines to stderr, no file logger
    ├── 004-per-upstream-tls-pinning.md          per-upstream TLS SPKI pinning via `tlsFingerprint`
    ├── 005-gateway-surface-namespace.md         surface namespace: LLM /llm/v1, management /api, SPA /ui
    ├── 006-tls-listener-server-block.md         listener under a `server` block, explicit TLS
    ├── 007-management-cookie-auth.md            cookie-session auth for the management surface (stage 1)
    ├── 008-client-bearer-auth.md                Bearer-token auth for the LLM surface (stage 2)
    ├── 009-alias-table-routing.md               model id = configured alias, per-client ACL, balance
    ├── 010-session-affinity.md                  session affinity on the completion surface: key priority, binding lifecycle
    ├── 011-management-live-model-listing.md     operator-triggered live model listing on the management surface (ADR-011)
    ├── 012-alias-model-metadata.md              alias model metadata: c0wrk detector port, discovery at start + on demand, min-rule limits, capability-AND (ADR-012)
    ├── 013-openapi-docs-surface.md              the /docs documentation surface: build-time-generated OpenAPI artifact + Swagger UI shell, ungated static metadata (ADR-013)
    ├── 014-runtime-management-crud.md           runtime management CRUD on /api: config.json write-back (tmp + atomic rename), hot apply, discover replacement, the mutation ADR (ADR-014)
    └── 015-adopt-react-bootstrap.md             react-bootstrap as the SPA's component layer over the Bootstrap CSS, the shared ConfirmModal (ADR-015)
```

All 31 spec files (3 architecture + 10 domain + 3 contracts + 15 ADRs) are listed above, alongside META.md, this INDEX, and the ADR template. After adding or removing a spec file, update this listing — see [META.md](./META.md), Update Protocol.
