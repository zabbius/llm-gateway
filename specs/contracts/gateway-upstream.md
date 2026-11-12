# Contract: Gateway <-> Provider Upstream

## Boundary Rule

Adapters make one-way outbound calls to provider HTTP APIs; providers are external systems with no knowledge of the gateway. Only adapter code constructs or parses provider wire formats — the gateway core never imports provider-specific modules and sees adapters only through the `Adapter` interface below. Not allowed: provider SDK dependencies (adapters use plain HTTP), retries on this boundary in the MVP, adapters calling other adapters, or adapters reaching back into the core.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `Adapter` (TS interface) | `src/adapters/adapter.ts` | gateway core: router, adapter registry | Uniform surface: `connect()`, `listModels()`, `forward()` — shape below |
| `OpenAICompatibleAdapter` (TS class) | `src/adapters/openai-compatible.ts` | adapter registry (constructed from config `type: "openai-compatible"`) | openai-compatible implementation: `baseUrl` (with `/v1`) + Bearer `apiKey`, pure proxy |
| `POST {baseUrl}/chat/completions` (provider HTTP) | provider API | `OpenAICompatibleAdapter` | chat completions upstream call (JSON or SSE response) |
| `POST {baseUrl}/completions` (provider HTTP) | provider API | `OpenAICompatibleAdapter` | legacy completions upstream call (JSON or SSE response) |
| `GET {baseUrl}/models` (provider HTTP) | provider API | `OpenAICompatibleAdapter.listModels()` | provider model discovery for the aggregated `/v1/models` list |

Shape of the uniform adapter surface as landed in `src/adapters/adapter.ts`:

```typescript
interface Adapter {
  readonly id: string;
  readonly type: AdapterType;                    // "openai-compatible" on the MVP
  connect(): Promise<void>;                      // startup probe; failure is logged, not fatal
  listModels(): Promise<ModelEntry[]>;           // provider-native entries, ids unprefixed
  forward(request: ProxyRequest): Promise<Response>;  // pure pass-through, streamed body
}

interface ProxyRequest {
  path: string;                                  // appended to baseUrl (which includes /v1);
                                                 // the router passes only the fixed paths —
                                                 // MVP: "chat/completions", "completions"
  method: "GET" | "POST";
  body?: ReadableStream<Uint8Array>;             // client body relayed as received;
                                                 // `model` already de-prefixed by the router
  headers: Record<string, string>;               // Content-Type / Accept;
                                                 // credentials are attached by the adapter itself
}
```

The gateway generates exactly three upstream paths on this boundary — the provider-native model id travels inside the body, never in the URL path.

## Initialization

At startup the process reads the JSON config, then wires this boundary:

1. For each entry of the `adapters[]` array, construct an adapter instance selected by the `type` field (`"openai-compatible"` → `OpenAICompatibleAdapter`); the `type` → factory map is injected by the entry point, and the registry performs the dispatch (see [layers.md](../architecture/layers.md)).
2. Register every instance in the adapter registry keyed by its unique `id`; the router resolves `<adapterId>/` prefixes through this registry (see [routing.md](../domains/routing.md)).
3. Abort startup on invalid config: unknown `type`, duplicate `id`, or `id` not matching `[a-z0-9][a-z0-9-]*` — a gateway with an invalid config never listens (see [security-model.md](../architecture/security-model.md)).
4. Probe each adapter once (`connect()` → `listModels()`, 10-second budget): the outcome is logged with the adapter id; a failed probe is **not fatal** — the adapter stays registered, and its unavailability surfaces per request. The gateway starts even with unreachable upstreams (see [data-flow.md](../architecture/data-flow.md)).

Target config schema (see [adapters/README.md](../domains/adapters/README.md)):

```json
{
  "listen": "127.0.0.1:8080",
  "logLevel": "info",
  "adapters": [
    {
      "id": "openai-main",
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-..."
    }
  ]
}
```

`baseUrl` is the API root **including** `/v1` (e.g. `https://api.openai.com/v1`), without a trailing slash — the adapter appends the fixed relative paths `chat/completions`, `completions`, `models` itself.

### Timeouts and retries (MVP policy)

- Startup probe (`connect()` → `listModels()`): 10 seconds per adapter; expiry counts as a failed probe (logged, non-fatal).
- Forward timeout (non-streaming): 120 seconds end-to-end — completions are long; no retry on expiry. For streams the same budget applies until upstream response headers arrive.
- Streaming: no whole-request timeout; an idle gap of 300 seconds between SSE chunks aborts the upstream request.
- **Retries: none in the MVP.** A failed upstream request is surfaced to the client immediately. Retries are a deliberate non-goal (pure-proxy latency guarantees, no duplicate side effects); introducing them passes the ADR bar.

