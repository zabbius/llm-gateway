/**
 * Models section — the models collection's management surface (ADR-014,
 * the ADR-009 alias table): every configured alias in config order with its
 * metadata aggregate (`meta` — the effective context window / output limit,
 * the aggregated minima over the alias's routes, and the strict-AND
 * capability badges) plus create / edit / delete.
 *
 * The form is inline (below the table): the alias is immutable on edit —
 * the path parameter owns it; routes, balance strategy and limits are
 * replaced wholesale by an update. Client-side checks mirror the store's
 * entry grammar (the alias pattern, at least one route, non-empty
 * provider-native model, no duplicate upstream/model pair, the
 * strategy/weight consistency, the limits rules); the store stays
 * authoritative — its value-free `400` problem lines surface as the
 * envelope's message in the alert, as do `404` (unknown alias) and the `409`
 * `resource_in_use` delete refusals naming the referencing clients.
 * A route's `model` takes no manual input: the row's select is fed by the
 * upstream's live catalog — opening the dropdown fires the one
 * `GET /api/upstreams/:id/models` fetch per upstream per editor visit
 * (ADR-011 semantics — fired only by the operator opening the select,
 * never on mount or form open), and picking a listed id sets the field; a
 * stored value renders as a plain option — the field never annotates it
 * with catalog provenance. The per-upstream live catalogs and discover
 * runs live on the Upstreams section.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  createModel,
  deleteModel,
  fetchModels,
  fetchUpstreamModels,
  fetchUpstreams,
  updateModel,
  type AliasCapabilities,
  type ManagedModelAlias,
  type ManagedUpstream,
  type ModelAliasWriteRequest,
  type UpstreamModel,
} from "../api.ts";

/** The load-balancing strategies an entry's `balance` block may select
 * between — the config grammar's vocabulary (src/config/schema.ts). */
const BALANCE_STRATEGIES = ["round-robin", "weighted-round-robin"] as const;
type BalanceStrategy = (typeof BALANCE_STRATEGIES)[number];

/**
 * Model alias grammar: any non-empty string without whitespace and without
 * "/" — the client-facing model id, and "/" is reserved so the id stays a
 * single URL path segment (ADR-009; mirrors `MODEL_ALIAS_PATTERN` in
 * src/config/schema.ts, where the store re-validates authoritatively).
 */
const MODEL_ALIAS_PATTERN = /^[^\s/]+$/;

/** One editable route row of the form; `weight` stays a raw input string. */
interface RouteForm {
  upstream: string;
  model: string;
  weight: string;
}

/** The whole editor form; limits stay raw input strings (empty = absent). */
interface FormState {
  alias: string;
  routes: RouteForm[];
  strategy: BalanceStrategy;
  context: string;
  output: string;
}

const emptyRoute = (): RouteForm => ({ upstream: "", model: "", weight: "" });

/** One open editor: `null` = closed, `NEW_ALIAS` = create, otherwise the alias being edited. */
const NEW_ALIAS = Symbol("new");

const EMPTY_FORM: FormState = {
  alias: "",
  routes: [emptyRoute()],
  strategy: "round-robin",
  context: "",
  output: "",
};

/** Edit pre-fills everything; nothing here is secret (the block has no
 * credentials), so the entry's current values are the form's starting point. */
function formFor(entry: ManagedModelAlias): FormState {
  const limits = entry.limits;
  return {
    alias: entry.alias,
    routes: entry.routes.map((route) => ({
      upstream: route.upstream,
      model: route.model,
      weight: route.weight === null ? "" : String(route.weight),
    })),
    strategy: entry.balance.strategy,
    context: limits?.context == null ? "" : String(limits.context),
    output: limits?.output == null ? "" : String(limits.output),
  };
}

/** A positive integer, or null when the raw string is empty (absent). */
function positiveIntegerOrEmpty(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** One upstream's live-catalog fetch state; the state map never stores
 * `idle` — the render site substitutes it for a missing entry. */
type Catalog =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; models: readonly UpstreamModel[]; fetchedAt: string };

/** The render-site idle substitution — the catalog state map never stores
 * `idle`; a route with no upstream (or no fetched state) renders this. */
const IDLE_CATALOG: Catalog = { kind: "idle" };

/** One route row's `model` select — no manual input: the options come from
 * the upstream's live catalog (fetched by the select's open gesture,
 * ADR-011); a stored value renders as a plain option (no catalog
 * annotation) until the loaded catalog supersedes it, and the loading /
 * error / empty states are options inside the dropdown. The loaded / error
 * status text lives in `RouteCatalogStatus`, below the row — this
 * component renders the select alone so its states never shift it. */
