/**
 * Typed access to the gateway's management surface (ADR-014 — the
 * mutation-capable boundary, specs/contracts/gateway-management.md) — the
 * only gateway calls the SPA makes: the slim session-gated mount probe
 * (`GET /api/status`, ADR-014 D3), the three CRUD collections (upstreams,
 * model aliases, clients), the operator-triggered live model listing
 * (`GET /api/upstreams/:id/models`, ADR-011 as amended by ADR-016 —
 * `?discover=1` folds the metadata-slice swap into the listing), plus the
 * auth actions (`POST /api/login`, `POST /api/logout`, ADR-007).
 *
 * Response shapes mirror the wire contract; the session cookie is HttpOnly
 * and carried by same-origin fetches automatically; error responses use the
 * single OpenAI error envelope the gateway serves on every gateway-generated
 * failure — a `401` (session missing or expired) surfaces as ApiFetchError
 * with `status === 401`, a referential-integrity refusal as `status === 409`
 * (`resource_in_use`, D6).
 */

/** The fixed credential mask the redacted views serve — display fact only,
 * never an acceptable credential on a write (ADR-014 D7 rejects it). */
export const CONFIGURED_MASK = "[Configured]";

/* ------------------------------------------------------------------ *
 * `GET /api/status` — the session-gated mount probe (ADR-014 D3).
 * ------------------------------------------------------------------ */

/**
 * The slim `GET /api/status` body: the gateway's overall health verdict
 * plus whether this request carries a valid session. The SPA's mount probe
 * reads `authenticated` (Log out applies only to a live session); a `401`
 * swaps the shell to the login card.
 */
export interface GatewayStatus {
  /** The gateway's health verdict as the boundary reports it. */
  readonly status: string;
  /** This request carries a valid session (true only behind a login). */
  readonly authenticated: boolean;
}

/* ------------------------------------------------------------------ *
 * Upstreams collection — GET/POST /api/upstreams,
 * GET/PUT/DELETE /api/upstreams/:id.
 * ------------------------------------------------------------------ */

/**
 * One configured upstream as every management read serves it — the config
 * store's redacted view: credentials and the TLS pin are the fixed mask
 * literal (or JSON null when the pin is absent), never the values. The
 * `proxy` is served verbatim (null = a direct connection) — it is not key
 * material, the grammar forbids userinfo in a proxy URL (ADR-017). The
 * probe fields ride the rows on the boundary's inventory read (ADR-014 D3's
 * re-homed probe outcome); the SPA renders them when present.
 */
export interface ManagedUpstream {
  /** Implementation discriminator, mirrors the config entry's `type`. */
  readonly type: string;
  readonly id: string;
  /** Verbatim, not secret: every client request already carries it. */
  readonly baseUrl: string;
  /** Always the fixed mask literal — presence visible, value never. */
  readonly apiKey: string;
  /** The fixed mask when configured, null when absent. */
  readonly tlsFingerprint: string | null;
  /** The outbound proxy URL verbatim — `http://host:port` or
   * `socks5://host:port`; null when the upstream connects directly
   * (ADR-017). Not masked: the grammar admits no credentials in it. */
  readonly proxy: string | null;
  /** The upstream's probe outcome ("ok" | "failed") when the row carries it. */
  readonly probe?: "ok" | "failed";
  /** Why the probe failed; present only when `probe` is "failed". */
  readonly reason?: string;
}

/** The `GET /api/upstreams` body — config order, entries masked. */
export interface UpstreamList {
  readonly upstreams: readonly ManagedUpstream[];
}

/** One upstream's probe outcome as the create/update answer reports it (D8):
 * `reason` exists only when `ok` is false — a log-safe failure fact. */
export interface UpstreamProbeReport {
  readonly ok: boolean;
  readonly reason?: string;
}

/** The create/update answer: the masked entry as it now reads, plus the
 * blocking probe's outcome — data, not a gate (D8). */
export interface UpstreamWriteResponse {
  readonly upstream: ManagedUpstream;
  readonly probe: UpstreamProbeReport;
}

