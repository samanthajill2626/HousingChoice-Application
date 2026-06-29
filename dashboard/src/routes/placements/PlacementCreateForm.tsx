// PlacementCreateForm — the "New placement" dialog (Modal). Creates one deal
// (this tenant on this unit) at a starting stage, with an optional label.
//
// A pre-filled side (tenantId/unitId prop set) renders LOCKED read-only (the
// caller already knows that side — e.g. the listing page sets unitId, the tenant
// file sets tenantId); the OTHER side stays an editable typeahead. The non-
// blocking overlap notice (role="status") warns when the chosen tenant/unit
// already has an active placement, but NEVER blocks submit (warn-but-allow).
//
// Navigation lives in the entry points: on a 201 the form calls onCreated and the
// caller closes + navigates (parity with ContactCreateForm). The form never
// navigates itself.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createPlacement,
  getContact,
  getContacts,
  getPlacementsBy,
  getUnit,
  getUnits,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  TERMINAL_STAGES,
  type Contact,
  type PlacementItem,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import {
  ContactSearchField,
  type ContactSearchValue,
} from '../contact/ContactSearchField.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import styles from './PlacementCreateForm.module.css';

export interface PlacementCreateFormProps {
  /** Pre-fill + lock the tenant side. */
  tenantId?: string;
  /** Pre-fill + lock the unit side. */
  unitId?: string;
  onClose: () => void;
  onCreated: (placement: PlacementItem) => void;
}

const FORM_ID = 'placement-create-form';
const DEFAULT_STAGE: PlacementStage = 'send_application';

/** The starting-stage options: every non-terminal stage, in ladder order. */
const STARTING_STAGES: readonly PlacementStage[] = PLACEMENT_STAGES.filter(
  (s) => !TERMINAL_STAGES.has(s),
);

/** Display name for a tenant contact (name → phone → "Unknown contact"). */
function tenantLabel(c: Contact): string {
  const phone = c.phones?.find((p) => p.primary)?.phone ?? c.phone;
  return contactDisplayName(c.firstName, c.lastName, phone);
}

/** Display label for a unit (formatted address → unitId fallback). */
function unitDisplayLabel(u: UnitItem): string {
  return formatAddress(u.address) || u.unitId;
}

