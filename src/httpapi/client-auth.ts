/**
 * The client-surface auth gate (specs/contracts/client-gateway.md, ADR-008):
 * stage 2 of the auth stage's implementation — the LLM surface `/llm/v1/*`
 * requires a config-backed Bearer API key whenever the `clients` block is
 * configured. The `/api/*` session gate (ADR-007, `src/httpapi/auth.ts`) is
 * a separate credential class on a separate surface and is untouched here.
 *
 *   gate middleware  — every /llm/v1/* request needs `Authorization: Bearer
 *                      <apiKey>` matching one configured client entry, else
 *                      the 401 envelope (no WWW-Authenticate — OpenAI-protocol
 *                      clients configure the header statically)
 *
 * Key verification is the `loginMatches` pattern (ADR-007): SHA-256 digests
 * on both sides through `timingSafeEqual` — no length or prefix-of-match
 * signal leaks, no throw on differing input lengths, and a request without a
 * Bearer credential burns the same one-digest work as a wrong key. The
 * configured keys are held only as digests inside the registry; the presented
 * value is never echoed into a log line, an error message, or a response body
 * (specs/architecture/security-model.md — client keys are a second credential
 * class with the same two-place storage rule as provider keys: the config
 * file and this in-memory slice).
 *
 * Layering (specs/architecture/layers.md): this module is HTTP-layer code.
 * It receives the entry-point-injected client slice as a plain value — the
 * only path by which a client apiKey reaches the HTTP layer — and the
 * logging censor already covers `authorization`/`apiKey` shapes.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type pino from "pino";
import type { GatewayEnv } from "../gateway/router.ts";
import { clientAuthenticationRequiredResponse, invalidApiKeyResponse } from "./errors.ts";

/**
 * One client credential the entry point injects (ADR-008): the validated
 * `clients[]` entry's identifying name and apiKey. The gate is constructed
 * with the config's entries — or an empty list while the runtime store is
 * wired and no clients block exists yet (ADR-014) — so the fields are always
 * present. The name is not secret (the management view shows it verbatim);
 * the apiKey is — it never appears in a log line, an error message, or a
 * response body.
 */
export interface ClientAuthSlice {
  /** Client entry name (verbatim from the config) — names the match in debug logs. */
  readonly name: string;
  /** The API key this client must present as `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string;
  /**
   * The aliases this client may address (`clients[].models` from the config,
   * ADR-009): published with the name on the request context so the dispatch
   * handlers can enforce the per-client alias ACL.
   */
  readonly models: readonly string[];
}

/**
 * Timing-safe client-key comparison: SHA-256 both sides to fixed-length
 * digests, then `timingSafeEqual` — the same construction as `loginMatches`
 * (ADR-007), for the same reasons.
 */
export function clientKeyMatches(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * Extract the credential from an `Authorization` header value: the
 * `Bearer` scheme (case-insensitive per RFC 9110) followed by a non-empty
 * token. Anything else — no header, a foreign scheme, an empty credential —
 * returns null and the gate answers `authentication_required`.
 */
export function bearerTokenOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const captured = match?.[1];
  if (captured === undefined) return null;
  const token = captured.trim();
  return token.length === 0 ? null : token;
}

/**
 * One digest-registry row: the client's identifying name, the fixed-length
 * SHA-256 of its apiKey (the raw key exists nowhere past this mapping), and
 * the alias ACL that travels with the identity on match.
 */
interface ClientDigestEntry {
  readonly name: string;
  readonly digest: Buffer;
  readonly allowedModels: readonly string[];
}

/**
 * Derive the registry rows from client entries: every apiKey becomes a
 * SHA-256 digest here and never survives in any other form.
 */
function digestEntriesOf(clients: readonly ClientAuthSlice[]): ClientDigestEntry[] {
  return clients.map((client) => ({
    name: client.name,
    digest: createHash("sha256").update(client.apiKey, "utf8").digest(),
    allowedModels: client.models,
  }));
}

/**
 * The built gate: the middleware `createApp` mounts on `/llm/v1/*`, plus the
 * hot-apply operation the clients CRUD handlers call after every store
 * mutation (ADR-014 D2). The pair is one value so the registry can never
 * serve stale digests: whoever holds the middleware holds the mutator.
 */
export interface ClientAuthGate {
  middleware: MiddlewareHandler<GatewayEnv>;
  /** Hot-apply: replace the whole digest registry (see createClientAuthGate). */
  replaceClients(clients: readonly ClientAuthSlice[]): void;
}

/**
 * Build the client auth gate: the `/llm/v1/*` Bearer middleware over a
 * MUTABLE digest registry. `createApp` constructs it once at startup — when
 * the config carries a non-empty `clients` block, and also whenever the
 * runtime configuration store is wired (ADR-014): the management CRUD can
 * create the first client at runtime, so the gate must already be mounted in
 * the empty-registry state. An empty registry answers every request with the
 * 401 envelope — fail-closed: the LLM surface never opens because the
 * registry is (or became) empty; that is distinct from the pre-ADR-014
 * deployment shape where no clients block is configured at all and no gate
 * mounts. After every clients-collection mutation the handlers call
 * `replaceClients` with the store's current entries: the digests are
 * re-derived in place and the very next request sees the new registry — a
 * new key admits immediately, a changed ACL cuts immediately, a removed key
 * answers `invalid_api_key` (ADR-014 D2, no restart).
 */
export function createClientAuthGate(clients: readonly ClientAuthSlice[], logger: pino.Logger): ClientAuthGate {
  const log = logger.child({ component: "client-auth" });
  // Digest once per registry generation: the configured keys exist
  // afterwards only as digests inside this closure.
  let expected = digestEntriesOf(clients);

  /**
   * The gate: every /llm/v1/* request needs a Bearer key matching one
   * configured client. Mounted after the request-log middleware so 401s are
   * logged like every request (≥1 line per request), before the route
   * handlers — the answer is produced before any body read or upstream
   * contact. Log lines carry the path and (on success) the client name —
   * never the presented header value or any configured key.
   */
  const middleware: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const token = bearerTokenOf(c.req.header("authorization"));
    if (token === null) {
      log.debug({ path: c.req.path }, "client request without a Bearer API key — 401");
      return clientAuthenticationRequiredResponse();
    }
    const presentedDigest = createHash("sha256").update(token, "utf8").digest();
    for (const entry of expected) {
      if (timingSafeEqual(presentedDigest, entry.digest)) {
        log.debug({ path: c.req.path, client: entry.name }, "client authenticated");
        // Publish the identity for the handlers (ADR-009 per-client ACL):
        // the alias list travels with the name, never the key.
        c.set("client", { name: entry.name, allowedModels: entry.allowedModels });
        await next();
        return;
      }
    }
    log.debug({ path: c.req.path }, "client request with an unknown API key — 401");
    return invalidApiKeyResponse();
  };

  return {
    middleware,
    replaceClients(clients: readonly ClientAuthSlice[]): void {
      expected = digestEntriesOf(clients);
      log.info(
        { clients: expected.length },
        "client digest registry rebuilt — hot-applied within the running gateway",
      );
    },
  };
}
