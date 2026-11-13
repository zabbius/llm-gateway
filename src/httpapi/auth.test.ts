/**
 * The auth gate contract (specs/contracts/gateway-management.md, ADR-008):
 * login success/failure/malformed-body paths, the /api/* session gate (401
 * envelope, no WWW-Authenticate), logout idempotence and revocation, the
 * ungated surfaces (/llm/v1), cookie attributes, and the in-memory session
 * store (TTL, bounded size). Credential material — the configured hash, the
 * presented passwords, session tokens — never appears in a response body or
 * a Set-Cookie beyond the token itself.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type pino from "pino";
import type { GatewayEnv } from "../gateway/router.ts";
import { LOGIN_FAILURE_DELAY_MS, MAX_SESSIONS, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, createAuthGate, loginMatches } from "./auth.ts";

/** A real argon2id hash of the test operator's password (verified below). */
const OPERATOR_USER = "admin";
const OPERATOR_PASSWORD = "operator-password-31337";
const OPERATOR_HASH = await Bun.password.hash(OPERATOR_PASSWORD, { algorithm: "argon2id" });

/** Minimal capturing stand-in for the root pino logger (app.test.ts pattern). */
function fakeLogger(): pino.Logger {
  const build = (bound: Record<string, unknown>): pino.Logger =>
    ({
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: (next: Record<string, unknown>) => build({ ...bound, ...next }),
    }) as unknown as pino.Logger;
  return build({});
}

/** The gate mounted on a minimal app: one protected route + one ungated one. */
function appWith(secureCookies = false): Hono<GatewayEnv> {
  const gate = createAuthGate(
    { user: OPERATOR_USER, passwordHash: OPERATOR_HASH, secureCookies },
    fakeLogger(),
  );
  const app = new Hono<GatewayEnv>();
  // the gate mounts before the protected handler — registration order is
  // execution order in Hono, so a later `use` never sees an earlier route's
  // response; login/logout are exempt inside the gate itself.
  app.use("/api/*", gate.middleware);
  app.post("/api/login", gate.login);
  app.post("/api/logout", gate.logout);
  app.get("/api/status", (c) => c.json({ upstreams: [] }));
  app.get("/llm/v1/models", (c) => c.json({ data: [] }));
  return app;
}

