/**
 * The upstream management CRUD surface (ADR-014, decision D1–D8) — the
 * management boundary's write half for the `upstreams` collection:
 *
 *   GET    /api/upstreams               — every configured upstream, masked
 *   POST   /api/upstreams               — create (validate → persist → probe
 *                                         → register → metadata slice)
 *   GET    /api/upstreams/:id           — one configured upstream, masked
 *   PUT    /api/upstreams/:id           — update (same hot-apply sequence;
 *                                         the id is immutable — D6/D7)
 *   DELETE /api/upstreams/:id           — delete, refused with the `409`
 *                                         `resource_in_use` envelope while
 *                                         any `models[].routes[]` entry
 *                                         still names the upstream (D6)
 *
 * The mutation sequence is the store's own validate → persist → apply
 * (src/config/store.ts — the config file stays the single source of truth,
 * D1) followed by the runtime half this module owns (D2): construct through
 * the registry's retained factory map, probe within the startup probe
 * budget — a failed probe is data in the response, never a cancellation
 * (D8) — swap the instance into the registry, and seed/clear the upstream's
 * metadata slice. `applyUpstreamRuntime` is the reusable hot-apply helper
 * the sibling CRUD surfaces (models, clients) mirror.
 *
 * Responses never carry credential material: entries are served through the
 * config store's redacted view (`ConfigStore.view` — the mask literal is
 * the config domain's constant), probe outcomes carry log-safe facts only,
 * and problem lines are value-free by the store's own contract.
 *
 * Auth: plain routes under `/api/*` — behind the ADR-007 session gate
 * whenever `auth.enabled`, with no exemption of their own.
 */
import type { Handler } from "hono";
import type pino from "pino";
import type { ConfigStore } from "../../config/store.ts";
import type { RedactedUpstreamConfig } from "../../config/redact.ts";
import type { GatewayEnv } from "../../gateway/router.ts";
import type { MetadataStore } from "../../gateway/metastore.ts";
import type { UpstreamRegistry } from "../../upstreams/registry.ts";
import { RUNTIME_PROBE_BUDGET_MS } from "../../upstreams/registry.ts";
import { readJsonBody, BodyLimitError } from "../body.ts";
import { badRequestResponse, notFoundResponse, payloadTooLargeResponse, resourceInUseResponse } from "../errors.ts";

/** One upstream's probe outcome as the create/update answer reports it (D8):
 * `reason` exists only when `ok` is false — a log-safe failure fact, never
 * credential or config material. */
export interface UpstreamProbeReport {
  ok: boolean;
  reason?: string;
}

/** The create/update answer: the masked entry as it now reads in the store's
 * view, plus the blocking probe's outcome (data, not a gate). */
export interface UpstreamWriteResponse {
  upstream: RedactedUpstreamConfig;
  probe: UpstreamProbeReport;
}

/** Dependencies of the upstream CRUD mounts — injected by app.ts. */
export interface UpstreamManagementDeps {
  /** The runtime configuration store — validate → persist → apply owner. */
  store: ConfigStore;
  /** The upstream registry — receives the runtime add/replace/remove writes. */
  registry: UpstreamRegistry;
  /** The alias-metadata store — the slice follows the upstream's lifecycle. */
  metadata: MetadataStore;
  /** The root logger; mounts log under their own children. */
  logger: pino.Logger;
  /** The request-body cap (`server.maxRequestBodyBytes`). */
  maxBodyBytes: number;
  /** The probe budget; defaults to the registry's startup-probe budget. */
  probeBudgetMs?: number;
}

/** The hot-apply outcome: the current masked entry plus the probe report —
 * the exact wire shape of the create/update answer. */
type AppliedUpstream = { upstream: RedactedUpstreamConfig; probe: UpstreamProbeReport };

