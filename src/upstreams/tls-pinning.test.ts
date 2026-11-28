/**
 * TLS SPKI pinning (ADR-004): the pin primitive and the bare-handshake
 * probe, plus OpenAICompatibleUpstream behavior against a REAL local TLS
 * upstream serving self-signed fixtures — the exact deployment scenario
 * pinning exists for (mocking fetch would bypass the TLS layer entirely).
 *
 * The fixtures in `fixtures/` are throwaway public test material: two
 * certificates on ONE key pair (a renewal) and one on a different key.
 * Their pins are asserted against openssl-computed constants below.
 *
 * The outbound-proxy block (ADR-017) runs the same pinned upstream through
 * the test-only http proxy double: the TLS socket comes from a CONNECT
 * tunnel, the pin check still precedes every request byte, and a refused or
 * failed CONNECT is a proxy failure — never a pin decision.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pino from "pino";
import { OpenAICompatibleUpstream } from "./openai-compatible.ts";
import { MockHttpProxy } from "./testing/mock-http-proxy.ts";
import {
  assertPinnedCertificate,
  computeSpkiPin,
  isTlsFailure,
  probePinnedLeaf,
  type PinnedLeaf,
  UpstreamTlsPinError,
} from "./tls-pinning.ts";

// ---------------------------------------------------------------------------
// fixtures — generated once with openssl; the pins are openssl ground truth
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "fixtures");
const PIN_CERT = "K4vmDE8v8SKXajayPc4yMc49GIvJEHyUF8mRo7bu/EM="; // openssl: x509 → pubkey → DER → sha256 → base64
const PIN_OTHER = "A8VHkKJ+IizusSO+4UGTXOEcZNhMEuGMPN/QugJxH0Y=";

function derOf(certFile: string): Buffer {
  return new crypto.X509Certificate(readFileSync(join(FIXTURES, certFile), "utf8")).raw;
}
const CERT_DER = derOf("pinned-test-cert.pem");
const ROTATED_DER = derOf("pinned-test-cert-rotated.pem");
const OTHER_DER = derOf("pinned-test-cert-other.pem");

/** One local TLS provider endpoint serving the given fixture cert/key pair. */
function startTlsProvider(
  certFile: string,
  handler?: (req: Request) => Response | Promise<Response>,
  keyFile = certFile.includes("other") ? "pinned-test-other-key.pem" : "pinned-test-key.pem",
): {
  baseUrl: string;
  requests: string[];
  stop: () => void;
} {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    tls: {
      key: readFileSync(join(FIXTURES, keyFile), "utf8"),
      cert: readFileSync(join(FIXTURES, certFile), "utf8"),
    },
    fetch: (req) => {
      requests.push(new URL(req.url).pathname);
      return handler?.(req) ?? Response.json({ choices: [{ message: { content: "ok" } }] });
    },
  });
  return {
    baseUrl: `https://localhost:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

/** A TCP endpoint that accepts and then never speaks — TLS hangs against it. */
function startHangingTcpEndpoint(): { port: number; stop: () => void } {
  const server: Server = createServer(() => {}); // accepts, never writes
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  return { port, stop: () => server.close() };
}

// ---------------------------------------------------------------------------
// shared test helpers (mirroring openai-compatible.test.ts conventions)
// ---------------------------------------------------------------------------

function fakeLogger(bindings: Record<string, unknown> = {}): {
  logger: pino.Logger;
  lines: Array<{ level: string; obj: unknown; msg: string }>;
} {
  const lines: Array<{ level: string; obj: unknown; msg: string }> = [];
  const emit =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, obj, msg: typeof obj === "string" ? obj : (msg ?? "") });
    };
  const build = (bound: Record<string, unknown>): pino.Logger =>
    ({
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
      child: (next: Record<string, unknown>) => build({ ...bound, ...next }),
    }) as unknown as pino.Logger;
  return { logger: build(bindings), lines };
}

function makeUpstream(
  baseUrl: string,
  tlsFingerprint: string | undefined,
  proxy?: string,
): { upstream: OpenAICompatibleUpstream; lines: Array<{ level: string; obj: unknown; msg: string }> } {
  const { logger, lines } = fakeLogger({ component: "upstream:pinned" });
  const upstream = new OpenAICompatibleUpstream(
    {
      type: "openai-compatible",
      id: "pinned",
      baseUrl,
      apiKey: "sk-upstream-secret",
      ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
      ...(proxy === undefined ? {} : { proxy }),
    },
    logger,
    { pinProbeMs: 2_000 },
  );
  return { upstream, lines };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function proxyRequest(body = JSON.stringify({ model: "gpt-4o", stream: false })): Parameters<
  OpenAICompatibleUpstream["forward"]
>[0] {
  return {
    path: "chat/completions",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: streamOf(body),
  };
}

const tlsServers: Array<{ stop: () => void }> = [];
const tcpServers: Array<{ stop: () => void }> = [];
const proxies: MockHttpProxy[] = [];

/** Await a promise expected to reject; return the rejection reason as an Error. */
async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the probe to reject, but it resolved");
}

/** A loopback port nothing listens on — bound, read, released. */
function closedPort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, error() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** The `error` object of a gateway-synthesized envelope. */
async function errorOf(response: Response): Promise<{ type: string; code: string; message: string }> {
  return ((await response.json()) as { error: { type: string; code: string; message: string } }).error;
}

afterEach(() => {
  for (const server of tlsServers) server.stop();
  tlsServers.length = 0;
  for (const server of tcpServers) server.stop();
  tcpServers.length = 0;
  for (const proxy of proxies) proxy.stop();
  proxies.length = 0;
});

// ---------------------------------------------------------------------------
// the pin primitive
// ---------------------------------------------------------------------------

describe("computeSpkiPin", () => {
  test("matches the openssl-computed pin of the fixture certificate", () => {
    expect(computeSpkiPin(CERT_DER)).toBe(PIN_CERT);
  });

  test("matches the openssl-computed pin from an X509Certificate as well as raw DER", () => {
    expect(computeSpkiPin(new crypto.X509Certificate(CERT_DER))).toBe(PIN_CERT);
  });

  test("a certificate renewed with the same key pair keeps the pin", () => {
    expect(computeSpkiPin(ROTATED_DER)).toBe(PIN_CERT);
  });

  test("a different key pair has a different pin", () => {
    expect(computeSpkiPin(OTHER_DER)).toBe(PIN_OTHER);
    expect(PIN_OTHER).not.toBe(PIN_CERT);
  });
});

describe("assertPinnedCertificate", () => {
  test("accepts the pinned certificate", () => {
    expect(() => assertPinnedCertificate(CERT_DER, PIN_CERT)).not.toThrow();
  });

  test("vetoes a certificate whose key differs, with the fact and nothing else", () => {
    let thrown: unknown;
    try {
      assertPinnedCertificate(OTHER_DER, PIN_CERT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UpstreamTlsPinError);
    expect((thrown as Error).message).toBe("upstream TLS certificate pin mismatch");
    expect((thrown as Error).message).not.toContain("internal"); // no subject, no DNS names
  });

  test("vetoes an unparsable certificate and a missing certificate", () => {
    const truncated = CERT_DER.subarray(0, CERT_DER.length - 8);
    expect(() => assertPinnedCertificate(truncated, PIN_CERT)).toThrow(/could not be parsed/);
    expect(() => assertPinnedCertificate(undefined, PIN_CERT)).toThrow(/presented no certificate/);
  });
});

describe("isTlsFailure", () => {
  test("pin errors and TLS diagnostics are TLS failures; network failures are not", () => {
    expect(isTlsFailure(new UpstreamTlsPinError("upstream TLS certificate pin mismatch"))).toBe(true);
    expect(isTlsFailure(new Error("self signed certificate"))).toBe(true);
    expect(isTlsFailure(new Error("unable to verify the first certificate"))).toBe(true);
    expect(isTlsFailure(new Error("getaddrinfo ENOTFOUND llm.lan"))).toBe(false);
    expect(isTlsFailure(new Error("Connection refused"))).toBe(false);
    expect(isTlsFailure(new Error("The operation was aborted"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the bare-handshake probe
// ---------------------------------------------------------------------------

describe("probePinnedLeaf", () => {
  test("returns the leaf PEM and pin when the pin matches", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);

    const leaf: PinnedLeaf = await probePinnedLeaf(provider.baseUrl, 5_000, PIN_CERT);
    expect(leaf.pin).toBe(PIN_CERT);
    expect(leaf.pem).toContain("-----BEGIN CERTIFICATE-----");
    // the PEM is a usable certificate that carries exactly the probed pin
    expect(computeSpkiPin(new crypto.X509Certificate(leaf.pem))).toBe(PIN_CERT);
    // a bare handshake sends no HTTP request
    expect(provider.requests).toHaveLength(0);
  });

  test("rejects with the fact of a mismatch — no certificate details", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);

    const error = await rejectionOf(probePinnedLeaf(provider.baseUrl, 5_000, PIN_OTHER));
    expect(error).toBeInstanceOf(UpstreamTlsPinError);
    expect(error.message).toBe("upstream TLS certificate pin mismatch");
    expect(error.message).not.toContain("BEGIN");
    expect(error.message).not.toContain("localhost");
    expect(error.message).not.toContain(PIN_CERT);
  });

  test("rejects a plain-http endpoint and an invalid URL up front", async () => {
    const plainHttp = await rejectionOf(probePinnedLeaf("http://127.0.0.1:11434/v1", 5_000, PIN_CERT));
    expect(plainHttp.message).toContain("plain-http");

    const invalid = await rejectionOf(probePinnedLeaf("not a url", 5_000, PIN_CERT));
    expect(invalid.message).toContain("not a valid URL");
  });

  test("times out against an endpoint that never completes the handshake", async () => {
    const hanging = startHangingTcpEndpoint();
    tcpServers.push(hanging);

    const error = await rejectionOf(probePinnedLeaf(`https://127.0.0.1:${hanging.port}/v1`, 150, PIN_CERT));
    expect(error.message).toContain("timed out");
  });

  test("an already-aborted signal aborts the probe", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);

    const controller = new AbortController();
    controller.abort();
    const error = await rejectionOf(probePinnedLeaf(provider.baseUrl, 5_000, PIN_CERT, controller.signal));
    expect(error.message).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// the upstream on the pinned path (real TLS provider endpoints)
