# ADR-007: Listener under a `server` block with explicit TLS

## Status

Accepted

## Context

The gateway's listener has exactly one configurable concern today — the address, the flat top-level `listen` key (`"host:port"`, defaulted to loopback per [security-model.md](../architecture/security-model.md)). HTTPS support adds more: a TLS switch, a certificate-chain file, a private-key file. Spreading those across the config root (`listen`, plus flat `tlsCert`/`tlsKey`/…) would leave listener state scattered over the very level that already groups everything else (`logLevel`, `upstreams`), and every future listener option (keep-alive limits, max body size) would keep widening that scatter.

Two questions had to be settled before the keys could be shaped. First, what turns TLS on: the presence of certificate material, or an explicit statement of intent. Second, how a pre-release gateway treats the existing top-level `listen`: as a contract to migrate, or as a draft to cut. The gateway has no users yet — the same window [ADR-006](./006-gateway-surface-namespace.md) used to re-cut the URL namespace is still open, and a config-file break is exactly as cheap now and never cheaper later.

TLS also interacts with the security model: the gateway's auth is a documented no-op and the listener binds loopback by default. Serving HTTPS could be misread as "the gateway is now secured", so the decision must state what TLS does and does not provide ([security-model.md](../architecture/security-model.md)).

## Decision

Listener options move under a `server` block, and TLS is switched explicitly:

- **`server` block owns the listener.** `server.listen` keeps the `"host:port"` grammar and the `"127.0.0.1:8080"` default; `server.tls` groups the TLS options. The schema stays strict — unknown keys are rejected at every level ([configuration.md](../domains/configuration.md)).
- **TLS is explicit: `server.tls.enabled: boolean` is required whenever the block is present.** A block without `enabled` never validates. Certificate and key paths may stay configured while `enabled` is `false` — staging material before switching on is a supported workflow.
- **Hard break: top-level `listen` becomes an unknown key.** No migration alias, no auto-move with a warning — the same clean-cut rule [ADR-006](./006-gateway-surface-namespace.md) applied to URL paths. Every config, example, and doc snippet moves to `server.listen` in the same change.
- **`server.tls.cert` / `server.tls.key` are PEM file paths**, read once at startup before the port binds (`src/index.ts`): a missing or unreadable file is a fatal startup error — one stderr line naming the path and the reason, exit 1 ([data-flow.md](../architecture/data-flow.md)). The config never carries PEM contents ([gateway-management.md](../contracts/gateway-management.md) — the management view shows paths verbatim). No passphrase support: keys are unencrypted PEM (the generated-by-tool pair `tools/generate-tls-cert.sh` writes a `600`-mode key); protecting the key file is the deployment's job.
- **TLS is not authentication.** HTTPS changes the transport, not the access model: the gateway auth surface stays a no-op, the loopback default stays, and nothing about certificates is treated as a client identity ([security-model.md](../architecture/security-model.md)).

## Consequences

Positive:

- Listener state is co-located and extensible: the next listener option lands as one more key inside `server`, never as another root-level name.
- The explicit `enabled` switch separates intent from material: a half-staged `tls` block (paths only) is a valid config, and turning TLS off is one boolean — deleting paths is not required, and their absence cannot silently flip the serving mode.
- Failure modes are sharpened: `enabled: true` with missing paths fails at config validation, before any port is bound; a path that does not resolve fails at startup, before any port is bound — both with one line naming the cause.
- Config and management view stay free of key material: only paths travel in the file and in `GET /api/configuration`.

Negative:

- Every existing config, `config.example.json` consumer, and doc snippet using top-level `listen` breaks now — accepted, since no deployment exists to migrate.
- Two files (certificate chain, key) must exist and stay readable by the gateway process when TLS is on; key rotation is a restart (no hot reload, per [configuration.md](../domains/configuration.md)).
- The `tls` block's three-key shape (`enabled` + two paths) is slightly heavier than a presence check — the price of explicit intent.

## Alternatives Considered

- **Implicit enablement by the presence of `server.tls`**: rejected — presence would double as intent, so certificate paths could not be staged while the listener stays on plain HTTP, and a half-written block would flip the surface to HTTPS the moment it appeared; the explicit boolean makes the serving mode readable from one key.
- **Flat `tlsCert` / `tlsKey` at the config root**: rejected — it scatters listener options across the root (`listen` next to `tlsCert` next to `logLevel`) and leaves the on/off question no natural flat home; a `tlsEnabled` beside them is three root keys for one concern the `server` block groups in one.
- **Dual listener (HTTP and HTTPS simultaneously)**: rejected — the gateway fronts LLM providers behind one fixed client surface; two listeners double binding, failure reporting, and every deployment's reverse-proxy story for no MVP use case.
- **Inline PEM contents in the config file**: rejected — key material in the config leaks into every place the config goes: editor history, backups, `GET /api/configuration` (the redacted view would have to mask bodies, not just credentials), and accidental commits; paths keep the material out of the config domain entirely.
- **Alias migration (auto-map top-level `listen` to `server.listen` with a warning)**: rejected — with no users there is nothing to migrate; an alias doubles the validation surface and the documented schema forever, and removing it later is the breaking change it pretended to avoid (the [ADR-006](./006-gateway-surface-namespace.md) rule: no compatibility shims).
