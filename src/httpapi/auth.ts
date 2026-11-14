/**
 * The management-surface auth gate (specs/contracts/gateway-management.md,
 * ADR-008): a config-backed cookie session for `/api/*` — stage 1 of the
 * auth stage's implementation ([data-flow.md](../../specs) request lifecycle).
 *
 *   POST /api/login  — {user, password} → 200 + Set-Cookie, or 401 after a
 *                      fixed delay (never reveals which half failed)
 *   POST /api/logout — revokes the presented session, expires the cookie,
 *                      always 200 (idempotent)
 *   gate middleware  — every other /api/* request needs a valid session
 *                      cookie, else the 401 envelope (no WWW-Authenticate —
 *                      the SPA's login card is the only login affordance)
 *
 * Sessions are in-memory only (ADR-008): a 32-byte random token, an absolute
 * TTL, a bounded store, cleared on restart — a restart logs every operator
 * out by design (fail-closed). Credential verification: the user comparison
 * is timing-safe (SHA-256 digests through `timingSafeEqual`), the password
 * goes through `Bun.password.verify` against the configured PHC hash, and a
 * failed login burns a dummy verify + a fixed delay so response timing and
 * short-circuiting leak nothing about which half was wrong.
 *
 * Layering (specs/architecture/layers.md): this module is HTTP-layer code. It
 * receives the entry-point-injected auth slice as a plain value — the only
 * path by which the password hash reaches the HTTP layer — and the plain
 * password, the hash, and session tokens never appear in a log line, an
 * error message, or a response body (specs/architecture/security-model.md
 * invariant 12; the logging censor already covers cookie/authorization).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler, Handler } from "hono";
import type pino from "pino";
import type { GatewayEnv } from "../gateway/router.ts";
import { authenticationRequiredResponse, invalidCredentialsResponse, badRequestResponse, payloadTooLargeResponse } from "./errors.ts";
import { BodyLimitError, readJsonBody } from "./body.ts";

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "llm_gateway_session";

/** Absolute session lifetime; the cookie's Max-Age mirrors it. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Store bound — the oldest session is evicted beyond it (no unbounded growth). */
export const MAX_SESSIONS = 64;

/** Fixed delay before a failed-login 401 (blunts online brute force). */
export const LOGIN_FAILURE_DELAY_MS = 500;

/**
 * A real argon2id PHC hash of a throwaway secret: burned on every failed
 * login so the response timing of a wrong-user attempt matches a wrong-
 * password attempt (which always runs a real verify). Generated once with
 * `bun -e 'Bun.password.hash(...)'`; only its verify cost matters.
 */
const LEVELING_DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$uod+uiD35O2+A3CoDSzvle91cboivnYLe9i3l4kOzp0$xB+QpB1QWvTFuKTi6Yei2E5E/H4z4b8Sj7LH0TXxrmE";

/**
 * The auth slice the entry point injects (ADR-008): the validated `auth`
 * block's credential fields. The gate is only constructed when the schema
 * validated `enabled: true` — which requires both fields — so the fallbacks
 * below are unreachable in production and merely fail closed.
 */
export interface AuthSlice {
  /** Operator login (verbatim from the config). */
  readonly user: string;
  /** PHC password hash (verbatim from the config) — never logged or echoed. */
  readonly passwordHash: string;
  /** Set-Cookie gains `Secure` when the listener serves TLS. */
  readonly secureCookies: boolean;
}

/**
 * In-memory session store: token → absolute expiry. Insertion-ordered, so
 * eviction takes the oldest entry; expired sessions are dropped lazily on
 * validation. Cleared on restart by being in memory only (ADR-008).
 */
export class SessionStore {
  private readonly sessions = new Map<string, { expiresAt: number }>();

  /** Mint a fresh session: 32 random bytes, base64url cookie-safe. */
  create(now: number = Date.now()): { token: string; expiresAt: number } {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(token, { expiresAt });
    return { token, expiresAt };
  }

