/**
 * The model-alias management CRUD surface (ADR-014; the `models` collection
 * of ADR-009):
 *
 *   GET    /api/models         — every configured alias entry, masked view
 *                                plus the aggregated `meta`
 *   POST   /api/models         — create (validate → persist → rebuild)
 *   GET    /api/models/:alias  — one configured alias entry
 *   PUT    /api/models/:alias  — update (same sequence; the alias is
 *                                immutable — the path parameter owns it)
 *   DELETE /api/models/:alias  — delete, refused with the `409`
 *                                `resource_in_use` envelope while any
 *                                `clients[].models` entry still names the
 *                                alias (D6), or while it is the block's
 *                                last entry (the store's 400 refusal)
 *
 * The resource is one `models[]` entry — an alias (ADR-009) with its
 * routes (upstream/model/weight), `balance.strategy` and optional manual
 * `limits` — served through the config store's redacted view (the models
 * block carries no credentials, but the view keeps every read on the one
 * masked shape) plus `meta`: the alias-metadata aggregate (contextWindow /
 * outputLimit minima, strict-AND capabilities — null where unknown, the
 * `GET /api/status` `meta[]` convention) folded from the metadata store's
 * *current* slice on every read, never an upstream contact.
 *
 * The mutation sequence mirrors the upstream CRUD's: the store owns
 * validate → persist → in-memory apply (the config file stays the single
 * source of truth, D1 — every grammar rule the task names is the store's:
 * route.upstream must name a configured upstream, the alias grammar and
 * uniqueness, strategy/weight consistency, limits rules, at least one
 * route, no duplicate upstream/model pair) and this module owns the
 * runtime half: rebuild the alias routing table over the freshly persisted
 * block. The rebuild constructs a brand-new `createRoutingTable` and
 * atomically swaps the rebuildable holder's reference — in-flight requests
 * complete against the build that dispatched them, and the very next
 * request resolves the new/changed/deleted alias (ADR-009 catalog and
 * dispatch alike, no restart).
 *
 * Responses never carry credential material: alias entries have none, and
 * problem lines are value-free by the store's contract.
 *
 * Auth: plain routes under `/api/*` — behind the ADR-007 session gate
 * whenever `auth.enabled`, with no exemption of their own.
 */
import type { Handler } from "hono";
import type pino from "pino";
import type { ConfigStore } from "../../config/store.ts";
import type { RedactedModelConfig } from "../../config/redact.ts";
import type { MetadataStore } from "../../gateway/metastore.ts";
import type { GatewayEnv, RebuildableRoutingTable } from "../../gateway/router.ts";
import { buildAliasMetadata, type AliasMetadata } from "../../gateway/aliasmeta.ts";
import type { ModelCapabilities } from "../../gateway/modelmetadata.ts";
import { readJsonBody, BodyLimitError } from "../body.ts";
import { badRequestResponse, notFoundResponse, payloadTooLargeResponse, resourceInUseResponse } from "../errors.ts";

/**
 * The alias-metadata aggregate on a management read — JSON `null` where
 * unknown (absent means unknown, never a fabricated zero/false), exactly
 * the `GET /api/status` `meta[]` row convention.
 */
export interface ModelAliasMeta {
  /** The aggregated context-window minimum, or null when unknown. */
  contextWindow: number | null;
  /** The aggregated output-limit minimum, or null when unknown. */
  outputLimit: number | null;
  /** The strict-AND capability flags, or null when not fully declared. */
  capabilities: ModelCapabilities | null;
}

/** One managed alias entry as every list/detail/create/update answer serves it. */
export interface ManagedModelAlias extends RedactedModelConfig {
  /** The metadata aggregate over the metadata store's current slice. */
  meta: ModelAliasMeta;
}

/** The `GET /api/models` answer — config order. */
export interface ModelAliasListResponse {
  models: ManagedModelAlias[];
}

/** The `DELETE /api/models/:alias` answer. */
export interface ModelAliasDeleteResponse {
  deleted: string;
}

