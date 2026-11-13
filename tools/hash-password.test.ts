/**
 * The `tools/hash-password.ts` contract: the generated hash verifies against
 * the password it came from, carries the PHC format the config schema
 * accepts (specs/domains/configuration.md — ADR-008), and the printed
 * snippet parses into a validating `auth` block. The snippet never contains
 * the plain password.
 */
import { describe, expect, test } from "bun:test";
import { validateGatewayConfig, isValidPasswordHash } from "../src/config/schema.ts";
import { configSnippet, hashPassword } from "./hash-password.ts";

const USER = "admin";
const PASSWORD = "operator-password-31337";

describe("hashPassword", () => {
  test("produces an argon2id PHC hash the config schema accepts", async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(isValidPasswordHash(hash)).toBe(true);
  });

  test("verifies against the source password and rejects others", async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await Bun.password.verify(PASSWORD, hash)).toBe(true);
    expect(await Bun.password.verify("not-the-password", hash)).toBe(false);
  });

  test("two invocations salt independently — hashes differ, both verify", async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
    expect(await Bun.password.verify(PASSWORD, first)).toBe(true);
    expect(await Bun.password.verify(PASSWORD, second)).toBe(true);
  });
});

describe("configSnippet", () => {
  test("is the enabled auth block: user verbatim, hash verbatim, no password", () => {
    const snippet = configSnippet(USER, "$argon2id$v=19$m=65536,t=2,p=1$U0FMVA$SEFTSA==");

    expect(snippet).toContain('"enabled": true');
    expect(snippet).toContain(`"user": "${USER}"`);
    expect(snippet).toContain('"passwordHash": "$argon2id$');
    expect(snippet).not.toContain(PASSWORD);
    expect(snippet).not.toContain("s3cret");
  });

  test("the snippet parses into an auth block the config schema validates", () => {
    const hash = Bun.password.hashSync(PASSWORD, { algorithm: "argon2id" });
    const snippet = configSnippet(USER, hash);
    const auth = JSON.parse(`{${snippet}}`) as { auth: { enabled: boolean; user: string; passwordHash: string } };

    expect(auth.auth.enabled).toBe(true);
    expect(auth.auth.user).toBe(USER);
    expect(isValidPasswordHash(auth.auth.passwordHash)).toBe(true);

    const result = validateGatewayConfig({
      upstreams: [
        { type: "openai-compatible", id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      ],
      auth: auth.auth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.auth).toEqual({ enabled: true, user: USER, passwordHash: hash });
  });
});
