/**
 * The `redactedConfigView` contract (specs/contracts/gateway-management.md,
 * specs/architecture/security-model.md): the view carries the fixed mask in
 * place of every credential — never the configured values — for entries with
 * and without a `tlsFingerprint`, passes `server` (the `tls` block becoming
 * `null` when absent) / `logLevel` / `baseUrl` / `proxy` through verbatim
 * (an absent `proxy` becoming `null`), and neither mutates nor shares objects
 * with the config.
 */
import { describe, expect, test } from "bun:test";
import { CONFIGURED_MASK, redactedConfigView } from "./redact.ts";
import { DEFAULT_MAX_REQUEST_BODY_BYTES, type NormalizedGatewayConfig, type UpstreamConfig } from "./schema.ts";

/** Distinctive key/pin material that must never surface in the view. */
const SECRET_KEY = "sk-live-super-secret-key";
const SECRET_PIN = "ChVe2KjfNPYd8xw7nslGJTBuGOiOq2cQ0CpI1Fh2WhM=";

/** A normalized config holding exactly one upstream entry. */
function normalized(
  entry: UpstreamConfig,
  tls?: NormalizedGatewayConfig["server"]["tls"],
): NormalizedGatewayConfig {
  return { server: { listen: "127.0.0.1:9090", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES, tls }, logLevel: "debug", upstreams: [entry] };
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

  test("a configured proxy is verbatim in the view; an absent one is null — the apiKey/tlsFingerprint masks are unchanged", () => {
    const PROXY_URL = "http://forward-proxy.internal:3128";
    const withProxy = redactedConfigView(normalized(entry({ proxy: PROXY_URL, tlsFingerprint: SECRET_PIN })));
    expect(withProxy.upstreams[0]?.proxy).toBe(PROXY_URL); // verbatim, never the mask
    expect(withProxy.upstreams[0]?.apiKey).toBe(CONFIGURED_MASK);
    expect(withProxy.upstreams[0]?.tlsFingerprint).toBe(CONFIGURED_MASK);

    const withoutProxy = redactedConfigView(normalized(entry()));
    expect(withoutProxy.upstreams[0]?.proxy).toBeNull();
    expect(withoutProxy.upstreams[0]?.apiKey).toBe(CONFIGURED_MASK);
    expect(withoutProxy.upstreams[0]?.tlsFingerprint).toBeNull();
  });

  test("the proxy URL is not secret material: it survives serialization verbatim while the key and pin do not", () => {
    const PROXY_URL = "socks5://10.0.0.7:1080";
    const raw = JSON.stringify(redactedConfigView(normalized(entry({ proxy: PROXY_URL, tlsFingerprint: SECRET_PIN }))));

    expect(raw).toContain(PROXY_URL);
    expect(raw).not.toContain(SECRET_KEY);
    expect(raw).not.toContain(SECRET_PIN);
  });

  test("a tls block is mirrored field by field: enabled and the PEM paths", () => {
    const view = redactedConfigView(normalized(entry(), { enabled: true, cert: "./tls/cert.pem", key: "./tls/key.pem" }));

    expect(view.server.tls).toEqual({ enabled: true, cert: "./tls/cert.pem", key: "./tls/key.pem" });
  });

  test("a tls block without cert/key reports null paths, keeping enabled", () => {
    const view = redactedConfigView(normalized(entry(), { enabled: false }));

    expect(view.server.tls).toEqual({ enabled: false, cert: null, key: null });
  });

  test("server, logLevel, baseUrl, type and id pass through verbatim; config order preserved", () => {
    const config: NormalizedGatewayConfig = {
      server: { listen: "127.0.0.1:9090", maxRequestBodyBytes: 8192 },
      logLevel: "debug",
      upstreams: [
        entry({ id: "alpha", baseUrl: "https://alpha.example/v1" }),
        entry({ id: "beta", baseUrl: "https://beta.example/v1" }),
      ],
    };

    const view = redactedConfigView(config);
    expect(view.server.listen).toBe("127.0.0.1:9090");
    expect(view.server.maxRequestBodyBytes).toBe(8192);
    expect(view.server.tls).toBeNull();
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
    expect(view.server).not.toBe(config.server); // no shared server block
    expect(view.server.tls).not.toBe(config.server.tls); // no shared tls block
    expect(view).toEqual(redactedConfigView(config)); // deterministic
  });

  test("an auth block mirrors field by field: enabled + user verbatim, the hash masked", () => {
    const SECRET_HASH = "$argon2id$v=19$m=65536,t=2,p=1$U0VDUkVUU0FMVA$U0VDUkVUUEFTU1dPUkQ";
    const view = redactedConfigView({
      ...normalized(entry({ tlsFingerprint: SECRET_PIN })),
      auth: { enabled: true, user: "root", passwordHash: SECRET_HASH },
    });

    expect(view.auth).toEqual({ enabled: true, user: "root", passwordHash: CONFIGURED_MASK });
    expect(JSON.stringify(view)).not.toContain(SECRET_HASH);
    expect(JSON.stringify(view)).not.toContain("U0VDUkVU"); // no hash fragment survives
  });

  test("a disabled auth block reports null credentials; no block reports null auth", () => {
    const disabled = redactedConfigView({
      ...normalized(entry()),
      auth: { enabled: false },
    });
    expect(disabled.auth).toEqual({ enabled: false, user: null, passwordHash: null });

    const absent = redactedConfigView(normalized(entry()));
    expect(absent.auth).toBeNull();
  });

  test("client entries mirror field by field: name and aliases verbatim, the client key masked", () => {
    const CLIENT_SECRET = "client-secret-material-that-must-not-leak";
    const config = {
      ...normalized(entry()),
      clients: [{ name: "local-dev", apiKey: CLIENT_SECRET, models: ["smart", "fast"] }],
    };
    const view = redactedConfigView(config);

    expect(view.clients).toEqual([{ name: "local-dev", apiKey: CONFIGURED_MASK, models: ["smart", "fast"] }]);
    expect(view.clients?.[0]?.apiKey).toBe("[Configured]");
    expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
    const inputClient = config.clients[0];
    if (inputClient === undefined) return; // narrowing; the shape above guarantees the entry
    expect(view.clients?.[0]).not.toBe(inputClient); // no shared object
    expect(view.clients?.[0]?.models).not.toBe(inputClient.models);
  });

  test("model entries mirror field by field: alias, routes and strategy verbatim, absent weight null", () => {
    const config = {
      ...normalized(entry()),
      models: [
        {
          alias: "smart",
          routes: [
            { upstream: "openai-main", model: "gpt-4o", weight: 3 },
            { upstream: "openai-main", model: "gpt-4o-mini" },
          ],
          balance: { strategy: "weighted-round-robin" as const },
        },
      ],
    };
    const view = redactedConfigView(config);

    expect(view.models).toEqual([
      {
        alias: "smart",
        routes: [
          { upstream: "openai-main", model: "gpt-4o", weight: 3 },
          { upstream: "openai-main", model: "gpt-4o-mini", weight: null },
        ],
        balance: { strategy: "weighted-round-robin" },
        limits: null,
      },
    ]);
    const inputModel = config.models[0];
    if (inputModel === undefined) return; // narrowing; the shape above guarantees the entry
    expect(view.models?.[0]).not.toBe(inputModel); // no shared object
    expect(view.models?.[0]?.routes[0]).not.toBe(inputModel.routes[0]);
    expect(view.models?.[0]?.balance).not.toBe(inputModel.balance);
  });

  test("a limits block mirrors verbatim; a partially filled block reports null for the absent key", () => {
    const config = {
      ...normalized(entry()),
      models: [
        {
          alias: "smart",
          routes: [{ upstream: "openai-main", model: "gpt-4o" }],
          balance: { strategy: "round-robin" as const },
          limits: { context: 128000, output: 16384 },
        },
        {
          alias: "fast",
          routes: [{ upstream: "openai-main", model: "gpt-4o-mini" }],
          balance: { strategy: "round-robin" as const },
          limits: { output: 4096 },
        },
      ],
    };
    const view = redactedConfigView(config);

    expect(view.models?.[0]?.limits).toEqual({ context: 128000, output: 16384 });
    expect(view.models?.[1]?.limits).toEqual({ context: null, output: 4096 });
    // the limits block is not secret, but it is still copied, never shared
    expect(view.models?.[0]?.limits).not.toBe(config.models[0]?.limits);
  });

  test("a model entry without a limits block reports null limits", () => {
    const view = redactedConfigView({
      ...normalized(entry()),
      models: [
        {
          alias: "fast",
          routes: [{ upstream: "openai-main", model: "gpt-4o-mini" }],
          balance: { strategy: "round-robin" as const },
        },
      ],
    });
    expect(view.models?.[0]?.limits).toBeNull();
  });

  test("no clients/models blocks report null — absent means absent, never an empty list", () => {
    const view = redactedConfigView(normalized(entry()));
    expect(view.clients).toBeNull();
    expect(view.models).toBeNull();
  });
});
