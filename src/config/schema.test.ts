/**
 * Unit tests for the config schema's `clients` and `models` blocks
 * (specs/domains/configuration.md): a valid config parses into a normalized,
 * deep-frozen shape; unknown keys are rejected with one problem line each at
 * every level (client entries, model entries, nested `routes`/`balance`);
 * the cross-block references — `clients[].models` → `models[].alias` and
 * `models[].routes[].upstream` → `upstreams[].id` — are validated like any
 * other config error, strategy/weight consistency is enforced, and the
 * per-entry `limits` block accepts only known keys and positive integers
 * (a present block carries at least one). The file grammar's "no value"
 * rule — absent, `null` and `""` are the only unset forms for `apiKey` /
 * `tlsFingerprint` / `proxy`, whitespace-only is a problem — is covered at
 * the validator level here. The pre-existing blocks (`server`, `auth`,
 * `upstreams`) are otherwise covered through the loader in `load.test.ts`
 * and the example sync in `example.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  BALANCE_KEYS,
  CLIENT_KEYS,
  LIMITS_KEYS,
  MODEL_KEYS,
  MODEL_ROUTE_KEYS,
  validateGatewayConfig,
} from "./schema.ts";

const CLIENT_SECRET = "client-key-material-that-never-leaks";

/** One valid upstream entry. */
function upstream(id = "openai"): Record<string, unknown> {
  return { type: "openai-compatible", id, baseUrl: "https://api.openai.com/v1", apiKey: "sk-upstream" };
}

/** One valid client entry. */
function client(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "local-dev", apiKey: CLIENT_SECRET, models: ["smart"], ...overrides };
}

/** One valid model entry (weighted strategy with weights on every route). */
function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: "smart",
    routes: [
      { upstream: "openai", model: "gpt-4o", weight: 3 },
      { upstream: "ollama", model: "qwen2.5:7b-instruct", weight: 1 },
    ],
    balance: { strategy: "weighted-round-robin" },
    ...overrides,
  };
}

/** A config value valid except for the given overrides (replaced wholesale). */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { upstreams: [upstream(), upstream("ollama")], clients: [client()], models: [model()], ...overrides };
}