function login(app: Hono<GatewayEnv>, body: unknown) {
  return app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionCookieOf(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

describe("the /api/* session gate (auth enabled)", () => {
  test("a request without a cookie gets the 401 envelope, no WWW-Authenticate", async () => {
    const response = await appWith().request("/api/status");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const body = (await response.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("authentication_required");
    expect(body.error.message).not.toContain(OPERATOR_PASSWORD);
  });

  test("a garbage or foreign cookie gets the same 401", async () => {
    for (const cookie of [`${SESSION_COOKIE}=not-a-token`, "other=cookie", `${SESSION_COOKIE}=`, "cookie-without-name"]) {
      const response = await appWith().request("/api/status", { headers: { cookie } });
      expect(response.status).toBe(401);
    }
  });

  test("the LLM surface passes ungated", async () => {
    const response = await appWith().request("/llm/v1/models");
    expect(response.status).toBe(200);
  });
});

describe("POST /api/login", () => {
  test("correct credentials: 200, session cookie with the contract attributes, then the gate admits", async () => {
    const app = appWith();
    const started = Date.now();
    const response = await login(app, { user: OPERATOR_USER, password: OPERATOR_PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });

    const cookie = sessionCookieOf(response);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=");
    expect(cookie).not.toContain("Secure"); // plain-http listener → no Secure flag
    expect(cookie).not.toContain(OPERATOR_PASSWORD);
    expect(cookie).not.toContain(OPERATOR_HASH);

    const token = cookie.split(";")[0]?.split("=")[1] ?? "";
    const admitted = await app.request("/api/status", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(admitted.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(LOGIN_FAILURE_DELAY_MS); // no delay on success
  });

  test("Secure is added when the listener serves TLS", async () => {
    const response = await login(appWith(true), { user: OPERATOR_USER, password: OPERATOR_PASSWORD });
    expect(sessionCookieOf(response)).toContain("Secure");
  });

  test("wrong password: delayed 401 invalid_credentials, message names neither half", async () => {
    const app = appWith();
    const started = Date.now();
    const response = await login(app, { user: OPERATOR_USER, password: "wrong-password" });

    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOGIN_FAILURE_DELAY_MS - 25);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_credentials");
    expect(body.error.message).not.toContain("password");
    expect(body.error.message).not.toContain("wrong-password");
  });

  test("wrong user costs the same as a wrong password (leveling) and fails identically", async () => {
    const app = appWith();
    const started = Date.now();
    const response = await login(app, { user: "who-is-this", password: OPERATOR_PASSWORD });

    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOGIN_FAILURE_DELAY_MS - 25);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_credentials");
  });

  test("a non-JSON body and non-string fields are 400, without the failure delay", async () => {
    const app = appWith();

    const notJson = await app.request("/api/login", { method: "POST", body: "not-json" });
    expect(notJson.status).toBe(400);

    const started = Date.now();
    const missingFields = await login(app, { user: OPERATOR_USER });
    expect(missingFields.status).toBe(400);
    const numericFields = await login(app, { user: 42, password: 24 });
    expect(numericFields.status).toBe(400);
    expect(numericFields.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(LOGIN_FAILURE_DELAY_MS);
  });
});

describe("POST /api/logout", () => {
  test("revokes the session: the cookie stops admitting, the answer expires the cookie", async () => {
    const app = appWith();
    const loginResponse = await login(app, { user: OPERATOR_USER, password: OPERATOR_PASSWORD });
    const token = sessionCookieOf(loginResponse).split(";")[0]?.split("=")[1] ?? "";

    const logout = await app.request("/api/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ authenticated: false });
    expect(sessionCookieOf(logout)).toContain("Max-Age=0");

    const after = await app.request("/api/status", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(after.status).toBe(401);
  });

  test("is idempotent without a session", async () => {
    const response = await appWith().request("/api/logout", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(sessionCookieOf(response)).toContain("Max-Age=0");
  });
});

describe("SessionStore", () => {
  test("validate accepts a live token and drops an expired one", () => {
    const store = new SessionStore();
    const { token } = store.create(1000);

    expect(store.validate(token, 1000 + SESSION_TTL_MS - 1)).toBe(true);
    expect(store.validate(token, 1000 + SESSION_TTL_MS)).toBe(false); // expiry is inclusive-fail
    expect(store.size).toBe(0); // the expired session was dropped
  });

  test("the store is bounded: the oldest session is evicted beyond the cap", () => {
    const store = new SessionStore();
    const first = store.create(0).token;
    for (let i = 1; i < MAX_SESSIONS; i++) store.create(i);
    expect(store.size).toBe(MAX_SESSIONS);

    store.create(MAX_SESSIONS); // evicts `first`
    expect(store.size).toBe(MAX_SESSIONS);
    expect(store.validate(first, 0)).toBe(false);
  });

  test("revoke is a silent no-op for unknown tokens", () => {
    const store = new SessionStore();
    store.revoke("never-minted");
    expect(store.size).toBe(0);
  });
});

describe("loginMatches (timing-safe user comparison)", () => {
  test("exact match true; everything else false — including length and case drift", () => {
    expect(loginMatches(OPERATOR_USER, OPERATOR_USER)).toBe(true);
    expect(loginMatches("Admin", OPERATOR_USER)).toBe(false);
    expect(loginMatches("", OPERATOR_USER)).toBe(false);
    expect(loginMatches("admin-with-a-much-longer-name", OPERATOR_USER)).toBe(false);
    expect(loginMatches(OPERATOR_USER, "")).toBe(false);
  });
});
