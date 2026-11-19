/**
 * Dispatch handlers for `POST /llm/v1/chat/completions` and `POST
 * /llm/v1/completions` (specs/domains/routing.md, ADR-009,
 * specs/domains/load-balancing.md): parse the OpenAI request, resolve
 * `body.model` as a configured alias against the routing table, enforce the
 * per-client alias ACL, then forward through the balance- and health-selected
 * route, rewriting `body.model` to the selected route's provider-native model
 * — the single body transformation routing makes (D3, unchanged principle) —
 * and relay the upstream's response unchanged (status, headers, body,
 * including SSE streams).
 *
 * Gateway-side failures are answered before any upstream contact:
 * unparseable JSON or a missing/empty `model` → 400 `invalid_request_error`
 * (no code); a body over the size cap → 413 `request_too_large`
 * (src/httpapi/body.ts); an alias that is not configured → 404
 * `model_not_found`; a configured alias the authenticated client is not
 * allowed to address → 403 (`modelForbiddenResponse`); an alias whose every
 * route is currently unhealthy → 503 (`serviceUnavailableResponse`,
 * specs/domains/load-balancing.md). Whether the upstream knows the route's
 * model name is the upstream's verdict — the request is forwarded regardless.
 *
 * Failover (specs/domains/load-balancing.md): one upstream per attempt — a
 * pre-first-byte failure (the upstream's synthesized 502/504 envelopes, a
 * relayed 5xx or 429) marks the route's health and advances to the next
 * eligible route; when every eligible route was tried in this request, the
 * last upstream failure response is relayed unchanged (upstream bodies pass
 * through untouched). Once a response streams, there is no failover — the
 * relayed answer is final. A `forward()` rejection stays a contract violation
 * mapped by the app's error middleware (502 envelope).
 *
 * Session affinity (ADR-010): every attempt of a request carries the same
 * affinity key — `X-Session-Id` header, else the `user` body field — so a
 * keyed request lands on its bound route whenever that route is eligible; a
 * pre-first-byte failure there releases the binding and the request migrates
 * with failover, re-binding wherever it lands. Keyless requests are served by
 * the pure strategy choice.
 *
 * Header policy at this boundary (specs/contracts/client-gateway.md): the
 * client's `Authorization` is dropped at the edge and hop-by-hop headers are
 * never relayed; everything else is handed to the upstream best-effort, and
 * the upstream enforces the outbound whitelist and attaches its own
 * credentials.
 */
import type pino from "pino";
import type { Context, Handler } from "hono";
import type { ProxyRequest } from "../../upstreams/upstream.ts";
import type { CompletionRequestBody } from "../../types.ts";
import { type GatewayEnv, type RoutingTable, clientMayUse } from "../../gateway/router.ts";
import { isPreFirstByteFailure } from "../../gateway/balancer.ts";
import {
  badRequestResponse,
  modelForbiddenResponse,
  modelNotFoundResponse,
  payloadTooLargeResponse,
  serviceUnavailableResponse,
} from "../errors.ts";
import { BodyLimitError, readJsonBody } from "../body.ts";

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session-affinity key (ADR-010): the `X-Session-Id` request header when
 * present and non-empty, else the OpenAI `user` body field when a non-empty
 * string, else undefined — no key, no binding, and selection is the pure
 * balancer choice. Extracted once before the failover loop: every attempt of
 * one request carries the same key.
 */
export function affinityKeyFor(headers: Headers, body: CompletionRequestBody): string | undefined {
  const session = headers.get("x-session-id");
  if (session !== null && session.length > 0) return session;
  const user = body.user;
  if (typeof user === "string" && user.length > 0) return user;
  return undefined;
}

export function handleChatCompletions(
  table: RoutingTable,
  logger: pino.Logger,
  maxBodyBytes: number,
): Handler<GatewayEnv> {
  return dispatch(table, logger, CHAT_COMPLETIONS_PATH, maxBodyBytes);
}

export function handleCompletions(
  table: RoutingTable,
  logger: pino.Logger,
  maxBodyBytes: number,
): Handler<GatewayEnv> {
  return dispatch(table, logger, COMPLETIONS_PATH, maxBodyBytes);
}

/**
 * The shared resolution path — both endpoints differ only in the forwarded
 * upstream `path` (specs/domains/routing.md invariants); both read their
 * body under the same configured cap (`server.maxRequestBodyBytes`).
 */
