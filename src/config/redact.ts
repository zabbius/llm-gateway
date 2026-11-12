/**
 * The redacted management view of the gateway configuration
 * (specs/contracts/gateway-management.md): the only config shape that ever
 * crosses into the HTTP layer.
 *
 * The view is built field by field — never by spreading a config entry:
 * `apiKey` is always the fixed mask, a configured `tlsFingerprint` becomes
 * the same mask, an absent one becomes `null`. The real key and pin values
 * are simply not copied, so no handler downstream of this function can
 * serialize them. The mask is the logging layer's censor (`REDACT_CENSOR`,
 * src/logging/logger.ts) — one shared literal, so presence (a key is
 * configured) stays visible while the value never is
 * (specs/architecture/security-model.md).
 */
import type { LogLevel } from "../types.ts";
import { REDACT_CENSOR } from "../logging/logger.ts";
import type { NormalizedGatewayConfig, UpstreamType } from "./schema.ts";

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
      apiKey: REDACT_CENSOR,
      tlsFingerprint: entry.tlsFingerprint !== undefined ? REDACT_CENSOR : null,
    })),
  };
}
