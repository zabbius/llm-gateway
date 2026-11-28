/**
 * The runtime configuration store (ADR-014, decision D1): the holder of the
 * current normalized config whose `upstreams`, `models` and `clients`
 * collections the management boundary mutates at runtime.
 *
 * A mutation validates the incoming entry against the current collections
 * with the same grammar helpers the startup validator uses
 * (`src/config/schema.ts` — patterns, `BALANCE_STRATEGIES`, `isHttpUrl`,
 * `isValidTlsFingerprint`, `isValidProxyUrl`, `isValidModelAlias`), then
 * writes the resulting
 * whole configuration back to the config file before it applies the change
 * in memory: the raw file is read, its three mutable sections are replaced,
 * the result goes to a sibling temp file and an atomic rename moves it onto
 * the config file. A validation problem or a failed write leaves both disk
 * and memory untouched — the file on disk and the state in memory never
 * diverge, and the config file stays the single source of truth a restart
 * reconstructs everything from. Hand edits made between runtime mutations
 * are preserved for the sections the store does not manage (`server`,
 * `logLevel`, `auth`) and are overwritten for the three mutable sections —
 * after the first runtime mutation the store, not the editor, owns them
 * until the next restart.
 *
 * Write-specific rules (ADR-014 D6/D7) — one grammar, one table:
 *
 *   THE RULE. Every write body reads under the wire grammar of the management
 *   contract (`specs/contracts/gateway-management.md`, "Optional values in a
 *   write body — keep / clear / reject"): an ABSENT key means "keep" on an
 *   update; `null` and the exact empty string `""` are ONE clear signal; a
 *   whitespace-only string (`trim() === ""` but not `""`) is never a value and is refused;
 *   the literal mask `[Configured]` (`CONFIGURED_MASK`, `src/config/redact.ts`)
 *   is a display fact, never an acceptable credential. Every refusal is a
 *   value-free problem line.
 *
 *   | body value      | `apiKey` (required credential)  | `tlsFingerprint` / `proxy` (optional)      |
 *   |-----------------|---------------------------------|--------------------------------------------|
 *   | absent          | update: keep the stored key     | update: keep the stored value              |
 *   |                 | create: 400, missing            | create: not set                            |
 *   | `null`          | update: 400, cannot be cleared  | clear (create: not set — as absent)        |
 *   |                 | create: 400, missing            |                                            |
 *   | `""` (exact)    | update: 400, cannot be cleared  | clear — the same signal as `null`          |
 *   |                 | create: 400, non-empty          |                                            |
 *   | whitespace-only | 400, whitespace-only            | 400, whitespace-only (send null or "")     |
 *   | `[Configured]`  | 400, mask literal               | pin: 400, mask literal; proxy: 400, URL grammar |
 *   | anything else   | a non-empty string, else 400    | the startup grammar (pin whitespace-normalized, URL trimmed), else 400 |
 *
 * - Why `apiKey` cannot be cleared: there is no credential-less upstream or
 *   client, so the clear signal on an update is refused with a line saying
 *   so; the absent field is the only honest "unchanged" because the masked
 *   view never carries the value back. Create requires a key.
 * - Why an absent pin / proxy keeps: dropping a pin silently would widen
 *   upstream trust from fail-closed pinning to system-CA verification
 *   (ADR-004), and an omitted field must never silently change the egress
 *   topology (ADR-017). An empty value normalizes to absent, so a stored
 *   entry never carries `tlsFingerprint: ""` or `proxy: ""`. The proxy URL
 *   is not a credential (the grammar admits no userinfo), so it rides the
 *   masked view verbatim, unlike `apiKey` / `tlsFingerprint`; a malformed
 *   one is still never echoed into a problem line.
 * - Every other key follows the null rule (`withoutNulls`, the startup
 *   grammar's rule, point-applied): a JSON `null` body value is the key not
 *   set — a required or inherited field (`type`, `id`, `baseUrl`, `name`,
 *   `models`, `routes`, `balance`) reads exactly as if omitted, and an
 *   optional field (a route `weight`, a single limit, the `limits` block) is
 *   absent from the result — on update that clears it, those blocks being
 *   replaced wholesale. The three wire-grammar keys are classified on the
 *   RAW body, before the null rule; `tlsFingerprint` / `proxy` keep their
 *   `null` through `withoutNulls` so an explicit clear never collapses into
 *   "absent from the patch", which on update means keep.
 * - Deleting a resource that live configuration still references (an
 *   upstream named by a model route, a model named by a client's alias ACL)
 *   is refused with problem lines naming the referencing entries — the
 *   handler maps that answer to `409 resource_in_use`; no cascades.
 * - The identifying key of an entry (`upstreams[].id`, `models[].alias`,
 *   `clients[].name`) is immutable on update — a rename would silently
 *   strand the cross-references pointing at the old key; the operator
 *   deletes and re-creates instead.
 * - A collection that is present keeps at least one entry (exactly the
 *   startup validator's shape rule); a block absent at startup appears with
 *   the first `add` and then follows the same rule.
 *
 * Problem lines are collections of plain strings, one per problem, and are
 * value-free where it matters: `apiKey` / pin material is never echoed, and
 * persist failures name the path and the errno code without quoting file
 * content — unlike the startup loader's parse errors, these lines can cross
 * into HTTP error envelopes (specs/architecture/security-model.md).
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { CONFIGURED_MASK, redactedConfigView, type RedactedGatewayConfig } from "./redact.ts";
import {
  BALANCE_KEYS,
  BALANCE_STRATEGIES,
  CLIENT_KEYS,
  LIMITS_KEYS,
  MODEL_KEYS,
  MODEL_ROUTE_KEYS,
  UPSTREAM_ID_PATTERN,
  UPSTREAM_KEYS,
  UPSTREAM_TYPES,
  deepFreeze,
  isHttpUrl,
  isPlainObject,
  isPositiveInteger,
  isValidModelAlias,
  isValidProxyUrl,
  isValidTlsFingerprint,
  normalizeBaseUrl,
  normalizeProxy,
  normalizeTlsFingerprint,
  withoutNulls,
} from "./schema.ts";
import type {
  BalanceStrategy,
  ClientConfig,
  ModelConfig,
  ModelLimitsConfig,
  ModelRouteConfig,
  NormalizedGatewayConfig,
  UpstreamConfig,
  UpstreamType,
} from "./schema.ts";

/** The result of one store operation: problems is a value-free list, one line per problem. */
export type StoreResult = { ok: true } | { ok: false; problems: string[] };

