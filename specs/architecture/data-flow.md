# Architecture: Data Flow

## Context

Two sequences decide whether the MVP acceptance holds: startup (config → upstreams → listen) and the per-request lifecycle (auth → route → resolve → upstream → proxy stream). This document traces both as the canonical reference for implementation and debugging: the fixed ordering, the failure exits at each hop, and what crosses each boundary. Layer responsibilities live in [layers.md](./layers.md); key handling and redaction during these flows live in [security-model.md](./security-model.md).

## Startup Flow

```
process start (bun src/index.ts)
     |
     v
[1] load config -- env LLM_GATEWAY_CONFIG, else ./config.json   src/config/load.ts
     |
     v
[2] validate config:
      upstream entries (id, type, baseUrl, apiKey, optional tlsFingerprint pin),
      server.listen host:port, server.tls (enabled + cert/key paths
      when enabled), log level
     |            invalid -> error to stderr, exit non-zero
     v
[3] construct one upstream per entry
      openai-compatible: baseUrl (with /v1) + apiKey, pure pass-through
     |
     v
[4] register upstreams in the registry (upstream id -> instance)  src/upstreams/registry.ts
     |
     v
[5] probe every upstream (connect() -> listModels, 10 s budget)  src/upstreams/registry.ts
     |            failure -> warning logged (with upstream id), startup continues
     v
[5b] route inventory: cross-check every configured route       src/gateway/crosscheck.ts
      {alias -> upstream/model} against the retained startup
      catalogs (specs/domains/routing.md):
        model in the catalog  -> matched
        model not in it       -> missing -> one warning per route
        no catalog            -> unknown -> silent (the upstream's
                                     probe warning covers it)
     |            findings warn only -- startup continues
     v
[6] build the Hono app, mount the surfaces:                     src/httpapi/app.ts
      LLM router at /llm/v1/*, management routes at /api/*
      (the status probe, the ADR-011 live listing, the ADR-014
      CRUD blocks over upstreams/models/clients, the auth
      gate wired from the entry-point-injected auth slice,
      ADR-007), SPA static serving at /ui/*,
      root / -> 302 redirect to /ui;
      the alias routing table (ADR-009) is built here too
      through the rebuildable holder, from the validated
      models block plus the registry (a runtime models
      mutation later swaps a fresh build in without a
      restart, ADR-014);
      the runtime configuration store (ADR-014 D1) is wired
      over the normalized config + the path it was loaded
      from — its presence mounts the CRUD blocks and
      generalizes the client gate (fail-closed on an empty
      registry, ADR-008)
     |
     v
[7] listen on the configured host:port (Bun.serve)  src/index.ts
      tls enabled -> both PEM files (cert, key) are read first:
      missing or unreadable -> error naming the path, exit non-zero;
      Bun.serve receives the PEM contents under `tls`
     |
     v
ready -- a client can chat with an LLM through the gateway
```

Notes:

- After construction every upstream runs a one-shot startup probe (`connect()` → `listModels()`, 10-second budget): the outcome is logged (a failure logs a warning naming the upstream id), and startup continues — the gateway comes up even with unreachable upstreams; their unavailability surfaces per request. The probe outcome is retained by the registry and is what `GET /api/status` later reports ([gateway-management.md](../contracts/gateway-management.md)).
- The route inventory ([5b], [routing.md](../domains/routing.md)) runs after every probe finished, purely in memory: each configured route's model is compared against its upstream's retained catalog — a verified-missing model warns once per route, a route without a comparable catalog stays silent, and the counts land on an info line. Findings never abort startup; `GET /api/status` recomputes the same three-state verdicts per request from the frozen config and retained statuses.
- The listener starts only after every probe finished (ok or logged).
- The entry point constructs the runtime configuration store ([ADR-014](../decisions/014-runtime-management-crud.md)) over the normalized config and the path it was loaded from, and hands it to the app: the store's presence mounts the management CRUD blocks and generalizes the client Bearer gate (seeded from the store's current clients — an empty registry answers `401` fail-closed until the CRUD creates the first client). The metadata store's construction and seeding ("discovery at start") ride the same wiring.
- When TLS is enabled ([ADR-006](../decisions/006-tls-listener-server-block.md)), both PEM files are read right before the bind — after validation and app wiring, before any port is bound: a missing or unreadable file is a fatal startup error, so a TLS-enabled gateway never falls back to plain HTTP.

## Request Lifecycle: Chat Completion

