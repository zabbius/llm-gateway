/**
 * resolveModel contracts (specs/domains/routing.md): split on the first "/",
 * both halves non-empty, exact registry lookup only, null when unresolved.
 */
import { describe, expect, test } from "bun:test";
import type pino from "pino";
import type { Adapter, AdapterConfig, ModelEntry, ProxyRequest } from "../adapters/adapter.ts";
import { AdapterRegistry, type AdapterFactories } from "../adapters/registry.ts";
import { resolveModel } from "./router.ts";

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

function entry(id: string): AdapterConfig {
  return { type: "openai-compatible", id, baseUrl: "https://upstream.example/v1", apiKey: "sk-test" };
}

class NullAdapter implements Adapter {
  readonly id: string;
  readonly type: AdapterConfig["type"] = "openai-compatible";

  constructor(config: AdapterConfig) {
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
  const map = new Map(ids.map((id) => [id, new NullAdapter(entry(id))]));
  const factories: AdapterFactories = {
    "openai-compatible": (config) => {
      const made = map.get(config.id);
      if (made === undefined) throw new Error(`unexpected id ${config.id}`);
      return made;
    },
  };
  return AdapterRegistry.create(ids.map(entry), factories, fakeLogger());
}

describe("resolveModel", () => {
  test("splits on the FIRST slash; the remainder keeps provider-native slashes", async () => {
    const registry = await registryWith("openai");
    const resolution = resolveModel("openai/gpt/4o-preview", registry);
    expect(resolution?.adapter.id).toBe("openai");
    expect(resolution?.upstreamModel).toBe("gpt/4o-preview");
  });

  test("a slash-less id does not resolve", async () => {
    const registry = await registryWith("openai");
    expect(resolveModel("gpt-4o", registry)).toBeNull();
  });

  test("empty halves do not resolve (leading /, trailing /, lone /)", async () => {
    const registry = await registryWith("openai");
    expect(resolveModel("/gpt-4o", registry)).toBeNull();
    expect(resolveModel("openai/", registry)).toBeNull();
    expect(resolveModel("/", registry)).toBeNull();
  });

  test("prefix lookup is exact — no fuzzy or segment matching", async () => {
    const registry = await registryWith("acme", "acme2");
    expect(resolveModel("acme/m", registry)?.adapter.id).toBe("acme");
    expect(resolveModel("acme2/m", registry)?.adapter.id).toBe("acme2");
    expect(resolveModel("acme22/m", registry)).toBeNull();
    expect(resolveModel("acm/m", registry)).toBeNull();
  });

  test("an unknown adapter prefix does not resolve", async () => {
    const registry = await registryWith("openai");
    expect(resolveModel("nope/gpt-4o", registry)).toBeNull();
  });
});
