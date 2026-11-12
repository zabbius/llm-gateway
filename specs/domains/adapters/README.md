# Provider Adapters

## Purpose

Owns the connections to upstream LLM providers. The gateway instantiates one adapter per `adapters` entry in the config file, identified by its `(type, id)` pair; all provider traffic flows through these adapters behind a single `Adapter` interface.

## Key Files

- `src/adapters/adapter.ts` — the `Adapter` interface, `AdapterConfig`, `AdapterType`, `ProxyRequest`, `ModelEntry`
- `src/adapters/registry.ts` — `AdapterRegistry`: builds instances from config (the `type` → factory dispatch lives here; the factory map is injected by the entry point), id-keyed lookup, aggregated model listing
- `src/adapters/openai-compatible.ts` — the MVP `openai-compatible` adapter (pure HTTP proxy)
- `src/adapters/tls-pinning.ts` — TLS SPKI pinning shared by the pinned adapter path: bare-handshake probe, pin computation (`computeSpkiPin`), pin-only `tls` options, `UpstreamTlsPinError`
- `tools/tls-fingerprint.ts` — CLI that prints (or fail-closed verifies with `--expect`) the pin for an adapter's `tlsFingerprint`

## Core Types

```ts
type AdapterType = "openai-compatible"; // grows as provider adapters land

interface AdapterConfig {
  type: AdapterType;   // selects the implementation
  id: string;          // unique; names the routing prefix namespace
  baseUrl: string;     // absolute http(s) upstream URL
  apiKey: string;      // secret, sent upstream only
  tlsFingerprint?: string;  // optional TLS SPKI pin — base64(SHA-256(SPKI DER));
                            // set → only the pinned key is accepted, fail closed
                            // (ADR-005); absent/empty or plain-http baseUrl → inert
}

/** One upstream model entry, as an adapter reports it — ids are unprefixed. */
interface ModelEntry {
  id: string;          // provider-native model id; aggregation adds the "{adapterId}/" prefix
  object: "model";
  created: number;     // passed through from upstream
  owned_by: string;    // rewritten by the aggregation to the adapter id
  [field: string]: unknown;  // provider-native extras ride along unchanged
}

interface Adapter {
  readonly id: string;
  readonly type: AdapterType;
  connect(): Promise<void>;                            // startup probe; failure logged, not fatal
  listModels(): Promise<ModelEntry[]>;                 // provider-native ids, unprefixed
  forward(request: ProxyRequest): Promise<Response>;   // pure pass-through
}

/**
 * Constructor of one adapter implementation, selected by the config entry's
 * `type`. The `type` → factory map is injected by the entry point (the only
 * place concrete adapter classes are named — layers.md invariant 2); the
 * registry performs the dispatch on `type`.
 */
type AdapterFactory = (entry: AdapterConfig, logger: pino.Logger) => Adapter;
```

The registry is the domain's aggregate root:

```ts
class AdapterRegistry {
  static create(entries: readonly AdapterConfig[], factories: AdapterFactories,
                logger: pino.Logger): Promise<AdapterRegistry>;
  find(id: string): Adapter | undefined; // exact-id lookup
  all(): readonly Adapter[];             // config order, feeds aggregation
}
```

Each config entry is identified by its `(type, id)` pair: `type` selects the constructor through the factory, `id` is the registry key. Ids are unique across the whole config, so prefix routing can resolve an adapter by id alone.

## Flow

Startup — build and connect the pool:

```
config.json ──► AdapterRegistry.create()
                    │  one iteration per config entry (type, id)
                    ├─► factory dispatch on type ──► new Adapter
                    ├─► adapter.connect()   (probe; failure logged, startup continues)
                    └─► adapters.set(id, adapter)
```

Serving — aggregation and pass-through:

```
GET /v1/models
  registry.all() ─► Promise.all(a.listModels()) ─► prefix ids "{id}/" ─► flatten
  (a failed adapter contributes no entries — warning logged, the rest still returns)
  ─► { object: "list", data: [...] }

POST /v1/chat/completions   (body.model = "openai/gpt-4o")
  registry.find("openai") ─► adapter.forward(...)
                                │ pass-through, incl. SSE
                                ▼
                             upstream
  client ◄───── response relayed unchanged ─────┘
```

## Invariants

- Every adapter instance corresponds to exactly one config entry and reports that entry's `type` and `id`.
- Adapter ids are unique across the entire config, independent of `type`; duplicates fail startup.
- The registry resolves adapters by id; the `(type, id)` pair is the config identity validated at load time.
- Every adapter's `connect()` probe runs during startup, before the gateway starts listening; a failed probe is logged and never blocks startup.
- Adapters relay requests and responses without interpreting or transforming payload bytes (prefix handling lives in routing).
- `listModels()` exposes only models of its own adapter, with provider-native unprefixed ids; prefixing happens in the aggregation, not in adapters.

## Configuration

Provided entirely by the `adapters` array of the gateway config — one entry per adapter with `type`, `id`, `baseUrl`, `apiKey`, and the optional `tlsFingerprint` TLS SPKI pin (enforced fail closed by the adapter module; see [ADR-005](../../decisions/005-per-adapter-tls-pinning.md)). See [Configuration](../configuration.md) for the schema, validation rules, and file location.

## Extension Points

- New provider: implement `Adapter` in a new module and register the constructor in the factory under a new `AdapterType` — the registry, routing, and aggregation need no changes.
- Per-adapter behavior (timeouts, header policy) stays local to each adapter module.

## Related Specs

- [Adapter contract](./adapter-contract.md) — the interface and connect→serve lifecycle every adapter implements
- [OpenAI-compatible adapter](./openai-compatible.md) — the MVP provider implementation
- [Routing](../routing.md) — consumes the registry for prefix resolution and model aggregation
- [Configuration](../configuration.md) — where `(type, id, baseUrl, apiKey, tlsFingerprint?)` entries come from
- [ADR-005: per-adapter TLS SPKI pinning](../../decisions/005-per-adapter-tls-pinning.md) — the `tlsFingerprint` semantics shared by this domain