/** The three collections the store owns; `clients`/`models` stay `undefined` while their config blocks are absent. */
interface StoreCollections {
  upstreams: UpstreamConfig[];
  models: ModelConfig[] | undefined;
  clients: ClientConfig[] | undefined;
}

type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/**
 * The runtime configuration store over one gateway config file. The
 * constructor takes the normalized config the startup loader produced and
 * the path it was loaded from; every mutation is a synchronous
 * validate → write → apply sequence (no await between validate and apply),
 * so two mutations can never interleave on Bun's single-threaded event loop.
 */
export class ConfigStore {
  /** The current normalized config — deep-frozen, rebuilt after every applied mutation. */
  private current: NormalizedGatewayConfig;

  constructor(
    config: NormalizedGatewayConfig,
    private readonly configPath: string,
  ) {
    this.current = config;
  }

  /** The current normalized config (deep-frozen; rebuild the assembled graph over this, ADR-014 D2). */
  get config(): NormalizedGatewayConfig {
    return this.current;
  }

  /**
   * The redacted management view of the current config — the masking rule
   * (`src/config/redact.ts`) applied to the current snapshot, so a read
   * after a mutation serves the mutated, masked state. The management
   * handlers consume this instead of touching config modules directly:
   * credential material never leaves the config domain (D7 — reads serve
   * masks only).
   */
  get view(): RedactedGatewayConfig {
    return redactedConfigView(this.current);
  }

  get upstreams(): readonly UpstreamConfig[] {
    return this.current.upstreams;
  }

  /** `undefined` while the config file carries no `models` block. */
  get models(): readonly ModelConfig[] | undefined {
    return this.current.models;
  }

  /** `undefined` while the config file carries no `clients` block. */
  get clients(): readonly ClientConfig[] | undefined {
    return this.current.clients;
  }

  findUpstream(id: string): UpstreamConfig | undefined {
    return this.current.upstreams.find((entry) => entry.id === id);
  }

  findModel(alias: string): ModelConfig | undefined {
    return this.current.models?.find((entry) => entry.alias === alias);
  }

  findClient(name: string): ClientConfig | undefined {
    return this.current.clients?.find((entry) => entry.name === name);
  }

  // -- upstreams -----------------------------------------------------------

  /** Create an upstream entry. All fields are required, including `apiKey`. */
  addUpstream(input: unknown): StoreResult {
    const checked = validateUpstreamEntry(input, { others: this.current.upstreams });
    if (!checked.ok) return checked;
    return this.commit({ upstreams: [...this.current.upstreams, checked.value] });
  }

  /**
   * Replace an upstream entry identified by its id. Every field is required
   * except `apiKey` (absent → keep the stored credential), `tlsFingerprint`
   * (absent → keep the stored pin, explicit `null` or the grammar's empty /
   * whitespace-only value → clear it) and `proxy` (absent → keep the stored
   * proxy, explicit `null` or empty → clear it). The id itself is immutable.
   */
  updateUpstream(id: string, input: unknown): StoreResult {
    const existing = this.findUpstream(id);
    if (existing === undefined) {
      return failure([`no upstream with id ${quoted(id)}`]);
    }
    const checked = validateUpstreamEntry(input, {
      others: this.current.upstreams.filter((entry) => entry !== existing),
      existing,
    });
    if (!checked.ok) return checked;
    return this.commit({
      upstreams: this.current.upstreams.map((entry) => (entry === existing ? checked.value : entry)),
    });
  }

  /** Delete an upstream entry; refused while any model route still names it. */
  removeUpstream(id: string): StoreResult {
    const existing = this.findUpstream(id);
    if (existing === undefined) {
      return failure([`no upstream with id ${quoted(id)}`]);
    }
    const referencing = this.upstreamReferences(id);
    if (referencing.length > 0) {
      return failure(referencing);
    }
    if (this.current.upstreams.length === 1) {
      return failure(["cannot remove the last upstream — upstreams must keep at least one entry"]);
    }
    return this.commit({ upstreams: this.current.upstreams.filter((entry) => entry !== existing) });
  }

  // -- models ---------------------------------------------------------------

