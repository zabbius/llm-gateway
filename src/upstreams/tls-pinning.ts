/**
 * TLS SPKI pinning for upstream connections (ADR-005; semantics follow
 * c0wrk ADR-054): a configured `tlsFingerprint` — base64 of SHA-256 over the
 * upstream certificate's SubjectPublicKeyInfo DER — makes the upstream accept
 * ONLY the pinned key. An absent (or empty) pin leaves the default fetch
 * behavior (system CA pool) untouched. There is deliberately no mode that
 * accepts an arbitrary certificate: every mismatch fails closed.
 *
 * Enforcement on Bun (verified empirically on 1.4.4): the TLS layer inside
 * `fetch` cannot express "accept the pinned key and nothing else". Its
 * `tls.checkServerIdentity` never runs when chain verification fails, and a
 * non-self-signed leaf passed as `tls.ca` cannot anchor its own chain — an
 * upstream that presents its leaf without a full chain (the common
 * internal-PKI deployment) is unpinnable through fetch no matter what the
 * config says. The pinned path therefore bypasses fetch's TLS layer:
 *
 *   1. the upstream connection is opened here (`node:tls.connect`,
 *      `rejectUnauthorized: false` — a pinned chain need not be publicly
 *      trusted), the served leaf certificate is read, and the connection is
 *      refused unless its pin matches the configuration — before any
 *      request byte, hence any credential, is written;
 *   2. the verified socket then carries a plain `node:http` request
 *      (`createConnection`), whose response is surfaced as the same
 *      `Response` the unpinned fetch path returns — relay semantics,
 *      SSE streaming included, are unchanged.
 *
 * Every pinned request verifies its own connection: a certificate renewed
 * with the same key pair keeps matching the pin, a key change fails closed
 * on the next request. Nothing is cached between requests.
 *
 * The bare-handshake probe (`fetchLeafCertificate`, `probePinnedLeaf`)
 * remains for the `tools/tls-fingerprint.ts` CLI — it fetches exactly the
 * pin: no HTTP request, no credentials.
 */
import crypto from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";

/**
 * A TLS verification failure on the pinned path: a pin decision (mismatch,
 * missing or unparsable certificate) or a pin on a plain-http endpoint.
 * The upstream maps this class to the `upstream_tls_error` envelope;
 * anything else stays "unreachable" (504).
 */
export class UpstreamTlsPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamTlsPinError";
  }
}

/** The pin-mismatch fact — no certificate bytes, subject, or DNS names (ADR-005). */
export const PIN_MISMATCH_MESSAGE = "upstream TLS certificate pin mismatch";

/**
 * Compute the pin of one certificate — accepted as an `X509Certificate` or
 * its raw DER bytes: `base64(SHA-256(SPKI DER))` — the Chromium
 * CertificatePinList / RFC 7469 construction, so a pin survives certificate
 * renewal as long as the key pair is reused.
 */
export function computeSpkiPin(certificate: crypto.X509Certificate | Buffer | Uint8Array): string {
  const parsed = certificate instanceof crypto.X509Certificate ? certificate : new crypto.X509Certificate(certificate);
  const spki = parsed.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spki).digest("base64");
}

/**
 * The fail-closed pin decision for one served certificate: accept only the
 * configured key, refuse anything else — and the absence or unparsability
 * of a certificate — with the fact of the refusal and nothing else.
 */
export function assertPinnedCertificate(raw: Buffer | undefined, expectedPin: string): void {
  if (raw === undefined || raw.length === 0) {
    throw new UpstreamTlsPinError("the upstream presented no certificate to pin");
  }
  let actual: string;
  try {
    actual = computeSpkiPin(raw);
  } catch {
    throw new UpstreamTlsPinError("the upstream TLS certificate could not be parsed");
  }
  if (actual !== expectedPin) {
    throw new UpstreamTlsPinError(PIN_MISMATCH_MESSAGE);
  }
}

