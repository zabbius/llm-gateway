# Architecture: Data Flow

## Context

Two sequences decide whether the MVP acceptance holds: startup (config → adapters → listen) and the per-request lifecycle (auth → route → prefix → adapter → proxy stream). This document traces both as the canonical reference for implementation and debugging: the fixed ordering, the failure exits at each hop, and what crosses each boundary. Layer responsibilities live in [layers.md](./layers.md); key handling and redaction during these flows live in [security-model.md](./security-model.md).

## Startup Flow

```
process start (bun src/index.ts)
     |
     v
[1] load config -- env LLM_GATEWAY_CONFIG, else ./config.json   src/config/load.ts
     |
     v
[2] validate config:
      adapter entries (id, type, baseUrl, apiKey, optional tlsFingerprint pin),
      listen host:port, log level
     |            invalid -> error to stderr, exit non-zero
     v
[3] construct one adapter per entry
      openai-compatible: baseUrl (with /v1) + apiKey, pure pass-through
     |
     v
[4] register adapters in the registry (adapter id -> instance)  src/adapters/registry.ts
     |
     v
[5] build the Hono app, mount the gateway router                src/httpapi/app.ts
     |
     v
[6] probe every adapter (connect() -> listModels, 10 s budget)  src/adapters/registry.ts
     |            failure -> warning logged (with adapter id), startup continues
     v
[7] listen on the configured host:port (Bun.serve)
     |
     v
ready -- a client can chat with an LLM through the gateway
```

Notes:

- After construction every adapter runs a one-shot startup probe (`connect()` → `listModels()`, 10-second budget): the outcome is logged (a failure logs a warning naming the adapter id), and startup continues — the gateway comes up even with unreachable upstreams; their unavailability surfaces per request.
- The listener starts only after every probe finished (ok or logged).

## Request Lifecycle: Chat Completion

```
client
   |  POST /v1/chat/completions -- OpenAI body, model: "acme/gpt-4o"
   v
[1] AUTH      the auth stage runs first                          security-model.md
   |          MVP: gateway-auth is a TODO -- the stage is a no-op placeholder
   v
[2] ROUTE     the Hono app matches the endpoint                  src/httpapi/app.ts
   |          GET /v1/models | POST /v1/chat/completions
   |          unknown route -> 404
   v
[3] PREFIX    model "acme/gpt-4o" splits on the first "/"
   |          adapterId = "acme", upstreamModel = "gpt-4o"
   |          body.model := "gpt-4o" (the only body transformation)
   |          no "/" in model -> 404 model_not_found to the client
   v
[4] ADAPTER   registry lookup by exact adapterId                 src/adapters/registry.ts
   |          unknown id -> 404 model_not_found (OpenAI error envelope)
   v
[5] PROXY     the adapter builds the upstream request:
   |            baseUrl + path; method and body relayed as received,
   |            client Authorization dropped at the edge (never forwarded),
   |            hop-by-hop headers never forwarded,
   |            adapter attaches its own provider credentials;
   |            pinned upstream (tlsFingerprint set, ADR-005): the request opens
   |            over the cached probed leaf — bare-handshake probe, fail-closed
   |            SPKI pin check, leaf-anchored chain, per-connection pin veto;
   |            a TLS failure invalidates the cache (re-probe next request) and
   |            maps to 502 upstream_tls_error
   v
[6] upstream provider processes the request
   |
   v
[7] STREAM    the upstream response is piped back as it arrives;
   |          stream:true -> SSE chunks pass through unbuffered;
   |          status and content-type preserved
   v
log one line at the configured level to stderr
(adapter id, status, duration; no key material -- security-model.md)
```

## Request Lifecycle: Models List

```
client
   |  GET /v1/models
   v
[1] AUTH      (as above)
   |
   v
[2] ROUTE     GET /v1/models
   |
   v
[3] AGGREGATE the router asks every registered adapter (via the interface)
   |          for its model list
   v
[4] PREFIX    every upstream model id is prefixed with its adapter id
   |          "gpt-4o" from adapter "acme" -> "acme/gpt-4o"
   v
flat aggregated list in the OpenAI list shape -> client
```

## Errors Along the Flow

- Upstream failure: the adapter never raises — it relays the upstream status and body, or synthesizes a 502 upstream_error / 504 upstream_timeout envelope (gateway-upstream.md); a TLS verification failure on a pinned upstream (`tlsFingerprint` set) synthesizes a 502 upstream_tls_error (ADR-005); the app's error middleware maps only unexpected gateway-side exceptions to a 502 upstream_error envelope, and logs at warning or error.
- Routing failures (unprefixed model, unknown adapter id) never reach an adapter — they are answered at stages [3] and [4].
- Chat requests are single-adapter by construction, so one provider being down never blocks requests targeting other providers.
- Models aggregation degrades: an adapter that fails or times out contributes no entries; the rest of the list still returns with status 200, and the failure is logged as a warning naming the adapter id.

## Invariants

- Startup order is fixed: config → adapters → registry → app → listen; the listener never accepts traffic before the registry is populated.
- Every proxied chat request resolves its adapter through the model-id prefix; no path leads from an HTTP handler to an adapter without the prefix lookup.
- The prefix is parsed once per request by the router for lookup; rewriting `body.model` (prefix strip) is the router's single body transformation — adapters relay payload bytes untouched.
- A chat-completion request touches exactly one adapter.
- Streaming responses are forwarded incrementally; the gateway never buffers a full SSE stream before answering the client.
- The auth stage precedes routing and adapter invocation; on MVP it is a no-op placeholder, and no code path skips it.
- Every request produces at least one log line at the configured level, written to stderr; nothing below the configured level is emitted.

## Anti-Patterns

- Aborting startup because a startup probe failed — probe results are logged, never fatal; upstream availability beyond the probe is a per-request concern, not a per-boot one.
- Buffering the whole SSE stream "to log the answer" before replying — destroys streaming latency; log boundary events and chunk counts instead.
- Routing by provider-specific URL prefixes instead of the model-id prefix — fragments the single OpenAI surface clients program against.
- Fuzzy or first-match adapter-id resolution ("acme2" matching "acme") — ids match exactly on the segment before the first "/"; fuzzy matching silently routes requests to the wrong provider.
- Answering 200 with an error payload after an adapter failure — failures surface as HTTP status codes at the app boundary.
- Constructing adapters per request from config — adapters are constructed exactly once, at startup.