/**
 * The create/update request body — the config entry's grammar. Create
 * requires `apiKey`; update with an absent `apiKey` keeps the stored
 * credential (D7). `tlsFingerprint` absent keeps the stored pin; explicit
 * null — or an empty / whitespace-only value, the grammar's own "no pin" —
 * clears it. `proxy` (ADR-017) follows the same rule: absent keeps the
 * stored proxy on update (and means a direct connection on create), explicit
 * null clears it; a value is an `http://` or `socks5://` URL with an explicit
 * port and no userinfo. A JSON `null` on any other key is the key not set —
 * it reads exactly as if omitted (a `null` `apiKey` keeps the stored
 * credential on update; a `null` required key is reported missing).
 */
export interface UpstreamWriteRequest {
  readonly type: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly tlsFingerprint?: string | null;
  readonly proxy?: string | null;
}

/** The `DELETE /api/upstreams/:id` answer. */
export interface UpstreamDeleteResponse {
  readonly deleted: string;
}

/* ------------------------------------------------------------------ *
 * Model aliases collection — GET/POST /api/models,
 * GET/PUT/DELETE /api/models/:alias (the ADR-009 `models` collection).
 * ------------------------------------------------------------------ */

/** The strict-AND capability flags of one alias's routes. */
export interface AliasCapabilities {
  /** Image/PDF input is declared on every route. */
  readonly attachment: boolean;
  /** Reasoning output is declared on every route. */
  readonly reasoning: boolean;
  /** The temperature parameter is declared supported/unsupported on every route. */
  readonly temperature: boolean;
  /** Tool calling is declared on every route. */
  readonly toolCall: boolean;
}

/**
 * The alias-metadata aggregate on a management read (`meta`, D4): token
 * budgets are the aggregated minima over the alias's routes and capability
 * flags the strict-AND declaration — JSON `null` where unknown.
 */
export interface AliasMeta {
  readonly contextWindow: number | null;
  readonly outputLimit: number | null;
  readonly capabilities: AliasCapabilities | null;
}

/** One configured route of an alias — weight `null` unless weighted. */
export interface ModelRoute {
  readonly upstream: string;
  readonly model: string;
  readonly weight: number | null;
}

/** The manual token budgets of an alias entry — null when absent. */
export interface AliasLimits {
  readonly context: number | null;
  readonly output: number | null;
}

/** One managed alias entry as every list/detail/create/update answer serves it. */
export interface ManagedModelAlias {
  readonly alias: string;
  readonly routes: readonly ModelRoute[];
  readonly balance: { readonly strategy: "round-robin" | "weighted-round-robin" };
  readonly limits: AliasLimits | null;
  readonly meta: AliasMeta;
}

/** The `GET /api/models` body — config order. */
export interface ModelAliasList {
  readonly models: readonly ManagedModelAlias[];
}

/** One route of a write request — weight only with the weighted strategy; `null` is an unweighted route. */
export interface ModelRouteInput {
  readonly upstream: string;
  readonly model: string;
  readonly weight?: number | null;
}

/**
 * The create/update request body — the config entry's grammar: at least one
 * route, every `upstream` naming a configured upstream id, strategy/weight
 * consistency, limits positive integers (at least one of context/output).
 * `alias` is required on create; on update the path parameter owns it. A JSON
 * `null` is the key not set: a `null` `alias` is inherited like an omitted
 * one, and a `null` limit or `limits` block leaves the entry without it.
 */
export interface ModelAliasWriteRequest {
  readonly alias?: string | null;
  readonly routes: readonly ModelRouteInput[];
  readonly balance: { readonly strategy: "round-robin" | "weighted-round-robin" };
  readonly limits?: { readonly context?: number | null; readonly output?: number | null } | null;
}

/** The `DELETE /api/models/:alias` answer. */
export interface ModelAliasDeleteResponse {
  readonly deleted: string;
}

/* ------------------------------------------------------------------ *
 * Clients collection — GET/POST /api/clients,
 * GET/PUT/DELETE /api/clients/:name (the ADR-008 `clients` collection).
 * ------------------------------------------------------------------ */

/** One configured client as every management read serves it — the key is
 * the fixed mask literal, never the value. */
export interface ManagedClient {
  readonly name: string;
  readonly apiKey: string;
  /** The alias ACL — every entry names a configured alias. */
  readonly models: readonly string[];
}

/** The `GET /api/clients` body — config order, entries masked. */
export interface ClientList {
  readonly clients: readonly ManagedClient[];
}

