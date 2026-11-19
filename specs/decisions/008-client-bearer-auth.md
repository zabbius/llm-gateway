# ADR-008: Bearer-token auth for the LLM surface (stage 2)

## Status

Accepted

## Context

[ADR-007](./007-management-cookie-auth.md) explicitly left the LLM surface undecided: `/llm/v1/*` stayed open — the loopback default its only protection — while the management surface got the cookie-session gate. The config schema meanwhile gained the `clients` block (entries of `name` / `apiKey` / `models`), giving stage 2 its credential store before any gate existed. Two questions had to be settled before the stage-2 code could exist.

**Scope and credential form.** The LLM surface is spoken by OpenAI-protocol SDK clients whose native credential is `Authorization: Bearer <key>` — the same header shape the gateway's own upstreams use against providers. Reusing the stage-1 cookie session there would force every SDK integration to carry a cookie jar ([ADR-007](./007-management-cookie-auth.md) rejected exactly that). The two surfaces therefore keep two credential classes: operator sessions on `/api/*`, client API keys on `/llm/v1/*` — neither substitutes for the other.

**Enforcement and safety.** The auth stage is one pre-routing stage in the request lifecycle ([data-flow.md](../architecture/data-flow.md)); stage 2 must extend it, not invent a second stage. And the comparison must not leak: a naive string compare exposes length and prefix-of-match through timing, a hazard the management gate already solved with SHA-256 digests through `timingSafeEqual` (`loginMatches`, ADR-007).

## Decision

- **Stage 2 gates `/llm/v1/*` only, and only when the `clients` block is configured.** The gate is a middleware mounted after the request log and before every route handler (`src/httpapi/client-auth.ts`, mounted by `src/httpapi/app.ts`); absent clients, nothing mounts and behavior is byte-for-byte identical to before ADR-008. `/api/*` keeps the ADR-007 session gate untouched; `/ui` and `/` stay public. A valid client key is not a session: it opens nothing on the management surface.
- **The credential is `Authorization: Bearer <apiKey>` matching any configured `clients[].apiKey`.** The Bearer scheme is matched case-insensitively (RFC 9110); a missing header, a foreign scheme, or an empty credential answers the 401 envelope `authentication_required`, an unknown key the 401 envelope `invalid_api_key` — both `authentication_error`, both from the single envelope mapper (`src/httpapi/errors.ts`), both sent without `WWW-Authenticate`, both before any body read or upstream contact. The answers never echo the presented value or any configured key.
- **Verification is timing-safe.** The configured keys are SHA-256 digested once at gate construction; the presented key is digested per request and compared through `timingSafeEqual` against every digest (`clientKeyMatches` — the `loginMatches` pattern of ADR-007): no length signal, no prefix signal, no throw on differing input lengths.
- **Client keys are the second credential class, under the provider-key storage rules** ([security-model.md](../architecture/security-model.md)): a key exists in exactly two places — the config file and the entry-point-injected client slice inside the gate closure. It never enters the redacted view (the fixed `[Configured]` mask), a log line, an error message, or a config-validation problem line.
- **The gate consumes the client's `Authorization`; it is still never forwarded upstream.** The upstream authenticates with its own configured `apiKey` (`gateway-upstream.md` Authorization policy, unchanged).
- **The gate authenticates; it does not authorize model aliases.** `clients[].models` is validated at startup but not enforced at request time — every valid client may address every model alias. Enforcing per-client alias tables is a client-visible contract change deliberately deferred.
- **No new login surface.** Unlike stage 1 there is no `/llm` login endpoint: SDK clients configure the header statically, keys are provisioned out-of-band through the config file.

## Consequences

Positive:

- The LLM surface is protectable beyond loopback: a deployment that binds a private interface can require client keys without any client-side change beyond the standard `apiKey` every OpenAI SDK already has.
- The auth stage stays one stage with two gates; the request lifecycle, the log line, and the envelope contract are unchanged.
- Timing-safe verification reuses the ADR-007 pattern — one construction for both credential classes, no new crypto code.

Negative:

- Client keys are static config credentials: revocation or rotation is a config edit plus a restart — no per-key expiry, no hot reload, no lockout machinery (mirroring the stage-1 stance on session lifetime).
- Without a `clients` block the surface stays open; the loopback/private-interface binding default remains the documented advice for that mode.
- Verification cost is linear in the number of configured clients (every digest is compared on a failed match) — immaterial at MVP scale.
- `clients[].models` is dead weight at request time until alias enforcement lands; validating without enforcing is a conscious trade for schema forward-compatibility.

## Alternatives Considered

- **Cookie sessions on `/llm/v1/*`**: rejected (again) — OpenAI SDK clients have no cookie story; Bearer is the protocol-native credential and the reason stage 2 was deferred from ADR-007.
- **A custom header (`x-api-key`) instead of `Authorization`**: rejected — breaks the drop-in OpenAI contract; clients would need gateway-specific configuration for a credential the protocol already carries.
- **Per-client alias enforcement now** (404 `model_not_found` when the addressed alias is not in the client's `models`): rejected for this stage — it conflates authentication with authorization and changes the model-visibility contract (`client-gateway.md`); the schema already validates the references, so enforcement can land later without a schema change.
- **JWT / OAuth bearer tokens**: rejected — the MVP has no identity provider, no signing key, and no revocation story beyond restart; static config keys match the config-backed precedent of both prior credential classes.
- **Plain string comparison with constant-time bail-out** (`crypto.timingSafeEqual` on the raw strings): rejected — it throws on differing lengths and leaks length information; the SHA-256 digest round-trip fixes both and is already the codebase's audited pattern.