  /** True while the token exists and has not expired (expired → dropped). */
  validate(token: string, now: number = Date.now()): boolean {
    const session = this.sessions.get(token);
    if (session === undefined) return false;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** Revoke one session; unknown tokens are a silent no-op (logout is idempotent). */
  revoke(token: string): void {
    this.sessions.delete(token);
  }

  /** Current session count (tests). */
  get size(): number {
    return this.sessions.size;
  }
}

/**
 * Timing-safe login comparison: SHA-256 both sides to fixed-length digests,
 * then `timingSafeEqual` — no length or prefix-of-match signal leaks, and
 * no throw on differing input lengths.
 */
export function loginMatches(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/** Parse the `Cookie` header into the session token, or null when absent. */
function sessionTokenOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE && rest.length > 0) {
      return rest.join("=");
    }
  }
  return null;
}

/** Serialize the session cookie (the only Set-Cookie the gate ever emits). */
function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The expired-cookie form used by logout (and never anything else). */
function expiredSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

/**
 * Build the auth gate: the login/logout handlers and the `/api/*` session
 * middleware. Constructed once at startup by `createApp` when (and only
 * when) the config enables auth — with auth off nothing here exists, and
 * the gateway behaves exactly as before ADR-008.
 */
export function createAuthGate(slice: AuthSlice, logger: pino.Logger): {
  middleware: MiddlewareHandler<GatewayEnv>;
  login: Handler<GatewayEnv>;
  logout: Handler<GatewayEnv>;
} {
  const log = logger.child({ component: "auth" });
  const store = new SessionStore();

  /** One credential check: timing-safe user compare + real password verify. */
  async function verifyCredentials(user: unknown, password: unknown): Promise<boolean> {
    const presentedUser = typeof user === "string" ? user : "";
    const presentedPassword = typeof password === "string" ? password : "";
    const userOk = loginMatches(presentedUser, slice.user);
    // The verify runs regardless of the user outcome: a wrong user burns the
    // same argon2id cost as a wrong password — timing distinguishes neither.
    const [passwordOk] = await Promise.all([
      Bun.password.verify(presentedPassword, slice.passwordHash).catch(() => false),
      // Leveling: on a wrong user the real verify above would return fast
      // against an empty string; burn the dummy verify to even the cost.
      userOk ? Promise.resolve() : Bun.password.verify(presentedPassword, LEVELING_DUMMY_HASH).catch(() => false),
    ]);
    return userOk && passwordOk === true;
  }

  const login: Handler<GatewayEnv> = async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      if (error instanceof BodyLimitError) return payloadTooLargeResponse();
      return badRequestResponse("login requires an application/json body");
    }
    const user = (body as { user?: unknown } | null)?.user;
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof user !== "string" || typeof password !== "string") {
      return badRequestResponse("login requires string `user` and `password` fields");
    }

    if (!(await verifyCredentials(user, password))) {
      await Bun.sleep(LOGIN_FAILURE_DELAY_MS);
      log.debug({}, "login failed");
      return invalidCredentialsResponse();
    }

    const { token, expiresAt } = store.create();
    const maxAge = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    log.debug({}, "login succeeded");
    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": sessionCookie(token, maxAge, slice.secureCookies) },
    });
  };

  const logout: Handler<GatewayEnv> = (c) => {
    const token = sessionTokenOf(c.req.header("cookie"));
    if (token !== null) store.revoke(token);
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": expiredSessionCookie(slice.secureCookies) },
    });
  };

  /**
   * The gate: every /api/* request except the two auth actions needs a valid
   * session. Mounted after the request-log middleware so 401s are logged
   * like every request (≥1 line per request), before every route handler.
   */
  const middleware: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const path = c.req.path;
    if (path === "/api/login" || path === "/api/logout") {
      await next();
      return;
    }
    const token = sessionTokenOf(c.req.header("cookie"));
    if (token !== null && store.validate(token)) {
      await next();
      return;
    }
    log.debug({ path }, "management request without a valid session — 401");
    return authenticationRequiredResponse();
  };

  return { middleware, login, logout };
}
