# Routing

## Purpose

Maps OpenAI-protocol requests onto the adapter registry. The model namespace is prefixed: a client model id `"{adapterId}/{model}"` selects the adapter; `GET /v1/models` aggregates all adapters into one flat list; the two completion endpoints dispatch as pure pass-through.

## Key Files

- `src/gateway/router.ts` — model-id prefix parsing and adapter resolution (`resolveModel`) <!-- TODO: verify -->
- `src/httpapi/handlers/models.ts` — `GET /v1/models` aggregation handler <!-- TODO: verify -->
- `src/httpapi/handlers/completions.ts` — `POST /v1/chat/completions` and `POST /v1/completions` dispatch handlers <!-- TODO: verify -->

## Core Types

```ts
/** Client-facing model id: "{adapterId}/{upstreamModel}" — split on the first "/";
    the remainder may contain further slashes (provider-native names). */
type PrefixedModelId = string;

interface RouteResolution {
  adapter: Adapter;       // registry hit by prefix
  upstreamModel: string;  // prefix stripped; what upstream receives in body.model
}

/** "openai/gpt-4o" → { adapter: registry entry "openai", upstreamModel: "gpt-4o" } */
declare function resolveModel(model: PrefixedModelId, registry: AdapterRegistry): RouteResolution;

/** Envelope for gateway-generated errors (dispatch failures only) — OpenAI-native. */
interface GatewayError {
  error: {
    message: string;
    type: "invalid_request_error" | "api_error";
    code: "model_not_found" | "upstream_error" | "upstream_timeout";
  };
}
```

Resolution rules:

- no `/` in the model id, or an empty half → `404` `model_not_found`;
- prefix is not a registered adapter id → `404` `model_not_found`;
- upstream unreachable / timed out (raised by the adapter) → `504` `upstream_timeout`; a non-JSON upstream error body → `502` `upstream_error`;
- an unknown *model* under a known adapter is not a gateway error — the request is forwarded and the upstream owns the verdict.

Endpoint map:

| Endpoint | Handling |
| -------- | -------- |
| `GET /v1/models` | aggregate: `registry.all()` → `listModels()` in parallel → flatten → `{ "object": "list", "data": [...] }` |
| `POST /v1/chat/completions` | `resolveModel(body.model)` → `adapter.forward({ path: "chat/completions", … })` |
| `POST /v1/completions` | `resolveModel(body.model)` → `adapter.forward({ path: "completions", … })` |

## Flow

Dispatch on `/v1/chat/completions`:

```
Client                          Gateway                                   Upstream
  │ POST /v1/chat/completions      │                                         │
  │ { "model": "openai/gpt-4o" }   │                                         │
  │───────────────────────────────►│ parse body                              │
  │                                │ resolveModel("openai/gpt-4o")           │
  │                                │   ├ prefix "openai" → registry.find     │
  │                                │   └ upstreamModel "gpt-4o"              │
  │                                │ body.model := "gpt-4o"                  │
  │                                │ adapter.forward("chat/completions") ───►│
  │                                │◄──────── response / SSE stream ─────────│
  │◄─── relayed unchanged ─────────│                                         │
```

Aggregation on `GET /v1/models`:

```
registry.all() ─► Promise.all(adapters.map(a => a.listModels()))
                       │  each adapter returns provider-native ids (unprefixed);
                       │  a failed adapter contributes no entries (warning logged)
                       ▼
        prefix ids "{adapterId}/" ─► flatten in config order ─► { "object": "list", "data": [...] }
```

## Invariants

- Every client-visible model id starts with a registered adapter id followed by `/`; the prefix grammar `[a-z0-9][a-z0-9-]*` contains no `/`.
- `GET /v1/models` returns one flat list — entries are never grouped or nested by adapter, and the list preserves config order.
- The only transformation routing makes on a dispatching request is replacing `body.model` `"a/m"` with `"m"`; the remaining bytes are forwarded as received.
- An unknown model under a known adapter is forwarded to the upstream — model existence is the upstream's verdict, not the gateway's.
- Requests with a malformed or unregistered prefix are rejected with `404` `model_not_found` before any upstream contact.
- Dispatch responses are relayed unchanged — status, headers, and body (including SSE); routing never rewrites them.
- `/v1/chat/completions` and `/v1/completions` share the same resolution path; only the forwarded upstream `path` differs.

## Configuration

Routing has no configuration of its own in the MVP. Its model namespace is derived entirely from the `adapters` array — every adapter id becomes a prefix. See [Configuration](./configuration.md).

## Extension Points

- A new OpenAI-protocol endpoint (e.g. `/v1/embeddings`) adds a handler that reuses `resolveModel`; the registry and adapters need no changes.
- Route-level auth or quotas — future cross-cutting concerns attach between request parsing and `resolveModel`; none exist in the MVP.

## Related Specs

- [Provider Adapters](./adapters/README.md) — the registry routing resolves against
- [Adapter contract](./adapters/adapter-contract.md) — what `forward()` does with a dispatched request
- [Configuration](./configuration.md) — source of the prefix namespace
- [Observability](./observability.md) — per-request log lines emitted on this path
