/**
 * The `GET /api/status` handler contract
 * (specs/contracts/gateway-management.md): the always-`200` health probe —
 * the fixed `status: "ok"` literal plus the `authenticated` session bit
 * the SPA's mount probe reads. The former inventory sections
 * (`upstreams[]` / `routes[]` / `meta[]`) are retired: probe outcomes and
 * the route inventory stay in the startup log lines, never HTTP body
 * material — and no key material can enter the body by construction.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { GatewayEnv } from "../../gateway/router.ts";
import { handleStatus } from "./status.ts";

/** The handler mounted on a minimal app, driven through `app.request`. */
function appWith(authenticated = false): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.get("/api/status", handleStatus(authenticated));
  return app;
}

interface StatusBody {
  status: string;
  authenticated: boolean;
}

async function statusResponse(app: Hono<GatewayEnv>): Promise<{ status: number; body: StatusBody; raw: string }> {
  const response = await app.request("/api/status");
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as StatusBody, raw };
}

describe("handleStatus (GET /api/status)", () => {
  test("answers 200 application/json — the fixed ok literal plus the session bit", async () => {
    const { status, body, raw } = await statusResponse(appWith());
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    // mounted without auth: every request is anonymous — the SPA's refresh
    // reads this bit to decide whether a Log out control applies
    expect(body.authenticated).toBe(false);
    // exact contract shape: the two keys and nothing else
    expect(Object.keys(body).sort()).toEqual(["authenticated", "status"]);
    expect(raw).toBe(JSON.stringify({ status: "ok", authenticated: false }));
  });

  test("behind the auth gate the bit flips: app.ts mounts with true once auth is enabled", async () => {
    // With auth on, the gate admits only valid sessions — reaching the
    // handler proves the session, so the mounted flag is true. (The e2e
    // suite drives the same flow through the live gate: login → cookie →
    // `authenticated: true`.)
    const { body } = await statusResponse(appWith(true));
    expect(body).toEqual({ status: "ok", authenticated: true });
  });

  test("always 200 — the probe carries no inventory and holds no gateway state", async () => {
    // The handler receives no registry, models, or metadata store: probe
    // outcomes and the route inventory are startup log lines, not body
    // material. Nothing here can throw into the error mapper — there is no
    // state whose read could fail.
    const { status, body, raw } = await statusResponse(appWith(true));
    expect(status).toBe(200);
    const sections = JSON.parse(raw) as Record<string, unknown>;
    expect(sections.upstreams).toBeUndefined();
    expect(sections.routes).toBeUndefined();
    expect(sections.meta).toBeUndefined();
    expect(body).toEqual({ status: "ok", authenticated: true });
  });

  test("no key material can enter the body — the handler holds no configuration", async () => {
    const { raw } = await statusResponse(appWith(false));
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain("baseUrl");
    expect(raw).not.toContain("[Configured]");
  });
});
