/**
 * Unit tests for the runtime configuration store (ADR-014 D1, D6, D7;
 * `src/config/store.ts`): per-entry validation of every collection write
 * (grammar, unknown keys, strategy/weight consistency, limits rules),
 * uniqueness within a collection, the cross-collection references
 * (`routes[].upstream` → `upstreams[].id`, `client.models` →
 * `models[].alias`), the wire grammar of `apiKey` / `tlsFingerprint` /
 * `proxy` (absent = keep on update; `null` and `""` = one clear signal,
 * refused for the required credential; a whitespace-only value and the
 * `[Configured]` mask literal are refused — table-driven over field × body
 * value × operation), the in-use removal refusal,
 * and the atomic write-back — a sibling temp file renamed onto the config
 * file, applied to memory only after the write succeeded, with the
 * operator-owned sections preserved verbatim and every written file still
 * passing the startup validator (`validateGatewayConfig`).
 *
 * Every credential in these fixtures is synthetic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGatewayConfig } from "./schema.ts";
import { ConfigStore } from "./store.ts";
import type { StoreResult } from "./store.ts";

// ---------------------------------------------------------------------------
// fixtures — every credential below is synthetic
// ---------------------------------------------------------------------------

const UPSTREAM_KEY = "sk-upstream-synthetic-key";
const CLIENT_KEY = "ck-client-synthetic-key";

/** A base64 SPKI pin decoding to exactly 32 bytes — a valid (synthetic) fingerprint. */
const VALID_PIN = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

/** A synthetic PHC-format password hash — only the prefix is validated (ADR-007). */
const SYNTHETIC_HASH = "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$ZmFrZWhhc2hmYWtlaGFzaA";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "llm-gateway-store-"));
let fixtureSeq = 0;

/** One raw upstream entry. */
function rawUpstream(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "openai-compatible",
    id,
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `${UPSTREAM_KEY}-${id}`,
    ...overrides,
  };
}

/** One raw model entry (weighted strategy, weights on every route). */
function rawModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: "smart",
    routes: [
      { upstream: "openai", model: "gpt-4o", weight: 3 },
      { upstream: "ollama", model: "qwen2.5:7b-instruct", weight: 1 },
    ],
    balance: { strategy: "weighted-round-robin" },
    ...overrides,
  };
}

/** One raw client entry. */
function rawClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "local-dev", apiKey: CLIENT_KEY, models: ["smart"], ...overrides };
}

/** A raw config valid for the startup validator, except for the given overrides. */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    upstreams: [rawUpstream("openai"), rawUpstream("ollama")],
    models: [rawModel()],
    clients: [rawClient()],
    ...overrides,
  };
}

interface Fixture {
  store: ConfigStore;
  path: string;
  dir: string;
}

