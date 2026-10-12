// RestoreLandlordDialog - Restore for a property whose stored landlord can't
// stay its landlord (caseworker-integrity spec 2026-10-12 section 4
// "Restore", Cameron 2026-10-12). A property comes back live only with a
// landlord of record typed `landlord`, or with none, and restore never
// dead-ends: when the plain restore answers 409 restore_needs_landlord,
// ListingDetail opens this dialog - pick a landlord (the same landlords-only
// source as the New property picker, UnitCreateForm) or restore without one.
// Staff can add a landlord later from the Contacts card (Add contact, role
// Landlord), which claims an empty slot.
import { useEffect, useState } from 'react';
import { ApiError, getAllContacts, restoreUnit, type Contact, type UnitItem } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { Modal } from '../contact/Modal.js';
// The roster's own sentence for the same 409 unit_roster_conflict (the
// landlord changed under the request) - one shared literal, never a copy.
import { ROSTER_RETRY_COPY } from './rosterCopy.js';
import styles from './ListingDetail.module.css';

/** Any other failure: nothing was restored. */
const RESTORE_FAILED_COPY = "Couldn't restore - please try again.";

export interface RestoreLandlordDialogProps {
  unitId: string;
  /** The stored landlord's display name from the 409 body, when it exists. */
  landlordName?: string;
  /** The restored unit (with its enriched contacts) - the caller applies it. */
  onRestored: (unit: UnitItem) => void;
  /** A 409 unit_roster_conflict: the caller re-reads the property. */
  onConflict: () => void;
  onClose: () => void;
}

export function RestoreLandlordDialog({
  unitId,
  landlordName,
  onRestored,
  onConflict,
  onClose,
}: RestoreLandlordDialogProps): React.JSX.Element {
  const [landlords, setLandlords] = useState<Contact[]>([]);
  const [pick, setPick] = useState<ContactSearchValue>({ name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        // EVERY page, landlords only - the New property picker's source.
        const items = await getAllContacts({ type: 'landlord' }, ac.signal);
        if (!ac.signal.aborted) setLandlords(items);
      } catch {
        // Non-fatal: the picker stays empty; "Restore without a landlord" still works.
      }
    })();
    return () => ac.abort();
  }, []);

  const run = (landlordId: string | null): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void restoreUnit(unitId, { landlordId })
      .then((unit) => onRestored(unit))
      .catch((err: unknown) => {
        const typed = contactTypeErrorMessage(err);
        if (typed !== null) {
          setError(typed);
          return;
        }
        if (err instanceof ApiError && err.status === 409 && err.code === 'unit_roster_conflict') {
          setError(ROSTER_RETRY_COPY);
          onConflict();
          return;
        }
        setError(RESTORE_FAILED_COPY);
      })
      .finally(() => setBusy(false));
  };

  const who = landlordName ?? "This property's landlord";
  const pickedId = pick.contactId;
  return (
    <Modal
      title="Restore property"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className={styles.confirmActions}>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => run(null)} disabled={busy}>
            Restore without a landlord
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => {
              if (pickedId !== undefined) run(pickedId);
            }}
            disabled={pickedId === undefined || busy}
          >
            Restore with this landlord
          </Button>
        </div>
      }
    >
      <p>{`${who} is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:`}</p>
      <ContactSearchField
        value={pick}
        onChange={setPick}
        candidates={landlords}
        inputLabel="Landlord"
        disabled={busy}
      />
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
