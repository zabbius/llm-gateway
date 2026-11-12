/**
 * UpstreamRegistry construction and lookup contracts
 * (specs/domains/upstreams/README.md): factory dispatch by `type` through the
 * entry-point-injected map, probes awaited (failures logged, never fatal),
 * probe outcomes retained per upstream (`status()` — the GET /api/status
 * snapshot), exact-id `find()`, config-order `all()`, registry written only
 * at create.
 */
import { describe, expect, test } from "bun:test";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "./upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "./registry.ts";

/** Minimal capturing stand-in for the injected pino logger. */
function fakeLogger(): {
  logger: pino.Logger;
  lines: Array<{ level: string; bindings: Record<string, unknown>; obj: unknown; msg: string }>;
} {
  const lines: Array<{ level: string; bindings: Record<string, unknown>; obj: unknown; msg: string }> = [];
  const emit =
    (level: string, bound: Record<string, unknown>) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, bindings: bound, obj, msg: typeof obj === "string" ? obj : (msg ?? "") });
    };
  const build = (bound: Record<string, unknown>): pino.Logger =>
    ({
      trace: emit("trace", bound),
      debug: emit("debug", bound),
      info: emit("info", bound),
      warn: emit("warn", bound),
      error: emit("error", bound),
      fatal: emit("fatal", bound),
      child: (next: Record<string, unknown>) => build({ ...bound, ...next }),
    }) as unknown as pino.Logger;
  return { logger: build({}), lines };
}

function entry(id: string): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl: "https://upstream.example/v1", apiKey: "sk-test" };
}

class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"];
  readonly connectInvoked: boolean[] = [];
  readonly childLogger: pino.Logger;

  constructor(
    config: UpstreamConfig,
    childLogger: pino.Logger,
    private readonly connectResult: "ok" | "throw" = "ok",
  ) {
    this.id = config.id;
    this.type = config.type;
    this.childLogger = childLogger;
  }

  async connect(): Promise<void> {
    this.connectInvoked.push(true);
    this.childLogger.info({ probe: "ran" }, "probe executed");
    if (this.connectResult === "throw") {
      throw new Error("probe exploded");
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    return [];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(null, { status: 204 });
  }
}

function factoriesFor(
  made: FakeUpstream[],
  shouldThrow: (id: string) => boolean = () => false,
): UpstreamFactories {
  return {
    "openai-compatible": (config, childLogger) => {
      const upstream = new FakeUpstream(config, childLogger, shouldThrow(config.id) ? "throw" : "ok");
      made.push(upstream);
      return upstream;
    },
  };
}

describe("UpstreamRegistry", () => {
  test("dispatches by type through the injected factory map, binding an upstream:<id> child logger", async () => {
    const made: FakeUpstream[] = [];
    const { logger, lines } = fakeLogger();

    const registry = await UpstreamRegistry.create(
      [entry("alpha"), entry("beta")],
      factoriesFor(made),
      logger,
    );

    expect(made).toHaveLength(2);
    expect(made.map((upstream) => upstream.id)).toEqual(["alpha", "beta"]);
    expect(made.every((upstream) => upstream.type === "openai-compatible")).toBe(true);
    // connect() ran inside create(), before the registry was handed out:
    expect(made.every((upstream) => upstream.connectInvoked.length === 1)).toBe(true);
    // each upstream got its own component-bound child:
    const components = lines.map((line) => line.bindings.component);
    expect(components).toContain("upstream:alpha");
    expect(components).toContain("upstream:beta");
    expect(registry.all()).toHaveLength(2);
  });

  test("all() returns upstreams in config order", async () => {
    const made: FakeUpstream[] = [];
    const { logger } = fakeLogger();

    const registry = await UpstreamRegistry.create(
      [entry("charlie"), entry("alpha"), entry("bravo")],
      factoriesFor(made),
      logger,
    );

    expect(registry.all().map((upstream) => upstream.id)).toEqual(["charlie", "alpha", "bravo"]);
  });

  test("find() matches ids exactly — no fuzzy or prefix matching", async () => {
    const made: FakeUpstream[] = [];
    const { logger } = fakeLogger();

    const registry = await UpstreamRegistry.create(
      [entry("acme"), entry("acme2")],
      factoriesFor(made),
      logger,
    );

    expect(registry.find("acme")?.id).toBe("acme");
    expect(registry.find("acme2")?.id).toBe("acme2");
    expect(registry.find("acme22")).toBeUndefined();
    expect(registry.find("acm")).toBeUndefined();
    expect(registry.find("acme/more")).toBeUndefined();
    expect(registry.find("")).toBeUndefined();
  });

  test("a throwing connect() is non-fatal: warning with type and id, upstream still registered", async () => {
    const made: FakeUpstream[] = [];
    const { logger, lines } = fakeLogger();

    const registry = await UpstreamRegistry.create(
      [entry("broken"), entry("healthy")],
      factoriesFor(made, (id) => id === "broken"),
      logger,
    );

    // startup continues: both upstreams registered despite the probe blow-up
    expect(registry.find("broken")).toBeDefined();
    expect(registry.find("healthy")).toBeDefined();

    const warnings = lines.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.bindings.component).toBe("upstream:broken");
    expect(warnings[0]?.msg).toContain("startup probe failed");
    const detail = warnings[0]?.obj as { type: string; id: string; reason: string };
    expect(detail.type).toBe("openai-compatible");
    expect(detail.id).toBe("broken");
    expect(detail.reason).toContain("probe exploded");
  });

  test("status() retains every startup-probe outcome in config order — ok, or failed with the log-safe reason", async () => {
    const made: FakeUpstream[] = [];
    const { logger } = fakeLogger();

    const registry = await UpstreamRegistry.create(
      [entry("healthy"), entry("broken"), entry("later")],
      factoriesFor(made, (id) => id === "broken"),
      logger,
    );

    // exact shape: an ok outcome carries no reason key at all; the failed
    // outcome carries the same log-safe reason the warning logged
    // (specs/contracts/gateway-management.md response shape)
    expect(registry.status()).toEqual([
      { id: "healthy", type: "openai-compatible", probe: "ok" },
      { id: "broken", type: "openai-compatible", probe: "failed", reason: "probe exploded" },
      { id: "later", type: "openai-compatible", probe: "ok" },
    ]);
    // a stable startup snapshot: the same read-only entries on every call
    expect(registry.status()).toEqual(registry.status());
  });

  test("create() rejects defensively on duplicate ids (config validation normally prevents this)", async () => {
    const made: FakeUpstream[] = [];
    const { logger } = fakeLogger();

    await expect(
      UpstreamRegistry.create([entry("dupe"), entry("dupe")], factoriesFor(made), logger),
    ).rejects.toThrow("duplicate upstream id");
  });
});
