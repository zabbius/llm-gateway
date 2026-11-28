# Security Policy

> **This is a security *policy*, not an audit report.** It defines the project's threat model and the secure coding rules every contributor and coding agent must follow. It does **not** record whether the current codebase complies with these rules — compliance verification belongs in code review, audits, or the issue tracker, never in this file.

## Supported Versions

No tagged releases exist yet; development happens on `main`. Only the latest `main` receives security fixes.

| Version        | Supported          |
| -------------- | ------------------ |
| `main` (HEAD)  | :white_check_mark: |
| tagged release | :x: (none exist)   |
| older commits  | :x:                |

## Reporting a Vulnerability

**Preferred channel:** GitHub Security Advisories — use the **"Report a vulnerability"** form under the repository's *Security* tab. Reports there are private by default.

**Do NOT** open public GitHub issues for suspected vulnerabilities, and do not post exploit details in chat, Discussions, or pull requests.

**What to include:** affected surface (`/llm/v1/*`, `/api/*`, `/ui/*`), a minimal reproduction, config shape involved (with all credentials replaced by placeholders), and your assessment of impact. Never attach a real `config.json` or `tls/` key material.

**Response expectations (maintainer's stated intent — tune to your practice):**
- Acknowledgment: within 5 business days
- Triage and severity assessment: within 10 business days
- Fix and coordinated disclosure timeline is agreed with the reporter per case

**Disclosure policy:** coordinated disclosure. Credit in release notes unless anonymity is requested.

---

## Threat Model

llm-gateway is a credential custodian and a transport proxy: clients speak the OpenAI protocol to one gateway, and the gateway forwards each request to the upstream provider selected by configuration, streaming the answer back. The gateway itself plans nothing, executes nothing, and decides nothing on anyone's behalf — every upstream call is a direct relay of a client-initiated completion request or an explicit operator action on `/api/*` (an ADR-011 live listing — its `discover=1` variant per ADR-016 included — or a CRUD create/update's blocking probe). Since [ADR-014](specs/decisions/014-runtime-management-crud.md) the gateway also **writes**: the management CRUD writes `config.json` back (atomic persist) and hot-applies the change into the running process — the one runtime file write, behind the session gate. **Deployment context for this model: the gateway runs on a private/home LAN, where other devices and people on the same network can reach the listener** (user-confirmed; the code's own default is loopback `127.0.0.1:8080`).

### Assets

| Asset | Sensitivity | Description |
| --- | --- | --- |
| Provider API keys | Critical | Upstream credentials in `config.json` (`upstreams[].apiKey`); authenticate to provider APIs; a leak = unauthorized spend and account access under the operator's provider identity |
| Operator password hash | Critical | `auth.passwordHash` (argon2id PHC) in `config.json`; unlocks the management surface `/api/*` |
| TLS private key file | Critical | `server.tls.key` PEM (repo convention: `tls/key.pem`); possession = ability to impersonate the gateway's TLS identity |
| Client API keys | High | `clients[].apiKey` in `config.json`; authenticate LLM-surface clients; scope = the client's alias ACL |
| Session tokens | High | In-memory operator session cookies (32-byte random, 24 h TTL); possession = management-surface access until expiry/restart |
| Client request/response payloads | High | Prompts and completions relayed through the gateway; the gateway must not retain, log, or transform them beyond the model-id rewrite |
| Upstream TLS pins | Medium | `tlsFingerprint` SPKI pins; define which upstream identity is acceptable for pinned providers |
| Configuration topology | Medium | Aliases, routes, upstream base URLs, outbound proxy URLs (`upstreams[].proxy` — scheme/host:port only, never credentials, ADR-017), listener address; served (masked) by the management CRUD reads (`GET /api/upstreams`, `GET /api/models`, `GET /api/clients`); reveals where client traffic is sent and through which egress hop |
| Availability & cost envelope | Medium | Every relayed request consumes provider quota/money; operator-triggered live upstream calls (the ADR-011 listing with its ADR-016 `discover=1` variant, the CRUD blocking probes) each cost the named upstream one `/models` call; nothing in the design meters usage |
| Log stream (stderr) | Medium | Carries request metadata and failure reasons; must never carry credentials or payload content |

### Threat Actors

- **LAN peer (primary remote actor)** — any device or person on the same private network: can reach every listening surface; may attempt credential guessing on `/api/login`, key guessing on `/llm/v1/*`, and abuse of any surface left ungated by configuration.
- **Local process / host malware** — anything already executing as the gateway's OS user can read `config.json`, `tls/key.pem`, process memory (provider keys, session tokens), and stderr. The gateway offers no defense against host compromise; it relies on host security.
- **Malicious or compromised upstream provider** — receives the relayed request (prompt content, metadata) and returns arbitrary bytes the gateway relays to the client; can also feed hostile responses to probe gateway behavior.
- **Supply-chain adversary** — malicious npm package (the runtime tree is deliberately tiny: `hono`, `pino`) or a compromised Bun runtime.
- **Misconfigured AI coding agent** — an agent editing this repository that weakens a gate, echoes a credential, or disables a redaction path (see Rules for AI Coding Agents).
- **Opportunistic scanner** — becomes relevant the moment the listener is bound beyond the LAN (deliberate misconfiguration); the design's answer is binding discipline plus the config-backed gates.

### Attack Surface

Every entry point below is verified against the mounted routes in `src/httpapi/app.ts`:

- `GET /` — unconditional 302 redirect to `/ui`. No data, no auth.
- `GET|HEAD /ui/*` — static files from `web/dist` plus SPA fallback (`index.html` served for client-side routes). Unauthenticated by design in every mode.
- `GET /docs` — the Swagger UI shell ([ADR-013](specs/decisions/013-openapi-docs-surface.md)): a static HTML constant carrying no data beyond the `/docs/openapi.json` URL; its pinned `swagger-ui-dist@5.35.0` assets load from unpkg **in the operator's browser** — the gateway itself never fetches. Ungated static documentation (no credential, no configuration value, no instance data; same class as `/ui/*`).
- `GET /docs/openapi.json` — the build-time-generated OpenAPI document ([ADR-013](specs/decisions/013-openapi-docs-surface.md)): `bun run apidocs` compiles `dist/openapi.json` from the wire-description tables and the mount serves it statically — static protocol metadata only: route paths, wire shapes, the fixed mask literals; no credential, no configuration value, no instance data, and no upstream contact at generation or serving; the server never generates (a missing artifact answers the envelope 404 with the regenerate hint). Ungated; unknown `/docs/*` paths answer the OpenAI envelope 404.
- `POST /api/login` — unauthenticated by definition; JSON body under the configured request-body cap (`server.maxRequestBodyBytes`, default 4 MiB); argon2id verification; fixed-delay identical failure answer.
- `POST /api/logout` — unauthenticated; idempotent session revocation.
- `GET /api/status` — the fixed health pair `{ status: "ok", authenticated }` (ADR-014 D3: no inventory in the body — probe outcomes and route verdicts stay in startup log lines). Session-gated when `auth.enabled`; otherwise reachable by anyone on the network path.
- `GET|POST /api/upstreams`, `GET|PUT|DELETE /api/upstreams/:id`, `POST /api/upstreams/:id/discover` — the upstream CRUD and discover (ADR-014). Reads answer masked entries; writes run validate → persist (`config.json` write-back, atomic) → hot-apply, with create/update making **one live upstream call** (the blocking probe, ADR-014 D8) and discover making **one live upstream call** (`listModels()` within the probe budget, D4); an unknown id answers `404` before any contact; a delete naming a referenced upstream answers `409` without mutating anything (D6). Session-gated when `auth.enabled`; otherwise reachable by anyone on the network path.
- `GET|POST /api/models`, `GET|PUT|DELETE /api/models/:alias` — the model-alias CRUD (ADR-014): masked entries plus the `meta` aggregate; writes persist to `config.json` and rebuild the routing table without a restart (health/affinity reset, D9); deletes answer `409 resource_in_use` while a client ACL still names the alias. No upstream contact anywhere on this collection. Session-gated when `auth.enabled`.
- `GET|POST /api/clients`, `GET|PUT|DELETE /api/clients/:name` — the client CRUD (ADR-014): masked entries; writes persist to `config.json` and hot-swap the LLM gate's digest registry — a created key admits, a removed key answers `401 invalid_api_key`, all without a restart. Session-gated when `auth.enabled`.
- `GET /api/upstreams/:id/models` — an operator-triggered **live** upstream call, one `listModels()` within the probe budget (ADR-011); session-gated when `auth.enabled`.
- `GET /llm/v1/models` — alias catalog, scoped to the authenticated client's ACL. Bearer-gated when the `clients` block is configured — or whenever the runtime configuration store is wired (ADR-014): the empty registry answers `401` fail-closed until the clients CRUD creates the first client.
- `POST /llm/v1/chat/completions`, `POST /llm/v1/completions` — completion dispatch: configured body cap, alias resolution, per-client ACL, relay to the configured upstream. Bearer-gated under the same condition as the catalog.
- Everything else — `404` in the OpenAI error envelope.
- Outbound: `fetch` to the configured `upstreams[].baseUrl` and to nothing else (absolute http(s) URL, validated at startup and again on every runtime mutation) — directly, or since [ADR-017](specs/decisions/017-per-upstream-outbound-proxy.md) through that entry's configured `proxy`: an `http://host:port` value is handed to Bun's `fetch` as its proxy option; a `socks5://host:port` value goes through a per-upstream in-process HTTP→SOCKS5 bridge (`src/upstreams/socks-bridge.ts`) that listens on `127.0.0.1:<ephemeral port>` only — a loopback-only bridge listener, never network-reachable, started with the entry's first outbound call and stopped with the upstream (`dispose()`). A proxy URL never carries credentials and no `Proxy-Authorization` header is ever sent; on a plain-http `baseUrl` the proxy sees the plaintext request (Bearer credential included) — prefer `https` baseUrls behind a proxy. Fixed path suffixes (`models`, the LM Studio native leg, `chat/completions`, `completions`), `redirect: "manual"` so upstream redirects are never followed.
- Local: `config.json` (path from `LLM_GATEWAY_CONFIG` or `./config.json`) and the TLS PEM files — the PEM files are read once at startup and never written; `config.json` is read at startup and **re-written only by the management mutations** (ADR-014 D1: read raw → replace the three mutable sections → sibling temp file → atomic same-directory rename; nothing else on the filesystem is ever written — the ADR-017 proxy bridge is an in-process loopback listener, not a file, and adds no write of any kind).
- The listener binds `127.0.0.1:8080` by default; any non-loopback binding is a deliberate operator decision that changes who can reach the ungated surfaces.

### Trust Boundaries

```
   UNTRUSTED: LAN clients                 TRUSTED: provider APIs
   arbitrary request bodies,              authenticated by the
   unknown identity,                      gateway-held provider key
   two credential classes                 over HTTPS (pin optional)
        |                                        ^
        | HTTP or TLS (transport only)           | Authorization from config only
        v                                        |
+------------------------------------------------------------------+
| gateway process                                                  |
|  [1] auth stage (session gate /api/*, Bearer gate /llm/v1/*)     |
|  [2] route + alias + per-client ACL resolution                   |
|  [3] upstream relay (header whitelist, own credential)           |
|  key storage rules + log redaction + strict config schema        |
+------------------------------------------------------------------+
        |                                        ^
        v                                        |
+------------------------------------------------------------------+
| config.json +    |  PEM read once at   | local filesystem /       |
| tls/*.pem        |  startup; config    | host OS (out of scope    |
| (operator-held)  |  re-written only by | for gateway defenses)    |
|                  |  the session-gated  |                          |
|                  |  CRUD write-back    |                          |
+------------------+  (ADR-014, atomic) +--------------------------+
```

- **Client ↔ gateway** — every request is untrusted regardless of route. The auth stage precedes routing and upstream contact; `/llm/v1/*` and `/api/*` carry two different, non-interchangeable credential classes (ADR-007, ADR-008). A surface without its gate relies on the listener binding — on a shared LAN, "ungated" means "everyone on the LAN".
- **Gateway ↔ upstream** — the gateway authenticates with credentials from its own config; client-supplied credentials never travel upstream. A configured `tlsFingerprint` narrows upstream trust to one SPKI key, fail-closed (ADR-004); without a pin, the system CA pool plus hostname verification decides — there is deliberately no third mode. A configured outbound `proxy` (ADR-017) inserts a hop those credentials cross: the proxy sees the target `host:port` of every call, and on a plain-http `baseUrl` the whole plaintext request including the Bearer key — so an entry routed through a proxy carries an `https` `baseUrl`, and the proxy sees ciphertext only. The proxy itself is never given credentials (no userinfo in its URL, no `Proxy-Authorization` header), the `socks5://` bridge is loopback-only, and the pin check still precedes every request byte through the tunnel. A proxy that refuses or fails the connection surfaces as `502 upstream_proxy_error` — never as a relayed upstream response.
- **Config file ↔ process** — the primary secret ingress, joined by the session-gated management mutation bodies ([ADR-014](specs/decisions/014-runtime-management-crud.md)): keys enter as file content or as an authenticated CRUD request body, exist in memory, and leave only as upstream credential headers or masked/never (logs, errors, management reads). Both ingress channels land the credential in the same two places — `config.json` and the in-memory holder — never a third; a mutation body's value is consumed by the store (never echoed, never logged, never in a problem line), and the atomic persist (temp file + rename) keeps the file the single source of truth.
- **Browser ↔ SPA** — the SPA authenticates through the HttpOnly `SameSite=Strict` session cookie carried by same-origin fetches; no tokens live in browser storage.
- **Upstream ↔ gateway** — upstream responses are relayed byte-for-byte (minus hop-by-hop headers); the gateway treats upstream output as opaque payload data, never as instruction.

### Known Risks & Accepted Trade-offs

Design-level decisions the architecture knowingly accepts — not gaps against this policy:

| Risk | Severity | Mitigation / Rationale |
| --- | --- | --- |
| Ungated surfaces rely on the listener binding: with no `clients` block the LLM surface, and with `auth.enabled: false` the management surface, are open to everything that can reach the listener | High (on a shared LAN) | Documented two-stage opt-in design (ADR-007/009): loopback default + private-interface rule is the load-bearing control until each gate is configured; operators on shared networks are expected to configure both gates (see Hard Constraints for agents: never expose without saying so) |
| No rate limiting, quota, or metering on any surface | Medium | MVP scope decision: a LAN client can drive unlimited upstream calls (cost and load). Operators front the gateway with their own controls if needed; adding metering is a contract change, not a tweak |
| Single operator identity (`auth.user`/`passwordHash`) — no per-operator accounts, no MFA | Medium | Accepted for a single-operator gateway; session compromise impact is bounded by the session TTL, the in-memory session loss on restart, and the loopback default — but the blast radius grew with ADR-014: a stolen session can now rewrite the whole configuration (see the next row) |
| Mutating management API (ADR-014): a stolen operator session can rewrite `config.json` (credentials included) and hot-apply the change into the running gateway — the class of damage grows from "read state" to "rewrite config" | High (session theft required) | The deliberate ADR-014 trade. Mitigations: every mutation runs the session gate (`/api/*`, cookie `HttpOnly`/`SameSite=Strict`); the write-back re-validates the whole config with the startup grammar before it persists (a broken mutation cannot poison the file); the persist is atomic (temp file + rename) so a crash cannot corrupt `config.json`; the loopback default keeps the surface off the general network; mutation responses and problem lines never echo credentials (D7); each mutation logs an info line to the stderr audit trail |
| Sessions are in-memory only — no persistent audit trail of who did what beyond the stderr stream | Medium | Accepted: stderr JSON lines are the sole audit artifact — every CRUD mutation logs an info line (created/updated/deleted, the entry identity, the hot-apply fact), so the mutation history is reconstructible from the log the operating environment retains; log retention/rotation is left to that environment |
| Upstream responses pass through unfiltered — the gateway never inspects model output (and never acts on it) | Medium | Core design: pure transport. The gateway is not a guardrail; clients own content policy |
| No CSP or other security headers on the HTML surface (`/ui/*`) | Low | Static, build-time-only SPA content (no user data in HTML), React's default escaping, no `dangerouslySetInnerHTML` anywhere in `web/src`, session cookie is `SameSite=Strict` — the attack classes headers usually mitigate are narrow; revisit if the SPA ever renders user-controlled content |
| The management CRUD reads reveal non-secret topology (upstream base URLs, aliases, routes, client names) to any holder of a valid session — and to the whole network path when auth is disabled | Low | The mask covers credential values; topology visibility is the endpoints' purpose (operator diagnostics and the SPA's forms) |
| Stderr-only logging (ADR-003) — no structured sink, no alerting pipeline | Low | Deliberate MVP simplicity; the process must stay embeddable and quiet on stdout |

