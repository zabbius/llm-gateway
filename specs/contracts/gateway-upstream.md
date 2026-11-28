# Contract: Gateway <-> Provider Upstream

## Boundary Rule

Upstreams make one-way outbound calls to provider HTTP APIs; providers are external systems with no knowledge of the gateway. Only upstream code constructs or parses provider wire formats — the gateway core never imports provider-specific modules and sees upstreams only through the `Upstream` interface below. Not allowed: provider SDK dependencies (upstreams use plain HTTP), retries on this boundary in the MVP, upstreams calling other upstreams, or upstreams reaching back into the core.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |
| `Upstream` (TS interface) | `src/upstreams/upstream.ts` | gateway core: router, upstream registry | Uniform surface: `connect()`, `listModels()`, `forward()` — shape below |
| `OpenAICompatibleUpstream` (TS class) | `src/upstreams/openai-compatible.ts` | upstream registry (constructed from config `type: "openai-compatible"`) | openai-compatible implementation: `baseUrl` (with `/v1`) + Bearer `apiKey`, pure proxy; every outbound call honors the entry's optional `proxy` ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) — `http://` through Bun's native proxy support, `socks5://` through a per-upstream loopback bridge (`src/upstreams/proxy.ts`, `src/upstreams/socks-bridge.ts`) |
| `POST {baseUrl}/chat/completions` (provider HTTP) | provider API | `OpenAICompatibleUpstream` | chat completions upstream call (JSON or SSE response) |
| `POST {baseUrl}/completions` (provider HTTP) | provider API | `OpenAICompatibleUpstream` | legacy completions upstream call (JSON or SSE response) |
| `GET {baseUrl}/models` (provider HTTP) | provider API | `OpenAICompatibleUpstream.listModels()` | provider model discovery for the startup probe and the ADR-011 operator listing (the client-facing `/llm/v1/models` is the alias catalog and contacts no upstream, [ADR-009](../decisions/009-alias-table-routing.md)) |
| `GET {baseUrl without the trailing /v1}/api/v0/models` (provider HTTP) | LM Studio native REST API | `OpenAICompatibleUpstream.connect()` / `.discover()` — the probe's native leg | LM Studio's native model catalog folded into the probe snapshot native-first by exact id; best-effort — any 4xx/5xx, transport failure, over-bound (>1 MiB) or unparseable answer silently skips the leg |

Shape of the uniform upstream surface as landed in `src/upstreams/upstream.ts`:

```typescript
interface Upstream {
  readonly id: string;
  readonly type: UpstreamType;                   // "openai-compatible" on the MVP
  connect(): Promise<void>;                      // startup probe; failure is logged, not fatal
  status?(): UpstreamStatus | undefined;         // the frozen startup snapshot connect() retained, if any — the registry consults it once
  discover?(): Promise<readonly ModelEntry[]>;   // optional on-demand re-probe: fresh snapshot, never writes the startup one
  listModels(): Promise<ModelEntry[]>;           // provider-native entries, ids unprefixed
  forward(request: ProxyRequest): Promise<Response>;  // pure pass-through, streamed body
  dispose?(): void;                              // optional release of what outlives a request (a socks5://
                                                 // proxy's bridge listener, ADR-017); idempotent, never
                                                 // throws — the registry calls it when a runtime
                                                 // replace/remove retires the instance and, in config
                                                 // order, on every instance at shutdown
}

interface ProxyRequest {
  path: string;                                  // appended to baseUrl (which includes /v1);
                                                 // the router passes only the fixed paths —
                                                 // MVP: "chat/completions", "completions"
  method: "GET" | "POST";
  body?: ReadableStream<Uint8Array>;             // client body relayed as received;
                                                 // `model` already rewritten to the selected route's model
  headers: Record<string, string>;               // the client headers minus the drop list, handed over best-effort —
                                                 // the openai-compatible upstream relays only Content-Type / Accept
                                                 // to the provider and attaches its own credentials
}
```

