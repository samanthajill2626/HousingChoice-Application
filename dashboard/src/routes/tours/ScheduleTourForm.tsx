// ScheduleTourForm — the "Schedule a tour" dialog (Modal). Creates one tour
// (this tenant on this property) via POST /api/tours. The date is OPTIONAL:
// left empty, the tour is created timeless ('requested' — the coordination
// anchor the Team books later); filled, it's created 'scheduled' and the
// reminder ladder arms server-side.
//
// A pre-filled tenant side (tenantId prop set) renders LOCKED read-only (the
// caller already knows the tenant — the tenant file's Tours card sets it); the
// unit side stays an editable typeahead. Mirrors PlacementCreateForm. The unit
// side can be pre-COMMITTED via initialUnitId (the tenant file passes the last
// property SENT) — one Clear click returns it to free search.
//
// Navigation lives in the entry points: on a 201 the form calls onCreated and
// the caller closes + navigates (parity with PlacementCreateForm). The form
// never navigates itself.
//
// Audience vocabulary: this is a staff-only dialog, so copy says "property"
// and "tour" (never "listing"/"home"); code says `unit`.
//
// Tour-type PREFILLS from the picked unit with VISIBLE PROVENANCE, in three
// branches: (1) the unit's structured tour_type -> caption "From the property";
// (2) else a keyword guess over the unit's tour_process free text -> caption
// "Guessed from the property's tour notes - check it"; (3) else the self_guided
// default -> caption "Default - no tour info on the property". Staff can
// override the picker (the caption then drops its property claim); a manual pick
// sticks until a NEW unit is picked, and clearing the unit resets type +
// caption + the read-only tour_process block back to the no-unit state.
// An odd-looking date (in the past, or more than 14 days
// out — usually a typo, occasionally intended) shows a confirmable warning:
// the first submit stops with the warning and the button becomes "Schedule
// anyway"; submitting again confirms. Editing the date clears the warning.
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
import { UnitSearchField, unitLabel, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { contactDisplayName } from '../contact/format.js';
import { tourTimeWarning } from './tourTime.js';
import styles from './ScheduleTourForm.module.css';

export interface ScheduleTourFormProps {
  /** Pre-fill + lock the tenant side. */
  tenantId?: string;
  /** Pre-COMMIT the unit side to this unit once the roster loads (the tenant
   *  file passes the LAST property sent to this tenant, so scheduling continues
   *  the conversation). Same committed state as a hand pick — Clear is one
   *  click. Ignored when the unit is missing from the roster or the staff
   *  member already typed/picked. */
  initialUnitId?: string;
  onClose: () => void;
  onCreated: (tour: Tour) => void;
}

const FORM_ID = 'schedule-tour-form';
const DEFAULT_TOUR_TYPE: TourType = 'self_guided';

// Provenance captions for the prefilled Tour type (spec S3 / edge notes E1).
// EXACT strings (plain ASCII hyphens) the tests + e2e assert on.
const PROVENANCE_FROM_PROPERTY = 'From the property';
const PROVENANCE_GUESSED = "Guessed from the property's tour notes - check it";
const PROVENANCE_DEFAULT = 'Default - no tour info on the property';

/** The tour-type options, in TOUR_TYPE_LABELS order. */
const TOUR_TYPES = Object.keys(TOUR_TYPE_LABELS) as TourType[];

/**
 * Derive a tourType from a unit's free-text `tour_process` field (best-effort
 * keyword match). Returns 'self_guided' when no keyword matches.
 */
function deriveTourType(tourProcess: string | undefined): TourType {
  if (!tourProcess) return 'self_guided';
  const t = tourProcess.toLowerCase();
  // Check pm_team first (pm keyword is short; check more specific phrase first)
  if (t.includes('pm_team') || t.includes('pm team') || t.includes('property manager')) {
    return 'pm_team';
  }
  // pm alone (but not 'pm_team' already checked) → pm_team
  if (/\bpm\b/.test(t)) {
    return 'pm_team';
  }
  if (
    t.includes('landlord_led') ||
    t.includes('landlord led') ||
    t.includes('landlord-led') ||
    t.includes('landlord') ||
    t.includes('owner')
  ) {
    return 'landlord_led';
  }
  // self_guided (any mention of "self")
  if (
    t.includes('self_guided') ||
    t.includes('self-guided') ||
    t.includes('self guided') ||
    t.includes('self')
  ) {
    return 'self_guided';
  }
  return 'self_guided';
}

/** Display name for a tenant contact (name → phone → "Unknown contact"). */
function tenantLabel(c: Contact): string {
  const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
  return contactDisplayName(c.firstName, c.lastName, phone);
}

export function ScheduleTourForm({
  tenantId,
  initialUnitId,
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

  // Whether the tourType was manually overridden (vs auto-derived from the
  // picked unit's tour_process). Reset on each NEW unit pick so the next pick
  // re-derives; while set, a unit re-pick must NOT clobber the staff choice.
  const [tourTypeOverridden, setTourTypeOverridden] = useState(false);

  // The provenance caption for the current prefill (null = no unit picked, or a
  // manual override that no longer claims a source). Set alongside setTourType.
  const [provenance, setProvenance] = useState<string | null>(null);

  // The pending confirmable date warning (past / >14 days out). Non-null means
  // the LAST submit stopped on it — the next submit with the same odd time is
  // the confirmation and proceeds. Editing the date clears it.
  const [dateWarning, setDateWarning] = useState<string | null>(null);

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
        // Pre-commit the unit side to the caller's suggestion — but only while
        // the field is still untouched (the functional update guards against a
        // pick/typing that landed before this fetch resolved).
        if (initialUnitId !== undefined) {
          const hit = page.units.find((u) => u.unitId === initialUnitId);
          if (hit !== undefined) {
            setUnitPick((prev) =>
              prev.label === '' && prev.unitId === undefined
                ? { label: unitLabel(hit), unitId: hit.unitId }
                : prev,
            );
          }
        }
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
  }, [tenantId, initialUnitId]);

  // -- Prefill tourType from the picked unit, with VISIBLE PROVENANCE. --
  //    Only auto-derive when the staff member hasn't manually overridden.
  //    Three branches (E1 - honest provenance): structured tour_type >
  //    keyword guess over tour_process > self_guided default. Clearing the
  //    unit (resolvedUnitId undefined) resets to the no-unit state (E2).
  useEffect(() => {
    if (tourTypeOverridden) return;
    if (resolvedUnitId === undefined) {
      // E2: no unit picked -> reset type + caption (the text block hides too).
      setTourType(DEFAULT_TOUR_TYPE);
      setProvenance(null);
      return;
    }
    const unit = units.find((u) => u.unitId === resolvedUnitId);
    if (unit?.tour_type) {
      // 1. Structured field set -> use it verbatim.
      setTourType(unit.tour_type);
      setProvenance(PROVENANCE_FROM_PROPERTY);
    } else if (unit?.tour_process && unit.tour_process.trim() !== '') {
      // 2. Non-empty free text -> best-effort keyword guess.
      setTourType(deriveTourType(unit.tour_process));
      setProvenance(PROVENANCE_GUESSED);
    } else {
      // 3. No property tour info -> the labeled default.
      setTourType(DEFAULT_TOUR_TYPE);
      setProvenance(PROVENANCE_DEFAULT);
    }
  }, [resolvedUnitId, units, tourTypeOverridden]);

  // Reset the override flag when a NEW unit is picked so the next pick re-derives;
  // re-picking the SAME unit keeps a manual tour-type choice intact.
  function handleUnitChange(v: UnitSearchValue): void {
    if (v.unitId !== unitPick.unitId) {
      setTourTypeOverridden(false);
    }
    setUnitPick(v);
  }

  function handleTourTypeChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    setTourType(e.target.value as TourType);
    setTourTypeOverridden(true);
    // E1: a manual pick must never keep a stale property-provenance caption.
    setProvenance(null);
  }

  // Editing the date withdraws a pending warning — the next submit re-checks.
  function handleScheduledAtChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setScheduledAtLocal(e.target.value);
    if (dateWarning !== null) setDateWarning(null);
  }

  const canCreate = resolvedTenantId !== undefined && resolvedUnitId !== undefined && !busy;

  // The picked unit's free-text tour_process, shown read-only as context beneath
  // the picker (G3). null when no unit is picked or its tour_process is empty.
  const pickedUnit =
    resolvedUnitId !== undefined ? units.find((u) => u.unitId === resolvedUnitId) : undefined;
  const pickedTourProcess =
    typeof pickedUnit?.tour_process === 'string' && pickedUnit.tour_process.trim() !== ''
      ? pickedUnit.tour_process
      : null;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (resolvedTenantId === undefined || resolvedUnitId === undefined || busy) return;

    // An odd-looking time (past / >14 days out) stops the FIRST submit with a
    // confirmable warning; the same submit repeated is the confirmation. Empty
    // stays valid (timeless).
    const warning = tourTimeWarning(scheduledAtLocal);
    if (warning !== null && warning !== dateWarning) {
      setDateWarning(warning);
      return;
    }

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
            {busy ? 'Scheduling…' : dateWarning !== null ? 'Schedule anyway' : 'Schedule'}
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
            onChange={handleUnitChange}
            candidates={units}
            inputLabel="Unit"
          />
        </div>

        {/* 3 - Tour type (required) with the visible prefill provenance caption
             and the picked unit's read-only tour_process for context. */}
        <div className={styles.field}>
          <span className={styles.label}>Tour type</span>
          <select
            className={styles.input}
            aria-label="Tour type"
            aria-describedby={
              provenance !== null ? 'schedule-tour-type-provenance' : undefined
            }
            value={tourType}
            onChange={handleTourTypeChange}
          >
            {TOUR_TYPES.map((t) => (
              <option key={t} value={t}>
                {TOUR_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {provenance !== null ? (
            <p id="schedule-tour-type-provenance" className={styles.provenance}>
              {provenance}
            </p>
          ) : null}
          {pickedTourProcess !== null ? (
            <p
              className={styles.tourNotes}
              title={pickedTourProcess}
              aria-label="Property tour notes"
            >
              {pickedTourProcess}
            </p>
          ) : null}
        </div>

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
            onChange={handleScheduledAtChange}
            aria-describedby="schedule-tour-at-hint"
            aria-invalid={dateWarning !== null}
          />
          <p id="schedule-tour-at-hint" className={styles.hint}>
            Leave empty to create the tour without a time — book it later.
          </p>
          {dateWarning !== null ? (
            <p role="alert" className={styles.warn}>
              {dateWarning} Press “Schedule anyway” to confirm, or pick a different time.
            </p>
          ) : null}
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
