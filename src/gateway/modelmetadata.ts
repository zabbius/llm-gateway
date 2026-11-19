/**
 * Model-metadata detectors over raw /models listing entries — the TypeScript
 * port of the c0wrk first-wins detector chain (`core/modelmetadata_detectors.go`),
 * ordered most-specific shape first: LM Studio → aggregator → OpenAI standard.
 * It is the basis for the model-metadata domain spec.
 *
 * Contract (first-wins):
 *  - `detectModelMetadata` runs the chain on one parsed entry object; the
 *    first matching detector's partial metadata wins; unmatched → `undefined`.
 *  - Numbers on `ModelMetadata` are flatly "0 == undeclared": every consumer
 *    treats 0 as absent, so no detector ever emits a negative.
 *  - Detectors never pin identity dimensions; unset fields inherit from the
 *    registry's lower tiers.
 *
 * Pure module: detectors consume `Record<string, unknown>` shapes, no imports.
 */

/** Capability flags for a model; an absent `capabilities` inherits. */
export interface ModelCapabilities {
  /** Image or PDF input is declared. */
  attachment: boolean;
  /** Reasoning output is declared. */
  reasoning: boolean;
  /** The temperature parameter is declared supported/unsupported. */
  temperature: boolean;
  /** Tool calling is declared. */
  toolCall: boolean;
}

/**
 * Partial metadata for one model; `contextWindow`/`outputLimit` are
 * "0 == undeclared", `capabilities` absent means inherit.
 */
export interface ModelMetadata {
  contextWindow: number;
  outputLimit: number;
  capabilities?: ModelCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The key's finite number, or undefined when absent or of any other type. */
function readNumber(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The key's boolean, or false when absent or of any other type. */
function readBool(entry: Record<string, unknown>, key: string): boolean {
  const value = entry[key];
  return typeof value === "boolean" ? value : false;
}

/** The key's string array elements (non-strings skipped), or [] when absent. */
function readStringArray(entry: Record<string, unknown>, key: string): string[] {
  const value = entry[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Parses the native LM Studio REST API entry: runtime window when loaded (a
 * non-positive loaded_context_length counts as not loaded — the advertised
 * capacity still applies), advertised capacity otherwise; capacity is claimed
 * only without max_model_len (the OpenAI-standard detector owns its
 * priority); no capabilities.
 */
export function detectLmStudioMetadata(entry: Record<string, unknown>): ModelMetadata | undefined {
  // A non-positive loaded_context_length is an unset runtime window, not a
  // declaration: reset it so the advertised-capacity branch below still
  // applies instead of a negative field poisoning the entry into declining.
  const loaded = readNumber(entry, "loaded_context_length") ?? 0;
  let window = Math.max(loaded, 0);
  const instances = entry["loaded_instances"];
  if (Array.isArray(instances)) {
    for (const instance of instances) {
      const config = isRecord(instance) ? instance["config"] : undefined;
      const length = isRecord(config) ? (readNumber(config, "context_length") ?? 0) : 0;
      if (length > 0) {
        window = length;
        break;
      }
    }
  }
  if (window === 0 && (readNumber(entry, "max_model_len") ?? 0) === 0) {
    window = readNumber(entry, "max_context_length") ?? 0;
  }
  if (window <= 0) {
    return undefined;
  }
  return { contextWindow: window, outputLimit: 0 };
}

/**
 * Reports image/PDF input modalities — the Attachment flag's contract on
 * `ModelCapabilities`.
 */
export function aggregatorDeclaresAttachment(input: readonly string[]): boolean {
  return input.some((modality) => modality === "application/pdf" || modality.startsWith("image/"));
}

/**
 * Parses the aggregator-style listing entry (the gateway-shaped
 * limit/capabilities/modalities form, matched structurally — no live
 * aggregator's response shape has been validated against it yet).
 * `limit.context > 0` is the shape's defining match condition.
 *
 * Capabilities are emitted only on a FULL declaration (both blocks AND the
 * tools/reasoning sub-objects AND the temperature key inside capabilities); a
 * partial one inherits — the authoritative all-false must not come from a
 * sparse block's omission or a missing temperature key.
 *
 * A declared output at or above the window drives EffectiveMax
 * (contextWindow − outputLimit − safety margin − tool overhead) to zero or
 * negative and silently disables compaction, so contradictory listing data
 * (output >= context) is treated as undeclared — the same "contradictory
 * data is ignored" stance as the non-positive case; both normalize to 0 here
 * so the wire contract is flatly "0 == undeclared".
 */
export function detectAggregatorMetadata(entry: Record<string, unknown>): ModelMetadata | undefined {
  const limit = entry["limit"];
  const context = isRecord(limit) ? (readNumber(limit, "context") ?? 0) : 0;
  if (context <= 0) {
    return undefined;
  }
  const declaredOutput = isRecord(limit) ? Math.max(readNumber(limit, "output") ?? 0, 0) : 0;
  const meta: ModelMetadata = {
    contextWindow: context,
    outputLimit: declaredOutput >= context ? 0 : declaredOutput,
  };
  const capabilities = entry["capabilities"];
  const modalities = entry["modalities"];
  const tools = isRecord(capabilities) ? capabilities["tools"] : undefined;
  const reasoning = isRecord(capabilities) ? capabilities["reasoning"] : undefined;
  if (isRecord(capabilities) && isRecord(tools) && isRecord(reasoning) && isRecord(modalities)) {
    // The temperature flag is presence-checked, not defaulted: the full
    // declaration requires the key itself. A missing key (or null, or any
    // non-boolean) counts as undeclared (inherit), so the omission cannot
    // masquerade as an authoritative "temperature unsupported".
    const temperature = capabilities["temperature"];
    if (typeof temperature === "boolean") {
      meta.capabilities = {
        attachment: aggregatorDeclaresAttachment(readStringArray(modalities, "input")),
        reasoning: readBool(reasoning, "supported"),
        temperature,
        toolCall: readBool(tools, "supported"),
      };
    }
  }
  return meta;
}

/**
 * Parses the standard OpenAI listing entry as extended by self-hosted
 * servers: the first non-zero of max_model_len / max_context_length /
 * context_length. Capabilities stay unset. Negative fields decline instead
 * of falling through — a negative must not silently promote a later field.
 */
export function detectOpenAIStandardMetadata(entry: Record<string, unknown>): ModelMetadata | undefined {
  let window = readNumber(entry, "max_model_len") ?? 0;
  if (window === 0) {
    window = readNumber(entry, "max_context_length") ?? 0;
  }
  if (window === 0) {
    window = readNumber(entry, "context_length") ?? 0;
  }
  if (window <= 0) {
    return undefined;
  }
  return { contextWindow: window, outputLimit: 0 };
}

/**
 * Runs the chain on one parsed entry: the first matching detector's partial
 * metadata wins; a non-object entry (unparseable or non-model shape) and
 * every unmatched shape decline to `undefined`.
 */
export function detectModelMetadata(entry: unknown): ModelMetadata | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  return (
    detectLmStudioMetadata(entry) ??
    detectAggregatorMetadata(entry) ??
    detectOpenAIStandardMetadata(entry)
  );
}