// ---------------------------------------------------------------------------

describe("OpenAICompatibleUpstream TLS pinning", () => {
  test("forward() relays through the pinned connection — exactly one upstream request", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const { upstream } = makeUpstream(provider.baseUrl, PIN_CERT);

    const response = await upstream.forward(proxyRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(provider.requests).toEqual(["/v1/chat/completions"]); // only the real request, no extra traffic
  });

  test("a wrong pin fails closed with 502 upstream_tls_error — the fact, not the certificate", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const { upstream } = makeUpstream(provider.baseUrl, PIN_OTHER);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await upstream.forward(proxyRequest());
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { type: string; code: string; message: string } };
      expect(body.error).toEqual({
        type: "api_error",
        code: "upstream_tls_error",
        message: 'upstream "pinned" TLS certificate does not match the configured tlsFingerprint pin',
      });
      expect(body.error.message).not.toContain("BEGIN");
    }
    expect(provider.requests).toHaveLength(0); // credentials never reach a mismatching upstream
  });

  test("an intermediate-signed certificate served WITHOUT its chain is pinned successfully", async () => {
    // the regression scenario: fetch cannot pin this upstream at all — a
    // non-self-signed leaf alone cannot anchor its own chain ("unable to
    // verify the first certificate") — while the per-connection pin check
    // needs no chain whatsoever: the key is the identity
    const provider = startTlsProvider(
      "pinned-test-chain-leaf.pem",
      undefined,
      "pinned-test-chain-leaf-key.pem",
    );
    tlsServers.push(provider);
    const leafPin = computeSpkiPin(derOf("pinned-test-chain-leaf.pem"));
    const { upstream } = makeUpstream(provider.baseUrl, leafPin);

    const response = await upstream.forward(proxyRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(provider.requests).toEqual(["/v1/chat/completions"]);
  });

  test("SSE streams through the pinned path chunk-by-chunk", async () => {
    const encoder = new TextEncoder();
    const provider = startTlsProvider("pinned-test-cert.pem", () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"]) {
            await Bun.sleep(10);
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    tlsServers.push(provider);
    const { upstream } = makeUpstream(provider.baseUrl, PIN_CERT);

    const response = await upstream.forward(proxyRequest(JSON.stringify({ model: "gpt-4o", stream: true })));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
  });

  test("an empty tlsFingerprint behaves like no pin: system CA verification fails on self-signed", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const { upstream } = makeUpstream(provider.baseUrl, "");

    const response = await upstream.forward(proxyRequest());
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_timeout");
  });

  test("a pin on a plain-http baseUrl is inert: the request relays without TLS pinning", async () => {
    const provider = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: "ok" } }] }),
    });
    tlsServers.push({ stop: () => provider.stop(true) });
    const { upstream } = makeUpstream(`http://localhost:${provider.port}/v1`, PIN_CERT);

    const response = await upstream.forward(proxyRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "ok" } }] });
  });

  test("listModels() with a wrong pin degrades with the pin mismatch in its reason", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const { upstream } = makeUpstream(provider.baseUrl, PIN_OTHER);

    await expect(upstream.listModels()).rejects.toThrow(/pin mismatch/);
    expect(provider.requests).toHaveLength(0);
  });

  test("connect() with a wrong pin rejects with the pin-mismatch fact — the registry warns and retains the outcome", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const { upstream, lines } = makeUpstream(provider.baseUrl, PIN_OTHER);

    await expect(upstream.connect()).rejects.toThrow(/pin mismatch/);
    // the warning belongs to the registry (it retains the probe outcome) —
    // the upstream itself stays silent on failure
    expect(lines.some((line) => line.level === "warn")).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  test("a renewal on the same key pair keeps the pinned path working — the pin binds the key", async () => {
    const renewed = startTlsProvider("pinned-test-cert.pem"); // serves the original cert
    tlsServers.push(renewed);
    const port = Number(new URL(renewed.baseUrl).port);
    const { upstream } = makeUpstream(renewed.baseUrl, PIN_CERT);

    const before = await upstream.forward(proxyRequest());
    expect(before.status).toBe(200);

    // the upstream renews its certificate — same key pair, new certificate.
    // No cached anchor exists to break: every request checks the pin of the
    // freshly served certificate, and the SPKI is unchanged
    renewed.stop();
    const rotated = startTlsProviderOnPort(port, "pinned-test-cert-rotated.pem");
    tlsServers.push(rotated);

    const after = await upstream.forward(proxyRequest());
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toEqual({ choices: [{ message: { content: "ok" } }] });
  });
});