---

## Security Architecture

The domains below are the ones this architecture actually involves. Each subsection states what contributors and agents **MUST** do — not an inventory of what the code already has. The authoritative invariants live in `specs/architecture/security-model.md`; where this section and a spec disagree, the spec wins and this file gets updated in the same change.

### Authentication & Authorization

Two config-backed credential classes, gate-bound to two surfaces. Both gates are opt-in by configuration and both mount in the auth stage — the first request stage, before routing and before any body read or upstream contact.

- **MUST** keep the auth stage first: no code path may reach a route handler or an upstream without passing through the stage (`src/httpapi/app.ts`).
- **MUST** keep the credential classes non-interchangeable: a client Bearer key opens `/llm/v1/*` and nothing else; a session cookie opens `/api/*` and nothing else.
- **MUST** keep management-surface authorization all-or-nothing: one operator identity; there is no partial management role. New management endpoints inherit the session gate automatically by living under `/api/*` — do not mount them outside it.
- **MUST** enforce the per-client alias ACL (ADR-009) on every new LLM-surface resolution path: an alias a client is not allowed to address is answered `403` before any upstream contact.
- **MUST** keep failures indistinguishable and leveled: wrong user and wrong password produce identical, delayed answers; unknown and missing client keys produce distinct but value-free `401` envelopes.
- **MUST NOT** invent a third acceptance path for TLS upstreams: pin fail-closed or standard CA verification — no `rejectUnauthorized: false`, no warning-and-continue (ADR-004).

