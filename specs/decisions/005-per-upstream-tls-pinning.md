# ADR-005: Per-Upstream TLS SPKI Pinning (`tlsFingerprint`)

## Status

Accepted

## Context

A growing share of upstream LLM deployments lives behind self-signed or internal-PKI certificates (in-cluster inference servers, `llm.lan`-style gateways). The gateway's default outbound verification — the system CA pool inside `fetch` — fails closed on such upstreams, so they surface as plain unreachability (`504 upstream_timeout`) with no legitimate way to connect. The operationally honest options are to pin the upstream's key or to disable verification; disabling wholesale is a standing MITM window and contradicts the trust model (`specs/architecture/security-model.md`).

The parent deployment (c0wrk) faced the same question and answered it with ADR-054: pin the upstream certificate's SPKI digest per connection. This gateway adopts the same pin semantics and field name (`tlsFingerprint`) as that decision, so operators can reuse their pins and their runbooks across both systems.

There is also a mechanism constraint. Empirically, on Bun 1.4.4, `fetch`'s TLS layer cannot express "accept the pinned key and nothing else": the `tls.checkServerIdentity` callback never runs when chain verification fails first, and a non-self-signed leaf handed to `tls.ca` cannot anchor its own chain — so an upstream that presents its leaf without a full chain (the common internal-PKI deployment) is unpinnable through fetch at all. Any pinning design on Bun must therefore open the upstream connection itself and enforce the pin on that connection, outside fetch's TLS layer.

## Decision

The `upstreams[]` config entries gain an optional `tlsFingerprint` field: `base64(SHA-256(SPKI DER))` of the upstream certificate's public key — the RFC 7469 / Chromium CertificatePinList construction, so a pin stays valid across certificate renewals as long as the key pair is reused. Validation (in `src/config/schema.ts`) accepts standard-alphabet base64 decoding to exactly 32 bytes, tolerates and strips whitespace, and never echoes the value into a problem line. Absent or empty means no pin: default system-CA verification, byte-identical to pre-ADR behavior.

A configured pin means exactly one thing, with no softer mode: **only the pinned key is accepted, and every mismatch fails closed.** The mechanism (`src/upstreams/tls-pinning.ts`, enforced by `OpenAICompatibleUpstream.upstreamFetch`, verified empirically on Bun 1.4.4) has three parts:

1. **Pinned connection** — the upstream opens the TLS connection itself (`node:tls.connect`, verification disabled: a pinned chain need not be publicly trusted), reads the served leaf certificate, and refuses the connection unless its pin matches the configuration — before any request byte, hence any credential, is written.
2. **Plain HTTP over the verified socket** — the request then runs over that socket via `node:http` (`createConnection`), and the response surfaces as the same `Response` the unpinned fetch path returns: relay semantics, SSE streaming included, are unchanged.
3. **No state** — every pinned request verifies its own connection; nothing is cached between requests. A certificate renewed with the same key pair keeps matching the pin, a key change fails closed on the next request. A pinned request is a single attempt — a failed pinned connection surfaces its mapped error and never retries within the same client request (`specs/contracts/gateway-upstream.md`).

A TLS verification failure on a pinned upstream is its own client-visible fact: a synthesized `502` envelope with `type: "api_error"`, `code: "upstream_tls_error"` (`src/httpapi/errors.ts`), whose message states the fact of the mismatch and nothing else — no certificate bytes, subject, or DNS names. Without a pin, TLS failures keep the pre-existing `504 upstream_timeout` mapping. A pin on a plain-http `baseUrl` stays valid config but is inert.

A companion script, `tools/tls-fingerprint.ts`, prints the pin of an https endpoint (`bun tools/tls-fingerprint.ts <url>`) and verifies one fail-closed (`--expect <pin>`); it reuses the same TLS module rather than duplicating any of its logic.

## Consequences

Positive:

- Self-signed and internal-PKI upstreams become usable through one config field, without ever disabling verification: there is deliberately no mode that accepts an arbitrary certificate.
- Pins survive routine certificate renewal on the same key pair — rotation of the certificate does not break the config; rotation of the key does, by design, until the operator re-pins.
- Every mismatch fails closed at the single decision point — the per-connection pin check, enforced before any request byte is written — and reports exactly one new error code clients can branch on.
- No-pin behavior and plain-http behavior are byte-identical to the pre-ADR gateway.

Negative:

- Key rotation on a pinned upstream breaks the upstream until the operator recomputes and redeploys the pin — an intentional maintenance cost that keeps the trust explicit.
- Every pinned request pays its own TLS handshake — the pinned path does not pool connections; a handshake-budget expiry surfaces as upstream unavailability.
- The mechanism is Bun-specific (the `fetch` TLS semantics above, plus `node:http`'s `createConnection`); a runtime upgrade that changes them requires re-verifying the design.
- `upstream_tls_error` joins the client-visible error vocabulary of `specs/contracts/client-gateway.md` — a public surface extension.

## Alternatives Considered

- **`skipVerify` flag** (per-upstream `rejectUnauthorized: false`): rejected — it accepts any certificate presented, which is a standing MITM window guarded only by network topology; it also contradicts the security-model invariants on upstream trust.
- **Pin the whole certificate** (hash of the full DER): rejected — it breaks on every routine renewal (validity dates change), turning a non-event into an incident; the SPKI binds the key pair, which is the identity that actually matters.
- **`checkServerIdentity`-only pin** (or a `ca`-anchored fetch): rejected — empirically unreachable on Bun 1.4.4: the callback never runs when chain verification fails first, and a non-self-signed leaf cannot anchor its own chain in `tls.ca` ("unable to verify the first certificate"), so leaf-only internal-PKI upstreams fail no matter how the pin is configured; the upstream must own the connection to make the pin check meaningful.
- **Warn-and-continue on mismatch** (log the mismatch, proceed with the handshake): rejected — a pin that warns is not a pin; it converts a security signal into log noise while still relaying traffic through an unverified channel. This is a deliberate deviation from the c0wrk ADR-054 analog, which chose warn semantics; here strict reject won because the gateway relays client bodies it cannot inspect.
- **Per-request probe without cache**: rejected — it doubles handshakes on every request and adds probe latency to each one; the cached leaf with TLS-failure invalidation gets the same freshness where it matters (immediately after any TLS failure) at a fraction of the cost.
