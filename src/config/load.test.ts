/**
 * Tests for startup config loading (specs/domains/configuration.md).
 *
 * Every bullet of the spec's "Validation errors" section has a case, plus:
 * problem aggregation (all problems of one start are reported together, one
 * line each), the LLM_GATEWAY_CONFIG env path and its precedence, defaults,
 * and baseUrl trailing-slash normalization.
 *
 * Reporting through the real stderr stream, and the exit-1 contract of
 * `loadConfigOrExit`, are asserted with spawned `bun` child processes — pino
 * owns fd 2, so that is the only way to observe the actual stream. The
 * failure fixture deliberately ends with `process.exit(1)` and no sleep: the
 * bootstrap logger's destination is synchronous, and these tests fail if a
 * line is ever lost to the exit.
 */
import { afterAll, afterEach, beforeEach, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_TYPES,
  DEFAULT_LISTEN,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  normalizeBaseUrl,
} from "./schema.ts";
import {
  CONFIG_ENV_VAR,
  DEFAULT_CONFIG_PATH,
  describeJsonError,
  loadConfig,
  resolveConfigPath,
} from "./load.ts";

const LOAD_PATH = join(import.meta.dir, "load.ts");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
let fixtureSeq = 0;

/** Write a config file into the fixture dir and return its path. */
function configFixture(body: string): string {
  const path = join(FIXTURE_DIR, `config-${++fixtureSeq}.json`);
  writeFileSync(path, body, "utf8");
  return path;
}

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

const VALID_ADAPTER = {
  type: "openai-compatible",
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-valid-secret",
};

/** A config file body that is valid except for the given top-level overrides. */
function validConfig(adapters: unknown[] = [VALID_ADAPTER], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...overrides, adapters });
}

/** A capturing problem logger: records every error line loadConfig emits. */
function capture(): { lines: string[]; error(message: string): void } {
  const lines: string[] = [];
  return { lines, error: (message) => lines.push(message) };
}

/** Build one adapter entry with one field removed or replaced. */
function adapterWith(field: keyof typeof VALID_ADAPTER, value: unknown): Record<string, unknown> {
  const adapter: Record<string, unknown> = { ...VALID_ADAPTER };
  if (value === undefined) {
    delete adapter[field];
  } else {
    adapter[field] = value;
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// env hygiene — LLM_GATEWAY_CONFIG is process-global
// ---------------------------------------------------------------------------

const ENV_KEY = CONFIG_ENV_VAR;
let savedEnvValue: string | undefined;

beforeEach(() => {
  savedEnvValue = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnvValue;
  }
});

// ---------------------------------------------------------------------------
// file location
// ---------------------------------------------------------------------------

test("a missing explicit file is an error naming the path that was tried", () => {
  const path = join(FIXTURE_DIR, "does-not-exist.json");
  const log = capture();
  const result = loadConfig({ path, log });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.path).toBe(path);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain(path);
  // every problem is logged, and the log lines are exactly the returned problems
  expect(log.lines).toEqual(result.problems);
});

test("without env and without explicit path, ./config.json is tried", () => {
  const log = capture();
  const result = loadConfig({ log }); // no config.json exists in the repo root

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.path).toBe(DEFAULT_CONFIG_PATH);
  expect(result.problems[0]).toContain("./config.json");
  expect(log.lines).toEqual(result.problems);
});

test("LLM_GATEWAY_CONFIG is the only path tried — missing file names the env path", () => {
  const envPath = join(FIXTURE_DIR, "env-missing.json");
  process.env[ENV_KEY] = envPath;

  const log = capture();
  const result = loadConfig({ log });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.path).toBe(envPath);
  expect(result.problems[0]).toContain(envPath);
});

test("LLM_GATEWAY_CONFIG is honored for an existing file", () => {
  const path = configFixture(validConfig([{ ...VALID_ADAPTER, id: "from-env" }]));
  process.env[ENV_KEY] = path;

  const result = loadConfig({});

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.path).toBe(path);
  expect(result.config.adapters[0]?.id).toBe("from-env");
});

test("an explicit path option beats the env var", () => {
  process.env[ENV_KEY] = join(FIXTURE_DIR, "env-missing.json");
  const path = configFixture(validConfig());

  const result = loadConfig({ path });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.path).toBe(path);
});