function dispatch(
  table: RoutingTable,
  parentLogger: pino.Logger,
  upstreamPath: string,
  maxBodyBytes: number,
): Handler<GatewayEnv> {
  const log = parentLogger.child({ component: "router" });

  return async (c: Context<GatewayEnv>) => {
    let parsed: unknown;
    try {
      parsed = await readJsonBody(c.req.raw, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyLimitError) return payloadTooLargeResponse();
      return badRequestResponse("We could not parse the JSON body of your request.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return badRequestResponse("The request body must be a JSON object.");
    }

    const body = parsed as CompletionRequestBody;
    if (typeof body.model !== "string" || body.model.length === 0) {
      return badRequestResponse("you must provide a model parameter");
    }

    const alias = body.model;
    if (table.routes(alias) === null) {
      // Never any upstream contact for an unconfigured alias
      // (specs/domains/routing.md invariants).
      return modelNotFoundResponse(alias);
    }

    const client = c.get("client");
    if (!clientMayUse(client, alias)) {
      // Registered but not this client's (ADR-009 per-client ACL) — also
      // answered without any upstream contact.
      log.debug({ alias, client: client?.name }, "alias not allowed for the authenticated client — 403");
      return modelForbiddenResponse(alias);
    }

    // The failover loop (specs/domains/load-balancing.md): one upstream per
    // attempt, advancing through the eligible routes until one answers with
    // something that is not a pre-first-byte failure. `tried` carries the
    // route ids this request already failed on; the body stream is rebuilt
    // per attempt (a consumed ReadableStream cannot be forwarded twice).
    const headers = relayedRequestHeaders(c.req.raw.headers);
    const affinityKey = affinityKeyFor(c.req.raw.headers, body); // ADR-010: X-Session-Id, else user, else none
    const tried = new Set<string>();
    let lastFailure: Response | undefined;

    for (;;) {
      const selection = table.select(alias, tried, affinityKey);
      if (selection === null) {
        if (lastFailure !== undefined) {
          // Every eligible route failed within this request: the last
          // upstream failure is the answer — relayed unchanged, exactly as
          // the single-upstream mapping would have delivered it.
          log.debug(
            { alias, attempts: tried.size, upstreamId: c.get("upstreamId") },
            "every eligible route failed — relaying the last upstream failure",
          );
          return lastFailure;
        }
        // Nothing was eligible from the start: every route of the alias is
        // circuit-open (cooldown or half-open probe in flight) — answered
        // without any upstream contact.
        log.warn({ alias }, "no healthy route for the alias — answering 503 without upstream contact");
        return serviceUnavailableResponse(alias);
      }

      c.set("upstreamId", selection.upstream.id);
      log.debug(
        {
          alias,
          upstreamId: selection.upstream.id,
          upstreamModel: selection.upstreamModel,
          upstreamPath,
          attempt: tried.size + 1,
        },
        "alias resolved — forwarding",
      );

      // The only transformation: body.model becomes the selected route's
      // provider-native model (D3); every other field is forwarded as received.
      body.model = selection.upstreamModel;
      const request: ProxyRequest = {
        path: upstreamPath,
        method: "POST",
        body: new Response(JSON.stringify(body)).body ?? undefined,
        headers,
      };

      let response: Response;
      try {
        // The upstream never rejects — it answers with a relayed upstream
        // response or a synthesized 502/504 envelope
        // (specs/domains/upstreams/upstream-contract.md). A rejection is a
        // contract violation: mark the route failed, then let the app's
        // error middleware map it (the single error-mapping place).
        response = await selection.upstream.forward(request);
      } catch (error) {
        table.report(selection, false, affinityKey);
        log.warn(
          { alias, upstreamId: selection.upstream.id, reason: describe(error) },
          "upstream forward rejected — route marked failed",
        );
        throw error;
      }

      if (isPreFirstByteFailure(response)) {
        // Pre-first-byte failure: the route's health records it and the next
        // eligible route takes the attempt. The failed response is retained
        // as the relay candidate for failover exhaustion; the failure it
        // supersedes is discarded (its body cancelled — the client would
        // never have seen it).
        table.report(selection, false, affinityKey);
        tried.add(selection.routeId);
        if (lastFailure !== undefined) void lastFailure.body?.cancel();
        lastFailure = response;
        log.warn(
          {
            alias,
            upstreamId: selection.upstream.id,
            upstreamModel: selection.upstreamModel,
            status: response.status,
            attempt: tried.size,
          },
          "pre-first-byte upstream failure — failing over to the next route",
        );
        continue;
      }

      // A servable answer — relay unchanged; once this crosses to the client
      // (or streams) there is no failover (specs/domains/load-balancing.md).
      table.report(selection, true, affinityKey);
      if (lastFailure !== undefined) void lastFailure.body?.cancel();
      return response;
    }
  };
}