```
client
   |  POST /llm/v1/chat/completions -- OpenAI body, model: "gpt-4o-fast" (an alias)
   v
[1] AUTH      the auth stage runs first                          security-model.md
   |          stage 1 (ADR-007): when auth.enabled is true, /api/*
   |          is gated by the config-backed session cookie --
   |          POST /api/login and POST /api/logout excepted;
   |          stage 2 (ADR-008): when the clients block is
   |          configured, /llm/v1/* requires Authorization:
   |          Bearer <apiKey> matching a configured client --
   |          missing/foreign/empty -> 401 authentication_required,
   |          unknown key -> 401 invalid_api_key (envelope,
   |          answered before the body is read or an upstream
   |          is contacted); on a match the gate publishes the
   |          client identity (name + allowed aliases) on the
   |          request context;
   |          the /ui shell and / pass ungated
   |          in every mode;
   |          neither block configured -> the stage is a no-op placeholder
   v
[2] ROUTE     the Hono app matches the endpoint                  src/httpapi/app.ts
   |          LLM surface: GET /llm/v1/models | POST /llm/v1/chat/completions
   |                      | POST /llm/v1/completions
   |          management: GET /api/status | GET /api/upstreams[/:id]
   |                      | POST /api/upstreams | PUT/DELETE /api/upstreams/:id
   |                      | POST /api/upstreams/:id/discover | GET /api/upstreams/:id/models
   |                      | GET/POST /api/models | GET/PUT/DELETE /api/models/:alias
   |                      | GET/POST /api/clients | GET/PUT/DELETE /api/clients/:name
   |                      | POST /api/login | POST /api/logout (ADR-007, ADR-011, ADR-014)
   |          unknown route -> 404
   v
[3] RESOLVE   alias lookup in the routing table (exact)          src/gateway/router.ts
   |          unknown alias -> 404 model_not_found (OpenAI error
   |          envelope); configured alias outside the client's
   |          clients[].models -> 403 (ADR-009 per-client ACL);
   |          then the route balancer selects the route
   |          (specs/domains/load-balancing.md): a session-
   |          affinity binding first (X-Session-Id header,
   |          else user — ADR-010), else the entry's
   |          balance.strategy rotation restricted to healthy
   |          routes -> (upstream, upstreamModel); every route
   |          open -> 503 upstream_unavailable without contact;
   |          the upstream comes from the registry (config-
   |          validated cross-references make a lookup miss
   |          impossible)
   v
[4] PROXY     the dispatch builds the upstream request:
   |            baseUrl + path; body.model := the route's
   |            provider-native model (the only body transformation),
   |            method and body relayed as received,
   |            client Authorization dropped at the edge (never forwarded),
   |            hop-by-hop headers never forwarded,
   |            upstream attaches its own provider credentials;
   |            one upstream per attempt (specs/domains/load-balancing.md):
   |            a pre-first-byte failure (synthesized 502/504/502-TLS,
   |            relayed 5xx or 429) marks the route and advances to the
   |            next eligible route; failover exhausted within the
   |            request relays the last upstream failure unchanged;
   |            once a response streams, there is no failover;
   |            pinned upstream (tlsFingerprint set, ADR-004): the request opens
   |            its own TLS socket and verifies the pin inline before any byte
   |            is written — fail-closed SPKI pin check, leaf-anchored chain,
   |            per-connection pin veto; nothing is cached between requests,
   |            and a TLS failure maps to 502 upstream_tls_error
   v
[5] the upstream's provider processes the request
   |
   v
[6] STREAM    the upstream response is piped back as it arrives;
   |          stream:true -> SSE chunks pass through unbuffered;
   |          status and content-type preserved
   v
[7] log the request-handled summary to stderr (debug level)
(upstream id, status, duration; no key material -- security-model.md)
```

## Request Lifecycle: Models List

```
client
   |  GET /llm/v1/models
   v
[1] AUTH      (as above)
   |
   v
[2] ROUTE     GET /llm/v1/models
   |
   v
[3] CATALOG   the routing table's current build lists its        src/gateway/router.ts
   |          aliases (config order); with a clients block,
   |          only the authenticated client's aliases are
   |          kept (ADR-009)
   |          every kept alias -> { id, object: "model",
   |          created: <process start epoch>, owned_by: "llm-gateway" }
   |          plus the alias-metadata projection where the
   |          aggregate knows a dimension (the metadata
   |          store's current slice — no upstream contact;
   |          a runtime models mutation is visible here on
   |          the next request, ADR-014)
   |
   v
flat client-scoped catalog in the OpenAI list shape -> client
```

## Request Lifecycle: Management Mutation

The runtime CRUD's write path ([ADR-014](../decisions/014-runtime-management-crud.md)) — one synchronous sequence per mutating request, behind the session gate like every `/api/*` request:

```
client
   |  POST/PUT/DELETE /api/{upstreams,models,clients}[/:key]   (session-gated)
   v
[1] AUTH      the session gate admits or answers the 401 envelope (ADR-007)
   |
   v
[2] VALIDATE  the configuration store checks the candidate entry against the
   |          current collections — the startup validator's grammar helpers
   |          (patterns, uniqueness, cross-references, last-entry rules)
   |          problem -> 400 envelope (value-free lines); nothing written
   v
[3] PERSIST   read the raw config file, replace ONLY the three mutable
   |          sections, write a sibling temp file, rename it onto
   |          config.json (same directory -> same-filesystem atomic replace)
   |          failure -> 400 envelope; memory untouched (invariant 15 of
   |          security-model.md — file and memory never diverge)
   v
[4] APPLY     the deep-frozen normalized config is rebuilt in memory
   |
   v
[5] HOT-APPLY the running graph, per collection (no restart):
   |          upstreams -> construct + probe within the 10 s budget (a failed
   |                      probe is data in the answer, not a cancellation, D8)
   |                      -> registry swap -> metadata slice seed/clear
   |          models    -> fresh routing-table build, atomically swapped into
   |                      the stable table object; route health and session
   |                      affinity start from the neutral state (D9)
   |          clients   -> the LLM gate's digest registry rebuilt from the
   |                      store's current clients (one atomic array swap)
   v
200 { upstream, probe } | entry | { client } | { deleted } -> client
   (referenced deletes answer 409 resource_in_use at step [2] before anything moves)
```

