# OpenAI-Compatible Upstream

## Role

The MVP provider upstream: a pure HTTP proxy in front of any provider API that speaks the OpenAI protocol (base URL + API key), relaying requests and responses — including SSE streams — unchanged.

## Key Files

- `src/upstreams/openai-compatible.ts` — `OpenAICompatibleUpstream`: proxying, header policy, timeouts, model mapping, the pinned upstream path (`upstreamFetch`)
- `src/upstreams/tls-pinning.ts` — the TLS SPKI pinning module it enforces the pin with: `pinnedUpstreamRequest`, `assertPinnedCertificate`, `computeSpkiPin`, the bare-handshake probe for the fingerprint CLI (`fetchLeafCertificate`, `probePinnedLeaf`), `UpstreamTlsPinError`

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

A non-empty `tlsFingerprint` on the config entry switches the upstream's only upstream fetch (`upstreamFetch` — shared by `forward()` and `fetchModels()`) to the pinned path; `http` baseUrls and absent/empty pins keep the plain fetch:

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

### Timeouts

| Constant | Default | Applies to |
| -------- | ------- | ---------- |
| `CONNECT_PROBE_TIMEOUT_MS` | `10 000` | both legs of the model probe inside `connect()` and `discover()` |
| `PIN_PROBE_TIMEOUT_MS` | `10 000` | the TLS handshake budget of one pinned upstream connection |
| `FORWARD_TIMEOUT_MS` | `120 000` | non-streaming `forward()` end-to-end; for streams — until upstream response headers arrive |
| `STREAM_IDLE_TIMEOUT_MS` | `300 000` | once streaming: maximum silence between chunks (no total cap) |

Forward timeout expiry maps to the upstream-unreachable error path (`504`, `code: "upstream_timeout"`), including for streams that stall before response headers arrive; an idle-stream expiry ends the SSE response. A failed probe at startup is logged and does not abort.

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

- The upstream performs a single attempt per client request — no retries in the MVP (retry policy is future work).

## Invariants

- Every outbound request carries exactly one credential: the configured `apiKey` as a `Bearer` token; a client-supplied `Authorization` header is never forwarded.
- `apiKey` never appears in logs or in any response returned to a client.
- SSE bodies reach the client byte-for-byte in arrival order; a streaming response never waits for the full body before relaying its first byte.
- Upstream error responses are relayed with their original status code.
- A configured `tlsFingerprint` always fails closed: a pin mismatch — checked on every pinned connection before any request byte is written — surfaces as `502 upstream_tls_error` and never as a relayed response or a degraded-verification success ([ADR-004](../../decisions/004-per-upstream-tls-pinning.md)).
- At most one upstream attempt happens per client request.
- The LM Studio native probe leg is best-effort: any of its failures silently skips the leg (debug), and only the standard leg can fail `connect()` or `discover()`; `discover()` never writes the startup snapshot.

## Related Specs

- [Upstreams](./README.md) — domain overview and registry
- [Upstream contract](./upstream-contract.md) — interface and lifecycle this module implements
- [Configuration](../configuration.md) — `baseUrl` / `apiKey` / `tlsFingerprint` validation rules
- [Observability](../observability.md) — what this upstream logs per level (never secrets)
- [ADR-004: per-upstream TLS SPKI pinning](../../decisions/004-per-upstream-tls-pinning.md) — the decision behind the pinned path this module implements