/** Wrap DER bytes as a PEM CERTIFICATE block (64-character base64 lines). */
function pemFromDer(raw: Buffer): string {
  const body = raw.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/**
 * True when an upstream failure is a TLS verification failure (a pin
 * decision, a plain-http pin) rather than plain unreachability — the
 * upstream's error mapping branches on this.
 */
export function isTlsFailure(error: unknown): boolean {
  if (error instanceof UpstreamTlsPinError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /certificate|tls|ssl|pin/i.test(message);
}

export interface PinnedLeaf {
  /** PEM of the served leaf certificate. */
  pem: string;
  /** The leaf's pin — `base64(SHA-256(SPKI DER))`. */
  pin: string;
}

/**
 * Bare TLS handshake against the endpoint — no HTTP request, no credentials
 * (the fingerprint IS what is being fetched; verification is disabled
 * because a pinned endpoint's chain need not be publicly trusted).
 * Returns the served leaf certificate as `{ pem, pin }` — no pin decision
 * attached; `probePinnedLeaf` adds the pin comparison on top of this.
 */
export function fetchLeafCertificate(url: string, timeoutMs: number, signal?: AbortSignal): Promise<PinnedLeaf> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new UpstreamTlsPinError(`cannot probe TLS pin: "${url}" is not a valid URL`));
  }
  if (target.protocol !== "https:") {
    return Promise.reject(new UpstreamTlsPinError("cannot probe a TLS pin on a plain-http endpoint"));
  }
  if (signal?.aborted) {
    return Promise.reject(new UpstreamTlsPinError("TLS pin probe aborted"));
  }
  const host = target.hostname.replace(/^\[|\]$/g, ""); // unwrap IPv6 literals
  const port = target.port === "" ? 443 : Number(target.port);
  // SNI carries hostnames, never IP literals (node:tls rejects an IP servername)
  const servername = isIP(host) === 0 ? host : undefined;

  return new Promise<PinnedLeaf>((resolve, reject) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    const timer = setTimeout(() => {
      socket.destroy(new UpstreamTlsPinError("TLS pin probe timed out"));
    }, timeoutMs);
    timer.unref();
    const abort = (): void => {
      socket.destroy(new UpstreamTlsPinError("TLS pin probe aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    socket.once("secureConnect", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        const certificate = socket.getPeerCertificate();
        const raw = certificate.raw;
        if (raw === undefined || raw.length === 0) {
          socket.destroy();
          reject(new UpstreamTlsPinError("the upstream presented no certificate to pin"));
          return;
        }
        socket.destroy();
        resolve({ pem: pemFromDer(raw), pin: computeSpkiPin(raw) });
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new UpstreamTlsPinError("TLS pin probe failed"));
      }
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/**
 * The served leaf certificate, ACCEPTED ONLY WHEN its pin matches
 * `expectedPin` — the fail-closed check the pin-fingerprint CLI uses.
 */
export async function probePinnedLeaf(
  url: string,
  timeoutMs: number,
  expectedPin: string,
  signal?: AbortSignal,
): Promise<PinnedLeaf> {
  const leaf = await fetchLeafCertificate(url, timeoutMs, signal);
  if (leaf.pin !== expectedPin) {
    throw new UpstreamTlsPinError(PIN_MISMATCH_MESSAGE);
  }
  return leaf;
}

/**
 * One upstream request over a pinned connection (ADR-005): the TLS socket is
 * opened here and accepted only when the served certificate's SPKI pin
 * matches `expectedPin` — checked before any request byte is written, so
 * credentials never reach a mismatching upstream. The verified socket then
 * carries the HTTP request; the response is surfaced as a standard
 * `Response` (streaming body, SSE included).
 *
 * Timeouts, aborts, and network failures surface as plain errors
 * (unreachable/timeout semantics); only pin decisions throw
 * `UpstreamTlsPinError`.
 */
export async function pinnedUpstreamRequest(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: ReadableStream<Uint8Array>;
    signal: AbortSignal;
  },
  expectedPin: string,
  handshakeTimeoutMs: number,
): Promise<Response> {
  if (init.signal.aborted) {
    throw new Error("the upstream request was aborted before it started");
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new UpstreamTlsPinError(`cannot enforce a TLS pin: "${url}" is not a valid URL`);
  }
  if (target.protocol !== "https:") {
    throw new UpstreamTlsPinError("cannot enforce a TLS pin on a plain-http endpoint");
  }
  const host = target.hostname.replace(/^\[|\]$/g, ""); // unwrap IPv6 literals
  const port = target.port === "" ? 443 : Number(target.port);
  // SNI carries hostnames, never IP literals (node:tls rejects an IP servername)
  const servername = isIP(host) === 0 ? host : undefined;

  const socket = await openPinnedSocket({ host, port, servername }, expectedPin, handshakeTimeoutMs, init.signal);

  return await new Promise<Response>((resolve, reject) => {
    const request = http.request(
      {
        host,
        port,
        path: `${target.pathname}${target.search}`,
        method: init.method,
        // the explicit Host mirrors what fetch would send (bracketed IPv6
        // literals included); node's own Host would miss the brackets.
        // No `agent: false` here: Bun's node:http hangs up a createConnection
        // request when agent is disabled — the default agent is consumed
        // once per socket anyway
        headers: { ...init.headers, host: target.host },
        createConnection: () => socket,
      },
      (upstream) => {
        const headers = new Headers();
        // framing headers are re-derived for the relayed body
        const skip = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);
        for (let i = 0; i + 1 < upstream.rawHeaders.length; i += 2) {
          const name = upstream.rawHeaders[i] ?? "";
          if (!skip.has(name.toLowerCase())) {
            headers.append(name, upstream.rawHeaders[i + 1] ?? "");
          }
        }
        resolve(
          new Response(Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>, {
            status: upstream.statusCode ?? 502,
            statusText: upstream.statusMessage ?? "",
            headers,
          }),
        );
      },
    );
    request.on("error", reject);
    const onAbort = (): void => {
      socket.destroy(new Error("the upstream request was aborted"));
    };
    init.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () => init.signal.removeEventListener("abort", onAbort));

    const body = init.body;
    if (body === undefined) {
      request.end();
      return;
    }
    void (async (): Promise<void> => {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined && !request.write(value)) {
            await new Promise<void>((resume) => request.once("drain", resume));
          }
        }
        request.end();
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error("the upstream request body failed"));
      }
    })();
  });
}

/**
 * Open the pinned upstream TLS connection and enforce the pin on it — the
 * connection is refused unless the served certificate's pin matches, before
 * any request data flows over it. Plain errors for timeouts, aborts, and
 * network failures (unreachable semantics); `UpstreamTlsPinError` only for
 * pin decisions.
 */
function openPinnedSocket(
  endpoint: { host: string; port: number; servername?: string },
  expectedPin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...endpoint, rejectUnauthorized: false });
    const timer = setTimeout(() => {
      fail(new Error("the upstream handshake timed out"));
    }, timeoutMs);
    timer.unref();
    const onAbort = (): void => {
      fail(new Error("the upstream request was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    function fail(error: Error): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    }

    socket.once("error", (error: Error) => fail(error));
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        assertPinnedCertificate(socket.getPeerCertificate()?.raw, expectedPin);
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new UpstreamTlsPinError(PIN_MISMATCH_MESSAGE));
        return;
      }
      resolve(socket);
    });
  });
}
