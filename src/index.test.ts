/**
 * The entry point's startup contracts (specs/architecture/data-flow.md
 * "Startup Flow", specs/architecture/layers.md):
 *
 * - in-process wiring: probes run sequentially, in config order, BEFORE the
 *   listener serves; a failed probe is a warning and startup continues; the
 *   registry is fully populated; parseListen decodes every listen grammar
 *   shape the schema accepts.
 * - subprocess smoke (the real process, real factory map, mock upstream):
 *   GET /llm/v1/models and POST /llm/v1/chat/completions end to end, startup lines on
 *   stderr (config loaded, probe result, listening), stdout stays empty, key
 *   material never appears, SIGTERM shuts down cleanly.
 * - invalid config: every problem on stderr, exit code 1, no port bound.
 * - TLS: https e2e with a throwaway self-signed cert (skipped when openssl is
 *   absent); tls enabled but a PEM file missing → clear stderr line, exit 1,
 *   no port bound.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "./upstreams/upstream.ts";
import type { UpstreamFactories } from "./upstreams/registry.ts";
import { parseListen, startGateway, type GatewayHandles } from "./index.ts";

/** A guaranteed-free loopback port (bind an ephemeral server, close it). */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("ephemeral server reported no port");
  return port;
}

/** Write a config file into a fresh temp dir; returns the path (caller cleans up). */
function tempConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-index-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function cleanupConfig(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}

/** Capturing fake upstream: records probe execution, never touches the network. */
class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"];

  constructor(
    config: UpstreamConfig,
    private readonly logger: pino.Logger,
    private readonly connectResult: "ok" | "throw" = "ok",
  ) {
    this.id = config.id;
    this.type = config.type;
  }

  async connect(): Promise<void> {
    if (this.connectResult === "throw") {
      throw new Error("probe exploded");
    }
    this.logger.info({ probe: "ran" }, "startup probe ok");
  }

  async listModels(): Promise<ModelEntry[]> {
    return [{ id: `${this.id}-model`, object: "model", created: 1, owned_by: this.id }];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(JSON.stringify({ echo: this.id }), {
      headers: { "content-type": "application/json" },
    });
  }
}

/** Factories whose upstreams record probe order in the shared `probes` array. */
function fakeFactories(
  probes: string[],
  throwing: ReadonlySet<string> = new Set(),
): UpstreamFactories {
  return {
    "openai-compatible": (entry, logger) => {
      const upstream = new FakeUpstream(entry, logger, throwing.has(entry.id) ? "throw" : "ok");
      const traced: Upstream = {
        id: upstream.id,
        type: upstream.type,
        connect: async () => {
          probes.push(entry.id);
          await upstream.connect();
        },
        listModels: () => upstream.listModels(),
        forward: (request) => upstream.forward(request),
      };
      return traced;
    },
  };
}

function configJson(listen: string, upstreams: UpstreamConfig[]): Record<string, unknown> {
  return { server: { listen }, logLevel: "none", upstreams };
}

function entry(id: string, baseUrl = "https://upstream.example/v1"): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl, apiKey: `sk-${id}-secret` };
}

