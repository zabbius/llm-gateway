/**
 * The client management CRUD surface (ADR-014, decisions D1/D2/D7) — the
 * management boundary's write half for the `clients` collection:
 *
 *   GET    /api/clients        — every configured client, masked
 *   POST   /api/clients        — create (validate → persist → digest swap)
 *   GET    /api/clients/:name  — one configured client, masked
 *   PUT    /api/clients/:name  — update (same sequence; the name is
 *                                immutable, an absent `apiKey` keeps the
 *                                stored credential — D7)
 *   DELETE /api/clients/:name  — delete (no `409 resource_in_use` class:
 *                                nothing in the configuration references a
 *                                client; the reverse direction — a model
 *                                alias a client's ACL names — is guarded on
 *                                the models surface's own delete)
 *
 * The mutation sequence is the store's own validate → persist → apply
 * (src/config/store.ts — the config file stays the single source of truth,
 * D1) followed by the runtime half this module owns (D2): the client-key
 * digest registry inside the LLM gate (src/httpapi/client-auth.ts) is
 * rebuilt from the store's current entries, so the next `/llm/v1` request
 * already sees it — a new key admits immediately, a changed ACL cuts
 * immediately, a removed key answers the `401 invalid_api_key` envelope, all
 * without a restart. An empty registry stays fail-closed: the store keeps at
 * least one entry in a present clients block, and before the first client
 * exists the mounted empty gate answers every request 401 — the surface
 * never opens.
 *
 * Responses never carry credential material: entries are served through the
 * config store's redacted view (`ConfigStore.view` — the mask literal is the
 * config domain's constant) and problem lines are value-free by the store's
 * own contract; a presented or created apiKey never enters a log line, an
 * error message, or a response body.
 *
 * Auth: plain routes under `/api/*` — behind the ADR-007 session gate
 * whenever `auth.enabled`, with no exemption of their own.
 */
import type { Handler } from "hono";
import type pino from "pino";
import type { ConfigStore } from "../../config/store.ts";
import type { RedactedClientConfig } from "../../config/redact.ts";
import type { GatewayEnv } from "../../gateway/router.ts";
import type { ClientAuthGate } from "../client-auth.ts";
import { readJsonBody, BodyLimitError } from "../body.ts";
import { badRequestResponse, notFoundResponse, payloadTooLargeResponse } from "../errors.ts";

/** Dependencies of the client CRUD mounts — injected by app.ts. */
export interface ClientManagementDeps {
  /** The runtime configuration store — validate → persist → apply owner. */
  store: ConfigStore;
  /**
   * The LLM gate's mutable digest registry — receives the hot-apply write
   * after every successful mutation. The same gate instance the app mounted,
   * so the registry can never diverge from the served middleware.
   */
  gate: ClientAuthGate;
  /** The root logger; mounts log under their own children. */
  logger: pino.Logger;
  /** The request-body cap (`server.maxRequestBodyBytes`). */
  maxBodyBytes: number;
}

/**
 * The runtime half of one client create/update/delete (ADR-014 D2) — the
 * step after the store's validate → persist → in-memory apply succeeded:
 * rebuild the gate's digest registry from the store's current clients. The
 * rebuild is atomic (one array swap inside the gate) and synchronous — no
 * request can observe a half-applied registry.
 */
function applyClientRuntime(deps: ClientManagementDeps, action: "created" | "updated" | "removed", name: string): void {
  deps.gate.replaceClients(deps.store.clients ?? []);
  deps.logger.child({ component: "http" }).info(
    { client: name },
    `client ${action} — LLM gate digest registry rebuilt within the running gateway`,
  );
}

/** The masked entry of one configured client, or undefined — the store's
 * current view is the only answer source (masks are the config domain's rule). */
function maskedEntry(store: ConfigStore, name: string): RedactedClientConfig | undefined {
  return store.view.clients?.find((entry) => entry.name === name);
}

/** Parse the JSON request body under the configured cap: the parsed value,
 * or a ready envelope response (413 / 400) the handler returns directly. */
async function parseBody(
  request: Request,
  maxBodyBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await readJsonBody(request, maxBodyBytes) };
  } catch (error) {
    if (error instanceof BodyLimitError) return { ok: false, response: payloadTooLargeResponse() };
    return { ok: false, response: badRequestResponse("We could not parse the JSON body of your request.") };
  }
}

