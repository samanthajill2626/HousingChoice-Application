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
//
// FIRE liveness: a rung FIRING is different — the send runs in the WORKER
// process, whose events never reach the app's SSE clients (the lib/events.ts
// single-instance seam; same class as broadcasts-list-liveness-worker-seam).
// SSE alone left the panel stale until a manual refresh. But the panel KNOWS
// every rung's dueAt, so it anchors its own refetch: a timer fires just after
// the next upcoming rung's dueAt, and while a rung is due-but-unconfirmed
// (the worker polls every 60s) it re-checks on a short interval until the
// rung flips. Each landed fetch re-anchors, so the panel converges with zero
// SSE involvement.
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

// dueAt-anchored refetch tuning. FIRE_BUFFER: the worker stamps the rung just
// after dueAt, so aim slightly past it. OVERDUE_POLL: while a rung is past due
// but still shows upcoming (the worker's poll runs every 60s), re-check on this
// interval. MAX_ANCHOR: clamp far-future timers (setTimeout overflows past
// ~24.8 days; a few no-op re-anchors per day cost nothing).
const FIRE_BUFFER_MS = 2_000;
const OVERDUE_POLL_MS = 20_000;
const MAX_ANCHOR_MS = 6 * 3_600_000;

/**
 * How long until the panel should refetch on its own, or null when nothing is
 * pending (no upcoming rung → no timer). Pure — tested in isolation.
 */
export function nextReminderRefetchDelay(
  reminders: Pick<TourReminderView, 'state' | 'dueAt'>[],
  now: number,
): number | null {
  let earliest: number | null = null;
  for (const r of reminders) {
    if (r.state !== 'upcoming') continue;
    const t = new Date(r.dueAt).getTime();
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) return null;
  const untilFire = earliest - now;
  if (untilFire <= 0) return OVERDUE_POLL_MS; // due — waiting on the worker's poll
  return Math.min(untilFire + FIRE_BUFFER_MS, MAX_ANCHOR_MS);
}

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
  // The dueAt-anchored self-refetch timer (see the FIRE-liveness header note).
  const anchorRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Re-anchor the self-refetch timer on every landed ladder: fire just after
  // the next upcoming rung's dueAt (then short re-checks while the worker's
  // poll catches up). Runs off COMMITTED state so each refetch reschedules
  // itself; cleared on tourId change/unmount.
  useEffect(() => {
    if (anchorRef.current !== null) clearTimeout(anchorRef.current);
    anchorRef.current = null;
    if (state.forId !== tourId || !state.loaded) return undefined;
    const delay = nextReminderRefetchDelay(state.reminders, Date.now());
    if (delay === null) return undefined;
    anchorRef.current = setTimeout(fetchNow, delay);
    return () => {
      if (anchorRef.current !== null) clearTimeout(anchorRef.current);
      anchorRef.current = null;
    };
  }, [state, tourId, fetchNow]);

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