test("resolveConfigPath: env value, empty env value, and unset env", () => {
  expect(resolveConfigPath({ [ENV_KEY]: "/opt/gw/config.json" })).toBe("/opt/gw/config.json");
  expect(resolveConfigPath({ [ENV_KEY]: "" })).toBe(DEFAULT_CONFIG_PATH);
  expect(resolveConfigPath({})).toBe(DEFAULT_CONFIG_PATH);
});

test("an unreadable file is an error naming the path and the reason", () => {
  const path = configFixture(validConfig());
  chmodSync(path, 0o000);
  try {
    const log = capture();
    const result = loadConfig({ path, log });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(path);
    expect(result.problems[0]).toContain("could not be read");
    expect(log.lines).toEqual(result.problems);
  } finally {
    chmodSync(path, 0o644);
  }
});

// ---------------------------------------------------------------------------
// JSON parse errors
// ---------------------------------------------------------------------------

test("a JSON parse error is reported with the path and the parser's message", () => {
  const path = configFixture('{"adapters": [');
  const log = capture();
  const result = loadConfig({ path, log });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain(`invalid JSON in ${path}`);
  // Bun's parse errors carry no position — the line names the message alone
  expect(result.problems[0]).toContain("JSON Parse error");
  expect(log.lines).toEqual(result.problems);
});

test("describeJsonError names line and column when the engine message has a position", () => {
  // "aa\nbbb\n{" — offset 8 is the "{" on line 3, second character
  const text = 'aa\nbbb\n{"a": 1,}';
  const error = new SyntaxError("Unexpected token } in JSON at position 8");
  expect(describeJsonError("/x/config.json", text, error)).toBe(
    "invalid JSON in /x/config.json at line 3, column 2: Unexpected token } in JSON at position 8",
  );
});

test("describeJsonError understands direct line/column messages and positionless ones", () => {
  const text = "{}";
  expect(
    describeJsonError("/x/config.json", text, new Error("Parse error on line 2, column 7: junk")),
  ).toBe("invalid JSON in /x/config.json at line 2, column 7: Parse error on line 2, column 7: junk");
  expect(describeJsonError("/x/config.json", text, new Error("JSON Parse error: Unexpected EOF"))).toBe(
    "invalid JSON in /x/config.json: JSON Parse error: Unexpected EOF",
  );
});

// ---------------------------------------------------------------------------
// schema shape and unknown keys
// ---------------------------------------------------------------------------

test("a non-object config root (array, string, null, number) is rejected", () => {
  for (const body of ["[]", '"nope"', "null", "42"]) {
    const log = capture();
    const result = loadConfig({ path: configFixture(body), log });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(["config root must be a JSON object"]);
    expect(log.lines).toEqual(result.problems);
  }
});

