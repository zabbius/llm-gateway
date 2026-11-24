/**
 * Clients section — the clients collection's management surface (ADR-014,
 * the ADR-008 per-client Bearer gate): every configured client in config
 * order (name, the key mask exactly as the redacted view serves it, the
 * alias ACL) plus create / edit / delete. Every mutation hot-applies into
 * the gate's digest registry — the very next `/llm/v1` request sees it.
 *
 * The form is inline (below the table): the ACL is a multi-select fed by
 * the configured aliases (`GET /api/models`); the key field is never
 * pre-filled — an empty `apiKey` is omitted from the request body, which
 * the boundary reads as "keep the stored credential" (ADR-014 D7; sending
 * the `[Configured]` mask back is refused). Create requires a key; edit
 * leaves the field empty unless the operator wants a rotation. The name is
 * immutable. Deleting asks through the shared ConfirmModal (destructive —
 * its confirm button renders red) before the store call. Every failure —
 * the store's value-free `400` problem lines included — surfaces as an
 * alert carrying the OpenAI envelope's message (deleting the last client
 * is the store's `400` refusal; there is no `resource_in_use` class on
 * this collection).
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { Alert, Button, Card, Form, Spinner, Table } from "react-bootstrap";
import {
  CONFIGURED_MASK,
  createClient,
  deleteClient,
  fetchClients,
  fetchModels,
  updateClient,
  type ManagedClient,
  type ClientWriteRequest,
} from "../api.ts";
import { ConfirmModal, type ConfirmDialog } from "../ui/ConfirmModal.tsx";

/** One open editor: `null` = closed, `NEW` = create, otherwise the name being edited. */
const NEW_CLIENT = Symbol("new");
type Editor = null | typeof NEW_CLIENT | string;

interface FormState {
  name: string;
  apiKey: string;
  models: readonly string[];
}

const EMPTY_FORM: FormState = { name: "", apiKey: "", models: [] };