The gateway generates exactly three upstream paths on this boundary — the provider-native model id travels inside the body, never in the URL path.

## Initialization

At startup the process reads the JSON config, then wires this boundary:

1. For each entry of the `upstreams[]` array, construct an upstream instance selected by the `type` field (`"openai-compatible"` → `OpenAICompatibleUpstream`); the `type` → factory map is injected by the entry point, and the registry performs the dispatch (see [layers.md](../architecture/layers.md)). An entry's optional `proxy` ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) is read here but resolved lazily — on the upstream's first outbound call: an `http://` proxy needs nothing up front, a `socks5://` proxy starts its loopback bridge at that moment (so an upstream never contacted never listens).
2. Register every instance in the upstream registry keyed by its unique `id`; the routing table resolves the `models[].routes[].upstream` references through this registry (see [routing.md](../domains/routing.md)).
3. Abort startup on invalid config: unknown `type`, duplicate `id`, or `id` not matching `[a-z0-9][a-z0-9-]*` — a gateway with an invalid config never listens (see [security-model.md](../architecture/security-model.md)).
4. Probe each upstream once (`connect()` → the two-leg model probe — standard `GET {baseUrl}/models` plus the best-effort LM Studio native leg `GET {baseUrl-without-/v1}/api/v0/models`, merged native-first; 10-second budget): the outcome is logged with the upstream id; a failed probe is **not fatal** — the upstream stays registered, and its unavailability surfaces per request. The gateway starts even with unreachable upstreams (see [data-flow.md](../architecture/data-flow.md)).

Target config schema (see [upstreams/README.md](../domains/upstreams/README.md)):

```json
{
  "server": { "listen": "127.0.0.1:8080" },
  "logLevel": "info",
  "upstreams": [
    {
      "id": "openai-main",
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "tlsFingerprint": "K4vmDE8v8SKXajayPc4yMc49GIvJEHyUF8mRo7bu/EM=",
      "proxy": null
    }
  ]
}
```

`baseUrl` is the API root **including** `/v1` (e.g. `https://api.openai.com/v1`), without a trailing slash — the upstream appends the fixed relative paths `chat/completions`, `completions`, `models` itself. The optional `tlsFingerprint` is the upstream's TLS SPKI pin — `base64(SHA-256(SPKI DER))`, computed with `tools/tls-fingerprint.ts`; when set, only the pinned key is accepted (fail closed), and the field is inert on a plain-http `baseUrl` (semantics: [ADR-004](../decisions/004-per-upstream-tls-pinning.md)). The optional `proxy` (`http://host:port` | `socks5://host:port`, explicit port, never credentials) carries every outbound call of the entry through that proxy — `null`/absent is a direct connection (semantics: [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)).

### Timeouts and retries (MVP policy)

- Startup probe (`connect()` → the two-leg `fetchMergedModels()` — the standard `GET {baseUrl}/models` plus the best-effort LM Studio native leg; `listModels()` is the separate one-leg call the ADR-011 listing makes): 10 seconds per upstream; expiry counts as a failed probe (logged, non-fatal).
- Forward timeout (non-streaming): 120 seconds end-to-end — completions are long; no retry on expiry. For streams the same budget applies until upstream response headers arrive.
- Streaming: no whole-request timeout; an idle gap of 300 seconds between SSE chunks aborts the upstream request.
- Pinned connection through a proxy ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)): the `CONNECT` exchange with the proxy has its own 10-second budget (`PROXY_DIAL_TIMEOUT_MS`); the 10-second TLS handshake budget of the pinned path starts once the tunnel is open. An `http://` proxy that is unreachable or times out is an unreachable upstream; one that *refuses* the tunnel is a proxy failure, as is every failed SOCKS dial on the `socks5://` path — the bridge is loopback, so it reports the SOCKS server's refusal, rejection, unreachability or dial timeout as its own marked `502` (see Error Propagation).
- **Retries: none in the MVP.** A failed upstream request is surfaced to the client immediately. Retries are a deliberate non-goal (pure-proxy latency guarantees, no duplicate side effects); introducing them passes the ADR bar.

