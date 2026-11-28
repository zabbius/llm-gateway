/**
 * Test-only SOCKS5 doubles for the outbound-proxy transport tests
 * (`socks-bridge.test.ts`, `proxy.test.ts`). Never imported by runtime code.
 *
 * Two components, both bound to `127.0.0.1:0` — every test using them is
 * offline:
 *
 *   - `MockSocks5Server` — the server side of a SOCKS5 handshake
 *     (`Bun.listen`, port 0). Modes: `"accept"` (a working no-auth server),
 *     `"refuse_connect"` (CONNECT answered with reply code 5 — the target
 *     is not reachable through the proxy), `"reject_noauth"` (the greeting is
 *     answered `05 FF` — the no-auth method is not taken), `"hang"` (the
 *     greeting is read and never answered — a server that stalls forever).
 *     After an accepted CONNECT the tunnel bytes go to the duplex the test's
 *     `onConnect` callback returns; `pairTo(target)` is the ready-made
 *     wiring to a `MockRawTarget`.
 *   - `MockRawTarget` — a bare TCP server ("the origin behind the SOCKS
 *     server"): every chunk goes to the test handler, which answers through
 *     the supplied duplex. `startEchoTarget()` is the echo variant.
 *
 * Ported from the opencode-poc reference doubles
 * (`opencode-proxy/src/testing/mock_socks.ts`). One deliberate fix: the
 * reference re-entered its data handler with the unconsumed tail of a
 * chunk, which concatenated that tail onto itself and — when the greeting
 * and the CONNECT request arrived in one chunk — replayed the request bytes
 * into the tunnel as payload. Here the tail is consumed in place.
 */
import type { Socket, TCPSocketListener } from "bun";

