/**
 * The `redactedConfigView` contract (specs/contracts/gateway-management.md,
 * specs/architecture/security-model.md): the view carries the fixed mask in
 * place of every credential — never the configured values — for entries with
 * and without a `tlsFingerprint`, passes `listen` / `logLevel` / `baseUrl`
 * through verbatim, and neither mutates nor shares objects with the config.
 */
import { describe, expect, test } from "bun:test";
import { CONFIGURED_MASK, redactedConfigView } from "./redact.ts";
import type { NormalizedGatewayConfig, UpstreamConfig } from "./schema.ts";

/** Distinctive key/pin material that must never surface in the view. */
const SECRET_KEY = "sk-live-super-secret-key";
const SECRET_PIN = "ChVe2KjfNPYd8xw7nslGJTBuGOiOq2cQ0CpI1Fh2WhM=";

/** A normalized config holding exactly one upstream entry. */
function normalized(entry: UpstreamConfig): NormalizedGatewayConfig {
  return { listen: "127.0.0.1:9090", logLevel: "debug", upstreams: [entry] };
}

function entry(overrides: Partial<UpstreamConfig> = {}): UpstreamConfig {
  return {
    type: "openai-compatible",
    id: "openai-main",
    baseUrl: "https://api.openai.com/v1",
    apiKey: SECRET_KEY,
    ...overrides,
  };
}

describe("redactedConfigView", () => {
  test("an entry with a tlsFingerprint: apiKey and tlsFingerprint are both the fixed mask", () => {
    const view = redactedConfigView(normalized(entry({ tlsFingerprint: SECRET_PIN })));

    expect(view.upstreams[0]?.apiKey).toBe(CONFIGURED_MASK);
    expect(view.upstreams[0]?.tlsFingerprint).toBe(CONFIGURED_MASK);
    // the exact mask literal the contract pins ([Configured], src/config/redact.ts)
    expect(view.upstreams[0]?.apiKey).toBe("[Configured]");
    expect(view.upstreams[0]?.tlsFingerprint).toBe("[Configured]");
  });

  test("an entry without a tlsFingerprint: null, never the mask, never a value", () => {
    const view = redactedConfigView(normalized(entry()));

    expect(view.upstreams[0]?.apiKey).toBe(CONFIGURED_MASK);
    expect(view.upstreams[0]?.tlsFingerprint).toBeNull();
  });

  test("listen, logLevel, baseUrl, type and id pass through verbatim; config order preserved", () => {
    const config: NormalizedGatewayConfig = {
      listen: "127.0.0.1:9090",
      logLevel: "debug",
      upstreams: [
        entry({ id: "alpha", baseUrl: "https://alpha.example/v1" }),
        entry({ id: "beta", baseUrl: "https://beta.example/v1" }),
      ],
    };

    const view = redactedConfigView(config);
    expect(view.listen).toBe("127.0.0.1:9090");
    expect(view.logLevel).toBe("debug");
    expect(view.upstreams.map((upstream) => upstream.id)).toEqual(["alpha", "beta"]);
    expect(view.upstreams[0]?.type).toBe("openai-compatible");
    expect(view.upstreams[0]?.baseUrl).toBe("https://alpha.example/v1");
    expect(view.upstreams[1]?.baseUrl).toBe("https://beta.example/v1");
  });

  test("no real key or pin material anywhere in the serialized view", () => {
    const view = redactedConfigView(normalized(entry({ tlsFingerprint: SECRET_PIN })));

    const raw = JSON.stringify(view);
    expect(raw).not.toContain(SECRET_KEY);
    expect(raw).not.toContain(SECRET_PIN);
    expect(raw).not.toContain("sk-live");
    expect(raw).toContain(CONFIGURED_MASK);
  });

  test("the view neither mutates nor shares objects with the config", () => {
    const config = normalized(entry({ tlsFingerprint: SECRET_PIN }));
    const view = redactedConfigView(config);

    expect(config.upstreams[0]?.apiKey).toBe(SECRET_KEY); // config untouched
    expect(config.upstreams[0]?.tlsFingerprint).toBe(SECRET_PIN);
    expect(view.upstreams[0]).not.toBe(config.upstreams[0]); // no shared object
    expect(view).toEqual(redactedConfigView(config)); // deterministic
  });
});
