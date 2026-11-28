/**
 * The outbound-proxy transport primitives (`proxy.ts`) against the local
 * doubles (`./testing/mock-http-proxy.ts`, `./testing/mock-socks.ts`) —
 * fully offline (127.0.0.1, port 0).
 *
 * parseProxyUrl — the config grammar re-parsed defensively (schemes, the
 * explicit-port rule, and every rejection as an `UpstreamProxyError` that
 * never echoes the value; cross-checked against the schema's own
 * `isValidProxyUrl`); resolveProxyTransport — `http://` is itself,
 * `socks5://` is a started per-upstream bridge; openConnectTunnel — 200 is
 * a tunnel (coalesced origin bytes preserved), non-200 is an
 * `UpstreamProxyError` carrying the status, an unreachable proxy and a
 * timeout are plain errors, and an abort is honored.
 */
import { describe, expect, test } from "bun:test";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pino from "pino";
import { MockHttpProxy } from "./testing/mock-http-proxy.ts";
import { MockRawTarget, MockSocks5Server, startEchoTarget } from "./testing/mock-socks.ts";
import { isValidProxyUrl } from "../config/schema.ts";
import {
  PROXY_DIAL_TIMEOUT_MS,
  UpstreamProxyError,
  openConnectTunnel,
  parseProxyUrl,
  resolveProxyTransport,
} from "./proxy.ts";

/** Minimal capturing stand-in for the injected pino child logger. */
function fakeLogger(): pino.Logger {
  const emit =
    () =>
    (_obj: unknown, _msg?: string): void => {};
  const build = (): pino.Logger =>
    ({
      trace: emit(),
      debug: emit(),
      info: emit(),
      warn: emit(),
      error: emit(),
      fatal: emit(),
      child: () => build(),
    }) as unknown as pino.Logger;
  return build();
}

/** Poll until `cond` holds; the timeout fails the test. */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`waitFor: "${what}" did not happen`);
    await Bun.sleep(10);
  }
}

/** Collect everything a handed-off tunnel socket delivers. */
function reader(socket: NetSocket): { text: () => string; closed: () => boolean } {
  const chunks: Buffer[] = [];
  let isClosed = false;
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    isClosed = true;
  });
  return { text: () => Buffer.concat(chunks).toString("latin1"), closed: () => isClosed };
}

