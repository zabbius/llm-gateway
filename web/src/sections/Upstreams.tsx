/**
 * Upstreams section — the upstreams collection's management surface
 * (ADR-014): every configured upstream in config order (id, type, probe
 * outcome, reason, baseUrl verbatim, the credential and pin masks exactly
 * as the redacted view serves them) plus create / edit / delete, and the
 * per-upstream live-model facilities: "Load models" (`GET
 * /api/upstreams/:id/models`, ADR-011 — the live catalog, filterable by
 * model id, every id click-to-copy: the unprefixed provider name that
 * `models[].routes[].model` in config expects) and "Discover" (`POST
 * /api/upstreams/:id/discover`, ADR-014 D4 — one re-probe, always-200
 * verdict whose inline outcome reads ok or the log-safe reason; a
 * successful run swaps the upstream's metadata slice, visible in the
 * Models section's `meta` rows on their next read).
 *
 * The form is inline (below the table): create fills every field, edit
 * disables the immutable id and leaves the key fields empty — an empty
 * `apiKey` is omitted from the request body, which the boundary reads as
 * "keep the stored credential" (ADR-014 D7; sending the `[Configured]`
 * mask back is refused, so the field is never pre-filled). The blocking
 * probe's outcome arrives as data in the create/update answer (D8) and is
 * rendered next to the save confirmation. Every failure — including a `409`
 * `resource_in_use` delete — surfaces as an alert carrying the OpenAI
 * envelope's message. Deletion is confirmed through the shared
 * ConfirmModal (Esc / backdrop / Cancel dismiss; only Delete proceeds).
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Copy, Download, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { Alert, Badge, Button, Card, Form, Spinner, Table } from "react-bootstrap";
import {
  CONFIGURED_MASK,
  createUpstream,
  deleteUpstream,
  discoverUpstream,
  fetchUpstreamModels,
  fetchUpstreams,
  updateUpstream,
  type DiscoverResult,
  type ManagedUpstream,
  type UpstreamModel,
  type UpstreamWriteRequest,
  type UpstreamWriteResponse,
} from "../api.ts";
import { ConfirmModal, type ConfirmDialog } from "../ui/ConfirmModal.tsx";

/** The one upstream implementation type the config grammar accepts today. */
const UPSTREAM_TYPES = ["openai-compatible"] as const;

/** One open editor: `null` = closed, `NEW` = create, otherwise the id being edited. */
const NEW_UPSTREAM = Symbol("new");
type Editor = null | typeof NEW_UPSTREAM | string;

/** Which fields the create form starts with; edit pre-fills everything but the key fields. */
interface FormState {
  type: string;
  id: string;
  baseUrl: string;
  apiKey: string;
  tlsFingerprint: string;
}

const EMPTY_FORM: FormState = { type: UPSTREAM_TYPES[0], id: "", baseUrl: "", apiKey: "", tlsFingerprint: "" };