The discover mount (`POST /api/upstreams/:id/discover`) and the ADR-011 listing ride the same gate and the same probe budget: one `listModels()` each, the discover run swapping the metadata slice wholesale on success and leaving it serving (retain-last-good) on failure — its report is always `200` data-not-error.

## Errors Along the Flow

- Upstream failure: the upstream never raises — it relays the upstream status and body, or synthesizes a 502 upstream_error / 504 upstream_timeout envelope (gateway-upstream.md); a TLS verification failure on a pinned upstream (`tlsFingerprint` set) synthesizes a 502 upstream_tls_error (ADR-004); the app's error middleware maps only unexpected gateway-side exceptions to a 502 upstream_error envelope, and logs at warning or error.
- Pre-first-byte failures (synthesized 502/504/502-TLS, relayed 5xx or 429) additionally count against the route's health and trigger failover to the entry's next eligible route (specs/domains/load-balancing.md); a client-caused 4xx relays unchanged and touches no health state.
- An alias whose every route is currently open (cooldown, or its half-open probe in flight) answers a 503 upstream_unavailable envelope without any upstream contact (load-balancing.md); failover exhausted within one request relays the last upstream failure response byte-for-byte.
- Routing failures (an unknown alias, an alias the authenticated client is not allowed to address) never reach an upstream — they are answered at stage [3] (404 model_not_found and 403 respectively, ADR-009).
- Chat requests resolve through the alias table, so one provider being down never blocks requests targeting other providers; with balancing, its routes' own failures fail over inside the entry.
- The models catalog is served from the routing table: no upstream contact, no degradation path — it lists the config's aliases or, with an absent `models` block, nothing.

## Invariants

- Startup order is fixed: config → upstreams → registry → app → listen; the listener never accepts traffic before the registry is populated.
- Every proxied chat request resolves its upstream through the alias table; no path leads from an HTTP handler to an upstream without an alias resolution ([ADR-009](../decisions/009-alias-table-routing.md)).
- The alias is resolved once per request by the routing table (exact lookup, balance-selected route); rewriting `body.model` to the selected route's model is the router's single body transformation — upstreams relay payload bytes untouched.
- A chat-completion attempt touches exactly one upstream; a pre-first-byte failure advances the request to the entry's next eligible route ([load-balancing.md](../domains/load-balancing.md)), and once a response streams the answer is final — no failover past the first byte.
- Streaming responses are forwarded incrementally; the gateway never buffers a full SSE stream before answering the client.
- The auth stage precedes routing and upstream invocation; when auth is enabled it gates `/api/*` with the session check ([ADR-007](../decisions/007-management-cookie-auth.md)), when auth is off it stays a no-op placeholder — no code path skips it.
- Request handling is logged to stderr — the request-handled summary at debug, failures at warning or error; nothing below the configured level is emitted.
- A management mutation touches the config file before it touches memory: validate → persist (sibling temp file + atomic rename) → apply → hot-apply ([ADR-014](../decisions/014-runtime-management-crud.md) D1; invariant 15 of [security-model.md](./security-model.md)) — a failed validation or write leaves both disk and memory untouched, and `config.json` stays the single source of truth a restart reconstructs everything from.

## Anti-Patterns

- Aborting startup because a startup probe failed — probe results are logged, never fatal; upstream availability beyond the probe is a per-request concern, not a per-boot one.
- Buffering the whole SSE stream "to log the answer" before replying — destroys streaming latency; log boundary events and chunk counts instead.
- Routing by provider-specific URL prefixes instead of the model alias — fragments the single OpenAI surface clients program against.
- Fuzzy or first-match alias resolution ("gpt" matching "gpt-4o-fast") — an alias matches exactly or not at all; fuzzy matching silently routes requests to the wrong model.
- Answering 200 with an error payload after an upstream failure — failures surface as HTTP status codes at the app boundary.
- Retrying a request after its response started streaming — a servable response is final; failover is a pre-first-byte concern only ([load-balancing.md](../domains/load-balancing.md)).
- Constructing upstreams per request from config — upstreams are constructed at startup, and the runtime CRUD's probe-and-swap is the one exception ([ADR-014](../decisions/014-runtime-management-crud.md)): a management mutation constructs exactly one fresh instance per mutation, never per request.
