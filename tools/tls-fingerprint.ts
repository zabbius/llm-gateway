#!/usr/bin/env bun
/**
 * Print the TLS SPKI pin of the certificate an https endpoint currently
 * serves — the exact string for the `tlsFingerprint` field of an upstream
 * config entry (ADR-005).
 *
 *   bun tools/tls-fingerprint.ts https://llm.lan:8443/v1
 *   → base64(SHA-256(SPKI DER)) on stdout, one line
 *
 *   bun tools/tls-fingerprint.ts --expect 'K4vmDE8v…' https://llm.lan:8443/v1
 *   → prints the pin when the endpoint serves it, fails closed otherwise
 *
 * The probe is a bare TLS handshake (verification disabled — the
 * fingerprint IS what is being fetched): no HTTP request is sent, no
 * credentials are involved. Self-signed and internal-PKI certificates are
 * fingerprinted like any other; "trusted or not" plays no role. All TLS
 * handling is reused from src/upstreams/tls-pinning.ts.
 */
import { fetchLeafCertificate, probePinnedLeaf, type PinnedLeaf } from "../src/upstreams/tls-pinning.ts";

const PROBE_TIMEOUT_MS = 10_000;

/** The full explanation behind --help: the pin, its format, its use. */
function help(): never {
  console.log(`usage: bun tools/tls-fingerprint.ts [--expect <pin>] <https-url>

Prints the TLS SPKI pin of the certificate the https endpoint serves —
the exact string for the tlsFingerprint field of an upstream config entry.

  <https-url>      endpoint to fingerprint (https only; port and path from
                   the URL, SNI from the hostname; default port 443)
  --expect <pin>   instead of just printing, verify the endpoint serves
                   this pin (fail-closed: mismatch exits non-zero)

The pin format is base64(SHA-256(SPKI DER)) — the RFC 7469 / Chromium
CertificatePinList construction over the certificate's public key. It
stays valid across certificate renewals as long as the key pair is
reused, and changes when the key changes. To recompute it by hand:
openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64

The probe is a bare TLS handshake: no HTTP request is sent and no
credentials are involved; certificate verification is disabled because a
pinned endpoint's chain need not be publicly trusted.`);
  process.exit(0);
}

/** Bad invocation: one-line usage on stderr, non-zero exit. */
function usage(problem?: string): never {
  if (problem !== undefined) console.error(`tools/tls-fingerprint: ${problem}`);
  console.error("usage: bun tools/tls-fingerprint.ts [--expect <pin>] <https-url>  (--help for details)");
  process.exit(1);
}

/** Parse argv into the probe mode; unknown flags and extra URLs are errors. */
function parseArgv(argv: readonly string[]): { url: string; expectedPin?: string } {
  const positional: string[] = [];
  let expectedPin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") help();
    if (arg === "--expect") {
      const value = argv[i + 1];
      if (value === undefined || value === "") usage("--expect requires a pin argument");
      expectedPin = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) usage(`unknown option "${arg}"`);
    positional.push(arg);
  }
  if (positional.length === 0) usage("an https-url argument is required");
  if (positional.length > 1) usage(`expected exactly one https-url, got ${positional.length}`);
  return { url: positional[0] ?? "", expectedPin };
}

async function main(): Promise<void> {
  const { url, expectedPin } = parseArgv(process.argv.slice(2));

  let leaf: PinnedLeaf;
  try {
    leaf =
      expectedPin === undefined
        ? await fetchLeafCertificate(url, PROBE_TIMEOUT_MS)
        : await probePinnedLeaf(url, PROBE_TIMEOUT_MS, expectedPin);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`tools/tls-fingerprint: ${url}: ${reason}`);
    process.exit(1);
  }
  console.log(leaf.pin);
}

if (import.meta.main) {
  await main();
}
