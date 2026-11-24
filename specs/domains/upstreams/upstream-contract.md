# Upstream Contract

## Role

Defines the interface every provider upstream implements and the `connect → serve` lifecycle the gateway drives it through.

## Key Files

- `src/upstreams/upstream.ts` — the `Upstream` interface and its request/response types, plus `UpstreamStatus` (the retained startup-probe outcome)
- `src/upstreams/registry.ts` — drives the lifecycle: constructs upstreams (factory dispatch on `type` through the entry-point-injected factory map), calls `connect()` at startup, and retains each probe outcome (`status()` — the retained-outcome snapshot the management upstream list `GET /api/upstreams` serves)

## Behavior

### Interface

```ts
type UpstreamType = "openai-compatible"; // grows as provider upstreams land

interface Upstream {
  /** Config identity: unique routing namespace + implementation discriminator. */
  readonly id: string;
  readonly type: UpstreamType;

  /** Startup phase. Called once; probes the provider API (openai-compatible:
      the two-leg model probe — standard + LM Studio native). Resolves when
      the probe succeeded; rejects with a log-safe reason when it did not —
      the registry records the outcome and startup continues. */
  connect(): Promise<void>;

  /** Provider-native model list; ids unprefixed — consumed by the startup probe
      and the ADR-011 operator listing, never rewritten into the alias namespace. */
  listModels(): Promise<ModelEntry[]>;

  /** Pure pass-through of one OpenAI-protocol request. Returns the upstream
      response as-is (status, headers, streamed body), so SSE flows untouched. */
  forward(request: ProxyRequest): Promise<Response>;

  /** The startup snapshot this upstream retained from connect() (optional —
      upstreams that keep none leave it out). Consulted exactly once by the
      registry, right after connect() resolved; never a second probe. */
  status?(): UpstreamStatus | undefined;

  /** Optional on-demand re-probe: a fresh model snapshot fetched from the
      provider right now, re-running the same legs the startup probe ran.
      Never writes the startup snapshot; rejects with a log-safe reason when
      the probe fails. Implementations that cannot re-probe leave it out. */
  discover?(): Promise<readonly ModelEntry[]>;
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
    status() hands back and the management upstream list `GET /api/upstreams`
    serves (gateway-management.md).
    Config identity plus the probe fact only: never credential or config
    material. reason (a log-safe failure fact) exists only on "failed".
    models is the frozen model catalog the upstream retained from its own
    probe — present only on "ok" and only when the upstream retains its
    probe result; a failed probe retains no catalog. */
interface UpstreamStatus {
  id: string;
  type: UpstreamType;
  probe: "ok" | "failed";
  reason?: string;
  models?: ModelEntry[];
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

`connect()` runs once per process and is the phase boundary between configuration and traffic: no request reaches an upstream that has not completed `connect()`. A failed probe does not change this — the registry retains the outcome (`probe: "ok"` or `probe: "failed"` with the log-safe `reason`, surfaced by the management upstream list `GET /api/upstreams`, [gateway-management.md](../../contracts/gateway-management.md)) and the upstream serves requests as usual (every upstream call re-attempts the provider). On success, an upstream that retains its probe result keeps the fetched model catalog as a frozen snapshot (`status()`), which the registry folds into the retained outcome once, at assembly: the snapshot seeds the alias-metadata store at startup and on the management create/update probes ([ADR-014](../../decisions/014-runtime-management-crud.md)), and the upstream-held snapshot is never refreshed at serve time (`listModels()` always re-fetches — the ADR-011 listing stores into the metadata store on its `discover=1` variant, never into the upstream, [ADR-016](../../decisions/016-discover-folded-into-live-listing.md)). A failed probe retains no catalog. Disconnection/shutdown is outside the MVP scope — process exit tears connections down.

`discover()` is the optional serve-phase re-probe: an upstream that implements it re-runs the same legs its startup probe ran and resolves with a freshly fetched model snapshot. No management mount consults it — the discovery facility it once served was replaced (at [ADR-014](../../decisions/014-runtime-management-crud.md)) by the interface's mandatory `listModels()`, which the management mounts run directly ([ADR-016](../../decisions/016-discover-folded-into-live-listing.md) folded that run into the ADR-011 listing's `discover=1` variant) — so the method stays optional interface surface with no current caller. It never writes the startup snapshot — `status()` and the registry's folded-in catalog stay exactly what `connect()` retained — and it rejects with a log-safe reason when the probe fails (the caller decides how to surface that). For the openai-compatible upstream, `connect()` and `discover()` share one fetch+merge helper (see [openai-compatible.md](./openai-compatible.md)).

## Error Handling

- `connect()` rejects exactly when the startup probe failed, carrying a log-safe `reason` (never credential or config material): the registry records the outcome (`{probe: "ok"}` or `{probe: "failed", reason}`, folding in the upstream's frozen `models` snapshot on `"ok"` when the upstream retains its probe result) and logs the warning with the failing entry's `(type, id)`, and startup continues. A failed probe retains no model catalog. Startup aborts only for invalid configuration (see [Configuration](../configuration.md)).
- `discover()` rejects with a log-safe reason when its probe legs fail (openai-compatible: when the standard leg fails — the LM Studio native leg never fails a probe); it never writes the startup snapshot, and its outcome is the caller's to surface.
- `forward()` distinguishes two failure classes:
  - the provider answered — the upstream status and body are relayed unchanged (`4xx`/`5xx` pass-through);
  - the provider is unreachable, the connection refused, or it timed out — the upstream synthesizes `504` with the OpenAI error envelope (`type: "api_error"`, `code: "upstream_timeout"`); a non-JSON upstream error body synthesizes `502` (`type: "api_error"`, `code: "upstream_error"`). It never fabricates a success response.
- `listModels()` failure at serve time degrades: the failing upstream contributes no entries to `GET /llm/v1/models`, the rest of the list still returns with status `200`, and the failure is logged as a warning naming the upstream id.

## Invariants

- Every upstream reports the `id` and `type` of its own config entry.
- `connect()` runs exactly once per upstream and completes before any `forward()` or `listModels()` call reaches it.
- `forward()` relays the request body as received and the upstream response as received; it never parses, filters, or re-emits payload bytes.
- `listModels()` exposes only models of its own upstream, with provider-native unprefixed ids.
- `discover()` (when implemented) resolves with freshly fetched entries and never writes the startup snapshot; its rejections carry a log-safe reason.
- The registry retains every startup-probe outcome in config order (`status()` → `UpstreamStatus`: `id`, `type`, `probe`, `reason?`, plus `models` — the upstream's frozen startup catalog — when the probe succeeded and the upstream retained its probe result) and never changes it after startup; every retained outcome and catalog is frozen at assembly, and the retained data carries no credential or config material.
- A failed upstream call never resolves to a `2xx` response.

## Related Specs

- [Upstreams](./README.md) — domain overview: registry, factory
- [OpenAI-compatible upstream](./openai-compatible.md) — header policy, SSE pass-through, timeouts
- [Routing](../routing.md) — how requests select an upstream and reach `forward()`
- [Configuration](../configuration.md) — the config entries upstreams are built from
