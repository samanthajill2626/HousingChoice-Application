// RelayCloseAskDialog - the shared "Also close the group text?" confirm offered
// AFTER a tour/placement terminal outcome is recorded, when the entity still has
// a linked OPEN relay group (design D4). Non-blocking by construction: the caller
// opens it ONLY once the outcome save has already succeeded, so a failure of
// either action here must never look like the outcome failed - it surfaces a
// small inline error and stays dismissible.
//   Close group text -> PATCH .../close { closed: true } (the existing endpoint;
//     the backend sends the final "group is closed" message and keeps the number).
//   Keep it open      -> POST .../close-nag/defer (pushes the Today nag out 28 days).
// Both then call onDone(). Staff-dashboard copy uses "group text" (GLOSSARY);
// ASCII only.
import { useState } from 'react';
import { closeConversation, deferCloseNag } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import styles from './RelayCloseAskDialog.module.css';

export interface RelayCloseAskDialogProps {
  /** The relay group's conversationId. */
  conversationId: string;
  /** Human member names for the prompt ("... with Ann & Marcus?"). May be empty
   *  (then the dialog uses the generic title). */
  memberSummary: string;
  /** Called once the operator answers (either action succeeds) OR dismisses the
   *  dialog. The caller clears its dialog state here. */
  onDone: () => void;
}

export function RelayCloseAskDialog({
  conversationId,
  memberSummary,
  onDone,
}: RelayCloseAskDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title =
    memberSummary.trim().length > 0
      ? `Also close the group text with ${memberSummary}?`
      : 'Also close the group text?';

  // Run one action (close or defer). The recorded outcome is ALREADY saved, so a
  // failure here must never re-open/undo it: show a small inline error, re-enable
  // the buttons, and leave the dialog dismissible.
  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void action()
      .then(() => onDone())
      .catch(() => {
        setError('We could not update the group text. You can close it later from the group.');
        setBusy(false);
      });
  };

  return (
    <Modal
      title={title}
      onClose={onDone}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => run(() => deferCloseNag(conversationId))}
            disabled={busy}
          >
            Keep it open
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={() => run(() => closeConversation(conversationId, true))}
            disabled={busy}
          >
            Close group text
          </Button>
        </>
      }
    >
      <p className={styles.body}>
        This group text is still open. Closing it sends everyone a final note and stops new
        messages; keeping it open reminds you again in 28 days.
      </p>
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
