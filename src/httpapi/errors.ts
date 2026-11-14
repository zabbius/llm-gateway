/**
 * The OpenAI error envelope — the single shape for every gateway-generated
 * failure (specs/contracts/client-gateway.md, Error Propagation):
 *
 *   { "error": { "message", "type", "param"?, "code"? } }
 *
 * Constructors live in exactly one module so the envelope shape can never
 * drift between call sites; the status↔type↔code mapping follows the
 * contract's table:
 *
 *   400  invalid_request_error  provider-style message, no code
 *   401  authentication_error    code "authentication_required" (ADR-008 gate)
 *   401  authentication_error    code "invalid_credentials" (ADR-008 login)
 *   404  invalid_request_error  param "model", code "model_not_found"
 *   404  invalid_request_error  unmatched route (no code) — envelope rule
 *   413  invalid_request_error  code "request_too_large" (body size cap)
 *   502  api_error              code "upstream_error"
 *   502  api_error              code "upstream_tls_error" (ADR-005)
 *   504  api_error              code "upstream_timeout"
 *
 * Upstream errors that are already OpenAI-shaped are NOT produced here —
 * they pass through byte-for-byte and are never wrapped
 * (specs/contracts/client-gateway.md rules; the openai-compatible upstream
 * synthesizes its own 502/504 per specs/contracts/gateway-upstream.md).
 */
import type { ErrorEnvelope } from "../types.ts";

/** Serialize one envelope as a JSON response with the given status. */
function envelopeResponse(status: number, envelope: ErrorEnvelope): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The model id does not resolve: no "/" separator, an empty half, or an
 * unknown upstream-id prefix. Sent before any upstream contact. Message
 * format matches the contract example ("The model 'X' does not exist").
 */
export function modelNotFoundResponse(model: string): Response {
  return envelopeResponse(404, {
    error: {
      message: `The model '${model}' does not exist`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  });
}

/** Malformed request: unparseable JSON body, body without a usable `model`. */
export function badRequestResponse(message: string): Response {
  return envelopeResponse(400, {
    error: { message, type: "invalid_request_error" },
  });
}

/**
 * The request body exceeds the gateway's hard size cap — answered before
 * any upstream contact, and still the envelope: clients parse it like any
 * other gateway-generated failure (specs/contracts/client-gateway.md).
 */
export function payloadTooLargeResponse(): Response {
  return envelopeResponse(413, {
    error: {
      message: "The request body exceeds the gateway's size limit.",
      type: "invalid_request_error",
      code: "request_too_large",
    },
  });
}

/**
 * Unauthenticated management request (ADR-008): `/api/*` without a valid
 * session while auth is enabled — the gate's answer before routing. Sent
 * with no `WWW-Authenticate` header: the SPA's login card is the only login
 * affordance, and the message names the fact, never the reason why.
 */
export function authenticationRequiredResponse(): Response {
  return envelopeResponse(401, {
    error: {
      message: "Authentication required: log in at POST /api/login",
      type: "authentication_error",
      code: "authentication_required",
    },
  });
}

/**
 * Failed login (ADR-008): wrong user or wrong password — the answer is
 * identical and delayed; it never reveals which credential half failed and
 * never echoes the presented password.
 */
export function invalidCredentialsResponse(): Response {
  return envelopeResponse(401, {
    error: {
      message: "Invalid credentials",
      type: "authentication_error",
      code: "invalid_credentials",
    },
  });
}

/** Unmatched route — 404 without the model-specific `param`/`code`. */
export function notFoundResponse(message: string): Response {
  return envelopeResponse(404, {
    error: { message, type: "invalid_request_error" },
  });
}

/**
 * Upstream answered a non-relayable error body. In the MVP the upstream
 * synthesizes this itself; the constructor serves the app's error mapping
 * (the single place exceptions become status codes) and keeps the full
 * contract table representable in one module.
 */
export function upstreamErrorResponse(message: string): Response {
  return envelopeResponse(502, {
    error: { message, type: "api_error", code: "upstream_error" },
  });
}

/** Upstream unreachable or timed out — same single-module rationale as 502. */
export function upstreamTimeoutResponse(message: string): Response {
  return envelopeResponse(504, {
    error: { message, type: "api_error", code: "upstream_timeout" },
  });
}

/**
 * Upstream TLS verification failed on a pinned upstream (ADR-005): the
 * served certificate's key does not match the configured `tlsFingerprint`.
 * The upstream synthesizes this itself on the pinned path; the constructor
 * keeps the full contract table representable in one module.
 */
export function upstreamTlsErrorResponse(message: string): Response {
  return envelopeResponse(502, {
    error: { message, type: "api_error", code: "upstream_tls_error" },
  });
}
