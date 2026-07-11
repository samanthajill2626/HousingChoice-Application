// ConfirmRemoveDialog -- the "Remove teammate" confirmation. Renders the shared
// accessible Modal (role="dialog", aria-modal, Esc/backdrop close). Confirming
// calls onConfirm; on a 409 guard it shows the message inline and stays open;
// on success onClose() runs (the roster has already dropped the row). While the
// request is in flight the dialog can't be dismissed and both buttons disable.
import { useState } from 'react';
import type { AdminUserView } from '../../api/index.js';
import type { RemoveResult } from './useTeam.js';
import { Modal } from '../contact/Modal.js';
import { Button } from '../../ui/index.js';
import styles from './TeamSection.module.css';

export interface ConfirmRemoveDialogProps {
  user: AdminUserView;
  onClose: () => void;
  onConfirm: (userId: string) => Promise<RemoveResult>;
}

export function ConfirmRemoveDialog({
  user,
  onClose,
  onConfirm,
}: ConfirmRemoveDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await onConfirm(user.userId);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    onClose(); // success -- the row is already gone from the roster
  }

  return (
    <Modal
      title="Remove teammate"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Removing...' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className={styles.dialogText}>
        Remove <strong>{user.name}</strong> ({user.email})? They'll lose dashboard access
        immediately.
      </p>
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
