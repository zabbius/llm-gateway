/**
 * The runtime configuration store (ADR-014, decision D1): the holder of the
 * current normalized config whose `upstreams`, `models` and `clients`
 * collections the management boundary mutates at runtime.
 *
 * A mutation validates the incoming entry against the current collections
 * with the same grammar helpers the startup validator uses
 * (`src/config/schema.ts` — patterns, `BALANCE_STRATEGIES`, `isHttpUrl`,
 * `isValidTlsFingerprint`, `isValidModelAlias`), then writes the resulting
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
 * Write-specific rules (ADR-014 D6/D7):
 * - An absent `apiKey` on an update keeps the stored credential — the
 *   masked management view never carries the value back, so the absent
 *   field is the only honest "unchanged". Create requires a key.
 * - The literal mask `[Configured]` (`CONFIGURED_MASK`,
 *   `src/config/redact.ts`) is rejected wherever a credential-shaped value
 *   is expected (`apiKey`, `tlsFingerprint`): the mask is a display fact,
 *   never an acceptable credential.
 * - An absent `tlsFingerprint` on an update keeps the stored pin (dropping
 *   a pin silently would widen upstream trust from fail-closed pinning to
 *   system-CA verification, ADR-004); an explicit `null` clears it.
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
  isValidTlsFingerprint,
  normalizeBaseUrl,
  normalizeTlsFingerprint,
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
   * except `apiKey` (absent → keep the stored credential) and
   * `tlsFingerprint` (absent → keep the stored pin, explicit `null` → clear
   * it). The id itself is immutable.
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
   * `limits` are replaced wholesale; the alias itself is immutable.
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
 * Validate one upstream entry for a create (`existing` absent) or an update
 * (`existing` present: an absent `apiKey` keeps the stored credential, an
 * absent `tlsFingerprint` keeps the stored pin, `null` clears it, and the id
 * — given or inherited — must not collide with `others`). The returned entry
 * is normalized the same way the startup validator normalizes
 * (`normalizeBaseUrl`, `normalizeTlsFingerprint`).
 */
function validateUpstreamEntry(
  input: unknown,
  context: { others: readonly UpstreamConfig[]; existing?: UpstreamConfig },
): Checked<UpstreamConfig> {
  const problems: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: ["upstream entry must be a JSON object"] };
  }

  for (const key of Object.keys(input)) {
    if (!UPSTREAM_KEYS.includes(key)) {
      problems.push(`upstream: unknown key "${key}" (valid keys: ${UPSTREAM_KEYS.join(", ")})`);
    }
  }

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
  // (specs/architecture/security-model.md). Absent on update = keep-existing
  // (ADR-014 D7); the view's own mask literal is rejected as input.
  const apiKey = input.apiKey;
  let validApiKey: string | undefined;
  if (apiKey === undefined) {
    if (context.existing === undefined) {
      problems.push('upstream: missing required key "apiKey"');
    } else {
      validApiKey = context.existing.apiKey;
    }
  } else if (typeof apiKey !== "string" || apiKey.length === 0) {
    problems.push("upstream: apiKey must be a non-empty string");
  } else if (apiKey === CONFIGURED_MASK) {
    problems.push(
      `upstream: apiKey must not be the literal ${quoted(CONFIGURED_MASK)} mask — send the real credential, or omit the field to keep the stored one`,
    );
  } else {
    validApiKey = apiKey;
  }

  const tlsFingerprint = input.tlsFingerprint;
  let validPin: string | undefined;
  if (tlsFingerprint === undefined) {
    // absent: create → no pin; update → keep the stored pin (never widen
    // upstream trust by dropping a pin silently, ADR-004)
    validPin = context.existing?.tlsFingerprint;
  } else if (tlsFingerprint === null) {
    validPin = undefined; // explicit clear
  } else if (typeof tlsFingerprint !== "string") {
    problems.push("upstream: tlsFingerprint must be a string — base64 of the SHA-256 SPKI digest (32 bytes)");
  } else if (tlsFingerprint === CONFIGURED_MASK) {
    problems.push(
      `upstream: tlsFingerprint must not be the literal ${quoted(CONFIGURED_MASK)} mask — send the pin value, or omit the field to keep the stored one`,
    );
  } else if (!isValidTlsFingerprint(tlsFingerprint)) {
    problems.push(
      "upstream: tlsFingerprint must be base64 (standard alphabet) decoding to exactly 32 bytes — compute it with tools/tls-fingerprint.ts",
    );
  } else {
    validPin = normalizeTlsFingerprint(tlsFingerprint);
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
    },
  };
}

