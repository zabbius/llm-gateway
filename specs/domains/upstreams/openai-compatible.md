# OpenAI-Compatible Upstream

## Role

The MVP provider upstream: a pure HTTP proxy in front of any provider API that speaks the OpenAI protocol (base URL + API key), relaying requests and responses — including SSE streams — unchanged.

## Key Files

- `src/upstreams/openai-compatible.ts` — `OpenAICompatibleUpstream`: proxying, header policy, timeouts, model-entry normalization (`toModelEntry`), the pinned upstream path (`upstreamFetch`), the outbound-proxy resolution and failure mapping (`proxyFetchUrl`, `dispose`, `upstream_proxy_error`)
- `src/upstreams/tls-pinning.ts` — the TLS SPKI pinning module it enforces the pin with: `pinnedUpstreamRequest`, `assertPinnedCertificate`, `computeSpkiPin`, the bare-handshake probe for the fingerprint CLI (`fetchLeafCertificate`, `probePinnedLeaf`), `UpstreamTlsPinError`
- `src/upstreams/proxy.ts` — the outbound-proxy transport primitives (ADR-017): `parseProxyUrl` (the defensive second parse), `resolveProxyTransport` (http: as-is, socks5: through a bridge), `openConnectTunnel` (the pinned path's CONNECT), `UpstreamProxyError`, `PROXY_DIAL_TIMEOUT_MS`
- `src/upstreams/socks-bridge.ts` — the per-upstream loopback HTTP→SOCKS5 bridge behind a `socks5://` proxy (`SocksBridge`), and the dial-failed marker header the upstream maps to `upstream_proxy_error`

## Behavior

### Upstream mapping

- `baseUrl` — absolute `http(s)` URL including the API root with `/v1` (e.g. `https://api.openai.com/v1`); a single trailing slash is stripped at config load.
- Upstream URL = `baseUrl + "/" + ProxyRequest.path` (`chat/completions`, `completions`, `models`).
- `listModels()` calls `GET {baseUrl}/models` and returns provider-native entries with unprefixed ids, verbatim; the client-facing model namespace is the gateway's alias catalog ([ADR-009](../../decisions/009-alias-table-routing.md)), so these entries surface only through the startup probe and the ADR-011 operator listing.

### The two-leg model probe (`connect()` / `discover()`)

The startup probe — and the optional on-demand re-probe `discover()`, which shares the same fetch+merge helper — runs two legs in parallel (the wait is the slower leg, not the sum) and merges the answers native-first by exact id: the native entries lead the merged list, and a native entry shadows the standard-leg twin with the same exact id (standard entries the native leg did not already provide follow).

| Leg | Request | Budget | Failure behavior |
| --- | ------- | ------ | ---------------- |
| standard (probe of record) | `GET {baseUrl}/models` | `CONNECT_PROBE_TIMEOUT_MS` | fails the probe — log-safe rejection |
| LM Studio native | `GET {baseUrl without the trailing `/v1`}/api/v0/models` | `CONNECT_PROBE_TIMEOUT_MS` | silent skip (debug log) — never fails the probe |

The native leg targets LM Studio's own REST API root (the config `baseUrl` minus its trailing `/v1` segment; a `baseUrl` without the suffix probes `{baseUrl}/api/v0/models` as-is), carries the configured `apiKey` as its only credential, and reads its answer bounded at 1 MiB. Any 4xx/5xx, transport failure, timeout, over-bound body, or unparseable answer silently skips the leg — a provider without the LM Studio native REST API (plain OpenAI et al.) probes through the standard leg alone. `listModels()` is unchanged: a single standard leg, no native request, no merge.

`discover()` resolves with freshly fetched entries and never writes the startup snapshot (`status()` keeps exactly what `connect()` retained); it rejects with a log-safe reason when the standard leg fails — a failing native leg alone is always a silent skip.

### Header policy

| Direction | Header | Value |
| --------- | ------ | ----- |
| out | `Authorization` | `Bearer {config.apiKey}` — always taken from config |
| out | `Content-Type` | relayed from the client request |
| out | `Accept` | relayed from the client request |
| in → client | all upstream response headers | relayed unchanged (the transport strips hop-by-hop headers) |

The client's own `Authorization` header is dropped — the configured `apiKey` is the only credential that ever reaches the provider API.

### SSE pass-through

When the upstream response has `Content-Type: text/event-stream`:

- the response status and headers are relayed unchanged;
- body chunks are written to the client as they arrive — no buffering, no reordering, no parsing of `data:` frames;
- a client disconnect aborts the upstream request.

### TLS pinning (`tlsFingerprint`) — ADR-004

A non-empty `tlsFingerprint` on the config entry switches the upstream's only upstream fetch (`upstreamFetch` — shared by `forward()` and `fetchModels()`) to the pinned path; `http` baseUrls and absent / `null` / `""` pins keep the plain fetch (the config grammar normalizes `null` and `""` to absent and refuses whitespace-only — [ADR-018](../../decisions/018-uniform-optional-value-write-policy.md); a normalized entry carries either a full pin or no key, [Configuration](../configuration.md); the module keeps its own non-empty guard, so a directly constructed entry with `""` is unpinned as well):

```
upstreamFetch on a pinned upstream (https baseUrl) — pinnedUpstreamRequest:
  open the TLS connection (rejectUnauthorized: false — a pinned chain
      │           need not be publicly trusted)
      │ secureConnect
      ▼
  assertPinnedCertificate: SPKI pin vs config — a mismatch fails closed,
      │           BEFORE any request byte (credentials never reach a
      │           mismatching upstream)
      │ match
      ▼
  node:http request over the verified socket (createConnection)
      │ response
      ▼
  standard Response (streaming body, SSE included)
      │
      ▼
  relay / mapped failure (upstream_tls_error on a pin decision)
```

Properties that hold on this path:

- The pin is `base64(SHA-256(SPKI DER))` — the certificate key is the identity; hostname, CA web-of-trust, and the rest of the certificate chain play no role, so self-signed and internal-PKI upstreams work even when the server presents its leaf without intermediates. A certificate renewed with the same key pair keeps matching; a key change fails closed.
- Every pinned request verifies its own connection and nothing is cached between requests: the next request always checks the certificate the upstream serves right now.
- The pinned path does not pool connections — each request pays its own TLS handshake.
- A pin on a plain-http `baseUrl` stays valid config but is never enforced.

### Outbound proxy (`proxy`) — ADR-017

A configured `proxy` — `http://host:port` or `socks5://host:port`, [ADR-017](../../decisions/017-per-upstream-outbound-proxy.md) — carries **every** outbound call of the upstream through that proxy: `forward()`, both probe legs of `connect()` / `discover()`, and `listModels()`, on the pinned and the unpinned path alike. `null` / absent means a direct connection — the pre-existing behavior, byte for byte. The proxy URL never carries credentials (the config grammar rejects userinfo), so nothing about it is secret.

**Resolution — lazy.** The constructor only reads `config.proxy`. The transport is resolved on the first outbound call (`resolveProxyTransport`, `src/upstreams/proxy.ts`) and retained:

| Configured scheme | Transport | What `fetch` is handed |
| ----------------- | --------- | ---------------------- |
| `http://` | Bun's native proxy support | the proxy URL itself — `fetch(url, { ...init, proxy })` |
| `socks5://` | a per-upstream loopback HTTP→SOCKS5 bridge (`src/upstreams/socks-bridge.ts`, `Bun.listen` on `127.0.0.1:0`) started at resolution | the bridge's `http://127.0.0.1:<port>` — the bridge dials the SOCKS5 server (RFC 1928, no-auth) for every request |

The bridge starts with the first request, never at construction — an upstream whose provider is never contacted never listens — and stops with the instance (`dispose()`), which the registry calls when a runtime CRUD write replaces or removes it ([ADR-014](../../decisions/014-runtime-management-crud.md)) and, in config order, on every instance at shutdown. A `proxy` value that fails its defensive re-parse rejects that call with `UpstreamProxyError` (the config grammar already refused every such value at startup — this is the second gate, not a second grammar).

**Unpinned path.** Without a `tlsFingerprint` — or on a plain-http `baseUrl` — the request is plain `fetch` with the proxy option added and nothing else changed: an `http://` target travels in absolute-form (`GET http://host:port/path HTTP/1.1`) for the proxy to forward; an `https://` target travels through a `CONNECT host:port` tunnel the runtime opens itself, after which TLS runs end to end between the gateway and the origin (system-CA verification unchanged — the proxy sees ciphertext only).

**Pinned path.** With a `tlsFingerprint` on an `https` `baseUrl` the request runs over the pinned connection exactly as above; a configured proxy changes only where the TCP socket comes from:

```
pinned upstream through a proxy — openPinnedSocket:
  openConnectTunnel(target, proxy)        proxy.ts: net.connect to the proxy,
      │           CONNECT host:port HTTP/1.1 — only a 200 hands the socket back
      │           (PROXY_DIAL_TIMEOUT_MS budget; a refusal is UpstreamProxyError,
      │            an unreachable proxy a plain error)
      ▼
  tls.connect({ socket: tunnel, servername, rejectUnauthorized: false })
      │ secureConnect
      ▼
  assertPinnedCertificate — the same fail-closed check, still BEFORE any request byte
      │ match
      ▼
  node:http request over the verified socket → standard Response (SSE included)
```

A `socks5://` proxy on the pinned path goes through the bridge the same way: the CONNECT is sent to the bridge's loopback URL, the bridge dials through SOCKS5 and relays the tunnel bytes, and the TLS handshake and the pin check stay between the gateway and the origin.

**Logging.** The bridge logs its lifecycle through the upstream's child logger — `socks bridge listening` / `socks bridge stopped` (info, with the proxy's scheme/host:port). Every proxy failure the upstream maps logs one error line with `code: "upstream_proxy_error"`, the log-safe `reason`, and the proxy's `{ scheme, host, port }` — never credentials (there are none) and never request bytes.