These are fixed MVP constants, not config fields — making them configurable is a contract change (see Breaking Change Checklist).

## Data Flow Across Boundary

Direction: gateway → provider (request), provider → gateway (response or stream).

```
                      the optional per-entry proxy (ADR-017) sits on every line below:
                      absolute-form for http targets, a CONNECT tunnel for https,
                      http:// natively / socks5:// through the upstream's loopback bridge;
                      a null/absent proxy is a direct line

router ── ProxyRequest{path, body with model rewritten, stream} ──▶ upstream
upstream ── POST {baseUrl}/chat/completions ──▶ [proxy] ──▶ provider
            Authorization: Bearer <config.apiKey>
            Content-Type: application/json   (Accept: text/event-stream when stream)
upstream ◀─ 200 JSON ──────────────────────────── provider            (non-streaming)
upstream ── ForwardResponse{status, body bytes} ──▶ router ──▶ client
upstream ◀─ 200 text/event-stream ─────────────── provider            (streaming)
upstream ── ForwardResponse{body: SSE bytes, verbatim} ──▶ router ──▶ client
```

Rules:

- The request body crosses this boundary semantically unchanged except for the single `model` field, which the router has already rewritten to the selected route's provider-native model (see [client-gateway.md](client-gateway.md)): the dispatch handler buffers the client JSON to read `model` and then re-serializes it — no fields are added, removed, or renamed, and unknown client fields pass through untouched; the byte layout is normalized by the re-serialization (whitespace between tokens, number and unicode formatting).
- Authorization policy: the upstream builds `Authorization: Bearer <apiKey>` from its own config on every upstream call; the client's `Authorization` header never travels upstream — with a configured `clients` block it is first validated by the client Bearer gate at the gateway edge ([ADR-008](../decisions/008-client-bearer-auth.md), [client-gateway.md](client-gateway.md)), and dropped in every mode afterwards. The configured `apiKey` never leaves this boundary in any other form.
- Proxy policy ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)): when the entry has a `proxy`, every outbound call — the three provider paths, both probe legs — goes through it, on the pinned and the unpinned path alike; the proxy URL is the entry's and never carries credentials, and no `Proxy-Authorization` is ever sent. With `null`/absent the line is direct and nothing else about the request changes.
- Only the three fixed paths above are callable upstream — client URLs are never proxied as-is.
- Hop-by-hop headers are never forwarded in either direction.
- Streaming upstream → client is a verbatim byte pass-through: the upstream does not parse SSE events; a client disconnect propagates as an upstream abort (see [openai-compatible.md](../domains/upstreams/openai-compatible.md)).

## Error Propagation

