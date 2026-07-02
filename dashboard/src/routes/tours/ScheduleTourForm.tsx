// ScheduleTourForm — the "Schedule a tour" dialog (Modal). Creates one tour
// (this tenant on this property) via POST /api/tours. The date is OPTIONAL:
// left empty, the tour is created timeless ('requested' — the coordination
// anchor the Team books later); filled, it's created 'scheduled' and the
// reminder ladder arms server-side.
//
// A pre-filled tenant side (tenantId prop set) renders LOCKED read-only (the
// caller already knows the tenant — the tenant file's Tours card sets it); the
// unit side stays an editable typeahead. Mirrors PlacementCreateForm.
//
// Navigation lives in the entry points: on a 201 the form calls onCreated and
// the caller closes + navigates (parity with PlacementCreateForm). The form
// never navigates itself.
//
// Audience vocabulary: this is a staff-only dialog, so copy says "property"
// and "tour" (never "listing"/"home"); code says `unit`.
import { useEffect, useState } from 'react';
import {
  createTour,
  getContact,
  getContacts,
  getUnits,
  TOUR_TYPE_LABELS,
  type Contact,
  type Tour,
  type TourType,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import {
  ContactSearchField,
  type ContactSearchValue,
} from '../contact/ContactSearchField.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { contactDisplayName } from '../contact/format.js';
import styles from './ScheduleTourForm.module.css';

export interface ScheduleTourFormProps {
  /** Pre-fill + lock the tenant side. */
  tenantId?: string;
  onClose: () => void;
  onCreated: (tour: Tour) => void;
}

const FORM_ID = 'schedule-tour-form';
const DEFAULT_TOUR_TYPE: TourType = 'self_guided';

/** The tour-type options, in TOUR_TYPE_LABELS order. */
const TOUR_TYPES = Object.keys(TOUR_TYPE_LABELS) as TourType[];

/** Display name for a tenant contact (name → phone → "Unknown contact"). */
function tenantLabel(c: Contact): string {
  const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
  return contactDisplayName(c.firstName, c.lastName, phone);
}

export function ScheduleTourForm({
  tenantId,
  onClose,
  onCreated,
}: ScheduleTourFormProps): React.JSX.Element {
  // Candidate lists for the typeaheads (fetched on mount).
  const [tenants, setTenants] = useState<Contact[]>([]);
  const [units, setUnits] = useState<UnitItem[]>([]);

  // Locked-side display label (resolved from the prop id).
  const [lockedTenantLabel, setLockedTenantLabel] = useState<string | null>(null);

  // Editable typeahead values (only used when the side is NOT locked).
  const [tenantPick, setTenantPick] = useState<ContactSearchValue>({ name: '' });
  const [unitPick, setUnitPick] = useState<UnitSearchValue>({ label: '' });

  // Tour type (required; defaults like PlacementCreateForm's stage select) +
  // the OPTIONAL datetime-local value ('' = timeless / requested).
  const [tourType, setTourType] = useState<TourType>(DEFAULT_TOUR_TYPE);
  const [scheduledAtLocal, setScheduledAtLocal] = useState('');

  // Submission state.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The resolved ids (from the prop OR the typeahead pick).
  const resolvedTenantId = tenantId ?? tenantPick.contactId;
  const resolvedUnitId = unitPick.unitId;
  const tenantLocked = tenantId !== undefined;

  // ── Fetch the candidate lists + resolve the locked-side label on mount. ──
  useEffect(() => {
    const ac = new AbortController();

    // Always fetch tenants so the picker works AND a locked tenant label can be
    // looked up from the list (with getContact as a fallback).
    void (async () => {
      try {
        const page = await getContacts({ type: 'tenant' }, ac.signal);
        if (ac.signal.aborted) return;
        setTenants(page.contacts);
        if (tenantId !== undefined) {
          const hit = page.contacts.find((c) => c.contactId === tenantId);
          if (hit) setLockedTenantLabel(tenantLabel(hit));
        }
      } catch {
        // Non-fatal: the list just stays empty; submit still works if the side is locked.
      }
    })();

    void (async () => {
      try {
        const page = await getUnits({}, ac.signal);
        if (ac.signal.aborted) return;
        setUnits(page.units);
      } catch {
        // Non-fatal.
      }
    })();

    // Fallback label resolution for a locked tenant not present in the first page.
    if (tenantId !== undefined) {
      void (async () => {
        try {
          const c = await getContact(tenantId, ac.signal);
          if (!ac.signal.aborted) setLockedTenantLabel((prev) => prev ?? tenantLabel(c));
        } catch {
          /* fall back to the id below */
        }
      })();
    }

    return () => ac.abort();
  }, [tenantId]);

  const canCreate = resolvedTenantId !== undefined && resolvedUnitId !== undefined && !busy;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (resolvedTenantId === undefined || resolvedUnitId === undefined || busy) return;

    setBusy(true);
    setError(null);

    // Empty date → OMIT scheduledAt entirely (a timeless 'requested' tour).
    // Filled → normalize the datetime-local value to a full ISO instant so the
    // stored time carries the user's timezone, not the server's.
    const body = {
      tenantId: resolvedTenantId,
      unitId: resolvedUnitId,
      tourType,
      ...(scheduledAtLocal !== '' && {
        scheduledAt: new Date(scheduledAtLocal).toISOString(),
      }),
    };

    try {
      const tour = await createTour(body);
      setBusy(false);
      onCreated(tour);
    } catch {
      setError("Couldn't schedule the tour — please try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Schedule a tour"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={!canCreate}>
            {busy ? 'Scheduling…' : 'Schedule'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        {/* 1 — Tenant (required; locked when the tenantId prop is set) */}
        <div className={styles.field}>
          <span className={styles.label}>Tenant</span>
          {tenantLocked ? (
            <div className={styles.locked} role="group" aria-label="Tenant">
              {lockedTenantLabel ?? tenantId}
            </div>
          ) : (
            <ContactSearchField
              value={tenantPick}
              onChange={setTenantPick}
              candidates={tenants}
              inputLabel="Tenant"
            />
          )}
        </div>

        {/* 2 — Unit (required; typeahead over the property roster) */}
        <div className={styles.field}>
          <span className={styles.label}>Unit</span>
          <UnitSearchField
            value={unitPick}
            onChange={setUnitPick}
            candidates={units}
            inputLabel="Unit"
          />
        </div>

        {/* 3 — Tour type (required; defaults to self-guided) */}
        <label className={styles.field}>
          <span className={styles.label}>Tour type</span>
          <select
            className={styles.input}
            aria-label="Tour type"
            value={tourType}
            onChange={(e) => setTourType(e.target.value as TourType)}
          >
            {TOUR_TYPES.map((t) => (
              <option key={t} value={t}>
                {TOUR_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {/* 4 — Date and time (OPTIONAL — empty creates a timeless 'requested' tour) */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="schedule-tour-at">
            Date and time
          </label>
          <input
            id="schedule-tour-at"
            className={styles.input}
            type="datetime-local"
            value={scheduledAtLocal}
            onChange={(e) => setScheduledAtLocal(e.target.value)}
            aria-describedby="schedule-tour-at-hint"
          />
          <p id="schedule-tour-at-hint" className={styles.hint}>
            Leave empty to create the tour without a time — book it later.
          </p>
        </div>

        {/* Generic error (blocking) */}
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
