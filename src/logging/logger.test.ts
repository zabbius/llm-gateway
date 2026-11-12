/**
 * Tests for the process-wide logger (specs/domains/observability.md).
 *
 * pino's destination binds to fd 2 directly, so the tests spawn short-lived
 * `bun` child processes that emit log lines and assert on the raw stderr /
 * stdout streams — the only way to observe real fd routing, level gating and
 * redaction end to end.
 */
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, PINO_LEVEL, REDACT_CENSOR } from "./logger.ts";

const LOGGER_PATH = join(import.meta.dir, "logger.ts");

interface FixtureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a logging scenario in a child process; returns its captured streams. */
async function runFixture(body: string): Promise<FixtureResult> {
  const dir = await mkdtemp(join(tmpdir(), "llm-gateway-logger-"));
  const script = join(dir, "fixture.ts");
  const source = [
    `import { createLogger } from ${JSON.stringify(LOGGER_PATH)};`,
    body,
    "await Bun.sleep(100);", // let the async stderr sink drain before exit
    "",
  ].join("\n");
  try {
    await writeFile(script, source);
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

test("PINO_LEVEL maps the gateway vocabulary onto pino spellings", () => {
  expect(PINO_LEVEL.trace).toBe("trace");
  expect(PINO_LEVEL.debug).toBe("debug");
  expect(PINO_LEVEL.info).toBe("info");
  expect(PINO_LEVEL.warning).toBe("warn");
  expect(PINO_LEVEL.error).toBe("error");
  expect(PINO_LEVEL.none).toBe("silent");
});

test("createLogger('warning') gates debug and info, passes warn as a JSON line to stderr", async () => {
  const result = await runFixture(
    [
      `const log = createLogger("warning");`,
      `log.debug({ path: "/v1/models" }, "hidden debug");`,
      `log.info("hidden info");`,
      `log.warn("visible warning");`,
    ].join("\n"),
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(""); // stdout stays empty for the whole process lifetime
  const parsed = jsonLines(result.stderr);
  expect(parsed).toHaveLength(1); // debug and info are suppressed
  expect(parsed[0]?.msg).toBe("visible warning");
  expect(parsed[0]?.level).toBe(40); // pino's "warn"
});

test("createLogger('none') suppresses every line", async () => {
  const result = await runFixture(
    [
      `const log = createLogger("none");`,
      `log.trace("t");`,
      `log.debug("d");`,
      `log.info("i");`,
      `log.warn("w");`,
      `log.error("e");`,
      `log.child({ component: "http" }).info("child");`,
    ].join("\n"),
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(jsonLines(result.stderr)).toHaveLength(0);
});

test("sensitive fields are redacted at trace level, including nested header objects", async () => {
  const result = await runFixture(
    [
      `const log = createLogger("trace");`,
      `log.trace({`,
      `  authorization: "Bearer sk-top-secret",`,
      `  "x-api-key": "xkey-top-secret",`,
      `  "api-key": "akey-top-secret",`,
      `  cookie: "ck-top-secret",`,
      `  token: "tk-top-secret",`,
      `  model: "openai-main/gpt-4o",`,
      `  headers: { authorization: "sk-nest-secret", cookie: "ck-nest-secret", accept: "kept-accept" },`,
      `  req: { headers: { "x-api-key": "xkey-req-secret" } },`,
      `}, "redaction probe");`,
    ].join("\n"),
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  // no secret value reaches the log stream, in any form
  for (const secret of [
    "sk-top-secret",
    "xkey-top-secret",
    "akey-top-secret",
    "ck-top-secret",
    "tk-top-secret",
    "sk-nest-secret",
    "ck-nest-secret",
    "xkey-req-secret",
  ]) {
    expect(result.stderr).not.toContain(secret);
  }
  const parsed = jsonLines(result.stderr);
  expect(parsed).toHaveLength(1);
  const line = parsed[0] ?? {};
  expect(line.level).toBe(10); // pino's "trace" — redaction holds at the most verbose level
  expect(line.authorization).toBe(REDACT_CENSOR);
  expect(line["x-api-key"]).toBe(REDACT_CENSOR);
  expect(line["api-key"]).toBe(REDACT_CENSOR);
  expect(line.cookie).toBe(REDACT_CENSOR);
  expect(line.token).toBe(REDACT_CENSOR);
  const headers = line.headers as Record<string, unknown> | undefined;
  expect(headers?.authorization).toBe(REDACT_CENSOR);
  expect(headers?.cookie).toBe(REDACT_CENSOR);
  expect(headers?.accept).toBe("kept-accept"); // non-sensitive fields pass through
  const req = line.req as { headers?: Record<string, unknown> } | undefined;
  expect(req?.headers?.["x-api-key"]).toBe(REDACT_CENSOR);
  expect(line.model).toBe("openai-main/gpt-4o");
});

test("redaction applies at info level too — not only at trace", async () => {
  const result = await runFixture(
    [
      `const log = createLogger("info");`,
      `log.info({ token: "tok-info-secret", user: "kept-user" }, "probe");`,
    ].join("\n"),
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("tok-info-secret");
  const parsed = jsonLines(result.stderr);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.token).toBe(REDACT_CENSOR);
  expect(parsed[0]?.user).toBe("kept-user");
});

test("child loggers carry the component binding; every stderr line is one JSON object", async () => {
  const result = await runFixture(
    [
      `const log = createLogger("info");`,
      `log.info("listening");`,
      `log.child({ component: "http" }).warn({ status: 502 }, "upstream error");`,
    ].join("\n"),
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  const parsed = jsonLines(result.stderr); // throws unless each line is a single JSON object
  expect(parsed).toHaveLength(2);
  expect(parsed[0]?.msg).toBe("listening");
  expect(parsed[0]?.component).toBeUndefined();
  expect(parsed[1]?.component).toBe("http");
  expect(parsed[1]?.msg).toBe("upstream error");
});

// The root logger itself is exercised once in-process for API-shape sanity;
// it writes to fd 2 (bun test's stderr), which is expected and not asserted here.
test("createLogger returns a pino logger", () => {
  const log = createLogger("none");
  expect(typeof log.child).toBe("function");
});
