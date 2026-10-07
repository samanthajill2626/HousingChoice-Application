// OrgEntryDialogs - the dialogs behind the Settings entry rows (spec
// 2026-10-06 D10, D12, D13): notes for everyone, and (Task 11.16) the
// admin-only spellings, rename, merge, kind and delete. Every refusal is shown
// through orgErrorCopy (never the raw code); every button has an explicit type.
import { useId, useState } from 'react';
import { patchOrg, type OrgEntry } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { orgErrorCopy } from '../orgs/orgCopy.js';
import styles from './OrgListSection.module.css';

interface EntryDialogProps {
  entry: OrgEntry;
  onClose: () => void;
}

/** "Edit notes" - everyone; notes touch no records (spec D10, D13: 500 chars). */
export function NotesDialog({ entry, onSaved, onClose }: EntryDialogProps & { onSaved: () => void }): React.JSX.Element {
  const notesId = useId();
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (busy) return;
    if (notes === (entry.notes ?? '')) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchOrg(entry.orgId, { notes });
      onSaved();
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit notes"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>{`Notes for ${entry.name}. Notes change no records.`}</p>
        <div className={styles.field}>
          <label htmlFor={notesId} className={styles.label}>
            Notes
          </label>
          <textarea
            id={notesId}
            className={styles.textarea}
            value={notes}
            rows={4}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
