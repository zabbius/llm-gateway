/**
 * Dispatch handlers for `POST /llm/v1/chat/completions` and `POST
 * /llm/v1/completions` (specs/domains/routing.md): parse the OpenAI request,
 * resolve the model-id prefix against the registry, rewrite `body.model` to
 * the upstream model — the single body transformation routing makes (D3) —
 * and relay the upstream's response unchanged (status, headers, body,
 * including SSE streams).
 *
 * Gateway-side failures are answered before any upstream contact:
 * unparseable JSON or a missing/empty `model` → 400 `invalid_request_error`
 * (no code); a model id that does not resolve (no "/", empty half, unknown
 * upstream prefix) → 404 `model_not_found`. An unknown *model* under a known
 * upstream is forwarded — model existence is the upstream's verdict.
 *
 * Header policy at this boundary (specs/contracts/client-gateway.md): the
 * client's `Authorization` is dropped at the edge and hop-by-hop headers are
 * never relayed; everything else is handed to the upstream best-effort, and
 * the upstream enforces the outbound whitelist and attaches its own
 * credentials.
 */
import type pino from "pino";
import type { Context, Handler } from "hono";
import type { UpstreamRegistry } from "../../upstreams/registry.ts";
import type { ProxyRequest } from "../../upstreams/upstream.ts";
import type { CompletionRequestBody } from "../../types.ts";
import { resolveModel, type GatewayEnv } from "../../gateway/router.ts";
import { badRequestResponse, modelNotFoundResponse } from "../errors.ts";

/** Upstream paths relative to baseUrl (specs/domains/routing.md endpoint map). */
const CHAT_COMPLETIONS_PATH = "chat/completions";
const COMPLETIONS_PATH = "completions";

/**
 * Client headers never handed to an upstream: the client credential (dropped
 * at the gateway edge — the upstream authenticates with its own config
 * apiKey) and hop-by-hop headers (RFC 9110 §7.6.1). The upstream additionally
 * whitelists what it actually forwards upstream.
 */
const DROPPED_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
];

/** Best-effort relay headers for the upstream (drop-list above applied). */
function relayedRequestHeaders(headers: Headers): Record<string, string> {
  const relayed: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (!DROPPED_REQUEST_HEADERS.includes(name.toLowerCase())) {
      relayed[name] = value;
    }
  }
  return relayed;
}

export function handleChatCompletions(
  registry: UpstreamRegistry,
  logger: pino.Logger,
): Handler<GatewayEnv> {
  return dispatch(registry, logger, CHAT_COMPLETIONS_PATH);
}

export function handleCompletions(
  registry: UpstreamRegistry,
  logger: pino.Logger,
): Handler<GatewayEnv> {
  return dispatch(registry, logger, COMPLETIONS_PATH);
}

/**
 * The shared resolution path — both endpoints differ only in the forwarded
 * upstream `path` (specs/domains/routing.md invariants).
 */
function dispatch(
  registry: UpstreamRegistry,
  parentLogger: pino.Logger,
  upstreamPath: string,
): Handler<GatewayEnv> {
  const log = parentLogger.child({ component: "router" });

  return async (c: Context<GatewayEnv>) => {
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return badRequestResponse("We could not parse the JSON body of your request.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return badRequestResponse("The request body must be a JSON object.");
    }

    const body = parsed as CompletionRequestBody;
    if (typeof body.model !== "string" || body.model.length === 0) {
      return badRequestResponse("you must provide a model parameter");
    }

    const resolution = resolveModel(body.model, registry);
    if (resolution === null) {
      // Never any upstream contact for unresolved prefixes
      // (specs/domains/routing.md invariants).
      return modelNotFoundResponse(body.model);
    }

    c.set("upstreamId", resolution.upstream.id);
    log.debug(
      { upstreamId: resolution.upstream.id, upstreamModel: resolution.upstreamModel, upstreamPath },
      "upstream resolved — forwarding",
    );

    // The only transformation: strip the prefix from body.model (D3); every
    // other field is forwarded as received.
    body.model = resolution.upstreamModel;

    const request: ProxyRequest = {
      path: upstreamPath,
      method: "POST",
      body: new Response(JSON.stringify(body)).body ?? undefined,
      headers: relayedRequestHeaders(c.req.raw.headers),
    };
    // The upstream never rejects — it answers with a relayed upstream
    // response or a synthesized 502/504 envelope
    // (specs/domains/upstreams/upstream-contract.md). The response crosses to
    // the client unchanged; anything uncaught is the app error middleware's
    // concern (the single error-mapping place).
    return resolution.upstream.forward(request);
  };
}