### Timeouts

| Constant | Default | Applies to |
| -------- | ------- | ---------- |
| `CONNECT_PROBE_TIMEOUT_MS` | `10 000` | both legs of the model probe inside `connect()` and `discover()` |
| `PIN_PROBE_TIMEOUT_MS` | `10 000` | the TLS handshake budget of one pinned upstream connection (starting once the socket — direct or tunnelled — exists) |
| `PROXY_DIAL_TIMEOUT_MS` | `10 000` | the CONNECT exchange with an http proxy on the pinned path (`proxy.ts`): TCP connect to the proxy plus its status line |
| `SOCKS_DIAL_TIMEOUT_MS` | `10 000` | the bridge's dial through the SOCKS5 server to the target (`socks-bridge.ts`): TCP connect + greeting + CONNECT reply; a stall is cut and reported as a dial failure |
| `FORWARD_TIMEOUT_MS` | `120 000` | non-streaming `forward()` end-to-end; for streams — until upstream response headers arrive |
| `STREAM_IDLE_TIMEOUT_MS` | `300 000` | once streaming: maximum silence between chunks (no total cap) |

Forward timeout expiry maps to the upstream-unreachable error path (`504`, `code: "upstream_timeout"`), including for streams that stall before response headers arrive; an idle-stream expiry ends the SSE response. A failed probe at startup is logged and does not abort. An `http://` proxy that is unreachable or times out during CONNECT is likewise unreachable — `504 upstream_timeout`; a proxy that *refuses* CONNECT is a proxy failure — `502 upstream_proxy_error`. On the `socks5://` path the bridge is loopback, so its own dial through the SOCKS server is the only thing that can fail: every such failure — refused, rejected, unreachable, or cut by `SOCKS_DIAL_TIMEOUT_MS` — is the marked `502`, hence `upstream_proxy_error`.

