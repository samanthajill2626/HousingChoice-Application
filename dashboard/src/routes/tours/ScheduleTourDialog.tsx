// ScheduleTourDialog — the "Schedule a tour" dialog. Opens from a tenant's file
// (TenantFile Tours card → "+ Schedule"). The tenant side is FIXED (pre-filled +
// locked to the contact we're viewing — resolved via getContact). Staff pick the
// unit (property) and an optional date/time.
//
// Tour-type is PREFILLED from the picked unit's `tour_process` free-text field
// (best-effort keyword match; staff can override). The three canonical values:
//   self_guided | landlord_led | pm_team
//
// Date/time is OPTIONAL:
//   - Empty → POST body has NO scheduledAt → backend creates status 'requested'
//     (a time-less tour request; no reminder ladder armed). The "No time yet" hint
//     is shown beneath the field.
//   - Present (must be in the future) → POST body includes scheduledAt →
//     backend creates status 'scheduled' + arms reminders.
//
// On success: close the dialog + navigate to /tours/:tourId (mirrors how
// PlacementCreateForm lands on the new placement detail).
//
// Vocabulary: this is a staff/navigator page → use "property" for units.
// Mirrors: PlacementCreateForm.tsx (modal + unit typeahead + AbortController).
import { useEffect, useState } from 'react';
import {
  createTour,
  getContact,
  getUnits,
  TOUR_TYPE_LABELS,
  type Contact,
  type Tour,
  type TourType,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { contactDisplayName } from '../contact/format.js';
import styles from './ScheduleTourDialog.module.css';

export interface ScheduleTourDialogProps {
  /** The tenant this tour is for — LOCKED, shown read-only (name resolved via
   *  getContact). */
  tenantId: string;
  onClose: () => void;
  /** Called with the newly created tour on a successful 201. The caller navigates. */
  onCreated: (tour: Tour) => void;
}

const FORM_ID = 'schedule-tour-form';

/** The ordered tour-type options for the <select>. */
const TOUR_TYPES: readonly TourType[] = ['self_guided', 'landlord_led', 'pm_team'];

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
  if (t.includes('self_guided') || t.includes('self-guided') || t.includes('self guided') || t.includes('self')) {
    return 'self_guided';
  }
  return 'self_guided';
}

/** Human-readable display name for a resolved tenant contact. */
function tenantLabel(c: Contact): string {
  const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
  return contactDisplayName(c.firstName, c.lastName, phone);
}

