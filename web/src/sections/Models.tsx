/**
 * Models section — configured aliases with their metadata aggregate, plus
 * the per-upstream live catalogs. The alias table reads `GET /api/models`
 * (loaded on mount, manual refresh): one row per configured alias with the
 * effective context window / output limit (`meta` — the aggregated minima)
 * and the strict-AND capability badges. The upstream cards come from
 * `GET /api/upstreams` (id, type, probe badge).
 *
 * Two operator-triggered upstream contacts ride the cards:
 * "Load models" (`GET /api/upstreams/:id/models`, ADR-011 — the live
 * catalog, filterable by model id, every id click-to-copy: the unprefixed
 * provider name that `models[].routes[].model` in config expects) and
 * "Discover" (`POST /api/upstreams/:id/discover`, ADR-014 D4 — one
 * re-probe, always-200 verdict whose inline outcome reads ok or the
 * log-safe reason). A finished discover re-reads `GET /api/models` so the
 * `meta` rows fold the refreshed metadata slices.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  discoverUpstream,
  fetchModels,
  fetchUpstreams,
  fetchUpstreamModels,
  type AliasCapabilities,
  type DiscoverResult,
  type ManagedModelAlias,
  type ManagedUpstream,
  type UpstreamModel,
} from "../api.ts";

/** One upstream's live listing state within this section visit. */
type Listing =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; models: readonly UpstreamModel[]; fetchedAt: string };

/** One discover run's state within this section visit (per upstream). */
type DiscoverRun =
  | { kind: "loading" }
  | { kind: "done"; result: DiscoverResult };

/** A finished discover run's inline verdict — the report's own shape: ok,
 * or the log-safe reason. Nothing while loading or untouched. */
function DiscoverOutcome({ run }: { run: DiscoverRun | undefined }): ReactNode {
  if (run?.kind !== "done") {
    return null;
  }
  return (
    <span className={`d-block small ${run.result.ok ? "text-success" : "text-danger"}`}>
      Discover: {run.result.ok ? "ok" : (run.result.reason ?? "failed")}
    </span>
  );
}