## Error Handling

- Upstream answered (`4xx`/`5xx`) — status, headers, and body relayed to the client unchanged; the gateway adds nothing.
- Upstream unreachable, DNS failure, timeout — the upstream synthesizes `504` with the OpenAI error envelope:

```json
{ "error": { "message": "upstream \"openai\" is unreachable: timeout",
             "type": "api_error",
             "code": "upstream_timeout" } }
```

- Upstream answered with a non-JSON, empty, or HTML error body — the upstream synthesizes `502` with `type: "api_error"`, `code: "upstream_error"`, since the payload is not a relayable OpenAI error.

- Upstream TLS verification failure on a pinned upstream (`tlsFingerprint` configured) — the upstream synthesizes `502` with `type: "api_error"`, `code: "upstream_tls_error"` ([ADR-004](../../decisions/004-per-upstream-tls-pinning.md)):

```json
{ "error": { "message": "upstream \"lan\" TLS certificate does not match the configured tlsFingerprint pin",
             "type": "api_error",
             "code": "upstream_tls_error" } }
```

  The message states the fact of the pin mismatch and never certificate bytes, subject, or DNS names; the failure is logged at error level (code + reason). Without a pin, a TLS failure keeps the pre-existing mapping — unreachable upstream, `504 upstream_timeout`.

