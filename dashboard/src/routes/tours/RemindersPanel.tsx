// RemindersPanel — the armed reminder ladder for a tour, shown on TourDetail
// under the Status/Scheduled block. Fetches GET /api/tours/:tourId/reminders
// and renders each rung (confirmation / day_before / morning_of / en_route /
// no_show_checkin) as a row: a human kind label, a state chip (upcoming =
// amber with relative fire time · sent = green with the absolute sent-at ·
// canceled = muted, struck-through), the body as secondary text, and — when
// the rung is armed-but-will-be-skipped — a "Will be skipped — <reason>" note.
// The NEXT rung to fire is highlighted.
//
// Staff-facing panel on a staff-only page, so "reminders"/"tour" wording is fine.
import { useEffect, useState } from 'react';
import {
  getTourReminders,
  ApiError,
  REMINDER_KIND_LABELS,
  REMINDER_SUPPRESSION_LABELS,
  type TourReminderView,
} from '../../api/index.js';
import { deadlineRelative, dateTime } from '../placements/placementsFormat.js';
import styles from './RemindersPanel.module.css';

/** A compact state chip for a single rung, mirroring DeadlineChip's tone pattern. */
function StateChip({ rung }: { rung: TourReminderView }): React.JSX.Element {
  if (rung.state === 'sent') {
    const when = rung.sentAt !== undefined ? dateTime(rung.sentAt) : '';
    return (
      <span className={`${styles.chip} ${styles.sent}`}>
        {when ? `Sent · ${when}` : 'Sent'}
      </span>
    );
  }
  if (rung.state === 'canceled') {
    return <span className={`${styles.chip} ${styles.canceled}`}>Canceled</span>;
  }
  // upcoming — amber, with the relative fire time ("due in Nh" / "overdue").
  const rel = deadlineRelative(rung.dueAt);
  return (
    <span className={`${styles.chip} ${styles.upcoming}`}>
      {rel.text || 'Upcoming'}
    </span>
  );
}

export function RemindersPanel({ tourId }: { tourId: string }): React.JSX.Element {
  const [reminders, setReminders] = useState<TourReminderView[]>([]);
  const [nextId, setNextId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tourId) return;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    getTourReminders(tourId, controller.signal)
      .then((page) => {
        setReminders(page.reminders);
        setNextId(page.next?.reminderId);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load reminders');
        setLoading(false);
      });
    return () => controller.abort();
  }, [tourId]);

  return (
    <section className={styles.panel} aria-labelledby="reminders-heading">
      <h2 id="reminders-heading" className={styles.title}>
        Reminders
      </h2>

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
    </section>
  );
}