/** Clipboard write with a plain-DOM fallback for non-secure contexts. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy unavailable");
  } finally {
    document.body.removeChild(textarea);
  }
}

/** A model id rendered as a click-to-copy control with transient feedback. */
function CopyableModelId({ id }: { id: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (): Promise<void> => {
    try {
      await copyText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [id]);

  return (
    <button
      type="button"
      className="btn btn-link btn-sm p-0 text-start align-baseline"
      onClick={() => void copy()}
      title={`Copy model id "${id}"`}
    >
      <code>{copied ? "copied ✓" : id}</code>
    </button>
  );
}

/** The filtered, click-to-copy model table of one loaded listing. */
function ModelList({ models, upstreamId }: { models: readonly UpstreamModel[]; upstreamId: string }): ReactNode {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle === ""
    ? models
    : models.filter((model) => typeof model.id === "string" && model.id.toLowerCase().includes(needle));

  return (
    <>
      <input
        type="search"
        className="form-control form-control-sm mb-2"
        placeholder="Filter by model id…"
        aria-label={`Filter models of upstream ${upstreamId}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {models.length === 0 ? (
        <p className="text-body-secondary small mb-0">The upstream reports no models.</p>
      ) : visible.length === 0 ? (
        <p className="text-body-secondary small mb-0">No models match “{query.trim()}”.</p>
      ) : (
        <table className="table table-sm align-middle mb-2">
          <thead>
            <tr>
              <th scope="col">model id</th>
              <th scope="col">owned_by</th>
              <th scope="col">created</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((model) => (
              <tr key={model.id}>
                <td>
                  <CopyableModelId id={model.id} />
                </td>
                <td>{model.owned_by}</td>
                <td>
                  {typeof model.created === "number"
                    ? new Date(model.created * 1000).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-body-secondary small mb-0">
        Click a model id to copy it — paste it as a route’s <code>model</code> on the Models
        form, with <code>routes[].upstream</code> = <code>{upstreamId}</code>.
      </p>
    </>
  );
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
 * badges, and the configured route set (upstream + provider-native model).
 */
function AliasTable({ models }: { models: readonly ManagedModelAlias[] }): ReactNode {
  return (
    <div className="mb-4">
      <h2 className="h5">Aliases</h2>
      <table className="table table-sm align-middle">
        <thead>
          <tr>
            <th scope="col">alias</th>
            <th scope="col">context window</th>
            <th scope="col">output limit</th>
            <th scope="col">capabilities</th>
            <th scope="col">routes</th>
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
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-body-secondary small mb-0">
        Effective context window and output limit per configured alias — the
        aggregated minima over the alias’s routes; the capability badges show
        what every route declares. Unknown budgets render as “—”.
      </p>
    </div>
  );
}

/** One upstream card: probe state, its on-demand live listing, and its per-upstream "Discover". */
function UpstreamCard({
  upstream,
  listing,
  onLoad,
  discover,
  onDiscover,
}: {
  upstream: ManagedUpstream;
  listing: Listing;
  onLoad: (upstreamId: string) => void;
  discover: DiscoverRun | undefined;
  onDiscover: (upstreamId: string) => void;
}): ReactNode {
  const loading = listing.kind === "loading";
  const discovering = discover?.kind === "loading";
  return (
    <div className="card mb-3">
      <div className="card-header d-flex align-items-center justify-content-between gap-2">
        <span className="d-flex align-items-center gap-2">
          <code>{upstream.id}</code>
          <span className="text-body-secondary">{upstream.type}</span>
          {upstream.probe !== undefined && (
            <span
              className={`badge ${
                upstream.probe === "ok" ? "text-bg-success" : "text-bg-danger"
              }`}
            >
              {upstream.probe}
            </span>
          )}
        </span>
        <span className="d-flex align-items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => onDiscover(upstream.id)}
            disabled={discovering}
          >
            {discovering && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>}
            Discover
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            onClick={() => onLoad(upstream.id)}
            disabled={loading}
          >
            {loading && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>}
            {listing.kind === "loaded" ? "Reload models" : "Load models"}
          </button>
        </span>
      </div>
      <div className="card-body">
        <DiscoverOutcome run={discover} />
        {listing.kind === "idle" && (
          <p className="text-body-secondary small mb-0">
            Not loaded yet — “Load models” fetches the upstream’s current catalog live.
          </p>
        )}
        {listing.kind === "error" && (
          <div className="alert alert-danger py-2 small mb-0" role="alert">
            Failed to load models: {listing.message}
          </div>
        )}
        {listing.kind === "loaded" && (
          <>
            <p className="text-body-secondary small mb-2">
              {listing.models.length} model{listing.models.length === 1 ? "" : "s"} · fetched{" "}
              {new Date(listing.fetchedAt).toLocaleString()}
            </p>
            <ModelList models={listing.models} upstreamId={upstream.id} />
          </>
        )}
      </div>
    </div>
  );
}

export function ModelsSection(): ReactNode {
  const [models, setModels] = useState<readonly ManagedModelAlias[] | null>(null);
  const [upstreams, setUpstreams] = useState<readonly ManagedUpstream[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  /** Discover runs by upstream id. */
  const [runs, setRuns] = useState<Record<string, DiscoverRun>>({});

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
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

  // The post-discover refresh: re-read the alias catalog without the
  // full-section spinner, so refreshed `meta` rows fold in next to the
  // run's inline verdict.
  const refreshQuietly = useCallback(async (): Promise<void> => {
    try {
      setModels((await fetchModels()).models);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** One discover run per upstream: the always-200 verdict is the outcome
   * (its `reason` carries a failure); any outcome re-reads the catalog. */
  const runDiscover = useCallback(
    (upstreamId: string): void => {
      setRuns((current) => ({ ...current, [upstreamId]: { kind: "loading" } }));
      void (async (): Promise<void> => {
        let run: DiscoverRun;
        try {
          run = { kind: "done", result: await discoverUpstream(upstreamId) };
        } catch (cause) {
          // The 404/401 classes: the envelope's message is the verdict.
          run = {
            kind: "done",
            result: {
              upstream: upstreamId,
              ok: false,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          };
        }
        setRuns((current) => ({ ...current, [upstreamId]: run }));
        void refreshQuietly();
      })();
    },
    [refreshQuietly],
  );

  const load = useCallback((upstreamId: string): void => {
    setListings((current) => ({ ...current, [upstreamId]: { kind: "loading" } }));
    void (async (): Promise<void> => {
      try {
        const listing = await fetchUpstreamModels(upstreamId);
        setListings((current) => ({
          ...current,
          [upstreamId]: {
            kind: "loaded",
            models: listing.models,
            fetchedAt: listing.fetchedAt,
          },
        }));
      } catch (cause) {
        setListings((current) => ({
          ...current,
          [upstreamId]: {
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }));
      }
    })();
  }, []);

  return (
    <section aria-labelledby="models-heading">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0" id="models-heading">
          Models
        </h1>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => void refresh()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      <p className="text-body-secondary">
        Configured aliases with their effective token budgets, then every
        configured upstream with its probe state; each card loads the
        upstream’s live model catalog on demand, and Discover re-probes that
        one upstream.
      </p>

      {error !== null && (
        <div className="alert alert-danger" role="alert">
          Failed to load models: {error}
        </div>
      )}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <div className="spinner-border" aria-hidden="true"></div>
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {!loading && models !== null && (
        <>
          {models.length > 0 && <AliasTable models={models} />}
          {upstreams.length === 0 ? (
            <p className="text-body-secondary">No upstreams configured — add one under Upstreams.</p>
          ) : (
            upstreams.map((upstream) => (
              <UpstreamCard
                key={upstream.id}
                upstream={upstream}
                listing={listings[upstream.id] ?? { kind: "idle" }}
                onLoad={load}
                discover={runs[upstream.id]}
                onDiscover={runDiscover}
              />
            ))
          )}
        </>
      )}
    </section>
  );
}
