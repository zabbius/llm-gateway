/**
 * TLS SPKI pinning (ADR-005): the pin primitive and the bare-handshake
 * probe, plus OpenAICompatibleAdapter behavior against a REAL local TLS
 * upstream serving self-signed fixtures — the exact deployment scenario
 * pinning exists for (mocking fetch would bypass the TLS layer entirely).
 *
 * The fixtures in `fixtures/` are throwaway public test material: two
 * certificates on ONE key pair (a renewal) and one on a different key.
 * Their pins are asserted against openssl-computed constants below.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pino from "pino";
import { OpenAICompatibleAdapter } from "./openai-compatible.ts";
import {
  computeSpkiPin,
  isTlsFailure,
  pinnedTlsOptions,
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

/** One local TLS upstream serving the given fixture cert/key pair. */
function startTlsUpstream(certFile: string, handler?: (req: Request) => Response | Promise<Response>): {
  baseUrl: string;
  requests: string[];
  stop: () => void;
} {
  const requests: string[] = [];
  const keyFile = certFile.includes("other") ? "pinned-test-other-key.pem" : "pinned-test-key.pem";
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

function makeAdapter(
  baseUrl: string,
  tlsFingerprint: string | undefined,
): { adapter: OpenAICompatibleAdapter; lines: Array<{ level: string; obj: unknown; msg: string }> } {
  const { logger, lines } = fakeLogger({ component: "adapter:pinned" });
  const adapter = new OpenAICompatibleAdapter(
    {
      type: "openai-compatible",
      id: "pinned",
      baseUrl,
      apiKey: "sk-upstream-secret",
      ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
    },
    logger,
    { pinProbeMs: 2_000 },
  );
  return { adapter, lines };
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
  OpenAICompatibleAdapter["forward"]
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

/** Await a promise expected to reject; return the rejection reason as an Error. */
async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the probe to reject, but it resolved");
}

afterEach(() => {
  for (const server of tlsServers) server.stop();
  tlsServers.length = 0;
  for (const server of tcpServers) server.stop();
  tcpServers.length = 0;
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

describe("pinnedTlsOptions", () => {
  const { checkServerIdentity } = pinnedTlsOptions("PEM-PLACEHOLDER", PIN_CERT);

  test("accepts the pinned certificate regardless of the hostname (pin-only identity)", () => {
    expect(checkServerIdentity("attacker.example", { raw: CERT_DER })).toBeUndefined();
  });

  test("vetoes a certificate whose key differs, with the fact and nothing else", () => {
    const error = checkServerIdentity("localhost", { raw: OTHER_DER });
    expect(error).toBeInstanceOf(UpstreamTlsPinError);
    expect(error?.message).toBe("upstream TLS certificate pin mismatch");
    expect(error?.message).not.toContain("internal"); // no subject, no DNS names
  });

  test("vetoes an unparsable certificate and a missing certificate", () => {
    const truncated = checkServerIdentity("localhost", { raw: CERT_DER.subarray(0, CERT_DER.length - 8) });
    expect(truncated?.message).toContain("could not be parsed");
    expect(checkServerIdentity("localhost", {})?.message).toContain("presented no certificate");
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
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);

    const leaf: PinnedLeaf = await probePinnedLeaf(upstream.baseUrl, 5_000, PIN_CERT);
    expect(leaf.pin).toBe(PIN_CERT);
    expect(leaf.pem).toContain("-----BEGIN CERTIFICATE-----");
    // the PEM is a usable certificate that carries exactly the probed pin
    expect(computeSpkiPin(new crypto.X509Certificate(leaf.pem))).toBe(PIN_CERT);
    // a bare handshake sends no HTTP request
    expect(upstream.requests).toHaveLength(0);
  });

  test("rejects with the fact of a mismatch — no certificate details", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);

    const error = await rejectionOf(probePinnedLeaf(upstream.baseUrl, 5_000, PIN_OTHER));
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
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);

    const controller = new AbortController();
    controller.abort();
    const error = await rejectionOf(probePinnedLeaf(upstream.baseUrl, 5_000, PIN_CERT, controller.signal));
    expect(error.message).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// the adapter on the pinned path (real TLS upstreams)
// ---------------------------------------------------------------------------

describe("OpenAICompatibleAdapter TLS pinning", () => {
  test("forward() relays through the pinned connection; the probe sends no HTTP request", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);
    const { adapter } = makeAdapter(upstream.baseUrl, PIN_CERT);

    const response = await adapter.forward(proxyRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(upstream.requests).toEqual(["/v1/chat/completions"]); // one HTTP request, no probe traffic
  });

  test("a wrong pin fails closed with 502 upstream_tls_error — the fact, not the certificate", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);
    const { adapter } = makeAdapter(upstream.baseUrl, PIN_OTHER);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await adapter.forward(proxyRequest());
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { type: string; code: string; message: string } };
      expect(body.error).toEqual({
        type: "api_error",
        code: "upstream_tls_error",
        message: 'upstream "pinned" TLS certificate does not match the configured tlsFingerprint pin',
      });
      expect(body.error.message).not.toContain("BEGIN");
    }
    expect(upstream.requests).toHaveLength(0); // credentials never reach a mismatching upstream
  });

  test("one upstream attempt per request: a TLS failure is never retried inside the failing request", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);
    const { adapter } = makeAdapter(upstream.baseUrl, PIN_CERT);

    // prime the leaf cache
    const first = await adapter.forward(proxyRequest());
    expect(first.status).toBe(200);
    expect(upstream.requests).toEqual(["/v1/chat/completions"]);

    // the next request's fetch fails at the TLS level: the adapter must
    // surface the failure instead of re-probing and retrying within the
    // same request (one attempt per client request — no retries)
    const realFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      attempts += 1;
      throw new Error("certificate verify failed");
    }) as unknown as typeof fetch;
    let failing: Response;
    try {
      failing = await adapter.forward(proxyRequest());
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(failing.status).toBe(502);
    const body = (await failing.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_tls_error");
    expect(attempts).toBe(1);

    // the failed request invalidated the leaf cache: the NEXT request
    // re-probes against the real upstream and relays again
    const reArmed = await adapter.forward(proxyRequest());
    expect(reArmed.status).toBe(200);
    expect(upstream.requests).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
  });

  test("SSE streams through the pinned path chunk-by-chunk", async () => {
    const encoder = new TextEncoder();
    const upstream = startTlsUpstream("pinned-test-cert.pem", () => {
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
    tlsServers.push(upstream);
    const { adapter } = makeAdapter(upstream.baseUrl, PIN_CERT);

    const response = await adapter.forward(proxyRequest(JSON.stringify({ model: "gpt-4o", stream: true })));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
  });

  test("an empty tlsFingerprint behaves like no pin: system CA verification fails on self-signed", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);
    const { adapter } = makeAdapter(upstream.baseUrl, "");

    const response = await adapter.forward(proxyRequest());
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_timeout");
  });

  test("listModels() with a wrong pin degrades with the pin mismatch in its reason", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);
    const { adapter } = makeAdapter(upstream.baseUrl, PIN_OTHER);

    await expect(adapter.listModels()).rejects.toThrow(/pin mismatch/);
    expect(upstream.requests).toHaveLength(0);
  });

  test("connect() with a wrong pin degrades to a warning and never rejects", async () => {
    const upstream = startTlsUpstream("pinned-test-cert.pem");
    tlsServers.push(upstream);
    const { adapter, lines } = makeAdapter(upstream.baseUrl, PIN_OTHER);

    await expect(adapter.connect()).resolves.toBeUndefined();
    const warning = lines.find((line) => line.level === "warn");
    expect(JSON.stringify(warning)).toContain("pin mismatch");
    expect(upstream.requests).toHaveLength(0);
  });

  test("a renewal on the same key pair: chain mismatch once, then the re-probe re-arms the pin", async () => {
    const renewed = startTlsUpstream("pinned-test-cert.pem"); // serves the original cert
    tlsServers.push(renewed);
    const port = Number(new URL(renewed.baseUrl).port);
    const { adapter } = makeAdapter(renewed.baseUrl, PIN_CERT);

    // first request primes the leaf cache with the original certificate
    const first = await adapter.forward(proxyRequest());
    expect(first.status).toBe(200);

    // the upstream renews its certificate — same key pair, new certificate
    renewed.stop();
    const rotated = startTlsUpstreamOnPort(port, "pinned-test-cert-rotated.pem");
    tlsServers.push(rotated);

    // the served chain no longer terminates at the cached leaf: fail closed…
    const mismatch = await adapter.forward(proxyRequest());
    expect(mismatch.status).toBe(502);
    const body = (await mismatch.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_tls_error");

    // …the cache is invalidated, the next probe sees the renewed certificate
    // whose SPKI still matches the pin, and the pinned path re-arms itself
    const reArmed = await adapter.forward(proxyRequest());
    expect(reArmed.status).toBe(200);
  });
});

/** Same as startTlsUpstream, but pinned to an explicit port (rotation scenario). */
function startTlsUpstreamOnPort(
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

afterAll(() => {
  // nothing long-lived: every server is stopped in afterEach
});
