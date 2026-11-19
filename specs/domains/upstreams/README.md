# Upstreams

## Purpose

Owns the connections to upstream LLM providers. The gateway instantiates one upstream per `upstreams` entry in the config file, identified by its `(type, id)` pair; all provider traffic flows through these upstreams behind a single `Upstream` interface.

Vocabulary: an *upstream* is one configured provider connection — a config entry plus its `Upstream` instance; the *provider (API)* is the remote LLM service an upstream connects to.

## Key Files

- `src/upstreams/upstream.ts` — the `Upstream` interface, `UpstreamConfig`, `UpstreamType`, `ProxyRequest`, `ModelEntry`
- `src/upstreams/registry.ts` — `UpstreamRegistry`: builds instances from config (the `type` → factory dispatch lives here; the factory map is injected by the entry point), id-keyed lookup, retained startup-probe outcomes (`status()` — the retained-outcome snapshot the management upstream list `GET /api/upstreams` serves); `listModels()` feeds the startup probe and the ADR-011 operator listing, never the client surface
- `src/upstreams/openai-compatible.ts` — the MVP `openai-compatible` upstream (pure HTTP proxy)
- `src/upstreams/tls-pinning.ts` — TLS SPKI pinning shared by the pinned upstream path: the per-request pinned connection (`pinnedUpstreamRequest`), pin decisions (`assertPinnedCertificate`, `computeSpkiPin`), the bare-handshake probe for the fingerprint CLI, `UpstreamTlsPinError`
- `tools/tls-fingerprint.ts` — CLI that prints (or fail-closed verifies with `--expect`) the pin for an upstream's `tlsFingerprint`

## Core Types

```ts
type UpstreamType = "openai-compatible"; // grows as provider upstreams land

interface UpstreamConfig {
  type: UpstreamType;   // selects the implementation
  id: string;          // unique; registry key the models[].routes[].upstream references name
  baseUrl: string;     // absolute http(s) upstream URL
  apiKey: string;      // secret, sent upstream only
  tlsFingerprint?: string;  // optional TLS SPKI pin — base64(SHA-256(SPKI DER));
                            // set → only the pinned key is accepted, fail closed
                            // (ADR-004); absent/empty or plain-http baseUrl → inert
}

/** One upstream model entry, as an upstream reports it — ids are unprefixed. */
interface ModelEntry {
  id: string;          // provider-native model id; surfaced verbatim to operators (ADR-011),
                       // never rewritten into the client-facing alias namespace
  object: "model";
  created: number;     // passed through from upstream
  owned_by: string;    // verbatim from the provider (the alias catalog never rewrites it)
  [field: string]: unknown;  // provider-native extras ride along unchanged
}

interface Upstream {
  readonly id: string;
  readonly type: UpstreamType;
  connect(): Promise<void>;                            // startup probe; failure → registry records outcome, not fatal
  status?(): UpstreamStatus | undefined;               // the frozen startup snapshot connect() retained, if any
  listModels(): Promise<ModelEntry[]>;                 // provider-native ids, unprefixed; probe + ADR-011 listing only
  forward(request: ProxyRequest): Promise<Response>;   // pure pass-through
}

/** The retained startup-probe outcome for one upstream — the GET /api/upstreams
    entry shape (gateway-management.md); reason exists only on "failed",
    models (the frozen startup catalog) only on "ok" with a retaining upstream. */
interface UpstreamStatus {
  id: string;
  type: UpstreamType;
  probe: "ok" | "failed";
  reason?: string;
  models?: ModelEntry[];
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
  all(): readonly Upstream[];             // config order (registry audit/inspection)
  status(): readonly UpstreamStatus[];    // retained probe outcomes in config order (GET /api/upstreams)
}
```

Each config entry is identified by its `(type, id)` pair: `type` selects the constructor through the factory, `id` is the registry key. Ids are unique across the whole config, so alias routing can resolve a configured route by id alone.

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

Serving — pass-through dispatch ([ADR-009](../../decisions/009-alias-table-routing.md)):

```
POST /llm/v1/chat/completions   (body.model = "gpt-4o-fast", an alias)
  routing table: exact alias lookup ─► balance-selected route
    └ route.upstream ─► registry.find(...) ─► upstream.forward(...)
                                  │ pass-through, incl. SSE; body.model
                                  │ carries the route's provider-native model
                                  ▼
                               upstream

GET /llm/v1/models — the gateway's alias catalog (ADR-009):
  routing-table aliases (client-scoped), owned_by "llm-gateway",
  process-start `created` — no upstream contact at all; upstream
  catalogs surface only through the startup probe and the ADR-011
  operator listing on /api/*
  client ◄───── response relayed unchanged ─────┘
```

## Invariants

- Every upstream instance corresponds to exactly one config entry and reports that entry's `type` and `id`.
- Upstream ids are unique across the entire config, independent of `type`; duplicates fail startup.
- The registry resolves upstreams by id; the `(type, id)` pair is the config identity validated at load time.
- Every upstream's `connect()` probe runs during startup, before the gateway starts listening; a failed probe is logged and never blocks startup. The registry retains every outcome (ok, or failed with its log-safe reason) in config order — a startup log fact that seeds the metadata store and the route inventory ([routing.md](../routing.md)) — carrying no credential or config material. After startup the registry accepts exactly three runtime writes, the management CRUD's hot-apply ([ADR-014](../../decisions/014-runtime-management-crud.md)): `add` (a created entry, probed within the startup budget — the outcome is data in the CRUD answer), `replace` (an updated one, same probe-and-land semantics) and `remove` (a deleted one).
- Upstreams relay requests and responses without interpreting or transforming payload bytes (the `model` rewrite lives in routing).
- `listModels()` exposes only models of its own upstream, with provider-native unprefixed ids; the client-facing model namespace (aliases, ADR-009) never touches upstream entries.

## Configuration

Provided entirely by the `upstreams` array of the gateway config — one entry per upstream with `type`, `id`, `baseUrl`, `apiKey`, and the optional `tlsFingerprint` TLS SPKI pin (enforced fail closed by the upstream module; see [ADR-004](../../decisions/004-per-upstream-tls-pinning.md)). See [Configuration](../configuration.md) for the schema, validation rules, and file location.

## Extension Points

- New provider: implement `Upstream` in a new module and register the constructor in the factory under a new `UpstreamType` — the registry, routing, and the alias catalog need no changes.
- Per-upstream behavior (timeouts, header policy) stays local to each upstream module.

## Related Specs

- [Upstream contract](./upstream-contract.md) — the interface and connect→serve lifecycle every upstream implements
- [OpenAI-compatible upstream](./openai-compatible.md) — the MVP provider implementation
- [Routing](../routing.md) — consumes the registry to resolve the routes aliases select ([ADR-009](../../decisions/009-alias-table-routing.md))
- [Configuration](../configuration.md) — where `(type, id, baseUrl, apiKey, tlsFingerprint?)` entries come from
- [ADR-004: per-upstream TLS SPKI pinning](../../decisions/004-per-upstream-tls-pinning.md) — the `tlsFingerprint` semantics shared by this domain
