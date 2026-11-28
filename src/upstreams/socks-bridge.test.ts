/**
 * SocksBridge against the local SOCKS5 and raw-target doubles
 * (`./testing/mock-socks.ts`) — fully offline (127.0.0.1, port 0).
 *
 * Covers the bridge's acceptance criteria: a CONNECT tunnel relays bytes
 * both ways; an absolute-URI request reaches the target as origin-form
 * without Proxy-* / Connection headers; every dial failure (a refused
 * CONNECT, a rejected no-auth, a hanging SOCKS server cut by the dial
 * timeout) answers 502 carrying the dial-failed marker; an oversized header
 * answers 431; a body arriving while the dial is in flight is forwarded on
 * the same tunnel (one SOCKS CONNECT); a closing target ends the client
 * side; stop() closes the listener and ends the live tunnels. Log lines go
 * through the injected pino child logger.
 */
import { describe, expect, test } from "bun:test";
import type pino from "pino";
import { MockRawTarget, MockSocks5Server, httpResponse, pairTo, startEchoTarget } from "./testing/mock-socks.ts";
import {
  BRIDGE_HEADER_LIMIT_BYTES,
  PROXY_DIAL_FAILED_HEADER,
  PROXY_DIAL_FAILED_MARKER,
  SocksBridge,
} from "./socks-bridge.ts";

/** Minimal capturing stand-in for the injected pino child logger. */
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

/** Poll until `cond` holds; the timeout fails the test. */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`waitFor: "${what}" did not happen`);
    await Bun.sleep(10);
  }
}

/** A bridge over the mock SOCKS server, logging through a fresh child logger. */
function startBridge(
  socksPort: number,
  dialTimeoutMs?: number,
): { bridge: SocksBridge; lines: ReturnType<typeof fakeLogger>["lines"] } {
  const { logger, lines } = fakeLogger({ component: "upstream:test" });
  const bridge = new SocksBridge(
    { host: "127.0.0.1", port: socksPort },
    "socks5://127.0.0.1:test",
    logger,
    dialTimeoutMs,
  ).start();
  return { bridge, lines };
}

/** A raw local client of the bridge collecting every chunk it receives. */
async function connectTo(
  port: number,
  onClosed: () => void = () => {},
): Promise<{ client: import("bun").Socket; got: Buffer[]; text: () => string }> {
  const got: Buffer[] = [];
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_s, d) => {
        got.push(Buffer.from(d));
      },
      error: () => {},
      close: () => onClosed(),
    },
  });
  return { client, got, text: () => Buffer.concat(got).toString("latin1") };
}