/** Write a config file into its own fixture dir and build a store over it. */
function makeStore(rawOverrides: Record<string, unknown> = {}): Fixture {
  const raw = rawConfig(rawOverrides);
  const dir = join(FIXTURE_DIR, `case-${++fixtureSeq}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const validated = validateGatewayConfig(JSON.parse(readFileSync(path, "utf8")));
  if (!validated.ok) {
    throw new Error(`invalid store fixture config: ${validated.problems.join("; ")}`);
  }
  return { store: new ConfigStore(validated.config, path), path, dir };
}

/** Overwrite the fixture's config file with raw JSON (hand-edit simulation). */
function rewriteFile(path: string, raw: unknown): void {
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/** Parse the fixture's config file from disk. */
function fileJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Names of leftover temp files in the fixture dir (must always stay empty). */
function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

/** Unwrap a failed result; throws when the operation unexpectedly succeeded. */
function problems(result: StoreResult): string[] {
  if (result.ok) throw new Error("expected the operation to fail, but it succeeded");
  return result.problems;
}

/** Unwrap a successful result; throws with the problems when it failed. */
function ok(result: StoreResult): void {
  if (!result.ok) throw new Error(`expected the operation to succeed: ${result.problems.join("; ")}`);
}

/** The written file must always still pass the startup validator. */
function expectFileValidates(path: string): void {
  const validated = validateGatewayConfig(JSON.parse(readFileSync(path, "utf8")));
  if (!validated.ok) {
    throw new Error(`written config file fails startup validation: ${validated.problems.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// the wire grammar table — one cell per field × body value × operation
// ---------------------------------------------------------------------------

/** The table's "the key is not sent" cell — distinct from a sent `null` or `""`. */
const ABSENT = Symbol("absent");

/** What one table cell expects of the write. */
type WireOutcome =
  | { reject: RegExp } // refused with a value-free problem line matching the pattern
  | { stored: string } // accepted: the varied field carries exactly this value
  | { cleared: true }; // accepted: the varied field carries no key at all

const WIRE_FIELDS = ["apiKey", "tlsFingerprint", "proxy"] as const;
type WireField = (typeof WIRE_FIELDS)[number];

/** Value-free problem lines: none of them carries any of the synthetic secrets in play. */
function expectNoLeak(lines: readonly string[], secrets: readonly string[]): void {
  for (const line of lines) {
    for (const secret of secrets) {
      expect(line.includes(secret)).toBe(false);
    }
  }
}

/** A table cell's body value, readable in a test name. */
function describeWireValue(body: unknown): string {
  return body === ABSENT ? "absent" : JSON.stringify(body);
}

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// Permission-based write failures do not fail under root.
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// ---------------------------------------------------------------------------
// upstream collection writes
// ---------------------------------------------------------------------------

describe("ConfigStore — upstream writes", () => {
  test("add appends a valid upstream, normalizes baseUrl, and the file passes startup validation", () => {
    const f = makeStore();
    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "third",
        baseUrl: "https://third.example.com/v1/",
        apiKey: "sk-third-synthetic",
      }),
    );

    expect(f.store.upstreams.length).toBe(3);
    expect(f.store.findUpstream("third")?.baseUrl).toBe("https://third.example.com/v1");
    expect(fileJson(f.path).upstreams as unknown[]).toHaveLength(3);
    expectFileValidates(f.path);
    expect(tempFiles(f.dir)).toEqual([]);
  });

  test("add rejects duplicate ids, grammar violations, bad URLs, unknown keys and non-objects", () => {
    const f = makeStore();

    expect(problems(f.store.addUpstream(rawUpstream("openai"))).join("\n")).toContain('duplicate upstream id "openai"');
    expect(problems(f.store.addUpstream(rawUpstream("UPPER"))).join("\n")).toContain("must match ^[a-z0-9][a-z0-9-]*$");
    expect(
      problems(
        f.store.addUpstream({ type: "openai-compatible", id: "a/b", baseUrl: "https://ab.example.com/v1", apiKey: "sk-ab-synthetic" }),
      ).join("\n"),
    ).toContain("must match ^[a-z0-9][a-z0-9-]*$");
    expect(
      problems(
        f.store.addUpstream({ type: "openai-compatible", id: "x", baseUrl: "ftp://x.example.com/v1", apiKey: "sk-x-synthetic" }),
      ).join("\n"),
    ).toContain("must be an absolute http(s) URL");
    expect(problems(f.store.addUpstream({ ...rawUpstream("x"), extra: 1 })).join("\n")).toContain('unknown key "extra"');
    expect(problems(f.store.addUpstream("not-an-object")).join("\n")).toContain("must be a JSON object");
    expect(
      problems(f.store.addUpstream({ type: "openai-compatible", id: "x", baseUrl: "https://x.example.com/v1" })).join("\n"),
    ).toContain('missing required key "apiKey"');

    // every rejected write leaves collection and file untouched
    expect(f.store.upstreams.length).toBe(2);
    expectFileValidates(f.path);
    expect(tempFiles(f.dir)).toEqual([]);
  });

  test("the literal [Configured] mask is rejected as a credential value; stored keys never leak into problems", () => {
    const f = makeStore();

    const maskKey = problems(
      f.store.addUpstream({ type: "openai-compatible", id: "third", baseUrl: "https://third.example.com/v1", apiKey: "[Configured]" }),
    );
    expect(maskKey.join("\n")).toContain("must not be the literal");

    const maskPin = problems(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "fourth",
        baseUrl: "https://fourth.example.com/v1",
        apiKey: "sk-fourth-synthetic",
        tlsFingerprint: "[Configured]",
      }),
    );
    expect(maskPin.join("\n")).toContain("tlsFingerprint must not be the literal");

    const emptyKey = problems(
      f.store.addUpstream({ type: "openai-compatible", id: "fifth", baseUrl: "https://fifth.example.com/v1", apiKey: "" }),
    );

    // apiKey-grade output care: no problem line ever quotes the stored secret
    for (const line of [...maskKey, ...maskPin, ...emptyKey]) {
      expect(line.includes(UPSTREAM_KEY)).toBe(false);
    }
    expect(f.store.upstreams.length).toBe(2);
    expectFileValidates(f.path);
  });

  test("tlsFingerprint must decode to 32 bytes; a valid pin is stored whitespace-normalized", () => {
    const f = makeStore();

    expect(
      problems(
        f.store.addUpstream({
          type: "openai-compatible",
          id: "pinned",
          baseUrl: "https://p.example.com/v1",
          apiKey: "sk-p-synthetic",
          tlsFingerprint: "not-base64!!",
        }),
      ).join("\n"),
    ).toContain("decoding to exactly 32 bytes");

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "pinned",
        baseUrl: "https://p.example.com/v1",
        apiKey: "sk-p-synthetic",
        tlsFingerprint: `  ${VALID_PIN}  `,
      }),
    );
    expect(f.store.findUpstream("pinned")?.tlsFingerprint).toBe(VALID_PIN);
    expect((fileJson(f.path).upstreams as Record<string, unknown>[])[2]?.tlsFingerprint).toBe(VALID_PIN);
    expectFileValidates(f.path);
  });

  test("update without apiKey keeps the stored credential (ADR-014 D7)", () => {
    const f = makeStore();

    ok(f.store.updateUpstream("openai", { type: "openai-compatible", baseUrl: "https://openai2.example.com/v1" }));

    const stored = f.store.findUpstream("openai");
    expect(stored?.apiKey).toBe(`${UPSTREAM_KEY}-openai`);
    expect(stored?.baseUrl).toBe("https://openai2.example.com/v1");
    expect((fileJson(f.path).upstreams as Record<string, unknown>[])[0]?.apiKey).toBe(`${UPSTREAM_KEY}-openai`);
    expectFileValidates(f.path);
  });

  test("update with an explicit new apiKey replaces the credential, on the store and on disk", () => {
    const f = makeStore();
    const newKey = "sk-rotated-synthetic-key";

    ok(f.store.updateUpstream("openai", { type: "openai-compatible", baseUrl: "https://openai.example.com/v1", apiKey: newKey }));

    expect(f.store.findUpstream("openai")?.apiKey).toBe(newKey);
    expect((fileJson(f.path).upstreams as Record<string, unknown>[])[0]?.apiKey).toBe(newKey);
    expectFileValidates(f.path);
  });

  test("update keeps the stored pin when tlsFingerprint is absent, and clears it on explicit null", () => {
    const f = makeStore({ upstreams: [rawUpstream("openai", { tlsFingerprint: VALID_PIN }), rawUpstream("ollama")] });

    ok(f.store.updateUpstream("openai", { type: "openai-compatible", baseUrl: "https://openai.example.com/v1" }));
    expect(f.store.findUpstream("openai")?.tlsFingerprint).toBe(VALID_PIN);

    ok(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        tlsFingerprint: null,
      }),
    );
    expect(f.store.findUpstream("openai")?.tlsFingerprint).toBeUndefined();
    expect((fileJson(f.path).upstreams as Record<string, unknown>[])[0]?.tlsFingerprint).toBeUndefined();
    expectFileValidates(f.path);
  });

  test("a null body value is the key not set: inherited keys read as omitted, pin/proxy keep their explicit clear, a null apiKey cannot clear the credential", () => {
    const f = makeStore({
      upstreams: [
        rawUpstream("openai", { tlsFingerprint: VALID_PIN, proxy: "http://proxy.example:8080" }),
        rawUpstream("ollama"),
      ],
    });

    // update — `null` on the inherited keys behaves exactly like an omitted one,
    // while the pin's explicit `null` still clears it and an absent proxy is kept
    ok(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        id: null,
        tlsFingerprint: null,
      }),
    );
    const stored = f.store.findUpstream("openai");
    expect(stored?.id).toBe("openai");
    expect(stored?.apiKey).toBe(`${UPSTREAM_KEY}-openai`);
    expect(stored?.tlsFingerprint).toBeUndefined();
    expect(stored?.proxy).toBe("http://proxy.example:8080");
    expectFileValidates(f.path);

    // update — `null` apiKey is the clear signal, and a credential cannot be
    // cleared (the wire grammar): refused, the stored key untouched
    const cannotClear = problems(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        apiKey: null,
      }),
    );
    expect(cannotClear.join("\n")).toContain("apiKey cannot be cleared");
    expect(f.store.findUpstream("openai")?.apiKey).toBe(`${UPSTREAM_KEY}-openai`);

    // create — `null` on a required key is reported missing, exactly like an absent one
    expect(problems(f.store.addUpstream(rawUpstream("new", { type: null }))).join("\n")).toContain('missing required key "type"');
    expect(problems(f.store.addUpstream(rawUpstream("new", { apiKey: null }))).join("\n")).toContain('missing required key "apiKey"');

    // create — `null` pin and proxy leave the entry without the keys
    ok(f.store.addUpstream(rawUpstream("new", { tlsFingerprint: null, proxy: null })));
    const created = f.store.findUpstream("new");
    expect(Object.hasOwn(created ?? {}, "tlsFingerprint")).toBe(false);
    expect(Object.hasOwn(created ?? {}, "proxy")).toBe(false);
    expectFileValidates(f.path);
  });

  test("an empty tlsFingerprint is the clear signal: create stores no key, update clears like null; a whitespace-only one is refused", () => {
    const f = makeStore({ upstreams: [rawUpstream("openai", { tlsFingerprint: VALID_PIN }), rawUpstream("ollama")] });
    const onDisk = (id: string): Record<string, unknown> | undefined =>
      (fileJson(f.path).upstreams as Record<string, unknown>[]).find((entry) => entry.id === id);

    // create: "" is the clear signal, on a create the same as absent — no key
    // on the store, on disk, or in the view
    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "blank",
        baseUrl: "https://blank.example.com/v1",
        apiKey: "sk-blank-synthetic",
        tlsFingerprint: "",
      }),
    );
    const blank = f.store.findUpstream("blank");
    expect(blank?.tlsFingerprint).toBeUndefined();
    expect(Object.hasOwn(blank ?? {}, "tlsFingerprint")).toBe(false); // never `""` on the entry
    expect(Object.hasOwn(onDisk("blank") ?? {}, "tlsFingerprint")).toBe(false);
    expect(f.store.view.upstreams.find((upstream) => upstream.id === "blank")?.tlsFingerprint).toBeNull(); // absent, never the mask

    // create: a whitespace-only value is neither a pin nor a clear signal —
    // refused, and nothing lands
    for (const value of ["   ", " \n\t "]) {
      const refused = problems(
        f.store.addUpstream({
          type: "openai-compatible",
          id: "spaces",
          baseUrl: "https://spaces.example.com/v1",
          apiKey: "sk-spaces-synthetic",
          tlsFingerprint: value,
        }),
      );
      expect(refused.join("\n")).toContain("tlsFingerprint must not be whitespace-only");
    }
    expect(f.store.findUpstream("spaces")).toBeUndefined();
    expect(f.store.upstreams.length).toBe(3); // openai, ollama, blank — "spaces" never landed

    // update: "" clears a stored pin exactly like an explicit null — the same
    // end state the startup loader produces for that value
    ok(f.store.updateUpstream("openai", { type: "openai-compatible", baseUrl: "https://openai.example.com/v1", tlsFingerprint: "" }));
    expect(f.store.findUpstream("openai")?.tlsFingerprint).toBeUndefined();
    expect(Object.hasOwn(onDisk("openai") ?? {}, "tlsFingerprint")).toBe(false);

    ok(f.store.updateUpstream("openai", { type: "openai-compatible", baseUrl: "https://openai.example.com/v1", tlsFingerprint: VALID_PIN }));
    expect(f.store.findUpstream("openai")?.tlsFingerprint).toBe(VALID_PIN);

    // update: a whitespace-only value is refused and the stored pin stays
    const blankUpdate = problems(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        tlsFingerprint: "   ",
      }),
    );
    expect(blankUpdate.join("\n")).toContain("tlsFingerprint must not be whitespace-only");
    expect(f.store.findUpstream("openai")?.tlsFingerprint).toBe(VALID_PIN);
    expect(Object.hasOwn(onDisk("openai") ?? {}, "tlsFingerprint")).toBe(true);
    expect(f.store.view.upstreams.find((upstream) => upstream.id === "openai")?.tlsFingerprint).toBe("[Configured]");
    expectFileValidates(f.path);
  });

  test("add stores a configured proxy trimmed (memory, masked view and file); an entry without one carries no proxy key", () => {
    const f = makeStore();
    const PROXY = "http://forward-proxy.internal:3128";

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "proxied",
        baseUrl: "https://proxied.example.com/v1",
        apiKey: "sk-proxied-synthetic",
        proxy: `  ${PROXY}  `,
      }),
    );
    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "direct",
        baseUrl: "https://direct.example.com/v1",
        apiKey: "sk-direct-synthetic",
        proxy: null,
      }),
    );

    expect(f.store.findUpstream("proxied")?.proxy).toBe(PROXY);
    expect(f.store.view.upstreams.find((upstream) => upstream.id === "proxied")?.proxy).toBe(PROXY); // verbatim in the masked view
    expect(f.store.findUpstream("direct")?.proxy).toBeUndefined();
    expect(f.store.view.upstreams.find((upstream) => upstream.id === "direct")?.proxy).toBeNull();

    const written = fileJson(f.path).upstreams as Record<string, unknown>[];
    expect(written.find((entry) => entry.id === "proxied")?.proxy).toBe(PROXY);
    expect("proxy" in (written.find((entry) => entry.id === "direct") ?? {})).toBe(false); // persisted only when set
    expect("proxy" in (written[0] ?? {})).toBe(false); // pre-existing entries untouched
    expectFileValidates(f.path);
  });

  test("update keeps the stored proxy when proxy is absent; null and an empty string clear it; a whitespace-only value is refused (memory and file)", () => {
    const PROXY = "socks5://10.0.0.7:1080";
    const f = makeStore({ upstreams: [rawUpstream("openai", { proxy: PROXY }), rawUpstream("ollama")] });

    // absent → keep (never a silent topology change)
    ok(f.store.updateUpstream("openai", { type: "openai-compatible", baseUrl: "https://openai.example.com/v1" }));
    expect(f.store.findUpstream("openai")?.proxy).toBe(PROXY);
    expect((fileJson(f.path).upstreams as Record<string, unknown>[])[0]?.proxy).toBe(PROXY);

    // a whitespace-only value is neither a URL nor a clear signal → refused,
    // the stored proxy stays (memory and file)
    const blank = problems(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        proxy: "   ",
      }),
    );
    expect(blank.join("\n")).toContain("proxy must not be whitespace-only");
    expect(f.store.findUpstream("openai")?.proxy).toBe(PROXY);
    expect((fileJson(f.path).upstreams as Record<string, unknown>[])[0]?.proxy).toBe(PROXY);

    // "" is the clear signal (the same as null) → a direct connection
    ok(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        proxy: "",
      }),
    );
    expect(f.store.findUpstream("openai")?.proxy).toBeUndefined();
    expect("proxy" in ((fileJson(f.path).upstreams as Record<string, unknown>[])[0] ?? {})).toBe(false);

    // re-set, then explicit null → clear
    ok(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        proxy: PROXY,
      }),
    );
    expect(f.store.findUpstream("openai")?.proxy).toBe(PROXY);
    ok(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        proxy: null,
      }),
    );
    expect(f.store.findUpstream("openai")?.proxy).toBeUndefined();
    expect(f.store.view.upstreams.find((upstream) => upstream.id === "openai")?.proxy).toBeNull();
    expect("proxy" in ((fileJson(f.path).upstreams as Record<string, unknown>[])[0] ?? {})).toBe(false);
    expectFileValidates(f.path);
    expect(tempFiles(f.dir)).toEqual([]);
  });

  test("an invalid proxy yields a value-free problem and writes nothing — a pasted user:pass@ URL never reaches the problem lines", () => {
    const f = makeStore();
    const LEAKY = "http://operator:s3cret-pw@proxy.example.com:3128";

    const leaked = problems(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "leaky",
        baseUrl: "https://leaky.example.com/v1",
        apiKey: "sk-leaky-synthetic",
        proxy: LEAKY,
      }),
    );
    expect(leaked.join("\n")).toContain("proxy must be an http: or socks5: URL with a non-empty host, an explicit port in 1-65535, no username/password");
    for (const line of leaked) {
      expect(line.includes("s3cret-pw")).toBe(false);
      expect(line.includes("operator")).toBe(false);
      expect(line.includes(LEAKY)).toBe(false);
    }

    const wrongScheme = problems(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "ftp",
        baseUrl: "https://ftp.example.com/v1",
        apiKey: "sk-ftp-synthetic",
        proxy: "ftp://proxy.example.com:21",
      }),
    );
    expect(wrongScheme.join("\n")).toContain("proxy must be an http: or socks5: URL");

    const noPort = problems(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "noport",
        baseUrl: "https://noport.example.com/v1",
        apiKey: "sk-noport-synthetic",
        proxy: "http://proxy.example.com",
      }),
    );
    expect(noPort.join("\n")).toContain("explicit port in 1-65535");

    const notAString = problems(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "numeric",
        baseUrl: "https://numeric.example.com/v1",
        apiKey: "sk-numeric-synthetic",
        proxy: 3128,
      }),
    );
    expect(notAString.join("\n")).toContain("proxy must be a string — an http: or socks5: URL with an explicit port, or null for a direct connection");

    // the same grammar applies on update, and a rejected write leaves both disk and memory untouched
    const onUpdate = problems(
      f.store.updateUpstream("openai", {
        type: "openai-compatible",
        baseUrl: "https://openai.example.com/v1",
        proxy: LEAKY,
      }),
    );
    expect(onUpdate.join("\n")).toContain("proxy must be an http: or socks5: URL");
    expect(onUpdate.join("\n").includes("s3cret-pw")).toBe(false);
    expect(f.store.upstreams.length).toBe(2);
    expect(f.store.findUpstream("openai")?.proxy).toBeUndefined();
    expect(fileJson(f.path).upstreams).toHaveLength(2);
    expectFileValidates(f.path);
    expect(tempFiles(f.dir)).toEqual([]);
  });

  // The wire grammar, table-driven: {apiKey, tlsFingerprint, proxy} × {absent,
  // null, "", "   ", a valid value, "[Configured]"} × {create, update}. Every
  // cell runs on a fresh fixture whose "openai" upstream carries all three
  // values; the body varies ONE field, so every other field reads per its own
  // row (absent = keep on update, not set on create). A refused cell leaves
  // memory and file untouched and never echoes a value; an accepted cell lands
  // exactly the expected entry, in memory and on disk.
  const STORED_KEY = `${UPSTREAM_KEY}-openai`;
  const PROBE_KEY = "sk-probe-synthetic-key";
  const STORED_PIN = VALID_PIN;
  const PROBE_PIN = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  // the pin cell sends an internal line wrap — the startup grammar still normalizes it
  const WRAPPED_PROBE_PIN = `${PROBE_PIN.slice(0, 24)}\n  ${PROBE_PIN.slice(24)}`;
  const STORED_PROXY = "http://forward-proxy.internal:3128";
  const PROBE_PROXY = "socks5://10.0.0.7:1080";
  const UPSTREAM_SECRETS = [STORED_KEY, PROBE_KEY, STORED_PIN, PROBE_PIN, STORED_PROXY, PROBE_PROXY];

  const upstreamCells: { field: WireField; body: unknown; create: WireOutcome; update: WireOutcome }[] = [
    // apiKey — a required credential: absent keeps on update; the clear signal cannot clear it
    { field: "apiKey", body: ABSENT, create: { reject: /upstream: missing required key "apiKey"/ }, update: { stored: STORED_KEY } },
    { field: "apiKey", body: null, create: { reject: /upstream: missing required key "apiKey"/ }, update: { reject: /upstream: apiKey cannot be cleared/ } },
    { field: "apiKey", body: "", create: { reject: /upstream: apiKey must be a non-empty string/ }, update: { reject: /upstream: apiKey cannot be cleared/ } },
    { field: "apiKey", body: "   ", create: { reject: /upstream: apiKey must not be whitespace-only/ }, update: { reject: /upstream: apiKey must not be whitespace-only/ } },
    { field: "apiKey", body: PROBE_KEY, create: { stored: PROBE_KEY }, update: { stored: PROBE_KEY } },
    { field: "apiKey", body: "[Configured]", create: { reject: /upstream: apiKey must not be the literal/ }, update: { reject: /upstream: apiKey must not be the literal/ } },
    // tlsFingerprint — optional: absent keeps; null and "" are one clear signal; blank is refused
    { field: "tlsFingerprint", body: ABSENT, create: { cleared: true }, update: { stored: STORED_PIN } },
    { field: "tlsFingerprint", body: null, create: { cleared: true }, update: { cleared: true } },
    { field: "tlsFingerprint", body: "", create: { cleared: true }, update: { cleared: true } },
    { field: "tlsFingerprint", body: "   ", create: { reject: /upstream: tlsFingerprint must not be whitespace-only/ }, update: { reject: /upstream: tlsFingerprint must not be whitespace-only/ } },
    { field: "tlsFingerprint", body: WRAPPED_PROBE_PIN, create: { stored: PROBE_PIN }, update: { stored: PROBE_PIN } },
    { field: "tlsFingerprint", body: "[Configured]", create: { reject: /upstream: tlsFingerprint must not be the literal/ }, update: { reject: /upstream: tlsFingerprint must not be the literal/ } },
    // proxy — optional, not a credential: absent keeps; null and "" clear; blank is refused
    { field: "proxy", body: ABSENT, create: { cleared: true }, update: { stored: STORED_PROXY } },
    { field: "proxy", body: null, create: { cleared: true }, update: { cleared: true } },
    { field: "proxy", body: "", create: { cleared: true }, update: { cleared: true } },
    { field: "proxy", body: "   ", create: { reject: /upstream: proxy must not be whitespace-only/ }, update: { reject: /upstream: proxy must not be whitespace-only/ } },
    { field: "proxy", body: `  ${PROBE_PROXY}  `, create: { stored: PROBE_PROXY }, update: { stored: PROBE_PROXY } },
    { field: "proxy", body: "[Configured]", create: { reject: /upstream: proxy must be an http: or socks5: URL/ }, update: { reject: /upstream: proxy must be an http: or socks5: URL/ } },
  ];

  for (const operation of ["create", "update"] as const) {
    for (const cell of upstreamCells) {
      const outcome = cell[operation];
      const verdict =
        "reject" in outcome ? `refused: ${outcome.reject.source}` : "stored" in outcome ? `stored ${JSON.stringify(outcome.stored)}` : "cleared";
      test(`wire grammar — ${operation}, ${cell.field} = ${describeWireValue(cell.body)} → ${verdict}`, () => {
        const f = makeStore({
          upstreams: [
            rawUpstream("openai", { tlsFingerprint: STORED_PIN, proxy: STORED_PROXY }),
            rawUpstream("ollama"),
          ],
        });
        const base =
          operation === "create"
            ? { type: "openai-compatible", id: "probe", baseUrl: "https://probe.example.com/v1", apiKey: PROBE_KEY }
            : { type: "openai-compatible", baseUrl: "https://openai.example.com/v1" };
        // the create base carries a valid key so the pin/proxy cells can land;
        // the apiKey cell's ABSENT row must still send no key at all
        const body: Record<string, unknown> = { ...base };
        if (cell.body === ABSENT) delete body[cell.field];
        else body[cell.field] = cell.body;
        const targetId = operation === "create" ? "probe" : "openai";
        const before = fileJson(f.path);
        const storedBefore = operation === "create" ? undefined : f.store.findUpstream("openai");

        const result = operation === "create" ? f.store.addUpstream(body) : f.store.updateUpstream("openai", body);

        if ("reject" in outcome) {
          expect(result.ok).toBe(false);
          const lines = problems(result);
          expect(lines.join("\n")).toMatch(outcome.reject);
          expectNoLeak(lines, UPSTREAM_SECRETS);
          // refused → nothing changed, in memory or on disk, and no temp file left behind
          expect(fileJson(f.path)).toEqual(before);
          expect(f.store.findUpstream(targetId)).toEqual(storedBefore);
          expect(tempFiles(f.dir)).toEqual([]);
          return;
        }

        ok(result);
        const expected: Record<WireField, string | undefined> = {
          ...(operation === "update"
            ? { apiKey: STORED_KEY, tlsFingerprint: STORED_PIN, proxy: STORED_PROXY }
            : { apiKey: PROBE_KEY, tlsFingerprint: undefined, proxy: undefined }),
          [cell.field]: "stored" in outcome ? outcome.stored : undefined,
        };
        const entry = f.store.findUpstream(targetId);
        const onDisk =
          (fileJson(f.path).upstreams as Record<string, unknown>[]).find((candidate) => candidate.id === targetId) ?? {};
        for (const field of WIRE_FIELDS) {
          if (expected[field] === undefined) {
            expect(Object.hasOwn(entry ?? {}, field)).toBe(false); // never "" or null on the entry
            expect(Object.hasOwn(onDisk, field)).toBe(false);
          } else {
            expect(entry?.[field]).toBe(expected[field]);
            expect(onDisk[field]).toBe(expected[field]);
          }
        }
        expectFileValidates(f.path);
        expect(tempFiles(f.dir)).toEqual([]);
      });
    }
  }

  test("update refuses unknown ids and identity changes; the id is immutable", () => {
    const f = makeStore();

    expect(problems(f.store.updateUpstream("ghost", rawUpstream("ghost"))).join("\n")).toContain('no upstream with id "ghost"');
    expect(
      problems(
        f.store.updateUpstream("openai", {
          type: "openai-compatible",
          id: "renamed",
          baseUrl: "https://openai.example.com/v1",
          apiKey: "sk-x-synthetic",
        }),
      ).join("\n"),
    ).toContain("an upstream id is immutable");

    expect(f.store.upstreams.length).toBe(2);
    expect(f.store.findUpstream("openai")).toBeDefined();
    expectFileValidates(f.path);
  });

  test("removeUpstream refuses an in-use upstream and names the referencing model (ADR-014 D6)", () => {
    const f = makeStore();

    expect(problems(f.store.removeUpstream("openai")).join("\n")).toContain('is still referenced by model "smart"');

    expect(f.store.findUpstream("openai")).toBeDefined();
    expectFileValidates(f.path);
  });

  test("removeUpstream succeeds once unreferenced; the last upstream cannot be removed", () => {
    // no clients block, two models: "smart" (routes → openai) and a spare on ollama
    const f = makeStore({
      clients: undefined,
      models: [rawModel(), rawModel({ alias: "spare", routes: [{ upstream: "ollama", model: "llama3", weight: 1 }] })],
    });

    ok(f.store.removeModel("smart"));
    ok(f.store.removeUpstream("openai"));
    expect(f.store.findUpstream("openai")).toBeUndefined();
    expect(f.store.findModel("smart")).toBeUndefined();

    expect(problems(f.store.removeUpstream("ollama")).join("\n")).toContain('is still referenced by model "spare"');
    expect(problems(f.store.removeModel("spare")).join("\n")).toContain("cannot remove the last model entry");
    expect(f.store.upstreams.length).toBe(1);
    expectFileValidates(f.path);

    const f2 = makeStore({ upstreams: [rawUpstream("solo")], models: undefined, clients: undefined });
    expect(problems(f2.store.removeUpstream("solo")).join("\n")).toContain("cannot remove the last upstream");
  });

  test("removeUpstream refuses unknown ids", () => {
    const f = makeStore();
    expect(problems(f.store.removeUpstream("ghost")).join("\n")).toContain('no upstream with id "ghost"');
  });
});

