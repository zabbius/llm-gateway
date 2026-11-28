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
 *   401  authentication_error    code "authentication_required" (ADR-007 gate)
 *   401  authentication_error    code "invalid_credentials" (ADR-007 login)
 *   401  authentication_error    code "authentication_required" (ADR-008 client gate, no Bearer)
 *   401  authentication_error    code "invalid_api_key" (ADR-008 client gate, wrong key)
 *   403  invalid_request_error  param "model", no code (alias not allowed for this client, ADR-009)
 *   404  invalid_request_error  param "model", code "model_not_found"
 *   404  invalid_request_error  unmatched route (no code) — envelope rule
 *   409  invalid_request_error  code "resource_in_use" (runtime CRUD delete of
 *                                   a referenced resource, ADR-014 D6)
 *   413  invalid_request_error  code "request_too_large" (body size cap)
 *   502  api_error              code "upstream_error"
 *   502  api_error              code "upstream_tls_error" (ADR-004)
 *   502  api_error              code "upstream_proxy_error" (ADR-017)
 *   503  api_error              code "upstream_unavailable" (no healthy route, load-balancing.md)
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
 * The model id does not resolve: the alias is not in the gateway's model
 * table (ADR-009). Sent before any upstream contact. Message format matches
 * the contract example ("The model 'X' does not exist").
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

/**
 * The alias is registered but the authenticated client is not allowed to
 * address it (ADR-009 per-client ACL): answered before any upstream contact,
 * after the 404 check — an unknown alias and a forbidden one are different
 * answers. The message names the model and the denial; it never reveals the
 * client's full alias list or any key material.
 */
export function modelForbiddenResponse(model: string): Response {
  return envelopeResponse(403, {
    error: {
      message: `You are not allowed to use the model '${model}'`,
      type: "invalid_request_error",
      param: "model",
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
 * Unauthenticated management request (ADR-007): `/api/*` without a valid
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
 * Failed login (ADR-007): wrong user or wrong password — the answer is
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

/**
 * LLM-surface request with no Bearer credential (ADR-008): `/llm/v1/*`
 * without an `Authorization` header, with a foreign scheme, or with an empty
 * credential while clients are configured — the client gate's answer before
 * routing and before any body read or upstream contact. Sent without
 * `WWW-Authenticate` (OpenAI-protocol clients configure the header
 * statically); the message names the header form, never any key value.
 */
export function clientAuthenticationRequiredResponse(): Response {
  return envelopeResponse(401, {
    error: {
      message: "Authentication required: provide your API key as 'Authorization: Bearer <apiKey>'",
      type: "authentication_error",
      code: "authentication_required",
    },
  });
}

/**
 * LLM-surface request with an unknown API key (ADR-008): a well-formed
 * `Bearer` credential that matches no configured client. Never echoes the
 * presented value or any configured key.
 */
export function invalidApiKeyResponse(): Response {
  return envelopeResponse(401, {
    error: {
      message: "Invalid API key",
      type: "authentication_error",
      code: "invalid_api_key",
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
 * A runtime CRUD delete whose target live configuration still references
 * (ADR-014 D6): an upstream named by a `models[].routes[]` entry, a model
 * named by a client's alias ACL, an alias itself. The gateway answers `409`
 * `invalid_request_error` with code `resource_in_use` and removes nothing —
 * referential integrity stays the operator's to resolve, in the order the
 * operator chooses. The message carries the store's problem lines, which
 * name the referencing entries (value-free — the store guarantees secrets
 * are never echoed) so the operator can act on them.
 */
export function resourceInUseResponse(message: string): Response {
  return envelopeResponse(409, {
    error: {
      message,
      type: "invalid_request_error",
      code: "resource_in_use",
    },
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
 * No healthy route left for the alias (specs/domains/load-balancing.md):
 * every route of the entry is circuit-open — answered by the dispatch
 * handler without any upstream contact, before a byte is forwarded. The
 * message names the alias (client-supplied vocabulary) and the condition;
 * never route, config, or credential material.
 */
export function serviceUnavailableResponse(model: string): Response {
  return envelopeResponse(503, {
    error: {
      message: `All routes for model '${model}' are currently unavailable`,
      type: "api_error",
      code: "upstream_unavailable",
    },
  });
}

/**
 * Upstream TLS verification failed on a pinned upstream (ADR-004): the
 * served certificate's key does not match the configured `tlsFingerprint`.
 * The upstream synthesizes this itself on the pinned path; the constructor
 * keeps the full contract table representable in one module.
 */
export function upstreamTlsErrorResponse(message: string): Response {
  return envelopeResponse(502, {
    error: { message, type: "api_error", code: "upstream_tls_error" },
  });
}

/**
 * The configured outbound proxy refused or failed the connection (ADR-017):
 * a refused CONNECT, a SOCKS dial that could not reach the upstream, or an
 * unusable proxy URL. The upstream synthesizes this itself on the proxied
 * paths; the constructor keeps the full contract table representable in one
 * module. The message names the fact only — never proxy credentials (the
 * config grammar forbids them in a proxy URL) and never the target's bytes.
 */
export function upstreamProxyErrorResponse(message: string): Response {
  return envelopeResponse(502, {
    error: { message, type: "api_error", code: "upstream_proxy_error" },
  });
}
