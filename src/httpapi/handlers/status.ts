/**
 * `GET /api/status` — the management surface's upstream health snapshot
 * (specs/contracts/gateway-management.md): every configured upstream with
 * the startup-probe outcome the registry retained at startup
 * (`UpstreamRegistry.create()` → `status()`), in config order.
 *
 * Read-only observation, always `200`: the handler contacts no upstream and
 * reads no files — a failed probe is data, not an error (`probe: "failed"`
 * plus its log-safe `reason`), so there is nothing here that can throw into
 * the error mapper. Key material cannot leak: the retained status carries
 * config identity (`id`, `type`) and the probe fact only.
 */
import type { Handler } from "hono";
import type { UpstreamRegistry } from "../../upstreams/registry.ts";
import type { GatewayEnv } from "../../gateway/router.ts";

export function handleStatus(registry: UpstreamRegistry): Handler<GatewayEnv> {
  return async () => {
    const body = JSON.stringify({ upstreams: registry.status() });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