/**
 * The create/update request body — `apiKey` required on create, absent on
 * update keeps the stored credential (D7); the name itself is immutable. A
 * JSON `null` is the key not set — a `null` `apiKey` keeps the stored
 * credential like an omitted one, a `null` required key is reported missing.
 */
export interface ClientWriteRequest {
  readonly name: string;
  readonly apiKey?: string | null;
  readonly models: readonly string[];
}

/** The create/update answer — the current masked entry. */
export interface ClientWriteResponse {
  readonly client: ManagedClient;
}

/** The `DELETE /api/clients/:name` answer. */
export interface ClientDeleteResponse {
  readonly deleted: string;
}

/* ------------------------------------------------------------------ *
 * `GET /api/upstreams/:id/models` — the operator-triggered live listing
 * (ADR-011), preserved verbatim.
 * ------------------------------------------------------------------ */

/** One provider-native model entry of a live listing (unprefixed ids). */
export interface UpstreamModel {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
  readonly [field: string]: unknown;
}

/**
 * The `GET /api/upstreams/:id/models` body (ADR-011) — one live upstream
 * listing: the named upstream's current provider-native catalog plus the
 * ISO-8601 instant the gateway completed the fetch.
 */
export interface UpstreamModels {
  /** The exact configured upstream id the listing was fetched for. */
  readonly upstream: string;
  /** Provider-native unprefixed entries. */
  readonly models: readonly UpstreamModel[];
  /** ISO-8601 instant the gateway completed the fetch. */
  readonly fetchedAt: string;
}

/* ------------------------------------------------------------------ *
 * Errors — the one envelope (src/httpapi/errors.ts) every
 * gateway-generated failure uses.
 * ------------------------------------------------------------------ */

/** The OpenAI error envelope — every gateway failure's shape. */
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
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

