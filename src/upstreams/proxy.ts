/**
 * Transport primitives behind a per-upstream outbound proxy (the `proxy`
 * field of an upstream config; the transport contract is documented in
 * specs/domains/upstreams/openai-compatible.md, outbound-proxy section).
 *
 * Two proxy schemes, two transports:
 *
 *   - `http://host:port` — Bun's `fetch` speaks it natively
 *     (`fetch(url, { proxy })`); `resolveProxyTransport` hands the URL back.
 *   - `socks5://host:port` — `fetch` rejects it (UnsupportedProxyProtocol),
 *     so the gateway runs a loopback HTTP→SOCKS5 bridge per upstream
 *     (`socks-bridge.ts`) and points `fetch` at the bridge's URL instead.
 *
 * `openConnectTunnel` is the pinned-TLS leg through an http proxy: the
 * `tls-pinning.ts` path bypasses `fetch` (its TLS layer cannot pin), so it
 * needs a raw tunnel — a `node:net` socket to the proxy, one
 * `CONNECT host:port HTTP/1.1`, a bounded read of the status line and the
 * headers, and only a `200` hands the socket back as the tunnel.
 *
 * `parseProxyUrl` re-validates the proxy URL against the config grammar
 * (`src/config/schema.ts` checked it at startup; this is the defensive
 * second parse before anything dials). Its errors name the fact, never the
 * value: a proxy URL must not carry credentials, and a mistyped one might.
 */
import net from "node:net";
import type pino from "pino";
import { SocksBridge } from "./socks-bridge.ts";

/** The CONNECT exchange with an http proxy (TCP connect + status line). */
export const PROXY_DIAL_TIMEOUT_MS = 10_000;
/** A proxy's CONNECT response head above this is refused. */
const CONNECT_RESPONSE_LIMIT_BYTES = 64 * 1024;

export type ProxyProtocol = "http:" | "socks5:";

export interface ParsedProxyUrl {
  readonly protocol: ProxyProtocol;
  /** Without IPv6 brackets — the form `node:net` / `Bun.connect` dial. */
  readonly host: string;
  readonly port: number;
}

/**
 * A proxy failure the upstream maps to its own error class: an unusable
 * proxy URL, or a proxy that answered CONNECT with anything but 200.
 * Unreachability, timeouts, and aborts stay plain errors.
 */
export class UpstreamProxyError extends Error {
  /** The proxy's HTTP status when it refused a CONNECT; undefined otherwise. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamProxyError";
    this.status = status;
  }
}

/**
 * `http://host:port` | `socks5://host:port` → `{ protocol, host, port }` —
 * the config grammar of `src/config/schema.ts` (`isValidProxyUrl`,
 * ADR-017) re-parsed defensively; `proxy.test.ts` cross-checks the two on a
 * corpus so they cannot drift. Anything else is an `UpstreamProxyError`:
 * another scheme, credentials (the proxy URL is a secret-free channel —
 * `Proxy-Authorization` is not supported), a path, query or fragment, an
 * empty host, a port outside 1..65535, a missing port (a missing port is a
 * typo, not a default), or not a URL. Errors name the fact, never the value.
 */
export function parseProxyUrl(raw: string): ParsedProxyUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // the URL parser reports a port above 65535 as "not a URL" — name the real problem
    const written = explicitPort(raw);
    if (written !== undefined && (Number(written) < 1 || Number(written) > 65535)) {
      throw new UpstreamProxyError("proxy URL: the port must be between 1 and 65535");
    }
    throw new UpstreamProxyError("proxy URL: not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "socks5:") {
    throw new UpstreamProxyError(`proxy URL: unsupported scheme "${url.protocol}" — expected http: or socks5:`);
  }
  const protocol: ProxyProtocol = url.protocol;
  if (url.hostname === "") throw new UpstreamProxyError("proxy URL: no host");
  if (url.username !== "" || url.password !== "") {
    throw new UpstreamProxyError("proxy URL: credentials in the URL are not supported");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new UpstreamProxyError("proxy URL: a path, query, or fragment is not allowed");
  }
  // The port must be written, and it is read from the authority rather than
  // `URL.port`: the parser elides a port equal to the scheme default
  // (`http://proxy:80` → `port === ""`), and the grammar accepts that `:80`.
  const written = explicitPort(raw);
  if (written === undefined) throw new UpstreamProxyError("proxy URL: the port must be stated explicitly");
  const port = Number(written);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UpstreamProxyError("proxy URL: the port must be between 1 and 65535");
  }
  return { protocol, host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/**
 * The port written in a proxy URL's authority, or `undefined` when none was
 * — the same read as the config grammar's private helper: the authority
 * after `://` (up to a path, query or fragment), minus any userinfo, must
 * end in `:<digits>`.
 */
function explicitPort(value: string): string | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) return undefined;
  const authority = value.slice(schemeEnd + 3).split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return /^(.*):([0-9]+)$/.exec(hostPort)?.[2];
}

/** What `fetch` must be handed as `proxy` for one configured proxy URL. */
export type ProxyTransport = HttpProxyTransport | Socks5ProxyTransport;

export interface HttpProxyTransport {
  readonly kind: "http";
  /** The configured proxy URL, as validated. */
  readonly proxyUrl: string;
  /** What `fetch({ proxy })` is handed — the proxy URL itself. */
  readonly fetchUrl: string;
}

