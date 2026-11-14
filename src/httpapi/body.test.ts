/**
 * The capped JSON body reader (src/httpapi/body.ts): every parsed request
 * body is bounded — an over-cap body throws `BodyLimitError` before
 * `JSON.parse` ever sees it, via the declared `content-length` (fast path)
 * or the streaming byte count. Handlers map it to the 413 envelope
 * (specs/contracts/client-gateway.md).
 */
import { describe, expect, test } from "bun:test";
import { BodyLimitError, MAX_BODY_BYTES, readJsonBody } from "./body.ts";

describe("readJsonBody", () => {
  test("parses a body under the cap", async () => {
    const request = new Request("http://gateway/", {
      method: "POST",
      body: JSON.stringify({ model: "alpha/gpt-4o" }),
    });
    expect(await readJsonBody(request)).toEqual({ model: "alpha/gpt-4o" });
  });

  test("a declared content-length over the cap fails before reading", async () => {
    const request = new Request("http://gateway/", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: "{}",
    });
    await expect(readJsonBody(request)).rejects.toBeInstanceOf(BodyLimitError);
  });

  test("a streamed body over the cap throws without buffering the remainder", async () => {
    const request = new Request("http://gateway/", { method: "POST", body: "1234567890" });
    await expect(readJsonBody(request, 8)).rejects.toBeInstanceOf(BodyLimitError);
  });

  test("a streamed body exactly at the cap parses", async () => {
    const request = new Request("http://gateway/", { method: "POST", body: "12345678" });
    expect(await readJsonBody(request, 8)).toEqual(12345678);
  });
});