/**
 * The runtime half of one upstream create/update (ADR-014 D2/D8) — the
 * reusable hot-apply step after the store's validate → persist → in-memory
 * apply succeeded. It resolves the stored (normalized) entry, constructs and
 * probes a fresh upstream instance through the registry within the probe
 * budget — the probe is awaited (blocking) and its outcome is data, never a
 * gate: the mutation already landed on disk and in the store — then swaps
 * the instance into the registry and seeds/clears the metadata slice (an ok
 * probe that retained a catalog seeds it; anything else clears the slice —
 * the write replaced the instance the old snapshot described). Returns the
 * current masked entry from the store's view for the handler's answer.
 */
export async function applyUpstreamRuntime(
  deps: UpstreamManagementDeps,
  id: string,
  mode: "add" | "replace",
): Promise<AppliedUpstream> {
  const { store, registry, metadata } = deps;
  const entry = store.findUpstream(id);
  if (entry === undefined) {
    // Unreachable through the handlers (each pre-checks existence and the
    // store mutation just succeeded) — kept loud: a silent skip here would
    // strand disk and memory apart.
    throw new Error(`upstream "${id}" vanished from the config store mid-apply — wiring bug`);
  }
  const status =
    mode === "add"
      ? await registry.add(entry, deps.probeBudgetMs ?? RUNTIME_PROBE_BUDGET_MS)
      : await registry.replace(id, entry, deps.probeBudgetMs ?? RUNTIME_PROBE_BUDGET_MS);

  if (status.probe === "ok" && status.models !== undefined) {
    metadata.set(id, status.models);
  } else {
    metadata.clear(id);
  }

  const masked = store.view.upstreams.find((candidate) => candidate.id === id);
  if (masked === undefined) {
    throw new Error(`upstream "${id}" missing from the redacted view after a successful write — wiring bug`);
  }
  return {
    upstream: masked,
    probe: status.probe === "ok" ? { ok: true } : { ok: false, reason: status.reason },
  };
}

/** The masked entry of one configured upstream, or undefined — the store's
 * current view is the only answer source (masks are the config domain's rule). */
function maskedEntry(store: ConfigStore, id: string): RedactedUpstreamConfig | undefined {
  return store.view.upstreams.find((entry) => entry.id === id);
}

/** `GET /api/upstreams` — every configured upstream through the store's
 * redacted view, in config order. Pure read: no upstream contact, no file
 * read (the view is the store's in-memory snapshot). */
