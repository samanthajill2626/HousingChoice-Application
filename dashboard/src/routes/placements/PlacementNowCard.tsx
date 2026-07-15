// PlacementNowCard - the placement hub's Now card (spec 3.1): the single "what is
// happening with this placement right now, and what do I do about it" surface,
// driven by the static per-stage STAGE_DESCRIPTORS map. The 5-part anatomy:
//
//   1. Stage + phase, always present.
//   2. Gate line: amber "Waiting on: <who>" when someone else holds the ball
//      (descriptor.gate.kind === 'them'), blue "Our move: <task>" when we do
//      ('us'). The {tenant}/{landlord} tokens interpolate to the resolved names.
//      Under it, the relevant date via the shared vocabulary (scheduledFor /
//      sinceWhen), or "no date recorded" when an expected gate date is missing.
//   3. Safety-net line, ONLY when the system is chasing: the armed nudge (shared
//      sendRelative) and/or the RTA window (closesAt), from the nudges prop + the
//      placement's next-deadline fields.
//   4. Record: the stage-scoped fields, ABSORBED verbatim from the old
//      StageDataCard + PaperworkCard recorders (inspection date/outcome, rent
//      determined/accepted, and the closing checklist incl. LIF when the tenant
//      is LIF-eligible). "Record: nothing at this stage" when record === 'none'.
//   5. Advance button - the SAME action as the header CTA (onAdvance). Absent at
//      the terminal stages (moved_in / lost), which render a completed/lost
//      summary instead.
//
// The nudges come in as a PROP: PlacementDetail owns ONE nudge fetch
// (usePlacementNudges) shared with the Deadlines and nudges card, so the ladder
// is never fetched twice. Staff-facing copy ("property"/"landlord"/"tenant"),
// tokens-only colours, plain ASCII.
import { useId, useState } from 'react';
import {
  STAGE_LABELS,
  STAGE_PHASE,
  formatLostReason,
  type Contact,
  type InspectionOutcome,
  type PlacementItem,
  type PlacementNudgeView,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Card } from '../contact/Card.js';
import { contactDisplayName } from '../contact/format.js';
import { closesAt, scheduledFor, sendRelative, sinceWhen } from './placementsFormat.js';
import { STAGE_DESCRIPTORS } from './stageDescriptors.js';
import styles from './PlacementNowCard.module.css';