  /** Create a model entry; every route must name a registered upstream id. Creates the `models` block when absent. */
  addModel(input: unknown): StoreResult {
    const checked = validateModelEntry(input, {
      others: this.current.models ?? [],
      upstreamIds: new Set(this.current.upstreams.map((entry) => entry.id)),
    });
    if (!checked.ok) return checked;
    return this.commit({ models: [...(this.current.models ?? []), checked.value] });
  }

  /**
   * Replace a model entry identified by its alias. `routes`, `balance` and
   * `limits` are replaced wholesale (an absent or `null` limits block
   * leaves the entry without limits — the null rule reads `null` as not
   * set); the alias itself is immutable.
   */
  updateModel(alias: string, input: unknown): StoreResult {
    const existing = this.findModel(alias);
    if (existing === undefined) {
      return failure([`no model with alias ${quoted(alias)}`]);
    }
    const checked = validateModelEntry(input, {
      others: (this.current.models ?? []).filter((entry) => entry !== existing),
      existing,
      upstreamIds: new Set(this.current.upstreams.map((entry) => entry.id)),
    });
    if (!checked.ok) return checked;
    return this.commit({
      models: (this.current.models ?? []).map((entry) => (entry === existing ? checked.value : entry)),
    });
  }

  /** Delete a model entry; refused while any client's alias ACL still names it, or when it is the block's last entry. */
  removeModel(alias: string): StoreResult {
    const existing = this.findModel(alias);
    if (existing === undefined) {
      return failure([`no model with alias ${quoted(alias)}`]);
    }
    const referencing = (this.current.clients ?? [])
      .filter((client) => client.models.includes(alias))
      .map((client) => `model ${quoted(alias)} is still referenced by client ${quoted(client.name)}`);
    if (referencing.length > 0) {
      return failure(referencing);
    }
    const models = this.current.models ?? [];
    if (models.length === 1) {
      return failure(["cannot remove the last model entry — a present models block keeps at least one entry"]);
    }
    return this.commit({ models: models.filter((entry) => entry !== existing) });
  }

  // -- clients ---------------------------------------------------------------

  /** Create a client entry; every listed alias must name a defined `models[].alias`. Creates the `clients` block when absent. */
  addClient(input: unknown): StoreResult {
    const checked = validateClientEntry(input, {
      others: this.current.clients ?? [],
      aliases: new Set((this.current.models ?? []).map((entry) => entry.alias)),
    });
    if (!checked.ok) return checked;
    return this.commit({ clients: [...(this.current.clients ?? []), checked.value] });
  }

  /**
   * Replace a client entry identified by its name. `models` is replaced
   * wholesale; `apiKey` absent → keep the stored credential; the name
   * itself is immutable.
   */
  updateClient(name: string, input: unknown): StoreResult {
    const existing = this.findClient(name);
    if (existing === undefined) {
      return failure([`no client with name ${quoted(name)}`]);
    }
    const checked = validateClientEntry(input, {
      others: (this.current.clients ?? []).filter((entry) => entry !== existing),
      existing,
      aliases: new Set((this.current.models ?? []).map((entry) => entry.alias)),
    });
    if (!checked.ok) return checked;
    return this.commit({
      clients: (this.current.clients ?? []).map((entry) => (entry === existing ? checked.value : entry)),
    });
  }

  /** Delete a client entry; refused when it is the block's last entry (removing the block would ungate the LLM surface). */
  removeClient(name: string): StoreResult {
    const existing = this.findClient(name);
    if (existing === undefined) {
      return failure([`no client with name ${quoted(name)}`]);
    }
    const clients = this.current.clients ?? [];
    if (clients.length === 1) {
      return failure(["cannot remove the last client entry — a present clients block keeps at least one entry"]);
    }
    return this.commit({ clients: clients.filter((entry) => entry !== existing) });
  }

  // -- persistence -----------------------------------------------------------

  /**
   * Write the current in-memory collections to the config file: read the
   * raw file, replace the three mutable sections, write a sibling temp file,
   * rename it onto the config file. The in-memory state does not change —
   * this is the disk-sync half of a mutation, public for a forced re-sync.
   */
  persist(): StoreResult {
    return this.writeThrough(this.collections());
  }

  // -- internals ---------------------------------------------------------------

  private collections(): StoreCollections {
    return {
      upstreams: this.current.upstreams,
      models: this.current.models,
      clients: this.current.clients,
    };
  }

  /**
   * The write-then-apply heart of every mutation: sync the candidate
   * collections to disk first, and rebuild the frozen normalized config only
   * after the write succeeded (ADR-014 D1 — a failed write leaves memory
   * untouched, so file and memory never diverge).
   */
  private commit(changed: Partial<StoreCollections>): StoreResult {
    const next: StoreCollections = { ...this.collections(), ...changed };
    const written = this.writeThrough(next);
    if (!written.ok) return written;
    this.current = deepFreeze({
      server: this.current.server,
      logLevel: this.current.logLevel,
      ...(this.current.auth !== undefined ? { auth: this.current.auth } : {}),
      ...(next.clients !== undefined ? { clients: next.clients } : {}),
      ...(next.models !== undefined ? { models: next.models } : {}),
      upstreams: next.upstreams,
    });
    return { ok: true };
  }