/** Send a JSON body with the given method; same failure handling as `request`. */
async function send<T>(method: string, path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ *
 * Helpers — one per management route, grouped by collection.
 * ------------------------------------------------------------------ */

/** The slim session-gated mount probe (`GET /api/status`, ADR-014 D3). */
export function fetchStatus(): Promise<GatewayStatus> {
  return request<GatewayStatus>("/api/status");
}

/** Every configured upstream, masked (`GET /api/upstreams`). */
export function fetchUpstreams(): Promise<UpstreamList> {
  return request<UpstreamList>("/api/upstreams");
}

/** One configured upstream, masked (`GET /api/upstreams/:id`). */
export function fetchUpstream(id: string): Promise<ManagedUpstream> {
  return request<ManagedUpstream>(`/api/upstreams/${encodeURIComponent(id)}`);
}

/**
 * Create an upstream (`POST /api/upstreams`): the store validates and
 * persists, then the gateway probes synchronously within its budget — a
 * failed probe is data in the answer, never a cancellation (D8). A `400`
 * (bad grammar, duplicate id, the mask literal as a credential) throws
 * ApiFetchError with the value-free problem lines.
 */
export function createUpstream(body: UpstreamWriteRequest): Promise<UpstreamWriteResponse> {
  return send<UpstreamWriteResponse>("POST", "/api/upstreams", body);
}

/**
 * Update an upstream (`PUT /api/upstreams/:id`) — same hot-apply sequence;
 * the id is immutable, an absent `apiKey` keeps the stored credential (D7).
 * An unknown id answers the `404` envelope before any validation.
 */
export function updateUpstream(id: string, body: UpstreamWriteRequest): Promise<UpstreamWriteResponse> {
  return send<UpstreamWriteResponse>("PUT", `/api/upstreams/${encodeURIComponent(id)}`, body);
}

/**
 * Delete an upstream (`DELETE /api/upstreams/:id`). A `409`
 * (`resource_in_use`) names the model routes still referencing it —
 * referential integrity is the operator's to resolve (D6); the last
 * upstream is the store's `400` refusal.
 */
export function deleteUpstream(id: string): Promise<UpstreamDeleteResponse> {
  return send<UpstreamDeleteResponse>("DELETE", `/api/upstreams/${encodeURIComponent(id)}`, {});
}

/**
 * Fetch an upstream's live model list (`GET /api/upstreams/:id/models`,
 * ADR-011 as amended by ADR-016) — one of the boundary's operator-triggered
 * request-time upstream contacts, triggered only by this explicit call.
 * With `discover: true` the fetched catalog swaps the upstream's metadata
 * slice wholesale before the answer (retain-last-good on failure — the
 * merged former discover mount). A `404` (unknown id) or `502` (upstream
 * failure, probe budget expiry) throws ApiFetchError with the envelope's
 * message; a `401` follows the shared login-card flow.
 */
export function fetchUpstreamModels(
  id: string,
  opts?: { readonly discover?: boolean },
): Promise<UpstreamModels> {
  const suffix = opts?.discover === true ? "?discover=1" : "";
  return request<UpstreamModels>(`/api/upstreams/${encodeURIComponent(id)}/models${suffix}`);
}

/** Every configured alias entry with its metadata aggregate (`GET /api/models`). */
export function fetchModels(): Promise<ModelAliasList> {
  return request<ModelAliasList>("/api/models");
}

/**
 * Create an alias entry (`POST /api/models`); the answer is the created
 * entry with its `meta`. A `400` carries the store's value-free problem
 * lines (alias grammar, unknown route upstream, strategy/weight rules…).
 */
export function createModel(body: ModelAliasWriteRequest): Promise<ManagedModelAlias> {
  return send<ManagedModelAlias>("POST", "/api/models", body);
}

/**
 * Update an alias entry (`PUT /api/models/:alias`) — routes, balance and
 * limits are replaced wholesale, the alias itself is immutable. An unknown
 * alias answers the `404` envelope before any validation.
 */
export function updateModel(alias: string, body: ModelAliasWriteRequest): Promise<ManagedModelAlias> {
  return send<ManagedModelAlias>("PUT", `/api/models/${encodeURIComponent(alias)}`, body);
}

/**
 * Delete an alias entry (`DELETE /api/models/:alias`). A `409`
 * (`resource_in_use`) names the clients whose ACL still lists the alias
 * (D6); the block's last entry is the store's `400` refusal.
 */
export function deleteModel(alias: string): Promise<ModelAliasDeleteResponse> {
  return send<ModelAliasDeleteResponse>("DELETE", `/api/models/${encodeURIComponent(alias)}`, {});
}

/** Every configured client, masked (`GET /api/clients`). */
export function fetchClients(): Promise<ClientList> {
  return request<ClientList>("/api/clients");
}

/**
 * Create a client (`POST /api/clients`); the answer is the masked entry.
 * `apiKey` is required here — an update may omit it (D7). A `400` carries
 * the store's value-free problem lines (grammar, unknown ACL aliases).
 */
export function createClient(body: ClientWriteRequest): Promise<ClientWriteResponse> {
  return send<ClientWriteResponse>("POST", "/api/clients", body);
}

/**
 * Update a client (`PUT /api/clients/:name`) — an absent `apiKey` keeps the
 * stored credential (D7); the name is immutable. An unknown name answers
 * the `404` envelope before any validation.
 */
export function updateClient(name: string, body: ClientWriteRequest): Promise<ClientWriteResponse> {
  return send<ClientWriteResponse>("PUT", `/api/clients/${encodeURIComponent(name)}`, body);
}

/**
 * Delete a client (`DELETE /api/clients/:name`) — the very next `/llm/v1`
 * request with its key answers `401`; no `resource_in_use` class exists
 * (nothing in the configuration references a client); the last entry is
 * the store's `400` refusal.
 */
export function deleteClient(name: string): Promise<ClientDeleteResponse> {
  return send<ClientDeleteResponse>("DELETE", `/api/clients/${encodeURIComponent(name)}`, {});
}

/**
 * Exchange credentials for a session cookie (`POST /api/login`). The cookie
 * is HttpOnly — the SPA never sees the session token; same-origin fetches
 * carry it automatically from here on. A `401` (wrong credentials) or `400`
 * (malformed request) throws ApiFetchError with the envelope's message.
 */
export function login(user: string, password: string): Promise<{ authenticated: boolean }> {
  return send<{ authenticated: boolean }>("POST", "/api/login", { user, password });
}

/** Revoke the session and expire the cookie (`POST /api/logout`); always 200. */
export function logout(): Promise<{ authenticated: boolean }> {
  return send<{ authenticated: boolean }>("POST", "/api/logout", {});
}
