/**
 * The redacted management view of the gateway configuration
 * (specs/contracts/gateway-management.md): the only config shape that ever
 * crosses into the HTTP layer.
 *
 * The view is built field by field — never by spreading a config entry:
 * every `apiKey` (upstream or client) is always the fixed mask, a configured
 * `tlsFingerprint` becomes the same mask, an absent one becomes `null`;
 * `baseUrl` and `proxy` are copied verbatim (neither can carry a credential —
 * the proxy grammar rejects userinfo, ADR-017), an absent `proxy` becomes
 * `null`. The real key and pin values are simply not copied, so no handler
 * downstream of this function can serialize them. `server` mirrors the
 * config's listener block verbatim — `listen`, the request-body cap and the
 * `cert`/`key` PEM paths are not secret.
 * The mask is the view's own literal `[Configured]`,
 * deliberately distinct from the logging layer's censor (`[Redacted]`,
 * src/logging/logger.ts): the view marks "a credential is configured here",
 * while the censor stands for any redacted value in a log line, including
 * client-supplied ones (specs/architecture/security-model.md).
 */
import type { LogLevel } from "../types.ts";
import type { BalanceStrategy, NormalizedGatewayConfig, UpstreamType } from "./schema.ts";

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
  /** verbatim outbound proxy URL — not secret (the grammar admits no userinfo); `null` when absent (ADR-017) */
  proxy: string | null;
}

/** TLS options of the redacted view — paths verbatim, absent values as `null`. */
export interface RedactedTlsConfig {
  /** mirrors the config's `server.tls.enabled` */
  enabled: boolean;
  /** verbatim PEM certificate-chain path — not secret; `null` when absent */
  cert: string | null;
  /** verbatim PEM private-key path — not secret; `null` when absent */
  key: string | null;
}

/** The redacted `server` block of the effective configuration. */
export interface RedactedServerConfig {
  /** the effective `listen` value after startup normalization */
  listen: string;
  /** the effective request-body cap in bytes after startup normalization — not secret */
  maxRequestBodyBytes: number;
  /** `null` when the config carries no `tls` block */
  tls: RedactedTlsConfig | null;
}

/** The redacted `auth` block of the effective configuration (ADR-007). */
export interface RedactedAuthConfig {
  /** mirrors the config's `auth.enabled` */
  enabled: boolean;
  /** verbatim operator login — it identifies, it does not authenticate; `null` when absent */
  user: string | null;
  /** the fixed mask when configured, `null` when absent — the hash never crosses into the view */
  passwordHash: string | null;
}

/** One client entry of the redacted view — the credential replaced by the mask. */
export interface RedactedClientConfig {
  /** verbatim client name — identifies the entry, it does not authenticate */
  name: string;
  /** always the fixed mask — presence visible, value never */
  apiKey: string;
  /** verbatim model aliases — not secret */
  models: string[];
}

/** One route of the redacted view — upstream id, model name and weight are not secret. */
export interface RedactedModelRouteConfig {
  /** verbatim upstream id the route targets */
  upstream: string;
  /** verbatim provider-native model name */
  model: string;
  /** verbatim when configured, `null` when absent (plain round-robin) */
  weight: number | null;
}

/** The redacted `balance` block of a model entry. */
export interface RedactedModelBalanceConfig {
  /** mirrors the config's `balance.strategy` */
  strategy: BalanceStrategy;
}

/** The redacted `limits` block of a model entry — the values are not secret. */
export interface RedactedModelLimitsConfig {
  /** verbatim token limit when configured, `null` when absent */
  context: number | null;
  /** verbatim token limit when configured, `null` when absent */
  output: number | null;
}

/** One model entry of the redacted view — alias, routes, strategy and limits are not secret. */
export interface RedactedModelConfig {
  /** verbatim client-facing alias */
  alias: string;
  /** config order preserved — the view mirrors the entry's `routes` array */
  routes: RedactedModelRouteConfig[];
  /** mirrors the config's `balance` block */
  balance: RedactedModelBalanceConfig;
  /** mirrors the config's optional `limits` block; `null` when the entry carries none */
  limits: RedactedModelLimitsConfig | null;
}

/** The sanitized effective configuration — the credential-free whole-config view. */
export interface RedactedGatewayConfig {
  /** mirrors the config's `server` block with `listen` defaulted */
  server: RedactedServerConfig;
  /** the effective log level after startup normalization */
  logLevel: LogLevel;
  /** `null` when the config carries no `auth` block */
  auth: RedactedAuthConfig | null;
  /** `null` when the config carries no `clients` block */
  clients: RedactedClientConfig[] | null;
  /** `null` when the config carries no `models` block */
  models: RedactedModelConfig[] | null;
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
  const tls = config.server.tls;
  const auth = config.auth;
  const clients = config.clients;
  const models = config.models;
  return {
    server: {
      listen: config.server.listen,
      maxRequestBodyBytes: config.server.maxRequestBodyBytes,
      tls:
        tls === undefined
          ? null
          : {
              enabled: tls.enabled,
              cert: tls.cert ?? null,
              key: tls.key ?? null,
            },
    },
    logLevel: config.logLevel,
    auth:
      auth === undefined
        ? null
        : {
            enabled: auth.enabled,
            user: auth.user ?? null,
            passwordHash: auth.passwordHash !== undefined ? CONFIGURED_MASK : null,
          },
    clients:
      clients === undefined
        ? null
        : clients.map((entry) => ({
            name: entry.name,
            apiKey: CONFIGURED_MASK,
            models: [...entry.models],
          })),
    models:
      models === undefined
        ? null
        : models.map((entry) => ({
            alias: entry.alias,
            routes: entry.routes.map((route) => ({
              upstream: route.upstream,
              model: route.model,
              weight: route.weight ?? null,
            })),
            balance: { strategy: entry.balance.strategy },
            limits:
              entry.limits === undefined
                ? null
                : {
                    context: entry.limits.context ?? null,
                    output: entry.limits.output ?? null,
                  },
          })),
    upstreams: config.upstreams.map((entry) => ({
      type: entry.type,
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: CONFIGURED_MASK,
      tlsFingerprint: entry.tlsFingerprint !== undefined ? CONFIGURED_MASK : null,
      proxy: entry.proxy ?? null,
    })),
  };
}
