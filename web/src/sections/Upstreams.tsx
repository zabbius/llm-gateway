/**
 * Upstreams section — the upstreams collection's management surface
 * (ADR-014): every configured upstream in config order (id, type, probe
 * outcome, reason, baseUrl verbatim, the credential and pin masks exactly
 * as the redacted view serves them) plus create / edit / delete.
 *
 * The form is inline (below the table): create fills every field, edit
 * disables the immutable id and leaves the key fields empty — an empty
 * `apiKey` is omitted from the request body, which the boundary reads as
 * "keep the stored credential" (ADR-014 D7; sending the `[Configured]`
 * mask back is refused, so the field is never pre-filled). The blocking
 * probe's outcome arrives as data in the create/update answer (D8) and is
 * rendered next to the save confirmation. Every failure — including a `409`
 * `resource_in_use` delete — surfaces as an alert carrying the OpenAI
 * envelope's message.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CONFIGURED_MASK,
  createUpstream,
  deleteUpstream,
  fetchUpstreams,
  updateUpstream,
  type ManagedUpstream,
  type UpstreamWriteRequest,
  type UpstreamWriteResponse,
} from "../api.ts";

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

export function UpstreamsSection(): ReactNode {
  const [upstreams, setUpstreams] = useState<readonly ManagedUpstream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  /** The saved entry's probe verdict (D8) — data next to the confirmation. */
  const [probe, setProbe] = useState<UpstreamWriteResponse["probe"] | null>(null);

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
    if (!window.confirm(`Delete upstream "${upstream.id}"?`)) return;
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
  };

  const editing = typeof editor === "string";

  return (
    <section aria-labelledby="upstreams-heading">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0" id="upstreams-heading">
          Upstreams
        </h1>
        <span className="d-flex align-items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={openCreate}
            disabled={editor !== null}
          >
            Add upstream
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
        Every configured upstream, in config order — create, edit, or delete;
        changes write through to config.json and hot-apply without a restart.
      </p>

      {error !== null && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {probe !== null && (
        <div className={`alert ${probe.ok ? "alert-success" : "alert-warning"} py-2`} role="status">
          Saved. Probe: {probe.ok ? "ok" : `failed — ${probe.reason ?? "unknown reason"}`}
        </div>
      )}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <div className="spinner-border" aria-hidden="true"></div>
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {!loading && upstreams !== null && (
        upstreams.length === 0 ? (
          <p className="text-body-secondary">No upstreams configured — add the first one.</p>
        ) : (
          <table className="table align-middle">
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
                      <span
                        className={`badge ${
                          upstream.probe === "ok" ? "text-bg-success" : "text-bg-danger"
                        }`}
                      >
                        {upstream.probe}
                      </span>
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
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => openEdit(upstream)}
                        disabled={editor !== null}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => remove(upstream)}
                        disabled={busy || editor !== null}
                      >
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {editor !== null && (
        <form className="card mt-3" onSubmit={submit}>
          <div className="card-body">
            <h2 className="h5 card-title">{editing ? `Edit upstream ${editor}` : "Add upstream"}</h2>
            <div className="row g-3">
              <div className="col-md-4">
                <label className="form-label" htmlFor="upstream-type">
                  type
                </label>
                <select
                  id="upstream-type"
                  className="form-select"
                  value={form.type}
                  onChange={(event) => setForm({ ...form, type: event.target.value })}
                >
                  {UPSTREAM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-md-4">
                <label className="form-label" htmlFor="upstream-id">
                  id
                </label>
                <input
                  id="upstream-id"
                  className="form-control"
                  value={form.id}
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                  disabled={editing}
                  required={!editing}
                />
                {editing && (
                  <div className="form-text">The id is immutable — the path parameter owns it.</div>
                )}
              </div>
              <div className="col-md-4">
                <label className="form-label" htmlFor="upstream-base-url">
                  baseUrl
                </label>
                <input
                  id="upstream-base-url"
                  className="form-control"
                  type="url"
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  required
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <div className="col-md-6">
                <label className="form-label" htmlFor="upstream-api-key">
                  apiKey {editing && <span className="text-body-secondary">(пусто = не менять)</span>}
                </label>
                <input
                  id="upstream-api-key"
                  className="form-control"
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
              </div>
              <div className="col-md-6">
                <label className="form-label" htmlFor="upstream-tls-pin">
                  tlsFingerprint {editing && <span className="text-body-secondary">(пусто = не менять)</span>}
                </label>
                <input
                  id="upstream-tls-pin"
                  className="form-control font-monospace"
                  value={form.tlsFingerprint}
                  onChange={(event) => setForm({ ...form, tlsFingerprint: event.target.value })}
                  placeholder={editing ? `пусто = не менять${upstreams?.find((u) => u.id === editor)?.tlsFingerprint == null ? " (сейчас не задан)" : ` (сейчас ${CONFIGURED_MASK})`}` : "optional SHA-256 pin"}
                />
                <div className="form-text">
                  Optional TLS certificate pin. Leave empty to keep the stored pin.
                </div>
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
              Saving probes the upstream synchronously (within the probe budget) — a failed
              probe is reported, not cancelled: the change still lands.
            </p>
          </div>
        </form>
      )}
    </section>
  );
}