export function ScheduleTourDialog({
  tenantId,
  onClose,
  onCreated,
}: ScheduleTourDialogProps): React.JSX.Element {
  // Resolved tenant name (loaded on mount from getContact).
  const [tenantName, setTenantName] = useState<string | null>(null);

  // Candidate list for the unit (property) typeahead.
  const [units, setUnits] = useState<UnitItem[]>([]);

  // The editable unit typeahead value.
  const [unitPick, setUnitPick] = useState<UnitSearchValue>({ label: '' });

  // Tour type: prefilled from the unit's tour_process when a unit is picked.
  const [tourType, setTourType] = useState<TourType>('self_guided');

  // Whether the tourType was auto-derived from this unit's tour_process, or
  // manually overridden. Reset to auto-derive on each new unit pick.
  const [tourTypeOverridden, setTourTypeOverridden] = useState(false);

  // Date/time — optional. Empty string = no time (creates 'requested' tour).
  const [scheduledAt, setScheduledAt] = useState('');

  // Inline error for a past datetime.
  const [dateError, setDateError] = useState<string | null>(null);

  // Submission state.
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Fetch tenant name + unit (property) candidate list on mount. ──
  useEffect(() => {
    const ac = new AbortController();

    // Resolve the tenant name for display.
    void (async () => {
      try {
        const c = await getContact(tenantId, ac.signal);
        if (!ac.signal.aborted) setTenantName(tenantLabel(c));
      } catch {
        // Non-fatal — display name stays null (falls back to tenantId in render).
      }
    })();

    // Fetch all units so the property typeahead has candidates.
    void (async () => {
      try {
        const page = await getUnits({}, ac.signal);
        if (!ac.signal.aborted) setUnits(page.units);
      } catch {
        // Non-fatal: typeahead stays empty; user can still type.
      }
    })();

    return () => ac.abort();
  }, [tenantId]);

  // ── Prefill tourType from the picked unit's tour_process. ──
  //    Only auto-derive when the staff member hasn't manually overridden.
  const resolvedUnitId = unitPick.unitId;
  useEffect(() => {
    if (resolvedUnitId === undefined) return;
    if (tourTypeOverridden) return;
    const unit = units.find((u) => u.unitId === resolvedUnitId);
    setTourType(deriveTourType(unit?.tour_process));
  }, [resolvedUnitId, units, tourTypeOverridden]);

  // Reset override flag when a NEW unit is picked so the next pick re-derives.
  function handleUnitChange(v: UnitSearchValue): void {
    if (v.unitId !== unitPick.unitId) {
      setTourTypeOverridden(false);
    }
    setUnitPick(v);
  }

  function handleTourTypeChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    setTourType(e.target.value as TourType);
    setTourTypeOverridden(true);
  }

  // Validate datetime on change — must be in the future when set.
  function handleDateChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const val = e.target.value;
    setScheduledAt(val);
    // Clear any prior error as the user edits; re-validate on submit.
    if (dateError !== null) setDateError(null);
  }

  const canSubmit = resolvedUnitId !== undefined && !busy;
  const hasNoTime = scheduledAt.trim() === '';

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (resolvedUnitId === undefined || busy) return;

    // Re-validate the datetime on submit (guards against race conditions).
    if (scheduledAt.trim()) {
      const ts = new Date(scheduledAt).getTime();
      if (Number.isNaN(ts) || ts <= Date.now()) {
        setDateError("The date and time can't be in the past.");
        return;
      }
    }

    setBusy(true);
    setSubmitError(null);

    const body: {
      tenantId: string;
      unitId: string;
      scheduledAt?: string;
      tourType: TourType;
    } = {
      tenantId,
      unitId: resolvedUnitId,
      tourType,
    };

    // Only include scheduledAt when the staff member entered a time.
    if (scheduledAt.trim()) {
      body.scheduledAt = new Date(scheduledAt).toISOString();
    }

    try {
      const tour = await createTour(body);
      setBusy(false);
      onCreated(tour);
    } catch {
      setSubmitError("Couldn't schedule the tour — please try again.");
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
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={!canSubmit}
          >
            {busy ? 'Scheduling…' : 'Schedule'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        {/* Tenant name (locked, read-only) */}
        {tenantName !== null ? (
          <div className={styles.field}>
            <span className={styles.label}>Tenant</span>
            <div className={styles.locked} role="group" aria-label="Tenant">
              {tenantName}
            </div>
          </div>
        ) : null}

        {/* Property (unit, required; editable typeahead) */}
        <div className={styles.field}>
          <span className={styles.label}>Property</span>
          <UnitSearchField
            value={unitPick}
            onChange={handleUnitChange}
            candidates={units}
            inputLabel="Property"
          />
        </div>

        {/* Tour type (prefilled from unit.tour_process; staff can override) */}
        <label className={styles.field}>
          <span className={styles.label}>Tour type</span>
          <select
            className={styles.input}
            aria-label="Tour type"
            value={tourType}
            onChange={handleTourTypeChange}
          >
            {TOUR_TYPES.map((t) => (
              <option key={t} value={t}>
                {TOUR_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {/* Date & time (optional) */}
        <label className={styles.field}>
          <span className={styles.label}>Date &amp; time</span>
          <input
            className={styles.input}
            type="datetime-local"
            aria-label="Date & time"
            value={scheduledAt}
            onChange={handleDateChange}
          />
          {hasNoTime && dateError === null ? (
            <p className={styles.hint}>
              No time yet — creates a tour request you can book later.
            </p>
          ) : null}
          {dateError !== null ? (
            <p role="alert" className={styles.error}>
              {dateError}
            </p>
          ) : null}
        </label>

        {/* Generic submission error */}
        {submitError !== null ? (
          <p role="alert" className={styles.error}>
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
