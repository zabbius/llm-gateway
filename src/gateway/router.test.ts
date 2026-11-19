/**
 * Routing-table contracts (specs/domains/routing.md, ADR-009): exact alias
 * lookup only, usable-route existence, balance-selected selection through the
 * route balancer (specs/domains/load-balancing.md), and the per-client ACL
 * (`clientMayUse`). Selection and health semantics are specified in
 * balancer.test.ts; these tests pin the table's surface over them.
 */
import { describe, expect, test } from "bun:test";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../upstreams/registry.ts";
import type { ModelConfig } from "../config/schema.ts";
import { clientMayUse, createRoutingTable, type GatewayClient } from "./router.ts";

function fakeLogger(): pino.Logger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => fakeLogger(),
  } as unknown as pino.Logger;
}

function entry(id: string): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl: "https://upstream.example/v1", apiKey: "sk-test" };
}

class NullUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"] = "openai-compatible";

  constructor(config: UpstreamConfig) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}
  async listModels(): Promise<ModelEntry[]> {
    return [];
  }
  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(null, { status: 204 });
  }
}

async function registryWith(...ids: string[]) {
  const map = new Map(ids.map((id) => [id, new NullUpstream(entry(id))]));
  const factories: UpstreamFactories = {
    "openai-compatible": (config) => {
      const made = map.get(config.id);
      if (made === undefined) throw new Error(`unexpected id ${config.id}`);
      return made;
    },
  };
  return UpstreamRegistry.create(ids.map(entry), factories, fakeLogger());
}

function modelEntry(alias: string, ...routes: ModelConfig["routes"]): ModelConfig {
  const weighted = routes.some((route) => route.weight !== undefined);
  return {
    alias,
    routes,
    balance: { strategy: weighted ? "weighted-round-robin" : "round-robin" },
  };
}

describe("createRoutingTable — alias existence", () => {
  test("a configured alias lists its usable route with the provider-native model", async () => {
    const registry = await registryWith("alpha", "bravo");
    const table = createRoutingTable(
      [
        modelEntry("gpt-fast", { upstream: "alpha", model: "gpt-4o-mini" }),
        modelEntry("legacy", { upstream: "bravo", model: "davinci-002" }),
      ],
      registry,
    );
    expect(table.routes("gpt-fast")?.map((route) => route.model)).toEqual(["gpt-4o-mini"]);
    expect(table.select("gpt-fast")?.upstream.id).toBe("alpha");
    expect(table.select("gpt-fast")?.upstreamModel).toBe("gpt-4o-mini");
    expect(table.select("legacy")?.upstream.id).toBe("bravo");
  });

  test("an unconfigured alias has no routes — exact lookup, never fuzzy", async () => {
    const registry = await registryWith("alpha");
    const table = createRoutingTable(
      [modelEntry("gpt-fast", { upstream: "alpha", model: "gpt-4o-mini" })],
      registry,
    );
    for (const bad of ["gpt", "gpt-faster", "GPT-FAST", "", "alpha/gpt-4o-mini"]) {
      expect(table.routes(bad)).toBeNull(); // the prefix scheme is gone
      expect(table.select(bad)).toBeNull();
    }
  });

  test("aliases() lists the configured aliases in config order", async () => {
    const registry = await registryWith("alpha", "bravo");
    const table = createRoutingTable(
      [
        modelEntry("zeta", { upstream: "bravo", model: "m" }),
        modelEntry("alpha-first", { upstream: "alpha", model: "m" }),
      ],
      registry,
    );
    expect(table.aliases()).toEqual(["zeta", "alpha-first"]);
  });

  test("a route whose upstream is missing from the registry is dropped; an alias with no routes left does not resolve", async () => {
    const registry = await registryWith("alpha");
    const table = createRoutingTable(
      [
        modelEntry("usable", { upstream: "alpha", model: "m1" }, { upstream: "ghost", model: "m2" }),
        modelEntry("unusable", { upstream: "ghost", model: "m3" }),
      ],
      registry,
    );
    expect(table.aliases()).toEqual(["usable"]);
    expect(table.routes("usable")?.map((route) => route.model)).toEqual(["m1"]);
    expect(table.routes("unusable")).toBeNull();
  });
});

describe("createRoutingTable — balance-selected selection", () => {
  test("round-robin rotates routes in config order, then repeats", async () => {
    const registry = await registryWith("alpha", "bravo");
    const table = createRoutingTable(
      [
        modelEntry(
          "dual",
          { upstream: "alpha", model: "m-alpha" },
          { upstream: "bravo", model: "m-bravo" },
        ),
      ],
      registry,
    );
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(table.select("dual")?.upstreamModel ?? "null");
    }
    expect(seen).toEqual(["m-alpha", "m-bravo", "m-alpha", "m-bravo"]);
  });

  test("weighted round-robin repeats each route proportionally to its weight over a cycle", async () => {
    const registry = await registryWith("alpha", "bravo");
    const table = createRoutingTable(
      [
        modelEntry(
          "weighted",
          { upstream: "alpha", model: "m-alpha", weight: 2 },
          { upstream: "bravo", model: "m-bravo", weight: 1 },
        ),
      ],
      registry,
    );
    // the weight-expanded schedule repeats each route `weight` times in
    // config order: alpha(2), bravo(1) → alpha, alpha, bravo
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(table.select("weighted")?.upstreamModel ?? "null");
    }
    expect(seen).toEqual([
      "m-alpha",
      "m-alpha",
      "m-bravo",
      "m-alpha",
      "m-alpha",
      "m-bravo",
    ]);
  });

  test("per-alias rotation state is independent", async () => {
    const registry = await registryWith("alpha", "bravo");
    const table = createRoutingTable(
      [
        modelEntry(
          "one",
          { upstream: "alpha", model: "m-alpha" },
          { upstream: "bravo", model: "m-bravo" },
        ),
        modelEntry(
          "two",
          { upstream: "alpha", model: "m-alpha" },
          { upstream: "bravo", model: "m-bravo" },
        ),
      ],
      registry,
    );
    table.select("one"); // advances only "one"
    expect(table.select("two")?.upstreamModel).toBe("m-alpha");
    expect(table.select("one")?.upstreamModel).toBe("m-bravo");
  });

  test("a selection reported failed is excluded for the request; a healthy sibling serves", async () => {
    const registry = await registryWith("alpha", "bravo");
    const table = createRoutingTable(
      [
        modelEntry(
          "dual",
          { upstream: "alpha", model: "m-alpha" },
          { upstream: "bravo", model: "m-bravo" },
        ),
      ],
      registry,
    );
    const first = table.select("dual");
    expect(first?.upstream.id).toBe("alpha");
    table.report(first as NonNullable<typeof first>, false); // below the default threshold: eligible again later
    const retried = table.select("dual", new Set([first?.routeId ?? ""]));
    expect(retried?.upstream.id).toBe("bravo");
    expect(retried?.routeId).not.toBe(first?.routeId);
  });
});

describe("clientMayUse — the per-client alias ACL", () => {
  const client: GatewayClient = { name: "acme", allowedModels: ["gpt-fast", "legacy"] };

  test("a listed alias is allowed", () => {
    expect(clientMayUse(client, "gpt-fast")).toBe(true);
    expect(clientMayUse(client, "legacy")).toBe(true);
  });

  test("an unlisted alias is denied", () => {
    expect(clientMayUse(client, "secret-alias")).toBe(false);
    expect(clientMayUse(client, "")).toBe(false);
  });

  test("no authenticated client means no ACL — every alias is addressable", () => {
    expect(clientMayUse(undefined, "anything")).toBe(true);
  });
});
