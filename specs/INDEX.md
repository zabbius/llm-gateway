# INDEX

Navigation for the specification system. One glance to find the right document for a task; formats and update rules live in [META.md](./META.md).

## Task → Spec

| Task | Read first | Also relevant |
| ---- | ---------- | ------------- |
| Start working on the project (understand the system) | [architecture/layers.md](./architecture/layers.md), [architecture/data-flow.md](./architecture/data-flow.md) | [META.md](./META.md), this INDEX |
| Add an upstream for a NEW provider type | [domains/upstreams/README.md](./domains/upstreams/README.md), [domains/upstreams/upstream-contract.md](./domains/upstreams/upstream-contract.md) | [contracts/gateway-upstream.md](./contracts/gateway-upstream.md), [decisions/001-upstream-per-provider-type.md](./decisions/001-upstream-per-provider-type.md), [decisions/002-model-id-prefix-routing.md](./decisions/002-model-id-prefix-routing.md), [domains/configuration.md](./domains/configuration.md) |
| Add a connection of an EXISTING type (e.g. another OpenAI-compatible provider) | [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md) | [domains/configuration.md](./domains/configuration.md), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) |
| Pin a self-signed / internal-PKI upstream (TLS `tlsFingerprint`) | [decisions/005-per-upstream-tls-pinning.md](./decisions/005-per-upstream-tls-pinning.md) | [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md), [domains/configuration.md](./domains/configuration.md), `tools/tls-fingerprint.ts` |
| Change the routing scheme (model-id prefix, dispatch) | [domains/routing.md](./domains/routing.md), [decisions/002-model-id-prefix-routing.md](./decisions/002-model-id-prefix-routing.md) | [contracts/client-gateway.md](./contracts/client-gateway.md), [architecture/data-flow.md](./architecture/data-flow.md) |
| Change the client-facing OpenAI surface (endpoints, error envelope, model list shape) | [contracts/client-gateway.md](./contracts/client-gateway.md) | [domains/routing.md](./domains/routing.md), [architecture/data-flow.md](./architecture/data-flow.md), [decisions/006-gateway-surface-namespace.md](./decisions/006-gateway-surface-namespace.md) (surface namespace) |
| Add or change a management endpoint (`/api/*`: status, configuration) | [contracts/gateway-management.md](./contracts/gateway-management.md) | [decisions/006-gateway-surface-namespace.md](./decisions/006-gateway-surface-namespace.md), [architecture/data-flow.md](./architecture/data-flow.md) (startup mount), [contracts/client-gateway.md](./contracts/client-gateway.md) (shared error envelope), [architecture/security-model.md](./architecture/security-model.md) (credential masking) |
| Add or change gateway auth (login, sessions, password hashing) | [decisions/008-management-cookie-auth.md](./decisions/008-management-cookie-auth.md), [architecture/security-model.md](./architecture/security-model.md) | [contracts/gateway-management.md](./contracts/gateway-management.md) (session gate, auth actions), [domains/configuration.md](./domains/configuration.md) (`auth` schema), [domains/frontend.md](./domains/frontend.md) (SPA login flow), `tools/hash-password.ts` |
| Change upstream interaction (paths, headers, timeouts, retries) | [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) | [domains/upstreams/upstream-contract.md](./domains/upstreams/upstream-contract.md), [domains/upstreams/openai-compatible.md](./domains/upstreams/openai-compatible.md) |
| Change the config file schema (add a field, new upstream type fields) | [domains/configuration.md](./domains/configuration.md) | [config.example.json](../config.example.json) (keep in sync — enforced by test), [architecture/data-flow.md](./architecture/data-flow.md) (startup), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (upstream entries) |
| Serve the gateway over TLS, or change listener options (address, TLS) | [decisions/007-tls-listener-server-block.md](./decisions/007-tls-listener-server-block.md) | [domains/configuration.md](./domains/configuration.md) (`server` schema), [architecture/data-flow.md](./architecture/data-flow.md) (PEM read before bind), [architecture/security-model.md](./architecture/security-model.md) (TLS ≠ authentication), `tools/generate-tls-cert.sh` |
| Change log levels or logging behavior | [domains/observability.md](./domains/observability.md), [decisions/004-pino-stderr-logging.md](./decisions/004-pino-stderr-logging.md) | [domains/configuration.md](./domains/configuration.md) (`logLevel`) |
| Change the startup / wiring sequence | [architecture/data-flow.md](./architecture/data-flow.md), [architecture/layers.md](./architecture/layers.md) | [domains/configuration.md](./domains/configuration.md) |
| Touch credentials, key handling, or log redaction | [architecture/security-model.md](./architecture/security-model.md) | [domains/observability.md](./domains/observability.md), [contracts/gateway-upstream.md](./contracts/gateway-upstream.md) (Authorization policy) |
| Work on the frontend (SPA) | [domains/frontend.md](./domains/frontend.md) | [decisions/006-gateway-surface-namespace.md](./decisions/006-gateway-surface-namespace.md) (`/ui/*` mount, client-side routing), [contracts/gateway-management.md](./contracts/gateway-management.md) (the management API the UI consumes) |
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
| route handlers: models aggregation, completions dispatch         |
+--------------------------------+---------------------------------+
                                 | delegates matched requests
                                 v
+------------------------------------------------------------------+
| gateway core                                                     |
| model-id prefix resolution ({upstreamId}/{model})                |
+--------------------------------+---------------------------------+
                                 | looks up by upstream id
                                 v
+------------------------------------------------------------------+
| upstream registry                                                |
| upstream id -> instance; populated at startup, read-only after   |
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
│   ├── routing.md                               prefix routing, model aggregation, dispatch
│   ├── configuration.md                         config file location, JSON schema, startup validation
│   ├── observability.md                         leveled pino logging to stderr
│   └── frontend.md                              SPA shell (React + Bootstrap), /ui/* client-side routing + management sections
│
├── contracts/
│   ├── client-gateway.md                        HTTP client <-> gateway (OpenAI protocol)
│   ├── gateway-management.md                    management API <-> operators/SPA (read-only /api/*)
│   └── gateway-upstream.md                      gateway upstreams <-> upstream provider APIs
│
└── decisions/
    ├── _template.md                             ADR template
    ├── 001-upstream-per-provider-type.md        upstream per provider connection, common interface
    ├── 002-model-id-prefix-routing.md           public model id = {upstreamId}/{model}
    ├── 003-hono-http-framework.md               Hono on Bun, edge-only handlers
    ├── 004-pino-stderr-logging.md               pino, JSON lines to stderr, no file logger
    ├── 005-per-upstream-tls-pinning.md          per-upstream TLS SPKI pinning via `tlsFingerprint`
    ├── 006-gateway-surface-namespace.md         surface namespace: LLM /llm/v1, management /api, SPA /ui
    ├── 007-tls-listener-server-block.md         listener under a `server` block, explicit TLS
    └── 008-management-cookie-auth.md            cookie-session auth for the management surface (stage 1)
```

All 21 spec files (3 architecture + 7 domain + 3 contracts + 8 ADRs) are listed above, alongside META.md, this INDEX, and the ADR template. After adding or removing a spec file, update this listing — see [META.md](./META.md), Update Protocol.
