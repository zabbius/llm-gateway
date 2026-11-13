/**
 * The `GET /api/configuration` handler contract
 * (specs/contracts/gateway-management.md): the handler returns the redacted
 * view verbatim — always `200`, `application/json`, the exact value the entry
 * point built — and no key material can appear in the body, because the view
 * it serializes carries the mask in place of every credential.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { GatewayEnv } from "../../gateway/router.ts";
import { redactedConfigView } from "../../config/redact.ts";
import { handleConfiguration } from "./configuration.ts";
import type { NormalizedGatewayConfig } from "../../config/schema.ts";

/** Distinctive key/pin material that must never surface in the body. */
const SECRET_KEY = "sk-super-secret-gateway-key";
const SECRET_PIN = "AAkBS7Y8xgDdCPe0bPq0WE1cR4m5jXKzlvJNUdBtTR0=";

/** A normalized config: one pinned upstream, one unpinned. */
function config(): NormalizedGatewayConfig {
  return {
    server: { listen: "127.0.0.1:8080", tls: { enabled: true, cert: "./tls/cert.pem", key: "./tls/key.pem" } },
    logLevel: "info",
    upstreams: [
      {
        type: "openai-compatible",
        id: "openai-main",
        baseUrl: "https://api.openai.com/v1",
        apiKey: SECRET_KEY,
        tlsFingerprint: SECRET_PIN,
      },
      {
        type: "openai-compatible",
        id: "vllm-local",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: SECRET_KEY,
      },
    ],
  };
}

/** The handler mounted on a minimal app, driven through `app.request`. */
function appWith(): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.get("/api/configuration", handleConfiguration(redactedConfigView(config())));
  return app;
}

interface ConfigurationBody {
  server: { listen: string; tls: { enabled: boolean; cert: string | null; key: string | null } | null };
  logLevel: string;
  upstreams: Array<{ type: string; id: string; baseUrl: string; apiKey: string; tlsFingerprint: string | null }>;
}

describe("handleConfiguration (GET /api/configuration)", () => {
  test("returns the redacted view verbatim: 200, application/json, exact body", async () => {
    const view = redactedConfigView(config());
    const app = new Hono<GatewayEnv>();
    app.get("/api/configuration", handleConfiguration(view));

    const response = await app.request("/api/configuration");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const raw = await response.text();
    expect(raw).toBe(JSON.stringify(view)); // verbatim — no re-shaping
    expect(JSON.parse(raw) as ConfigurationBody).toEqual(view);
  });

  test("the body masks credentials: apiKey and tlsFingerprint are the fixed mask, absent pin is null", async () => {
    const response = await appWith().request("/api/configuration");
    const body = (await response.json()) as ConfigurationBody;

    expect(body.server.listen).toBe("127.0.0.1:8080");
    expect(body.server.tls).toEqual({ enabled: true, cert: "./tls/cert.pem", key: "./tls/key.pem" });
    expect(body.logLevel).toBe("info");
    expect(body.upstreams[0]?.apiKey).toBe("[Configured]");
    expect(body.upstreams[0]?.tlsFingerprint).toBe("[Configured]");
    expect(body.upstreams[1]?.apiKey).toBe("[Configured]");
    expect(body.upstreams[1]?.tlsFingerprint).toBeNull();
  });

  test("no configured key or pin material appears anywhere in the response body", async () => {
    const response = await appWith().request("/api/configuration");
    const raw = await response.text();

    expect(raw).not.toContain(SECRET_KEY);
    expect(raw).not.toContain(SECRET_PIN);
    expect(raw).not.toContain("sk-super-secret");
    expect(raw).toContain("[Configured]");
    expect(raw).toContain('"tlsFingerprint":null'); // absent → JSON null, not omission
  });

  test("a config without a tls block serializes server.tls as null", async () => {
    const view = redactedConfigView({ ...config(), server: { listen: "127.0.0.1:8080" } });
    const app = new Hono<GatewayEnv>();
    app.get("/api/configuration", handleConfiguration(view));

    const raw = await (await app.request("/api/configuration")).text();
    expect(raw).toContain('"tls":null'); // absent tls block → JSON null, not omission
  });
});