/** `GET /api/clients` — every configured client through the store's
 * redacted view, in config order; `[]` while no clients block exists. Pure
 * read: no file read, no key material (the view is the store's snapshot). */
export function handleListClients(deps: ClientManagementDeps): Handler<GatewayEnv> {
  return async () =>
    new Response(JSON.stringify({ clients: deps.store.view.clients ?? [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** `GET /api/clients/:name` — one configured client, masked. An unknown name
 * is the 404 envelope, answered before anything else. */
export function handleGetClient(deps: ClientManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const name = c.req.param("name") ?? "";
    const entry = maskedEntry(deps.store, name);
    if (entry === undefined) {
      return notFoundResponse(`Client '${name}' is not configured`);
    }
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `POST /api/clients` — create: the store's validate → persist → apply
 * (creating the `clients` block when absent — a present block keeps at least
 * one entry from here on), then the digest-registry hot-apply. Answers the
 * masked entry; the new key admits `/llm/v1` on the next request. A
 * validation problem (bad grammar, duplicate name, the `[Configured]` mask
 * literal as a key — D7, an empty or unknown-alias `models[]`) is the 400
 * envelope with the store's value-free problem lines.
 */
export function handleCreateClient(deps: ClientManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const parsed = await parseBody(c.req.raw, deps.maxBodyBytes);
    if (!parsed.ok) return parsed.response;

    const name = typeof (parsed.body as { name?: unknown } | null)?.name === "string" ? (parsed.body as { name: string }).name : "";
    const result = deps.store.addClient(parsed.body);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    applyClientRuntime(deps, "created", name);
    const masked = maskedEntry(deps.store, name);
    if (masked === undefined) {
      throw new Error(`client "${name}" missing from the redacted view after a successful create — wiring bug`);
    }
    return new Response(JSON.stringify({ client: masked }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `PUT /api/clients/:name` — update: an unknown name is the 404 envelope
 * before any validation; then the create sequence with the store's update
 * rules (`models` replaced wholesale, an absent `apiKey` keeps the stored
 * credential — D7; the name itself is immutable). The digest registry is
 * rebuilt from the store's current state, so an ACL change cuts on the very
 * next request and a replaced key invalidates the old one — no restart.
 */
export function handleUpdateClient(deps: ClientManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const name = c.req.param("name") ?? "";
    if (deps.store.findClient(name) === undefined) {
      return notFoundResponse(`Client '${name}' is not configured`);
    }

    const parsed = await parseBody(c.req.raw, deps.maxBodyBytes);
    if (!parsed.ok) return parsed.response;

    const result = deps.store.updateClient(name, parsed.body);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    applyClientRuntime(deps, "updated", name);
    const masked = maskedEntry(deps.store, name);
    if (masked === undefined) {
      throw new Error(`client "${name}" missing from the redacted view after a successful update — wiring bug`);
    }
    return new Response(JSON.stringify({ client: masked }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `DELETE /api/clients/:name` — delete: an unknown name is the 404 envelope.
 * No `409 resource_in_use` class exists here — no configuration entry
 * references a client (the reverse direction, a model alias a client's ACL
 * names, is the models surface's own delete guard). The store's one refusal
 * is the last-entry rule (a present clients block keeps at least one entry —
 * validation-shaped, the 400 envelope). On success the deleted key answers
 * `401 invalid_api_key` from the next request on.
 */
export function handleDeleteClient(deps: ClientManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const name = c.req.param("name") ?? "";
    if (deps.store.findClient(name) === undefined) {
      return notFoundResponse(`Client '${name}' is not configured`);
    }

    const result = deps.store.removeClient(name);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    applyClientRuntime(deps, "removed", name);
    return new Response(JSON.stringify({ deleted: name }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** All five client CRUD mounts, wired to one deps object — the app mounts
 * them as a single management-CRUD block (ADR-014 D2). */
export function clientManagementHandlers(deps: ClientManagementDeps): {
  list: Handler<GatewayEnv>;
  get: Handler<GatewayEnv>;
  create: Handler<GatewayEnv>;
  update: Handler<GatewayEnv>;
  remove: Handler<GatewayEnv>;
} {
  return {
    list: handleListClients(deps),
    get: handleGetClient(deps),
    create: handleCreateClient(deps),
    update: handleUpdateClient(deps),
    remove: handleDeleteClient(deps),
  };
}
