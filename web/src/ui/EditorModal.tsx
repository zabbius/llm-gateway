import { useId, type FormEvent, type ReactNode } from "react";
import { Button, Form, Modal, Spinner } from "react-bootstrap";
import { Plus, Save, X } from "lucide-react";
import "./modal.css";

/**
 * The CRUD sections' shared create/edit dialog shell: a real `<form>`
 * (react-bootstrap `Form`) inside the modal body carries the caller's
 * `onSubmit`, and the footer's submit button binds to it through the HTML
 * `form` attribute — `Modal` itself must NOT be asked to root the dialog as
 * a form (`as="form"` is not consumed by `Modal`; it leaks as an inert
 * attribute onto the `.modal-dialog` div, no `<form>` element exists, and a
 * `type="submit"` button with no form owner is a dead button: the click
 * fires nothing and the refusal is silent). The footer button submits
 * through that association; Enter in an input submits via the form's
 * explicit `onKeyDown` → `requestSubmit()` — Chromium scopes native implicit
 * submission to buttons inside the `<form>` element and ignores an
 * out-of-form default button even when it is form-associated. Dialog is
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
  const formId = useId();
  return (
    <Modal
      show={show}
      onHide={onClose}
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
      <Modal.Body>
        <Form
          id={formId}
          onSubmit={onSubmit}
          onKeyDown={(event) => {
            // Enter in an input submits explicitly: Chromium scopes implicit
            // submission to buttons INSIDE the <form> element and ignores the
            // out-of-form default button even with the form association, so
            // the platform affordance cannot be relied on here.
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
        >
          {children}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="submit"
          form={formId}
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
