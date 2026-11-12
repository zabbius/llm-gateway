/**
 * Synchronization between `config.example.json` and the config schema
 * (specs/domains/configuration.md "Example file").
 *
 * The example file is the copy-paste starting point that documents every
 * supported option, so it must never drift from `src/config/schema.ts`.
 * These tests fail when the schema gains, drops, or renames a key without
 * the example following, when a new adapter type is registered without a
 * sample entry, or when the example stops being a valid config — forcing
 * the example update into the same change as the schema change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ADAPTER_KEYS,
  ADAPTER_TYPES,
  TOP_LEVEL_KEYS,
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
    expect(validated.config.listen).toBe("127.0.0.1:8080");
    expect(validated.config.logLevel).toBe("info");
    expect(validated.config.adapters.length).toBeGreaterThanOrEqual(1);
  });

  test("covers every supported top-level key exactly", () => {
    const example = readExample() as Record<string, unknown>;
    expect(Object.keys(example).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
  });

  test("every adapter entry covers every supported adapter key exactly", () => {
    const { adapters } = readExample() as { adapters: Record<string, unknown>[] };
    expect(adapters.length).toBeGreaterThanOrEqual(1);
    for (const entry of adapters) {
      expect(Object.keys(entry).sort()).toEqual([...ADAPTER_KEYS].sort());
    }
  });

  test("every registered adapter type appears at least once", () => {
    const { adapters } = readExample() as { adapters: { type: string }[] };
    const exampleTypes = new Set(adapters.map((entry) => entry.type));
    for (const type of ADAPTER_TYPES) {
      expect(exampleTypes.has(type)).toBe(true);
    }
  });

  test("every baseUrl demonstrates the /v1 root convention in normalized form", () => {
    const { adapters } = readExample() as { adapters: { baseUrl: string }[] };
    for (const entry of adapters) {
      expect(entry.baseUrl.endsWith("/v1")).toBe(true);
      // normalized form: no trailing slash at all (normalizeBaseUrl would strip one)
      expect(entry.baseUrl.endsWith("/")).toBe(false);
    }
  });
});