describe("parseListen", () => {
  test("splits loopback, hostname, and bracketed IPv6 forms", () => {
    expect(parseListen("127.0.0.1:8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
    expect(parseListen("localhost:3000")).toEqual({ hostname: "localhost", port: 3000 });
    expect(parseListen("[::1]:443")).toEqual({ hostname: "::1", port: 443 });
    expect(parseListen("[2001:db8::1]:9000")).toEqual({ hostname: "2001:db8::1", port: 9000 });
  });
});

describe("startGateway (in-process wiring)", () => {
  test("probes run sequentially in config order before the listener serves", async () => {
    const port = freePort();
    const path = tempConfig(configJson(`127.0.0.1:${port}`, [entry("alpha"), entry("beta")]));
    const probes: string[] = [];
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path, factories: fakeFactories(probes) });

      // By the time the listener answers, every probe already ran — and in order.
      const response = await fetch(`http://127.0.0.1:${port}/llm/v1/models`);
      expect(response.status).toBe(200);
      expect(probes).toEqual(["alpha", "beta"]);

      const body = (await response.json()) as {
        object: string;
        data: Array<{ id: string; owned_by: string }>;
      };
      expect(body.object).toBe("list");
      expect(body.data.map((m) => `${m.id} ${m.owned_by}`)).toEqual([
        "alpha/alpha-model alpha",
        "beta/beta-model beta",
      ]);

      handles.stop();
      await expect(fetch(`http://127.0.0.1:${port}/llm/v1/models`)).rejects.toThrow();
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });

  test("a failed probe warns but does not block startup", async () => {
    const port = freePort();
    const path = tempConfig(configJson(`127.0.0.1:${port}`, [entry("alpha"), entry("beta")]));
    const probes: string[] = [];
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({
        configPath: path,
        factories: fakeFactories(probes, new Set(["beta"])),
      });

      expect(probes).toEqual(["alpha", "beta"]); // the second probe ran after the first threw
      const response = await fetch(`http://127.0.0.1:${port}/llm/v1/models`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((m) => m.id)).toEqual(["alpha/alpha-model", "beta/beta-model"]);
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });

  test("real factory map: unreachable upstream degrades to an empty aggregation", async () => {
    const port = freePort();
    const closed = freePort(); // no listener will ever exist here
    const path = tempConfig(configJson(`127.0.0.1:${port}`, [entry("solo", `http://127.0.0.1:${closed}/v1`)]));
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path }); // default (real) factories

      expect(handles.registry.find("solo")?.id).toBe("solo");
      const response = await fetch(`http://127.0.0.1:${port}/llm/v1/models`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { object: string; data: unknown[] };
      expect(body.object).toBe("list");
      expect(body.data).toEqual([]);
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });
  test("auth enabled: /api gated by the session cookie — /llm/v1 and the shell stay open", async () => {
    const port = freePort();
    const password = "operator-password";
    const passwordHash = Bun.password.hashSync(password, { algorithm: "argon2id" });
    const path = tempConfig({
      ...configJson(`127.0.0.1:${port}`, [entry("alpha")]),
      auth: { enabled: true, user: "admin", passwordHash },
    });
    let handles: GatewayHandles | undefined;
    try {
      handles = await startGateway({ configPath: path, factories: fakeFactories([]) });
      const base = `http://127.0.0.1:${port}`;

      // unauthenticated management read → 401 envelope, no native prompt
      const gated = await fetch(`${base}/api/status`);
      expect(gated.status).toBe(401);
      expect(gated.headers.get("www-authenticate")).toBeNull();
      const gatedBody = (await gated.json()) as { error: { type: string; code: string } };
      expect(gatedBody.error.type).toBe("authentication_error");
      expect(gatedBody.error.code).toBe("authentication_required");

      // the LLM surface and the UI redirect stay open
      expect((await fetch(`${base}/llm/v1/models`)).status).toBe(200);
      expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(302);

      // login mints the cookie; the cookie admits
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "admin", password }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(cookie.startsWith("llm_gateway_session=")).toBe(true);
      expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);

      // the sanitized view masks the hash and names the login
      const configuration = (await (
        await fetch(`${base}/api/configuration`, { headers: { cookie } })
      ).json()) as { auth: { enabled: boolean; user: string; passwordHash: string | null } | null };
      expect(configuration.auth).toEqual({ enabled: true, user: "admin", passwordHash: "[Configured]" });
      expect(JSON.stringify(configuration)).not.toContain(passwordHash);

      // logout revokes: the same cookie stops admitting
      const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
      expect(logout.status).toBe(200);
      expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);

      // wrong credentials: delayed 401 invalid_credentials
      const bad = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "admin", password: "wrong-password" }),
      });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_credentials");
    } finally {
      handles?.stop();
      cleanupConfig(path);
    }
  });
});

