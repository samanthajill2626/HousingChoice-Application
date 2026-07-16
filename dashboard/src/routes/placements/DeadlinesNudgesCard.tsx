// DeadlinesNudgesCard - the placement hub's Deadlines and nudges card (spec
// section 3.2), the placement analogue of the tour RemindersPanel.
//
//   Deadlines block: the read-only voucher expiration + RTA window (rendered via
//     the date vocabulary - expiresOn / closesAt), plus a manual follow-up row
//     with Set / Change / Clear. Set/Change open the parent's follow-up modal (the
//     header kebab's "Set follow-up" opens the SAME modal); Clear calls the clear
//     binding directly. All follow-up writes emit placement.updated, so the parent
//     refetches the placement bundle and passes the new deadline props back down.
//
//   Nudges block: the armed application-nudge ladder - each rung's kind label,
//     recipient (tenant / landlord, by NAME), a "sends ..." chip (the shared
//     sendRelative), and a per-rung Cancel / Restore. The ladder itself is fetched
//     ONCE by the parent (usePlacementNudges) and passed in as props, shared with
//     the Now card's safety-net line - the spec's "do not fetch twice" rule. The
//     cancel/restore + busyId single-flight live in that shared hook; this card is
//     the presentation of its state.
//
//   UI copy states the RE-ARM semantic: a stage move cancels-then-arms that
//   stage's nudge (jobs/placementNudges armNudgeForStage), so a cancel holds only
//   within the current stage.
//
// Staff-facing card on a staff-only page: "property"/"landlord"/"tenant" wording
// per the GLOSSARY. Plain-hyphen chips, plain ASCII copy.
import { useCallback, useState } from 'react';
import {
  clearPlacementFollowUp,
  type NudgeKind,
  type NudgeSkipReason,
  type PlacementNudgeView,
} from '../../api/index.js';
import { Card } from '../contact/Card.js';
import { closesAt, dateTime, expiresOn, sendRelative, wasDue } from './placementsFormat.js';
import styles from './DeadlinesNudgesCard.module.css';

/** Human-readable labels for the application-nudge rungs (staff-facing). Mirrors
 *  the server NudgeKind ladder (app/src/repos/placementNudgesRepo.ts). */
const NUDGE_KIND_LABELS: Readonly<Record<NudgeKind, string>> = {
  receipt_check: 'Receipt check',
  completion_check: 'Completion check',
  approval_check: 'Approval check',
  rta_window_closing: 'RTA window closing',
};

/** Why the poll retired a rung UNSENT (staff-facing, plain-hyphen copy). */
const NUDGE_SKIP_REASON_LABELS: Readonly<Record<NudgeSkipReason, string>> = {
  placement_missing: 'placement no longer exists',
  stage_moved: 'stage moved on before it fired',
  unknown_kind: 'unrecognized nudge',
  unit_missing: 'property no longer exists',
  no_landlord: 'no landlord on the property',
  contact_missing: 'recipient no longer exists',
  contact_no_phone: 'recipient has no phone number',
};

/** A compact state chip for a single nudge rung (mirrors RemindersPanel's StateChip). */
function StateChip({ nudge }: { nudge: PlacementNudgeView }): React.JSX.Element {
  if (nudge.state === 'sent') {
    const when = nudge.sentAt !== undefined ? dateTime(nudge.sentAt) : '';
    return (
      <span className={`${styles.chip} ${styles.sent}`}>{when ? `Sent - ${when}` : 'Sent'}</span>
    );
  }
  if (nudge.state === 'canceled') {
    return <span className={`${styles.chip} ${styles.canceled}`}>Canceled</span>;
  }
  if (nudge.state === 'skipped') {
    // The poll retired the rung UNSENT (claim-skip) - say why, so the chip is
    // never a false "Sent" or a permanent "sending shortly" lie.
    const reason =
      nudge.skipReason !== undefined ? NUDGE_SKIP_REASON_LABELS[nudge.skipReason] : undefined;
    return (
      <span className={`${styles.chip} ${styles.skipped}`}>
        {reason !== undefined ? `Skipped - ${reason}` : 'Skipped'}
      </span>
    );
  }
  // upcoming - amber, with the relative FIRE time ("sends in Nh" / "sending
  // shortly"), the same wording the tour reminder chip + the contact-timeline
  // ScheduledCard use for a message that WILL be sent.
  const text = sendRelative(nudge.dueAt);
  return <span className={`${styles.chip} ${styles.upcoming}`}>{text || 'Upcoming'}</span>;
}

