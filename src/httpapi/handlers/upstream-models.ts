/**
 * `GET /api/upstreams/:id/models` — the management surface's
 * operator-triggered live upstream listing (ADR-011 as amended by ADR-016,
 * specs/contracts/gateway-management.md): it invokes `listModels()` on the
 * named upstream through the interface and answers `200` with the
 * provider-native catalog: `{ upstream, models, fetchedAt }`.
 *
 * `?discover=1` (ADR-016) folds the former standalone discover mount into
 * this listing: the fetched catalog swaps the upstream's alias-metadata
 * slice wholesale before the answer — an empty listing included ("provider
 * lists zero models" is a fact); a failed listing or an expired budget
 * leaves the last good snapshot serving (retain-last-good) and surfaces as
 * this endpoint's own `502` envelope. Without the parameter the endpoint
 * is a pure read — nothing mutates.
 *
 * This is one of the enumerated exceptions to the management reads'
 * in-memory rule (ADR-011): the sanctioned request-time upstream contacts
 * on `/api/*` are this listing and the CRUD create/update blocking probes
 * (ADR-014 D8) — every other read (`GET /api/status`, the CRUD lists)
 * and both auth actions stay strictly in-memory.
 * The budget is the startup probe budget: an operator refresh must not hang
 * for the forward budget a completions relay may legitimately take. Any
 * failure — a `listModels()` rejection or the budget expiring — is the `502`
 * `api_error` / `upstream_error` envelope from the single mapper; an unknown
 * id is the `404` envelope, answered before any upstream contact. No
 * response here carries credential material: the messages name the upstream
 * id and log-safe failure facts only, and the body carries the provider's
 * model entries (the upstream attaches its own credentials server-side; none
 * of them can reach this JSON).
 *
 * Auth: a plain `GET` under `/api/*` — behind the ADR-007 session gate
 * whenever `auth.enabled`, with no exemption of its own (the gate exempts
 * the two auth actions and nothing else).
 */
import type pino from "pino";
import type { Handler } from "hono";
import type { UpstreamRegistry } from "../../upstreams/registry.ts";
import type { GatewayEnv } from "../../gateway/router.ts";
import type { MetadataStore } from "../../gateway/metastore.ts";
import { notFoundResponse, upstreamErrorResponse } from "../errors.ts";

/**
 * The live-listing budget: the upstream domain's startup probe budget
 * (`CONNECT_PROBE_TIMEOUT_MS`, src/upstreams/openai-compatible.ts), restated
 * here because the HTTP layer names no concrete upstream module
 * (specs/architecture/layers.md invariant 2). `listModels()` itself carries
 * the longer forward budget internally; this race bounds the operator-facing
 * answer on top of it.
 */
export const UPSTREAM_MODELS_TIMEOUT_MS = 10_000;

export function handleUpstreamModels(
  registry: UpstreamRegistry,
  metadata: MetadataStore,
  logger: pino.Logger,
  timeoutMs: number = UPSTREAM_MODELS_TIMEOUT_MS,
): Handler<GatewayEnv> {
  const log = logger.child({ component: "http" });

  return async (c) => {
    // `?? ""`: Hono's conservative typing — a matched route always carries the
    // segment, and an empty id fails the exact lookup into the 404 path.
    const id = c.req.param("id") ?? "";
    const upstream = registry.find(id);
    if (upstream === undefined) {
      // Unknown id: answered before any upstream contact — the 404 envelope
      // (gateway-management.md Error Propagation), not the model-specific
      // `model_not_found` shape (this is an upstream id, not a model id).
      return notFoundResponse(`Upstream '${id}' is not configured`);
    }
    c.set("upstreamId", upstream.id);

    // `?discover=1` (ADR-016): the fetched catalog swaps the metadata slice
    // before the answer. Any other value — the pure ADR-011 read.
    const discover = c.req.query("discover") === "1";

    // The probe-budget race: the answer must arrive within the budget or the
    // operator gets the 502 envelope — the underlying listModels() fetch (its
    // own forward budget) is simply abandoned, not awaited.
    let timedOut = false;
    let disarmBudget: (() => void) | undefined;
    const budget = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("probe budget expired"));
      }, timeoutMs);
      timer.unref();
      disarmBudget = () => clearTimeout(timer);
    });

    try {
      const models = await Promise.race([upstream.listModels(), budget]);
      disarmBudget?.();

      if (discover) {
        // The wholesale swap — a successful listing replaces the slice
        // atomically (the store freezes its own copy), an empty listing
        // included ("provider lists zero models" is a fact, ADR-016).
        metadata.set(upstream.id, models);
        log.info(
          { upstreamId: upstream.id, count: models.length },
          "live listing with discover=1 — metadata slice swapped",
        );
      }

      log.debug({ upstreamId: upstream.id, count: models.length }, "live model list fetched");
      const body = JSON.stringify({ upstream: upstream.id, models, fetchedAt: new Date().toISOString() });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      disarmBudget?.();
      // A failed live listing is an expected outcome (a degraded upstream is
      // exactly what an operator probes for): logged at warn — never thrown
      // into the app's error middleware — and answered as the contract's 502
      // envelope (ADR-011). With `discover=1` the store is untouched here —
      // retain-last-good keeps the last good snapshot serving (ADR-016).
      // The reason is the upstream interface's log-safe
      // rejection fact (upstream-contract.md): no credential material.
      const reason = timedOut
        ? `no answer within the probe budget (${timeoutMs}ms)`
        : error instanceof Error
          ? error.message
          : String(error);
      log.warn(
        { upstreamId: upstream.id, timedOut, reason },
        "live model list failed — answering upstream_error envelope",
      );
      return upstreamErrorResponse(`upstream "${upstream.id}" model list failed: ${reason}`);
    }
  };
}
