/**
 * `GET /api/status` — the management surface's health probe
 * (specs/contracts/gateway-management.md): always `200`, composed entirely
 * from state the gateway already holds —
 *
 *  - `status` — the fixed `"ok"` literal: the process is up and serving.
 *    Every deeper fact (startup-probe outcomes, the route inventory) stays
 *    where it is already observable — the startup log lines (probe
 *    warnings, the crosscheck warnings); the HTTP surface carries no
 *    inventory;
 *  - `authenticated` — whether this request carries a valid session.
 *
 * Read-only observation: the handler contacts no upstream, reads no files,
 * and holds no reference to gateway state — nothing here can throw into
 * the error mapper, and the body carries no configuration or credential
 * material by construction.
 */
import type { Handler } from "hono";
import type { GatewayEnv } from "../../gateway/router.ts";

export function handleStatus(authenticated: boolean): Handler<GatewayEnv> {
  return async () => {
    // `authenticated` — whether this request carries a valid session: with
    // auth on, the gate admits only valid sessions, so reaching this handler
    // means true; with auth off everything is anonymous (false). The SPA's
    // mount probe reads this bit to decide whether a Log out control
    // applies.
    const body = JSON.stringify({ status: "ok", authenticated });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