/** Same as startTlsProvider, but pinned to an explicit port (rotation scenario). */
function startTlsProviderOnPort(
  port: number,
  certFile: string,
): { baseUrl: string; stop: () => void } {
  const keyFile = certFile.includes("other") ? "pinned-test-other-key.pem" : "pinned-test-key.pem";
  const server = Bun.serve({
    port,
    tls: {
      key: readFileSync(join(FIXTURES, keyFile), "utf8"),
      cert: readFileSync(join(FIXTURES, certFile), "utf8"),
    },
    fetch: () => Response.json({ choices: [{ message: { content: "ok" } }] }),
  });
  return { baseUrl: `https://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// the upstream through an outbound proxy (ADR-017) — pinned and unpinned
// ---------------------------------------------------------------------------

describe("OpenAICompatibleUpstream through an outbound proxy", () => {
  test("pinned + proxy + the right pin: the TLS socket comes from CONNECT and the answer is relayed", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const proxy = new MockHttpProxy().start();
    proxies.push(proxy);
    const { upstream } = makeUpstream(provider.baseUrl, PIN_CERT, proxy.url);

    const response = await upstream.forward(proxyRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "ok" } }] });

    // the tunnel was opened to the provider's authority, and the request rode it
    expect(proxy.connects).toEqual([{ target: new URL(provider.baseUrl).host }]);
    expect(provider.requests).toEqual(["/v1/chat/completions"]);
  });

  test("pinned + proxy: SSE streams through the tunnel chunk-by-chunk", async () => {
    const encoder = new TextEncoder();
    const provider = startTlsProvider("pinned-test-cert.pem", () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"]) {
            await Bun.sleep(10);
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    tlsServers.push(provider);
    const proxy = new MockHttpProxy().start();
    proxies.push(proxy);
    const { upstream } = makeUpstream(provider.baseUrl, PIN_CERT, proxy.url);

    const response = await upstream.forward(proxyRequest(JSON.stringify({ model: "gpt-4o", stream: true })));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
  });

  test("pinned + proxy + a wrong pin: 502 upstream_tls_error — the tunnel opened, but no request byte reached the provider", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const proxy = new MockHttpProxy().start();
    proxies.push(proxy);
    const { upstream, lines } = makeUpstream(provider.baseUrl, PIN_OTHER, proxy.url);

    const response = await upstream.forward(proxyRequest());
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      type: "api_error",
      code: "upstream_tls_error",
      message: 'upstream "pinned" TLS certificate does not match the configured tlsFingerprint pin',
    });
    // the CONNECT succeeded (the proxy dials the provider), the pin check
    // then vetoed the certificate before any byte of the request was written
    expect(proxy.connects).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(lines.some((line) => (line.obj as { code?: string } | undefined)?.code === "upstream_proxy_error")).toBe(
      false,
    );
  });

  test("a proxy that refuses CONNECT is a proxy failure on both paths — 502 upstream_proxy_error, never a pin decision", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);

    // fetch path: Bun raises ERR_PROXY_TUNNEL
    const refusingFetch = new MockHttpProxy({ mode: "refuse", refuseStatus: 403 }).start();
    proxies.push(refusingFetch);
    const unpinned = makeUpstream(provider.baseUrl, undefined, refusingFetch.url);
    const viaFetch = await unpinned.upstream.forward(proxyRequest());
    expect(viaFetch.status).toBe(502);
    expect(await errorOf(viaFetch)).toEqual({
      type: "api_error",
      code: "upstream_proxy_error",
      message: 'upstream "pinned" is unreachable through its configured proxy',
    });
    expect(refusingFetch.connects).toHaveLength(1);
    // the failure line carries the code and the proxy's scheme/host:port
    const failure = unpinned.lines.find((line) => line.msg === "upstream proxy failed — synthesizing 502");
    expect((failure?.obj as { code?: string }).code).toBe("upstream_proxy_error");
    expect((failure?.obj as { proxy?: unknown }).proxy).toEqual({
      scheme: "http",
      host: "127.0.0.1",
      port: refusingFetch.port,
    });

    // pinned path: our own CONNECT is refused
    const refusingTunnel = new MockHttpProxy({ mode: "refuse", refuseStatus: 403 }).start();
    proxies.push(refusingTunnel);
    const pinned = makeUpstream(provider.baseUrl, PIN_CERT, refusingTunnel.url);
    const viaPin = await pinned.upstream.forward(proxyRequest());
    expect(viaPin.status).toBe(502);
    expect((await errorOf(viaPin)).code).toBe("upstream_proxy_error");
    expect(refusingTunnel.connects).toHaveLength(1);

    expect(provider.requests).toHaveLength(0); // nothing ever reached the provider
  });

  test("a proxy that is down leaves the upstream unreachable — 504 upstream_timeout on both paths", async () => {
    const provider = startTlsProvider("pinned-test-cert.pem");
    tlsServers.push(provider);
    const downProxy = `http://127.0.0.1:${closedPort()}`;

    for (const pin of [undefined, PIN_CERT]) {
      const { upstream } = makeUpstream(provider.baseUrl, pin, downProxy);
      const response = await upstream.forward(proxyRequest());
      expect(response.status).toBe(504);
      expect((await errorOf(response)).code).toBe("upstream_timeout");
    }
    expect(provider.requests).toHaveLength(0);
  });

  test("a target dead behind a live tunnel is unreachable — 504 upstream_timeout, not a proxy error", async () => {
    const proxy = new MockHttpProxy().start(); // answers 200, then cannot dial the dead target
    proxies.push(proxy);
    const deadBaseUrl = `https://localhost:${closedPort()}/v1`;

    for (const pin of [undefined, PIN_CERT]) {
      const { upstream, lines } = makeUpstream(deadBaseUrl, pin, proxy.url);
      const response = await upstream.forward(proxyRequest());
      expect(response.status).toBe(504);
      expect((await errorOf(response)).code).toBe("upstream_timeout");
      expect(lines.some((line) => (line.obj as { code?: string } | undefined)?.code === "upstream_proxy_error")).toBe(
        false,
      );
    }
  });

  test("unpinned https through Bun's native CONNECT: reached through the proxy, TLS verified, SSE relayed", async () => {
    // The unpinned path keeps system-CA verification, and the fixture is
    // self-signed — so this leg runs in a child process that trusts the
    // fixture certificate through NODE_EXTRA_CA_CERTS (read at process
    // start only). Everything else is the real upstream against the real
    // proxy double; the child reports what it observed.
    const script = `
      import { readFileSync } from "node:fs";
      import { OpenAICompatibleUpstream } from ${JSON.stringify(join(import.meta.dir, "openai-compatible.ts"))};
      import { MockHttpProxy } from ${JSON.stringify(join(import.meta.dir, "testing", "mock-http-proxy.ts"))};
      const fixtures = ${JSON.stringify(FIXTURES)};
      const encoder = new TextEncoder();
      const requests = [];
      const provider = Bun.serve({
        port: 0,
        tls: {
          key: readFileSync(fixtures + "/pinned-test-key.pem", "utf8"),
          cert: readFileSync(fixtures + "/pinned-test-cert.pem", "utf8"),
        },
        fetch: (req) => {
          requests.push(new URL(req.url).pathname);
          const body = new ReadableStream({
            async start(controller) {
              for (const chunk of ['data: {"a":1}\\n\\n', "data: [DONE]\\n\\n"]) {
                await Bun.sleep(10);
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            },
          });
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      });
      const proxy = new MockHttpProxy().start();
      const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
      const upstream = new OpenAICompatibleUpstream(
        { type: "openai-compatible", id: "openai", baseUrl: "https://localhost:" + provider.port + "/v1",
          apiKey: "sk-upstream-secret", proxy: proxy.url },
        logger,
        {},
      );
      const response = await upstream.forward({
        path: "chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("{}")); controller.close(); } }),
      });
      const text = await response.text();
      console.log("RESULT " + JSON.stringify({
        status: response.status,
        contentType: response.headers.get("content-type"),
        text,
        connects: proxy.connects,
        requests,
      }));
      proxy.stop();
      provider.stop(true);
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(FIXTURES, "pinned-test-cert.pem") },
    });
    const stdout = child.stdout.toString();
    const line = stdout.split("\n").find((candidate) => candidate.startsWith("RESULT "));
    if (line === undefined) {
      throw new Error(`child reported no result (exit ${child.exitCode}):\n${stdout}\n${child.stderr.toString()}`);
    }
    const result = JSON.parse(line.slice("RESULT ".length)) as {
      status: number;
      contentType: string | null;
      text: string;
      connects: Array<{ target: string }>;
      requests: string[];
    };
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    expect(result.text).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(result.connects).toHaveLength(1); // fetch opened ONE CONNECT tunnel to the provider
    expect(result.connects[0]?.target).toMatch(/^localhost:\d+$/);
    expect(result.requests).toEqual(["/v1/chat/completions"]);
  }, 20_000);
});

afterAll(() => {
  // nothing long-lived: every server is stopped in afterEach
});
