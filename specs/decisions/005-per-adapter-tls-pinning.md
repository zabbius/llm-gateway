# ADR-005: Per-Adapter TLS SPKI Pinning (`tlsFingerprint`)

## Status

Accepted

## Context

A growing share of upstream LLM deployments lives behind self-signed or internal-PKI certificates (in-cluster inference servers, `llm.lan`-style gateways). The gateway's default outbound verification — the system CA pool inside `fetch` — fails closed on such upstreams, so they surface as plain unreachability (`504 upstream_timeout`) with no legitimate way to connect. The operationally honest options are to pin the upstream's key or to disable verification; disabling wholesale is a standing MITM window and contradicts the trust model (`specs/architecture/security-model.md`).

The parent deployment (c0wrk) faced the same question and answered it with ADR-054: pin the upstream certificate's SPKI digest per connection. This gateway adopts the same pin semantics and field name (`tlsFingerprint`) as that decision, so operators can reuse their pins and their runbooks across both systems.

There is also a mechanism constraint. Empirically, on Bun 1.4.4, `fetch`'s `tls.checkServerIdentity` callback never runs when the certificate chain fails verification first — a pin-only callback cannot by itself accept a self-signed chain. Any pinning design on Bun must make the chain verifiable (by anchoring it at a known certificate) before the per-connection pin check can get a word in.

## Decision

The `adapters[]` config entries gain an optional `tlsFingerprint` field: `base64(SHA-256(SPKI DER))` of the upstream certificate's public key — the RFC 7469 / Chromium CertificatePinList construction, so a pin stays valid across certificate renewals as long as the key pair is reused. Validation (in `src/config/schema.ts`) accepts standard-alphabet base64 decoding to exactly 32 bytes, tolerates and strips whitespace, and never echoes the value into a problem line. Absent or empty means no pin: default system-CA verification, byte-identical to pre-ADR behavior.

A configured pin means exactly one thing, with no softer mode: **only the pinned key is accepted, and every mismatch fails closed.** The mechanism (`src/adapters/tls-pinning.ts`, enforced by `OpenAICompatibleAdapter.upstreamFetch`, verified empirically on Bun 1.4.4) has three parts:

1. **Probe** — a bare TLS handshake (`node:tls.connect`, verification disabled: no HTTP request, no credentials — the fingerprint is what is being fetched) reads the served leaf certificate and rejects it when its pin does not match the configuration.
2. **Anchor** — the probed leaf is handed to `fetch` as its `tls.ca`, so the chain of the actually-served certificate must terminate at exactly that leaf; a rotated certificate fails closed.
3. **Per-connection veto** — a pin-only `tls.checkServerIdentity` on the same `fetch` re-checks the SPKI pin per connection; being a custom callback, it replaces the built-in hostname check entirely — the pin is the only identity requirement.

The probed leaf PEM is cached per adapter as an optimization. Any TLS failure invalidates the cache, and the next request re-probes: a certificate renewed with the same key pair matches the pin again, a key change keeps failing closed. The probe never retries within a failed request — the no-retry invariant holds (`specs/contracts/gateway-upstream.md`).

A TLS verification failure on a pinned upstream is its own client-visible fact: a synthesized `502` envelope with `type: "api_error"`, `code: "upstream_tls_error"` (`src/httpapi/errors.ts`), whose message states the fact of the mismatch and nothing else — no certificate bytes, subject, or DNS names. Without a pin, TLS failures keep the pre-existing `504 upstream_timeout` mapping. A pin on a plain-http `baseUrl` stays valid config but is inert.

A companion script, `tools/tls-fingerprint.ts`, prints the pin of an https endpoint (`bun tools/tls-fingerprint.ts <url>`) and verifies one fail-closed (`--expect <pin>`); it reuses the same TLS module rather than duplicating any of its logic.

## Consequences

Positive:

- Self-signed and internal-PKI upstreams become usable through one config field, without ever disabling verification: there is deliberately no mode that accepts an arbitrary certificate.
- Pins survive routine certificate renewal on the same key pair — rotation of the certificate does not break the config; rotation of the key does, by design, until the operator re-pins.
- Every mismatch branch fails closed (probe comparison, chain-not-terminating-at-pinned-leaf, per-connection veto) and reports exactly one new error code clients can branch on.
- No-pin behavior and plain-http behavior are byte-identical to the pre-ADR gateway.

Negative:

- Key rotation on a pinned upstream breaks the adapter until the operator recomputes and redeploys the pin — an intentional maintenance cost that keeps the trust explicit.
- The first request (or the first request after any TLS failure) on a pinned adapter pays one extra handshake; a probe timeout surfaces as upstream unavailability.
- The mechanism is Bun-specific (the `checkServerIdentity` semantics above); a runtime upgrade that changes them requires re-verifying the three-part design.
- `upstream_tls_error` joins the client-visible error vocabulary of `specs/contracts/client-gateway.md` — a public surface extension.

## Alternatives Considered

- **`skipVerify` flag** (per-adapter `rejectUnauthorized: false`): rejected — it accepts any certificate presented, which is a standing MITM window guarded only by network topology; it also contradicts the security-model invariants on upstream trust.
- **Pin the whole certificate** (hash of the full DER): rejected — it breaks on every routine renewal (validity dates change), turning a non-event into an incident; the SPKI binds the key pair, which is the identity that actually matters.
- **`checkServerIdentity`-only pin**: rejected — empirically unreachable on Bun 1.4.4: the callback never runs when chain verification fails first, so a self-signed upstream would always fail; the probe-and-anchor steps exist precisely to make the callback meaningful.
- **Warn-and-continue on mismatch** (log the mismatch, proceed with the handshake): rejected — a pin that warns is not a pin; it converts a security signal into log noise while still relaying traffic through an unverified channel. This is a deliberate deviation from the c0wrk ADR-054 analog, which chose warn semantics; here strict reject won because the gateway relays client bodies it cannot inspect.
- **Per-request probe without cache**: rejected — it doubles handshakes on every request and adds probe latency to each one; the cached leaf with TLS-failure invalidation gets the same freshness where it matters (immediately after any TLS failure) at a fraction of the cost.