### Data Protection

The gateway retains no payloads and keeps no database; since [ADR-014](specs/decisions/014-runtime-management-crud.md) it writes exactly one file at runtime — `config.json`, the management CRUD's write-back. Data protection is about the two links, the log stream, and that one write.

- **MUST** treat `server.tls.enabled` as transport-only: it encrypts the client link and authenticates nobody (ADR-006). Client identity comes exclusively from the gates.
- **MUST** read PEM files once at startup, before the port binds; a missing/unreadable file exits with code 1 — never a fallback to plain HTTP. The PEM files are never written.
- **MUST** keep the config write-back atomic: every mutation reads the raw file, replaces only the three mutable sections, writes a sibling temp file, and renames it onto `config.json` (same directory — a same-filesystem atomic replace) — and rebuilds the in-memory state only after the write succeeded (ADR-014 D1). A validation failure or a write failure leaves both disk and memory untouched.
- **MUST** keep the write-back the gateway's only runtime file write: no sidecar files, no journals, no cache files — a second written file is a security-model change requiring an ADR.
- **MUST** keep TLS-pinned upstream connections fail-closed: the SPKI pin is verified before any byte — hence any credential — is written to the socket (ADR-004). Through a configured proxy (ADR-017) the rule is unchanged: the `CONNECT` tunnel (or the `socks5://` bridge) supplies only the TCP socket, and the TLS handshake and the pin decision run over it before any request byte.
- **MUST** keep the outbound proxy a credential-free hop (ADR-017): the `proxy` URL never carries userinfo (the config grammar rejects it), no code path sends a `Proxy-Authorization` header, the `socks5://` bridge binds `127.0.0.1` only, and a proxy failure is reported as `502 upstream_proxy_error` — never relayed as if the upstream had answered.
- **MUST NOT** persist, cache, or journal request/response payload content anywhere.
- **MUST NOT** follow upstream redirects (`redirect: "manual"` is the contract): a redirect must surface as an upstream-relayed status, never as an automatic fetch to a new destination.