export interface Socks5ProxyTransport {
  readonly kind: "socks5";
  /** The configured proxy URL, as validated. */
  readonly proxyUrl: string;
  /** What `fetch({ proxy })` is handed — the loopback bridge's URL. */
  readonly fetchUrl: string;
  /** The per-upstream bridge behind `fetchUrl`; `stop()` it with its upstream. */
  readonly bridge: SocksBridge;
}

export interface ProxyTransportOptions {
  /** The owning upstream's child logger — the bridge logs through it. */
  readonly logger: pino.Logger;
  /** The bridge's SOCKS dial budget; default `SOCKS_DIAL_TIMEOUT_MS`. */
  readonly dialTimeoutMs?: number;
}

/**
 * Resolve one configured proxy URL into what `fetch({ proxy })` accepts:
 * an `http://` proxy is used as-is; a `socks5://` proxy starts its
 * per-upstream loopback bridge (`Bun.listen` on `127.0.0.1:0`) and resolves
 * to the bridge's URL. The bridge dials lazily — nothing contacts the SOCKS
 * server until the first request — and lives until `bridge.stop()`.
 */
export function resolveProxyTransport(proxyUrl: string, options: ProxyTransportOptions): ProxyTransport {
  const parsed = parseProxyUrl(proxyUrl);
  if (parsed.protocol === "http:") {
    return { kind: "http", proxyUrl, fetchUrl: proxyUrl };
  }
  const bridge = new SocksBridge(parsed, proxyUrl, options.logger, options.dialTimeoutMs).start();
  return { kind: "socks5", proxyUrl, fetchUrl: bridge.url, bridge };
}

/** `host:port` (a CONNECT authority) → `{ host, port }`; null for anything else. */
function parseAuthority(target: string): { host: string; port: number } | null {
  const i = target.lastIndexOf(":");
  if (i <= 0 || i === target.length - 1) return null;
  const host = target.slice(0, i).replace(/^\[|\]$/g, ""); // unwrap IPv6 literals
  const port = Number(target.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** `HTTP/1.x <code> [reason]` → the status code; undefined for anything else. */
function parseStatusLine(head: string): number | undefined {
  const line = head.split("\r\n")[0] ?? "";
  const code = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+.*)?$/.exec(line)?.[1];
  return code === undefined ? undefined : Number(code);
}

/**
 * Open a tunnel through an http proxy for `target` (`host:port`): connect
 * to the proxy, send `CONNECT target HTTP/1.1`, and read — bounded by
 * `CONNECT_RESPONSE_LIMIT_BYTES` — the status line and headers. Only a
 * `200` resolves, with the connected socket as the tunnel (origin bytes
 * that rode along with the response are pushed back onto it). The socket
 * never enters flowing mode, so it hands off like a fresh `net.connect`
 * socket: the consumer's first `on("data")`, `pipe`, or
 * `tls.connect({ socket })` resumes it and receives the pushed-back bytes.
 * Anything else the proxy answers throws `UpstreamProxyError` (carrying the
 * status when there is one); an unreachable proxy, a timeout, or an abort
 * throws a plain error. Every failure destroys the socket.
 */
export async function openConnectTunnel(
  target: string,
  proxyUrl: string,
  timeoutMs: number = PROXY_DIAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<net.Socket> {
  if (signal?.aborted) throw new Error("the proxy CONNECT was aborted before it started");
  const proxy = parseProxyUrl(proxyUrl);
  if (proxy.protocol !== "http:") {
    throw new UpstreamProxyError("a CONNECT tunnel needs an http: proxy URL");
  }
  if (!parseAuthority(target)) {
    throw new UpstreamProxyError(`CONNECT target "${target}" is not a host:port authority`);
  }

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let buf: Buffer = Buffer.alloc(0);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`the proxy CONNECT timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    const onAbort = (): void => fail(new Error("the proxy CONNECT was aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });

    // Parse in 'readable' mode, never in flowing mode: a socket that never
    // flowed hands off like a fresh `net.connect` socket — the pushed-back
    // leftover waits in its buffer and whatever the consumer attaches
    // (`on("data")`, `pipe`, `tls.connect({ socket })`) resumes it. A
    // flowing socket, by contrast, loses bytes unshifted while no 'data'
    // listener exists (verified on Bun 1.4.5).
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) {
          if (buf.length > CONNECT_RESPONSE_LIMIT_BYTES) {
            fail(new UpstreamProxyError("the proxy's CONNECT response headers were too large"));
            return;
          }
          continue;
        }
        const head = buf.subarray(0, idx).toString("latin1");
        const leftover = buf.subarray(idx + 4);
        socket.off("readable", onReadable);
        const status = parseStatusLine(head);
        if (status !== 200) {
          fail(
            new UpstreamProxyError(
              status === undefined
                ? "the proxy answered CONNECT with a non-HTTP response"
                : `the proxy refused CONNECT with HTTP ${status}`,
              status,
            ),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (leftover.length > 0) socket.unshift(leftover); // origin bytes that rode along with the 200
        socket.setNoDelay(true);
        resolve(socket);
        return;
      }
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error("the proxy closed the connection during CONNECT"));
    socket.on("readable", onReadable);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
  });
}
