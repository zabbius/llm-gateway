/**
 * The tools/tls-fingerprint.ts script: prints the `tlsFingerprint` pin for
 * an https endpoint (ADR-005). Verified end-to-end against a local TLS
 * upstream serving the pinning fixtures — the printed pin must equal the
 * openssl-computed ground truth of the served certificate.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "tls-fingerprint.ts");
const FIXTURES = join(import.meta.dir, "..", "src", "adapters", "fixtures");
const PIN_CERT = "K4vmDE8v8SKXajayPc4yMc49GIvJEHyUF8mRo7bu/EM="; // openssl ground truth of the fixture cert

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const server of servers) server.stop();
  servers.length = 0;
});

afterAll(() => {
  for (const server of servers) server.stop();
});

function startTlsUpstream(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    tls: {
      key: readFileSync(join(FIXTURES, "pinned-test-key.pem"), "utf8"),
      cert: readFileSync(join(FIXTURES, "pinned-test-cert.pem"), "utf8"),
    },
    fetch: () => Response.json({ ok: true }),
  });
  servers.push(server);
  const { port } = server;
  if (port === undefined) throw new Error("the test upstream did not get a TCP port");
  return { port, stop: () => server.stop(true) };
}

async function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("tools/tls-fingerprint.ts", () => {
  test("prints the served certificate's SPKI pin (openssl ground truth)", async () => {
    const upstream = startTlsUpstream();

    const result = await runScript([`https://localhost:${upstream.port}/v1`]);

    expect(result.code).toBe(0);
    // exactly one line on stdout: the pin, ready to paste into the config
    expect(result.stdout.split("\n")).toHaveLength(2); // pin + trailing newline
    expect(result.stdout.trim()).toBe(PIN_CERT);
    expect(result.stderr).toBe("");
  });

  test("a plain-http URL is rejected with a usage exit", async () => {
    const result = await runScript(["http://127.0.0.1:11434/v1"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("plain-http");
  });

  test("an unreachable endpoint exits non-zero naming the failure", async () => {
    // port 1 on loopback: nothing listens there, connect fails fast
    const result = await runScript(["https://127.0.0.1:1/v1"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tools/tls-fingerprint:");
  });

  test("no or extra arguments print the usage", async () => {
    for (const args of [[], ["https://a.example/v1", "https://b.example/v1"]]) {
      const result = await runScript(args);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("usage: bun tools/tls-fingerprint.ts");
    }
  });

  test("--help explains the pin format and exits zero", async () => {
    const result = await runScript(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("base64(SHA-256(SPKI DER))"); // the key format
    expect(result.stdout).toContain("tlsFingerprint"); // where the pin goes
    expect(result.stdout).toContain("openssl dgst -sha256"); // the openssl cross-check
  });

  test("--expect with the pinned endpoint's real pin passes through probePinnedLeaf", async () => {
    const upstream = startTlsUpstream();

    const result = await runScript([`https://localhost:${upstream.port}/v1`, "--expect", PIN_CERT]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(PIN_CERT);
    expect(result.stderr).toBe("");
  });

  test("--expect with a different pin fails closed, non-zero", async () => {
    const upstream = startTlsUpstream();

    const result = await runScript([`https://localhost:${upstream.port}/v1`, "--expect", "AAAA="]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pin mismatch");
  });
});
