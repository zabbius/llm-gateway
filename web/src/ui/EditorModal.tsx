import { useId, type FormEvent, type ReactNode } from "react";
import { Button, Modal, Spinner } from "react-bootstrap";
import { Plus, Save, X } from "lucide-react";
import "./modal.css";

/**
 * The CRUD sections' shared create/edit dialog shell: a react-bootstrap
 * Modal rooted as a form (`as="form"` lands on `.modal-dialog`, so the
 * footer's submit button works and Enter in an input submits implicitly),
 * 90% of the viewport wide, with a static backdrop and Esc disabled — a
 * typed editing session survives stray gestures and closing stays
 * explicit: Cancel or the header close button, both `onClose`. The footer
 * owns the Save/Create and Cancel buttons and the body is the caller's
 * content, so submit errors surface inside the dialog, never behind the
 * overlay.
 */
export function EditorModal({
  show,
  title,
  editing,
  busy = false,
  submitDisabled = false,
  onClose,
  onSubmit,
  children,
}: {
  show: boolean;
  /** The dialog heading; visible exactly while `show` is true. */
  title: ReactNode;
  /** Edit mode — the submit button reads "Save", create mode "Create". */
  editing: boolean;
  /** A save request in flight — spinner in the submit button, both buttons disabled. */
  busy?: boolean;
  /** Extra disable condition for the submit button (form validity beyond the grammar). */
  submitDisabled?: boolean;
  /** Cancel — the Cancel button, the header close button and onHide all end here. */
  onClose: () => void;
  /** Save — the form submit; the store's grammar stays the caller's job. */
  onSubmit: (event: FormEvent) => void;
  /** The dialog body — form fields, the submit-error alert, the trailing hint. */
  children: ReactNode;
}): ReactNode {
  const titleId = useId();
  return (
    <Modal
      as="form"
      show={show}
      onHide={onClose}
      onSubmit={onSubmit}
      aria-labelledby={titleId}
      dialogClassName="modal-90w"
      centered
      scrollable
      backdrop="static"
      keyboard={false}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5" id={titleId}>
          {title}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>{children}</Modal.Body>
      <Modal.Footer>
        <Button
          type="submit"
          variant="primary"
          className="d-inline-flex align-items-center gap-1"
          disabled={busy || submitDisabled}
        >
          {busy && <Spinner as="span" animation="border" size="sm" aria-hidden="true" />}
          {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
          {editing ? "Save" : "Create"}
        </Button>
        <Button
          type="button"
          variant="outline-secondary"
          className="d-inline-flex align-items-center gap-1"
          onClick={onClose}
          disabled={busy}
        >
          <X aria-hidden="true" size={16} />
          Cancel
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
