# Architecture: Data Flow

## Context

Two sequences decide whether the MVP acceptance holds: startup (config → upstreams → listen) and the per-request lifecycle (auth → route → prefix → upstream → proxy stream). This document traces both as the canonical reference for implementation and debugging: the fixed ordering, the failure exits at each hop, and what crosses each boundary. Layer responsibilities live in [layers.md](./layers.md); key handling and redaction during these flows live in [security-model.md](./security-model.md).

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
[6] build the Hono app, mount the surfaces:                     src/httpapi/app.ts
      LLM router at /llm/v1/*, management routes at /api/*
      (+ the auth gate wired from the entry-point-injected
      auth slice, ADR-008), SPA static serving at /ui/*,
      root / -> 302 redirect to /ui
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
- The listener starts only after every probe finished (ok or logged).
- When TLS is enabled ([ADR-007](../decisions/007-tls-listener-server-block.md)), both PEM files are read right before the bind — after validation and app wiring, before any port is bound: a missing or unreadable file is a fatal startup error, so a TLS-enabled gateway never falls back to plain HTTP.

## Request Lifecycle: Chat Completion

```
client
   |  POST /llm/v1/chat/completions -- OpenAI body, model: "acme/gpt-4o"
   v
[1] AUTH      the auth stage runs first                          security-model.md
   |          stage 1 (ADR-008): when auth.enabled is true, /api/*
   |          is gated by the config-backed session cookie --
   |          POST /api/login and POST /api/logout excepted;
   |          /llm/v1 and the /ui shell pass ungated (stage 2 TODO);
   |          auth off -> the stage is a no-op placeholder
   v
[2] ROUTE     the Hono app matches the endpoint                  src/httpapi/app.ts
   |          LLM surface: GET /llm/v1/models | POST /llm/v1/chat/completions
   |                      | POST /llm/v1/completions
   |          management: GET /api/status | GET /api/configuration
   |                      | POST /api/login | POST /api/logout (ADR-008)
   |          unknown route -> 404
   v
[3] PREFIX    model "acme/gpt-4o" splits on the first "/"
   |          upstreamId = "acme", upstreamModel = "gpt-4o"
   |          body.model := "gpt-4o" (the only body transformation)
   |          no "/" in model -> 404 model_not_found to the client
   v
[4] UPSTREAM  registry lookup by exact upstreamId                src/upstreams/registry.ts
   |          unknown id -> 404 model_not_found (OpenAI error envelope)
   v
[5] PROXY     the upstream builds the upstream request:
   |            baseUrl + path; method and body relayed as received,
   |            client Authorization dropped at the edge (never forwarded),
   |            hop-by-hop headers never forwarded,
   |            upstream attaches its own provider credentials;
   |            pinned upstream (tlsFingerprint set, ADR-005): the request opens
   |            its own TLS socket and verifies the pin inline before any byte
   |            is written — fail-closed SPKI pin check, leaf-anchored chain,
   |            per-connection pin veto; nothing is cached between requests,
   |            and a TLS failure maps to 502 upstream_tls_error
   v
[6] upstream provider processes the request
   |
   v
[7] STREAM    the upstream response is piped back as it arrives;
   |          stream:true -> SSE chunks pass through unbuffered;
   |          status and content-type preserved
   v
log the request-handled summary to stderr (debug level)
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
[3] AGGREGATE the router asks every registered upstream (via the interface)
   |          for its model list
   v
[4] PREFIX    every upstream model id is prefixed with its upstream id
   |          "gpt-4o" from upstream "acme" -> "acme/gpt-4o"
   v
flat aggregated list in the OpenAI list shape -> client
```

## Errors Along the Flow

- Upstream failure: the upstream never raises — it relays the upstream status and body, or synthesizes a 502 upstream_error / 504 upstream_timeout envelope (gateway-upstream.md); a TLS verification failure on a pinned upstream (`tlsFingerprint` set) synthesizes a 502 upstream_tls_error (ADR-005); the app's error middleware maps only unexpected gateway-side exceptions to a 502 upstream_error envelope, and logs at warning or error.
- Routing failures (unprefixed model, unknown upstream id) never reach an upstream — they are answered at stages [3] and [4].
- Chat requests are single-upstream by construction, so one provider being down never blocks requests targeting other providers.
- Models aggregation degrades: an upstream that fails or times out contributes no entries; the rest of the list still returns with status 200, and the failure is logged as a warning naming the upstream id.

## Invariants

- Startup order is fixed: config → upstreams → registry → app → listen; the listener never accepts traffic before the registry is populated.
- Every proxied chat request resolves its upstream through the model-id prefix; no path leads from an HTTP handler to an upstream without the prefix lookup.
- The prefix is parsed once per request by the router for lookup; rewriting `body.model` (prefix strip) is the router's single body transformation — upstreams relay payload bytes untouched.
- A chat-completion request touches exactly one upstream.
- Streaming responses are forwarded incrementally; the gateway never buffers a full SSE stream before answering the client.
- The auth stage precedes routing and upstream invocation; when auth is enabled it gates `/api/*` with the session check ([ADR-008](../decisions/008-management-cookie-auth.md)), when auth is off it stays a no-op placeholder — no code path skips it.
- Request handling is logged to stderr — the request-handled summary at debug, failures at warning or error; nothing below the configured level is emitted.

## Anti-Patterns

- Aborting startup because a startup probe failed — probe results are logged, never fatal; upstream availability beyond the probe is a per-request concern, not a per-boot one.
- Buffering the whole SSE stream "to log the answer" before replying — destroys streaming latency; log boundary events and chunk counts instead.
- Routing by provider-specific URL prefixes instead of the model-id prefix — fragments the single OpenAI surface clients program against.
- Fuzzy or first-match upstream-id resolution ("acme2" matching "acme") — ids match exactly on the segment before the first "/"; fuzzy matching silently routes requests to the wrong provider.
- Answering 200 with an error payload after an upstream failure — failures surface as HTTP status codes at the app boundary.
- Constructing upstreams per request from config — upstreams are constructed exactly once, at startup.