// ---------------------------------------------------------------------------
// model collection writes
// ---------------------------------------------------------------------------

describe("ConfigStore — model writes", () => {
  test("add creates the models block when absent; every route must name a registered upstream", () => {
    const f = makeStore({ models: undefined, clients: undefined });

    expect(
      problems(f.store.addModel(rawModel({ routes: [{ upstream: "ghost", model: "m", weight: 1 }] }))).join("\n"),
    ).toContain('unknown upstream "ghost"');
    expect(f.store.models).toBeUndefined();
    expect("models" in fileJson(f.path)).toBe(false);

    ok(f.store.addModel(rawModel()));
    expect(f.store.models?.length).toBe(1);
    expect("models" in fileJson(f.path)).toBe(true);
    expectFileValidates(f.path);
  });

  test("add validates alias grammar, uniqueness, routes, strategy/weight consistency and limits", () => {
    const f = makeStore();

    expect(problems(f.store.addModel(rawModel({ alias: "foo/bar" }))).join("\n")).toContain('without "/" or whitespace');
    expect(problems(f.store.addModel(rawModel({ alias: "foo bar" }))).join("\n")).toContain('without "/" or whitespace');
    expect(problems(f.store.addModel(rawModel())).join("\n")).toContain('duplicate model alias "smart"');
    expect(
      problems(f.store.addModel(rawModel({ alias: "other", routes: [{ upstream: "ghost", model: "m", weight: 1 }] }))).join("\n"),
    ).toContain('unknown upstream "ghost"');
    expect(
      problems(f.store.addModel(rawModel({ alias: "other", balance: { strategy: "round-robin" } }))).join("\n"),
    ).toContain('weight is only valid when the balance strategy is "weighted-round-robin"');
    expect(
      problems(f.store.addModel(rawModel({ alias: "other", routes: [{ upstream: "openai", model: "gpt-4o" }] }))).join("\n"),
    ).toContain('weight is required when the balance strategy is "weighted-round-robin"');
    expect(
      problems(f.store.addModel(rawModel({ alias: "other", balance: { strategy: "least-connections" } }))).join("\n"),
    ).toContain("strategy must be one of:");
    expect(problems(f.store.addModel(rawModel({ alias: "other", limits: {} }))).join("\n")).toContain(
      'limits must carry at least one of "context", "output"',
    );
    expect(problems(f.store.addModel(rawModel({ alias: "other", limits: { context: 0 } }))).join("\n")).toContain(
      "context must be a positive integer",
    );
    expect(problems(f.store.addModel(rawModel({ alias: "other", limits: { context: 5, extra: 1 } }))).join("\n")).toContain(
      'unknown key "extra"',
    );
    expect(problems(f.store.addModel(rawModel({ alias: "other", routes: [] }))).join("\n")).toContain(
      "routes must be an array with at least one route entry",
    );
    expect(
      problems(
        f.store.addModel(
          rawModel({
            alias: "other",
            routes: [
              { upstream: "openai", model: "gpt-4o", weight: 1 },
              { upstream: "openai", model: "gpt-4o", weight: 2 },
            ],
          }),
        ),
      ).join("\n"),
    ).toContain('duplicate route "openai/gpt-4o"');

    expect(f.store.models?.length).toBe(1);
    expectFileValidates(f.path);
  });

  test("add accepts a valid entry with limits; the normalized limits travel with the entry and the file", () => {
    const f = makeStore();
    ok(
      f.store.addModel(
        rawModel({
          alias: "fast",
          routes: [{ upstream: "openai", model: "gpt-4o-mini", weight: 1 }],
          limits: { context: 128000, output: 4096 },
        }),
      ),
    );

    expect(f.store.findModel("fast")?.limits).toEqual({ context: 128000, output: 4096 });
    expect((fileJson(f.path).models as Record<string, unknown>[])[1]?.limits).toEqual({ context: 128000, output: 4096 });
    expectFileValidates(f.path);
  });

  test("update replaces routes/balance/limits wholesale and keeps the alias immutable", () => {
    const f = makeStore();

    expect(
      problems(
        f.store.updateModel("smart", rawModel({ alias: "renamed", routes: [{ upstream: "openai", model: "gpt-4o", weight: 1 }] })),
      ).join("\n"),
    ).toContain("a model alias is immutable");

    ok(
      f.store.updateModel("smart", {
        routes: [{ upstream: "ollama", model: "qwen2.5:7b-instruct", weight: 2 }],
        balance: { strategy: "weighted-round-robin" },
      }),
    );
    const updated = f.store.findModel("smart");
    expect(updated?.alias).toBe("smart");
    expect(updated?.routes).toEqual([{ upstream: "ollama", model: "qwen2.5:7b-instruct", weight: 2 }]);
    expect(updated?.limits).toBeUndefined();
    expectFileValidates(f.path);

    expect(problems(f.store.updateModel("ghost", rawModel())).join("\n")).toContain('no model with alias "ghost"');
  });

  test("a null body value is the key not set on model writes: weights, single limits and the limits block fall away", () => {
    const f = makeStore({ models: [rawModel({ limits: { context: 8192, output: 4096 } })] });

    // update — a null alias is inherited, a null weight is an unweighted route,
    // a null limits block leaves the entry without limits (replaced wholesale)
    ok(
      f.store.updateModel("smart", {
        alias: null,
        routes: [{ upstream: "openai", model: "gpt-4o", weight: null }],
        balance: { strategy: "round-robin" },
        limits: null,
      }),
    );
    const updated = f.store.findModel("smart");
    expect(updated?.alias).toBe("smart");
    expect(updated?.routes).toEqual([{ upstream: "openai", model: "gpt-4o" }]);
    expect(updated?.limits).toBeUndefined();
    expect(Object.hasOwn(updated ?? {}, "limits")).toBe(false);
    expectFileValidates(f.path);

    // a null single limit falls away, its sibling stays
    ok(
      f.store.updateModel("smart", {
        routes: [{ upstream: "openai", model: "gpt-4o", weight: 2 }],
        balance: { strategy: "weighted-round-robin" },
        limits: { context: null, output: 4096 },
      }),
    );
    expect(f.store.findModel("smart")?.limits).toEqual({ output: 4096 });
    expectFileValidates(f.path);

    // required keys — null reads as missing, exactly like absent
    const hollow = problems(f.store.updateModel("smart", { routes: null, balance: null })).join("\n");
    expect(hollow).toContain("model: routes must be an array with at least one route entry");
    expect(hollow).toContain('model: missing required key "balance"');
    expect(
      problems(
        f.store.updateModel("smart", {
          routes: [{ upstream: "openai", model: "gpt-4o", weight: null }],
          balance: { strategy: "weighted-round-robin" },
        }),
      ).join("\n"),
    ).toContain('weight is required when the balance strategy is "weighted-round-robin"');
    expect(problems(f.store.addModel(rawModel({ alias: "hollow", limits: { context: null } }))).join("\n")).toContain(
      'model: limits must carry at least one of "context", "output"',
    );
  });

  test("remove refuses the last entry of a present block and entries referenced by a client ACL", () => {
    const f = makeStore();
    expect(problems(f.store.removeModel("smart")).join("\n")).toContain('is still referenced by client "local-dev"');
    expect(f.store.findModel("smart")).toBeDefined();

    const f2 = makeStore({ clients: undefined });
    expect(problems(f2.store.removeModel("smart")).join("\n")).toContain("cannot remove the last model entry");
    expect(problems(f2.store.removeModel("ghost")).join("\n")).toContain('no model with alias "ghost"');
  });
});

