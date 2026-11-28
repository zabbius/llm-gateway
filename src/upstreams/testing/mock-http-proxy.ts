/**
 * Test-only HTTP proxy double for the outbound-proxy transport tests
 * (`proxy.test.ts`; the upstream's proxy tests reuse it). Never imported by
 * runtime code. Bound to `127.0.0.1:0` — every test using it is offline.
 *
 * Speaks the two request shapes that reach an http proxy:
 *
 *   - `CONNECT host:port HTTP/1.1` — per `mode`: `"tunnel"` answers
 *     `200 Connection established` and relays bytes both ways to the
 *     authority; `"refuse"` answers a non-200 status (`refuseStatus`,
 *     default 403) and closes; `"hang"` reads the request and never answers
 *     (for timeout and abort tests). `tunnelPreamble` is written right
 *     after the 200 head in the same write — the coalesced-leftover case a
 *     tunnel opener must preserve.
 *   - absolute-form requests (`POST http://host:port/path HTTP/1.1`) —
 *     rewritten to origin-form with `Connection: close`, forwarded to the
 *     target, the target's bytes relayed back as-is. A `Content-Length`
 *     body is forwarded whole once it has arrived; a `Transfer-Encoding:
 *     chunked` body (what fetch sends for a streaming request body) is
 *     relayed chunk by chunk as it keeps arriving. Every forwarded request
 *     is recorded in `requests` (method, absolute URL, header lines, the
 *     body bytes seen so far); every CONNECT in `connects`.
 *
 * Ported from the opencode-poc reference double
 * (`opencode-proxy/src/testing/mock_http_proxy.ts`), extended with the
 * CONNECT modes `openConnectTunnel` needs.
 */
import type { Socket, TCPSocketListener } from "bun";

export type MockHttpProxyMode = "tunnel" | "refuse" | "hang";

export interface MockHttpProxyOptions {
  /** CONNECT behavior; default `"tunnel"`. */
  readonly mode?: MockHttpProxyMode;
  /** The status line code for `"refuse"`; default 403. */
  readonly refuseStatus?: number;
  /** Bytes written immediately after the `200` head, in the same write. */
  readonly tunnelPreamble?: string;
}

/** One absolute-form request the proxy forwarded. */
export interface ProxiedRequest {
  readonly method: string;
  /** The absolute URL of the request line. */
  readonly url: string;
  /** The header lines as received (request line excluded). */
  readonly headers: string[];
  /** The request body (Content-Length framed), as UTF-8 text. */
  readonly body: string;
  readonly at: number;
}

/** One CONNECT request the proxy saw. */
export interface ConnectRecord {
  /** The CONNECT authority (`host:port`). */
  readonly target: string;
}

type Phase = "head" | "tunnel";

interface ClientState {
  phase: Phase;
  buf: Buffer;
  /** Bytes that arrived after the CONNECT head before the target pair existed. */
  pending: Uint8Array[];
  upstream?: { write(data: Uint8Array): void; end(): void };
}

export class MockHttpProxy {
  readonly requests: ProxiedRequest[] = [];
  readonly connects: ConnectRecord[] = [];

  private server?: TCPSocketListener<undefined>;
  private readonly state = new WeakMap<object, ClientState>();
  private readonly mode: MockHttpProxyMode;
  private readonly refuseStatus: number;
  private readonly tunnelPreamble: string;

  constructor(options: MockHttpProxyOptions = {}) {
    this.mode = options.mode ?? "tunnel";
    this.refuseStatus = options.refuseStatus ?? 403;
    this.tunnelPreamble = options.tunnelPreamble ?? "";
  }