Provider → gateway → client direction; the mapping rules must stay consistent with the Error Propagation table in [client-gateway.md](client-gateway.md#error-propagation):

| Upstream outcome | What crosses back | Client sees |
| ---------------- | ----------------- | ----------- |
| OpenAI-shaped error JSON (any 4xx/5xx) | Status + body proxied unchanged — never wrapped again | Upstream error envelope, byte-for-byte |
| Non-JSON / empty / HTML error body | synthesized `Response` | 502, `type: "api_error"`, `code: "upstream_error"` |
| Connect timeout, connection refused | synthesized `Response` | 504, `type: "api_error"`, `code: "upstream_timeout"` |
| Response timeout (non-streaming) | synthesized `Response` | 504, `type: "api_error"`, `code: "upstream_timeout"` |
| TLS verification failure on a pinned upstream (`tlsFingerprint` configured — [ADR-004](../decisions/004-per-upstream-tls-pinning.md)) | synthesized `Response` | 502, `type: "api_error"`, `code: "upstream_tls_error"` (the fact of the pin mismatch only — no certificate material); without a pin a TLS failure stays `upstream_timeout` |
| The configured outbound proxy refused or failed the connection ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)): a refused `CONNECT` (`ERR_PROXY_TUNNEL` on the fetch path, the upstream's own CONNECT on the pinned path), a SOCKS dial that could not reach the upstream, an unusable proxy URL | synthesized `Response` | 502, `type: "api_error"`, `code: "upstream_proxy_error"` (the fact only — never proxy credentials, never target bytes). An `http://` proxy that is merely down or times out, and a target dead behind a live tunnel, stay `upstream_timeout`; a `socks5://` proxy the bridge could not dial — unreachable, refusing, or cut by its dial timeout — is that marked `502`, hence this row; a pin decision through a proxy stays `upstream_tls_error` |
| Idle timeout mid-stream | Upstream aborted; SSE response simply ends | Stream ends — no JSON error after SSE started |
| `listModels()` failure | The startup probe logs a warning (the entry keeps serving; `/api/status` carries no probe state). At request time only the ADR-011 operator listing calls it — that answers the 502 `upstream_error` envelope | `/llm/v1/models` is unaffected — it is the alias catalog and never calls `listModels()` ([ADR-009](../decisions/009-alias-table-routing.md)) |

The upstream never invents success: any upstream outcome that is not a well-formed 2xx response is propagated per the table, and the gateway core performs no retry on any of these outcomes (MVP: no retries).

## Breaking Change Checklist

Derived from the actual coupling of this boundary:

1. **Config schema (`upstreams[].id` / `type` / `baseUrl` / `apiKey` / `tlsFingerprint` / `proxy`)** couples the config loader, startup validation, README examples, and [client-gateway.md](client-gateway.md) examples. Any key rename, type change, or new required field must update all of them in one change; changing the config file format itself (JSON) is cross-cutting and passes the ADR bar. The `tlsFingerprint` semantics (pin format, fail-closed enforcement, `upstream_tls_error`) are fixed by [ADR-004](../decisions/004-per-upstream-tls-pinning.md) — changing them rewrites that ADR in place first. The `proxy` grammar (schemes, explicit port, no credentials) and its transport (`fetch({ proxy })` / the socks5 bridge, `upstream_proxy_error`) are fixed by [ADR-017](../decisions/017-per-upstream-outbound-proxy.md) — same rule.
2. **`baseUrl` semantics** (API root including `/v1`; the upstream appends the fixed relative paths) — changing what the URL must contain (e.g. dropping `/v1` and hardcoding it inside upstreams) changes path construction in every upstream and every documented example; requires a migration note and updates to [upstreams/README.md](../domains/upstreams/README.md) plus this contract.
3. **Upstream `id` grammar (`[a-z0-9][a-z0-9-]*`)** couples registry keys and the `models[].routes[].upstream` references the routing table resolves — always change together with item 1 of [client-gateway.md](client-gateway.md#breaking-change-checklist) and [routing.md](../domains/routing.md).
4. **`Upstream` interface signature** couples every upstream implementation, the registry, and the router call sites — update [routing.md](../domains/routing.md) and [upstreams/README.md](../domains/upstreams/README.md) in the same change.
5. **`type` discriminator `"openai-compatible"` and its semantics** — changing the meaning of an existing type breaks deployed configs (update this contract + [upstreams/README.md](../domains/upstreams/README.md)); adding a new provider type is an extension point and changes nothing here.
6. **Authorization policy** (the config `apiKey` is the only upstream credential; the client `Authorization` header is validated at the edge when clients are configured ([ADR-008](../decisions/008-client-bearer-auth.md)) and never forwarded) — any change must update [client-gateway.md](client-gateway.md) and [security-model.md](../architecture/security-model.md). The outbound proxy adds a second credential-free channel ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)): a proxy URL never carries userinfo and `Proxy-Authorization` is never sent — admitting proxy credentials changes this policy, the config grammar, and [security-model.md](../architecture/security-model.md) together.
7. **No-retry invariant and timeout constants** — introducing retries contradicts a documented invariant and passes the ADR bar; making timeouts configurable changes the config schema (see item 1).
