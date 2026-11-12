/**
 * `GET /v1/models` aggregation (specs/domains/routing.md): fan out
 * `listModels()` over every registered adapter, prefix each provider-native
 * id with its adapter id, rewrite `owned_by` to the adapter id, flatten in
 * config order, answer with the OpenAI list envelope
 * (`{ "object": "list", "data": [...] }`).
 *
 * Degrades gracefully: an adapter whose `listModels()` rejects contributes no
 * entries while the rest of the list still returns with status 200; the
 * failure is logged as a warning naming the adapter id
 * (specs/architecture/data-flow.md, Errors Along the Flow).
 */
import type pino from "pino";
import type { Handler } from "hono";
import type { AdapterRegistry } from "../../adapters/registry.ts";
import type { ModelEntry, ModelList } from "../../types.ts";
import type { GatewayEnv } from "../../gateway/router.ts";

export function handleModels(
  registry: AdapterRegistry,
  logger: pino.Logger,
): Handler<GatewayEnv> {
  const log = logger.child({ component: "router" });

  return async () => {
    const adapters = registry.all();
    const settled = await Promise.allSettled(adapters.map((adapter) => adapter.listModels()));

    const data: ModelEntry[] = [];
    adapters.forEach((adapter, index) => {
      const result = settled[index];
      if (result === undefined) {
        return;
      }
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        log.warn(
          { adapterId: adapter.id, reason },
          "model list failed — adapter contributes no entries",
        );
        return;
      }
      for (const entry of result.value) {
        // Provider-native entry rides along; only `id` (prefixed) and
        // `owned_by` (adapter id) are rewritten — nothing else is touched
        // (specs/contracts/client-gateway.md, model list shape).
        data.push({ ...entry, id: `${adapter.id}/${entry.id}`, owned_by: adapter.id });
      }
    });

    log.debug({ count: data.length, adapters: adapters.length }, "models aggregated");

    const list: ModelList = { object: "list", data };
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
