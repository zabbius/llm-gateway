/**
 * `GET /v1/models` aggregation (specs/domains/routing.md): fan out
 * `listModels()` over every registered upstream, prefix each provider-native
 * id with its upstream id, rewrite `owned_by` to the upstream id, flatten in
 * config order, answer with the OpenAI list envelope
 * (`{ "object": "list", "data": [...] }`).
 *
 * Degrades gracefully: an upstream whose `listModels()` rejects contributes no
 * entries while the rest of the list still returns with status 200; the
 * failure is logged as a warning naming the upstream id
 * (specs/architecture/data-flow.md, Errors Along the Flow).
 */
import type pino from "pino";
import type { Handler } from "hono";
import type { UpstreamRegistry } from "../../upstreams/registry.ts";
import type { ModelEntry, ModelList } from "../../types.ts";
import type { GatewayEnv } from "../../gateway/router.ts";

export function handleModels(
  registry: UpstreamRegistry,
  logger: pino.Logger,
): Handler<GatewayEnv> {
  const log = logger.child({ component: "router" });

  return async () => {
    const upstreams = registry.all();
    const settled = await Promise.allSettled(upstreams.map((upstream) => upstream.listModels()));

    const data: ModelEntry[] = [];
    upstreams.forEach((upstream, index) => {
      const result = settled[index];
      if (result === undefined) {
        return;
      }
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        log.warn(
          { upstreamId: upstream.id, reason },
          "model list failed — upstream contributes no entries",
        );
        return;
      }
      for (const entry of result.value) {
        // Provider-native entry rides along; only `id` (prefixed) and
        // `owned_by` (upstream id) are rewritten — nothing else is touched
        // (specs/contracts/client-gateway.md, model list shape).
        data.push({ ...entry, id: `${upstream.id}/${entry.id}`, owned_by: upstream.id });
      }
    });

    log.debug({ count: data.length, upstreams: upstreams.length }, "models aggregated");

    const list: ModelList = { object: "list", data };
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