### Secret Management

The core rule is the **two-place rule**: every credential exists in exactly two places — the config file and its single in-memory consumer slice. A credential created or updated at runtime enters through an authenticated management mutation body behind the session gate ([ADR-014](specs/decisions/014-runtime-management-crud.md)) and lands in those same two places — the mutation body is a second ingress channel, never a third storage location.

- Provider API keys: config (or an authenticated `POST`/`PUT /api/upstreams` body) → the store's validation and atomic write-back → upstream instance field → outbound `Authorization` header. Nothing else reads them.
- Operator password hash: config → entry-point-injected auth slice → `Bun.password.verify` inside `POST /api/login` handling only. The `auth` block is not runtime-mutable — the store never writes it.
- Client API keys: config (or an authenticated `POST`/`PUT /api/clients` body) → the store's validation and atomic write-back → entry-point-injected client slice → **precomputed SHA-256 digest** inside the gate closure; the plaintext of a client key does not survive gate construction.
- **MUST** keep credential values out of every log line, error envelope, validation problem line, and the management view (`redactedConfigView` masks with the fixed literal `[Configured]`; the log censor uses `[Redacted]` — keep the two distinct).
- **MUST** keep the write semantics operator-honest (ADR-014 D7): create requires a key; an update that omits `apiKey` keeps the stored credential — the masked view never carries the value back, so the absent field is the only "unchanged" an operator can express; the literal mask `[Configured]` submitted as a credential value is rejected (the mask is a display fact, never an acceptable credential); the pin follows the same rule with an explicit `null` meaning clear (dropping a pin silently would widen upstream trust).
- **MUST** keep `config.json` and `tls/` out of version control (`.gitignore` carries both); `config.example.json` carries placeholders only and is kept schema-synced by test.
- **MUST NOT** add new secret channels: no secrets in environment variables (the only env var is the config *path* `LLM_GATEWAY_CONFIG`), no secrets in CLI flags, no key material in URLs — the outbound `proxy` URL included (ADR-017: no userinfo, ever, and no `Proxy-Authorization` header from code; an authenticated proxy waits for a dedicated credential source, which is an ADR, not a tweak).
- **MUST** generate credentials with the bundled tools: `tools/hash-password.ts` for the operator hash, `tools/tls-fingerprint.ts` for pins, `tools/generate-tls-cert.sh` (writes the key with mode `600`) for local TLS pairs.
- Rotation: replace the value through the authenticated CRUD (`PUT` with the new key — the LLM gate's digest swap invalidates the old one immediately, no restart) or by editing `config.json` and restarting; a restart additionally clears every session. The operator hash rotates by config edit + restart only (the `auth` block is not runtime-mutable).

### Dependency Management

- Runtime tree is deliberately minimal: `hono` (HTTP framework) and `pino` (logging). The descriptive OpenAPI-document generation behind `/docs` (`hono-openapi` + `zod`) is build-time only — devDependencies, run via `bun run apidocs` (ADR-013; a wire description must not delegate a security-critical function, and none does: it validates no request). The web package adds `react`, `react-dom`, `bootstrap`, and `lucide-react` (icon glyph components, bundled into the SPA build by Vite — the SPA never loads dependencies from an external server at runtime).
- **MUST** keep dependency additions justified and minimal: a new runtime dependency requires a written rationale in the PR (what it does, why the platform APIs don't).
- **MUST** keep lockfiles (`bun.lock`, `web/bun.lock`) committed, with integrity hashes intact; never hand-edit them.
- **MUST** run `bun audit` (root and `web/`) before merging dependency changes; known-vulnerable versions of direct dependencies do not merge. (`bun audit` reported no known vulnerabilities across 39 packages when this policy was written, 2026-11-17 — a point-in-time fact, not a standing guarantee.)
- **MUST** prefer platform capabilities (Bun stdlib, `node:crypto`, WHATWG `fetch`, `Bun.password`, `Bun.serve`) over packages for security-critical functions: TLS, hashing, comparison, randomness, password hashing are all platform-provided — keep them that way.

### Logging, Monitoring & Incident Response

- Structured JSON lines to stderr only (ADR-003), leveled by `logLevel`; stdout stays empty forever.
- The logging layer redacts a fixed sensitive-field set (`authorization`, `x-api-key`, `api-key`, `cookie`, `token`, `apiKey`, `passwordHash` — bare, one level deep, and under `headers`) before emission at every level including trace.
- **MUST** extend `REDACT_PATHS` in `src/logging/logger.ts` in the same change that introduces any new logged field carrying credential-shaped values.
- **MUST NOT** log request or response bodies at any level; upstream failures log status + code + gateway-authored reason only. Provider error payloads are relayed to the client verbatim but never copied into logs.
- **MUST** keep per-request lines useful but value-free: method, path, upstream id, status, duration, client *name* (never the presented key).
- Incident response (minimal, single-operator scale): kill the process (SIGINT/SIGTERM) — sessions die with the process; rotate every credential in `config.json` and the TLS key if host compromise is suspected; inspect the stderr capture for the incident window; fix, then restart.

---

## Agentic Application Security

**Omitted by decision:** the reconnaissance found no agentic indicators — this gateway builds no agents (no LLM SDKs, no agent frameworks, no MCP, no tool execution, no agent memory; it is a pure transport proxy), so per the OWASP Top 10 for Agentic Applications (2026) scoping rule the ASI01–ASI10 section is not generated. Classical controls above apply; note for the record that agent *clients* may connect through this gateway, but their agency lives in the clients, not here.

---

## Secure Coding Guidelines

These guidelines apply to ALL contributors: human developers, code reviewers, and AI coding agents. Automated agents MUST treat them as hard constraints. Stack context: TypeScript on Bun, Hono HTTP layer, React 19 SPA — the rules name the stack-specific mechanisms to use.

### Input Validation

- Validate all external input at the trust boundary where it enters — config file at startup (`src/config/schema.ts`), HTTP bodies at the handler (`src/httpapi/body.ts` + handlers), and management mutation bodies at the configuration store (`src/config/store.ts`), which reuses the startup grammar helpers so the schema stays one schema (ADR-014). No other validation site is allowed to become a second schema.
- **Follow the strict-schema pattern**: unknown keys are rejected at every level, every problem is collected (not first-fail), the validated result is deep-frozen. Any new config field ships with: type check, grammar check, cross-block reference check, example-file sync (`src/config/example.test.ts` enforces it), and a problem line that never echoes the value.
- **Allowlists over denylists**: header relay uses a whitelist (`RELAYED_REQUEST_HEADERS`) plus a hop-by-hop/credential drop-list; upstream types are a closed set (`UPSTREAM_TYPES`); log levels and balance strategies are closed vocabularies. Keep them closed.
- Body parsing goes through `readJsonBody` (64 MiB cap, cancel on overflow, `JSON.parse` of the buffered result). Never read a request body with an unbounded path; never `eval`/`Function`-parse anything.
- Validate grammar with anchored regexes (`UPSTREAM_ID_PATTERN`, `MODEL_ALIAS_PATTERN`, `LISTEN_PATTERN`, `TLS_FINGERPRINT_PATTERN`) and, for the outbound proxy, the `isValidProxyUrl` helper (ADR-017: scheme `http:` or `socks5:` only, non-empty host, an explicit port in 1–65535, no userinfo, no path/query/fragment — value-free problem lines, since a pasted URL might carry credentials); an alias with `/` or whitespace is invalid because `/` is a routing separator — grammar rules encode trust-boundary decisions, do not loosen them silently.

### Output Encoding & Injection Prevention

- There is no SQL, no shell, no template engine, no `eval` in this codebase. Keep it that way: **never** introduce string-built commands, dynamic `import()` of user-influenced specifiers, or `new Function`.
- Upstream URLs are built exactly one way: `baseUrl + "/" + fixedPath` where `baseUrl` is a startup-validated absolute http(s) URL and `fixedPath` is a module constant. Never forward client-controlled strings into a URL, host, or path — `body.model` is rewritten from the *configured* routing table, never taken verbatim to the wire.
- HTML output: React's escaping is the mechanism. `dangerouslySetInnerHTML`, `innerHTML`, and `document.write` are forbidden in `web/src`.
- Error responses come from the single envelope mapper (`src/httpapi/errors.ts`); messages are static or name client-supplied vocabulary (alias, path) — never internal details, stack traces, config values, or credentials. New failure modes add a constructor there; they never `throw` strings toward clients.

### Authentication & Session Security

- Password verification: `Bun.password.verify` against an argon2id PHC hash (generated by `tools/hash-password.ts`). Never store or verify a plaintext password; never invent a custom hashing scheme.
- Every credential comparison — user names, client API keys, any future secret — uses the SHA-256-both-sides + `timingSafeEqual` pattern (`loginMatches` / `clientKeyMatches`). Plain `===` on secrets is forbidden.
- Session tokens: `crypto.getRandomValues`, 32 bytes (256 bits), base64url; absolute TTL (24 h); bounded store (64) with oldest-eviction; in-memory only — a restart is a full logout (fail-closed).
- Cookie attributes are non-negotiable: `HttpOnly; SameSite=Strict; Path=/` plus `Secure` whenever the listener serves TLS.
- Login responses never reveal which half failed; failed logins burn a leveled dummy verify + a fixed delay. Preserve both when touching the login path.
- A new authenticated surface means a new decision in the auth stage — gates mount in `createApp`, not in handlers.

### Cryptography

- Use platform primitives only: `node:crypto` (`createHash`, `timingSafeEqual`, `getRandomValues`) and `Bun.password`. No third-party crypto packages, no hand-rolled constructions.
- Never use MD5/SHA-1 for security purposes; SHA-256 is the digest for credential comparison and SPKI pinning.
- TLS verification is platform fetch or the pinning module (`src/upstreams/tls-pinning.ts`); the pin check fails closed and runs before any request byte is written — on a direct socket and on a proxy's `CONNECT` tunnel alike (ADR-017). There is no "skip verification" mode and none may be added.
- Tokens and digests come from CSPRNGs; never derive randomness from time, counters, or hashes of predictable input.

### Error Handling & Logging

- Gateway-generated failures are always the OpenAI error envelope from `src/httpapi/errors.ts`; upstream 4xx/5xx bodies pass through untouched. Never wrap, rewrite, or "improve" an upstream error body.
- Fail securely: an unexpected exception maps to a generic `502 upstream_error` envelope; internal error text goes to the log, not to the client.
- Startup fails loudly and early: invalid config, unreadable PEM, bind failure — one clear stderr line per problem, exit code 1, before any port binds. Never degrade into a half-configured listening process.
- Never log: credentials, presented keys, session tokens, cookies, request/response bodies, PEM contents. Paths are not secret; file contents are.
- Structured fields over interpolated strings: log objects (`log.debug({ path, client }, "message")`), so the redact paths can match field names.

### File & Resource Handling

- File paths enter only through the config (`server.tls.cert/key`, config path); the gateway reads them at startup and, except for the ADR-014 `config.json` write-back (the management path the store was constructed with — never a client-supplied path, atomic via temp file + rename), writes nothing. Never accept a client-supplied path.
- Static serving stays inside `web/dist` (mounted under `/ui/*` with the prefix rewritten); the SPA fallback reads exactly one file (`web/dist/index.html`). New file-serving code must keep an absolute allowlisted root and cannot serve `config.json`, `tls/`, or anything outside the dist directory.
- Every external call has a fixed timeout (`CONNECT_PROBE_TIMEOUT_MS`, `PIN_PROBE_TIMEOUT_MS`, `FORWARD_TIMEOUT_MS`, `STREAM_IDLE_TIMEOUT_MS`, and since ADR-017 `PROXY_DIAL_TIMEOUT_MS` — the `CONNECT` exchange with an http proxy on the pinned path — plus the bridge's `SOCKS_DIAL_TIMEOUT_MS` for one SOCKS5 dial) with an unref'd timer and an `AbortController`. New network I/O copies this pattern; unbounded waits are defects.
- Every parsed body is capped (64 MiB); a stream that crosses the cap is cancelled, not buffered.

### Dependency & Supply Chain Rules

- See Dependency Management in Security Architecture — the binding rules: minimal tree, committed lockfiles with integrity hashes, `bun audit` gate on dependency changes, platform-first for security primitives.
- New tools under `tools/` that generate or handle credentials must keep their outputs out of version control and their test fixtures synthetic (the committed `src/upstreams/fixtures/*.pem` are test-only synthetic keys — never replace them with real material).

### Secrets & Configuration

- `config.json` and `tls/` are gitignored; this is enforced by convention and must stay in `.gitignore`. Never suggest removing those entries.
- `config.example.json` carries placeholders and stays key-synced with the schema by test — a schema change without an example change fails CI.
- Secrets never appear in: source, tests, commit messages, logs, error envelopes, or the redacted management view. The only environment variable is the config path (`LLM_GATEWAY_CONFIG`).
- Treat any credential that has entered a log, a bug report, or a screenshot as compromised: rotate it (replace in `config.json`, restart).

---

## Rules for AI Coding Agents

These directives are non-negotiable for any AI agent working on this repository.

### Hard Constraints

1. **No secret exposure** — never write, echo, log, commit, or "example-ize" a real credential: provider API keys, client keys, the operator password/hash, session tokens, TLS key material. Placeholders only in `config.example.json`; synthetic keys only in test fixtures.
2. **No disabled security controls** — never bypass or weaken the auth stage, either gate, the per-client ACL, the body cap, the timeouts, the header whitelist/drop-lists, the redact paths, or the fail-closed TLS pin — not even temporarily, not even in tests (tests drive the real gates with fake *values*).
3. **No new credential channels** — no secrets via environment variables, CLI arguments, URLs, or code. The secret ingresses are exactly the config file and the session-gated management mutation bodies ([ADR-014](specs/decisions/014-runtime-management-crud.md)) — both landing in the same two places; the two-place rule is inviolable. The outbound `proxy` URL is a URL: it never carries userinfo and no `Proxy-Authorization` header is ever sent ([ADR-017](specs/decisions/017-per-upstream-outbound-proxy.md)).
4. **No client credential forwarding** — the client's `Authorization` (and every other credential-shaped header) is dropped at the edge and never reaches an upstream; upstreams attach their own config-derived credential. Never "optimize" this away.
5. **No plain-string secret comparison** — every credential check goes through the SHA-256 + `timingSafeEqual` construction; no length/prefix leaks, no early exits on mismatch.
6. **No bodies in logs** — request and response payloads never enter a log line at any level; new logged fields that could carry credential-shaped values must extend `REDACT_PATHS` in the same change.
7. **No client-controlled URL material** — never let request data influence the upstream URL, host, path, or redirect target; the upstream URL is config `baseUrl` + fixed constant path, and redirects are never followed.
8. **No loosened validation** — strict schema (unknown keys rejected, total problem collection, deep-frozen result), anchored grammars, and the 64 MiB cap are contract-level behavior; extending them requires a spec change (ADR) in the same commit, never a silent relaxation.
9. **No suppressed warnings or special-case TLS acceptance** — no `rejectUnauthorized: false`, no ignore-cert flags, no warning-and-continue pin mismatch; pinned upstreams fail closed (ADR-004).
10. **No ungated-surface surprises** — if a change adds a route, it MUST state which surface it belongs to (`/llm/v1/*`, `/api/*`, `/ui/*`) and therefore which gate (or deliberate no-gate rationale) covers it, in the PR description and the touched spec.
11. **Preserve layering** — auth stage first, single error mapper, upstreams as the only request/response mutators (plus the model-id rewrite), config domain as the only schema/redaction owner (`specs/architecture/layers.md`). Security behavior emerging from layering must not be re-implemented per-handler.
12. **Spec-first for structural change** — read the relevant spec under `specs/` (start at `specs/INDEX.md`; credential/key/log work → `specs/architecture/security-model.md`) and update it in the same change; a code↔spec drift is a defect.
13. **No proxy credentials, no proxy-weakened pin** — the configured `proxy` is a credential-free, loopback-bridged hop ([ADR-017](specs/decisions/017-per-upstream-outbound-proxy.md)): never add userinfo to a proxy URL, never send `Proxy-Authorization`, never bind the `socks5://` bridge beyond `127.0.0.1`, never skip or reorder the pin check for a tunnelled socket (it runs before any request byte), and never relay a proxy failure as an upstream answer — it is `502 upstream_proxy_error`. When routing an entry through a proxy, keep its `baseUrl` on `https` (a plain-http target hands the proxy the provider key in clear text).

### Behavioral Guidelines

- **Ask before touching security boundaries** — changes to authentication flows, credential handling, TLS behavior, header policy, or network exposure warrant explicit human review before merging.
- **Preserve existing invariants** — when editing a file, identify the security invariants it implements (see `specs/architecture/security-model.md` invariants 1–18) and leave them holding.
- **Default to the more secure option** when implementations compete; note the choice in the PR.
- **Test the security property** — changes to gates, redaction, caps, ACL, or envelope mapping come with tests that exercise the rejection path (unauthenticated, wrong key, forbidden alias, oversized body), not only the happy path.
- **Flag uncertainty loudly** — if unsure whether a change weakens a boundary, say so in the PR description rather than deciding silently.
- **Respect `.gitignore`** — never propose un-ignoring `config.json` or `tls/`.

---

## Security-Related Configuration Files

| File | Purpose |
| --- | --- |
| `config.json` | Real configuration incl. all credentials — **gitignored**, operator-managed, never committed |
| `config.example.json` | Placeholder-only schema example; kept in sync with `src/config/schema.ts` by test |
| `tls/cert.pem`, `tls/key.pem` | Local TLS listener pair — **gitignored** (`tls/`); generated by `tools/generate-tls-cert.sh`, key written mode `600` |
| `.gitignore` | Carries the `config.json` and `tls/` exclusions — the secret-hygiene backbone |
| `bun.lock`, `web/bun.lock` | Pinned dependency trees with sha512 integrity hashes |
| `tools/hash-password.ts` | argon2id PHC hash generator for `auth.passwordHash` |
| `tools/tls-fingerprint.ts` | SPKI pin generator for `upstreams[].tlsFingerprint` |
| `tools/generate-tls-cert.sh` | Self-signed TLS pair generator for local deployments |
| `specs/architecture/security-model.md` | The authoritative security invariants (trust boundaries, key storage, redaction) |
| `src/config/schema.ts` | The single validation point for all configuration (strict keys, grammar, cross-refs) |
| `src/logging/logger.ts` | The redact-path list every log line passes through |

---

## Revision History

| Date       | Author | Change |
| ---------- | ------ | ------ |
| 2026-11-17 | security-policy-generator (AI agent) | Initial version — threat model for LAN-shared deployment, classical controls, agent rules; ASI section omitted (no agentic indicators) |
| 2026-11-28 | AI agent (ADR-017 docs pass) | Attack surface (outbound proxy hop + loopback bridge listeners; Local unchanged), trust boundaries, assets, the fixed-timeout list (`PROXY_DIAL_TIMEOUT_MS`), the pin-through-a-tunnel rule, and agent rules (#3, new #13) extended for the per-upstream outbound proxy; the former direct-only Outbound wording replaced |
