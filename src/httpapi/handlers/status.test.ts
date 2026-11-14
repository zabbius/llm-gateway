/**
 * The `GET /api/status` handler contracts
 * (specs/contracts/gateway-management.md): the retained startup-probe
 * outcomes in config order, always `200` — a failed probe is data
 * (`probe: "failed"` + its log-safe `reason`), never an error — and no key
 * material ever enters the response body.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../../upstreams/registry.ts";
import type { GatewayEnv } from "../../gateway/router.ts";
import { handleStatus } from "./status.ts";

/** Minimal capturing stand-in for the injected pino logger. */
function fakeLogger(): pino.Logger {
  const noop = () => undefined;
  const build = (): pino.Logger =>
    ({
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      child: () => build(),
    }) as unknown as pino.Logger;
  return build();
}

function entry(id: string): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl: `https://${id}.example/v1`, apiKey: "sk-test" };
}

/** Upstream whose `connect()` probe resolves, or rejects with a given failure. */
class ProbeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"];

  constructor(config: UpstreamConfig, private readonly probeFailure?: Error) {
    this.id = config.id;
    this.type = config.type;
  }

  async connect(): Promise<void> {
    if (this.probeFailure !== undefined) {
      throw this.probeFailure;
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    return [];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(null, { status: 204 });
  }
}

interface ProbeSpec {
  id: string;
  /** When set, the upstream's startup probe rejects with this error. */
  probeFailure?: Error;
}

async function registryWith(specs: ProbeSpec[]): Promise<UpstreamRegistry> {
  const entries = specs.map((spec) => entry(spec.id));
  const factories: UpstreamFactories = {
    "openai-compatible": (config) =>
      new ProbeUpstream(config, specs.find((spec) => spec.id === config.id)?.probeFailure),
  };
  return UpstreamRegistry.create(entries, factories, fakeLogger());
}

/** The handler mounted on a minimal app, driven through `app.request`. */
function appWith(registry: UpstreamRegistry, authenticated = false): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.get("/api/status", handleStatus(registry, authenticated));
  return app;
}

interface StatusEntry {
  id: string;
  type: string;
  probe: string;
  reason?: string;
}

async function statusBody(app: Hono<GatewayEnv>): Promise<{ status: number; body: { upstreams: StatusEntry[]; authenticated: boolean }; raw: string }> {
  const response = await app.request("/api/status");
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as { upstreams: StatusEntry[]; authenticated: boolean }, raw };
}

describe("handleStatus (GET /api/status)", () => {
  test("serves the retained probe outcomes in config order, always 200 — a failed probe is data, not an error", async () => {
    const app = appWith(
      await registryWith([
        { id: "alpha" },
        {
          id: "dead",
          probeFailure: new Error('upstream "dead" is unreachable: timeout'),
        },
        { id: "omega" },
      ]),
    );

    const { status, body, raw } = await statusBody(app);
    expect(status).toBe(200);
    expect(raw).toContain('"probe":"failed"');
    expect(body.upstreams.map((upstream) => upstream.id)).toEqual(["alpha", "dead", "omega"]);
    expect(body.upstreams[1]?.probe).toBe("failed");
    // the log-safe failure fact, same string the startup warning carries
    expect(body.upstreams[1]?.reason).toBe('upstream "dead" is unreachable: timeout');
    // mounted without auth: every request is anonymous — the SPA's refresh
    // reads this bit to decide whether a Log out control applies
    expect(body.authenticated).toBe(false);
  });

  test("an ok probe carries no reason key; only a failed probe does", async () => {
    const app = appWith(
      await registryWith([
        { id: "healthy" },
        { id: "dead", probeFailure: new Error("connection refused") },
      ]),
    );

    const { body } = await statusBody(app);
    const ok = body.upstreams[0] as StatusEntry;
    const failed = body.upstreams[1] as StatusEntry;
    expect(Object.keys(ok).sort()).toEqual(["id", "probe", "type"]);
    expect(Object.keys(failed).sort()).toEqual(["id", "probe", "reason", "type"]);
  });

  test("no key material ever enters the body — neither apiKey nor baseUrl", async () => {
    const app = appWith(
      await registryWith([
        { id: "alpha" },
        { id: "dead", probeFailure: new Error("connection refused") },
      ]),
    );

    const { raw } = await statusBody(app);
    expect(raw).not.toContain("sk-test");
    expect(raw).not.toContain(".example/v1");
  });

  test("answers 200 even when every probe failed", async () => {
    const app = appWith(
      await registryWith([
        { id: "one", probeFailure: new Error("connection refused") },
        { id: "two", probeFailure: new Error("timeout") },
      ]),
    );

    const { status, body } = await statusBody(app);
    expect(status).toBe(200);
    expect(body.upstreams.map((upstream) => upstream.probe)).toEqual(["failed", "failed"]);
  });

  test("behind the auth gate the bit flips: app.ts mounts with true once auth is enabled", async () => {
    // With auth on, the gate admits only valid sessions — reaching the
    // handler proves the session, so the mounted flag is true.
    const app = appWith(await registryWith([{ id: "alpha" }]), true);
    const { body } = await statusBody(app);
    expect(body.authenticated).toBe(true);
  });
});