export function ClientsSection(): ReactNode {
  const [clients, setClients] = useState<readonly ManagedClient[] | null>(null);
  const [aliases, setAliases] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  // The pending delete confirmation — open exactly while non-null.
  const [dialog, setDialog] = useState<ConfirmDialog | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // The alias catalog feeds the ACL multi-select; clients ride along.
      const [clientList, modelList] = await Promise.all([fetchClients(), fetchModels()]);
      setClients(clientList.clients);
      setAliases(modelList.models.map((entry) => entry.alias));
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
    setEditor(NEW_CLIENT);
  };

  const openEdit = (client: ManagedClient): void => {
    setError(null);
    setForm({ name: client.name, apiKey: "", models: [...client.models] });
    setEditor(client.name);
  };

  const close = (): void => {
    setEditor(null);
    setForm(EMPTY_FORM);
    setError(null);
  };

  const toggleModel = (alias: string, selected: boolean): void => {
    setForm((current) => ({
      ...current,
      models: selected
        ? [...current.models, alias]
        : current.models.filter((entry) => entry !== alias),
    }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const editing = typeof editor === "string";
    const body: ClientWriteRequest = {
      name: form.name.trim(),
      models: [...form.models],
      // Empty = unchanged (D7): the key rides the body only when filled.
      ...(form.apiKey !== "" ? { apiKey: form.apiKey } : {}),
    };
    if (!editing && (form.name.trim() === "" || form.apiKey === "")) return; // create requires both
    if (body.models.length === 0) return; // the grammar requires a non-empty ACL

    setBusy(true);
    void (async (): Promise<void> => {
      try {
        if (editing) {
          await updateClient(editor as string, body);
        } else {
          await createClient(body);
        }
        close();
        await refresh();
      } catch (cause) {
        // 400 problem lines (unknown alias in the ACL, grammar), 404 on an
        // unknown name — the envelope's message, as an alert.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const remove = (client: ManagedClient): void => {
    setBusy(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        await deleteClient(client.name);
        await refresh();
      } catch (cause) {
        // The last client is the store's 400 refusal — the envelope's
        // message, as an alert.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const requestRemove = (client: ManagedClient): void => {
    setDialog({
      title: `Delete client "${client.name}"?`,
      body: "Its key stops working on the next request.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => {
        setDialog(null);
        remove(client);
      },
    });
  };

  const editing = typeof editor === "string";

  return (
    <section aria-labelledby="clients-heading">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0" id="clients-heading">
          Clients
        </h1>
        <span className="d-flex align-items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="d-inline-flex align-items-center gap-1"
            onClick={openCreate}
            disabled={editor !== null}
          >
            <Plus aria-hidden="true" size={14} />
            Add client
          </Button>
          <Button
            type="button"
            variant="outline-secondary"
            size="sm"
            className="d-inline-flex align-items-center gap-1"
            onClick={() => void refresh()}
            disabled={loading || editor !== null}
          >
            <RefreshCw aria-hidden="true" size={14} />
            Refresh
          </Button>
        </span>
      </div>
      <p className="text-body-secondary">
        Every configured client with its alias ACL, in config order — create,
        edit, or delete; changes hot-apply into the client gate without a
        restart (a deleted key answers 401 on the next request).
      </p>

      {error !== null && <Alert variant="danger">{error}</Alert>}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <Spinner animation="border" aria-hidden="true" />
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {!loading && clients !== null && (
        clients.length === 0 ? (
          <p className="text-body-secondary">No clients configured — add the first one.</p>
        ) : (
          <Table className="align-middle">
            <thead>
              <tr>
                <th scope="col">name</th>
                <th scope="col">apiKey</th>
                <th scope="col">models (ACL)</th>
                <th scope="col">actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.name}>
                  <td>
                    <code>{client.name}</code>
                  </td>
                  {/* The mask renders exactly as the read returned it. */}
                  <td>{client.apiKey}</td>
                  <td>
                    <span className="d-inline-flex flex-wrap gap-1">
                      {client.models.map((alias) => (
                        <code key={alias} className="badge text-bg-light border">
                          {alias}
                        </code>
                      ))}
                    </span>
                  </td>
                  <td>
                    <span className="d-inline-flex gap-1">
                      <Button
                        type="button"
                        variant="outline-secondary"
                        size="sm"
                        className="d-inline-flex align-items-center gap-1"
                        onClick={() => openEdit(client)}
                        disabled={editor !== null}
                      >
                        <Pencil aria-hidden="true" size={14} />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline-danger"
                        size="sm"
                        className="d-inline-flex align-items-center gap-1"
                        onClick={() => requestRemove(client)}
                        disabled={busy || editor !== null}
                      >
                        <Trash2 aria-hidden="true" size={14} />
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

      {editor !== null && (
        <Card as="form" className="mt-3" onSubmit={submit}>
          <Card.Body>
            <Card.Title as="h2" className="h5">
              {editing ? `Edit client ${editor}` : "Add client"}
            </Card.Title>
            <div className="row g-3">
              <Form.Group className="col-md-4" controlId="client-name">
                <Form.Label>name</Form.Label>
                <Form.Control
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  disabled={editing}
                  required={!editing}
                />
                {editing && (
                  <Form.Text as="div">The name is immutable — the path parameter owns it.</Form.Text>
                )}
              </Form.Group>
              <Form.Group className="col-md-4" controlId="client-api-key">
                <Form.Label>
                  apiKey {editing && <span className="text-body-secondary">(пусто = не менять)</span>}
                </Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  required={!editing}
                  placeholder={editing ? `пусто = не менять (сейчас ${CONFIGURED_MASK})` : "client Bearer key"}
                />
                <Form.Text as="div">
                  {editing
                    ? "Leave empty to keep the stored key — the stored value is never served back."
                    : "Required on create; stored once, served back only as the mask."}
                </Form.Text>
              </Form.Group>
              <Form.Group className="col-md-4" controlId="client-models">
                <Form.Label>models (ACL)</Form.Label>
                {aliases.length === 0 ? (
                  <Form.Text as="div">
                    No aliases configured — create one under Models first; the ACL must name
                    existing aliases.
                  </Form.Text>
                ) : (
                  <div
                    id="client-models"
                    className="border rounded p-2 d-flex flex-column gap-1"
                    style={{ maxHeight: "12rem", overflowY: "auto" }}
                    role="group"
                    aria-label="Allowed aliases"
                  >
                    {aliases.map((alias, index) => (
                      <Form.Check
                        key={alias}
                        id={`client-models-${index}`}
                        inline
                        className="mb-0 small"
                        checked={form.models.includes(alias)}
                        onChange={(event) => toggleModel(alias, event.target.checked)}
                        label={<code>{alias}</code>}
                      />
                    ))}
                  </div>
                )}
                <Form.Text as="div">
                  The aliases this client may request — at least one, each an existing alias.
                </Form.Text>
              </Form.Group>
            </div>
            <div className="d-flex gap-2 mt-3">
              <Button
                variant="primary"
                type="submit"
                className="d-inline-flex align-items-center gap-1"
                disabled={busy || form.models.length === 0 || (!editing && (form.name.trim() === "" || form.apiKey === ""))}
              >
                {busy && <Spinner as="span" animation="border" size="sm" aria-hidden="true" />}
                {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
                {editing ? "Save" : "Create"}
              </Button>
              <Button
                variant="outline-secondary"
                type="button"
                className="d-inline-flex align-items-center gap-1"
                onClick={close}
                disabled={busy}
              >
                <X aria-hidden="true" size={16} />
                Cancel
              </Button>
            </div>
            <p className="form-text mb-0 mt-2">
              Saving validates and persists to config.json, then hot-applies into the gate —
              the very next request admits or refuses with the new key set.
            </p>
          </Card.Body>
        </Card>
      )}

      <ConfirmModal dialog={dialog} onDismiss={() => setDialog(null)} />
    </section>
  );
}
