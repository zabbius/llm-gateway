# Architecture: Security Model

## Context

The gateway is a credential custodian: it holds provider API keys that clients must never see, and it forwards untrusted client traffic to trusted upstreams. On MVP there is no client authentication — gateway-auth is a documented TODO (see the request lifecycle in [data-flow.md](./data-flow.md)) — so the active protections are exactly the ones in this document: key storage rules, log redaction, and the trust boundaries. They must hold even while the auth stage is a no-op.

## Trust Boundaries

```
     UNTRUSTED                                TRUSTED
+------------------+                +------------------+
|     clients      |                |     upstream     |
| arbitrary        |                |    providers     |
| request bodies   |                |   authenticated  |
| unknown identity |                |  by provider key |
+------------------+                +------------------+
        |                                    ^
        | HTTP                               | HTTPS + provider key
        | no client auth on MVP              | credentials from config only
        v                                    |
+------------------------------------------------------------------+
|                             gateway                              |
|  request stages: auth (TODO on MVP) -> route -> prefix ->        |
|  adapter -> proxy stream; key storage + log redaction rules      |
+------------------------------------------------------------------+
```

- Inbound: every client request is untrusted regardless of route. On MVP the auth stage is a no-op placeholder; while it is, the listener binds to loopback or a private interface only.
- Outbound: the gateway authenticates to upstreams only with credentials from its config; client-supplied credentials never travel upstream. A configured `tlsFingerprint` narrows that trust further: the pinned upstream is identified by its SPKI key alone — fail-closed probe, leaf-anchored chain, per-connection pin veto ([ADR-005](../decisions/005-per-adapter-tls-pinning.md)) — and its chain need not be publicly trusted. Without a pin, the system CA pool plus hostname verification decide; there is deliberately no third mode that accepts an arbitrary certificate.
- The upstream is trusted to answer OpenAI-dialect requests — and trusted with no more client data than the request itself carries.

## Provider Keys

- Provider API keys exist in exactly two places: the config file and the in-memory field of their adapter instance.
- Keys enter the process only via the config file (kept out of version control); the config path comes from the `LLM_GATEWAY_CONFIG` environment variable (default `./config.json`), key material never does.
- Key flow: config → adapter field → provider credential header on upstream calls. No other component reads the field.
- `GET /v1/models` and error responses expose model ids and statuses only — never keys, never adapter credentials.

## Redaction in Logs

- Logging is leveled (trace/debug/info/warning/error/none) and writes to stderr. The logging layer redacts a fixed set of sensitive fields (authorization, x-api-key, api-key, cookie, token) before emitting any line, at every level including trace.
- Startup logs adapter ids and types; the raw config is never dumped, and key material never reaches a log line.
- Adapters log upstream interactions as metadata (method, host, status, byte counts). Request and response bodies appear only at trace/debug and only after redaction.
- Upstream error text is redacted before logging: provider error payloads sometimes echo request headers.

## Invariants

1. Provider API keys are stored in exactly two places: the config file and the in-memory field of their adapter instance.
2. No provider key, client credential, or sensitive header value ever appears in a log line, an HTTP response body, or an error message the gateway emits.
3. The logging layer redacts sensitive field values before emission, at every level including trace.
4. Adapters attach their own credentials at the upstream boundary; client-supplied authorization headers are never forwarded upstream.
5. The auth stage precedes routing and adapter invocation in the request lifecycle; on MVP it is a no-op TODO, and no code path reaches an adapter without passing through it.
6. While gateway-auth is unimplemented, the listener binds only to loopback or a private interface.
7. Startup logging names adapters (id, type) but never prints key material or the raw config.
8. A configured `tlsFingerprint` always fails closed on a pin mismatch — a pinned upstream that presents any other key surfaces as `502 upstream_tls_error`, never as a relayed response or a warning-and-continue ([ADR-005](../decisions/005-per-adapter-tls-pinning.md)).

## Anti-Patterns

- Hardcoding a provider key or base URL in adapter source "just for a local test" — keys enter the process only through the config file; a committed test key is a leaked key.
- Forwarding client headers wholesale to the upstream — header pass-through excludes authorization and hop-by-hop headers; the adapter injects its own credentials.
- Logging full upstream request/response bodies at info level "to debug faster" — bodies live at trace/debug after redaction; info stays metadata-only.
- Putting key material into an error surface ("upstream rejected key sk-...") — errors carry statuses and provider messages, never credentials.
- Implementing gateway-auth inside individual adapters (each adapter checking client keys) — auth is one pre-routing stage; per-adapter auth duplicates checks and spreads credential logic into provider code.
- Adding a skip-verification fetch path (`rejectUnauthorized: false`) to "make self-signed upstreams work" — the only non-default acceptance path is the pinned one ([ADR-005](../decisions/005-per-adapter-tls-pinning.md)); a flag that accepts any certificate is a standing MITM window.
- Exposing the MVP listener publicly "temporarily" before gateway-auth lands, or shipping provider keys to the future admin SPA — the admin surface receives aggregates and statuses, never key material.
