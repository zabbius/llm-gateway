/**
 * The in-process HTTP→SOCKS5 bridge behind a `socks5://` outbound proxy.
 *
 * Why a bridge: Bun's `fetch` speaks one proxy protocol — a plain HTTP
 * proxy, `fetch(url, { proxy: "http://host:port" })` — and rejects
 * `socks5://` outright (UnsupportedProxyProtocol). The bridge is the
 * adapter: a loopback-only HTTP proxy (`Bun.listen` on `127.0.0.1:0`, one
 * per upstream — started by `resolveProxyTransport` in `proxy.ts`) whose
 * every dial is carried through the configured SOCKS5 server (RFC 1928,
 * no-auth only; RFC 1929 user/pass is not supported). TLS inside a CONNECT
 * tunnel is end-to-end between the client and the origin — the bridge only
 * pumps bytes, so the pinned-TLS path (`tls-pinning.ts`) is unaffected.
 *
 * Request handling:
 *   - `CONNECT host:port` → dial through SOCKS5, answer `200 Connection
 *     established`, then relay bytes both ways until either side closes.
 *   - an absolute-URI request (`GET http://host:port/path HTTP/1.1`) →
 *     rewrite the request line to origin-form, drop the hop-by-hop and
 *     `Proxy-*` headers, force `Connection: close`, dial through SOCKS5,
 *     forward, and relay the origin's bytes back untouched.
 *   - a header block above 64 KiB → `431`; a malformed request line or
 *     authority, or a non-http absolute URI → `400`; a failed or timed-out
 *     SOCKS dial → `502` carrying the marker header
 *     `x-llm-gateway-proxy: dial-failed` — the upstream maps that marker
 *     in `openai-compatible.ts` (only the absolute-URI path can surface it
 *     to a `fetch` caller: a CONNECT client sees a refused tunnel instead).
 *
 * Bytes that arrive while a dial is in flight (a request body streamed
 * behind its header) are buffered and written on the tunnel once it opens —
 * the request is never parsed twice.
 *
 * Ported from the opencode-poc reference bridge
 * (`opencode-proxy/src/proxy/socks.ts`): same wire logic, plus an injected
 * pino logger with English lines, a dial timeout that cuts a hanging SOCKS
 * server, the dial-failed marker header, and a forceful `stop()`.
 */
import type pino from "pino";
import type { Socket, TCPSocketListener } from "bun";

/** A SOCKS5 endpoint as parsed from the proxy URL by `parseProxyUrl` (`proxy.ts`). */
export interface SocksEndpoint {
  host: string;
  port: number;
}

/** One SOCKS5 dial (TCP connect + greeting + CONNECT reply) — a server that stalls is cut after this. */
export const SOCKS_DIAL_TIMEOUT_MS = 10_000;
/** A local client's header block above this is refused with `431`. */
export const BRIDGE_HEADER_LIMIT_BYTES = 64 * 1024;
/** Marker header on every bridge-authored `502` — names the failure as a proxy dial failure. */
export const PROXY_DIAL_FAILED_HEADER = "x-llm-gateway-proxy";
/** The marker header's value on a dial failure. */
export const PROXY_DIAL_FAILED_MARKER = "dial-failed";

/**
 * The pause between the last write on a bridge socket and its end: an
 * immediate `end()` can overtake the flush of the write (the peer then
 * sees a reset or loses the bytes).
 */
const CLOSE_DELAY_MS = 25;

type ByteSink = (data: Uint8Array) => void;

interface DialHandlers {
  /** Tunnel bytes from the origin. */
  onData: ByteSink;
  /** The origin closed — the tunnel is over. */
  onEnd: () => void;
}