function formFor(upstream: ManagedUpstream): FormState {
  return {
    type: upstream.type,
    id: upstream.id,
    baseUrl: upstream.baseUrl,
    // Never pre-fill the key fields: the mask is display fact, not a
    // credential (D7) — empty means "keep what is stored".
    apiKey: "",
    tlsFingerprint: "",
  };
}

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
    <Button
      type="button"
      variant="link"
      size="sm"
      className="p-0 text-start align-baseline"
      onClick={() => void copy()}
      title={`Copy model id "${id}"`}
    >
      <Copy aria-hidden="true" className="me-1 align-text-bottom" size={12} />
      <code>{copied ? "copied ✓" : id}</code>
    </Button>
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
      <Form.Control
        type="search"
        size="sm"
        className="mb-2"
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
        <Table size="sm" className="align-middle mb-2">
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
        </Table>
      )}
      <p className="text-body-secondary small mb-0">
        Click a model id to copy it — paste it as a route’s <code>model</code> on the Models
        form, with <code>routes[].upstream</code> = <code>{upstreamId}</code>.
      </p>
    </>
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
    <Card className="mb-3">
      <Card.Header className="d-flex align-items-center justify-content-between gap-2">
        <span className="d-flex align-items-center gap-2">
          <code>{upstream.id}</code>
          <span className="text-body-secondary">{upstream.type}</span>
          {upstream.probe !== undefined && (
            <Badge bg={upstream.probe === "ok" ? "success" : "danger"} text="white">
              {upstream.probe}
            </Badge>
          )}
        </span>
        <span className="d-flex align-items-center gap-2">
          <Button
            type="button"
            variant="outline-secondary"
            size="sm"
            onClick={() => onDiscover(upstream.id)}
            disabled={discovering}
          >
            {discovering && <Spinner as="span" size="sm" className="me-2" aria-hidden="true" />}
            <Search aria-hidden="true" className="me-1 align-text-bottom" size={14} />
            Discover
          </Button>
          <Button
            type="button"
            variant="outline-primary"
            size="sm"
            onClick={() => onLoad(upstream.id)}
            disabled={loading}
          >
            {loading && <Spinner as="span" size="sm" className="me-2" aria-hidden="true" />}
            <Download aria-hidden="true" className="me-1 align-text-bottom" size={14} />
            {listing.kind === "loaded" ? "Reload models" : "Load models"}
          </Button>
        </span>
      </Card.Header>
      <Card.Body>
        <DiscoverOutcome run={discover} />
        {listing.kind === "idle" && (
          <p className="text-body-secondary small mb-0">
            Not loaded yet — “Load models” fetches the upstream’s current catalog live.
          </p>
        )}
        {listing.kind === "error" && (
          <Alert variant="danger" className="py-2 small mb-0">
            Failed to load models: {listing.message}
          </Alert>
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
      </Card.Body>
    </Card>
  );
}