export function DeadlinesNudgesCard({
  placementId,
  tenantName,
  landlordName,
  voucherExpiration,
  rtaWindowAt,
  followUpAt,
  onEditFollowUp,
  nudges,
  nudgesLoading,
  nudgesError,
  busyId,
  onToggleCanceled,
}: {
  placementId: string;
  tenantName: string;
  landlordName: string | null;
  /** The tenant's voucher expiration DATE (ISO), read-only. Absent when unset. */
  voucherExpiration?: string;
  /** The system-managed RTA-window close instant (ISO), read-only. Absent when
   *  it is not the placement's current next deadline. */
  rtaWindowAt?: string;
  /** The manual follow-up instant (ISO), when armed as the current next deadline. */
  followUpAt?: string;
  /** Open the parent's follow-up date/time modal (shared with the header kebab). */
  onEditFollowUp: () => void;
  /** The nudge ladder, fetched ONCE by the parent (usePlacementNudges) and shared
   *  with the Now card - this card presents it, it does not fetch it. */
  nudges: PlacementNudgeView[];
  /** True until the first nudge fetch lands. */
  nudgesLoading: boolean;
  nudgesError: string | null;
  /** The single in-flight cancel/restore rung id, or null. */
  busyId: string | null;
  /** Cancel/restore one rung (the shared hook's single-flight PATCH + refetch). */
  onToggleCanceled: (nudge: PlacementNudgeView) => void;
}): React.JSX.Element {
  // Clear the manual follow-up (the write emits placement.updated - the parent
  // refetches the bundle and passes followUpAt=undefined back down).
  const [clearing, setClearing] = useState(false);
  const onClearFollowUp = useCallback(() => {
    if (clearing) return;
    setClearing(true);
    clearPlacementFollowUp(placementId).finally(() => setClearing(false));
  }, [clearing, placementId]);

  const recipientName = (r: PlacementNudgeView['recipient']): string =>
    r === 'landlord' ? (landlordName ?? 'Landlord') : tenantName;

  return (
    <Card title="Deadlines and nudges">
      {/* --- Deadlines ------------------------------------------------------ */}
      <div className={styles.section}>
        <p className={styles.sectionLabel}>Deadlines</p>
        <ul className={styles.deadlines}>
          {voucherExpiration !== undefined ? (
            <li className={styles.deadline}>
              <span className={styles.deadlineKind}>Voucher</span>
              <span className={styles.deadlineValue}>{expiresOn(voucherExpiration)}</span>
            </li>
          ) : null}
          {rtaWindowAt !== undefined ? (
            <li className={styles.deadline}>
              <span className={styles.deadlineKind}>RTA window</span>
              <span className={styles.deadlineValue}>{closesAt(rtaWindowAt)}</span>
            </li>
          ) : null}
          <li className={styles.deadline}>
            <span className={styles.deadlineKind}>Follow-up</span>
            <span className={styles.deadlineValue}>
              {followUpAt !== undefined ? wasDue(followUpAt) : 'none set'}
            </span>
            <span className={styles.followUpActions}>
              {followUpAt !== undefined ? (
                <>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={onEditFollowUp}
                    aria-label="Change follow-up"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={onClearFollowUp}
                    disabled={clearing}
                    aria-label="Clear follow-up"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.action}
                  onClick={onEditFollowUp}
                  aria-label="Set follow-up"
                >
                  Set follow-up
                </button>
              )}
            </span>
          </li>
        </ul>
      </div>

      {/* --- Nudges --------------------------------------------------------- */}
      <div className={styles.section}>
        <p className={styles.sectionLabel}>Nudges</p>
        {nudgesLoading ? (
          <p className={styles.muted} aria-live="polite">
            Loading nudges...
          </p>
        ) : nudgesError !== null ? (
          <p className={styles.muted} role="alert">
            {nudgesError}
          </p>
        ) : nudges.length === 0 ? (
          <p className={styles.muted}>No nudges armed.</p>
        ) : (
          <ul className={styles.rows}>
            {nudges.map((nudge) => {
              const label = NUDGE_KIND_LABELS[nudge.kind] ?? nudge.kind;
              return (
                <li key={nudge.nudgeId} className={styles.row}>
                  <div className={styles.rowHead}>
                    <span
                      className={`${styles.kind} ${nudge.state === 'canceled' ? styles.struck : ''}`}
                    >
                      {label}
                    </span>
                    <span className={styles.recipient}>to {recipientName(nudge.recipient)}</span>
                    <StateChip nudge={nudge} />
                    {nudge.state === 'upcoming' || nudge.state === 'canceled' ? (
                      <button
                        type="button"
                        className={`${styles.action} ${styles.rowAction}`}
                        disabled={busyId !== null}
                        aria-label={`${nudge.state === 'upcoming' ? 'Cancel' : 'Restore'} ${label} nudge`}
                        onClick={() => onToggleCanceled(nudge)}
                      >
                        {nudge.state === 'upcoming' ? 'Cancel' : 'Restore'}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className={styles.caveat}>A stage move re-arms this stage&apos;s nudge.</p>
      </div>
    </Card>
  );
}