export function handleListUpstreams(deps: UpstreamManagementDeps): Handler<GatewayEnv> {
  return async () =>
    new Response(JSON.stringify({ upstreams: deps.store.view.upstreams }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** `GET /api/upstreams/:id` — one configured upstream, masked. An unknown id
 * is the 404 envelope, answered before anything else (an upstream id is not
 * a model id — no `model_not_found` shape). */
export function handleGetUpstream(deps: UpstreamManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const id = c.req.param("id") ?? "";
    const entry = maskedEntry(deps.store, id);
    if (entry === undefined) {
      return notFoundResponse(`Upstream '${id}' is not configured`);
    }
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `POST /api/upstreams` — create: the store's validate → persist → apply,
 * then the runtime hot-apply (probe within the budget, register, metadata
 * slice). Answers the masked entry plus the blocking probe outcome; a
 * failed probe is data in that answer, never a cancellation (D8). A
 * validation problem (bad grammar, duplicate id, the `[Configured]` mask
 * literal as a key — D7) is the 400 envelope with the store's value-free
 * problem lines.
 */
export function handleCreateUpstream(deps: UpstreamManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, deps.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyLimitError) return payloadTooLargeResponse();
      return badRequestResponse("We could not parse the JSON body of your request.");
    }

    const id = typeof (body as { id?: unknown } | null)?.id === "string" ? (body as { id: string }).id : "";
    const result = deps.store.addUpstream(body);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    const applied = await applyUpstreamRuntime(deps, id, "add");
    deps.logger.child({ component: "http" }).info(
      { upstreamId: applied.upstream.id, probe: applied.probe.ok ? "ok" : "failed" },
      "upstream created — registered within the running gateway",
    );
    return new Response(JSON.stringify(applied satisfies UpstreamWriteResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `PUT /api/upstreams/:id` — update: an unknown id is the 404 envelope
 * before any validation; then the create sequence with the store's update
 * rules (every field required except `apiKey` — absent keeps the stored
 * credential, D7; explicit `null` clears the pin; the id is immutable).
 * The fresh instance replaces the old one under the same id, so the next
 * `/llm/v1` selection resolves the new instance — hot-applied without a
 * restart (D2).
 */
export function handleUpdateUpstream(deps: UpstreamManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const id = c.req.param("id") ?? "";
    if (deps.store.findUpstream(id) === undefined) {
      return notFoundResponse(`Upstream '${id}' is not configured`);
    }

    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, deps.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyLimitError) return payloadTooLargeResponse();
      return badRequestResponse("We could not parse the JSON body of your request.");
    }

    const result = deps.store.updateUpstream(id, body);
    if (!result.ok) {
      return badRequestResponse(result.problems.join("; "));
    }

    const applied = await applyUpstreamRuntime(deps, id, "replace");
    deps.logger.child({ component: "http" }).info(
      { upstreamId: applied.upstream.id, probe: applied.probe.ok ? "ok" : "failed" },
      "upstream updated — replacement registered within the running gateway",
    );
    return new Response(JSON.stringify(applied satisfies UpstreamWriteResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * `DELETE /api/upstreams/:id` — delete: an unknown id is the 404 envelope;
 * a delete whose target any `models[].routes[]` entry still names is the
 * `409` `resource_in_use` envelope naming the referencing models (D6 —
 * referential integrity is the operator's to resolve, no cascades); a
 * delete of the last upstream is the store's 400 refusal. On success the
 * instance leaves the registry and the metadata slice is cleared (a deleted
 * upstream's metadata must not keep serving alias metadata).
 */
export function handleDeleteUpstream(deps: UpstreamManagementDeps): Handler<GatewayEnv> {
  return async (c) => {
    const id = c.req.param("id") ?? "";
    if (deps.store.findUpstream(id) === undefined) {
      return notFoundResponse(`Upstream '${id}' is not configured`);
    }

    // D6: the in-use check names the referencing entries exactly like the
    // store's own refusal lines do — the handler answers 409 without
    // attempting a mutation the store would refuse anyway.
    const referencing: string[] = [];
    for (const model of deps.store.models ?? []) {
      const routeIndexes: number[] = [];
      model.routes.forEach((route, index) => {
        if (route.upstream === id) routeIndexes.push(index);
      });
      if (routeIndexes.length > 0) {
        referencing.push(
          `upstream '${id}' is still referenced by model '${model.alias}' (route${routeIndexes.length > 1 ? "s" : ""} ${routeIndexes.join(", ")})`,
        );
      }
    }
    if (referencing.length > 0) {
      return resourceInUseResponse(referencing.join("; "));
    }

    const result = deps.store.removeUpstream(id);
    if (!result.ok) {
      // The store's remaining refusals (the last-upstream rule) are
      // validation-shaped, not conflict-shaped: the 400 envelope.
      return badRequestResponse(result.problems.join("; "));
    }

    if (!deps.registry.remove(id)) {
      // Defensive: the registry and the store are mutated by the same
      // handler — reaching this means they diverged (a wiring bug).
      throw new Error(`upstream "${id}" was in the config store but not in the registry — wiring bug`);
    }
    deps.metadata.clear(id);
    deps.logger.child({ component: "http" }).info(
      { upstreamId: id },
      "upstream deleted — removed from the running gateway",
    );
    return new Response(JSON.stringify({ deleted: id }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** All five upstream CRUD mounts, wired to one deps object — the app mounts
 * them as a single management-CRUD block (ADR-014 D2). */
export function upstreamManagementHandlers(deps: UpstreamManagementDeps): {
  list: Handler<GatewayEnv>;
  get: Handler<GatewayEnv>;
  create: Handler<GatewayEnv>;
  update: Handler<GatewayEnv>;
  remove: Handler<GatewayEnv>;
} {
  return {
    list: handleListUpstreams(deps),
    get: handleGetUpstream(deps),
    create: handleCreateUpstream(deps),
    update: handleUpdateUpstream(deps),
    remove: handleDeleteUpstream(deps),
  };
}
