/**
 * Typed access to the gateway's management surface (specs/contracts/
 * gateway-management.md) — the ONLY gateway calls the SPA makes: two
 * read-only GETs, plain JSON, no credentials in, no mutation. Response
 * shapes mirror the contract; error responses use the single OpenAI error
 * envelope the gateway serves on every gateway-generated failure.
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

/** The `GET /api/configuration` body — the sanitized effective configuration. */
export interface GatewayConfiguration {
  readonly listen: string;
  readonly logLevel: LogLevel;
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