describe("validateGatewayConfig — clients/models blocks", () => {
  test("a valid config parses; the normalized shape carries clients and models", () => {
    const validated = validateGatewayConfig(config());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return; // narrowing; the real failure list is asserted above

    expect(validated.config.clients).toEqual([{ name: "local-dev", apiKey: CLIENT_SECRET, models: ["smart"] }]);
    expect(validated.config.models).toEqual([
      {
        alias: "smart",
        routes: [
          { upstream: "openai", model: "gpt-4o", weight: 3 },
          { upstream: "ollama", model: "qwen2.5:7b-instruct", weight: 1 },
        ],
        balance: { strategy: "weighted-round-robin" },
      },
    ]);
  });

  test("absent blocks parse into the legacy shape: no clients, no models", () => {
    const validated = validateGatewayConfig({ upstreams: [upstream()] });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.config.clients).toBeUndefined();
    expect(validated.config.models).toBeUndefined();
  });

  test("the normalized config is deep-frozen — the validated shape is immutable", () => {
    const validated = validateGatewayConfig(config());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const parsed = validated.config;

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.server)).toBe(true);
    expect(Object.isFrozen(parsed.upstreams[0])).toBe(true);
    expect(Object.isFrozen(parsed.clients)).toBe(true);
    expect(Object.isFrozen(parsed.clients?.[0])).toBe(true);
    expect(Object.isFrozen(parsed.clients?.[0]?.models)).toBe(true);
    expect(Object.isFrozen(parsed.models)).toBe(true);
    expect(Object.isFrozen(parsed.models?.[0])).toBe(true);
    expect(Object.isFrozen(parsed.models?.[0]?.routes)).toBe(true);
    expect(Object.isFrozen(parsed.models?.[0]?.routes[0])).toBe(true);
    expect(Object.isFrozen(parsed.models?.[0]?.balance)).toBe(true);
  });

  test("the normalized entries share no object with the input", () => {
    const value = config();
    const validated = validateGatewayConfig(value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const inputClient = (value.clients as Record<string, unknown>[])[0];
    const inputModel = (value.models as Record<string, unknown>[])[0];
    expect(inputClient).toBeDefined();
    expect(inputModel).toBeDefined();
    if (inputClient === undefined || inputModel === undefined) return;
    expect(validated.config.clients?.[0]).not.toBe(inputClient);
    expect(validated.config.clients?.[0]?.models).not.toBe(inputClient.models);
    expect(validated.config.models?.[0]).not.toBe(inputModel);
    expect(validated.config.models?.[0]?.routes[0]).not.toBe((inputModel.routes as unknown[])[0]);
    expect(validated.config.models?.[0]?.balance).not.toBe(inputModel.balance);
    // the input itself stays unfrozen and untouched
    expect(Object.isFrozen(inputClient)).toBe(false);
    expect(inputClient.models).toEqual(["smart"]);
  });

  test("empty clients/models arrays are rejected — a present block carries at least one entry", () => {
    const validated = validateGatewayConfig(config({ clients: [], models: [] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      "clients must be an array with at least one client entry",
      "models must be an array with at least one model entry",
    ]);
  });

  test("unknown keys are rejected with one problem line at every new level", () => {
    const validated = validateGatewayConfig(
      config({
        clients: [{ name: "c", apiKey: "k", models: ["smart"], extra: 1 }],
        models: [
          {
            alias: "smart",
            routes: [{ upstream: "openai", model: "gpt-4o", weight: 1, retry: 2 }],
            balance: { strategy: "round-robin", mode: "fast" },
            limits: { context: 4096, size: 8 },
            ttl: 60,
          },
        ],
      }),
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      `clients[0]: unknown key "extra" (valid keys: ${CLIENT_KEYS.join(", ")})`,
      `models[0]: unknown key "ttl" (valid keys: ${MODEL_KEYS.join(", ")})`,
      `models[0]: routes[0]: unknown key "retry" (valid keys: ${MODEL_ROUTE_KEYS.join(", ")})`,
      `models[0]: balance: unknown key "mode" (valid keys: ${BALANCE_KEYS.join(", ")})`,
      // strategy/weight consistency: round-robin must not carry weights
      `models[0]: routes[0]: weight is only valid when the balance strategy is "weighted-round-robin" (strategy is "round-robin")`,
      `models[0]: limits: unknown key "size" (valid keys: ${LIMITS_KEYS.join(", ")})`,
    ]);
  });

  test("a client model reference that matches no alias is a fatal config error", () => {
    const validated = validateGatewayConfig(config({ clients: [client({ models: ["missing-alias"] })] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'clients[0]: models[0]: unknown model alias "missing-alias" — no models[] entry defines it',
    ]);
  });

  test("a route upstream that matches no upstream id is a fatal config error", () => {
    const validated = validateGatewayConfig(
      config({
        models: [
          model({
            routes: [{ upstream: "no-such-upstream", model: "gpt-4o", weight: 1 }],
          }),
        ],
      }),
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'models[0]: routes[0]: unknown upstream "no-such-upstream" — no upstreams[] entry declares this id',
    ]);
  });

  test("both cross-block references are validated in one run, after the per-entry problems", () => {
    const validated = validateGatewayConfig(
      config({
        clients: [client({ models: ["ghost"] })],
        models: [model({ routes: [{ upstream: "ghost-upstream", model: "m", weight: 1 }] })],
      }),
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'clients[0]: models[0]: unknown model alias "ghost" — no models[] entry defines it',
      'models[0]: routes[0]: unknown upstream "ghost-upstream" — no upstreams[] entry declares this id',
    ]);
  });

  test("a weighted-round-robin entry requires a weight on every route", () => {
    const validated = validateGatewayConfig(
      config({
        models: [
          model({
            routes: [
              { upstream: "openai", model: "gpt-4o", weight: 2 },
              { upstream: "ollama", model: "qwen2.5:7b-instruct" },
            ],
          }),
        ],
      }),
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'models[0]: routes[1]: weight is required when the balance strategy is "weighted-round-robin"',
    ]);
  });

  test("a route weight must be a positive integer", () => {
    const validated = validateGatewayConfig(
      config({
        models: [
          model({
            balance: { strategy: "weighted-round-robin" },
            routes: [{ upstream: "openai", model: "gpt-4o", weight: 0 }],
          }),
        ],
      }),
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual(["models[0]: routes[0]: weight must be a positive integer"]);
  });

  test("an unknown balance strategy is rejected with the valid values listed", () => {
    const validated = validateGatewayConfig(
      config({ models: [model({ balance: { strategy: "random" }, routes: [{ upstream: "openai", model: "m" }] })] }),
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'models[0]: balance: strategy must be one of: round-robin, weighted-round-robin (got "random")',
    ]);
  });

  test("model aliases are unique across the array and never contain \"/\" or whitespace", () => {
    const validated = validateGatewayConfig(config({ models: [model(), model({ alias: "smart" })] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual(['duplicate model alias "smart" (entries 0, 1)']);

    const slashed = validateGatewayConfig(
      config({ clients: undefined, models: [model({ alias: "openai/gpt-4o" })] }),
    );
    expect(slashed.ok).toBe(false);
    if (slashed.ok) return;
    expect(slashed.problems).toEqual([
      'models[0]: model alias "openai/gpt-4o" must be a non-empty string without "/" or whitespace ("/" is the upstream-prefix separator)',
    ]);
  });

  test("duplicate client names and duplicate routes within one entry are rejected", () => {
    const validated = validateGatewayConfig(config({ clients: [client(), client()] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual(['duplicate client name "local-dev" (entries 0, 1)']);

    const duplicateRoute = validateGatewayConfig(
      config({
        models: [
          model({
            routes: [
              { upstream: "openai", model: "gpt-4o", weight: 1 },
              { upstream: "openai", model: "gpt-4o", weight: 2 },
            ],
          }),
        ],
      }),
    );
    expect(duplicateRoute.ok).toBe(false);
    if (duplicateRoute.ok) return;
    expect(duplicateRoute.problems).toEqual(['models[0]: duplicate route "openai/gpt-4o" in the routes array']);
  });

  test("a problem line names the rule but never echoes a client apiKey — \"\" and whitespace-only alike", () => {
    for (const apiKey of ["", "   ", " \n\t "]) {
      const validated = validateGatewayConfig(config({ clients: [client({ apiKey })] }));
      expect(validated.ok).toBe(false);
      if (validated.ok) return;
      expect(validated.problems).toEqual(["clients[0]: apiKey must be a non-empty string"]);
      const raw = JSON.stringify(validated.problems);
      expect(raw).not.toContain(CLIENT_SECRET);
    }
  });

  test("a client models array entry must be a non-empty string; duplicates within one client are rejected", () => {
    const validated = validateGatewayConfig(config({ clients: [client({ models: ["smart", "smart", ""] })] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'clients[0]: duplicate model alias "smart" in the models array',
      "clients[0]: models[2] must be a non-empty string naming a models[].alias",
    ]);
  });
});

describe("validateGatewayConfig — the model limits block", () => {
  test("a valid limits block with both keys parses, is copied and deep-frozen", () => {
    const value = config({ models: [model({ limits: { context: 128000, output: 16384 } })] });
    const validated = validateGatewayConfig(value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return; // narrowing; the real failure list is asserted above

    const entry = validated.config.models?.[0];
    expect(entry?.limits).toEqual({ context: 128000, output: 16384 });
    expect(Object.isFrozen(entry?.limits)).toBe(true);
    // the normalized block shares no object with the input
    const inputLimits = (value.models as Record<string, unknown>[])[0]?.limits;
    expect(entry?.limits).not.toBe(inputLimits);
    expect(Object.isFrozen(inputLimits)).toBe(false); // the input stays untouched
  });

  test("a limits block with a single key parses; an absent block stays absent", () => {
    const half = validateGatewayConfig(config({ models: [model({ limits: { output: 4096 } })] }));
    expect(half.ok).toBe(true);
    if (!half.ok) return;
    expect(half.config.models?.[0]?.limits).toEqual({ output: 4096 });

    const absent = validateGatewayConfig(config());
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.config.models?.[0]).not.toHaveProperty("limits");
  });

  test("an empty limits block is rejected — a present block carries at least one key", () => {
    const validated = validateGatewayConfig(config({ models: [model({ limits: {} })] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual(['models[0]: limits must carry at least one of "context", "output"']);
  });

  test("unknown keys inside limits are rejected with the valid key set listed", () => {
    const validated = validateGatewayConfig(config({ models: [model({ limits: { context: 4096, tokens: 8 } })] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([`models[0]: limits: unknown key "tokens" (valid keys: ${LIMITS_KEYS.join(", ")})`]);
  });

  test("context and output must be positive integers — zero, negative, fractional and non-numbers are rejected", () => {
    // `null` is not in the list: a null key is the limit not set (the test below)
    for (const bad of [0, -1, -4096, 4096.5, "4096"]) {
      const byContext = validateGatewayConfig(config({ models: [model({ limits: { context: bad } })] }));
      expect(byContext.ok).toBe(false);
      if (!byContext.ok) {
        expect(byContext.problems).toEqual(["models[0]: limits: context must be a positive integer"]);
      }

      const byOutput = validateGatewayConfig(config({ models: [model({ limits: { output: bad } })] }));
      expect(byOutput.ok).toBe(false);
      if (!byOutput.ok) {
        expect(byOutput.problems).toEqual(["models[0]: limits: output must be a positive integer"]);
      }
    }
  });

  test("a limits block that is not a JSON object is rejected", () => {
    const validated = validateGatewayConfig(config({ models: [model({ limits: "up to 4096 tokens" })] }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual(["models[0]: limits must be a JSON object"]);
  });

  test("a null limit is not set — a block of only nulls is empty, a null sibling leaves the other limit", () => {
    const partial = validateGatewayConfig(config({ models: [model({ limits: { context: null, output: 8192 } })] }));
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.config.models?.[0]?.limits).toEqual({ output: 8192 });

    const hollow = validateGatewayConfig(config({ models: [model({ limits: { context: null, output: null } })] }));
    expect(hollow.ok).toBe(false);
    if (!hollow.ok) {
      expect(hollow.problems).toEqual(['models[0]: limits must carry at least one of "context", "output"']);
    }
  });

  test("a null key in a client or model entry is not set — required keys read as missing, optional ones fall away", () => {
    const hollowClient = validateGatewayConfig(config({ clients: [{ name: null, apiKey: null, models: null }] }));
    expect(hollowClient.ok).toBe(false);
    if (!hollowClient.ok) {
      expect(hollowClient.problems).toEqual([
        'clients[0]: missing required key "name"',
        'clients[0]: missing required key "apiKey"',
        "clients[0]: models must be an array with at least one model alias",
      ]);
    }

    // no client block here — its default alias reference would add a cross-ref problem
    const hollowModel = validateGatewayConfig(
      config({ clients: undefined, models: [{ alias: null, routes: null, balance: null, limits: null }] }),
    );
    expect(hollowModel.ok).toBe(false);
    if (!hollowModel.ok) {
      expect(hollowModel.problems).toEqual([
        'models[0]: missing required key "alias"',
        "models[0]: routes must be an array with at least one route entry",
        'models[0]: missing required key "balance"',
      ]);
    }

    // the null-stripped entry normalizes exactly like one written without the key
    const plain = validateGatewayConfig(
      config({
        models: [
          model({
            balance: { strategy: "round-robin" },
            limits: null,
            routes: [{ upstream: "openai", model: "gpt-4o", weight: null }],
          }),
        ],
      }),
    );
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.config.models?.[0]).toEqual({
        alias: "smart",
        routes: [{ upstream: "openai", model: "gpt-4o" }],
        balance: { strategy: "round-robin" },
      });
      expect(Object.hasOwn(plain.config.models?.[0] ?? {}, "limits")).toBe(false);
    }
  });
});

describe("validateGatewayConfig — the file grammar's \"no value\" rule", () => {
  // Absent, `null` and `""` are the only ways to say "no value" for the
  // optional pin/proxy; whitespace-only is a problem. apiKey has no "no
  // value" form at all: "" and whitespace-only both fail as non-empty-required.

  test("absent, null and \"\" pin/proxy values are valid and leave the entry without the key", () => {
    for (const overrides of [{}, { tlsFingerprint: null, proxy: null }, { tlsFingerprint: "", proxy: "" }]) {
      const validated = validateGatewayConfig({
        ...config(),
        upstreams: [{ ...upstream(), ...overrides }, upstream("ollama")],
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const entry = validated.config.upstreams[0];
      expect(Object.hasOwn(entry ?? {}, "tlsFingerprint")).toBe(false);
      expect(Object.hasOwn(entry ?? {}, "proxy")).toBe(false);
    }
  });

  test("a whitespace-only upstream apiKey is rejected as non-empty-required, exactly like \"\"", () => {
    for (const apiKey of ["", "   ", " \n\t "]) {
      const validated = validateGatewayConfig({
        ...config(),
        upstreams: [{ ...upstream(), apiKey }, upstream("ollama")],
      });
      expect(validated.ok).toBe(false);
      if (!validated.ok) {
        expect(validated.problems).toEqual(["upstreams[0]: apiKey must be a non-empty string"]);
      }
    }
  });

  test("a whitespace-only tlsFingerprint / proxy is a problem naming the key and rule, never the value", () => {
    const validated = validateGatewayConfig({
      ...config(),
      upstreams: [{ ...upstream(), tlsFingerprint: " \n\t ", proxy: "   " }, upstream("ollama")],
    });
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.problems).toEqual([
      'upstreams[0]: tlsFingerprint must not be whitespace-only — omit the key, use null or "" for no value',
      'upstreams[0]: proxy must not be whitespace-only — omit the key, use null or "" for no value',
    ]);
  });

  test("whitespace inside a non-empty pin/proxy is still stripped — only the all-whitespace value is a problem", () => {
    const pin = Buffer.alloc(32, 7).toString("base64");
    const validated = validateGatewayConfig({
      ...config(),
      upstreams: [
        {
          ...upstream(),
          tlsFingerprint: `  ${pin.slice(0, 20)}\n${pin.slice(20)}  `,
          proxy: "  http://proxy.example:8080\n ",
        },
        upstream("ollama"),
      ],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.config.upstreams[0]?.tlsFingerprint).toBe(pin);
    expect(validated.config.upstreams[0]?.proxy).toBe("http://proxy.example:8080");
  });
});