describe("startGateway (subprocess, real process)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");

  interface MockUpstream {
    port: number;
    stop(): void;
    seen: Array<{ path: string; authorization: string | undefined; model: unknown }>;
  }

  /** Minimal OpenAI-compatible upstream: records each request it receives. */
  function mockUpstream(): MockUpstream {
    const seen: MockUpstream["seen"] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization") ?? undefined;
        let model: unknown = undefined;
        if (request.method === "POST") {
          const body = (await request.json()) as { model?: unknown };
          model = body.model;
        }
        seen.push({ path: url.pathname, authorization, model });
        if (request.method === "GET" && url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "test-model", object: "model", created: 1, owned_by: "mockup" }],
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
          return Response.json({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          });
        }
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      },
    });
    const port = server.port;
    if (port === undefined) throw new Error("mock upstream reported no port");
    return { port, stop: () => server.stop(true), seen };
  }

  function spawnGateway(configPath: string): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, LLM_GATEWAY_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Narrow the spawned process's piped stream (typed as a union by Bun). */
  function piped(stream: ReturnType<typeof Bun.spawn>["stdout"]): ReadableStream<Uint8Array> {
    if (!(stream instanceof ReadableStream)) throw new Error("expected a piped stream");
    return stream;
  }

  /** Path of openssl, or null when the system has none (the https e2e skips). */
  const OPENSSL = Bun.which("openssl");

  /**
   * Generate a throwaway self-signed certificate/key pair with openssl into
   * `dir` (test-only material; the caller deletes the directory). Returns the
   * two file paths the config references.
   */
  async function selfSignedCert(dir: string): Promise<{ cert: string; key: string }> {
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    const proc = Bun.spawnSync(
      ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : "";
      throw new Error(`openssl failed (code ${proc.exitCode}):\n${stderr}`);
    }
    return { cert, key };
  }

  async function waitUntilReady(
    url: string,
    proc: ReturnType<typeof Bun.spawn>,
    timeoutMs: number,
    init: BunFetchRequestInit = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        const stderr = await new Response(piped(proc.stderr)).text();
        throw new Error(`gateway process exited early (code ${proc.exitCode}):\n${stderr}`);
      }
      try {
        const response = await fetch(url, init);
        if (response.ok) return;
      } catch {
        // not listening yet — poll again
      }
      await Bun.sleep(100);
    }
    throw new Error(`gateway did not become ready within ${timeoutMs}ms: ${url}`);
  }

  test("end-to-end smoke: models list and chat completion through the started process", async () => {
    const apiKey = "sk-smoke-secret-value";
    const upstream = mockUpstream();
    const port = freePort();
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}` },
      logLevel: "info",
      upstreams: [
        { type: "openai-compatible", id: "mock", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey },
      ],
    });
    const proc = spawnGateway(path);
    const stdoutText = new Response(piped(proc.stdout)).text();
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      await waitUntilReady(`http://127.0.0.1:${port}/llm/v1/models`, proc, 15_000);

      // GET /llm/v1/models — aggregation through the running gateway process.
      const modelsResponse = await fetch(`http://127.0.0.1:${port}/llm/v1/models`);
      expect(modelsResponse.status).toBe(200);
      const models = (await modelsResponse.json()) as {
        object: string;
        data: Array<{ id: string; owned_by: string; object: string; created: number }>;
      };
      expect(models.object).toBe("list");
      expect(models.data).toEqual([{ id: "mock/test-model", object: "model", created: 1, owned_by: "mock" }]);

      // POST /llm/v1/chat/completions — dispatch through the running process.
      const chatResponse = await fetch(`http://127.0.0.1:${port}/llm/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer client-junk" },
        body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content: "ping" }] }),
      });
      expect(chatResponse.status).toBe(200);
      const chat = (await chatResponse.json()) as { choices: Array<{ message: { content: string } }> };
      expect(chat.choices[0]?.message.content).toBe("pong");

      // The upstream saw the upstream's own credential and the de-prefixed
      // model — never the client's Authorization header.
      const upstreamProbe = upstream.seen.find((s) => s.path === "/v1/models");
      const upstreamChat = upstream.seen.find((s) => s.path === "/v1/chat/completions");
      expect(upstreamProbe?.authorization).toBe(`Bearer ${apiKey}`);
      expect(upstreamChat?.authorization).toBe(`Bearer ${apiKey}`);
      expect(upstreamChat?.model).toBe("test-model");

      // Startup logging is asserted after shutdown: only then do the piped
      // streams reach EOF and deliver their full contents.
      proc.kill();
      expect(await proc.exited).toBe(0);

      const stderr = await stderrText;
      expect(stderr).toContain('"config loaded');
      expect(stderr).toContain('"id":"mock"');
      expect(stderr).toContain('"type":"openai-compatible"');
      expect(stderr).toContain("startup probe ok");
      expect(stderr).toContain('"gateway listening"');
      expect(stderr).toContain("shutdown requested");
      expect(stderr).not.toContain(apiKey);
      expect(stderr).not.toContain("client-junk");
      // stdout stays empty forever (observability.md).
      expect((await stdoutText).trim()).toBe("");
    } finally {
      proc.kill();
      await proc.exited.catch(() => undefined);
      upstream.stop();
      cleanupConfig(path);
    }
  }, 30_000);

  test("invalid config: every problem on stderr, exit 1, no port bound", async () => {
    const port = freePort(); // the listen the config WOULD have used
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}` },
      logLevel: "info",
      upstreams: [{ type: "nonexistent-type", id: "x", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }],
    });
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      expect(await proc.exited).toBe(1);

      const stderr = await stderrText;
      expect(stderr).toContain("unknown upstream type");
      expect(stderr).toContain("upstreams[0]");
      expect(stderr).not.toContain('"gateway listening"');

      await expect(fetch(`http://127.0.0.1:${port}/llm/v1/models`)).rejects.toThrow();
    } finally {
      proc.kill();
      cleanupConfig(path);
    }
  }, 15_000);

  // Graceful degradation: without openssl the https surface is skipped, not
  // failed — the rest of the suite still verifies the gateway.
  test.skipIf(OPENSSL === null)("end-to-end over TLS: https models list through the started process", async () => {
    const apiKey = "sk-tls-secret-value";
    const upstream = mockUpstream();
    const port = freePort();
    const dir = mkdtempSync(join(tmpdir(), "gw-index-tls-"));
    const { cert, key } = await selfSignedCert(dir);
    const path = tempConfig({
      server: { listen: `127.0.0.1:${port}`, tls: { enabled: true, cert, key } },
      logLevel: "info",
      upstreams: [
        { type: "openai-compatible", id: "mock", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey },
      ],
    });
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      // The test client accepts the self-signed certificate — the fetch-side
      // equivalent of curl -k, scoped to these requests only. Verification
      // stays fully on everywhere else.
      const insecure: BunFetchRequestInit = { tls: { rejectUnauthorized: false } };
      const url = `https://127.0.0.1:${port}/llm/v1/models`;
      await waitUntilReady(url, proc, 15_000, insecure);

      const modelsResponse = await fetch(url, insecure);
      expect(modelsResponse.status).toBe(200);
      const models = (await modelsResponse.json()) as {
        object: string;
        data: Array<{ id: string; owned_by: string; object: string; created: number }>;
      };
      expect(models.object).toBe("list");
      expect(models.data).toEqual([{ id: "mock/test-model", object: "model", created: 1, owned_by: "mock" }]);

      proc.kill();
      expect(await proc.exited).toBe(0);

      const stderr = await stderrText;
      expect(stderr).toContain('"gateway listening"');
      // The listening line carries the fact of TLS — never the PEM contents
      // (security-model.md invariant 7).
      expect(stderr).toContain('"tls":true');
      expect(stderr).not.toContain("BEGIN CERTIFICATE");
      expect(stderr).not.toContain("PRIVATE KEY");
      expect(stderr).not.toContain(apiKey);
    } finally {
      proc.kill();
      await proc.exited.catch(() => undefined);
      upstream.stop();
      cleanupConfig(path);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("tls enabled but the certificate file is missing: clear stderr line, exit 1, no port bound", async () => {
    const port = freePort(); // the listen the config WOULD have used
    const dir = mkdtempSync(join(tmpdir(), "gw-index-tls-missing-"));
    const certPath = join(dir, "cert.pem"); // never created
    const keyPath = join(dir, "key.pem"); // never created
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          server: { listen: `127.0.0.1:${port}`, tls: { enabled: true, cert: certPath, key: keyPath } },
          logLevel: "info",
          upstreams: [{ type: "openai-compatible", id: "mock", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }],
        },
        null,
        2,
      ),
    );
    const proc = spawnGateway(path);
    const stderrText = new Response(piped(proc.stderr)).text();
    try {
      expect(await proc.exited).toBe(1);

      const stderr = await stderrText;
      expect(stderr).toContain(`tls certificate file not found/readable: ${certPath}`);
      expect(stderr).not.toContain('"gateway listening"');

      await expect(fetch(`http://127.0.0.1:${port}/llm/v1/models`)).rejects.toThrow();
    } finally {
      proc.kill();
      cleanupConfig(path);
    }
  }, 15_000);
});