/** Dependencies of the model-alias CRUD mounts — injected by app.ts. */
export interface ModelAliasManagementDeps {
  /** The runtime configuration store — validate → persist → apply owner. */
  store: ConfigStore;
  /**
   * The rebuildable alias routing table: every applied mutation ends in a
   * `rebuild()` over the store's freshly persisted models block, so the
   * `/llm/v1` surface sees the change on its next request.
   */
  routing: RebuildableRoutingTable;
  /** The alias-metadata store — the `meta` aggregate's current slice. */
  metadata: MetadataStore;
  /** The root logger; mounts log under their own children. */
  logger: pino.Logger;
  /** The request-body cap (`server.maxRequestBodyBytes`). */
  maxBodyBytes: number;
}

/**
 * One managed entry: the store's current redacted view of the alias plus
 * the metadata aggregate folded over the store's current models block and
 * the metadata store's current slice. Pure read — no upstream contact.
 */
function managedEntry(store: ConfigStore, metadata: MetadataStore, alias: string): ManagedModelAlias | undefined {
  const entry = store.view.models?.find((candidate) => candidate.alias === alias);
  if (entry === undefined) {
    return undefined;
  }
  return attachMeta(entry, buildAliasMetadata(store.config.models ?? [], metadata).get(alias));
}

/** Project the aggregated metadata onto the redacted entry, null where unknown. */
function attachMeta(entry: RedactedModelConfig, aggregate: AliasMetadata | undefined): ManagedModelAlias {
  return {
    ...entry,
    meta: {
      contextWindow: aggregate?.contextWindow ?? null,
      outputLimit: aggregate?.outputLimit ?? null,
      capabilities: aggregate?.capabilities ?? null,
    },
  };
}

/** Every managed list/detail entry, in config order, each with its `meta`. */
function managedEntries(store: ConfigStore, metadata: MetadataStore): ManagedModelAlias[] {
  const aliasMeta = buildAliasMetadata(store.config.models ?? [], metadata);
  return (store.view.models ?? []).map((entry) => attachMeta(entry, aliasMeta.get(entry.alias)));
}

/** The runtime half of every applied mutation: rebuild the alias table over the freshly persisted block. */
function rebuildRouting(deps: ModelAliasManagementDeps): void {
  deps.routing.rebuild(deps.store.config.models ?? []);
}

