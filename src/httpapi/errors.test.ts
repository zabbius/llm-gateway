/**
 * Error envelope constructors (specs/contracts/client-gateway.md, Error
 * Propagation): one OpenAI shape, status↔type↔code per the contract table.
 */
import { describe, expect, test } from "bun:test";
import {
  badRequestResponse,
  clientAuthenticationRequiredResponse,
  invalidApiKeyResponse,
  modelForbiddenResponse,
  modelNotFoundResponse,
  notFoundResponse,
  payloadTooLargeResponse,
  serviceUnavailableResponse,
  upstreamErrorResponse,
  upstreamProxyErrorResponse,
  upstreamTimeoutResponse,
  upstreamTlsErrorResponse,
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

  test("modelForbiddenResponse — 403, invalid_request_error, param 'model', no code (ADR-009 per-client ACL)", async () => {
    const { status, contentType, body } = await envelopeOf(modelForbiddenResponse("secret-alias"));
    expect(status).toBe(403);
    expect(contentType).toContain("application/json");
    expect(body).toEqual({
      error: {
        message: "You are not allowed to use the model 'secret-alias'",
        type: "invalid_request_error",
        param: "model",
      },
    });
  });

  test("serviceUnavailableResponse — 503, api_error, code 'upstream_unavailable', message names the model", async () => {
    const { status, contentType, body } = await envelopeOf(serviceUnavailableResponse("solo-alias"));
    expect(status).toBe(503);
    expect(contentType).toContain("application/json");
    expect(body).toEqual({
      error: {
        message: "All routes for model 'solo-alias' are currently unavailable",
        type: "api_error",
        code: "upstream_unavailable",
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

  test("payloadTooLargeResponse — 413, invalid_request_error, code 'request_too_large'", async () => {
    const { status, contentType, body } = await envelopeOf(payloadTooLargeResponse());
    expect(status).toBe(413);
    expect(contentType).toContain("application/json");
    expect(body).toEqual({
      error: {
        message: "The request body exceeds the gateway's size limit.",
        type: "invalid_request_error",
        code: "request_too_large",
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

  test("clientAuthenticationRequiredResponse — 401, authentication_error, code 'authentication_required' (ADR-008 client gate)", async () => {
    const { status, body } = await envelopeOf(clientAuthenticationRequiredResponse());
    expect(status).toBe(401);
    expect(body).toEqual({
      error: {
        message: "Authentication required: provide your API key as 'Authorization: Bearer <apiKey>'",
        type: "authentication_error",
        code: "authentication_required",
      },
    });
  });

  test("invalidApiKeyResponse — 401, authentication_error, code 'invalid_api_key' (ADR-008 client gate)", async () => {
    const { status, body } = await envelopeOf(invalidApiKeyResponse());
    expect(status).toBe(401);
    expect(body).toEqual({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
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

  test("upstreamTlsErrorResponse — 502, api_error, code 'upstream_tls_error'", async () => {
    const { status, body } = await envelopeOf(upstreamTlsErrorResponse('upstream "lan" TLS certificate pin mismatch'));
    expect(status).toBe(502);
    expect(body).toEqual({
      error: {
        message: 'upstream "lan" TLS certificate pin mismatch',
        type: "api_error",
        code: "upstream_tls_error",
      },
    });
  });

  test("upstreamProxyErrorResponse — 502, api_error, code 'upstream_proxy_error' (ADR-017)", async () => {
    const { status, contentType, body } = await envelopeOf(
      upstreamProxyErrorResponse('upstream "openai" is unreachable through its configured proxy'),
    );
    expect(status).toBe(502);
    expect(contentType).toContain("application/json");
    expect(body).toEqual({
      error: {
        message: 'upstream "openai" is unreachable through its configured proxy',
        type: "api_error",
        code: "upstream_proxy_error",
      },
    });
  });
});