  /**
   * Read the raw config file, replace the mutable sections with `next`,
   * write the result to a sibling temp file and rename it onto the config
   * file (same directory, so the rename is a same-filesystem atomic
   * replace). All failure paths are value-free problem lines.
   */
  private writeThrough(next: StoreCollections): StoreResult {
    let rawText: string;
    try {
      rawText = readFileSync(this.configPath, "utf8");
    } catch (error) {
      return failure([persistFailureLine("read", this.configPath, error)]);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch {
      // The engine's parse message can quote file content, and these lines
      // may cross into HTTP error envelopes — name the file, not the text.
      return failure([`config file ${this.configPath} is not valid JSON — restore it before writing changes`]);
    }
    if (!isPlainObject(raw)) {
      return failure([`config file ${this.configPath} does not hold a JSON object at the root`]);
    }

    const output: Record<string, unknown> = { ...raw };
    output.upstreams = next.upstreams.map(upstreamEntryToJson);
    if (next.models === undefined) {
      delete output.models;
    } else {
      output.models = next.models.map(modelEntryToJson);
    }
    if (next.clients === undefined) {
      delete output.clients;
    } else {
      output.clients = next.clients.map(clientEntryToJson);
    }

    const tempPath = `${this.configPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`, { mode: persistedFileMode(this.configPath) });
      renameSync(tempPath, this.configPath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // nothing to clean up — the temp file was never created
      }
      return failure([persistFailureLine("write", this.configPath, error)]);
    }
    return { ok: true };
  }

  /** Problem lines for every model route that still names the upstream id (the `409 resource_in_use` evidence, D6). */
  private upstreamReferences(id: string): string[] {
    const lines: string[] = [];
    for (const model of this.current.models ?? []) {
      const routeIndexes: number[] = [];
      model.routes.forEach((route, index) => {
        if (route.upstream === id) routeIndexes.push(index);
      });
      if (routeIndexes.length > 0) {
        lines.push(
          `upstream ${quoted(id)} is still referenced by model ${quoted(model.alias)} (route${routeIndexes.length > 1 ? "s" : ""} ${routeIndexes.join(", ")})`,
        );
      }
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// per-entry write validators — the startup grammar, point-applied
// ---------------------------------------------------------------------------

/**
 * How one body value reads under the wire grammar (the header's table):
 * `absent` (the key was not sent), `clear` (`null` or the exact empty string
 * — one signal), `blank` (whitespace-only but not `""` — never a value), or
 * `value` (anything else, handed to the key's own grammar). Classified on
 * the RAW body, before the null rule drops `null` keys.
 */
type WireKind = "absent" | "clear" | "blank" | "value";

function wireKind(raw: unknown): WireKind {
  if (raw === undefined) return "absent";
  if (raw === null || raw === "") return "clear";
  if (typeof raw === "string" && raw.trim() === "") return "blank";
  return "value";
}

/** The value-free refusal for a whitespace-only optional value (`tlsFingerprint`, `proxy`). */
function blankOptionalProblem(entry: "upstream", key: "tlsFingerprint" | "proxy"): string {
  return `${entry}: ${key} must not be whitespace-only — send null or an empty string to clear, or a real value`;
}

/**
 * Resolve the required `apiKey` of one entry under the wire grammar. `raw` is
 * the body value before the null rule; `existing` is the stored credential on
 * an update (absent on a create). Returns the credential the entry carries,
 * or one value-free problem line. A credential can never be cleared, so the
 * clear signal on an update is refused; on a create `null` reads as missing
 * and `""` as empty — exactly the startup grammar. The mask literal is
 * rejected as a display fact, never a credential.
 */
function resolveApiKey(
  raw: unknown,
  context: { entry: "upstream" | "client"; existing?: string },
): { value: string } | { problem: string } {
  const entry = context.entry;
  const article = entry === "upstream" ? "an" : "a";
  switch (wireKind(raw)) {
    case "clear":
      if (context.existing === undefined) {
        return raw === null
          ? { problem: `${entry}: missing required key "apiKey"` }
          : { problem: `${entry}: apiKey must be a non-empty string` };
      }
      return {
        problem: `${entry}: apiKey cannot be cleared — ${article} ${entry} requires a credential; send a new value, or omit the field to keep the stored one`,
      };
    case "blank":
      return {
        problem: `${entry}: apiKey must not be whitespace-only — send the real credential, or omit the field to keep the stored one`,
      };
    case "absent":
      return context.existing === undefined
        ? { problem: `${entry}: missing required key "apiKey"` }
        : { value: context.existing };
    case "value":
      break;
  }
  if (typeof raw !== "string") {
    return { problem: `${entry}: apiKey must be a non-empty string` };
  }
  if (raw === CONFIGURED_MASK) {
    return {
      problem: `${entry}: apiKey must not be the literal ${quoted(CONFIGURED_MASK)} mask — send the real credential, or omit the field to keep the stored one`,
    };
  }
  return { value: raw };
}

/**
 * Validate one upstream entry for a create (`existing` absent) or an update
 * (`existing` present). The three wire-grammar keys — `apiKey`,
 * `tlsFingerprint`, `proxy` — are classified on the RAW body and resolved by
 * the header's table: absent keeps the stored value on update; `null` and
 * `""` are one clear signal (a refusal for the required credential, a clear
 * for the two optional fields); a whitespace-only value and the mask literal
 * are refused. Every other key follows the null rule through `withoutNulls`.
 * The id — given or inherited — must not collide with `others`. The returned
 * entry is normalized the same way the startup validator normalizes
 * (`normalizeBaseUrl`, `normalizeTlsFingerprint`, `normalizeProxy`) — an
 * empty pin or proxy never reaches the entry as `""`.
 */
function validateUpstreamEntry(
  given: unknown,
  context: { others: readonly UpstreamConfig[]; existing?: UpstreamConfig },
): Checked<UpstreamConfig> {
  const problems: string[] = [];
  if (!isPlainObject(given)) {
    return { ok: false, problems: ["upstream entry must be a JSON object"] };
  }

  for (const key of Object.keys(given)) {
    if (!UPSTREAM_KEYS.includes(key)) {
      problems.push(`upstream: unknown key "${key}" (valid keys: ${UPSTREAM_KEYS.join(", ")})`);
    }
  }

  // The grammar's null rule, point-applied: a `null` body value is the key
  // not set — `type`, `id` and `baseUrl` read exactly as if omitted (the
  // strict-key pass above still saw the raw body). The three wire-grammar
  // keys are NOT read through it: `apiKey` is classified on the raw body
  // below (a `null` must not read as "absent from the patch" on an update —
  // a credential cannot be cleared), and the two optional fields keep their
  // `null` so their explicit clear never collapses into "absent", which on
  // update means keep (D7).
  const input = withoutNulls(given, ["tlsFingerprint", "proxy"]);

  const type = input.type;
  let validType: UpstreamType | undefined;
  if (type === undefined) {
    problems.push(`upstream: missing required key "type" (registered upstream types: ${UPSTREAM_TYPES.join(", ")})`);
  } else if (!(UPSTREAM_TYPES as readonly unknown[]).includes(type)) {
    problems.push(
      `upstream: unknown upstream type ${quoted(type)} (registered upstream types: ${UPSTREAM_TYPES.join(", ")})`,
    );
  } else {
    validType = type as UpstreamType;
  }

  const id = input.id;
  let validId: string | undefined;
  if (id === undefined) {
    if (context.existing === undefined) {
      problems.push('upstream: missing required key "id"');
    } else {
      validId = context.existing.id;
    }
  } else if (typeof id !== "string" || !UPSTREAM_ID_PATTERN.test(id)) {
    problems.push(
      `upstream: upstream id ${quoted(id)} must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, hyphens; never "/")`,
    );
  } else if (context.existing !== undefined && id !== context.existing.id) {
    problems.push(
      `upstream: id ${quoted(id)} does not match the updated entry's id ${quoted(context.existing.id)} — an upstream id is immutable (delete and re-create to rename)`,
    );
  } else if (context.others.some((entry) => entry.id === id)) {
    problems.push(`upstream: duplicate upstream id ${quoted(id)}`);
  } else {
    validId = id;
  }

  const baseUrl = input.baseUrl;
  let validBaseUrl: string | undefined;
  if (baseUrl === undefined) {
    problems.push('upstream: missing required key "baseUrl"');
  } else if (typeof baseUrl !== "string" || !isHttpUrl(baseUrl)) {
    problems.push(
      `upstream: baseUrl ${typeof baseUrl === "string" ? quoted(baseUrl) : String(baseUrl)} must be an absolute http(s) URL including the API root with "/v1"`,
    );
  } else {
    validBaseUrl = normalizeBaseUrl(baseUrl);
  }

  // The apiKey value is never echoed into a problem line — it must never
  // reach a log, an error envelope or the management view
  // (specs/architecture/security-model.md). Read on the RAW body, before the
  // null rule, through the wire grammar: absent on update keeps the stored
  // credential (ADR-014 D7), the clear signal cannot clear a credential, a
  // whitespace-only value is refused, and the view's own mask literal is
  // rejected as input.
  let validApiKey: string | undefined;
  const apiKey = resolveApiKey(given.apiKey, { entry: "upstream", existing: context.existing?.apiKey });
  if ("problem" in apiKey) {
    problems.push(apiKey.problem);
  } else {
    validApiKey = apiKey.value;
  }

  // The pin value is never echoed into a problem line (apiKey-grade output
  // care, ADR-004). The wire grammar on the RAW body: absent — create → no
  // pin, update → keep the stored pin (never widen upstream trust by dropping
  // a pin silently); `null` or the exact empty string — one clear signal (on
  // create the same as absent); whitespace-only — refused (neither a value
  // nor a clear); anything else — the startup grammar, which strips every
  // whitespace character (a pin pasted with line wraps still matches), so a
  // stored entry never carries `tlsFingerprint: ""`.
  const tlsFingerprint = input.tlsFingerprint;
  let validPin: string | undefined;
  const pinKind = wireKind(given.tlsFingerprint);
  if (pinKind === "absent") {
    validPin = context.existing?.tlsFingerprint;
  } else if (pinKind === "clear") {
    validPin = undefined; // explicit clear
  } else if (pinKind === "blank") {
    problems.push(blankOptionalProblem("upstream", "tlsFingerprint"));
  } else if (typeof tlsFingerprint !== "string") {
    problems.push("upstream: tlsFingerprint must be a string — base64 of the SHA-256 SPKI digest (32 bytes)");
  } else if (tlsFingerprint === CONFIGURED_MASK) {
    problems.push(
      `upstream: tlsFingerprint must not be the literal ${quoted(CONFIGURED_MASK)} mask — send the pin value, or omit the field to keep the stored one`,
    );
  } else {
    const pin = normalizeTlsFingerprint(tlsFingerprint);
    if (pin === undefined) {
      validPin = undefined; // defensive: a non-blank string always normalizes to a value
    } else if (!isValidTlsFingerprint(pin)) {
      problems.push(
        "upstream: tlsFingerprint must be base64 (standard alphabet) decoding to exactly 32 bytes — compute it with tools/tls-fingerprint.ts",
      );
    } else {
      validPin = pin;
    }
  }

  // The proxy value is never echoed into a problem line — a pasted
  // `user:pass@host` URL carries credentials that must not reach an error
  // envelope or a log (ADR-017). The wire grammar on the RAW body: absent —
  // create → direct connection, update → keep the stored proxy (an omitted
  // field must never silently change the egress topology); `null` or the
  // exact empty string — one clear signal (on create the same as absent);
  // whitespace-only — refused; anything else — the startup grammar (trimmed,
  // then the http:/socks5: URL rules). The mask literal is not a URL, so it
  // fails that grammar.
  const proxy = input.proxy;
  let validProxy: string | undefined;
  const proxyKind = wireKind(given.proxy);
  if (proxyKind === "absent") {
    validProxy = context.existing?.proxy;
  } else if (proxyKind === "clear") {
    validProxy = undefined; // explicit clear
  } else if (proxyKind === "blank") {
    problems.push(blankOptionalProblem("upstream", "proxy"));
  } else if (typeof proxy !== "string") {
    problems.push(
      "upstream: proxy must be a string — an http: or socks5: URL with an explicit port, or null for a direct connection",
    );
  } else {
    const trimmed = normalizeProxy(proxy);
    if (trimmed === undefined) {
      validProxy = undefined; // defensive: a non-blank string always trims to a value
    } else if (!isValidProxyUrl(trimmed)) {
      problems.push(
        "upstream: proxy must be an http: or socks5: URL with a non-empty host, an explicit port in 1-65535, no username/password, and no path, query or fragment",
      );
    } else {
      validProxy = trimmed;
    }
  }

  if (problems.length > 0 || validType === undefined || validId === undefined || validBaseUrl === undefined || validApiKey === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: {
      type: validType,
      id: validId,
      baseUrl: validBaseUrl,
      apiKey: validApiKey,
      ...(validPin !== undefined ? { tlsFingerprint: validPin } : {}),
      ...(validProxy !== undefined ? { proxy: validProxy } : {}),
    },
  };
}

/**
 * Validate one model entry for a create or an update. Every route must name
 * a registered upstream id (`context.upstreamIds`), the balance strategy and
 * route weights must agree, and a present `limits` block carries at least
 * one positive integer — the startup validator's rules, point-applied. A
 * `null` body value is the key not set: a `null` `weight` is an unweighted
 * route, a `null` limit or `limits` block leaves the entry without it (an
 * update replaces those wholesale, so absent is cleared), and a `null`
 * `alias` is inherited from the updated entry like an omitted one.
 */
function validateModelEntry(
  given: unknown,
  context: { others: readonly ModelConfig[]; existing?: ModelConfig; upstreamIds: ReadonlySet<string> },
): Checked<ModelConfig> {
  const problems: string[] = [];
  if (!isPlainObject(given)) {
    return { ok: false, problems: ["model entry must be a JSON object"] };
  }

  for (const key of Object.keys(given)) {
    if (!MODEL_KEYS.includes(key)) {
      problems.push(`model: unknown key "${key}" (valid keys: ${MODEL_KEYS.join(", ")})`);
    }
  }

  const input = withoutNulls(given);

  const alias = input.alias;
  let validAlias: string | undefined;
  if (alias === undefined) {
    if (context.existing === undefined) {
      problems.push('model: missing required key "alias"');
    } else {
      validAlias = context.existing.alias;
    }
  } else if (typeof alias !== "string" || !isValidModelAlias(alias)) {
    problems.push(
      `model: model alias ${quoted(alias)} must be a non-empty string without "/" or whitespace ("/" is the upstream-prefix separator)`,
    );
  } else if (context.existing !== undefined && alias !== context.existing.alias) {
    problems.push(
      `model: alias ${quoted(alias)} does not match the updated entry's alias — a model alias is immutable (delete and re-create to rename)`,
    );
  } else if (context.others.some((entry) => entry.alias === alias)) {
    problems.push(`model: duplicate model alias ${quoted(alias)}`);
  } else {
    validAlias = alias;
  }

  const routes = input.routes;
  const validRoutes: ModelRouteConfig[] = [];
  if (!Array.isArray(routes) || routes.length === 0) {
    problems.push("model: routes must be an array with at least one route entry");
  } else {
    const seenPairs = new Set<string>();
    routes.forEach((rawRoute, routeIndex) => {
      if (!isPlainObject(rawRoute)) {
        problems.push(`model: routes[${routeIndex}] must be a JSON object`);
        return;
      }

      for (const key of Object.keys(rawRoute)) {
        if (!MODEL_ROUTE_KEYS.includes(key)) {
          problems.push(`model: routes[${routeIndex}]: unknown key "${key}" (valid keys: ${MODEL_ROUTE_KEYS.join(", ")})`);
        }
      }

      const route = withoutNulls(rawRoute);

      const routeUpstream = route.upstream;
      const routeModel = route.model;
      const upstreamOk = routeUpstream !== undefined && typeof routeUpstream === "string" && routeUpstream.length > 0;
      const modelOk = routeModel !== undefined && typeof routeModel === "string" && routeModel.length > 0;

      if (routeUpstream === undefined) {
        problems.push(`model: routes[${routeIndex}]: missing required key "upstream"`);
      } else if (!upstreamOk) {
        problems.push(
          `model: routes[${routeIndex}]: upstream must be a non-empty string naming an upstreams[].id`,
        );
      } else if (!context.upstreamIds.has(routeUpstream)) {
        // cross-reference: routes[].upstream → upstreams[].id
        problems.push(
          `model: routes[${routeIndex}]: unknown upstream ${quoted(routeUpstream)} — no upstreams[] entry declares this id`,
        );
      }

      if (routeModel === undefined) {
        problems.push(`model: routes[${routeIndex}]: missing required key "model"`);
      } else if (!modelOk) {
        problems.push(
          `model: routes[${routeIndex}]: model must be a non-empty string (the provider-native model name)`,
        );
      }

      const weight = route.weight;
      if (weight !== undefined && !isPositiveInteger(weight)) {
        problems.push(`model: routes[${routeIndex}]: weight must be a positive integer`);
      }

      if (upstreamOk && modelOk) {
        const pair = `${routeUpstream}/${routeModel}`;
        if (seenPairs.has(pair)) {
          problems.push(`model: duplicate route "${pair}" in the routes array`);
        } else {
          seenPairs.add(pair);
        }
      }

      if (upstreamOk && modelOk) {
        validRoutes.push({
          upstream: routeUpstream,
          model: routeModel,
          ...(typeof weight === "number" ? { weight } : {}),
        });
      }
    });
  }

  const balance = input.balance;
  let validStrategy: BalanceStrategy | undefined;
  if (balance === undefined) {
    problems.push('model: missing required key "balance"');
  } else if (!isPlainObject(balance)) {
    problems.push("model: balance must be a JSON object");
  } else {
    for (const key of Object.keys(balance)) {
      if (!BALANCE_KEYS.includes(key)) {
        problems.push(`model: balance: unknown key "${key}" (valid keys: ${BALANCE_KEYS.join(", ")})`);
      }
    }

    const strategy = balance.strategy;
    if (strategy === undefined) {
      problems.push('model: balance: missing required key "strategy"');
    } else if (!(BALANCE_STRATEGIES as readonly unknown[]).includes(strategy)) {
      problems.push(
        `model: balance: strategy must be one of: ${BALANCE_STRATEGIES.join(", ")} (got ${quoted(strategy)})`,
      );
    } else {
      validStrategy = strategy as BalanceStrategy;
      // strategy/weight consistency, exactly like the startup validator
      const weighted = strategy === "weighted-round-robin";
      if (Array.isArray(routes)) {
        routes.forEach((rawRoute, routeIndex) => {
          // the null-stripped view: a `null` weight is an unweighted route
          const route = isPlainObject(rawRoute) ? withoutNulls(rawRoute) : rawRoute;
          if (!isPlainObject(route)) return;
          if (weighted && route.weight === undefined) {
            problems.push(
              `model: routes[${routeIndex}]: weight is required when the balance strategy is "weighted-round-robin"`,
            );
          } else if (!weighted && route.weight !== undefined) {
            problems.push(
              `model: routes[${routeIndex}]: weight is only valid when the balance strategy is "weighted-round-robin" (strategy is "round-robin")`,
            );
          }
        });
      }
    }
  }

  const rawLimits = input.limits;
  let validLimits: ModelLimitsConfig | undefined;
  if (rawLimits !== undefined) {
    if (!isPlainObject(rawLimits)) {
      problems.push("model: limits must be a JSON object");
    } else {
      for (const key of Object.keys(rawLimits)) {
        if (!LIMITS_KEYS.includes(key)) {
          problems.push(`model: limits: unknown key "${key}" (valid keys: ${LIMITS_KEYS.join(", ")})`);
        }
      }
      const limits = withoutNulls(rawLimits);
      if (Object.keys(limits).length === 0) {
        problems.push('model: limits must carry at least one of "context", "output"');
      }
      const context = limits.context;
      if (context !== undefined && !isPositiveInteger(context)) {
        problems.push("model: limits: context must be a positive integer");
      }
      const output = limits.output;
      if (output !== undefined && !isPositiveInteger(output)) {
        problems.push("model: limits: output must be a positive integer");
      }
      validLimits = {
        ...(typeof context === "number" ? { context } : {}),
        ...(typeof output === "number" ? { output } : {}),
      };
    }
  }

  if (problems.length > 0 || validAlias === undefined || validStrategy === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: {
      alias: validAlias,
      routes: validRoutes,
      balance: { strategy: validStrategy },
      ...(validLimits !== undefined && Object.keys(validLimits).length > 0 ? { limits: validLimits } : {}),
    },
  };
}

/**
 * Validate one client entry for a create or an update. Every listed alias
 * must name a defined `models[].alias` (`context.aliases`). `apiKey` follows
 * the same wire grammar as an upstream's (the header's table), read on the
 * RAW body: absent keeps the stored credential on update, the clear signal
 * (`null` / `""`) cannot clear it, a whitespace-only value and the view's
 * mask literal are refused, and on a create `null` reads as missing and `""`
 * as empty. Every other key follows the null rule — it reads exactly as if
 * omitted.
 */
function validateClientEntry(
  given: unknown,
  context: { others: readonly ClientConfig[]; existing?: ClientConfig; aliases: ReadonlySet<string> },
): Checked<ClientConfig> {
  const problems: string[] = [];
  if (!isPlainObject(given)) {
    return { ok: false, problems: ["client entry must be a JSON object"] };
  }

  for (const key of Object.keys(given)) {
    if (!CLIENT_KEYS.includes(key)) {
      problems.push(`client: unknown key "${key}" (valid keys: ${CLIENT_KEYS.join(", ")})`);
    }
  }

  const input = withoutNulls(given);

  const name = input.name;
  let validName: string | undefined;
  if (name === undefined) {
    if (context.existing === undefined) {
      problems.push('client: missing required key "name"');
    } else {
      validName = context.existing.name;
    }
  } else if (typeof name !== "string" || name.length === 0) {
    problems.push("client: name must be a non-empty string");
  } else if (context.existing !== undefined && name !== context.existing.name) {
    problems.push(
      `client: name ${quoted(name)} does not match the updated entry's name ${quoted(context.existing.name)} — a client name is immutable (delete and re-create to rename)`,
    );
  } else if (context.others.some((entry) => entry.name === name)) {
    problems.push(`client: duplicate client name ${quoted(name)}`);
  } else {
    validName = name;
  }

  // apiKey-grade output care: the value never reaches a problem line
  // (specs/architecture/security-model.md). Read on the RAW body, before the
  // null rule, through the wire grammar: absent on update keeps the stored
  // credential, the clear signal cannot clear it, a whitespace-only value is
  // refused, and the view's mask literal is rejected as input.
  let validApiKey: string | undefined;
  const apiKey = resolveApiKey(given.apiKey, { entry: "client", existing: context.existing?.apiKey });
  if ("problem" in apiKey) {
    problems.push(apiKey.problem);
  } else {
    validApiKey = apiKey.value;
  }

  const clientModels = input.models;
  const validModels: string[] = [];
  if (!Array.isArray(clientModels) || clientModels.length === 0) {
    problems.push("client: models must be an array with at least one model alias");
  } else {
    const seenRefs = new Set<string>();
    clientModels.forEach((ref, refIndex) => {
      if (typeof ref !== "string" || ref.length === 0) {
        problems.push(`client: models[${refIndex}] must be a non-empty string naming a models[].alias`);
      } else if (seenRefs.has(ref)) {
        problems.push(`client: duplicate model alias ${quoted(ref)} in the models array`);
      } else {
        seenRefs.add(ref);
        if (!context.aliases.has(ref)) {
          // cross-reference: clients[].models → models[].alias
          problems.push(
            `client: models[${refIndex}]: unknown model alias ${quoted(ref)} — no models[] entry defines it`,
          );
        } else {
          validModels.push(ref);
        }
      }
    });
  }

  if (problems.length > 0 || validName === undefined || validApiKey === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: {
      name: validName,
      apiKey: validApiKey,
      models: validModels,
    },
  };
}

// ---------------------------------------------------------------------------
// serialization for the write-back — field by field, never spread
// ---------------------------------------------------------------------------

function upstreamEntryToJson(entry: UpstreamConfig): Record<string, unknown> {
  return {
    type: entry.type,
    id: entry.id,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    ...(entry.tlsFingerprint !== undefined ? { tlsFingerprint: entry.tlsFingerprint } : {}),
    ...(entry.proxy !== undefined ? { proxy: entry.proxy } : {}),
  };
}

function modelEntryToJson(entry: ModelConfig): Record<string, unknown> {
  return {
    alias: entry.alias,
    routes: entry.routes.map((route) => ({
      upstream: route.upstream,
      model: route.model,
      ...(route.weight !== undefined ? { weight: route.weight } : {}),
    })),
    balance: { strategy: entry.balance.strategy },
    ...(entry.limits !== undefined
      ? {
          limits: {
            ...(entry.limits.context !== undefined ? { context: entry.limits.context } : {}),
            ...(entry.limits.output !== undefined ? { output: entry.limits.output } : {}),
          },
        }
      : {}),
  };
}

function clientEntryToJson(entry: ClientConfig): Record<string, unknown> {
  return {
    name: entry.name,
    apiKey: entry.apiKey,
    models: [...entry.models],
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** A failed StoreResult carrying the given value-free problem lines. */
function failure(problems: string[]): StoreResult {
  return { ok: false, problems };
}

/**
 * Render a rejected value for a problem line; strings are quoted. Only ever
 * called on non-secret values — never on an apiKey or pin (the validators
 * construct credential problem lines without going through this).
 */
function quoted(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * The permissions the temp file is written with before the rename: the
 * config file's own mode, so the credentials inside never momentarily sit in
 * a world-readable temp file; `0o600` as the fallback when the file cannot
 * be stat'ed (it was just read successfully, so this is a narrow race).
 */
function persistedFileMode(configPath: string): number {
  try {
    return statSync(configPath).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/** A value-free failure line for a persist read/write: the operation, the path, the errno code. */
function persistFailureLine(operation: "read" | "write", configPath: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const action = operation === "read" ? "could not be read" : "could not be written";
  return `config file ${action}: ${configPath}${code !== undefined ? ` (${code})` : ""}`;
}
