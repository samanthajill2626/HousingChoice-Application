// RemindersPanel — the armed reminder ladder for a tour, shown on TourDetail
// under the Status/Scheduled block. Fetches GET /api/tours/:tourId/reminders
// and renders each rung (confirmation / day_before / morning_of / en_route /
// no_show_checkin) as a row: a human kind label, a state chip (upcoming =
// amber with relative fire time - sent = green with the absolute sent-at -
// canceled = muted, struck-through), the body as secondary text, and — when
// the rung is armed-but-will-be-skipped — a "Will be skipped — <reason>" note.
// The NEXT rung to fire is highlighted.
//
// Staff-facing panel on a staff-only page, so "reminders"/"tour" wording is fine.
//
// LIVE: arming/rescheduling/canceling a reminder ladder emits a
// `scheduled.updated` SSE event (advisory payload - it carries no tourId, so we
// refetch on any), and every mutation on this tour emits `tour.updated` - we
// subscribe to both (the useTourActivity pattern) so an on-page Book/Reschedule/
// Mark-toured refreshes the ladder without a reload.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTourReminders,
  useEventStream,
  ApiError,
  REMINDER_KIND_LABELS,
  REMINDER_SUPPRESSION_LABELS,
  type TourReminderView,
  type TourUpdatedEvent,
} from '../../api/index.js';
import { sendRelative, dateTime } from '../placements/placementsFormat.js';
import { Card } from '../contact/Card.js';
import styles from './RemindersPanel.module.css';

/** A compact state chip for a single rung, mirroring DeadlineChip's tone pattern. */
function StateChip({ rung }: { rung: TourReminderView }): React.JSX.Element {
  if (rung.state === 'sent') {
    const when = rung.sentAt !== undefined ? dateTime(rung.sentAt) : '';
    return (
      <span className={`${styles.chip} ${styles.sent}`}>
        {when ? `Sent - ${when}` : 'Sent'}
      </span>
    );
  }
  if (rung.state === 'canceled') {
    return <span className={`${styles.chip} ${styles.canceled}`}>Canceled</span>;
  }
  // upcoming — amber, with the relative FIRE time. These are reminders that WILL
  // be sent, so the wording is "sends in Nh" / "sending shortly" (mirrors the
  // contact-timeline ScheduledCard), NOT the "due in"/"overdue" used for deadlines.
  const text = sendRelative(rung.dueAt);
  return (
    <span className={`${styles.chip} ${styles.upcoming}`}>
      {text || 'Upcoming'}
    </span>
  );
}

/** The last LANDED fetch: the ladder + which tourId it describes (loading is
 *  derived when it doesn't match - the useTourActivity pattern, no setState in
 *  the effect body). */
interface Committed {
  reminders: TourReminderView[];
  nextId: string | undefined;
  error: string | null;
  /** Which tourId this state describes. */
  forId: string;
  /** False until the first fetch for forId lands. */
  loaded: boolean;
}

export function RemindersPanel({ tourId }: { tourId: string }): React.JSX.Element {
  const [state, setState] = useState<Committed>({
    reminders: [],
    nextId: undefined,
    error: null,
    forId: tourId,
    loaded: false,
  });

  // Track the in-flight request so a refetch (SSE-driven or tourId change)
  // supersedes the previous one and a late response can't clobber fresher data.
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(() => {
    if (!tourId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    getTourReminders(tourId, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({
          reminders: page.reminders,
          nextId: page.next?.reminderId,
          error: null,
          forId: tourId,
          loaded: true,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setState({
          reminders: [],
          nextId: undefined,
          error: err instanceof ApiError ? err.message : 'Failed to load reminders',
          forId: tourId,
          loaded: true,
        });
      });
  }, [tourId]);

  useEffect(() => {
    fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Live: refetch when a reminder ladder changes anywhere (scheduled.updated has
  // no tourId to filter on) or when THIS tour mutates (belt-and-suspenders - the
  // arm/cancel rides the same PATCH that emits it). Refetches are QUIET: the
  // prior ladder stays up until the fresh one lands - no loading flash.
  const onScheduledUpdated = useCallback(() => fetchNow(), [fetchNow]);
  const onTourUpdated = useCallback(
    (ev: TourUpdatedEvent) => {
      if (ev.tourId === tourId) fetchNow();
    },
    [tourId, fetchNow],
  );
  useEventStream({ onScheduledUpdated, onTourUpdated });

  // Committed state is for a previous tourId (or nothing landed yet) -> loading.
  const loading = state.forId !== tourId || !state.loaded;
  const { reminders, nextId, error } = state;

  return (
    <Card title="Reminders">
      {loading ? (
        <p className={styles.muted} aria-live="polite">
          Loading reminders…
        </p>
      ) : error !== null ? (
        <p className={styles.muted} role="alert">
          {error}
        </p>
      ) : reminders.length === 0 ? (
        <p className={styles.muted}>No reminders armed.</p>
      ) : (
        <ul className={styles.rows}>
          {reminders.map((rung) => {
            const isNext = rung.reminderId === nextId;
            const suppression =
              rung.suppression !== undefined
                ? REMINDER_SUPPRESSION_LABELS[rung.suppression.reason] ?? rung.suppression.reason
                : undefined;
            return (
              <li
                key={rung.reminderId}
                className={`${styles.row} ${isNext ? styles.next : ''}`}
                {...(isNext && { 'aria-current': 'step' as const })}
              >
                <div className={styles.rowHead}>
                  <span
                    className={`${styles.kind} ${rung.state === 'canceled' ? styles.struck : ''}`}
                  >
                    {REMINDER_KIND_LABELS[rung.kind] ?? rung.kind}
                  </span>
                  {isNext ? <span className={styles.nextTag}>Next</span> : null}
                  <StateChip rung={rung} />
                </div>
                <p className={`${styles.body} ${rung.state === 'canceled' ? styles.struck : ''}`}>
                  {rung.body}
                </p>
                {suppression !== undefined ? (
                  <p className={styles.suppression}>Will be skipped — {suppression}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
