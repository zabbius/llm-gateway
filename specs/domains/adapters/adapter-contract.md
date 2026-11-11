# Adapter Contract

## Role

Defines the interface every provider adapter implements and the `connect → serve` lifecycle the gateway drives it through.

## Key Files

- `src/adapters/adapter.ts` — the `Adapter` interface and its request/response types <!-- TODO: verify -->
- `src/adapters/registry.ts` — drives the lifecycle: constructs adapters (factory dispatch on `type`) and calls `connect()` at startup <!-- TODO: verify -->

## Behavior

### Interface

```ts
type AdapterType = "openai-compatible"; // grows as provider adapters land

interface Adapter {
  /** Config identity: unique routing namespace + implementation discriminator. */
  readonly id: string;
  readonly type: AdapterType;

  /** Startup phase. Called once; probes the upstream (openai-compatible:
      listModels). A failed probe is logged and does not reject. */
  connect(): Promise<void>;

  /** Provider-native model list; ids unprefixed — aggregation adds "{id}/". */
  listModels(): Promise<ModelEntry[]>;

  /** Pure pass-through of one OpenAI-protocol request. Returns the upstream
      response as-is (status, headers, streamed body), so SSE flows untouched. */
  forward(request: ProxyRequest): Promise<Response>;
}

interface ProxyRequest {
  /** Upstream path relative to baseUrl: "chat/completions", "completions", "models". */
  path: string;
  method: "GET" | "POST";
  /** Client body relayed as received — streamed, never buffered whole. */
  body?: ReadableStream<Uint8Array>;
  /** Relay headers (Content-Type, Accept, …); the adapter attaches its own credentials. */
  headers: Record<string, string>;
}
```

### Lifecycle: connect → serve

```
   AdapterRegistry.create()
           │  per config entry (type, id)
           ▼
    factory.create(type, id, baseUrl, apiKey)
           │
           ▼
╔═══════════════════════════════════════╗
║ connect()  — once                     ║
║   validates the entry, probes upstream║
║   (openai-compatible: listModels)     ║
║   ok ────────► ready                  ║
║   fail ──────► probe failed: warn log ║
║   with (type, id); startup goes on    ║
╚═══════════════════════════════════════╝
           │  listening starts after every probe finished (ok or logged)
           ▼
╔═══════════════════════════════════════╗
║ serve  — many                         ║
║   forward() / listModels()            ║
║   stateless request handling;         ║
║   no per-request adapter state        ║
╚═══════════════════════════════════════╝
```

`connect()` runs once per process and is the phase boundary between configuration and traffic: no request reaches an adapter that has not completed `connect()`. A failed probe does not change this — the adapter is marked degraded in the logs and serves requests as usual (every upstream call re-attempts the provider). Disconnection/shutdown is outside the MVP scope — process exit tears connections down.

## Error Handling

- `connect()` never rejects on upstream unavailability: the probe outcome (ok or failed) is logged with the failing entry's `(type, id)`, and startup continues. Startup aborts only for invalid configuration (see [Configuration](../configuration.md)).
- `forward()` distinguishes two failure classes:
  - upstream answered — the upstream status and body are relayed unchanged (`4xx`/`5xx` pass-through);
  - upstream unreachable, connection refused, or timed out — the adapter synthesizes `504` with the OpenAI error envelope (`type: "api_error"`, `code: "upstream_timeout"`); a non-JSON upstream error body synthesizes `502` (`type: "api_error"`, `code: "upstream_error"`). It never fabricates a success response.
- `listModels()` failure at serve time degrades: the failing adapter contributes no entries to `GET /v1/models`, the rest of the list still returns with status `200`, and the failure is logged as a warning naming the adapter id.

## Invariants

- Every adapter reports the `id` and `type` of its own config entry.
- `connect()` runs exactly once per adapter and completes before any `forward()` or `listModels()` call reaches it.
- `forward()` relays the request body as received and the upstream response as received; it never parses, filters, or re-emits payload bytes.
- `listModels()` exposes only models of its own adapter, with provider-native unprefixed ids.
- A failed upstream call never resolves to a `2xx` response.

## Related Specs

- [Provider Adapters](./README.md) — domain overview: registry, factory, aggregation
- [OpenAI-compatible adapter](./openai-compatible.md) — header policy, SSE pass-through, timeouts
- [Routing](../routing.md) — how requests select an adapter and reach `forward()`
- [Configuration](../configuration.md) — the config entries adapters are built from