// ---------------------------------------------------------------------------
// client collection writes
// ---------------------------------------------------------------------------

describe("ConfigStore — client writes", () => {
  test("add creates the clients block when absent and validates alias cross-references", () => {
    const f = makeStore({ clients: undefined });

    expect(problems(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk-synthetic", models: ["ghost"] })).join("\n")).toContain(
      'unknown model alias "ghost"',
    );
    expect(f.store.clients).toBeUndefined();
    expect("clients" in fileJson(f.path)).toBe(false);

    ok(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk-synthetic", models: ["smart"] }));
    expect(f.store.clients?.length).toBe(1);
    expect("clients" in fileJson(f.path)).toBe(true);
    expectFileValidates(f.path);
  });

  test("add rejects duplicate names, empty/masked keys, and broken model lists", () => {
    const f = makeStore();

    expect(problems(f.store.addClient(rawClient())).join("\n")).toContain('duplicate client name "local-dev"');
    expect(problems(f.store.addClient({ name: "kiosk", apiKey: "", models: ["smart"] })).join("\n")).toContain(
      "apiKey must be a non-empty string",
    );
    const maskLines = problems(f.store.addClient({ name: "kiosk", apiKey: "[Configured]", models: ["smart"] }));
    expect(maskLines.join("\n")).toContain("must not be the literal");
    expect(problems(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk", models: [] })).join("\n")).toContain(
      "models must be an array with at least one model alias",
    );
    expect(problems(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk", models: ["smart", "smart"] })).join("\n")).toContain(
      'duplicate model alias "smart" in the models array',
    );
    expect(problems(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk", models: ["smart", "ghost"] })).join("\n")).toContain(
      'unknown model alias "ghost"',
    );
    expect(problems(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk", models: ["smart"], extra: 1 })).join("\n")).toContain(
      'unknown key "extra"',
    );

    // the mask-rejection line names the public mask, never a stored key
    for (const line of maskLines) {
      expect(line.includes(CLIENT_KEY)).toBe(false);
    }
    expect(f.store.clients?.length).toBe(1);
    expectFileValidates(f.path);
  });

  test("update keeps the stored credential and replaces the alias ACL wholesale", () => {
    const f = makeStore();
    ok(f.store.addModel(rawModel({ alias: "fast", routes: [{ upstream: "openai", model: "gpt-4o-mini", weight: 1 }] })));

    ok(f.store.updateClient("local-dev", { models: ["fast"] }));
    const updated = f.store.findClient("local-dev");
    expect(updated?.apiKey).toBe(CLIENT_KEY);
    expect(updated?.models).toEqual(["fast"]);
    expect((fileJson(f.path).clients as Record<string, unknown>[])[0]?.apiKey).toBe(CLIENT_KEY);
    expectFileValidates(f.path);

    expect(problems(f.store.updateClient("ghost", rawClient())).join("\n")).toContain('no client with name "ghost"');
    expect(problems(f.store.updateClient("local-dev", rawClient({ name: "renamed" }))).join("\n")).toContain(
      "a client name is immutable",
    );
  });

  test("a null body value is the key not set on client writes: a null name reads as omitted, a null apiKey cannot clear the credential, null models as missing", () => {
    const f = makeStore();

    ok(f.store.updateClient("local-dev", { name: null, models: ["smart"] }));
    const updated = f.store.findClient("local-dev");
    expect(updated?.name).toBe("local-dev");
    expect(updated?.apiKey).toBe(CLIENT_KEY);
    expectFileValidates(f.path);

    // a null apiKey is the clear signal, and a credential cannot be cleared
    // (the wire grammar): refused, the stored key untouched
    const cannotClear = problems(f.store.updateClient("local-dev", { apiKey: null, models: ["smart"] }));
    expect(cannotClear.join("\n")).toContain("client: apiKey cannot be cleared");
    expect(f.store.findClient("local-dev")?.apiKey).toBe(CLIENT_KEY);

    expect(problems(f.store.addClient(rawClient({ name: "second", apiKey: null }))).join("\n")).toContain(
      'client: missing required key "apiKey"',
    );
    expect(problems(f.store.updateClient("local-dev", { models: null })).join("\n")).toContain(
      "client: models must be an array with at least one model alias",
    );
  });

  // The wire grammar for a client's `apiKey`, table-driven — the same rows as
  // an upstream's required credential: absent keeps on update; the clear
  // signal cannot clear it; blank and the mask are refused; on a create `null`
  // reads as missing and `""` as empty.
  const PROBE_CLIENT_KEY = "ck-probe-synthetic-key";
  const clientCells: { body: unknown; create: WireOutcome; update: WireOutcome }[] = [
    { body: ABSENT, create: { reject: /client: missing required key "apiKey"/ }, update: { stored: CLIENT_KEY } },
    { body: null, create: { reject: /client: missing required key "apiKey"/ }, update: { reject: /client: apiKey cannot be cleared/ } },
    { body: "", create: { reject: /client: apiKey must be a non-empty string/ }, update: { reject: /client: apiKey cannot be cleared/ } },
    { body: "   ", create: { reject: /client: apiKey must not be whitespace-only/ }, update: { reject: /client: apiKey must not be whitespace-only/ } },
    { body: PROBE_CLIENT_KEY, create: { stored: PROBE_CLIENT_KEY }, update: { stored: PROBE_CLIENT_KEY } },
    { body: "[Configured]", create: { reject: /client: apiKey must not be the literal/ }, update: { reject: /client: apiKey must not be the literal/ } },
  ];

  for (const operation of ["create", "update"] as const) {
    for (const cell of clientCells) {
      const outcome = cell[operation];
      const verdict =
        "reject" in outcome ? `refused: ${outcome.reject.source}` : "stored" in outcome ? `stored ${JSON.stringify(outcome.stored)}` : "cleared";
      test(`wire grammar — client ${operation}, apiKey = ${describeWireValue(cell.body)} → ${verdict}`, () => {
        const f = makeStore();
        const base = operation === "create" ? { name: "probe", models: ["smart"] } : { models: ["smart"] };
        const body: Record<string, unknown> = { ...base };
        if (cell.body === ABSENT) delete body.apiKey;
        else body.apiKey = cell.body;
        const targetName = operation === "create" ? "probe" : "local-dev";
        const before = fileJson(f.path);
        const storedBefore = operation === "create" ? undefined : f.store.findClient("local-dev");

        const result = operation === "create" ? f.store.addClient(body) : f.store.updateClient("local-dev", body);

        if ("reject" in outcome) {
          expect(result.ok).toBe(false);
          const lines = problems(result);
          expect(lines.join("\n")).toMatch(outcome.reject);
          expectNoLeak(lines, [CLIENT_KEY, PROBE_CLIENT_KEY]);
          expect(fileJson(f.path)).toEqual(before);
          expect(f.store.findClient(targetName)).toEqual(storedBefore);
          expect(tempFiles(f.dir)).toEqual([]);
          return;
        }

        ok(result);
        if ("cleared" in outcome) throw new Error("a client apiKey is never cleared — the table has no such cell");
        const entry = f.store.findClient(targetName);
        expect(entry?.apiKey).toBe(outcome.stored);
        expect(entry?.name).toBe(targetName);
        expect(entry?.models).toEqual(["smart"]);
        const onDisk =
          (fileJson(f.path).clients as Record<string, unknown>[]).find((candidate) => candidate.name === targetName) ?? {};
        expect(onDisk.apiKey).toBe(outcome.stored);
        expectFileValidates(f.path);
        expect(tempFiles(f.dir)).toEqual([]);
      });
    }
  }

  test("remove refuses the last client entry and unknown names", () => {
    const f = makeStore({
      clients: [rawClient(), rawClient({ name: "kiosk", apiKey: "ck-kiosk-synthetic", models: ["smart"] })],
    });

    ok(f.store.removeClient("kiosk"));
    expect(f.store.clients?.length).toBe(1);
    expect(problems(f.store.removeClient("local-dev")).join("\n")).toContain("cannot remove the last client entry");
    expect(problems(f.store.removeClient("ghost")).join("\n")).toContain('no client with name "ghost"');
    expectFileValidates(f.path);
  });
});

// ---------------------------------------------------------------------------
// the atomic write-back
// ---------------------------------------------------------------------------

describe("ConfigStore — persist write-back", () => {
  test("the write replaces the config file via rename: the file's inode changes and no temp file remains", () => {
    const f = makeStore();
    const beforeIno = statSync(f.path).ino;

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "third",
        baseUrl: "https://third.example.com/v1",
        apiKey: "sk-third-synthetic",
      }),
    );

    expect(statSync(f.path).ino).not.toBe(beforeIno);
    expect(tempFiles(f.dir)).toEqual([]);
    expectFileValidates(f.path);
  });

  test("the operator-owned sections are preserved verbatim, including unknown top-level keys", () => {
    const f = makeStore({
      logLevel: "debug",
      server: { listen: "127.0.0.1:9050", tls: { enabled: false } },
      auth: { enabled: true, user: "operator", passwordHash: SYNTHETIC_HASH },
    });
    const before = fileJson(f.path);
    // hand-edited content outside the store's ownership, added while running
    rewriteFile(f.path, { ...before, operatorNote: "hand-added while running" });

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "third",
        baseUrl: "https://third.example.com/v1",
        apiKey: "sk-third-synthetic",
      }),
    );

    const after = fileJson(f.path);
    expect(after.server).toEqual(before.server);
    expect(after.auth).toEqual(before.auth);
    expect(after.logLevel).toBe("debug");
    expect(after.operatorNote).toBe("hand-added while running");
    expect(after.upstreams as unknown[]).toHaveLength(3);
    // the hand-added unknown key keeps the file outside the startup schema —
    // preserving it verbatim is the store's contract; the next startup
    // reports it, exactly as it would report any hand-edit mistake.
  });

  test("hand edits to the managed sections are overwritten by the next runtime mutation", () => {
    const f = makeStore({ models: undefined, clients: undefined });
    // a hand-added models block while the store holds none
    rewriteFile(f.path, { ...fileJson(f.path), models: [rawModel({ alias: "hand-added" })] });

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "third",
        baseUrl: "https://third.example.com/v1",
        apiKey: "sk-third-synthetic",
      }),
    );

    expect("models" in fileJson(f.path)).toBe(false);
    expect(f.store.models).toBeUndefined();
    expectFileValidates(f.path);
  });

  test.skipIf(RUNNING_AS_ROOT)(
    "a failed write leaves file and memory untouched, with no temp file left behind",
    () => {
      const f = makeStore();
      const before = fileJson(f.path);

      chmodSync(f.dir, 0o500);
      try {
        const lines = problems(
          f.store.addUpstream({
            type: "openai-compatible",
            id: "third",
            baseUrl: "https://third.example.com/v1",
            apiKey: "sk-third-synthetic",
          }),
        );
        expect(lines.join("\n")).toContain("could not be written");
        expect(lines.join("\n")).not.toContain("sk-third-synthetic");
      } finally {
        chmodSync(f.dir, 0o700);
      }

      expect(f.store.upstreams.length).toBe(2);
      expect(fileJson(f.path)).toEqual(before);
      expect(tempFiles(f.dir)).toEqual([]);
    },
  );

  test("a missing config file, corrupt JSON and a non-object root produce value-free problems", () => {
    const f = makeStore();

    unlinkSync(f.path);
    expect(problems(f.store.addUpstream(rawUpstream("third"))).join("\n")).toContain("could not be read");

    writeFileSync(f.path, "this is not json {{{", "utf8");
    const parseLines = problems(f.store.addUpstream(rawUpstream("third")));
    expect(parseLines.join("\n")).toContain("is not valid JSON");
    // value-free: the file's content never reaches the problem line
    expect(parseLines.join("\n")).not.toContain("this is not json");

    rewriteFile(f.path, []);
    expect(problems(f.store.addUpstream(rawUpstream("third"))).join("\n")).toContain("does not hold a JSON object");

    expect(f.store.upstreams.length).toBe(2);
  });

  test("persist() refuses a corrupt file and re-syncs a stale-but-valid one", () => {
    const f = makeStore();

    // a file persist cannot parse is never overwritten — the store would lose
    // the operator's sections it cannot read
    writeFileSync(f.path, "corrupted by a partial hand edit", "utf8");
    const lines = problems(f.store.persist());
    expect(lines.join("\n")).toContain("is not valid JSON");
    expect(readFileSync(f.path, "utf8")).toBe("corrupted by a partial hand edit");
    expect(f.store.upstreams.length).toBe(2);

    // a stale-but-valid file: persist re-syncs the store's state onto it
    rewriteFile(f.path, rawConfig({ upstreams: [rawUpstream("stale")] }));
    ok(f.store.persist());
    expectFileValidates(f.path);
    expect(fileJson(f.path).upstreams as unknown[]).toHaveLength(2);
    expect(f.store.findUpstream("stale")).toBeUndefined();
    expect(tempFiles(f.dir)).toEqual([]);
  });

  test("every written file passes the startup validator across a sequence of mutations", () => {
    const f = makeStore({ clients: undefined });

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "third",
        baseUrl: "https://third.example.com/v1",
        apiKey: "sk-third-synthetic",
      }),
    );
    expectFileValidates(f.path);
    ok(f.store.addModel(rawModel({ alias: "fast", routes: [{ upstream: "third", model: "gpt-4o-mini", weight: 1 }] })));
    expectFileValidates(f.path);
    ok(f.store.addClient({ name: "kiosk", apiKey: "ck-kiosk-synthetic", models: ["fast"] }));
    expectFileValidates(f.path);
    ok(f.store.addClient({ name: "backup", apiKey: "ck-backup-synthetic", models: ["fast"] }));
    expectFileValidates(f.path);
    ok(
      f.store.updateUpstream("third", {
        type: "openai-compatible",
        baseUrl: "https://third.example.com/v2",
        apiKey: "sk-third-rotated-synthetic",
      }),
    );
    expectFileValidates(f.path);
    ok(
      f.store.updateModel("fast", {
        routes: [{ upstream: "third", model: "gpt-4o-mini", weight: 4 }],
        balance: { strategy: "weighted-round-robin" },
        limits: { context: 8192 },
      }),
    );
    expectFileValidates(f.path);
    ok(f.store.updateClient("kiosk", { models: ["smart"], apiKey: "ck-kiosk-rotated-synthetic" }));
    expectFileValidates(f.path);
    ok(f.store.removeClient("backup"));
    expectFileValidates(f.path);
    ok(f.store.removeModel("fast"));
    expectFileValidates(f.path);

    expect(f.store.clients?.length).toBe(1);
    expect(f.store.models?.length).toBe(1);
    expect(fileJson(f.path).upstreams as unknown[]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// snapshot immutability and lookups
// ---------------------------------------------------------------------------

describe("ConfigStore — snapshot and lookups", () => {
  test("the config and every nested collection are deep-frozen, after construction and after mutations", () => {
    const f = makeStore();
    expect(Object.isFrozen(f.store.config)).toBe(true);
    expect(Object.isFrozen(f.store.upstreams)).toBe(true);
    expect(Object.isFrozen(f.store.upstreams[0])).toBe(true);
    expect(Object.isFrozen(f.store.models)).toBe(true);
    expect(Object.isFrozen(f.store.models?.[0])).toBe(true);
    expect(Object.isFrozen(f.store.models?.[0]?.routes)).toBe(true);
    expect(Object.isFrozen(f.store.clients)).toBe(true);
    expect(Object.isFrozen(f.store.clients?.[0]?.models)).toBe(true);

    ok(
      f.store.addUpstream({
        type: "openai-compatible",
        id: "third",
        baseUrl: "https://third.example.com/v1",
        apiKey: "sk-third-synthetic",
      }),
    );
    expect(Object.isFrozen(f.store.config)).toBe(true);
    expect(Object.isFrozen(f.store.upstreams)).toBe(true);
    expect(Object.isFrozen(f.store.findUpstream("third"))).toBe(true);
  });

  test("input objects are copied into the store — later caller-side mutation changes nothing", () => {
    const f = makeStore();
    const input = {
      type: "openai-compatible",
      id: "third",
      baseUrl: "https://third.example.com/v1",
      apiKey: "sk-third-synthetic",
    };
    ok(f.store.addUpstream(input));

    input.baseUrl = "https://mutated.example.com/v1";
    (input as Record<string, unknown>).apiKey = "rotated-later";

    expect(f.store.findUpstream("third")?.baseUrl).toBe("https://third.example.com/v1");
    expect(f.store.findUpstream("third")?.apiKey).toBe("sk-third-synthetic");
  });

  test("findUpstream / findModel / findClient resolve by id, alias and name", () => {
    const f = makeStore();
    expect(f.store.findUpstream("openai")?.id).toBe("openai");
    expect(f.store.findUpstream("ghost")).toBeUndefined();
    expect(f.store.findModel("smart")?.alias).toBe("smart");
    expect(f.store.findModel("ghost")).toBeUndefined();
    expect(f.store.findClient("local-dev")?.name).toBe("local-dev");
    expect(f.store.findClient("ghost")).toBeUndefined();
  });
});
