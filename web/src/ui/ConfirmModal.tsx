import type { ReactNode } from "react";
import { Button, Modal } from "react-bootstrap";

/**
 * One pending confirmation — the ConfirmModal is open exactly while `dialog`
 * is not null. The caller owns that state, so `onConfirm` must clear it as
 * part of its work; Esc, the backdrop, the header close button and Cancel all
 * merely call `onDismiss`.
 */
export type ConfirmDialog = {
  title: string;
  body: ReactNode;
  /** The confirm button's label; defaults to "Confirm". */
  confirmLabel?: string;
  /** The cancel button's label; defaults to "Cancel". */
  cancelLabel?: string;
  /** Destructive action — the confirm button renders variant="danger". */
  destructive?: boolean;
  onConfirm: () => void;
};

/**
 * The SPA's one confirmation surface — the styled replacement for
 * `window.confirm()`, whose native dialog blocks the event loop and cannot be
 * styled. Esc, the backdrop and the header close button all cancel
 * (react-bootstrap routes them to `onHide`), so the only way through is the
 * action button; a destructive action's confirm button carries variant
 * "danger" for the visual weight the native dialog could never convey.
 */
export function ConfirmModal({
  dialog,
  onDismiss,
}: {
  dialog: ConfirmDialog | null;
  onDismiss: () => void;
}): ReactNode {
  return (
    <Modal show={dialog !== null} onHide={onDismiss} centered>
      <Modal.Header closeButton>
        <Modal.Title>{dialog?.title ?? ""}</Modal.Title>
      </Modal.Header>
      <Modal.Body>{dialog?.body}</Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onDismiss}>
          {dialog?.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          variant={dialog?.destructive === true ? "danger" : "primary"}
          autoFocus
          onClick={() => dialog?.onConfirm()}
        >
          {dialog?.confirmLabel ?? "Confirm"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