export function PlacementCreateForm({
  tenantId,
  unitId,
  onClose,
  onCreated,
}: PlacementCreateFormProps): React.JSX.Element {
  // Candidate lists for the typeaheads (fetched on mount).
  const [tenants, setTenants] = useState<Contact[]>([]);
  const [units, setUnits] = useState<UnitItem[]>([]);

  // Locked-side display labels (resolved from the prop id).
  const [lockedTenantLabel, setLockedTenantLabel] = useState<string | null>(null);
  const [lockedUnitLabel, setLockedUnitLabel] = useState<string | null>(null);

  // Editable typeahead values (only used when the side is NOT locked).
  const [tenantPick, setTenantPick] = useState<ContactSearchValue>({ name: '' });
  const [unitPick, setUnitPick] = useState<UnitSearchValue>({ label: '' });

  // Starting stage + optional label.
  const [stage, setStage] = useState<PlacementStage>(DEFAULT_STAGE);
  const [tag, setTag] = useState('');

  // Overlap notices (non-blocking) for each side, with a link target. Each is
  // keyed by the id it was fetched FOR (`forId`) so we DERIVE staleness in render
  // instead of resetting with a synchronous setState in the effect (which the
  // React Compiler flags as a cascading render — set-state-in-effect). Mirrors
  // the useContactFile `forId` pattern.
  const [tenantOverlap, setTenantOverlap] = useState<{
    forId?: string;
    placement: PlacementItem | null;
  }>({ placement: null });
  const [unitOverlap, setUnitOverlap] = useState<{
    forId?: string;
    placement: PlacementItem | null;
  }>({ placement: null });

  // Submission state.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The resolved ids (from the prop OR the typeahead pick).
  const resolvedTenantId = tenantId ?? tenantPick.contactId;
  const resolvedUnitId = unitId ?? unitPick.unitId;
  const tenantLocked = tenantId !== undefined;
  const unitLocked = unitId !== undefined;

  // ── Fetch the candidate lists + resolve any locked-side label on mount. ──
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
        // Non-fatal: the list just stays empty; submit still works if a side is locked.
      }
    })();

    void (async () => {
      try {
        const page = await getUnits({}, ac.signal);
        if (ac.signal.aborted) return;
        setUnits(page.units);
        if (unitId !== undefined) {
          const hit = page.units.find((u) => u.unitId === unitId);
          if (hit) setLockedUnitLabel(unitDisplayLabel(hit));
        }
      } catch {
        // Non-fatal.
      }
    })();

    // Fallback label resolution for a locked side not present in the first page.
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
    if (unitId !== undefined) {
      void (async () => {
        try {
          const u = await getUnit(unitId, ac.signal);
          if (!ac.signal.aborted) setLockedUnitLabel((prev) => prev ?? unitDisplayLabel(u));
        } catch {
          /* fall back to the id below */
        }
      })();
    }

    return () => ac.abort();
  }, [tenantId, unitId]);

  // ── Overlap lookup: re-run whenever the resolved TENANT changes. ──
  useEffect(() => {
    if (resolvedTenantId === undefined) return;
    const id = resolvedTenantId;
    const ac = new AbortController();
    void (async () => {
      try {
        const rows = await getPlacementsBy({ tenantId: id }, ac.signal);
        if (ac.signal.aborted) return;
        const active = rows.filter((p) => !TERMINAL_STAGES.has(p.stage));
        setTenantOverlap({ forId: id, placement: active[0] ?? null });
      } catch {
        if (!ac.signal.aborted) setTenantOverlap({ forId: id, placement: null });
      }
    })();
    return () => ac.abort();
  }, [resolvedTenantId]);

  // ── Overlap lookup: re-run whenever the resolved UNIT changes. ──
  useEffect(() => {
    if (resolvedUnitId === undefined) return;
    const id = resolvedUnitId;
    const ac = new AbortController();
    void (async () => {
      try {
        const rows = await getPlacementsBy({ unitId: id }, ac.signal);
        if (ac.signal.aborted) return;
        const active = rows.filter((p) => !TERMINAL_STAGES.has(p.stage));
        setUnitOverlap({ forId: id, placement: active[0] ?? null });
      } catch {
        if (!ac.signal.aborted) setUnitOverlap({ forId: id, placement: null });
      }
    })();
    return () => ac.abort();
  }, [resolvedUnitId]);

  // Derive the CURRENT overlap per side: show a notice only when the committed
  // lookup is for the id that's resolved right now (a stale or cleared side shows
  // nothing — no synchronous reset needed).
  const tenantOverlapNow =
    tenantOverlap.forId !== undefined && tenantOverlap.forId === resolvedTenantId
      ? tenantOverlap.placement
      : null;
  const unitOverlapNow =
    unitOverlap.forId !== undefined && unitOverlap.forId === resolvedUnitId
      ? unitOverlap.placement
      : null;

  const canCreate = resolvedTenantId !== undefined && resolvedUnitId !== undefined && !busy;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (resolvedTenantId === undefined || resolvedUnitId === undefined || busy) return;

    setBusy(true);
    setError(null);

    const trimmedTag = tag.trim();
    const body = {
      tenantId: resolvedTenantId,
      unitId: resolvedUnitId,
      stage,
      ...(trimmedTag && { placement_tag: trimmedTag }),
    };

    try {
      const placement = await createPlacement(body);
      setBusy(false);
      onCreated(placement);
    } catch {
      setError("Couldn't create the placement — please try again.");
      setBusy(false);
    }
  }

  // The "other party" address for a TENANT-side overlap: the unit on that
  // existing placement (resolved from the units list; falls back to the id).
  function overlapUnitLabel(p: PlacementItem): string {
    const hit = units.find((u) => u.unitId === p.unitId);
    return hit ? unitDisplayLabel(hit) : p.unitId;
  }

  // The "other party" name for a UNIT-side overlap: the tenant on that existing
  // placement (resolved from the tenants list; falls back to the id).
  function overlapTenantLabel(p: PlacementItem): string {
    const hit = tenants.find((c) => c.contactId === p.tenantId);
    return hit ? tenantLabel(hit) : p.tenantId;
  }

  return (
    <Modal
      title="New placement"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
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
          {tenantOverlapNow !== null ? (
            <p role="status" className={styles.notice}>
              This tenant already has an active placement on{' '}
              {overlapUnitLabel(tenantOverlapNow)} — {STAGE_LABELS[tenantOverlapNow.stage]}.{' '}
              <Link to={`/placements/${tenantOverlapNow.placementId}`}>Open it</Link>
            </p>
          ) : null}
        </div>

        {/* 2 — Unit (required; locked when the unitId prop is set) */}
        <div className={styles.field}>
          <span className={styles.label}>Unit</span>
          {unitLocked ? (
            <div className={styles.locked} role="group" aria-label="Unit">
              {lockedUnitLabel ?? unitId}
            </div>
          ) : (
            <UnitSearchField
              value={unitPick}
              onChange={setUnitPick}
              candidates={units}
              inputLabel="Unit"
            />
          )}
          {unitOverlapNow !== null ? (
            <p role="status" className={styles.notice}>
              This unit already has an active placement with{' '}
              {overlapTenantLabel(unitOverlapNow)} — {STAGE_LABELS[unitOverlapNow.stage]}.{' '}
              <Link to={`/placements/${unitOverlapNow.placementId}`}>Open it</Link>
            </p>
          ) : null}
        </div>

        {/* 3 — Starting stage (required; default send_application; non-terminal only) */}
        <label className={styles.field}>
          <span className={styles.label}>Starting stage</span>
          <select
            className={styles.input}
            aria-label="Starting stage"
            value={stage}
            onChange={(e) => setStage(e.target.value as PlacementStage)}
          >
            {STARTING_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        {/* 4 — Label (optional → placement_tag) */}
        <label className={styles.field}>
          <span className={styles.label}>Label</span>
          <input
            className={styles.input}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Optional"
            autoComplete="off"
          />
        </label>

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