/**
 * Validate one model entry for a create or an update. Every route must name
 * a registered upstream id (`context.upstreamIds`), the balance strategy and
 * route weights must agree, and a present `limits` block carries at least
 * one positive integer — the startup validator's rules, point-applied.
 */
function validateModelEntry(
  input: unknown,
  context: { others: readonly ModelConfig[]; existing?: ModelConfig; upstreamIds: ReadonlySet<string> },
): Checked<ModelConfig> {
  const problems: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: ["model entry must be a JSON object"] };
  }

  for (const key of Object.keys(input)) {
    if (!MODEL_KEYS.includes(key)) {
      problems.push(`model: unknown key "${key}" (valid keys: ${MODEL_KEYS.join(", ")})`);
    }
  }

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
    routes.forEach((route, routeIndex) => {
      if (!isPlainObject(route)) {
        problems.push(`model: routes[${routeIndex}] must be a JSON object`);
        return;
      }

      for (const key of Object.keys(route)) {
        if (!MODEL_ROUTE_KEYS.includes(key)) {
          problems.push(`model: routes[${routeIndex}]: unknown key "${key}" (valid keys: ${MODEL_ROUTE_KEYS.join(", ")})`);
        }
      }

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
        routes.forEach((route, routeIndex) => {
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

  const limits = input.limits;
  let validLimits: ModelLimitsConfig | undefined;
  if (limits !== undefined) {
    if (!isPlainObject(limits)) {
      problems.push("model: limits must be a JSON object");
    } else {
      for (const key of Object.keys(limits)) {
        if (!LIMITS_KEYS.includes(key)) {
          problems.push(`model: limits: unknown key "${key}" (valid keys: ${LIMITS_KEYS.join(", ")})`);
        }
      }
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
 * must name a defined `models[].alias` (`context.aliases`); an absent
 * `apiKey` on update keeps the stored credential; the view's mask literal is
 * rejected as a key.
 */
function validateClientEntry(
  input: unknown,
  context: { others: readonly ClientConfig[]; existing?: ClientConfig; aliases: ReadonlySet<string> },
): Checked<ClientConfig> {
  const problems: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: ["client entry must be a JSON object"] };
  }

  for (const key of Object.keys(input)) {
    if (!CLIENT_KEYS.includes(key)) {
      problems.push(`client: unknown key "${key}" (valid keys: ${CLIENT_KEYS.join(", ")})`);
    }
  }

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
  // (specs/architecture/security-model.md). Absent on update = keep-existing.
  const apiKey = input.apiKey;
  let validApiKey: string | undefined;
  if (apiKey === undefined) {
    if (context.existing === undefined) {
      problems.push('client: missing required key "apiKey"');
    } else {
      validApiKey = context.existing.apiKey;
    }
  } else if (typeof apiKey !== "string" || apiKey.length === 0) {
    problems.push("client: apiKey must be a non-empty string");
  } else if (apiKey === CONFIGURED_MASK) {
    problems.push(
      `client: apiKey must not be the literal ${quoted(CONFIGURED_MASK)} mask — send the real credential, or omit the field to keep the stored one`,
    );
  } else {
    validApiKey = apiKey;
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
