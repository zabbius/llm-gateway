/**
 * Typed access to the gateway's management surface (specs/contracts/
 * gateway-management.md) — the only gateway calls the SPA makes: two
 * read-only GETs plus the auth actions (`POST /api/login`, `POST /api/logout`,
 * ADR-008). Response shapes mirror the contract; the session cookie is
 * HttpOnly and carried by same-origin fetches automatically; error responses
 * use the single OpenAI error envelope the gateway serves on every
 * gateway-generated failure — a `401` (session missing or expired) surfaces
 * as ApiFetchError with `status === 401`.
 */

/** A gateway log level (src/types.ts), as the configuration endpoint reports it. */
export type LogLevel = "trace" | "debug" | "info" | "warning" | "error" | "none";

/** One upstream's retained startup-probe outcome (`GET /api/status[]`). */
export interface UpstreamStatus {
  readonly id: string;
  readonly type: string;
  readonly probe: "ok" | "failed";
  /** Why the probe failed; present only when `probe` is "failed". */
  readonly reason?: string;
}

/** The `GET /api/status` body — config order preserved. */
export interface GatewayStatus {
  readonly upstreams: readonly UpstreamStatus[];
}

/** One upstream entry of the sanitized configuration — credentials already masked. */
export interface RedactedUpstreamConfig {
  readonly type: string;
  readonly id: string;
  /** Verbatim, not secret: every client request already carries it. */
  readonly baseUrl: string;
  /** Always the fixed mask literal — presence visible, value never. */
  readonly apiKey: string;
  /** The fixed mask when configured, null when absent. */
  readonly tlsFingerprint: string | null;
}

/** TLS options of the sanitized configuration — paths verbatim, absent values null. */
export interface RedactedTlsConfig {
  readonly enabled: boolean;
  readonly cert: string | null;
  readonly key: string | null;
}

/** The sanitized `auth` block — enabled state verbatim, the login verbatim, the hash always masked. */
export interface RedactedAuthConfig {
  readonly enabled: boolean;
  /** The operator login identifies, it does not authenticate. */
  readonly user: string | null;
  /** Always the fixed mask when configured, null when absent. */
  readonly passwordHash: string | null;
}

/** The sanitized `server` block of the effective configuration. */
export interface RedactedServerConfig {
  readonly listen: string;
  /** `null` when the gateway runs plain HTTP (no `tls` block in the config). */
  readonly tls: RedactedTlsConfig | null;
}

/** The `GET /api/configuration` body — the sanitized effective configuration. */
export interface GatewayConfiguration {
  readonly server: RedactedServerConfig;
  readonly logLevel: LogLevel;
  /** `null` when the config carries no `auth` block (the surface is ungated). */
  readonly auth: RedactedAuthConfig | null;
  readonly upstreams: readonly RedactedUpstreamConfig[];
}

/** The OpenAI error envelope (src/httpapi/errors.ts) — every gateway failure's shape. */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly param?: string;
    readonly code?: string;
  };
}

/** A failed management-API call: HTTP status plus the best available message. */
export class ApiFetchError extends Error {
  /** 0 when the request itself failed (network, abort) — no response arrived. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
  }
}

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch (cause) {
    throw new ApiFetchError(0, cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new ApiFetchError(response.status, await failureMessage(response));
  }
  return (await response.json()) as T;
}

/** The envelope's message when the body is one, else a plain status fact. */
async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Partial<ApiErrorEnvelope>;
    const message = body.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not an envelope (or not JSON) — fall through to the generic message.
  }
  return `request failed with status ${response.status}`;
}

/** Fetch the upstream health snapshot (`GET /api/status`). */
export function fetchStatus(): Promise<GatewayStatus> {
  return request<GatewayStatus>("/api/status");
}

/** Fetch the sanitized effective configuration (`GET /api/configuration`). */
export function fetchConfiguration(): Promise<GatewayConfiguration> {
  return request<GatewayConfiguration>("/api/configuration");
}

/**
 * Exchange credentials for a session cookie (`POST /api/login`). The cookie
 * is HttpOnly — the SPA never sees the session token; same-origin fetches
 * carry it automatically from here on. A `401` (wrong credentials) or `400`
 * (malformed request) throws ApiFetchError with the envelope's message.
 */
export function login(user: string, password: string): Promise<{ authenticated: boolean }> {
  return send<{ authenticated: boolean }>("/api/login", { user, password });
}

/** Revoke the session and expire the cookie (`POST /api/logout`); always 200. */
export function logout(): Promise<{ authenticated: boolean }> {
  return send<{ authenticated: boolean }>("/api/logout", {});
}

/** POST JSON to a management endpoint with the same failure handling as `request`. */
async function send<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiFetchError(0, cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new ApiFetchError(response.status, await failureMessage(response));
  }
  return (await response.json()) as T;
}
