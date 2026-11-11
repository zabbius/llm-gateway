# OpenAI-Compatible Adapter

## Role

The MVP provider adapter: a pure HTTP proxy in front of any upstream that speaks the OpenAI API (base URL + API key), relaying requests and responses — including SSE streams — unchanged.

## Key Files

- `src/adapters/openai-compatible/adapter.ts` — `OpenAICompatibleAdapter`: proxying, header policy, timeouts, model mapping <!-- TODO: verify -->

## Behavior

### Upstream mapping

- `baseUrl` — absolute `http(s)` URL including the API root with `/v1` (e.g. `https://api.openai.com/v1`); a single trailing slash is stripped at config load.
- Upstream URL = `baseUrl + "/" + ProxyRequest.path` (`chat/completions`, `completions`, `models`).
- `listModels()` calls `GET {baseUrl}/models` and returns provider-native entries with unprefixed ids; prefixing `id → "{adapterId}/{id}"` and setting `owned_by` to the adapter id happen in the aggregation, not in the adapter.

### Header policy

| Direction | Header | Value |
| --------- | ------ | ----- |
| out | `Authorization` | `Bearer {config.apiKey}` — always taken from config |
| out | `Content-Type` | relayed from the client request |
| out | `Accept` | relayed from the client request |
| in → client | all upstream response headers | relayed unchanged (the transport strips hop-by-hop headers) |

The client's own `Authorization` header is dropped — the configured `apiKey` is the only credential that ever reaches upstream.

### SSE pass-through

When the upstream response has `Content-Type: text/event-stream`:

- the response status and headers are relayed unchanged;
- body chunks are written to the client as they arrive — no buffering, no reordering, no parsing of `data:` frames;
- a client disconnect aborts the upstream request.

### Timeouts

| Constant | Default | Applies to |
| -------- | ------- | ---------- |
| `CONNECT_PROBE_TIMEOUT_MS` | `10 000` | the `listModels()` probe inside `connect()` |
| `FORWARD_TIMEOUT_MS` | `120 000` | non-streaming `forward()` end-to-end; for streams — until upstream response headers arrive |
| `STREAM_IDLE_TIMEOUT_MS` | `300 000` | once streaming: maximum silence between chunks (no total cap) |

Forward timeout expiry maps to the upstream-unreachable error path (`504`, `code: "upstream_timeout"`), including for streams that stall before response headers arrive; an idle-stream expiry ends the SSE response. A failed probe at startup is logged and does not abort.

## Error Handling

- Upstream answered (`4xx`/`5xx`) — status, headers, and body relayed to the client unchanged; the gateway adds nothing.
- Upstream unreachable, DNS failure, timeout — the adapter synthesizes `504` with the OpenAI error envelope:

```json
{ "error": { "message": "upstream \"openai\" is unreachable: timeout",
             "type": "api_error",
             "code": "upstream_timeout" } }
```

- Upstream answered with a non-JSON, empty, or HTML error body — the adapter synthesizes `502` with `type: "api_error"`, `code: "upstream_error"`, since the payload is not a relayable OpenAI error.

- The adapter performs a single attempt per client request — no retries in the MVP (retry policy is future work).

## Invariants

- Every outbound request carries exactly one credential: the configured `apiKey` as a `Bearer` token; a client-supplied `Authorization` header is never forwarded.
- `apiKey` never appears in logs or in any response returned to a client.
- SSE bodies reach the client byte-for-byte in arrival order; a streaming response never waits for the full body before relaying its first byte.
- Upstream error responses are relayed with their original status code.
- At most one upstream attempt happens per client request.

## Related Specs

- [Provider Adapters](./README.md) — domain overview and registry
- [Adapter contract](./adapter-contract.md) — interface and lifecycle this module implements
- [Configuration](../configuration.md) — `baseUrl` / `apiKey` validation rules
- [Observability](../observability.md) — what this adapter logs per level (never secrets)
