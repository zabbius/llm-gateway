/**
 * Error envelope constructors (specs/contracts/client-gateway.md, Error
 * Propagation): one OpenAI shape, status↔type↔code per the contract table.
 */
import { describe, expect, test } from "bun:test";
import {
  badRequestResponse,
  modelNotFoundResponse,
  notFoundResponse,
  upstreamErrorResponse,
  upstreamTimeoutResponse,
} from "./errors.ts";

async function envelopeOf(response: Response): Promise<{ status: number; contentType: string; body: unknown }> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.json(),
  };
}

describe("error envelope constructors", () => {
  test("modelNotFoundResponse — 404, invalid_request_error, param 'model', code 'model_not_found'", async () => {
    const { status, contentType, body } = await envelopeOf(modelNotFoundResponse("nope/gpt-4o"));
    expect(status).toBe(404);
    expect(contentType).toContain("application/json");
    expect(body).toEqual({
      error: {
        message: "The model 'nope/gpt-4o' does not exist",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
  });

  test("badRequestResponse — 400, invalid_request_error, provider-style message, no code", async () => {
    const { status, body } = await envelopeOf(badRequestResponse("you must provide a model parameter"));
    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        message: "you must provide a model parameter",
        type: "invalid_request_error",
      },
    });
  });

  test("notFoundResponse — 404 unmatched route, no code, no param", async () => {
    const { status, body } = await envelopeOf(notFoundResponse("Route not found: GET /nope"));
    expect(status).toBe(404);
    expect(body).toEqual({
      error: { message: "Route not found: GET /nope", type: "invalid_request_error" },
    });
  });

  test("upstreamErrorResponse — 502, api_error, code 'upstream_error'", async () => {
    const { status, body } = await envelopeOf(upstreamErrorResponse("upstream answered badly"));
    expect(status).toBe(502);
    expect(body).toEqual({
      error: { message: "upstream answered badly", type: "api_error", code: "upstream_error" },
    });
  });

  test("upstreamTimeoutResponse — 504, api_error, code 'upstream_timeout'", async () => {
    const { status, body } = await envelopeOf(upstreamTimeoutResponse("upstream 'acme' is unreachable: timeout"));
    expect(status).toBe(504);
    expect(body).toEqual({
      error: { message: "upstream 'acme' is unreachable: timeout", type: "api_error", code: "upstream_timeout" },
    });
  });
});
