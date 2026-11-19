/**
 * Synchronization between `config.example.json` and the config schema
 * (specs/domains/configuration.md "Example file").
 *
 * The example file is the copy-paste starting point that documents every
 * supported option, so it must never drift from `src/config/schema.ts`.
 * These tests fail when the schema gains, drops, or renames a key without
 * the example following, when a new upstream type is registered without a
 * sample entry, or when the example stops being a valid config — forcing
 * the example update into the same change as the schema change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  UPSTREAM_KEYS,
  UPSTREAM_TYPES,
  TOP_LEVEL_KEYS,
  SERVER_KEYS,
  TLS_KEYS,
  CLIENT_KEYS,
  MODEL_KEYS,
  MODEL_ROUTE_KEYS,
  BALANCE_KEYS,
  LIMITS_KEYS,
  validateGatewayConfig,
} from "./schema.ts";

/** Repo root, resolved the same way as in `src/index.test.ts`. */
const EXAMPLE_PATH = join(import.meta.dir, "..", "..", "config.example.json");

function readExample(): unknown {
  return JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
}

describe("config.example.json", () => {
  test("is a valid gateway config carrying the documented defaults", () => {
    const validated = validateGatewayConfig(readExample());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return; // narrowing; the real failure list is asserted above
    expect(validated.config.server.listen).toBe("127.0.0.1:8080");
    expect(validated.config.logLevel).toBe("info");
    expect(validated.config.upstreams.length).toBeGreaterThanOrEqual(1);
  });

  test("covers every supported top-level key exactly", () => {
    const example = readExample() as Record<string, unknown>;
    expect(Object.keys(example).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  });

  test("the server block covers every supported server key exactly", () => {
    const { server } = readExample() as { server: Record<string, unknown> };
    expect(Object.keys(server).sort()).toEqual([...SERVER_KEYS].sort());
  });

  test("the tls block covers every supported tls key exactly", () => {
    const { server } = readExample() as { server: { tls: Record<string, unknown> } };
    expect(Object.keys(server.tls).sort()).toEqual([...TLS_KEYS].sort());
  });

  test("every upstream entry covers every supported upstream key exactly", () => {
    const { upstreams } = readExample() as { upstreams: Record<string, unknown>[] };
    expect(upstreams.length).toBeGreaterThanOrEqual(1);
    for (const entry of upstreams) {
      expect(Object.keys(entry).sort()).toEqual([...UPSTREAM_KEYS].sort());
    }
  });

  test("every client entry covers every supported client key exactly", () => {
    const { clients } = readExample() as { clients: Record<string, unknown>[] };
    expect(clients.length).toBeGreaterThanOrEqual(1);
    for (const entry of clients) {
      expect(Object.keys(entry).sort()).toEqual([...CLIENT_KEYS].sort());
    }
  });

  test("every model entry covers every supported model key exactly", () => {
    const { models } = readExample() as { models: Record<string, unknown>[] };
    expect(models.length).toBeGreaterThanOrEqual(1);
    for (const entry of models) {
      expect(Object.keys(entry).sort()).toEqual([...MODEL_KEYS].sort());
    }
  });

  test("every route covers only supported route keys, with upstream and model required", () => {
    const { models } = readExample() as { models: { routes: Record<string, unknown>[] }[] };
    for (const entry of models) {
      expect(entry.routes.length).toBeGreaterThanOrEqual(1);
      for (const route of entry.routes) {
        for (const key of Object.keys(route)) {
          expect(MODEL_ROUTE_KEYS).toContain(key);
        }
        expect(route.upstream).toBeString();
        expect(route.model).toBeString();
      }
    }
  });

  test("every balance block carries exactly the strategy key, and both strategies appear", () => {
    const { models } = readExample() as {
      models: { routes: { weight?: number }[]; balance: Record<string, unknown> }[];
    };
    const strategies = new Set<string>();
    for (const entry of models) {
      expect(Object.keys(entry.balance).sort()).toEqual([...BALANCE_KEYS].sort());
      const strategy = entry.balance.strategy;
      expect(typeof strategy).toBe("string");
      strategies.add(strategy as string);
      if (strategy === "weighted-round-robin") {
        // the weighted sample demonstrates the optional weight on every route
        for (const route of entry.routes) {
          expect(typeof route.weight).toBe("number");
        }
      } else if (strategy === "round-robin") {
        for (const route of entry.routes) {
          expect(route.weight).toBeUndefined();
        }
      }
    }
    expect(strategies.has("round-robin")).toBe(true);
    expect(strategies.has("weighted-round-robin")).toBe(true);
  });

  test("every limits block carries only known keys and at least one of them", () => {
    const { models } = readExample() as { models: { limits: Record<string, unknown> }[] };
    for (const entry of models) {
      const keys = Object.keys(entry.limits);
      expect(keys.length).toBeGreaterThanOrEqual(1); // an empty limits block never validates
      for (const key of keys) {
        expect(LIMITS_KEYS).toContain(key);
        expect(entry.limits[key]).toBeNumber();
      }
    }
  });

  test("every client reference names a defined alias and every route names a defined upstream", () => {
    const example = readExample() as {
      clients: { models: string[] }[];
      models: { alias: string; routes: { upstream: string }[] }[];
      upstreams: { id: string }[];
    };
    const aliases = new Set(example.models.map((entry) => entry.alias));
    const upstreamIds = new Set(example.upstreams.map((entry) => entry.id));
    for (const client of example.clients) {
      for (const ref of client.models) {
        expect(aliases.has(ref)).toBe(true);
      }
    }
    for (const model of example.models) {
      for (const route of model.routes) {
        expect(upstreamIds.has(route.upstream)).toBe(true);
      }
    }
  });

  test("every registered upstream type appears at least once", () => {
    const { upstreams } = readExample() as { upstreams: { type: string }[] };
    const exampleTypes = new Set(upstreams.map((entry) => entry.type));
    for (const type of UPSTREAM_TYPES) {
      expect(exampleTypes.has(type)).toBe(true);
    }
  });

  test("every baseUrl demonstrates the /v1 root convention in normalized form", () => {
    const { upstreams } = readExample() as { upstreams: { baseUrl: string }[] };
    for (const entry of upstreams) {
      expect(entry.baseUrl.endsWith("/v1")).toBe(true);
      // normalized form: no trailing slash at all (normalizeBaseUrl would strip one)
      expect(entry.baseUrl.endsWith("/")).toBe(false);
    }
  });
});