These are fixed MVP constants, not config fields — making them configurable is a contract change (see Breaking Change Checklist).

## Data Flow Across Boundary

Direction: gateway → provider (request), provider → gateway (response or stream).

```
router ── ProxyRequest{path, body: de-prefixed, stream} ──▶ adapter
adapter ── POST {baseUrl}/chat/completions ──▶ provider
            Authorization: Bearer <config.apiKey>
            Content-Type: application/json   (Accept: text/event-stream when stream)
adapter ◀─ 200 JSON ──────────────────────────── provider            (non-streaming)
adapter ── ForwardResponse{status, body bytes} ──▶ router ──▶ client
adapter ◀─ 200 text/event-stream ─────────────── provider            (streaming)
adapter ── ForwardResponse{body: SSE bytes, verbatim} ──▶ router ──▶ client
```

Rules:

- The request body crosses this boundary byte-for-byte except for the single `model` field, which the router has already de-prefixed (see [client-gateway.md](client-gateway.md)); no fields are added, removed, or renamed, and unknown client fields pass through untouched.
- Authorization policy: the adapter builds `Authorization: Bearer <apiKey>` from its own config on every upstream call; the client's `Authorization` header was already dropped at the gateway edge (see [client-gateway.md](client-gateway.md)). The configured `apiKey` never leaves this boundary in any other form.
- Only the three fixed paths above are callable upstream — client URLs are never proxied as-is.
- Hop-by-hop headers are never forwarded in either direction.
- Streaming upstream → client is a verbatim byte pass-through: the adapter does not parse SSE events; a client disconnect propagates as an upstream abort (see [openai-compatible.md](../domains/adapters/openai-compatible.md)).

## Error Propagation

Provider → gateway → client direction; the mapping rules must stay consistent with the Error Propagation table in [client-gateway.md](client-gateway.md#error-propagation):

| Upstream outcome | What crosses back | Client sees |
| ---------------- | ----------------- | ----------- |
| OpenAI-shaped error JSON (any 4xx/5xx) | Status + body proxied unchanged — never wrapped again | Upstream error envelope, byte-for-byte |
| Non-JSON / empty / HTML error body | synthesized `Response` | 502, `type: "api_error"`, `code: "upstream_error"` |
| Connect timeout, connection refused | synthesized `Response` | 504, `type: "api_error"`, `code: "upstream_timeout"` |
| Response timeout (non-streaming) | synthesized `Response` | 504, `type: "api_error"`, `code: "upstream_timeout"` |
| Idle timeout mid-stream | Upstream aborted; SSE response simply ends | Stream ends — no JSON error after SSE started |
| `listModels()` failure | Registry entry degrades; router logs a warning | That adapter contributes no entries to `/v1/models` (200) |

The adapter never invents success: any upstream outcome that is not a well-formed 2xx response is propagated per the table, and the gateway core performs no retry on any of these outcomes (MVP: no retries).

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Config schema (`adapters[].id` / `type` / `baseUrl` / `apiKey`)** couples the config loader, startup validation, README examples, and [client-gateway.md](client-gateway.md) examples. Any key rename, type change, or new required field must update all of them in one change; changing the config file format itself (JSON) is cross-cutting and passes the ADR bar.
2. **`baseUrl` semantics** (API root including `/v1`; the adapter appends the fixed relative paths) — changing what the URL must contain (e.g. dropping `/v1` and hardcoding it inside adapters) changes path construction in every adapter and every documented example; requires a migration note and updates to [adapters/README.md](../domains/adapters/README.md) plus this contract.
3. **Adapter `id` grammar (`[a-z0-9][a-z0-9-]*`)** couples registry keys, `<adapterId>/` prefix parsing, and the client-facing model id scheme — always change together with item 1 of [client-gateway.md](client-gateway.md#breaking-change-checklist) and [routing.md](../domains/routing.md).
4. **`Adapter` interface signature** couples every adapter implementation, the registry, and the router call sites — update [routing.md](../domains/routing.md) and [adapters/README.md](../domains/adapters/README.md) in the same change.
5. **`type` discriminator `"openai-compatible"` and its semantics** — changing the meaning of an existing type breaks deployed configs (update this contract + [adapters/README.md](../domains/adapters/README.md)); adding a new provider type is an extension point and changes nothing here.
6. **Authorization policy** (the config `apiKey` is the only upstream credential; the client `Authorization` header is dropped at the edge) — any change must update [client-gateway.md](client-gateway.md) and [security-model.md](../architecture/security-model.md).
7. **No-retry invariant and timeout constants** — introducing retries contradicts a documented invariant and passes the ADR bar; making timeouts configurable changes the config schema (see item 1).
