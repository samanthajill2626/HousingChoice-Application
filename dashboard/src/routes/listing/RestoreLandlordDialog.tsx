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

/** The landlords read failed: the picker can offer no one (R1 code review,
 *  dashboard finding 5; the house "Couldn't load <thing>" copy). */
const LANDLORDS_LOAD_FAILED_COPY = "Couldn't load the landlords.";

export interface RestoreLandlordDialogProps {
  unitId: string;
  /** The stored landlord's display name from the 409 body, when it exists. */
  landlordName?: string;
  /** The restored unit (with its enriched contacts) - the caller applies it. */
  onRestored: (unit: UnitItem) => void;
  /** A 409 unit_roster_conflict: the caller re-reads the property. */
  onConflict: () => void;
  /** A 409 restore_landlord_not_needed (spec revision 7; final review round 2
   *  R2-1): the plain restore applies now - the property's landlord changed
   *  while staff were choosing - and nothing was written. A retry of the same
   *  choice can never succeed, so the caller closes the dialog and re-reads the
   *  property; it never re-runs the plain restore on its own. */
  onLandlordNotNeeded: () => void;
  onClose: () => void;
}

export function RestoreLandlordDialog({
  unitId,
  landlordName,
  onRestored,
  onConflict,
  onLandlordNotNeeded,
  onClose,
}: RestoreLandlordDialogProps): React.JSX.Element {
  const [landlords, setLandlords] = useState<Contact[]>([]);
  const [landlordsFailed, setLandlordsFailed] = useState(false);
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
        // The picker can offer no one, so say so (an aborted read is the
        // dialog closing, not a failure). "Restore without a landlord" and
        // Cancel still work; "Restore with this landlord" stays disabled
        // because nothing can be picked.
        if (!ac.signal.aborted) setLandlordsFailed(true);
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
        // Not ROSTER_RETRY_COPY: no retry of this choice can succeed.
        if (err instanceof ApiError && err.status === 409 && err.code === 'restore_landlord_not_needed') {
          onLandlordNotNeeded();
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
      {landlordsFailed ? (
        <p role="alert" className={styles.error}>
          {LANDLORDS_LOAD_FAILED_COPY}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