  start(): this {
    if (this.server) throw new Error("mock_http_proxy: start() called on an already running proxy");
    this.server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (socket, chunk) => this.onData(socket, Buffer.from(chunk)),
        error: (socket) => {
          try {
            socket.end();
          } catch {
            /* noop */
          }
        },
      },
    });
    return this;
  }

  get port(): number {
    if (!this.server) throw new Error("mock_http_proxy: port() before start()");
    return this.server.port;
  }

  /** The proxy URL exactly as a client hands it to `fetch({ proxy })` / `openConnectTunnel`. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  stop(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = undefined;
  }

  private onData(socket: Socket, chunk: Buffer): void {
    const st = this.state.get(socket as object) ?? {
      phase: "head" as const,
      buf: Buffer.alloc(0),
      pending: [],
    };
    this.state.set(socket as object, st);
    if (st.phase === "tunnel") {
      if (st.upstream) st.upstream.write(chunk);
      else st.pending.push(chunk);
      return;
    }
    st.buf = Buffer.concat([st.buf, chunk]);
    const idx = st.buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const headText = st.buf.subarray(0, idx).toString("latin1");
    const rest = st.buf.subarray(idx + 4);
    const lines = headText.split("\r\n");
    const [method = "", target = ""] = lines[0]?.split(" ") ?? [];
    const headers = lines.slice(1);

    if (method === "CONNECT") {
      this.connects.push({ target });
      if (this.mode === "hang") return;
      if (this.mode === "refuse") {
        socket.write(
          `HTTP/1.1 ${this.refuseStatus} Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        this.endAfterFlush(socket);
        return;
      }
      st.phase = "tunnel";
      socket.write(`HTTP/1.1 200 Connection established\r\n\r\n${this.tunnelPreamble}`);
      const authority = parseAuthority(target);
      if (!authority) {
        socket.end();
        return;
      }
      Bun.connect({
        hostname: authority.host,
        port: authority.port,
        socket: {
          data: (_s, data) => {
            socket.write(data);
          },
          close: () => this.endAfterFlush(socket),
          error: () => this.endAfterFlush(socket),
        },
      })
        .then((up) => {
          st.upstream = { write: (d: Uint8Array) => up.write(d), end: () => up.end() };
          for (const b of st.pending) up.write(b);
          st.pending.length = 0;
        })
        .catch(() => socket.end());
      if (rest.length > 0) {
        if (st.upstream) st.upstream.write(rest);
        else st.pending.push(rest);
      }
      return;
    }

    // absolute-form: a Content-Length body is forwarded once whole; a chunked
    // body (a streaming request) is relayed as it keeps arriving
    const chunked = headers.some((line) => /^transfer-encoding:\s*chunked/i.test(line));
    let contentLength = 0;
    for (const line of headers) {
      const m = /^content-length:\s*(\d+)/i.exec(line);
      if (m?.[1] !== undefined) contentLength = Number(m[1]);
    }
    if (!chunked && rest.length < contentLength) return;
    st.phase = "tunnel";
    this.forwardAbsolute(socket, st, method, target, headers, chunked ? rest : rest.subarray(0, contentLength));
  }

  /**
   * Rewrite to origin-form, drop the hop-by-hop headers, forward, and relay
   * the target back. The TCP pair is registered as the client's upstream so
   * bytes that arrive after the head (a chunked body) are written through in
   * order — buffered while the pair is still connecting.
   */
  private forwardAbsolute(
    socket: Socket,
    st: ClientState,
    method: string,
    absoluteUrl: string,
    headers: string[],
    body: Buffer,
  ): void {
    let target: URL;
    try {
      target = new URL(absoluteUrl);
    } catch {
      socket.end();
      return;
    }
    const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
    const requestLine = `${method} ${target.pathname || "/"}${target.search} HTTP/1.1`;
    const forwardedHeaders = headers.filter(
      (line) => !/^(connection|proxy-connection|keep-alive):/i.test(line),
    );
    const forwarded = Buffer.concat([
      Buffer.from([requestLine, ...forwardedHeaders, "Connection: close", "", ""].join("\r\n"), "latin1"),
      body,
    ]);
    this.requests.push({
      method,
      url: absoluteUrl,
      headers: [...headers],
      body: body.toString("utf8"),
      at: Date.now() % 100000,
    });
    Bun.connect({
      hostname: target.hostname,
      port,
      socket: {
        data: (_s, data) => {
          socket.write(data);
        },
        close: () => this.endAfterFlush(socket),
        error: () => this.endAfterFlush(socket),
      },
    })
      .then((up) => {
        st.upstream = { write: (d: Uint8Array) => up.write(d), end: () => up.end() };
        up.write(new Uint8Array(forwarded));
        up.flush();
        for (const b of st.pending) up.write(b);
        st.pending.length = 0;
      })
      .catch(() => socket.end()); // target unreachable — drop the client, never the test runner
  }

  /** An immediate end() can overtake the flush of the status line just written — let the bytes leave first. */
  private endAfterFlush(socket: Socket): void {
    const closer = setTimeout(() => {
      try {
        socket.end();
      } catch {
        /* already closed */
      }
    }, 25);
    closer.unref();
  }
}

/** `host:port` → `{ host, port }`; null for anything else (IPv6 literals are not needed by the tests). */
function parseAuthority(target: string): { host: string; port: number } | null {
  const i = target.lastIndexOf(":");
  if (i <= 0 || i === target.length - 1) return null;
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}