function RouteModelSelect({
  domId,
  route,
  catalog,
  onChange,
  onOpen,
}: {
  domId: string;
  route: RouteForm;
  catalog: Catalog;
  onChange: (model: string) => void;
  onOpen: () => void;
}): ReactNode {
  const catalogIds =
    catalog.kind === "loaded" ? [...new Set(catalog.models.map((model) => model.id))] : [];
  return (
    <select
      id={domId}
      className="form-select"
      value={route.model}
      onChange={(event) => onChange(event.target.value)}
      onMouseDown={onOpen}
      onFocus={onOpen}
      disabled={route.upstream === ""}
      required
      title={
        route.upstream === ""
          ? "Pick the upstream first — the model list comes from its live catalog"
          : "Provider-native model names from this upstream's live catalog"
      }
    >
      <option value="" disabled>
        {route.upstream === "" ? "— choose an upstream first —" : "— choose a model —"}
      </option>
      {route.model !== "" && !catalogIds.includes(route.model) && (
        <option value={route.model}>{route.model}</option>
      )}
      {catalog.kind === "loading" && <option disabled>loading the live catalog…</option>}
      {catalog.kind === "error" && <option disabled>failed to load — reopen to retry</option>}
      {catalog.kind === "loaded" && catalogIds.length === 0 && (
        <option disabled>the upstream reports no models</option>
      )}
      {catalogIds.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}

/** The route row's catalog status — loaded (the unique-model count and the
 * fetch time) or failed (the error; reopening the select retries) —
 * rendered BELOW the row, in a grid column aligned under the model field:
 * it moves only what follows the row, never the row's own columns (the
 * select's open gesture must not shift the label, the input, or their
 * neighbors). */
function RouteCatalogStatus({ catalog }: { catalog: Catalog }): ReactNode {
  if (catalog.kind === "loaded") {
    const catalogIds = [...new Set(catalog.models.map((model) => model.id))];
    return (
      <div className="row">
        <div className="col-md-4 offset-md-4">
          <div className="form-text">
            {catalogIds.length} model{catalogIds.length === 1 ? "" : "s"} · fetched{" "}
            {new Date(catalog.fetchedAt).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }
  if (catalog.kind === "error") {
    return (
      <div className="row">
        <div className="col-md-4 offset-md-4">
          <div className="form-text text-danger">Failed to load models: {catalog.message}</div>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * The client-side pass over the store's entry grammar — convenience only:
 * every violation here is a visible alert, and the store re-validates the
 * submitted body authoritatively (its `400` problem lines land as alerts).
 */
function validateForm(form: FormState, aliases: readonly string[], editing: boolean): string | null {
  if (!editing) {
    const alias = form.alias.trim();
    if (alias === "") return "alias is required.";
    if (!MODEL_ALIAS_PATTERN.test(alias)) {
      return `alias "${alias}" must be a non-empty string without whitespace or "/" ("/" is the upstream-prefix separator).`;
    }
    if (aliases.includes(alias)) return `duplicate alias "${alias}" — aliases are unique across the table.`;
  }
  if (form.routes.length === 0) return "at least one route is required.";
  const seen = new Set<string>();
  for (const [index, row] of form.routes.entries()) {
    const label = `route ${index + 1}`;
    const model = row.model.trim();
    if (row.upstream === "") return `${label}: pick the upstream.`;
    if (model === "") return `${label}: model is required (the provider-native model name).`;
    const pair = `${row.upstream}/${model}`;
    if (seen.has(pair)) return `duplicate route "${pair}" in the routes array.`;
    seen.add(pair);
    if (form.strategy === "weighted-round-robin") {
      if (positiveIntegerOrEmpty(row.weight) === undefined || positiveIntegerOrEmpty(row.weight) === null) {
        return `${label}: weight must be a positive integer — the weighted strategy requires one on every route.`;
      }
    }
  }
  for (const [name, raw] of [["context", form.context], ["output", form.output]] as const) {
    if (positiveIntegerOrEmpty(raw) === undefined) return `limits.${name} must be a positive integer.`;
  }
  return null;
}

/** The strict-AND capability declaration as one badge per flag. */
function CapabilityBadges({ capabilities }: { capabilities: AliasCapabilities }): ReactNode {
  const flags: ReadonlyArray<{ label: string; on: boolean }> = [
    { label: "attachment", on: capabilities.attachment },
    { label: "reasoning", on: capabilities.reasoning },
    { label: "temperature", on: capabilities.temperature },
    { label: "toolCall", on: capabilities.toolCall },
  ];
  return (
    <span className="d-inline-flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span
          key={flag.label}
          className={`badge ${flag.on ? "text-bg-success" : "text-bg-light border"}`}
        >
          {flag.label}
        </span>
      ))}
    </span>
  );
}

/**
 * The alias table: one row per configured alias (`GET /api/models`) with
 * the effective context window / output limit (the `meta` aggregate —
 * aggregated minima over the alias's routes; unknown → “—”), the capability
 * badges, the configured route set, and the row actions.
 */
function AliasTable({
  models,
  onEdit,
  onDelete,
  locked,
}: {
  models: readonly ManagedModelAlias[];
  onEdit: (entry: ManagedModelAlias) => void;
  onDelete: (entry: ManagedModelAlias) => void;
  locked: boolean;
}): ReactNode {
  return (
    <table className="table table-sm align-middle">
      <thead>
        <tr>
          <th scope="col">alias</th>
          <th scope="col">context window</th>
          <th scope="col">output limit</th>
          <th scope="col">capabilities</th>
          <th scope="col">routes</th>
          <th scope="col">actions</th>
        </tr>
      </thead>
      <tbody>
        {models.map((entry) => (
          <tr key={entry.alias}>
            <td>
              <code>{entry.alias}</code>
            </td>
            <td>{entry.meta.contextWindow === null ? "—" : entry.meta.contextWindow.toLocaleString()}</td>
            <td>{entry.meta.outputLimit === null ? "—" : entry.meta.outputLimit.toLocaleString()}</td>
            <td>
              {entry.meta.capabilities === null ? "—" : <CapabilityBadges capabilities={entry.meta.capabilities} />}
            </td>
            <td>
              {entry.routes.map((route) => (
                <span key={`${route.upstream}/${route.model}`} className="d-block small">
                  <code>{route.upstream}</code>
                  {" → "}
                  <code>{route.model}</code>
                  {route.weight !== null && <span className="text-body-secondary"> · w{route.weight}</span>}
                </span>
              ))}
            </td>
            <td>
              <span className="d-inline-flex gap-1">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => onEdit(entry)}
                  disabled={locked}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  onClick={() => onDelete(entry)}
                  disabled={locked}
                >
                  Delete
                </button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ModelsSection(): ReactNode {
  const [models, setModels] = useState<readonly ManagedModelAlias[] | null>(null);
  const [upstreams, setUpstreams] = useState<readonly ManagedUpstream[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<null | typeof NEW_ALIAS | string>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  /** Per-upstream live-catalog state within this editor visit (ADR-011). */
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  /** Synchronous snapshot of `catalogs` for the open-gesture guard, and the
   * upstreams with a fetch in flight (mousedown and focus fire together). */
  const catalogsRef = useRef(catalogs);
  const fetchingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    catalogsRef.current = catalogs;
  }, [catalogs]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // The upstream ids feed the route editor's select; aliases ride along.
      const [aliasList, upstreamList] = await Promise.all([fetchModels(), fetchUpstreams()]);
      setModels(aliasList.models);
      setUpstreams(upstreamList.upstreams);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCreate = (): void => {
    setError(null);
    setForm(EMPTY_FORM);
    setEditor(NEW_ALIAS);
  };

  const openEdit = (entry: ManagedModelAlias): void => {
    setError(null);
    setForm(formFor(entry));
    setEditor(entry.alias);
  };

  const close = (): void => {
    setEditor(null);
    setForm(EMPTY_FORM);
    setError(null);
    setCatalogs({});
  };

  /** The model select's open gesture (mousedown or focus) fires the one
   * live-catalog fetch per upstream per editor visit (ADR-011 — never on
   * mount or form open). A loaded catalog is reused for the visit; a
   * failed one retries on the next open. Errors stay select state, not
   * alerts. */
  const ensureCatalog = useCallback((upstreamId: string): void => {
    if (upstreamId === "" || fetchingRef.current.has(upstreamId)) return;
    const existing = catalogsRef.current[upstreamId];
    if (existing !== undefined && existing.kind !== "error") return;
    fetchingRef.current.add(upstreamId);
    setCatalogs((current) => ({ ...current, [upstreamId]: { kind: "loading" } }));
    void (async (): Promise<void> => {
      try {
        const listing = await fetchUpstreamModels(upstreamId);
        setCatalogs((current) => ({
          ...current,
          [upstreamId]: {
            kind: "loaded",
            models: listing.models,
            fetchedAt: listing.fetchedAt,
          },
        }));
      } catch (cause) {
        setCatalogs((current) => ({
          ...current,
          [upstreamId]: {
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }));
      } finally {
        fetchingRef.current.delete(upstreamId);
      }
    })();
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const editing = typeof editor === "string";
    const problem = validateForm(form, (models ?? []).map((entry) => entry.alias), editing);
    if (problem !== null) {
      setError(problem);
      return;
    }
    const routes = form.routes.map((row) => ({
      upstream: row.upstream,
      model: row.model.trim(),
      // The weight rides only with the weighted strategy (the grammar
      // rejects weights under round-robin and requires them otherwise).
      ...(form.strategy === "weighted-round-robin"
        ? { weight: positiveIntegerOrEmpty(row.weight) as number }
        : {}),
    }));
    const limits: { context?: number; output?: number } = {};
    const context = positiveIntegerOrEmpty(form.context);
    const output = positiveIntegerOrEmpty(form.output);
    if (typeof context === "number") limits.context = context;
    if (typeof output === "number") limits.output = output;
    const body: ModelAliasWriteRequest = {
      routes,
      balance: { strategy: form.strategy },
      // A present limits block always carries at least one key (the grammar
      // refuses an empty one); absent block = no limits.
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      // The path parameter owns the alias on update — it rides the body on
      // create only.
      ...(editing ? {} : { alias: form.alias.trim() }),
    };

    setBusy(true);
    void (async (): Promise<void> => {
      try {
        if (editing) {
          await updateModel(editor as string, body);
        } else {
          await createModel(body);
        }
        close();
        await refresh();
      } catch (cause) {
        // 400 problem lines (grammar, duplicates, unknown route upstream),
        // 404 on an unknown alias — the envelope's message, as an alert.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const remove = (entry: ManagedModelAlias): void => {
    if (!window.confirm(`Delete alias "${entry.alias}"? The next /llm/v1 request naming it answers 404.`)) return;
    setBusy(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        await deleteModel(entry.alias);
        // An open editor on the deleted alias is closed by the refresh below
        // (the row is gone; the editor state resets with the table).
        await refresh();
      } catch (cause) {
        // 409 resource_in_use (a client's ACL names the alias), 400 on the
        // block's last entry — the envelope's message, as an alert.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const editing = typeof editor === "string";
  const weighted = form.strategy === "weighted-round-robin";

  return (
    <section aria-labelledby="models-heading">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0" id="models-heading">
          Models
        </h1>
        <span className="d-flex align-items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={openCreate}
            disabled={editor !== null}
          >
            Add alias
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => void refresh()}
            disabled={loading || editor !== null}
          >
            Refresh
          </button>
        </span>
      </div>
      <p className="text-body-secondary">
        Every configured alias with its effective token budgets and capability
        badges, in config order — create, edit, or delete; changes rebuild the
        routing table and hot-apply without a restart (a deleted alias answers
        404 on the next request). The per-upstream live catalogs and discover
        runs live on the Upstreams section.
      </p>

      {error !== null && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <div className="spinner-border" aria-hidden="true"></div>
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {!loading && models !== null && (
        models.length === 0 ? (
          <p className="text-body-secondary">No aliases configured — add the first one.</p>
        ) : (
          <AliasTable models={models} onEdit={openEdit} onDelete={remove} locked={editor !== null || busy} />
        )
      )}

      {editor !== null && (
        <form className="card mt-3" onSubmit={submit}>
          <div className="card-body">
            <h2 className="h5 card-title">{editing ? `Edit alias ${editor}` : "Add alias"}</h2>
            <div className="row g-3">
              <div className="col-md-4">
                <label className="form-label" htmlFor="model-alias">
                  alias
                </label>
                <input
                  id="model-alias"
                  className="form-control"
                  value={form.alias}
                  onChange={(event) => setForm({ ...form, alias: event.target.value })}
                  disabled={editing}
                  required={!editing}
                  placeholder="client-facing model id"
                />
                {editing ? (
                  <div className="form-text">The alias is immutable — the path parameter owns it.</div>
                ) : (
                  <div className="form-text">No whitespace, no “/” (the upstream-prefix separator); unique.</div>
                )}
              </div>
              <div className="col-md-4">
                <label className="form-label" htmlFor="model-strategy">
                  balance.strategy
                </label>
                <select
                  id="model-strategy"
                  className="form-select"
                  value={form.strategy}
                  onChange={(event) =>
                    setForm({ ...form, strategy: event.target.value as BalanceStrategy })
                  }
                >
                  {BALANCE_STRATEGIES.map((strategy) => (
                    <option key={strategy} value={strategy}>
                      {strategy}
                    </option>
                  ))}
                </select>
                <div className="form-text">
                  {weighted
                    ? "Weighted rotation — every route needs a positive integer weight."
                    : "Routes rotate in config order; weights are not allowed."}
                </div>
              </div>
            </div>

            <label className="form-label mt-3">routes</label>
            <div className="d-flex flex-column gap-2">
              {form.routes.map((route, index) => {
                const catalog: Catalog =
                  route.upstream === "" ? IDLE_CATALOG : (catalogs[route.upstream] ?? IDLE_CATALOG);
                return (
                  <div key={index}>
                    <div className="row g-2 align-items-end">
                      <div className="col-md-4">
                        <label className="form-label small text-body-secondary" htmlFor={`route-upstream-${index}`}>
                          upstream {index + 1}
                        </label>
                        <select
                          id={`route-upstream-${index}`}
                          className="form-select"
                          value={route.upstream}
                          onChange={(event) =>
                            // a model belongs to its upstream — switching resets the pick
                            setForm({
                              ...form,
                              routes: form.routes.map((row, i) =>
                                i === index ? { ...row, upstream: event.target.value, model: "" } : row,
                              ),
                            })
                          }
                          required
                        >
                          <option value="" disabled>
                            — choose upstream —
                          </option>
                          {upstreams.map((upstream) => (
                            <option key={upstream.id} value={upstream.id}>
                              {upstream.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small text-body-secondary" htmlFor={`route-model-${index}`}>
                          model
                        </label>
                        <RouteModelSelect
                          domId={`route-model-${index}`}
                          route={route}
                          catalog={catalog}
                          onChange={(model) =>
                            setForm({
                              ...form,
                              routes: form.routes.map((row, i) =>
                                i === index ? { ...row, model } : row,
                              ),
                            })
                          }
                          onOpen={() => ensureCatalog(route.upstream)}
                        />
                      </div>
                      <div className={weighted ? "col-md-2" : "col-md-2 d-none"}>
                        <label className="form-label small text-body-secondary" htmlFor={`route-weight-${index}`}>
                          weight
                        </label>
                        <input
                          id={`route-weight-${index}`}
                          className="form-control"
                          type="number"
                          min={1}
                          step={1}
                          value={route.weight}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              routes: form.routes.map((row, i) =>
                                i === index ? { ...row, weight: event.target.value } : row,
                              ),
                            })
                          }
                          required={weighted}
                          placeholder="w"
                        />
                      </div>
                      <div className="col-md-2">
                        {/* the control-only column: the full-size button
                            matches the selects' height, so the row's shared
                            bottom alignment centers it on their centers */}
                        <button
                          type="button"
                          className="btn btn-outline-danger w-100"
                          onClick={() =>
                            setForm({ ...form, routes: form.routes.filter((_, i) => i !== index) })
                          }
                          disabled={form.routes.length === 1}
                          title={form.routes.length === 1 ? "At least one route is required" : "Remove route"}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    {/* the catalog status renders below the row — it moves
                        only what follows the row, never the row's columns */}
                    <RouteCatalogStatus catalog={catalog} />
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary mt-2"
              onClick={() => setForm({ ...form, routes: [...form.routes, emptyRoute()] })}
            >
              Add route
            </button>
            {upstreams.length === 0 && (
              <div className="form-text">
                No upstreams configured — add one under Upstreams first; every route names a configured upstream id.
              </div>
            )}

            <div className="row g-3 mt-1">
              <div className="col-md-3">
                <label className="form-label" htmlFor="model-limits-context">
                  limits.context
                </label>
                <input
                  id="model-limits-context"
                  className="form-control"
                  type="number"
                  min={1}
                  step={1}
                  value={form.context}
                  onChange={(event) => setForm({ ...form, context: event.target.value })}
                  placeholder="optional"
                />
              </div>
              <div className="col-md-3">
                <label className="form-label" htmlFor="model-limits-output">
                  limits.output
                </label>
                <input
                  id="model-limits-output"
                  className="form-control"
                  type="number"
                  min={1}
                  step={1}
                  value={form.output}
                  onChange={(event) => setForm({ ...form, output: event.target.value })}
                  placeholder="optional"
                />
                <div className="form-text">Optional manual budgets; both empty = no limits block.</div>
              </div>
            </div>

            <div className="d-flex gap-2 mt-3">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>}
                {editing ? "Save" : "Create"}
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={close} disabled={busy}>
                Cancel
              </button>
            </div>
            <p className="form-text mb-0 mt-2">
              Saving validates and persists to config.json, then hot-applies —
              update replaces routes, balance and limits wholesale; the alias
              itself is immutable.
            </p>
          </div>
        </form>
      )}
    </section>
  );
}