export function PlacementNowCard({
  placement,
  unit,
  tenant,
  landlord,
  nudges,
  nextStageLabel,
  onAdvance,
  onRecordPlacement,
  onRecordFinalRent,
  onTogglePaperwork,
}: {
  placement: PlacementItem;
  unit: UnitItem | null;
  tenant: Contact | null;
  landlord: Contact | null;
  /** The placement's nudge ladder (fetched ONCE by the parent, shared with the
   *  Deadlines and nudges card). Drives the safety-net line's armed-nudge phrase. */
  nudges: PlacementNudgeView[];
  /** The next ladder stage's label (for the Advance button copy). Absent at the
   *  terminal stages, where no Advance renders. */
  nextStageLabel?: string;
  /** Advance to the next stage - the SAME action as the header CTA. Absent at the
   *  terminal stages. */
  onAdvance?: () => void;
  /** Record a placement-level datum in place (inspection date/outcome, determined
   *  rent) - PATCHes the placement. */
  onRecordPlacement: (patch: {
    inspection_date?: string;
    inspection_outcome?: InspectionOutcome;
    rent_determined?: number;
  }) => Promise<unknown>;
  /** Record the accepted final rent in place - PATCHes the unit. */
  onRecordFinalRent: (amount: number) => Promise<unknown>;
  /** Toggle a closing-checklist field (lease_signed / lif / move_in_details). */
  onTogglePaperwork: (field: 'lease_signed' | 'lif' | 'move_in_details', checked: boolean) => void;
}): React.JSX.Element {
  const descriptor = STAGE_DESCRIPTORS[placement.stage];
  const stageLabel = STAGE_LABELS[placement.stage] ?? placement.stage;
  const phase = STAGE_PHASE[placement.stage];

  // The stage + phase line - the one element every shape (incl. terminal) shows.
  const stageHeader = (
    <p className={styles.stageLine}>
      <span className={styles.stage}>{stageLabel}</span>
      <span className={styles.phase}>{phase} phase</span>
    </p>
  );

  // Terminal stages: a completed / lost summary, and NO Advance button.
  if (descriptor.gate.kind === 'terminal') {
    const lostReason = formatLostReason(placement.lost_reason);
    return (
      <Card title="Now">
        {stageHeader}
        <p className={styles.terminal}>
          {placement.stage === 'lost'
            ? `This placement was lost${lostReason !== undefined ? ` - ${lostReason}` : ''}.`
            : 'This placement is complete - the tenant has moved in.'}
        </p>
      </Card>
    );
  }

  const isUs = descriptor.gate.kind === 'us';
  // Token interpolation: {tenant}/{landlord} -> the resolved display names (or a
  // generic noun when the contact could not be loaded - never a raw id in copy).
  const tenantName = tenant
    ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone)
    : 'the tenant';
  const landlordName = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : 'the landlord';
  const interpolate = (s: string): string =>
    s.replaceAll('{tenant}', tenantName).replaceAll('{landlord}', landlordName);
  const gateText =
    descriptor.gate.kind === 'us'
      ? `Our move: ${interpolate(descriptor.gate.move)}`
      : `Waiting on: ${interpolate(descriptor.gate.waitingOn)}`;

  const gateDate = resolveGateDate(placement, descriptor.gateDate);

  // Safety-net line (only when the system is chasing): the soonest armed nudge +
  // the RTA window when it is the current next deadline.
  const upcomingNudge = [...nudges]
    .filter((n) => n.state === 'upcoming')
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];
  const rtaWindowAt =
    placement.next_deadline_type === 'rta_window' ? placement.next_deadline_at : undefined;
  const safetyParts = [
    upcomingNudge !== undefined ? `Nudge ${sendRelative(upcomingNudge.dueAt)}` : '',
    rtaWindowAt !== undefined ? `RTA window ${closesAt(rtaWindowAt)}` : '',
  ].filter((p) => p !== '');

  return (
    <Card title="Now">
      {stageHeader}

      <div className={styles.gate} data-tone={isUs ? 'us' : 'them'} data-testid="now-gate">
        <p className={styles.gateText}>{gateText}</p>
        {gateDate !== null ? <p className={styles.gateDate}>{gateDate}</p> : null}
      </div>

      {safetyParts.length > 0 ? (
        <p className={styles.safety} data-testid="now-safety">
          {safetyParts.join(' - ')}
        </p>
      ) : null}

      <div className={styles.record}>
        <p className={styles.recordLabel}>Record</p>
        {descriptor.record === 'none' ? (
          <p className={styles.recordNone}>Record: nothing at this stage</p>
        ) : (
          <>
            <StageDataCard
              placement={placement}
              unit={unit}
              onRecordPlacement={onRecordPlacement}
              onRecordFinalRent={onRecordFinalRent}
            />
            {descriptor.record === 'paperwork' ? (
              <PaperworkCard
                placement={placement}
                lifEligible={tenant?.lifEligible === true}
                onToggle={onTogglePaperwork}
              />
            ) : null}
          </>
        )}
      </div>

      {onAdvance !== undefined && nextStageLabel !== undefined ? (
        <div className={styles.advance}>
          <Button size="sm" onClick={onAdvance}>
            Advance to {nextStageLabel}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** Resolve the date the gate line surfaces, per the descriptor's gateDate:
 *  a future appointment ("scheduled for ..."), the elapsed wait since entering
 *  the stage ("waiting since ..."), or "no date recorded" when the expected date
 *  is absent. gateDate 'none' shows no date sub-line at all. */
function resolveGateDate(
  placement: PlacementItem,
  gateDate: 'none' | 'inspection_date' | 'move_in_date' | 'stage_entered_at',
): string | null {
  switch (gateDate) {
    case 'none':
      return null;
    case 'inspection_date':
      return placement.inspection_date ? scheduledFor(placement.inspection_date) : 'no date recorded';
    case 'move_in_date':
      return placement.move_in_date ? scheduledFor(placement.move_in_date) : 'no date recorded';
    case 'stage_entered_at':
      return placement.stage_entered_at
        ? `waiting ${sinceWhen(placement.stage_entered_at)}`
        : 'no date recorded';
  }
}

/* ========================================================================== */
/* Absorbed stage-data recorders (MOVED verbatim from PlacementDetail, Task 9).*/
/* ========================================================================== */

/** The complete-paperwork checklist (rendered only at `complete_paperwork`):
 *  Lease signed + Move-in details shared always; the LIF row only when the tenant
 *  is LIF-eligible (with a "confirm if included" hint), N/A otherwise. Each toggle
 *  PATCHes the placement via the parent's `onToggle`. */
function PaperworkCard({
  placement,
  lifEligible,
  onToggle,
}: {
  placement: PlacementItem;
  lifEligible: boolean;
  onToggle: (field: 'lease_signed' | 'lif' | 'move_in_details', checked: boolean) => void;
}): React.JSX.Element {
  return (
    <Card title="Paperwork">
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={placement.lease_signed === true}
          onChange={(e) => onToggle('lease_signed', e.target.checked)}
        />
        <span className={styles.checkText}>Lease signed</span>
      </label>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={placement.move_in_details === true}
          onChange={(e) => onToggle('move_in_details', e.target.checked)}
        />
        <span className={styles.checkText}>Move-in details shared</span>
      </label>
      {lifEligible ? (
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={placement.lif === true}
            onChange={(e) => onToggle('lif', e.target.checked)}
          />
          <span className={styles.checkText}>
            LIF
            <span className={styles.checkHint}>Confirm if included</span>
          </span>
        </label>
      ) : (
        <p className={styles.checkNa}>LIF - not applicable for this tenant.</p>
      )}
    </Card>
  );
}

/** In-place stage-data entry (Approval & Move-in): at each data-bearing stage the
 *  team can RECORD that stage's value WITHOUT a stage move (the move still asks,
 *  prefilled). Prefilled from what's on file. inspection_date / inspection_outcome
 *  / rent_determined PATCH the placement (the server 409s a wrong-stage write); the
 *  accepted final_rent PATCHes the unit. Rendered null outside the four stages. */
function StageDataCard({
  placement,
  unit,
  onRecordPlacement,
  onRecordFinalRent,
}: {
  placement: PlacementItem;
  unit: UnitItem | null;
  onRecordPlacement: (patch: {
    inspection_date?: string;
    inspection_outcome?: InspectionOutcome;
    rent_determined?: number;
  }) => Promise<unknown>;
  onRecordFinalRent: (amount: number) => Promise<unknown>;
}): React.JSX.Element | null {
  switch (placement.stage) {
    case 'schedule_inspection':
      return (
        <DateRecorder
          label="Inspection date"
          buttonLabel="Record inspection date"
          initial={placement.inspection_date ?? ''}
          onRecord={(value) => onRecordPlacement({ inspection_date: value })}
        />
      );
    case 'awaiting_inspection':
      return (
        <OutcomeRecorder
          current={placement.inspection_outcome}
          onRecord={(outcome) => onRecordPlacement({ inspection_outcome: outcome })}
        />
      );
    case 'determine_rent':
      return (
        <MoneyRecorder
          title="Rent determination"
          label="Determined rent (monthly)"
          buttonLabel="Record determined rent"
          initial={placement.rent_determined}
          onRecord={(amount) => onRecordPlacement({ rent_determined: amount })}
        />
      );
    case 'awaiting_rent_acceptance':
      return (
        <MoneyRecorder
          title="Rent acceptance"
          label="Accepted rent (monthly)"
          buttonLabel="Record accepted rent"
          initial={unit?.final_rent}
          onRecord={onRecordFinalRent}
        />
      );
    default:
      return null;
  }
}

/** Shared record lifecycle for the stage-data recorders: busy + error + the async
 *  save (errors surface inline, never throw out). */
function useRecorder<T>(onRecord: (v: T) => Promise<unknown>): {
  busy: boolean;
  err: string | null;
  record: (v: T) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const record = async (v: T): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await onRecord(v);
    } catch {
      setErr('We couldn’t save that — please try again.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, record };
}

function DateRecorder({
  label,
  buttonLabel,
  initial,
  onRecord,
}: {
  label: string;
  buttonLabel: string;
  initial: string;
  onRecord: (value: string) => Promise<unknown>;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const { busy, err, record } = useRecorder<string>(onRecord);
  const id = useId();
  return (
    <Card title="Inspection">
      <label className={styles.stageDataLabel} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="date"
        className={styles.stageDataInput}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button onClick={() => value && void record(value)} disabled={busy || value === ''}>
        {buttonLabel}
      </Button>
      {err ? <p role="alert">{err}</p> : null}
    </Card>
  );
}

function MoneyRecorder({
  title,
  label,
  buttonLabel,
  initial,
  onRecord,
}: {
  title: string;
  label: string;
  buttonLabel: string;
  initial: number | undefined;
  onRecord: (amount: number) => Promise<unknown>;
}): React.JSX.Element {
  const [value, setValue] = useState(initial !== undefined ? String(initial) : '');
  const { busy, err, record } = useRecorder<number>(onRecord);
  const id = useId();
  const amount = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(amount) && amount > 0;
  return (
    <Card title={title}>
      <label className={styles.stageDataLabel} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min="1"
        inputMode="numeric"
        className={styles.stageDataInput}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button onClick={() => valid && void record(amount)} disabled={busy || !valid}>
        {buttonLabel}
      </Button>
      {err ? <p role="alert">{err}</p> : null}
    </Card>
  );
}

function OutcomeRecorder({
  current,
  onRecord,
}: {
  current: InspectionOutcome | undefined;
  onRecord: (outcome: InspectionOutcome) => Promise<unknown>;
}): React.JSX.Element {
  const [value, setValue] = useState<InspectionOutcome | undefined>(current);
  const { busy, err, record } = useRecorder<InspectionOutcome>(onRecord);
  // A group name distinct from the move modal's `inspection-outcome` - both can be
  // mounted at awaiting_inspection (the recorder card + the move dialog), and a
  // shared name would merge them into one document-wide radio group.
  const group = useId();
  return (
    <Card title="Inspection">
      <fieldset className={styles.stageDataFieldset}>
        <legend className={styles.stageDataLabel}>Inspection outcome</legend>
        <label className={styles.checkRow}>
          <input
            type="radio"
            name={group}
            checked={value === 'pass'}
            onChange={() => setValue('pass')}
          />
          <span className={styles.checkText}>Pass</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="radio"
            name={group}
            checked={value === 'fail'}
            onChange={() => setValue('fail')}
          />
          <span className={styles.checkText}>Fail</span>
        </label>
      </fieldset>
      <Button onClick={() => value && void record(value)} disabled={busy || value === undefined}>
        Record inspection outcome
      </Button>
      {err ? <p role="alert">{err}</p> : null}
    </Card>
  );
}
