# Upstream Contract

## Role

Defines the interface every provider upstream implements and the `connect → serve` lifecycle the gateway drives it through.

## Key Files

- `src/upstreams/upstream.ts` — the `Upstream` interface and its request/response types
- `src/upstreams/registry.ts` — drives the lifecycle: constructs upstreams (factory dispatch on `type` through the entry-point-injected factory map) and calls `connect()` at startup

## Behavior

### Interface

```ts
type UpstreamType = "openai-compatible"; // grows as provider upstreams land

interface Upstream {
  /** Config identity: unique routing namespace + implementation discriminator. */
  readonly id: string;
  readonly type: UpstreamType;

  /** Startup phase. Called once; probes the provider API (openai-compatible:
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
  /** Relay headers (Content-Type, Accept, …); the upstream attaches its own credentials. */
  headers: Record<string, string>;
}
```

### Lifecycle: connect → serve

```
   UpstreamRegistry.create()
           │  per config entry (type, id)
           ▼
    factory(entry, logger)   — the entry point injects the
           │                   `type` → factory map (layers.md);
           │                   the registry dispatches on `type`
           ▼
╔═══════════════════════════════════════╗
║ connect()  — once                     ║
║   validates the entry, probes the     ║
║   provider API (openai-compatible:    ║
║   listModels)                         ║
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
║   no per-request upstream state       ║
╚═══════════════════════════════════════╝
```

`connect()` runs once per process and is the phase boundary between configuration and traffic: no request reaches an upstream that has not completed `connect()`. A failed probe does not change this — the upstream is marked degraded in the logs and serves requests as usual (every upstream call re-attempts the provider). Disconnection/shutdown is outside the MVP scope — process exit tears connections down.

## Error Handling

- `connect()` never rejects on provider unavailability: the probe outcome (ok or failed) is logged with the failing entry's `(type, id)`, and startup continues. Startup aborts only for invalid configuration (see [Configuration](../configuration.md)).
- `forward()` distinguishes two failure classes:
  - the provider answered — the upstream status and body are relayed unchanged (`4xx`/`5xx` pass-through);
  - the provider is unreachable, the connection refused, or it timed out — the upstream synthesizes `504` with the OpenAI error envelope (`type: "api_error"`, `code: "upstream_timeout"`); a non-JSON upstream error body synthesizes `502` (`type: "api_error"`, `code: "upstream_error"`). It never fabricates a success response.
- `listModels()` failure at serve time degrades: the failing upstream contributes no entries to `GET /v1/models`, the rest of the list still returns with status `200`, and the failure is logged as a warning naming the upstream id.

## Invariants

- Every upstream reports the `id` and `type` of its own config entry.
- `connect()` runs exactly once per upstream and completes before any `forward()` or `listModels()` call reaches it.
- `forward()` relays the request body as received and the upstream response as received; it never parses, filters, or re-emits payload bytes.
- `listModels()` exposes only models of its own upstream, with provider-native unprefixed ids.
- A failed upstream call never resolves to a `2xx` response.

## Related Specs

- [Upstreams](./README.md) — domain overview: registry, factory, aggregation
- [OpenAI-compatible upstream](./openai-compatible.md) — header policy, SSE pass-through, timeouts
- [Routing](../routing.md) — how requests select an upstream and reach `forward()`
- [Configuration](../configuration.md) — the config entries upstreams are built from
