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
//   Nudges block: the armed application-nudge ladder (GET /nudges) - each rung's
//     kind label, recipient (tenant / landlord, by NAME), a "sends ..." chip
//     (the shared sendRelative), and a per-rung Cancel / Restore. Cancel/restore
//     mirrors RemindersPanel exactly: a busyId single-flight so a double-click
//     can't fire two PATCHes, a 409 (lost race / already sent) resolves silently
//     via the post-PATCH refetch (the ladder IS the honest answer, no banner).
//
//   UI copy states the RE-ARM semantic: a stage move cancels-then-arms that
//   stage's nudge (jobs/placementNudges armNudgeForStage), so a cancel holds only
//   within the current stage.
//
// LIVE: arming/canceling a nudge emits scheduled.updated (advisory - no
// placementId, so we refetch on any). And a nudge FIRING happens in the WORKER
// process, whose events never reach the app's SSE clients (the lib/events.ts
// single-instance seam) - so, like RemindersPanel, the card anchors its own
// refetch to the next upcoming rung's dueAt via the IMPORTED nextReminderRefetchDelay.
//
// Staff-facing card on a staff-only page: "property"/"landlord"/"tenant" wording
// per the GLOSSARY. Plain-hyphen chips, plain ASCII copy.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPlacementNudges,
  patchPlacementNudge,
  clearPlacementFollowUp,
  useEventStream,
  ApiError,
  type NudgeKind,
  type PlacementNudgeView,
} from '../../api/index.js';
import { Card } from '../contact/Card.js';
import { closesAt, dateTime, expiresOn, sendRelative, wasDue } from './placementsFormat.js';
import { nextReminderRefetchDelay } from '../tours/RemindersPanel.js';
import styles from './DeadlinesNudgesCard.module.css';

/** Human-readable labels for the application-nudge rungs (staff-facing). Mirrors
 *  the server NudgeKind ladder (app/src/repos/placementNudgesRepo.ts). */
const NUDGE_KIND_LABELS: Readonly<Record<NudgeKind, string>> = {
  receipt_check: 'Receipt check',
  completion_check: 'Completion check',
  approval_check: 'Approval check',
  rta_window_closing: 'RTA window closing',
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
  // upcoming - amber, with the relative FIRE time ("sends in Nh" / "sending
  // shortly"), the same wording the tour reminder chip + the contact-timeline
  // ScheduledCard use for a message that WILL be sent.
  const text = sendRelative(nudge.dueAt);
  return <span className={`${styles.chip} ${styles.upcoming}`}>{text || 'Upcoming'}</span>;
}

/** The last LANDED fetch: the ladder + which placementId it describes (loading is
 *  derived when it doesn't match - the RemindersPanel pattern, no setState in the
 *  effect body). */
interface Committed {
  nudges: PlacementNudgeView[];
  error: string | null;
  /** Which placementId this state describes. */
  forId: string;
  /** False until the first fetch for forId lands. */
  loaded: boolean;
}

export function DeadlinesNudgesCard({
  placementId,
  tenantName,
  landlordName,
  voucherExpiration,
  rtaWindowAt,
  followUpAt,
  onEditFollowUp,
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
}): React.JSX.Element {
  const [state, setState] = useState<Committed>({
    nudges: [],
    error: null,
    forId: placementId,
    loaded: false,
  });

  // Track the in-flight request so a refetch (SSE-driven or placementId change)
  // supersedes the previous one and a late response can't clobber fresher data.
  const abortRef = useRef<AbortController | null>(null);
  // The dueAt-anchored self-refetch timer (see the worker-fire liveness note).
  const anchorRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNow = useCallback(() => {
    if (!placementId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    getPlacementNudges(placementId, controller.signal)
      .then((nudges) => {
        if (controller.signal.aborted) return;
        setState({ nudges, error: null, forId: placementId, loaded: true });
      })
      .catch((err: unknown) => {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return;
        }
        setState({
          nudges: [],
          error: err instanceof ApiError ? err.message : 'Failed to load nudges',
          forId: placementId,
          loaded: true,
        });
      });
  }, [placementId]);

  useEffect(() => {
    fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Re-anchor the self-refetch timer on every landed ladder: fire just after the
  // next upcoming rung's dueAt (then short re-checks while the worker's poll
  // catches up). Runs off COMMITTED state so each refetch reschedules itself;
  // cleared on placementId change/unmount. REUSES the RemindersPanel delay math.
  useEffect(() => {
    if (anchorRef.current !== null) clearTimeout(anchorRef.current);
    anchorRef.current = null;
    if (state.forId !== placementId || !state.loaded) return undefined;
    const delay = nextReminderRefetchDelay(state.nudges, Date.now());
    if (delay === null) return undefined;
    anchorRef.current = setTimeout(fetchNow, delay);
    return () => {
      if (anchorRef.current !== null) clearTimeout(anchorRef.current);
      anchorRef.current = null;
    };
  }, [state, placementId, fetchNow]);

  // Live: refetch when a nudge ladder changes anywhere (scheduled.updated carries
  // no placementId to filter on). Refetches are QUIET: the prior ladder stays up
  // until the fresh one lands - no loading flash.
  const onScheduledUpdated = useCallback(() => fetchNow(), [fetchNow]);
  useEventStream({ onScheduledUpdated });

  // Cancel/restore one rung: PATCH, then refetch for the honest ladder. A 409
  // means the transition lost a race (the rung fired/was claimed between render
  // and click) - the refetch shows the real state, no error banner. One in-flight
  // action at a time (busyId) so a double-click can't fire two PATCHes.
  const [busyId, setBusyId] = useState<string | null>(null);
  const onToggleCanceled = useCallback(
    (nudge: PlacementNudgeView) => {
      if (busyId !== null) return;
      setBusyId(nudge.nudgeId);
      patchPlacementNudge(placementId, nudge.nudgeId, nudge.state === 'upcoming')
        .catch(() => {
          /* 409 race / transient - the refetch below reports the honest state */
        })
        .finally(() => {
          setBusyId(null);
          fetchNow();
        });
    },
    [busyId, placementId, fetchNow],
  );

  // Clear the manual follow-up (the write emits placement.updated - the parent
  // refetches the bundle and passes followUpAt=undefined back down).
  const [clearing, setClearing] = useState(false);
  const onClearFollowUp = useCallback(() => {
    if (clearing) return;
    setClearing(true);
    clearPlacementFollowUp(placementId).finally(() => setClearing(false));
  }, [clearing, placementId]);

  const loading = state.forId !== placementId || !state.loaded;
  const { nudges, error } = state;

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
        {loading ? (
          <p className={styles.muted} aria-live="polite">
            Loading nudges...
          </p>
        ) : error !== null ? (
          <p className={styles.muted} role="alert">
            {error}
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
