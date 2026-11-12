# Upstreams

## Purpose

Owns the connections to upstream LLM providers. The gateway instantiates one upstream per `upstreams` entry in the config file, identified by its `(type, id)` pair; all provider traffic flows through these upstreams behind a single `Upstream` interface.

Vocabulary: an *upstream* is one configured provider connection — a config entry plus its `Upstream` instance; the *provider (API)* is the remote LLM service an upstream connects to.

## Key Files

- `src/upstreams/upstream.ts` — the `Upstream` interface, `UpstreamConfig`, `UpstreamType`, `ProxyRequest`, `ModelEntry`
- `src/upstreams/registry.ts` — `UpstreamRegistry`: builds instances from config (the `type` → factory dispatch lives here; the factory map is injected by the entry point), id-keyed lookup, aggregated model listing, retained startup-probe outcomes (`status()` — the `GET /api/status` snapshot)
- `src/upstreams/openai-compatible.ts` — the MVP `openai-compatible` upstream (pure HTTP proxy)
- `src/upstreams/tls-pinning.ts` — TLS SPKI pinning shared by the pinned upstream path: the per-request pinned connection (`pinnedUpstreamRequest`), pin decisions (`assertPinnedCertificate`, `computeSpkiPin`), the bare-handshake probe for the fingerprint CLI, `UpstreamTlsPinError`
- `tools/tls-fingerprint.ts` — CLI that prints (or fail-closed verifies with `--expect`) the pin for an upstream's `tlsFingerprint`

## Core Types

```ts
type UpstreamType = "openai-compatible"; // grows as provider upstreams land

interface UpstreamConfig {
  type: UpstreamType;   // selects the implementation
  id: string;          // unique; names the routing prefix namespace
  baseUrl: string;     // absolute http(s) upstream URL
  apiKey: string;      // secret, sent upstream only
  tlsFingerprint?: string;  // optional TLS SPKI pin — base64(SHA-256(SPKI DER));
                            // set → only the pinned key is accepted, fail closed
                            // (ADR-005); absent/empty or plain-http baseUrl → inert
}

/** One upstream model entry, as an upstream reports it — ids are unprefixed. */
interface ModelEntry {
  id: string;          // provider-native model id; aggregation adds the "{upstreamId}/" prefix
  object: "model";
  created: number;     // passed through from upstream
  owned_by: string;    // rewritten by the aggregation to the upstream id
  [field: string]: unknown;  // provider-native extras ride along unchanged
}

interface Upstream {
  readonly id: string;
  readonly type: UpstreamType;
  connect(): Promise<void>;                            // startup probe; failure → registry records outcome, not fatal
  listModels(): Promise<ModelEntry[]>;                 // provider-native ids, unprefixed
  forward(request: ProxyRequest): Promise<Response>;   // pure pass-through
}

/** The retained startup-probe outcome for one upstream — the GET /api/status
    entry shape (gateway-management.md); reason exists only on "failed". */
interface UpstreamStatus {
  id: string;
  type: UpstreamType;
  probe: "ok" | "failed";
  reason?: string;
}

/**
 * Constructor of one upstream implementation, selected by the config entry's
 * `type`. The `type` → factory map is injected by the entry point (the only
 * place concrete upstream classes are named — layers.md invariant 2); the
 * registry performs the dispatch on `type`.
 */
type UpstreamFactory = (entry: UpstreamConfig, logger: pino.Logger) => Upstream;
```

The registry is the domain's aggregate root:

```ts
class UpstreamRegistry {
  static create(entries: readonly UpstreamConfig[], factories: UpstreamFactories,
                logger: pino.Logger): Promise<UpstreamRegistry>;
  find(id: string): Upstream | undefined; // exact-id lookup
  all(): readonly Upstream[];             // config order, feeds aggregation
  status(): readonly UpstreamStatus[];    // retained probe outcomes in config order (GET /api/status)
}
```

Each config entry is identified by its `(type, id)` pair: `type` selects the constructor through the factory, `id` is the registry key. Ids are unique across the whole config, so prefix routing can resolve an upstream by id alone.

## Flow

Startup — build and connect the pool:

```
config.json ──► UpstreamRegistry.create()
                    │  one iteration per config entry (type, id)
                    ├─► factory dispatch on type ──► new Upstream
                    ├─► upstream.connect()   (probe; outcome retained — ok, or
                    │    failed + log-safe reason; failure logged, startup continues)
                    └─► upstreams.set(id, upstream)
```

Serving — aggregation and pass-through:

```
GET /llm/v1/models
  registry.all() ─► Promise.all(u.listModels()) ─► prefix ids "{id}/" ─► flatten
  (a failed upstream contributes no entries — warning logged, the rest still returns)
  ─► { object: "list", data: [...] }

POST /llm/v1/chat/completions   (body.model = "openai/gpt-4o")
  registry.find("openai") ─► upstream.forward(...)
                                │ pass-through, incl. SSE
                                ▼
                             upstream
  client ◄───── response relayed unchanged ─────┘
```

## Invariants

- Every upstream instance corresponds to exactly one config entry and reports that entry's `type` and `id`.
- Upstream ids are unique across the entire config, independent of `type`; duplicates fail startup.
- The registry resolves upstreams by id; the `(type, id)` pair is the config identity validated at load time.
- Every upstream's `connect()` probe runs during startup, before the gateway starts listening; a failed probe is logged and never blocks startup. The registry retains every outcome (ok, or failed with its log-safe reason) in config order for `GET /api/status` ([gateway-management.md](../../contracts/gateway-management.md)) — read-only after startup, carrying no credential or config material.
- Upstreams relay requests and responses without interpreting or transforming payload bytes (prefix handling lives in routing).
- `listModels()` exposes only models of its own upstream, with provider-native unprefixed ids; prefixing happens in the aggregation, not in upstreams.

## Configuration

Provided entirely by the `upstreams` array of the gateway config — one entry per upstream with `type`, `id`, `baseUrl`, `apiKey`, and the optional `tlsFingerprint` TLS SPKI pin (enforced fail closed by the upstream module; see [ADR-005](../../decisions/005-per-upstream-tls-pinning.md)). See [Configuration](../configuration.md) for the schema, validation rules, and file location.

## Extension Points

- New provider: implement `Upstream` in a new module and register the constructor in the factory under a new `UpstreamType` — the registry, routing, and aggregation need no changes.
- Per-upstream behavior (timeouts, header policy) stays local to each upstream module.

## Related Specs

- [Upstream contract](./upstream-contract.md) — the interface and connect→serve lifecycle every upstream implements
- [OpenAI-compatible upstream](./openai-compatible.md) — the MVP provider implementation
- [Routing](../routing.md) — consumes the registry for prefix resolution and model aggregation
- [Configuration](../configuration.md) — where `(type, id, baseUrl, apiKey, tlsFingerprint?)` entries come from
- [ADR-005: per-upstream TLS SPKI pinning](../../decisions/005-per-upstream-tls-pinning.md) — the `tlsFingerprint` semantics shared by this domain