/** `GET /api/models` — every configured alias entry, config order, with `meta`. */
export function handleListModelAliases(deps: ModelAliasManagementDeps): Handler<GatewayEnv> {
  return async () =>
    new Response(JSON.stringify({ models: managedEntries(deps.store, deps.metadata) } satisfies ModelAliasListResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** `GET /api/models/:alias` — one configured alias entry, or the 404 envelope. */
export function handleGetModelAlias(deps: ModelAliasManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const alias = c.req.param("alias") ?? "";
    const entry = managedEntry(deps.store, deps.metadata, alias);
    if (entry === undefined) {
      return notFoundResponse(`Model alias '${alias}' is not configured`);
    }
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `POST /api/models` — create: the store's validate → persist → apply (the
 * full entry grammar: alias grammar and uniqueness, every route's upstream
 * must name a configured upstream, at least one route, no duplicate
 * upstream/model pair, strategy/weight consistency, limits rules), then the
 * routing-table rebuild. Answers the created entry with its `meta`.
 */
export function handleCreateModelAlias(deps: ModelAliasManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, deps.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyLimitError) return payloadTooLargeResponse();
      return badRequestResponse("We could not parse the JSON body of your request.");
    }

    const result = deps.store.addModel(body);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    const alias =
      typeof (body as { alias?: unknown } | null)?.alias === "string" ? (body as { alias: string }).alias : "";
    rebuildRouting(deps);
    const entry = managedEntry(deps.store, deps.metadata, alias);
    if (entry === undefined) {
      // Unreachable through the handler (the store mutation just succeeded)
      // — kept loud: a silent bare answer would hide a wiring bug.
      throw new Error(`model alias "${alias}" missing from the redacted view after a successful write — wiring bug`);
    }
    deps.logger.child({ component: "http" }).info(
      { alias, routes: entry.routes.length },
      "model alias created — routing table rebuilt within the running gateway",
    );
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `PUT /api/models/:alias` — update: an unknown alias is the 404 envelope
 * before any validation; then the create sequence with the store's update
 * rules — `routes`, `balance` and `limits` are replaced wholesale, the
 * alias itself is immutable (the path parameter owns it; a differing
 * `alias` in the body is a 400). The rebuilt table serves the changed
 * entry on the very next `/llm/v1` request.
 */
export function handleUpdateModelAlias(deps: ModelAliasManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const alias = c.req.param("alias") ?? "";
    if (deps.store.findModel(alias) === undefined) {
      return notFoundResponse(`Model alias '${alias}' is not configured`);
    }

    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, deps.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyLimitError) return payloadTooLargeResponse();
      return badRequestResponse("We could not parse the JSON body of your request.");
    }

    const result = deps.store.updateModel(alias, body);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    rebuildRouting(deps);
    const entry = managedEntry(deps.store, deps.metadata, alias);
    if (entry === undefined) {
      throw new Error(`model alias "${alias}" missing from the redacted view after a successful write — wiring bug`);
    }
    deps.logger.child({ component: "http" }).info(
      { alias, routes: entry.routes.length },
      "model alias updated — routing table rebuilt within the running gateway",
    );
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `DELETE /api/models/:alias` — delete: an unknown alias is the 404
 * envelope; a delete whose alias any `clients[].models` entry still names
 * is the `409` `resource_in_use` envelope naming the referencing clients
 * (D6 — referential integrity is the operator's to resolve, no cascades);
 * the block's last entry is the store's 400 refusal. On success the alias
 * leaves the routing table on the rebuild — the next `/llm/v1` request
 * answers `404 model_not_found` for it.
 */
export function handleDeleteModelAlias(deps: ModelAliasManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const alias = c.req.param("alias") ?? "";
    if (deps.store.findModel(alias) === undefined) {
      return notFoundResponse(`Model alias '${alias}' is not configured`);
    }

    // D6: the in-use check names the referencing clients exactly like the
    // store's own refusal lines do — the handler answers 409 without
    // attempting a mutation the store would refuse anyway.
    const referencing = (deps.store.clients ?? [])
      .filter((client) => client.models.includes(alias))
      .map((client) => `model '${alias}' is still referenced by client '${client.name}'`);
    if (referencing.length > 0) {
      return resourceInUseResponse(referencing.join("; "));
    }

    const result = deps.store.removeModel(alias);
    if (!result.ok) {
      // The store's remaining refusal (the last-entry rule) is
      // validation-shaped, not conflict-shaped: the 400 envelope.
      return badRequestResponse(result.problems.join("; "));
    }

    rebuildRouting(deps);
    deps.logger.child({ component: "http" }).info(
      { alias },
      "model alias deleted — routing table rebuilt within the running gateway",
    );
    return new Response(JSON.stringify({ deleted: alias } satisfies ModelAliasDeleteResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** The mounted handler set, mirroring the upstream CRUD's shape. */
export interface ModelAliasHandlers {
  list: Handler<GatewayEnv>;
  create: Handler<GatewayEnv>;
  get: Handler<GatewayEnv>;
  update: Handler<GatewayEnv>;
  remove: Handler<GatewayEnv>;
}

/** Build the five handlers over one dependency bundle — app.ts mounts them as the models CRUD block. */
export function modelAliasManagementHandlers(deps: ModelAliasManagementDeps): ModelAliasHandlers {
  return {
    list: handleListModelAliases(deps),
    create: handleCreateModelAlias(deps),
    get: handleGetModelAlias(deps),
    update: handleUpdateModelAlias(deps),
    remove: handleDeleteModelAlias(deps),
  };
}
