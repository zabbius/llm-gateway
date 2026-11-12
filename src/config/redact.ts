/**
 * The redacted management view of the gateway configuration
 * (specs/contracts/gateway-management.md): the only config shape that ever
 * crosses into the HTTP layer.
 *
 * The view is built field by field — never by spreading a config entry:
 * `apiKey` is always the fixed mask, a configured `tlsFingerprint` becomes
 * the same mask, an absent one becomes `null`. The real key and pin values
 * are simply not copied, so no handler downstream of this function can
 * serialize them. The mask is the view's own literal `[Configured]`,
 * deliberately distinct from the logging layer's censor (`[Redacted]`,
 * src/logging/logger.ts): the view marks "a credential is configured here",
 * while the censor stands for any redacted value in a log line, including
 * client-supplied ones (specs/architecture/security-model.md).
 */
import type { LogLevel } from "../types.ts";
import type { NormalizedGatewayConfig, UpstreamType } from "./schema.ts";

/** The fixed mask replacing every credential in the management view. */
export const CONFIGURED_MASK = "[Configured]";

/** One upstream entry of the redacted view — credentials replaced by the mask. */
export interface RedactedUpstreamConfig {
  type: UpstreamType;
  /** ^[a-z0-9][a-z0-9-]*$ — mirrors the config entry */
  id: string;
  /** verbatim — not secret: every client request already carries it */
  baseUrl: string;
  /** always the fixed mask — presence visible, value never */
  apiKey: string;
  /** the fixed mask when configured, `null` when absent */
  tlsFingerprint: string | null;
}

/** The sanitized effective configuration served by `GET /api/configuration`. */
export interface RedactedGatewayConfig {
  /** the effective `listen` value after startup normalization */
  listen: string;
  /** the effective log level after startup normalization */
  logLevel: LogLevel;
  /** config order preserved — the view mirrors the `upstreams` array */
  upstreams: RedactedUpstreamConfig[];
}

/**
 * Build the redacted view of a validated (normalized) config. Deterministic:
 * the same config always yields the same view. The input is never mutated
 * and no view object is shared with it — the real `apiKey` /
 * `tlsFingerprint` values live on in the config domain only.
 */
export function redactedConfigView(config: NormalizedGatewayConfig): RedactedGatewayConfig {
  return {
    listen: config.listen,
    logLevel: config.logLevel,
    upstreams: config.upstreams.map((entry) => ({
      type: entry.type,
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: CONFIGURED_MASK,
      tlsFingerprint: entry.tlsFingerprint !== undefined ? CONFIGURED_MASK : null,
    })),
  };
}
