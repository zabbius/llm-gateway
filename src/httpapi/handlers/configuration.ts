/**
 * `GET /api/configuration` — the management surface's sanitized effective
 * configuration (specs/contracts/gateway-management.md): the `server` block
 * (`listen`, `tls`), `logLevel`, and the upstream entries with credentials
 * masked.
 *
 * The handler receives the redacted view built by the entry point
 * (`redactedConfigView`, src/config/redact.ts) as a plain value — the raw
 * config never crosses into the HTTP layer (specs/architecture/layers.md).
 * Read-only observation, always `200`: nothing here reads files or contacts
 * upstreams, and no key material exists in the value it serializes — the
 * mask replaced it before the view was built, so there is nothing that can
 * throw into the error mapper.
 */
import type { Handler } from "hono";
import type { RedactedGatewayConfig } from "../../config/redact.ts";
import type { GatewayEnv } from "../../gateway/router.ts";

export function handleConfiguration(configuration: RedactedGatewayConfig): Handler<GatewayEnv> {
  return async () => {
    const body = JSON.stringify(configuration);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
