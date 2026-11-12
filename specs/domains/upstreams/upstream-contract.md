# Upstream Contract

## Role

Defines the interface every provider upstream implements and the `connect → serve` lifecycle the gateway drives it through.

## Key Files

- `src/upstreams/upstream.ts` — the `Upstream` interface and its request/response types, plus `UpstreamStatus` (the retained startup-probe outcome)
- `src/upstreams/registry.ts` — drives the lifecycle: constructs upstreams (factory dispatch on `type` through the entry-point-injected factory map), calls `connect()` at startup, and retains each probe outcome (`status()` — the `GET /api/status` snapshot)

## Behavior

### Interface

```ts
type UpstreamType = "openai-compatible"; // grows as provider upstreams land

interface Upstream {
  /** Config identity: unique routing namespace + implementation discriminator. */
  readonly id: string;
  readonly type: UpstreamType;

  /** Startup phase. Called once; probes the provider API (openai-compatible:
      listModels). Resolves when the probe succeeded; rejects with a log-safe
      reason when it did not — the registry records the outcome and startup
      continues. */
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

/** The retained startup-probe outcome for one upstream — what the registry's
    status() hands back and GET /api/status serves (gateway-management.md).
    Config identity plus the probe fact only: never credential or config
    material. reason (a log-safe failure fact) exists only on "failed". */
interface UpstreamStatus {
  id: string;
  type: UpstreamType;
  probe: "ok" | "failed";
  reason?: string;
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
║   ok ────────► ready (probe retained) ║
║   fail ──────► probe failed: outcome  ║
║   retained, warn (type, id); startup  ║
║   goes on                             ║
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

`connect()` runs once per process and is the phase boundary between configuration and traffic: no request reaches an upstream that has not completed `connect()`. A failed probe does not change this — the registry retains the outcome (`probe: "ok"` or `probe: "failed"` with the log-safe `reason`, surfaced by `GET /api/status`, [gateway-management.md](../../contracts/gateway-management.md)) and the upstream serves requests as usual (every upstream call re-attempts the provider). Disconnection/shutdown is outside the MVP scope — process exit tears connections down.

## Error Handling

- `connect()` rejects exactly when the startup probe failed, carrying a log-safe `reason` (never credential or config material): the registry records the outcome (`{probe: "ok"}` or `{probe: "failed", reason}`), logs the warning with the failing entry's `(type, id)`, and startup continues. Startup aborts only for invalid configuration (see [Configuration](../configuration.md)).
- `forward()` distinguishes two failure classes:
  - the provider answered — the upstream status and body are relayed unchanged (`4xx`/`5xx` pass-through);
  - the provider is unreachable, the connection refused, or it timed out — the upstream synthesizes `504` with the OpenAI error envelope (`type: "api_error"`, `code: "upstream_timeout"`); a non-JSON upstream error body synthesizes `502` (`type: "api_error"`, `code: "upstream_error"`). It never fabricates a success response.
- `listModels()` failure at serve time degrades: the failing upstream contributes no entries to `GET /llm/v1/models`, the rest of the list still returns with status `200`, and the failure is logged as a warning naming the upstream id.

## Invariants

- Every upstream reports the `id` and `type` of its own config entry.
- `connect()` runs exactly once per upstream and completes before any `forward()` or `listModels()` call reaches it.
- `forward()` relays the request body as received and the upstream response as received; it never parses, filters, or re-emits payload bytes.
- `listModels()` exposes only models of its own upstream, with provider-native unprefixed ids.
- The registry retains every startup-probe outcome in config order (`status()` → `UpstreamStatus`: `id`, `type`, `probe`, `reason?`) and never changes it after startup; the retained outcome carries no credential or config material.
- A failed upstream call never resolves to a `2xx` response.

## Related Specs

- [Upstreams](./README.md) — domain overview: registry, factory, aggregation
- [OpenAI-compatible upstream](./openai-compatible.md) — header policy, SSE pass-through, timeouts
- [Routing](../routing.md) — how requests select an upstream and reach `forward()`
- [Configuration](../configuration.md) — the config entries upstreams are built from