/** A valid HTTP/1.1 response with a body — for raw targets whose clients are real HTTP clients (fetch, the bridge). */
export function httpResponse(body: string, status = "200 OK"): Buffer {
  return Buffer.from(
    `HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export type Duplex = { write(data: Uint8Array): void; end(): void };

/** One accepted CONNECT: the target the client asked the SOCKS server for. */
export interface SocksConnectRecord {
  host: string;
  port: number;
}

export type MockSocksMode = "accept" | "refuse_connect" | "reject_noauth" | "hang";

interface SocksClientState {
  phase: "greeting" | "request" | "tunnel" | "hang";
  buf: Buffer;
  pair?: Duplex;
}

/**
 * Where an accepted CONNECT is terminated. `null` leaves the tunnel silent.
 * `ctl.end()` closes the bridge side of the pair (the target's EOF must
 * reach the client).
 */
export type SocksConnectHandler = (
  host: string,
  port: number,
  ctl: { write: (data: Uint8Array) => void; end: () => void },
) => Duplex | null;

export class MockSocks5Server {
  /** Every CONNECT request (target host:port), in arrival order — refused ones included. */
  readonly connects: SocksConnectRecord[] = [];

  private server?: TCPSocketListener<undefined>;
  private readonly state = new WeakMap<object, SocksClientState>();

  constructor(
    private readonly mode: MockSocksMode,
    private readonly onConnect: SocksConnectHandler = () => null,
  ) {}

  start(): this {
    if (this.server) throw new Error("mock_socks: start() called on an already running server");
    this.server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (client, data) => this.handleData(client, Buffer.from(data)),
        error: (client) => {
          try {
            client.end();
          } catch {
            /* noop */
          }
        },
      },
    });
    return this;
  }

  get port(): number {
    if (!this.server) throw new Error("mock_socks: port() before start()");
    return this.server.port;
  }

  stop(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = undefined;
  }

  private handleData(client: Socket, chunk: Buffer): void {
    const st = this.state.get(client as object) ?? { phase: "greeting" as const, buf: Buffer.alloc(0) };
    this.state.set(client as object, st);
    if (st.phase === "tunnel") {
      st.pair?.write(chunk);
      return;
    }
    if (st.phase === "hang") return;
    st.buf = Buffer.concat([st.buf, chunk]);
    this.process(client, st);
  }

  /**
   * Consumes `st.buf` phase by phase. Whatever is left after a phase
   * transition is re-processed in the new phase — without re-appending it
   * to itself.
   */
  private process(client: Socket, st: SocksClientState): void {
    if (st.phase === "greeting") {
      if (st.buf.length < 3) return;
      const greeting = st.buf.subarray(0, 3);
      st.buf = st.buf.subarray(3);
      // the bridge offers exactly one method (05 01 00 = no-auth); anything else is dropped
      if (greeting[0] !== 0x05 || greeting[1] !== 0x01 || greeting[2] !== 0x00) {
        client.end();
        return;
      }
      if (this.mode === "hang") {
        st.phase = "hang";
        return;
      }
      if (this.mode === "reject_noauth") {
        client.write(new Uint8Array([0x05, 0xff]));
        client.end();
        return;
      }
      client.write(new Uint8Array([0x05, 0x00]));
      st.phase = "request";
      this.process(client, st);
      return;
    }

    if (st.phase === "request") {
      if (st.buf.length < 5) return;
      const ver = st.buf[0];
      const cmd = st.buf[1];
      const atyp = st.buf[3];
      let host = "";
      let port = 0;
      let consumed = 0;
      if (atyp === 0x03) {
        const len = st.buf[4] ?? 0;
        if (st.buf.length < 5 + len + 2) return;
        host = st.buf.subarray(5, 5 + len).toString("latin1");
        port = st.buf.readUInt16BE(5 + len);
        consumed = 7 + len;
      } else if (atyp === 0x01) {
        if (st.buf.length < 10) return;
        host = Array.from(st.buf.subarray(4, 8)).join(".");
        port = st.buf.readUInt16BE(8);
        consumed = 10;
      } else {
        client.end(); // IPv6 is not needed by the tests
        return;
      }
      st.buf = st.buf.subarray(consumed);
      const ok = ver === 0x05 && cmd === 0x01 && this.mode === "accept";
      this.connects.push({ host, port });
      // reply: VER 05, REP (00 = ok, 05 = refused), RSV 0, ATYP 01, BND.ADDR 0.0.0.0, BND.PORT 0
      client.write(new Uint8Array([0x05, ok ? 0x00 : 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      if (!ok) {
        client.end();
        return;
      }
      st.phase = "tunnel";
      st.pair =
        this.onConnect(host, port, {
          write: (d: Uint8Array) => client.write(d),
          end: () => client.end(),
        }) ?? undefined;
      if (st.buf.length > 0) st.pair?.write(st.buf); // payload that rode along with the request
      st.buf = Buffer.alloc(0);
      return;
    }
  }
}

/** A bare TCP target "behind the SOCKS server": each chunk → handler; the answer goes through the handler's duplex. */
export class MockRawTarget {
  private server?: TCPSocketListener<undefined>;

  constructor(private readonly handler: (data: Buffer, respond: Duplex) => void) {}

  start(): this {
    if (this.server) throw new Error("mock_socks: start() called on an already running target");
    this.server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (client, data) => {
          this.handler(Buffer.from(data), {
            write: (d: Uint8Array) => client.write(d),
            // an immediate end() can overtake the flush of the handler's last write — let it leave first
            end: () => {
              const closer = setTimeout(() => client.end(), 25);
              closer.unref();
            },
          });
        },
        error: (client) => {
          try {
            client.end();
          } catch {
            /* noop */
          }
        },
      },
    });
    return this;
  }

  /** `host:port` of the target for CONNECT / an absolute URI (127.0.0.1 — offline). */
  get hostPort(): string {
    if (!this.server) throw new Error("mock_socks: hostPort() before start()");
    return `127.0.0.1:${this.server.port}`;
  }

  get port(): number {
    if (!this.server) throw new Error("mock_socks: port() before start()");
    return this.server.port;
  }

  stop(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = undefined;
  }
}

/** An echo target: everything that arrives is written back to the sender. */
export function startEchoTarget(): MockRawTarget {
  return new MockRawTarget((data, respond) => respond.write(data)).start();
}

/**
 * `onConnect` callback for `MockSocks5Server`: the tunnel is wired to
 * `target`. The duplex is returned at once; bytes arriving before the TCP
 * pair exists are buffered (a local connection — a microsecond window).
 * The target's EOF is translated into `ctl.end()` — the close reaches the
 * bridge.
 */
export function pairTo(
  target: MockRawTarget,
): (
  host: string,
  port: number,
  ctl: { write: (d: Uint8Array) => void; end: () => void },
) => Duplex | null {
  return (_host, _port, ctl) => {
    const pending: Uint8Array[] = [];
    let pair: Duplex | null = null;
    Bun.connect({
      hostname: "127.0.0.1",
      port: target.port,
      socket: {
        data: (_s, d) => ctl.write(d),
        error: () => {
          /* a broken target — ctl.end() arrives through close */
        },
        close: () => ctl.end(),
      },
    })
      .then((s) => {
        pair = {
          write: (d: Uint8Array) => s.write(d),
          end: () => s.end(),
        };
        for (const b of pending) pair.write(b);
        pending.length = 0;
      })
      .catch(() => {
        /* the test sees the break as a timeout */
      });
    return {
      write: (d: Uint8Array) => {
        if (pair) pair.write(d);
        else pending.push(d);
      },
      end: () => pair?.end(),
    };
  };
}