/** A port nothing listens on: bind ephemeral, read the port, close. */
function closedPort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Await a promise expected to reject; return the rejection reason. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("parseProxyUrl", () => {
  test("http: and socks5: with an explicit port; an explicit :80 is kept even though URL.port elides it; IPv6 brackets are unwrapped", () => {
    expect(parseProxyUrl("http://127.0.0.1:8080")).toEqual({ protocol: "http:", host: "127.0.0.1", port: 8080 });
    expect(parseProxyUrl("http://proxy.internal:80")).toEqual({ protocol: "http:", host: "proxy.internal", port: 80 });
    expect(parseProxyUrl("http://proxy.internal:8080/")).toEqual({ protocol: "http:", host: "proxy.internal", port: 8080 });
    expect(parseProxyUrl("socks5://192.168.23.3:9051")).toEqual({
      protocol: "socks5:",
      host: "192.168.23.3",
      port: 9051,
    });
    expect(parseProxyUrl("socks5://[::1]:1080")).toEqual({ protocol: "socks5:", host: "::1", port: 1080 });
  });

  test("a missing port is a typo, not a default — rejected by name", () => {
    for (const raw of ["http://proxy.internal", "socks5://example.internal", "http://proxy.internal/"]) {
      const error = (() => {
        try {
          parseProxyUrl(raw);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(UpstreamProxyError);
      expect(String((error as Error).message)).toContain("stated explicitly");
    }
  });

  test("rejects other schemes, credentials, paths, bad ports, and garbage — as UpstreamProxyError, never echoing the value", () => {
    const bad = [
      "https://h:443",
      "socks5h://h:1080",
      "ftp://h:21",
      "http://user:secret@h:8080",
      "socks5://user:secret@h:1080",
      "http://h:8080/path",
      "http://h:8080?x=1",
      "http://h:8080#frag",
      "http://h:0",
      "http://h:99999",
      "http://h:abc",
      "socks5://:1080",
      "::::",
      "",
    ];
    for (const raw of bad) {
      const error = (() => {
        try {
          parseProxyUrl(raw);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(UpstreamProxyError);
      expect(String((error as Error).message)).not.toContain("secret");
    }
    expect(String(((): unknown => {
      try {
        parseProxyUrl("https://h:443");
      } catch (e) {
        return e;
      }
    })())).toContain("https:");
    expect(String(((): unknown => {
      try {
        parseProxyUrl("http://h:99999");
      } catch (e) {
        return e;
      }
    })())).toContain("1 and 65535");
  });

  test("agrees with the config grammar (src/config/schema.ts isValidProxyUrl) on every shape — the two cannot drift", () => {
    const corpus = [
      "http://127.0.0.1:8080",
      "http://proxy.internal:80",
      "http://proxy.internal:8080/",
      "http://H:8080",
      "http://h:0080",
      "http://[::1]:8080",
      "socks5://192.168.23.3:9051",
      "socks5://example.internal:1080",
      "http://proxy.internal",
      "socks5://example.internal",
      "https://h:443",
      "socks5h://h:1080",
      "ftp://h:21",
      "http://user:secret@h:8080",
      "socks5://user:secret@h:1080",
      "http://h:8080/path",
      "http://h:8080?x=1",
      "http://h:8080#frag",
      "http://h:0",
      "http://h:99999",
      "http://h:abc",
      "http://h:",
      "socks5://:1080",
      "::::",
      "",
      "http://h:8080 extra",
    ];
    for (const raw of corpus) {
      let accepted = true;
      try {
        parseProxyUrl(raw);
      } catch {
        accepted = false;
      }
      expect({ url: raw, accepted }).toEqual({ url: raw, accepted: isValidProxyUrl(raw) });
    }
  });
});

describe("resolveProxyTransport", () => {
  test("the dial budget is the fixed 10 s constant", () => {
    expect(PROXY_DIAL_TIMEOUT_MS).toBe(10_000);
  });

  test("http:// resolves to itself — no bridge, nothing listening", () => {
    const transport = resolveProxyTransport("http://127.0.0.1:8080", { logger: fakeLogger() });
    expect(transport).toEqual({
      kind: "http",
      proxyUrl: "http://127.0.0.1:8080",
      fetchUrl: "http://127.0.0.1:8080",
    });
  });

  test("socks5:// resolves to a started per-upstream bridge on 127.0.0.1 — nothing dials the SOCKS server yet", () => {
    const socks = new MockSocks5Server("accept").start();
    const transport = resolveProxyTransport(`socks5://127.0.0.1:${socks.port}`, { logger: fakeLogger() });
    try {
      expect(transport.kind).toBe("socks5");
      if (transport.kind !== "socks5") throw new Error("unreachable");
      expect(transport.proxyUrl).toBe(`socks5://127.0.0.1:${socks.port}`);
      expect(transport.fetchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(transport.fetchUrl).toBe(transport.bridge.url);
      expect(socks.connects).toHaveLength(0);
    } finally {
      if (transport.kind === "socks5") transport.bridge.stop();
      socks.stop();
    }
  });

  test("an invalid proxy URL throws UpstreamProxyError before anything listens", () => {
    const error = (() => {
      try {
        resolveProxyTransport("https://h:443", { logger: fakeLogger() });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UpstreamProxyError);
  });
});

describe("openConnectTunnel", () => {
  test("200 → the socket is a tunnel to the target; a coalesced leftover is preserved; bytes relay both ways", async () => {
    const echo = startEchoTarget();
    const proxy = new MockHttpProxy({ mode: "tunnel", tunnelPreamble: "HELLO" }).start();
    try {
      const socket = await openConnectTunnel(echo.hostPort, proxy.url, 5000);
      // the consumer attaches its reader a tick after the resolve — the
      // unshifted preamble must still be delivered, not dropped
      await Bun.sleep(30);
      const r = reader(socket);
      await waitFor("the coalesced preamble", () => r.text().includes("HELLO"));
      socket.write("ping-through-tunnel");
      await waitFor("the echo through the tunnel", () => r.text().includes("ping-through-tunnel"));
      expect(proxy.connects).toEqual([{ target: echo.hostPort }]);
      socket.end();
    } finally {
      proxy.stop();
      echo.stop();
    }
  });

  test("the handed-off socket carries a TLS handshake — tls.connect({ socket }) resumes it (the pinned-TLS consumer)", async () => {
    // a TLS origin behind the proxy tunnel, serving the synthetic fixture pair
    const peers = new Set<tls.TLSSocket>();
    const server = tls.createServer(
      {
        key: readFileSync(join(import.meta.dir, "fixtures", "pinned-test-key.pem"), "utf8"),
        cert: readFileSync(join(import.meta.dir, "fixtures", "pinned-test-cert.pem"), "utf8"),
      },
      (peer) => {
        peers.add(peer);
        peer.on("data", (d: Buffer) => {
          peer.write(d);
        });
        peer.on("error", () => {});
        peer.on("close", () => peers.delete(peer));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const proxy = new MockHttpProxy({ mode: "tunnel" }).start();
    let socket: NetSocket | undefined;
    let secure: tls.TLSSocket | undefined;
    try {
      socket = await openConnectTunnel(`127.0.0.1:${port}`, proxy.url, 5000);
      secure = tls.connect({ socket, rejectUnauthorized: false, servername: "localhost" });
      const got: Buffer[] = [];
      secure.on("data", (d: Buffer) => got.push(d));
      secure.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        secure!.once("secureConnect", () => resolve());
        secure!.once("error", (e) => reject(e));
        const guard = setTimeout(() => reject(new Error("TLS handshake through the tunnel timed out")), 3000);
        guard.unref();
      });
      expect(secure.getProtocol()).toMatch(/^TLSv1/);
      secure.write("hello-tls");
      await waitFor("the TLS echo through the tunnel", () => Buffer.concat(got).toString() === "hello-tls");
      expect(proxy.connects).toEqual([{ target: `127.0.0.1:${port}` }]);
    } finally {
      secure?.destroy();
      socket?.destroy();
      proxy.stop();
      for (const peer of peers) peer.destroy();
      server.close();
    }
  });

  test("non-200 → UpstreamProxyError carrying the status; the proxy saw the CONNECT", async () => {
    const proxy = new MockHttpProxy({ mode: "refuse", refuseStatus: 403 }).start();
    try {
      const error = await failure(openConnectTunnel("127.0.0.1:1", proxy.url, 5000));
      expect(error).toBeInstanceOf(UpstreamProxyError);
      expect((error as UpstreamProxyError).status).toBe(403);
      expect(String((error as Error).message)).toContain("403");
      expect(proxy.connects).toEqual([{ target: "127.0.0.1:1" }]);
    } finally {
      proxy.stop();
    }
  });

  test("an unreachable proxy → a plain error, not UpstreamProxyError", async () => {
    const error = await failure(openConnectTunnel("127.0.0.1:1", `http://127.0.0.1:${closedPort()}`, 5000));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpstreamProxyError);
  });

  test("a proxy that never answers → a plain timeout error within the budget", async () => {
    const proxy = new MockHttpProxy({ mode: "hang" }).start();
    try {
      const t0 = performance.now();
      const error = await failure(openConnectTunnel("127.0.0.1:1", proxy.url, 150));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UpstreamProxyError);
      expect(String((error as Error).message)).toContain("timed out");
      expect(performance.now() - t0).toBeLessThan(3000);
    } finally {
      proxy.stop();
    }
  });

  test("an abort mid-dial is honored → a plain error naming the abort", async () => {
    const proxy = new MockHttpProxy({ mode: "hang" }).start();
    try {
      const controller = new AbortController();
      const pending = openConnectTunnel("127.0.0.1:1", proxy.url, 10_000, controller.signal);
      setTimeout(() => controller.abort(), 50);
      const error = await failure(pending);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UpstreamProxyError);
      expect(String((error as Error).message)).toContain("aborted");
    } finally {
      proxy.stop();
    }
  });

  test("an already-aborted signal rejects before anything dials", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(openConnectTunnel("127.0.0.1:1", "http://127.0.0.1:9", 1000, controller.signal));
    expect(String((error as Error).message)).toContain("aborted before it started");
  });

  test("a socks5:// proxy URL or a malformed target is an UpstreamProxyError before any dial", async () => {
    const notHttp = await failure(openConnectTunnel("127.0.0.1:1", "socks5://127.0.0.1:1080"));
    expect(notHttp).toBeInstanceOf(UpstreamProxyError);
    const badTarget = await failure(openConnectTunnel("not-an-authority", "http://127.0.0.1:9"));
    expect(badTarget).toBeInstanceOf(UpstreamProxyError);
  });

  test("a handed-off tunnel ends when the origin closes", async () => {
    const proxy = new MockHttpProxy({ mode: "tunnel" }).start();
    // an origin that answers once and closes
    const origin = new MockRawTarget((_data, respond) => {
      respond.write(Buffer.from("bye"));
      respond.end();
    }).start();
    try {
      const socket = await openConnectTunnel(origin.hostPort, proxy.url, 5000);
      const r = reader(socket);
      socket.write("x"); // the origin answers once and closes
      await waitFor("the origin's bytes", () => r.text().includes("bye"));
      await waitFor("the tunnel closed", () => r.closed());
    } finally {
      proxy.stop();
      origin.stop();
    }
  });
});
