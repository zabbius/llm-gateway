#!/usr/bin/env bun
/**
 * Generate the operator credential for the gateway's management auth
 * (ADR-008): hash a password with argon2id and print the ready-to-paste
 * `auth` block for the config file.
 *
 *   bun tools/hash-password.ts --user admin --password 's3cret'
 *   cat prompt_answer | bun tools/hash-password.ts --user admin --stdin
 *   bun tools/hash-password.ts                 (interactive: login + hidden password)
 *
 *   → a JSON snippet on stdout:
 *       "auth": { "enabled": true, "user": "admin", "passwordHash": "$argon2id$…" }
 *
 * The hash is the exact string for the `auth.passwordHash` config field —
 * `Bun.password.verify` checks logins against it, and the startup validation
 * accepts the PHC format it produces (specs/domains/configuration.md). The
 * plain password is hashed and immediately discarded: it is never echoed
 * back, never printed, and never written anywhere but this hash.
 */
import { isValidPasswordHash } from "../src/config/schema.ts";

/** One round of argon2id (Bun's built-in — the runtime verifies against it). */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** The ready-to-paste config snippet body for one operator identity. */
export function configSnippet(user: string, hash: string): string {
  return JSON.stringify(
    {
      auth: {
        enabled: true,
        user,
        passwordHash: hash,
      },
    },
    null,
    2,
  )
    .slice(1, -1) // unwrap the outer braces — the snippet sits inside the config object
    .trim()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** The full explanation behind --help: what is generated, where it goes. */
function help(): never {
  console.log(`usage: bun tools/hash-password.ts [--user <login>] [--password <secret> | --stdin]

Prints the ready-to-paste "auth" block for the gateway config file —
a single operator identity with an argon2id password hash (ADR-008).

  --user <login>    operator login for auth.user (prompted when absent)
  --password <pw>   the password to hash (prompted — hidden input — when absent)
  --stdin           read the password from piped stdin instead of prompting
                    (echo -n 'pw' | bun tools/hash-password.ts --user admin --stdin)

The output looks like:

  "auth": {
    "enabled": true,
    "user": "admin",
    "passwordHash": "$argon2id$v=19$..."
  }

Paste it at the config's top level (beside "logLevel"), then restart the
gateway — the management surface (/ui + /api) now asks for this login at
the SPA's login card. The plain password never appears anywhere: not in
the snippet, not in logs, not in the config file.`);
  process.exit(0);
}

/** Bad invocation: one-line usage on stderr, non-zero exit. */
function usage(problem?: string): never {
  if (problem !== undefined) console.error(`tools/hash-password: ${problem}`);
  console.error("usage: bun tools/hash-password.ts [--user <login>] [--password <secret> | --stdin]  (--help for details)");
  process.exit(1);
}

/** Read a line without echo (TTY) or a piped line — for the password. */
function readHidden(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onChunk);
      stdin.removeListener("error", onError);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
        process.stdout.write("\n");
      }
    };
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onEnd(): void {
      // piped (non-TTY) input without a terminator still ends the value;
      // a TTY never fires "end", so interactive input keeps line semantics
      cleanup();
      resolve(value);
    }
    function onChunk(chunk: Buffer): void {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(130); // Ctrl-C: abandon silently
        if (char === "\u007F" || char === "\b") {
          value = value.slice(0, -1);
          if (stdin.isTTY) process.stdout.write("\b \b");
          continue;
        }
        value += char;
        if (stdin.isTTY) process.stdout.write("*");
      }
    }
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on("data", onChunk);
    if (!stdin.isTTY) stdin.once("end", onEnd);
    stdin.once("error", onError);
  });
}

/** Read one visible line (for the login prompt). */
function readVisible(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onChunk);
      stdin.removeListener("error", onError);
    };
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onEnd(): void {
      // piped input without a trailing newline still terminates the value
      cleanup();
      resolve(value);
    }
    function onChunk(chunk: Buffer): void {
      const text = value + chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(text.slice(0, newline).replace(/\r$/, ""));
        return;
      }
      value = text;
    }
    stdin.on("data", onChunk);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
  });
}

interface ParsedArgv {
  user?: string;
  password?: string;
  fromStdin: boolean;
}

/** Parse argv; unknown flags, both password sources, and empty values are errors. */
function parseArgv(argv: readonly string[]): ParsedArgv {
  const parsed: ParsedArgv = { fromStdin: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") help();
    if (arg === "--stdin") {
      parsed.fromStdin = true;
      continue;
    }
    const value = argv[i + 1];
    if (arg === "--user" || arg === "--password") {
      if (value === undefined || value === "") usage(`${arg} requires a value`);
      if (arg === "--user") parsed.user = value;
      else parsed.password = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) usage(`unknown option "${arg}"`);
    usage(`unexpected positional argument "${arg}"`);
  }
  if (parsed.fromStdin && parsed.password !== undefined) usage("--stdin and --password are mutually exclusive");
  return parsed;
}

/** Interactive prompts fill whatever the flags left out. */
async function resolveCredentials(parsed: ParsedArgv): Promise<{ user: string; password: string }> {
  let user = parsed.user;
  let password = parsed.password;
  if (user === undefined) user = (await readVisible("Login: ")).trim();
  if (user.length === 0) usage("the login must be a non-empty string");
  if (parsed.fromStdin) {
    password = (await readVisible("")) ?? "";
    if (!process.stdin.isTTY) process.stdout.write("\n");
  } else if (password === undefined) {
    password = await readHidden("Password (hidden input): ");
  }
  if (password.length === 0) usage("the password must be a non-empty string");
  return { user, password };
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const { user, password } = await resolveCredentials(parsed);

  const hash = await hashPassword(password);
  if (!isValidPasswordHash(hash)) {
    // Unreachable with the runtime's own argon2id output — kept fail-closed
    // in case a future Bun version changes the PHC shape.
    console.error("tools/hash-password: the runtime produced a hash the config schema would reject");
    process.exit(1);
  }

  console.log(`auth block for the gateway config (paste at the top level, beside "logLevel"):\n`);
  console.log(configSnippet(user, hash));
}

if (import.meta.main) {
  await main();
}