- The configured outbound proxy refused or failed the connection ([ADR-017](../../decisions/017-per-upstream-outbound-proxy.md)) — a refused `CONNECT` (Bun's `ERR_PROXY_TUNNEL` on the fetch path, the upstream's own CONNECT on the pinned path), a SOCKS dial that could not reach the upstream (the bridge's marked `502`), or an unusable proxy URL — the upstream synthesizes `502` with `type: "api_error"`, `code: "upstream_proxy_error"`:

```json
{ "error": { "message": "upstream \"openai\" is unreachable through its configured proxy",
             "type": "api_error",
             "code": "upstream_proxy_error" } }
```

  The message states the fact for the client and names neither credentials nor the target's bytes; the error log line carries the proxy's scheme/host:port. A proxy that is merely *down* is **not** a proxy failure when it is an `http://` proxy — the upstream is unreachable, `504 upstream_timeout` — and neither is a target that dies behind a live tunnel (the proxy did its job); a `socks5://` proxy the bridge could not dial is the marked `502` above, whatever the SOCKS server's failure. A pin decision through a proxy keeps `502 upstream_tls_error`. The probe legs name the proxy in their rejection (`upstream "…" is unreachable: proxy failure: …`), so the retained probe `reason` says where the request stopped.

- The upstream performs a single attempt per client request — no retries in the MVP (retry policy is future work).

## Invariants

- Every outbound request carries exactly one credential: the configured `apiKey` as a `Bearer` token; a client-supplied `Authorization` header is never forwarded.
- `apiKey` never appears in logs or in any response returned to a client.
- SSE bodies reach the client byte-for-byte in arrival order; a streaming response never waits for the full body before relaying its first byte.
- Upstream error responses are relayed with their original status code.
- A configured `tlsFingerprint` always fails closed: a pin mismatch — checked on every pinned connection before any request byte is written — surfaces as `502 upstream_tls_error` and never as a relayed response or a degraded-verification success ([ADR-004](../../decisions/004-per-upstream-tls-pinning.md)).
- At most one upstream attempt happens per client request.
- The LM Studio native probe leg is best-effort: any of its failures silently skips the leg (debug), and only the standard leg can fail `connect()` or `discover()`; `discover()` never writes the startup snapshot.
- A configured `proxy` carries every outbound call of the upstream — forwards, both probe legs, listings — on the pinned and the unpinned path alike; a proxy URL never carries credentials, and no `Proxy-Authorization` is ever sent ([ADR-017](../../decisions/017-per-upstream-outbound-proxy.md)).
- Through a proxy the pin check still precedes every request byte: the CONNECT tunnel supplies only the TCP socket, the TLS handshake and the pin decision happen over it, so a mismatching upstream never receives a byte of the request.
- A proxy failure is reported as what it is — `502 upstream_proxy_error` — never as a relayed upstream verdict, a timeout, or a pin decision; an unreachable or timed-out `http://` proxy, or a dead target behind a live tunnel, stays `504 upstream_timeout`, while a `socks5://` proxy the bridge could not dial is the marked `502` — this very code.
- A `socks5://` bridge listens on loopback only, starts with the first outbound call, and stops with its instance (`dispose()`).

## Related Specs

- [Upstreams](./README.md) — domain overview and registry
- [Upstream contract](./upstream-contract.md) — interface and lifecycle this module implements
- [Configuration](../configuration.md) — `baseUrl` / `apiKey` / `tlsFingerprint` / `proxy` validation rules
- [Observability](../observability.md) — what this upstream logs per level (never secrets)
- [ADR-004: per-upstream TLS SPKI pinning](../../decisions/004-per-upstream-tls-pinning.md) — the decision behind the pinned path this module implements
- [ADR-017: per-upstream outbound proxy](../../decisions/017-per-upstream-outbound-proxy.md) — the `proxy` field and the transport this module honors it with
