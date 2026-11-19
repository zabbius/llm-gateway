/**
 * `GET /llm/v1/models` (specs/domains/routing.md, ADR-009): the gateway's own
 * alias catalog, not an aggregation of upstream catalogs. Every configured
 * alias the authenticated client may address becomes one OpenAI entry —
 * `id` = the alias, `object` = "model", `created` = the process start epoch
 * (one fixed timestamp per process — aliases are config, their creation time
 * is boot time in the MVP), `owned_by` = "llm-gateway" (the catalog's owner
 * is the gateway, not any provider). Answered with the OpenAI list envelope
 * (`{ "object": "list", "data": [...] }`) entirely from the startup-built
 * routing table: no upstream is contacted, so the endpoint cannot degrade —
 * it either lists config or the config was empty.
 *
 * Alias metadata (specs/domains/routing.md "Alias metadata"): when a
 * metadata store is wired in, the handler folds its *current* slice into the
 * entries on every request — `buildAliasMetadata` over the config `models`
 * block (manual `limits` included) plus the store. An alias with a known
 * context window gains `limit: { context, output }` (context > 0 required;
 * `output` is 0 when the output limit is not declared — the c0wrk wire
 * contract's "0 == undeclared"); the `capabilities` / `modalities` pair
 * appears only on the full four-flag declaration (the builder's strict AND).
 * An alias without metadata — nothing known, or no store wired — serializes
 * byte-for-byte as the bare four-key OpenAI entry. Retain-last-good means a
 * failed discovery never changes what is served here; the fold contacts no
 * upstream.
 *
 * Scoping: with a `clients` block configured, the client Bearer gate (ADR-008)
 * has authenticated the request and set the client identity on the context —
 * only the aliases in that client's `models` are listed (the per-client ACL,
 * ADR-009). Without a clients block nothing authenticates and every
 * configured alias is listed.
 */
import type pino from "pino";
import type { Handler } from "hono";
import type { ModelEntry, ModelList } from "../../types.ts";
import { type GatewayEnv, type RoutingTable } from "../../gateway/router.ts";
import { buildAliasMetadata, type AliasMetadata } from "../../gateway/aliasmeta.ts";
import type { MetadataStore } from "../../gateway/metastore.ts";
import type { ModelConfig } from "../../config/schema.ts";

/** The process start epoch (seconds) — `created` on every listed entry (P1). */
export const PROCESS_STARTED_AT = Math.floor(Date.now() / 1000);

/** The catalog owner named on every entry (P1). */
const OWNED_BY = "llm-gateway";

/**
 * The optional alias-metadata inputs: the validated `models` block plus the
 * store the entry point seeded. Undefined (no store wired) → every entry
 * serializes exactly as before metadata existed.
 */
export interface ModelsMetadataSource {
  /**
   * The validated `models` block — manual `limits` fold in through the
   * builder. A plain array is the startup snapshot; a provider function is
   * resolved per request so the runtime models CRUD's rebuilds (ADR-014)
   * are reflected in the folded metadata immediately.
   */
  models: readonly ModelConfig[] | (() => readonly ModelConfig[]);
  /** The per-upstream snapshot store; read per request, never mutated here. */
  store: MetadataStore;
}

export function handleModels(
  table: RoutingTable,
  logger: pino.Logger,
  metadata?: ModelsMetadataSource,
): Handler<GatewayEnv> {
  const log = logger.child({ component: "router" });

  return async (c) => {
    const client = c.get("client");
    const aliases = client === undefined ? table.aliases() : table.aliases().filter((alias) => client.allowedModels.includes(alias));

    // The alias metadata is rebuilt from the store's current slice on every
    // request — a successful discovery strengthens it, a failed one leaves it
    // untouched (retain-last-good). Pure fold: no upstream contact. The
    // models block may be a provider (runtime CRUD deployments resolve it
    // per request) or the startup snapshot (plain array deployments).
    const aliasMeta =
      metadata === undefined
        ? undefined
        : buildAliasMetadata(
            typeof metadata.models === "function" ? metadata.models() : metadata.models,
            metadata.store,
          );

    const data: ModelEntry[] = aliases.map((alias) => {
      const entry: ModelEntry = {
        id: alias,
        object: "model",
        created: PROCESS_STARTED_AT,
        owned_by: OWNED_BY,
      };
      applyAliasMetadata(entry, aliasMeta?.get(alias));
      return entry;
    });

    log.debug(
      { count: data.length, client: client?.name },
      "alias catalog served",
    );

    const list: ModelList = { object: "list", data };
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Projects one alias's aggregated metadata onto its catalog entry, in place,
 * after the four base keys so the JSON serialization order is stable. The
 * wire shapes mirror the c0wrk aggregator listing form the detector chain
 * reads back (`src/gateway/modelmetadata.ts`): `limit` only when the context
 * window is known (context > 0; output 0 == undeclared), and
 * `capabilities` + `modalities` only together, only on the full four-flag
 * declaration the builder's strict AND guarantees. Unknown dimensions add
 * nothing — an entry without metadata stays exactly the bare OpenAI entry.
 */
function applyAliasMetadata(entry: ModelEntry, meta: AliasMetadata | undefined): void {
  if (meta === undefined) {
    return;
  }
  if (meta.contextWindow !== undefined && meta.contextWindow > 0) {
    entry.limit = { context: meta.contextWindow, output: meta.outputLimit ?? 0 };
  }
  if (meta.capabilities !== undefined) {
    entry.capabilities = {
      tools: { supported: meta.capabilities.toolCall },
      reasoning: { supported: meta.capabilities.reasoning },
      temperature: meta.capabilities.temperature,
    };
    entry.modalities = { input: meta.capabilities.attachment ? ["text", "image/png"] : ["text"] };
  }
}