test("an unknown top-level key is rejected and valid keys are named", () => {
  const log = capture();
  const result = loadConfig({
    path: configFixture(validConfig([VALID_ADAPTER], { listern: "typo" })),
    log,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual([
    'unknown top-level key "listern" (valid keys: listen, logLevel, adapters)',
  ]);
  expect(log.lines).toEqual(result.problems);
});

test("an unknown per-adapter key is rejected and valid keys are named", () => {
  const result = loadConfig({
    path: configFixture(validConfig([{ ...VALID_ADAPTER, id: "other", retry: 5 }])),
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual([
    'adapters[0]: unknown key "retry" (valid keys: type, id, baseUrl, apiKey)',
  ]);
});

// ---------------------------------------------------------------------------
// listen
// ---------------------------------------------------------------------------

test("malformed listen values are rejected with the host:port rule", () => {
  for (const listen of [
    "localhost",
    "127.0.0.1",
    "127.0.0.1:abc",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:1234567",
    ":8080",
    "-host:8080",
    "host:-1",
    "[::1",
  ]) {
    const result = loadConfig({
      path: configFixture(validConfig([VALID_ADAPTER], { listen })),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      `listen must be a "host:port" string with a port in 1-65535 (got "${listen}")`,
    ]);
  }
});

test("valid listen forms are accepted and kept in the normalized config", () => {
  for (const listen of ["127.0.0.1:8080", "localhost:80", "0.0.0.0:65535", "my-host.example:9443", "[::1]:8080"]) {
    const result = loadConfig({
      path: configFixture(validConfig([VALID_ADAPTER], { listen })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.listen).toBe(listen);
  }
});

// ---------------------------------------------------------------------------
// logLevel
// ---------------------------------------------------------------------------

test("an invalid logLevel is rejected with all six valid values listed", () => {
  for (const logLevel of ["loud", "warn", "VERBOSE", "", 42, null]) {
    const result = loadConfig({
      path: configFixture(validConfig([VALID_ADAPTER], { logLevel })),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("logLevel must be one of:");
    for (const level of LOG_LEVELS) {
      expect(result.problems[0]).toContain(level);
    }
  }
});

test("valid logLevel spellings pass through; omitted defaults to info", () => {
  for (const logLevel of LOG_LEVELS) {
    const result = loadConfig({
      path: configFixture(validConfig([VALID_ADAPTER], { logLevel })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.logLevel).toBe(logLevel);
  }

  const defaulted = loadConfig({ path: configFixture(validConfig()) });
  expect(defaulted.ok).toBe(true);
  if (!defaulted.ok) return;
  expect(defaulted.config.logLevel).toBe(DEFAULT_LOG_LEVEL);
  expect(defaulted.config.logLevel).toBe("info");
});

// ---------------------------------------------------------------------------
// adapters array
// ---------------------------------------------------------------------------

test("adapters missing, not an array, or empty is rejected", () => {
  for (const body of ["{}", '{"adapters": "nope"}', '{"adapters": []}', '{"adapters": {}}']) {
    const result = loadConfig({ path: configFixture(body) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(["adapters must be an array with at least one adapter entry"]);
  }
});

// ---------------------------------------------------------------------------
// adapter type
// ---------------------------------------------------------------------------

test("a missing adapter type is rejected and registered types are listed", () => {
  const result = loadConfig({
    path: configFixture(validConfig([{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" }])),
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual([
    `adapters[0]: missing required key "type" (registered adapter types: ${ADAPTER_TYPES.join(", ")})`,
  ]);
});

test("an unknown adapter type is rejected and registered types are listed", () => {
  const result = loadConfig({
    path: configFixture(validConfig([{ ...VALID_ADAPTER, type: "azure-openai" }])),
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual([
    `adapters[0]: unknown adapter type "azure-openai" (registered adapter types: ${ADAPTER_TYPES.join(", ")})`,
  ]);
});

// ---------------------------------------------------------------------------
// adapter id
// ---------------------------------------------------------------------------

test("a missing or malformed id is rejected with the grammar", () => {
  for (const id of [undefined, "OpenAI", "my_id", "a/b", "-leading", "id.dot", "", 42, null]) {
    const result = loadConfig({ path: configFixture(validConfig([adapterWith("id", id)])) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("adapters[0]:");
    // a missing key names the key; a present-but-invalid value names the grammar
    if (id === undefined) {
      expect(result.problems[0]).toContain('missing required key "id"');
    } else {
      expect(result.problems[0]).toContain("^[a-z0-9][a-z0-9-]*$");
    }
  }
});

test("valid id spellings are accepted", () => {
  // "trailing-" is accepted because the spec grammar is exactly
  // ^[a-z0-9][a-z0-9-]*$ — the tail allows a trailing hyphen
  for (const id of ["a", "9to5", "openai2", "my-adapter", "llm-gw-2", "trailing-"]) {
    const result = loadConfig({
      path: configFixture(validConfig([{ ...VALID_ADAPTER, id }])),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.adapters[0]?.id).toBe(id);
  }
});

test("duplicate ids are named with their entries; unique ids are not flagged", () => {
  const adapters = [
    { ...VALID_ADAPTER, id: "openai" },
    { ...VALID_ADAPTER, id: "acme" },
    { ...VALID_ADAPTER, id: "openai" },
    { ...VALID_ADAPTER, id: "solo" },
    { ...VALID_ADAPTER, id: "openai" },
  ];
  const result = loadConfig({ path: configFixture(validConfig(adapters)) });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual(['duplicate adapter id "openai" (entries 0, 2, 4)']);
});

// ---------------------------------------------------------------------------
// baseUrl
// ---------------------------------------------------------------------------

test("a missing or non-absolute-http(s) baseUrl is rejected", () => {
  for (const baseUrl of [undefined, "api.openai.com/v1", "/v1", "//host/v1", "ftp://api.openai.com/v1", "", 42]) {
    const result = loadConfig({ path: configFixture(validConfig([adapterWith("baseUrl", baseUrl)])) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("adapters[0]:");
    if (baseUrl === undefined) {
      expect(result.problems[0]).toContain('missing required key "baseUrl"');
    } else {
      expect(result.problems[0]).toContain("absolute http(s) URL");
    }
  }
});

test("absolute http and https baseUrls are accepted, with or without /v1", () => {
  // /v1 is the documented convention for the API root (the adapter builds
  // upstream URLs from it); validation enforces the absolute-http(s) rule
  // enumerated in the spec's "Validation errors".
  for (const baseUrl of ["https://api.openai.com/v1", "http://localhost:11434/v1", "https://api.example.test"]) {
    const result = loadConfig({
      path: configFixture(validConfig([{ ...VALID_ADAPTER, baseUrl }])),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.adapters[0]?.baseUrl).toBe(baseUrl);
  }
});

// ---------------------------------------------------------------------------
// apiKey — the value itself must never reach a problem line
// ---------------------------------------------------------------------------

test("a missing, empty, or non-string apiKey is rejected without echoing the value", () => {
  for (const apiKey of [undefined, "", 42, null]) {
    const log = capture();
    const result = loadConfig({ path: configFixture(validConfig([adapterWith("apiKey", apiKey)])), log });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      apiKey === undefined
        ? 'adapters[0]: missing required key "apiKey"'
        : "adapters[0]: apiKey must be a non-empty string",
    ]);
    // the real key never appears anywhere in the reported output
    expect(result.problems.join("\n")).not.toContain(VALID_ADAPTER.apiKey);
    expect(log.lines.join("\n")).not.toContain(VALID_ADAPTER.apiKey);
  }
});

// ---------------------------------------------------------------------------
// aggregation — every problem of one start is reported
// ---------------------------------------------------------------------------

test("all problems of one config are collected, printed, and returned together", () => {
  const body = JSON.stringify({
    listern: "typo-key", // unknown top-level key
    logLevel: "loud", // invalid logLevel
    listen: "localhost", // malformed listen
    adapters: [
      // unknown key, unknown type, bad id, bad baseUrl, empty apiKey
      { type: "azure", id: "Bad_ID", baseUrl: "ftp://x/v1", apiKey: "", retry: true },
      // entry 1 is valid
      { type: "openai-compatible", id: "acme", baseUrl: "https://a.example/v1", apiKey: "k-one" },
      // duplicate id "acme" (with entry 1)
      { type: "openai-compatible", id: "acme", baseUrl: "https://b.example/v1/", apiKey: "k-two" },
      // entry 3 is valid (and its id is unique)
      { type: "openai-compatible", id: "solo", baseUrl: "https://c.example/v1", apiKey: "k-three" },
      // entry is not an object
      "not-an-object",
    ],
  });
  const log = capture();
  const result = loadConfig({ path: configFixture(body), log });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toHaveLength(10);

  const all = result.problems.join("\n");
  expect(all).toContain('unknown top-level key "listern"');
  expect(all).toContain('listen must be a "host:port" string');
  expect(all).toContain("logLevel must be one of: trace, debug, info, warning, error, none");
  expect(all).toContain('adapters[0]: unknown key "retry"');
  expect(all).toContain('adapters[0]: unknown adapter type "azure"');
  expect(all).toContain('adapter id "Bad_ID" must match ^[a-z0-9][a-z0-9-]*$');
  expect(all).toContain('adapters[0]: baseUrl "ftp://x/v1" must be an absolute http(s) URL');
  expect(all).toContain("adapters[0]: apiKey must be a non-empty string");
  expect(all).toContain('duplicate adapter id "acme" (entries 1, 2)');
  expect(all).toContain("adapters[4] must be a JSON object");

  // one log line per problem — and no secret material anywhere
  expect(log.lines).toEqual(result.problems);
  expect(all).not.toContain("k-one");
  expect(all).not.toContain("k-two");
  expect(all).not.toContain("k-three");
});

// ---------------------------------------------------------------------------
// defaults and normalization
// ---------------------------------------------------------------------------

test("omitted listen and logLevel get their documented defaults", () => {
  const result = loadConfig({ path: configFixture(validConfig()) });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.config.listen).toBe(DEFAULT_LISTEN);
  expect(result.config.listen).toBe("127.0.0.1:8080");
  expect(result.config.logLevel).toBe(DEFAULT_LOG_LEVEL);
  expect(result.config.logLevel).toBe("info");
  expect(result.config.adapters).toEqual([
    { type: "openai-compatible", id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-valid-secret" },
  ]);
});

test("a single trailing slash is stripped from baseUrl at load", () => {
  const result = loadConfig({
    path: configFixture(validConfig([
      { type: "openai-compatible", id: "slashed", baseUrl: "https://api.openai.com/v1/", apiKey: "k" },
      { type: "openai-compatible", id: "plain", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
    ])),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.config.adapters[0]?.baseUrl).toBe("https://api.openai.com/v1");
  expect(result.config.adapters[1]?.baseUrl).toBe("https://api.openai.com/v1");
});

test("normalizeBaseUrl strips exactly one trailing slash", () => {
  expect(normalizeBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
  expect(normalizeBaseUrl("https://api.openai.com/v1//")).toBe("https://api.openai.com/v1/");
  expect(normalizeBaseUrl("https://api.openai.com/")).toBe("https://api.openai.com");
  expect(normalizeBaseUrl("https://api.openai.com")).toBe("https://api.openai.com");
});

// ---------------------------------------------------------------------------
// real stderr / exit code, through spawned `bun` child processes
// ---------------------------------------------------------------------------

interface FixtureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a config-loading scenario in a child process; returns its streams. */
async function runFixture(body: string, configJson: string): Promise<FixtureResult> {
  const dir = await mkdtemp(join(tmpdir(), "llm-gateway-config-run-"));
  const script = join(dir, "fixture.ts");
  const configPath = join(dir, "config.json");
  const source = [`const configPath = ${JSON.stringify(configPath)};`, body, ""].join("\n");
  try {
    await writeFile(script, source);
    await writeFile(configPath, configJson);
    const proc = Bun.spawn(["bun", "run", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Parse stderr into one JSON object per line (throws if any line is not JSON). */
function jsonLines(stderr: string): Array<Record<string, unknown>> {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("loadConfigOrExit prints each problem as a component:'config' error line, then exits 1", async () => {
  const configJson = JSON.stringify({
    listern: "typo-key",
    logLevel: "loud",
    adapters: [VALID_ADAPTER],
  });

  // the same file loaded in-process: the lines the child must print
  const inProcess = loadConfig({ path: configFixture(configJson) });
  expect(inProcess.ok).toBe(false);
  const expectedProblems = inProcess.ok ? [] : inProcess.problems;

  // no Bun.sleep before exit — the bootstrap logger must flush synchronously
  const result = await runFixture(
    [
      `import { loadConfigOrExit } from ${JSON.stringify(LOAD_PATH)};`,
      `loadConfigOrExit({ path: configPath });`,
    ].join("\n"),
    configJson,
  );

  expect(result.code).toBe(1); // a failed validation exits with code 1
  expect(result.stdout).toBe(""); // stdout stays empty for the whole process lifetime

  const parsed = jsonLines(result.stderr);
  expect(parsed).toHaveLength(expectedProblems.length); // every problem, none lost
  expect(parsed.map((line) => line.msg)).toEqual(expectedProblems);
  for (const line of parsed) {
    expect(line.component).toBe("config");
    expect(line.level).toBe(50); // pino's "error"
  }
});

test("loadConfigOrExit returns the normalized config and prints nothing on success", async () => {
  const configJson = validConfig([
    { type: "openai-compatible", id: "openai", baseUrl: "https://api.openai.com/v1/", apiKey: "sk-valid-secret" },
  ]);

  const result = await runFixture(
    [
      `import { loadConfigOrExit } from ${JSON.stringify(LOAD_PATH)};`,
      `const config = loadConfigOrExit({ path: configPath });`,
      `console.log(JSON.stringify(config));`,
    ].join("\n"),
    configJson,
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe(""); // success is silent — problems are the only pre-config output
  const reported = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(reported).toEqual({
    listen: "127.0.0.1:8080",
    logLevel: "info",
    adapters: [
      { type: "openai-compatible", id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-valid-secret" },
    ],
  });
});
