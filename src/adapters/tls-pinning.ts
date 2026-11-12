/**
 * TLS SPKI pinning for upstream connections (ADR-005; semantics follow
 * c0wrk ADR-054): a configured `tlsFingerprint` — base64 of SHA-256 over the
 * upstream certificate's SubjectPublicKeyInfo DER — makes the adapter accept
 * ONLY the pinned key. An absent (or empty) pin leaves the default fetch
 * behavior (system CA pool) untouched. There is deliberately no mode that
 * accepts an arbitrary certificate: every mismatch fails closed.
 *
 * Enforcement on Bun (verified empirically on 1.4.4): `fetch`'s
 * `tls.checkServerIdentity` never runs when the certificate chain fails to
 * verify, so pinning a self-signed upstream needs the chain to pass first.
 * The module therefore
 *
 *   1. probes the upstream with a bare TLS handshake
 *      (`node:tls.connect`, `rejectUnauthorized: false` — no HTTP request is
 *      sent, no credential is involved; the fingerprint IS what is fetched),
 *      computes the pin, and refuses the leaf when it does not match the
 *      configured pin;
 *   2. hands the probed leaf certificate to `fetch` as its `tls.ca`, so the
 *      chain of the actually-served certificate must terminate at exactly
 *      that leaf — a rotated certificate fails closed;
 *   3. installs a pin-only `tls.checkServerIdentity` on the same fetch —
 *      it runs after the chain verified, re-checks the SPKI pin per
 *      connection, and (being a custom callback) replaces the built-in
 *      hostname check entirely: the pin is the only identity requirement.
 *
 * The probed leaf PEM is cached on the caller's side as an optimization; a
 * TLS failure invalidates the cache (`isTlsFailure`) so the next request
 * re-probes — a certificate renewed with the same key pair keeps matching
 * the pin, a key change fails closed on the probe.
 */
import crypto from "node:crypto";
import { isIP } from "node:net";
import tls from "node:tls";

/**
 * A TLS verification failure on the pinned path: the probe's pin check, the
 * per-connection `checkServerIdentity` veto, or a chain that does not
 * terminate at the pinned leaf. The adapter maps this class to the
 * `upstream_tls_error` envelope; anything else stays "unreachable" (504).
 */
export class UpstreamTlsPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamTlsPinError";
  }
}

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

/** Wrap DER bytes as a PEM CERTIFICATE block (64-character base64 lines). */
function pemFromDer(raw: Buffer): string {
  const body = raw.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/**
 * True when an upstream failure is a TLS verification failure (pin veto,
 * certificate chain) rather than plain unreachability — the cache
 * invalidation and the error mapping both branch on this.
 */
export function isTlsFailure(error: unknown): boolean {
  if (error instanceof UpstreamTlsPinError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /certificate|tls|ssl|pin/i.test(message);
}

export interface PinnedLeaf {
  /** PEM of the probed leaf certificate (the fetch `ca` anchor). */
  pem: string;
  /** The leaf's pin — `base64(SHA-256(SPKI DER))`. */
  pin: string;
}

/**
 * The fetch `tls` options for one pinned upstream: the probed leaf as the
 * only trust anchor, plus a pin-only `checkServerIdentity` (which, as a
 * custom callback, replaces the built-in hostname check — the pin is the
 * only identity requirement, per ADR-005).
 */
export function pinnedTlsOptions(pem: string, expectedPin: string): {
  ca: string;
  checkServerIdentity: (hostname: string, certificate: { raw?: Buffer }) => Error | undefined;
} {
  return {
    ca: pem,
    checkServerIdentity: (_hostname, certificate) => {
      const raw = certificate.raw;
      if (raw === undefined) {
        return new UpstreamTlsPinError("upstream TLS certificate pin mismatch: the server presented no certificate");
      }
      let actual: string;
      try {
        actual = computeSpkiPin(raw);
      } catch {
        return new UpstreamTlsPinError("upstream TLS certificate pin mismatch: the certificate could not be parsed");
      }
      if (actual !== expectedPin) {
        // the fact of the mismatch and nothing else — no certificate bytes,
        // no subject, no DNS names (ADR-005)
        return new UpstreamTlsPinError("upstream TLS certificate pin mismatch");
      }
      return undefined;
    },
  };
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
 * `expectedPin` — the fail-closed probe the pinned adapter path uses before
 * its first request.
 */
export async function probePinnedLeaf(
  url: string,
  timeoutMs: number,
  expectedPin: string,
  signal?: AbortSignal,
): Promise<PinnedLeaf> {
  const leaf = await fetchLeafCertificate(url, timeoutMs, signal);
  if (leaf.pin !== expectedPin) {
    // the fact of the mismatch and nothing else — no certificate bytes,
    // no subject, no DNS names (ADR-005)
    throw new UpstreamTlsPinError("upstream TLS certificate pin mismatch");
  }
  return leaf;
}