export function UpstreamsSection(): ReactNode {
  const [upstreams, setUpstreams] = useState<readonly ManagedUpstream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  /** The saved entry's probe verdict (D8) — data next to the confirmation. */
  const [probe, setProbe] = useState<UpstreamWriteResponse["probe"] | null>(null);
  /** Per-upstream live listing state ("Load models", ADR-011). */
  const [listings, setListings] = useState<Record<string, Listing>>({});
  /** Discover runs by upstream id (ADR-014 D4). */
  const [runs, setRuns] = useState<Record<string, DiscoverRun>>({});
  /** The pending delete confirmation — open exactly while non-null (ConfirmModal). */
  const [dialog, setDialog] = useState<ConfirmDialog | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setUpstreams((await fetchUpstreams()).upstreams);
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
    setProbe(null);
    setError(null);
    setForm(EMPTY_FORM);
    setEditor(NEW_UPSTREAM);
  };

  const openEdit = (upstream: ManagedUpstream): void => {
    setProbe(null);
    setError(null);
    setForm(formFor(upstream));
    setEditor(upstream.id);
  };

  const close = (): void => {
    setEditor(null);
    setForm(EMPTY_FORM);
    setProbe(null);
    setError(null);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const editing = typeof editor === "string";
    const body: UpstreamWriteRequest = {
      type: form.type,
      id: form.id.trim(),
      baseUrl: form.baseUrl.trim(),
      // Empty = unchanged (D7): the fields ride the body only when filled —
      // an absent apiKey keeps the stored credential, an absent pin keeps
      // the stored one; the mask literal is never submitted.
      ...(form.apiKey !== "" ? { apiKey: form.apiKey } : {}),
      ...(form.tlsFingerprint !== "" ? { tlsFingerprint: form.tlsFingerprint } : {}),
    };
    if (!editing && (form.id.trim() === "" || form.apiKey === "")) return; // create requires both

    setBusy(true);
    setProbe(null);
    void (async (): Promise<void> => {
      try {
        const answer = editing
          ? await updateUpstream(editor as string, body)
          : await createUpstream(body);
        setProbe(answer.probe);
        setEditor(null);
        setForm(EMPTY_FORM);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const remove = (upstream: ManagedUpstream): void => {
    setDialog({
      title: "Delete upstream",
      body: (
        <>
          Delete upstream <code>{upstream.id}</code>?
        </>
      ),
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => {
        setDialog(null);
        setBusy(true);
        setError(null);
        void (async (): Promise<void> => {
          try {
            await deleteUpstream(upstream.id);
            await refresh();
          } catch (cause) {
            // The 409 resource_in_use envelope's message (the referencing
            // models) and every other refusal land here, as an alert.
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        })();
      },
    });
  };

  /** One discover run per upstream: the always-200 verdict is the outcome
   * (its `reason` carries a failure). A successful run swaps the upstream's
   * metadata slice — the refreshed minima fold into the Models section's
   * `meta` rows on their next read; no re-read happens on this tab. */
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
      })();
    },
    [],
  );

  /** One live listing per upstream, on the explicit "Load models" click. */
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

  const editing = typeof editor === "string";

  return (
    <section aria-labelledby="upstreams-heading">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0" id="upstreams-heading">
          Upstreams
        </h1>
        <span className="d-flex align-items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={openCreate}
            disabled={editor !== null}
          >
            <Plus aria-hidden="true" className="me-1 align-text-bottom" size={14} />
            Add upstream
          </Button>
          <Button
            type="button"
            variant="outline-secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || editor !== null}
          >
            <RefreshCw aria-hidden="true" className="me-1 align-text-bottom" size={14} />
            Refresh
          </Button>
        </span>
      </div>
      <p className="text-body-secondary">
        Every configured upstream, in config order — create, edit, or delete;
        changes write through to config.json and hot-apply without a restart.
        Each card loads the upstream’s live model catalog on demand, and
        Discover re-probes that one upstream.
      </p>

      {error !== null && <Alert variant="danger">{error}</Alert>}

      {probe !== null && (
        <Alert variant={probe.ok ? "success" : "warning"} className="py-2" role="status">
          Saved. Probe: {probe.ok ? "ok" : `failed — ${probe.reason ?? "unknown reason"}`}
        </Alert>
      )}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <Spinner animation="border" aria-hidden="true" />
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {!loading && upstreams !== null && (
        upstreams.length === 0 ? (
          <p className="text-body-secondary">No upstreams configured — add the first one.</p>
        ) : (
          <Table className="align-middle">
            <thead>
              <tr>
                <th scope="col">id</th>
                <th scope="col">type</th>
                <th scope="col">probe</th>
                <th scope="col">reason</th>
                <th scope="col">baseUrl</th>
                <th scope="col">apiKey</th>
                <th scope="col">tls pin</th>
                <th scope="col">actions</th>
              </tr>
            </thead>
            <tbody>
              {upstreams.map((upstream) => (
                <tr key={upstream.id}>
                  <td>
                    <code>{upstream.id}</code>
                  </td>
                  <td>{upstream.type}</td>
                  <td>
                    {upstream.probe === undefined ? (
                      "—"
                    ) : (
                      <Badge bg={upstream.probe === "ok" ? "success" : "danger"} text="white">
                        {upstream.probe}
                      </Badge>
                    )}
                  </td>
                  <td>{upstream.reason ?? "—"}</td>
                  <td>
                    <code>{upstream.baseUrl}</code>
                  </td>
                  {/* The mask renders exactly as the read returned it. */}
                  <td>{upstream.apiKey}</td>
                  <td>{upstream.tlsFingerprint ?? "—"}</td>
                  <td>
                    <span className="d-inline-flex gap-1">
                      <Button
                        type="button"
                        variant="outline-secondary"
                        size="sm"
                        onClick={() => openEdit(upstream)}
                        disabled={editor !== null}
                      >
                        <Pencil aria-hidden="true" className="me-1 align-text-bottom" size={14} />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline-danger"
                        size="sm"
                        onClick={() => remove(upstream)}
                        disabled={busy || editor !== null}
                      >
                        <Trash2 aria-hidden="true" className="me-1 align-text-bottom" size={14} />
                        Delete
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      )}

      {!loading && upstreams !== null && upstreams.length > 0 && (
        <>
          {upstreams.map((upstream) => (
            <UpstreamCard
              key={upstream.id}
              upstream={upstream}
              listing={listings[upstream.id] ?? { kind: "idle" }}
              onLoad={load}
              discover={runs[upstream.id]}
              onDiscover={runDiscover}
            />
          ))}
        </>
      )}

      {editor !== null && (
        <Card as="form" className="mt-3" onSubmit={submit}>
          <Card.Body>
            <Card.Title as="h2" className="h5">
              {editing ? `Edit upstream ${editor}` : "Add upstream"}
            </Card.Title>
            <div className="row g-3">
              <Form.Group as="div" className="col-md-4" controlId="upstream-type">
                <Form.Label>type</Form.Label>
                <Form.Select
                  value={form.type}
                  onChange={(event) => setForm({ ...form, type: event.target.value })}
                >
                  {UPSTREAM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              <Form.Group as="div" className="col-md-4" controlId="upstream-id">
                <Form.Label>id</Form.Label>
                <Form.Control
                  value={form.id}
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                  disabled={editing}
                  required={!editing}
                />
                {editing && (
                  <div className="form-text">The id is immutable — the path parameter owns it.</div>
                )}
              </Form.Group>
              <Form.Group as="div" className="col-md-4" controlId="upstream-base-url">
                <Form.Label>baseUrl</Form.Label>
                <Form.Control
                  type="url"
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  required
                  placeholder="https://api.example.com/v1"
                />
              </Form.Group>
              <Form.Group as="div" className="col-md-6" controlId="upstream-api-key">
                <Form.Label>
                  apiKey {editing && <span className="text-body-secondary">(пусто = не менять)</span>}
                </Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  required={!editing}
                  placeholder={editing ? `пусто = не менять (сейчас ${CONFIGURED_MASK})` : "provider API key"}
                />
                <div className="form-text">
                  {editing
                    ? "Leave empty to keep the stored credential — the stored value is never served back."
                    : "Required on create; stored once, served back only as the mask."}
                </div>
              </Form.Group>
              <Form.Group as="div" className="col-md-6" controlId="upstream-tls-pin">
                <Form.Label>
                  tlsFingerprint {editing && <span className="text-body-secondary">(пусто = не менять)</span>}
                </Form.Label>
                <Form.Control
                  className="font-monospace"
                  value={form.tlsFingerprint}
                  onChange={(event) => setForm({ ...form, tlsFingerprint: event.target.value })}
                  placeholder={editing ? `пусто = не менять${upstreams?.find((u) => u.id === editor)?.tlsFingerprint == null ? " (сейчас не задан)" : ` (сейчас ${CONFIGURED_MASK})`}` : "optional SHA-256 pin"}
                />
                <div className="form-text">
                  Optional TLS certificate pin. Leave empty to keep the stored pin.
                </div>
              </Form.Group>
            </div>
            <div className="d-flex gap-2 mt-3">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy && <Spinner as="span" size="sm" className="me-2" aria-hidden="true" />}
                {editing ? <Save aria-hidden="true" className="me-1 align-text-bottom" size={16} /> : <Plus aria-hidden="true" className="me-1 align-text-bottom" size={16} />}
                {editing ? "Save" : "Create"}
              </Button>
              <Button type="button" variant="outline-secondary" onClick={close} disabled={busy}>
                <X aria-hidden="true" className="me-1 align-text-bottom" size={16} />
                Cancel
              </Button>
            </div>
            <p className="form-text mb-0 mt-2">
              Saving probes the upstream synchronously (within the probe budget) — a failed
              probe is reported, not cancelled: the change still lands.
            </p>
          </Card.Body>
        </Card>
      )}

      <ConfirmModal dialog={dialog} onDismiss={() => setDialog(null)} />
    </section>
  );
}