/** A bridge-authored HTTP/1.1 response with a plain-text body, closed after delivery. */
function httpResponse(status: string, body: string, extraHeaders: readonly string[] = []): Uint8Array {
  const head = [
    `HTTP/1.1 ${status}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...extraHeaders,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return new Uint8Array(Buffer.from(head + body, "latin1"));
}

/** `host:port` (a CONNECT authority) → `{ host, port }`; null for anything else. IPv6 literals are not supported. */
function parseAuthority(target: string): SocksEndpoint | null {
  const i = target.lastIndexOf(":");
  if (i <= 0 || i === target.length - 1) return null;
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Dial `host:port` through the SOCKS5 server (no-auth). Resolves with the
 * established socket once the CONNECT reply is `00`; tunnel bytes that
 * arrive in the same chunk as the reply are delivered through `onData`
 * before the promise settles. Rejects on a refused handshake, a socket
 * error, a close during the handshake, or the dial timeout — in every case
 * the socket is ended.
 */
function socksDial(
  socks: SocksEndpoint,
  host: string,
  port: number,
  handlers: DialHandlers,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let stage: "greeting" | "connect" | "tunnel" = "greeting";
    let rbuf: Buffer = Buffer.alloc(0);
    let settled = false; // resolved or rejected — never touched again
    let established = false; // the tunnel exists — a close from here on is the tunnel's end
    let sock: Socket | undefined;
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(why));
      try {
        sock?.end();
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(() => fail(`the SOCKS5 dial timed out after ${timeoutMs} ms`), timeoutMs);
    timer.unref();

    Bun.connect({
      hostname: socks.host,
      port: socks.port,
      socket: {
        open(s) {
          sock = s;
          s.write(new Uint8Array([0x05, 0x01, 0x00])); // greeting: version 5, one method — no-auth
        },
        data(s, data) {
          sock = s;
          if (stage === "tunnel") {
            handlers.onData(data);
            return;
          }
          rbuf = Buffer.concat([rbuf, Buffer.from(data)]);
          if (stage === "greeting") {
            if (rbuf.length < 2) return;
            if (rbuf[0] !== 0x05 || rbuf[1] !== 0x00) {
              fail("the SOCKS5 server refused the no-auth method");
              return;
            }
            stage = "connect";
            const hostBytes = Buffer.from(host, "latin1");
            if (hostBytes.length === 0 || hostBytes.length > 255) {
              fail("the SOCKS5 target host name is empty or longer than 255 bytes");
              return;
            }
            // CONNECT: VER 05, CMD 01, RSV 00, ATYP 03 (domain name), length, name, port
            s.write(
              new Uint8Array(
                Buffer.concat([
                  Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
                  hostBytes,
                  Buffer.from([(port >> 8) & 0xff, port & 0xff]),
                ]),
              ),
            );
            rbuf = Buffer.alloc(0);
            return;
          }
          // stage === "connect": the reply is at least 4 bytes; its total length depends on ATYP
          if (rbuf.length < 5) return;
          const atyp = rbuf[3] ?? 0;
          const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 5 + (rbuf[4] ?? 0) + 2;
          if (rbuf.length < need) return;
          if (rbuf[0] !== 0x05 || rbuf[1] !== 0x00) {
            fail(`the SOCKS5 server refused CONNECT (reply code ${rbuf[1]})`);
            return;
          }
          stage = "tunnel";
          established = true;
          settled = true;
          clearTimeout(timer);
          resolve(s);
          const leftover = rbuf.subarray(need);
          if (leftover.length > 0) handlers.onData(new Uint8Array(leftover)); // origin bytes that rode along with the reply
        },
        error(_s, err) {
          fail(`the SOCKS5 connection failed: ${err.message}`);
        },
        close() {
          // after establishment = the tunnel's EOF; before = a handshake cut short
          if (established) handlers.onEnd();
          else fail("the SOCKS5 server closed the connection during the handshake");
        },
      },
    }).catch((e: unknown) => fail(`the SOCKS5 connect failed: ${(e as Error).message}`));
  });
}

interface ClientState {
  /** `header`: collecting the request head; `dialing`: head parsed, tunnel pending; `tunnel`: relaying; `refused`: answered, draining. */
  phase: "header" | "dialing" | "tunnel" | "refused";
  /** `header`: the head so far; `dialing`: body bytes to forward on the tunnel. */
  buf: Buffer;
  upstream?: Socket;
}

/**
 * One loopback HTTP proxy whose dials go through a SOCKS5 server. The
 * bridge listens on `127.0.0.1` only — it is never reachable from the
 * network — and its port is ephemeral: the owning upstream resolves
 * `fetch({ proxy })` to `url` and stops the bridge with `stop()`.
 */
export class SocksBridge {
  private server?: TCPSocketListener<undefined>;
  /** Live origin sockets (through SOCKS) — `stop()` ends them. */
  private readonly upstreams = new Set<Socket>();
  /** Live local client sockets — `stop()` ends them. */
  private readonly clients = new Set<Socket>();
  private readonly clientState = new WeakMap<object, ClientState>();

  constructor(
    private readonly socks: SocksEndpoint,
    private readonly socksUrl: string,
    private readonly logger: pino.Logger,
    private readonly dialTimeoutMs: number = SOCKS_DIAL_TIMEOUT_MS,
  ) {}

  start(): this {
    if (this.server) throw new Error("socks bridge: start() called on an already running bridge");
    this.server = Bun.listen({
      hostname: "127.0.0.1", // loopback only — never exposed
      port: 0,
      socket: {
        open: (client) => {
          this.clients.add(client);
        },
        data: (client, data) => this.onClientData(client, data),
        error: (client, err) => {
          this.logger.debug({ err: err.message }, "socks bridge client error");
          try {
            client.end();
          } catch {
            /* already closed */
          }
        },
        close: (client) => {
          this.clients.delete(client);
        },
      },
    });
    this.logger.info(
      { proxy: this.socksUrl, listen: `127.0.0.1:${this.server.port}` },
      "socks bridge listening",
    );
    return this;
  }

  /** The local URL for `fetch({ proxy })` — always `http://127.0.0.1:<port>`. */
  get url(): string {
    if (!this.server) throw new Error("socks bridge: url() before start()");
    return `http://127.0.0.1:${this.server.port}`;
  }

  get port(): number {
    if (!this.server) throw new Error("socks bridge: port() before start()");
    return this.server.port;
  }

  /** Forceful: the listener, every local client, and every live tunnel end now. */
  stop(): void {
    const server = this.server;
    if (!server) return;
    server.stop(true);
    this.server = undefined;
    for (const upstream of this.upstreams) {
      try {
        upstream.end();
      } catch {
        /* already closed */
      }
    }
    this.upstreams.clear();
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* already closed */
      }
    }
    this.clients.clear();
    this.logger.info({ proxy: this.socksUrl }, "socks bridge stopped");
  }

  private onClientData(client: Socket, data: Uint8Array): void {
    let st = this.clientState.get(client as object);
    if (!st) {
      st = { phase: "header", buf: Buffer.alloc(0) };
      this.clientState.set(client as object, st);
    }
    if (st.phase === "refused") return;
    if (st.phase === "tunnel") {
      try {
        st.upstream?.write(data);
      } catch {
        /* upstream gone — its close ends the client */
      }
      return;
    }
    st.buf = Buffer.concat([st.buf, Buffer.from(data)]);
    if (st.phase === "dialing") return; // body bytes — forwarded once the tunnel opens

    const idx = st.buf.indexOf("\r\n\r\n");
    if (idx < 0) {
      if (st.buf.length > BRIDGE_HEADER_LIMIT_BYTES) {
        this.respond(client, st, "431 Request Header Fields Too Large", "socks bridge: request header too large");
      }
      return;
    }
    if (idx > BRIDGE_HEADER_LIMIT_BYTES) {
      // complete, but over the limit — refused exactly like an endless head
      this.respond(client, st, "431 Request Header Fields Too Large", "socks bridge: request header too large");
      return;
    }
    const head = st.buf.subarray(0, idx).toString("latin1");
    st.buf = st.buf.subarray(idx + 4); // what follows the head: body bytes, forwarded on the tunnel
    st.phase = "dialing";
    const lines = head.split("\r\n");
    const requestLine = lines[0] ?? "";
    const firstSpace = requestLine.indexOf(" ");
    const versionAt = requestLine.lastIndexOf(" HTTP/");
    const method = firstSpace > 0 ? requestLine.slice(0, firstSpace) : "";
    const target = firstSpace > 0 && versionAt > firstSpace ? requestLine.slice(firstSpace + 1, versionAt) : "";
    if (!method || !target) {
      this.respond(client, st, "400 Bad Request", "socks bridge: malformed request line");
      return;
    }

    if (method === "CONNECT") {
      const authority = parseAuthority(target);
      if (!authority) {
        this.respond(client, st, "400 Bad Request", "socks bridge: malformed CONNECT authority");
        return;
      }
      this.openTunnel(client, st, authority, `CONNECT ${target}`);
      return;
    }

    // absolute-URI: rewrite the request line to origin-form and forward the rest as-is
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      this.respond(client, st, "400 Bad Request", "socks bridge: the request target is not a URL");
      return;
    }
    if (url.protocol !== "http:" || !url.hostname) {
      this.respond(
        client,
        st,
        "400 Bad Request",
        "socks bridge: expected an absolute http:// URI (https goes through CONNECT)",
      );
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const path = `${url.pathname || "/"}${url.search}`;
    const forwarded = [`${method} ${path} HTTP/1.1`];
    for (const line of lines.slice(1)) {
      const lower = line.toLowerCase();
      if (lower.startsWith("proxy-") || lower.startsWith("connection:") || lower.startsWith("keep-alive:")) {
        continue;
      }
      forwarded.push(line);
    }
    forwarded.push("Connection: close");
    const request = Buffer.from(`${forwarded.join("\r\n")}\r\n\r\n`, "latin1");
    this.openTunnel(client, st, { host: url.hostname, port }, `${method} ${url.hostname}:${port}${path}`, request);
  }

  /**
   * Dial `target` through SOCKS and turn the client into a relay. For
   * CONNECT (`request` undefined) the establishment head is written first;
   * for an absolute-URI request `request` is the rewritten head. Body bytes
   * buffered during the dial follow in both cases.
   */
  private openTunnel(
    client: Socket,
    st: ClientState,
    target: SocksEndpoint,
    label: string,
    request?: Buffer,
  ): void {
    const started = performance.now();
    let upstream: Socket | undefined;
    socksDial(
      this.socks,
      target.host,
      target.port,
      {
        onData: (d) => {
          try {
            client.write(d);
          } catch {
            /* client gone — its close ends the upstream */
          }
        },
        onEnd: () => {
          if (upstream) this.upstreams.delete(upstream);
          // the last relayed write may still be in flight — let it flush before the FIN
          const closer = setTimeout(() => {
            try {
              client.end();
            } catch {
              /* already closed */
            }
          }, CLOSE_DELAY_MS);
          closer.unref();
        },
      },
      this.dialTimeoutMs,
    )
      .then((up) => {
        upstream = up;
        this.upstreams.add(up);
        st.upstream = up;
        const pending = st.buf;
        st.buf = Buffer.alloc(0);
        if (request === undefined) {
          client.write(new Uint8Array(Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n")));
        } else {
          up.write(request);
        }
        if (pending.length > 0) up.write(pending);
        st.phase = "tunnel";
        this.logger.debug(
          { target: label, ms: Math.round(performance.now() - started) },
          "socks bridge tunnel open",
        );
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn({ target: label, reason }, "socks bridge dial failed");
        this.respond(
          client,
          st,
          "502 Bad Gateway",
          `socks dial failed: ${reason}`,
          [`${PROXY_DIAL_FAILED_HEADER}: ${PROXY_DIAL_FAILED_MARKER}`],
        );
      });
  }

  /** Answer a bridge-authored status line and close; the client's further bytes are drained. */
  private respond(
    client: Socket,
    st: ClientState,
    status: string,
    body: string,
    extraHeaders: readonly string[] = [],
  ): void {
    st.phase = "refused";
    try {
      client.write(httpResponse(status, body, extraHeaders));
    } catch {
      return;
    }
    const closer = setTimeout(() => {
      try {
        client.end();
      } catch {
        /* already closed */
      }
    }, CLOSE_DELAY_MS);
    closer.unref();
  }
}
