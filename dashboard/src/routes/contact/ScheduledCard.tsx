// ScheduledCard — ONE not-yet-sent scheduled message in the contact's pinned
// "Upcoming" section (scheduled-message-visibility, Part B client). Rendered
// distinct from a sent bubble: a dashed, muted card with a clock icon, the fire
// time (relative + absolute, or "sending shortly" once it's due), the body, a
// source tag, and — when the message is armed but will be skipped — an amber
// "Will be skipped — <reason>" line. Purely presentational; the server owns the
// `upcoming` bucket and its suppression.
import type { TimelineScheduled } from '../../api/index.js';
import { dateTime, sendRelative } from '../placements/placementsFormat.js';
import styles from './Timeline.module.css';

/** Source → the short staff-facing tag shown on the card. */
const SOURCE_TAG: Readonly<Record<TimelineScheduled['source'], string>> = {
  tour_reminder: 'Tour reminder',
  placement_nudge: 'Nudge',
};

/** Suppression reason → the human "why it will be skipped" phrasing (brief m-copy). */
const SUPPRESSION_COPY: Readonly<
  Record<NonNullable<TimelineScheduled['suppression']>['reason'], string>
> = {
  contact_opted_out: 'contact opted out',
  manual_mode: 'conversation in manual mode',
  sms_sending_disabled: 'SMS sending paused',
  stale_stage: 'no longer applies',
};

/** The fire-time line: while the send is still in the future, "sends <relative> -
 *  <absolute>"; once it's at/past due (the worker just hasn't run yet), the
 *  honest "sending shortly". */
function fireTimeLabel(at: string, now: number): string {
  // Imminent (at/past fire time) → the honest "sending shortly", no absolute.
  if (new Date(at).getTime() <= now) return 'sending shortly';
  // Future → "sends in Nh - <absolute>" (sendRelative is the shared wording).
  return [sendRelative(at, now), dateTime(at)].filter(Boolean).join(' - ');
}

export function ScheduledCard({
  item,
  now = Date.now(),
}: {
  item: TimelineScheduled;
  /** Injectable clock for deterministic tests (defaults to Date.now()). */
  now?: number;
}): React.JSX.Element {
  const suppression =
    item.suppression !== undefined ? SUPPRESSION_COPY[item.suppression.reason] : undefined;

  return (
    <div className={styles.scheduled}>
      <div className={styles.scheduledHead}>
        <span className={styles.scheduledClock} aria-hidden="true">
          🕐
        </span>
        <span className={styles.scheduledFire}>{fireTimeLabel(item.at, now)}</span>
        <span className={styles.scheduledTag}>{SOURCE_TAG[item.source]}</span>
      </div>
      <div className={styles.scheduledBody}>{item.body}</div>
      {suppression !== undefined ? (
        <p className={styles.scheduledSkip}>Will be skipped — {suppression}</p>
      ) : null}
    </div>
  );
}