describe("SocksBridge", () => {
  test("absolute-URI GET reaches the target behind SOCKS as origin-form; Proxy-* and Connection headers dropped", async () => {
    let seen: Buffer | null = null;
    const target = new MockRawTarget((data, respond) => {
      seen = data;
      respond.write(httpResponse("hello-from-target"));
    }).start();
    const socks = new MockSocks5Server("accept", pairTo(target)).start();
    const { bridge, lines } = startBridge(socks.port);
    try {
      expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`http://${target.hostPort}/probe?x=1`, { proxy: bridge.url });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-from-target");
      expect(socks.connects).toEqual([{ host: "127.0.0.1", port: target.port }]);
      // the request line is origin-form; hop-by-hop and proxy headers are gone; close is forced
      const head = (seen as Buffer | null)!.toString("latin1").toLowerCase();
      expect(head.startsWith("get /probe?x=1 http/1.1\r\n")).toBe(true);
      expect(head).not.toContain("proxy-");
      expect(head).not.toContain("keep-alive");
      expect(head).toContain("connection: close");
      expect(head).toContain(`host: ${target.hostPort}`);
      // the injected child logger carries the lifecycle lines
      expect(lines.some((l) => l.level === "info" && l.msg === "socks bridge listening")).toBe(true);
      expect(lines.some((l) => l.level === "debug" && l.msg === "socks bridge tunnel open")).toBe(true);
    } finally {
      bridge.stop();
      socks.stop();
      target.stop();
    }
  });

  test("CONNECT tunnel relays bytes both ways; the SOCKS CONNECT names the target", async () => {
    const echo = startEchoTarget();
    const socks = new MockSocks5Server("accept", pairTo(echo)).start();
    const { bridge } = startBridge(socks.port);
    try {
      const { client, text } = await connectTo(bridge.port);
      client.write(`CONNECT ${echo.hostPort} HTTP/1.1\r\nHost: ${echo.hostPort}\r\n\r\n`);
      await waitFor("200 Connection established", () => text().includes("200 Connection established"));
      client.write("ping-123");
      await waitFor("the echo came back through the tunnel", () => text().includes("ping-123"));
      expect(socks.connects).toEqual([{ host: "127.0.0.1", port: echo.port }]);
      client.end();
    } finally {
      bridge.stop();
      socks.stop();
      echo.stop();
    }
  });

  test("SOCKS refuses CONNECT (reply 5) → 502 carrying the dial-failed marker, warn line logged", async () => {
    const target = startEchoTarget();
    const socks = new MockSocks5Server("refuse_connect", pairTo(target)).start();
    const { bridge, lines } = startBridge(socks.port);
    try {
      const res = await fetch(`http://${target.hostPort}/x`, { proxy: bridge.url });
      expect(res.status).toBe(502);
      expect(res.headers.get(PROXY_DIAL_FAILED_HEADER)).toBe(PROXY_DIAL_FAILED_MARKER);
      expect(await res.text()).toContain("socks dial failed");
      expect(socks.connects).toEqual([{ host: "127.0.0.1", port: target.port }]);
      const warn = lines.find((l) => l.level === "warn" && l.msg === "socks bridge dial failed");
      expect(warn).toBeDefined();
      expect(String((warn?.obj as { target?: string }).target)).toContain("/x");
    } finally {
      bridge.stop();
      socks.stop();
      target.stop();
    }
  });

  test("SOCKS rejects no-auth (05 FF) → 502 carrying the dial-failed marker", async () => {
    const target = startEchoTarget();
    const socks = new MockSocks5Server("reject_noauth", pairTo(target)).start();
    const { bridge } = startBridge(socks.port);
    try {
      const res = await fetch(`http://${target.hostPort}/x`, { proxy: bridge.url });
      expect(res.status).toBe(502);
      expect(res.headers.get(PROXY_DIAL_FAILED_HEADER)).toBe(PROXY_DIAL_FAILED_MARKER);
      expect(await res.text()).toContain("no-auth");
    } finally {
      bridge.stop();
      socks.stop();
      target.stop();
    }
  });

  test("a hanging SOCKS server is cut by the dial timeout → 502 carrying the marker", async () => {
    const target = startEchoTarget();
    const socks = new MockSocks5Server("hang", pairTo(target)).start();
    const { bridge, lines } = startBridge(socks.port, 150);
    try {
      const t0 = performance.now();
      const res = await fetch(`http://${target.hostPort}/x`, { proxy: bridge.url });
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(502);
      expect(res.headers.get(PROXY_DIAL_FAILED_HEADER)).toBe(PROXY_DIAL_FAILED_MARKER);
      expect(await res.text()).toContain("timed out");
      expect(elapsed).toBeLessThan(3000);
      const warn = lines.find((l) => l.level === "warn" && l.msg === "socks bridge dial failed");
      expect(String((warn?.obj as { reason?: string }).reason)).toContain("timed out");
    } finally {
      bridge.stop();
      socks.stop();
      target.stop();
    }
  });

  test("a body arriving while the dial is in flight is forwarded on the same tunnel — one SOCKS CONNECT", async () => {
    const seen: Buffer[] = [];
    const target = new MockRawTarget((data, respond) => {
      seen.push(data);
      if (Buffer.concat(seen).toString("latin1").endsWith("0123456789")) respond.write(httpResponse("ok"));
    }).start();
    const socks = new MockSocks5Server("accept", pairTo(target)).start();
    const { bridge } = startBridge(socks.port);
    try {
      const { client, text } = await connectTo(bridge.port);
      client.write(
        `POST http://${target.hostPort}/upload HTTP/1.1\r\nHost: ${target.hostPort}\r\nContent-Length: 10\r\n\r\n`,
      );
      client.write("0123456789");
      await waitFor("the target's answer", () => text().includes("\r\n\r\nok"));
      const request = Buffer.concat(seen).toString("latin1");
      expect(request.startsWith("POST /upload HTTP/1.1\r\n")).toBe(true);
      expect(request.endsWith("\r\n\r\n0123456789")).toBe(true);
      expect(socks.connects).toHaveLength(1);
      client.end();
    } finally {
      bridge.stop();
      socks.stop();
      target.stop();
    }
  });

  test("an oversized header block → 431, nothing dialed — endless or complete", async () => {
    const socks = new MockSocks5Server("accept").start();
    const { bridge } = startBridge(socks.port);
    try {
      // endless: more than the limit without a terminator
      const flood = await connectTo(bridge.port);
      flood.client.write(`GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-Pad: ${"a".repeat(BRIDGE_HEADER_LIMIT_BYTES)}`);
      await waitFor("431 on an endless header", () => flood.text().startsWith("HTTP/1.1 431"));
      flood.client.end();
      // complete, but over the limit
      const complete = await connectTo(bridge.port);
      complete.client.write(
        `GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-Pad: ${"a".repeat(BRIDGE_HEADER_LIMIT_BYTES)}\r\n\r\n`,
      );
      await waitFor("431 on a complete oversized header", () => complete.text().startsWith("HTTP/1.1 431"));
      expect(socks.connects).toHaveLength(0);
      complete.client.end();
    } finally {
      bridge.stop();
      socks.stop();
    }
  });

  test("a malformed request line → 400, nothing dialed", async () => {
    const socks = new MockSocks5Server("accept").start();
    const { bridge } = startBridge(socks.port);
    try {
      const { client, text } = await connectTo(bridge.port);
      client.write("NOT A REQUEST\r\n\r\n");
      await waitFor("400", () => text().startsWith("HTTP/1.1 400"));
      expect(socks.connects).toHaveLength(0);
      client.end();
    } finally {
      bridge.stop();
      socks.stop();
    }
  });

  test("a target that closes ends the client side of the tunnel", async () => {
    const closing = new MockRawTarget((_data, respond) => {
      respond.write(Buffer.from("bye"));
      respond.end();
    }).start();
    const socks = new MockSocks5Server("accept", pairTo(closing)).start();
    const { bridge } = startBridge(socks.port);
    try {
      let closed = false;
      const { client, text } = await connectTo(bridge.port, () => {
        closed = true;
      });
      client.write(`CONNECT ${closing.hostPort} HTTP/1.1\r\n\r\n`);
      await waitFor("200 after CONNECT", () => text().includes("200 Connection established"));
      client.write("x");
      await waitFor("the target's bytes", () => text().includes("bye"));
      await waitFor("the client side closed", () => closed);
      client.end();
    } finally {
      bridge.stop();
      socks.stop();
      closing.stop();
    }
  });

  test("stop() closes the listener and ends the live tunnels; url/port throw before start and start() is single-shot", async () => {
    const echo = startEchoTarget();
    const socks = new MockSocks5Server("accept", pairTo(echo)).start();
    const { logger, lines } = fakeLogger();
    const fresh = new SocksBridge({ host: "127.0.0.1", port: socks.port }, "socks5://127.0.0.1:test", logger);
    expect(() => fresh.url).toThrow("before start()");
    expect(() => fresh.port).toThrow("before start()");
    const bridge = fresh.start();
    try {
      expect(() => bridge.start()).toThrow("already running");
      const port = bridge.port;
      expect(bridge.url).toBe(`http://127.0.0.1:${port}`);
      let closed = false;
      const { client, text } = await connectTo(port, () => {
        closed = true;
      });
      client.write(`CONNECT ${echo.hostPort} HTTP/1.1\r\n\r\n`);
      await waitFor("200 after CONNECT", () => text().includes("200 Connection established"));
      bridge.stop();
      await waitFor("the live tunnel ended", () => closed);
      await expect(
        Bun.connect({ hostname: "127.0.0.1", port, socket: { data: () => {} } }),
      ).rejects.toThrow();
      expect(() => bridge.port).toThrow("before start()");
      expect(lines.some((l) => l.level === "info" && l.msg === "socks bridge stopped")).toBe(true);
    } finally {
      bridge.stop(); // idempotent
      socks.stop();
      echo.stop();
    }
  });
});
