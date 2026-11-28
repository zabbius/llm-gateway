# ADR-008: Bearer-token auth for the LLM surface (stage 2)

## Status

Accepted

## Context

[ADR-007](./007-management-cookie-auth.md) explicitly left the LLM surface undecided: `/llm/v1/*` stayed open — the loopback default its only protection — while the management surface got the cookie-session gate. The config schema meanwhile gained the `clients` block (entries of `name` / `apiKey` / `models`), giving stage 2 its credential store before any gate existed. Two questions had to be settled before the stage-2 code could exist.

**Scope and credential form.** The LLM surface is spoken by OpenAI-protocol SDK clients whose native credential is `Authorization: Bearer <key>` — the same header shape the gateway's own upstreams use against providers. Reusing the stage-1 cookie session there would force every SDK integration to carry a cookie jar ([ADR-007](./007-management-cookie-auth.md) rejected exactly that). The two surfaces therefore keep two credential classes: operator sessions on `/api/*`, client API keys on `/llm/v1/*` — neither substitutes for the other.

**Enforcement and safety.** The auth stage is one pre-routing stage in the request lifecycle ([data-flow.md](../architecture/data-flow.md)); stage 2 must extend it, not invent a second stage. And the comparison must not leak: a naive string compare exposes length and prefix-of-match through timing, a hazard the management gate already solved with SHA-256 digests through `timingSafeEqual` (`loginMatches`, ADR-007).

## Decision

- **Stage 2 gates `/llm/v1/*` only — when the `clients` block carries entries, or whenever the runtime configuration store is wired ([ADR-014](./014-runtime-management-crud.md)).** The gate is a middleware mounted after the request log and before every route handler (`src/httpapi/client-auth.ts`, mounted by `src/httpapi/app.ts`); the store-wired case exists because the clients CRUD can create the first client at runtime, so the gate mounts over an empty registry and answers every request `401` fail-closed until it does. Without a store and without clients nothing mounts: `/llm/v1/*` answers unauthenticated. `/api/*` keeps the ADR-007 session gate untouched; `/ui` and `/` stay public. A valid client key is not a session: it opens nothing on the management surface.
- **The credential is `Authorization: Bearer <apiKey>` matching any configured `clients[].apiKey`.** The Bearer scheme is matched case-insensitively (RFC 9110); a missing header, a foreign scheme, or an empty credential answers the 401 envelope `authentication_required`, an unknown key the 401 envelope `invalid_api_key` — both `authentication_error`, both from the single envelope mapper (`src/httpapi/errors.ts`), both sent without `WWW-Authenticate`, both before any body read or upstream contact. The answers never echo the presented value or any configured key.
- **Verification is timing-safe.** The configured keys are SHA-256 digested once at gate construction; the presented key is digested per request and compared through `timingSafeEqual` against every digest (`clientKeyMatches` — the `loginMatches` pattern of ADR-007): no length signal, no prefix signal, no throw on differing input lengths.
- **Client keys are the second credential class, under the provider-key storage rules** ([security-model.md](../architecture/security-model.md)): a key exists in exactly two places — the config file and the gateway's in-memory configuration (the store's current clients, from which the gate's digest registry is built; the gate closure itself holds only the SHA-256 digests). It never enters the redacted view (the fixed `[Configured]` mask), a log line, an error message, or a config-validation problem line.
- **The gate consumes the client's `Authorization`; it is still never forwarded upstream.** The upstream authenticates with its own configured `apiKey` (`gateway-upstream.md` Authorization policy, unchanged).
- **The gate authenticates; the dispatch authorizes model aliases.** `clients[].models` is enforced at request time by the routing core's `clientMayUse` — an alias outside the client's list answers `403` before any upstream contact ([ADR-009](./009-alias-table-routing.md)).
- **No new login surface.** Unlike stage 1 there is no `/llm` login endpoint: SDK clients configure the header statically, keys are provisioned out-of-band through the config file or the session-gated clients CRUD ([ADR-014](./014-runtime-management-crud.md)).

## Consequences

Positive:

- The LLM surface is protectable beyond loopback: a deployment that binds a private interface can require client keys without any client-side change beyond the standard `apiKey` every OpenAI SDK already has.
- The auth stage stays one stage with two gates; the request lifecycle, the log line, and the envelope contract are unchanged.
- Timing-safe verification reuses the ADR-007 pattern — one construction for both credential classes, no new crypto code.

Negative:

- Client keys are static config credentials with no per-key expiry and no lockout machinery; rotation is a config edit or a clients CRUD mutation that hot-applies the rebuilt digest registry ([ADR-014](./014-runtime-management-crud.md)) — a restart is never required for it.
- Without a `clients` block and without a wired store the surface stays open; the loopback/private-interface binding default remains the documented advice for that mode.
- Verification cost is linear in the number of configured clients (every digest is compared on a failed match) — immaterial at MVP scale.
- `clients[].models` costs one set lookup per request; its enforcement belongs to the routing core ([ADR-009](./009-alias-table-routing.md)), not to the gate.

## Alternatives Considered

- **Cookie sessions on `/llm/v1/*`**: rejected (again) — OpenAI SDK clients have no cookie story; Bearer is the protocol-native credential and the reason stage 2 was deferred from ADR-007.
- **A custom header (`x-api-key`) instead of `Authorization`**: rejected — breaks the drop-in OpenAI contract; clients would need gateway-specific configuration for a credential the protocol already carries.
- **Per-client alias enforcement inside the gate** (404 `model_not_found` when the addressed alias is not in the client's `models`): rejected — it conflates authentication with authorization and lives in the wrong place; enforcement landed in the routing core as a `403` before upstream contact ([ADR-009](./009-alias-table-routing.md)), on the schema this ADR validates.
- **JWT / OAuth bearer tokens**: rejected — the MVP has no identity provider, no signing key, and no revocation story beyond restart; static config keys match the config-backed precedent of both prior credential classes.
- **Plain string comparison with constant-time bail-out** (`crypto.timingSafeEqual` on the raw strings): rejected — it throws on differing lengths and leaks length information; the SHA-256 digest round-trip fixes both and is already the codebase's audited pattern.
