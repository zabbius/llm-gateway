# ADR-017: Per-upstream outbound proxy

## Status

Accepted

## Context

Every upstream request leaves the process directly: the `openai-compatible` upstream calls `fetch` from the gateway host to the provider's `baseUrl`, and nothing in the config can route that connection through anything else. An operator behind a corporate egress proxy — or reaching a provider only through a forward proxy — cannot use the gateway for that provider without a process-wide trick (an `HTTP_PROXY`-style environment variable, which Bun's `fetch` does not honor, or a transparent network layer). A process-wide switch is also the wrong shape for this gateway: it fronts many providers behind one surface, and the egress path is a property of the connection — a corporate proxy for a cloud provider, a direct connection for a local Ollama — not of the process.

Measured on Bun 1.4.5 (2026-11-28), the runtime this MVP targets: `fetch(url, { proxy })` accepts `http:` / `https:` proxy URLs only; a `socks5://` proxy is rejected with the error code `UnsupportedProxyProtocol` before any connection is attempted; and an HTTP proxy that answers the `CONNECT` request with a refusal makes `fetch` fail with `ERR_PROXY_TUNNEL` ("Proxy refused to open a tunnel: <status>"). None of these is a config-parse concern — they are request-time outcomes the upstream layer reports.

## Decision

Add an optional `proxy` field to every `upstreams[]` entry — the connection's egress path, validated by the config grammar in `src/config/schema.ts` (`UPSTREAM_KEYS`, `normalizeProxy`, `isValidProxyUrl`) exactly like `baseUrl` and `tlsFingerprint`, and honored by the upstream for every outbound request of that connection — forwards, both probe legs, listings: an `http://` value is handed to `fetch` as its `proxy` option; a `socks5://` value is handed as the URL of a per-upstream loopback HTTP→SOCKS5 bridge (`src/upstreams/socks-bridge.ts`, `src/upstreams/proxy.ts`) that dials the SOCKS5 server, resolved lazily on the first outbound call; on the pinned path (`tlsFingerprint` set) the TLS socket instead comes from a `CONNECT` tunnel through the proxy (`openConnectTunnel`), the pin check unchanged:

- Absent, `null`, empty or whitespace-only → a direct connection; the normalized config carries no `proxy` key.
- Otherwise the value is a string, stored trimmed, that must parse with `new URL` into scheme `http:` or `socks5:`, a non-empty host, an explicit port in 1–65535, no username/password, and no path (beyond `/`), query or fragment. `https:` proxy URLs and every other scheme are rejected. The port must be written: `new URL` elides a port equal to the scheme default (`http://proxy:80` → `port ""`), so the grammar reads the authority and accepts an explicit `:80`.
- Proxy credentials are not admitted: a `user:pass@` URL is a config error. Credentials never enter `config.json` through this field ([security-model.md](../architecture/security-model.md) — the two-place storage rule), and a problem line names the key and the rule but never the value, so a pasted `user:pass@` URL cannot reach stderr or a log.
- The grammar accepts `socks5:` although Bun 1.4.5's `fetch` does not honor it: the config contract describes the proxy URL space, not one HTTP client's capability, and a later runtime upgrade must not need a schema change. The upstream layer bridges the gap rather than reporting a failure (Consequences).

`config.example.json` carries `"proxy": null` on every upstream entry (the exact-key-coverage test enforces it), and [configuration.md](../domains/configuration.md) documents the field, its validation errors and the masked-view shape.

## Consequences

- An operator routes one provider through a forward proxy and leaves the others direct, per entry, with no process-wide side effects; the example's `null` documents the default (direct).
- Validation fails loudly at startup on every malformed proxy URL — a typo never surfaces as a request-time mystery — and the rule line is value-free, so a credential-bearing paste is diagnosed without leaking it.
- `socks5:` values are honored on Bun 1.4.5 through the bridge: a loopback-only HTTP proxy (`127.0.0.1:0`, one per upstream) whose every dial goes through the configured SOCKS5 server (RFC 1928, no-auth), started with the upstream's first outbound call and stopped by its `dispose()` when a runtime CRUD write retires the instance or the gateway shuts down. The bridge answers a failed SOCKS dial with a marked `502`; a native SOCKS-capable client would only remove the bridge, never change the config.
- An HTTP proxy that refuses `CONNECT` surfaces as `ERR_PROXY_TUNNEL` on the fetch path and as the upstream's own `UpstreamProxyError` on the pinned path; an `http://` proxy that is down or times out is plain unreachability (504 `upstream_timeout`) — a dead target behind a live tunnel likewise. A `socks5://` proxy is different by construction: the gateway always reaches its own loopback bridge, and the bridge reports every failed SOCKS dial — refused, rejected, unreachable, or cut by its dial timeout — as the marked `502`, so that case is `upstream_proxy_error`, never a timeout.
- No proxy credentials yet: an operator who needs an authenticated proxy cannot express it. The field's shape leaves room for a dedicated credential source (an environment variable or secret reference) later without relaxing the grammar's rejection of inline userinfo.
- One new client-visible error code: a proxy that refused or failed the connection is `502 upstream_proxy_error` — distinct from `upstream_timeout`, so an operator can tell "the proxy said no" from "the upstream did not answer", and from `upstream_tls_error`, so a pin decision through a proxy is still reported as the pin's. The message names the fact only; the log line carries the proxy's scheme/host:port. (`UnsupportedProxyProtocol` can no longer occur for an admitted scheme — `socks5:` goes through the bridge — but the code stays mapped as a proxy failure.)

## Alternatives Considered

- **A process-wide proxy (environment variable or a `server.proxy` block)** — rejected: egress is a property of the connection, not the process; a global switch forces every provider through the same proxy and cannot express "cloud via proxy, local Ollama direct". Bun's `fetch` does not honor `HTTP_PROXY` anyway.
- **Inline proxy credentials (`http://user:pass@host:port`)** — rejected: they would land in `config.json` in clear text and could leak through problem lines; the grammar rejects userinfo outright and defers authenticated proxies to a dedicated credential source.
- **Reject `socks5:` at config time because Bun 1.4.5 cannot honor it** — rejected: the grammar would encode a transient runtime limitation; it accepts the scheme, and the upstream's bridge honors it on the runtime as it stands, so a native client later needs no schema change.
- **Accept the scheme's default port implicitly (`http://proxy` meaning `:80`)** — rejected: the explicit-port rule keeps every proxy URL unambiguous and the grammar strict — a missing port is a typo, not a default.
