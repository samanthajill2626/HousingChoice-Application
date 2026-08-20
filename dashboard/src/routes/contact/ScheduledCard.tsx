// ScheduledCard — ONE not-yet-sent scheduled message in the contact's pinned
// "Upcoming" section (scheduled-message-visibility, Part B client). Rendered
// distinct from a sent bubble: a dashed, muted card with a clock icon, the fire
// time (relative + absolute, or "sending shortly" once it's due), the body, a
// source tag, and — when the message is armed but will be skipped — an amber
// "Will be skipped — <reason>" line. Purely presentational; the server owns the
// `upcoming` bucket and its suppression.
import { suppressionNote, type TimelineScheduled } from '../../api/index.js';
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
  // A DEFERRAL, not a drop - suppressionNote leads this one with "Will wait".
  quiet_hours: 'quiet hours',
  // Neither a drop nor a timed deferral - suppressionNote leads this one with
  // "Paused", so it reads "Paused - send manually". Distinct from the
  // sms_sending_disabled copy above ("SMS sending paused"), which is the
  // env-wide kill switch rather than this one rung awaiting a person.
  paused: 'send manually',
};

/** The fire-time line: while the send is still in the future, "sends <relative> -
 *  <absolute>"; once it's at/past due (the worker just hasn't run yet), the
 *  honest "sending shortly". The ABSOLUTE half renders in `timezone` - the zone
 *  the body below it was composed in (spec D8) - so a navigator outside the org's
 *  zone never reads a card whose time disagrees with its own text. sendRelative
 *  is purely relative, hence zone-independent, and stays untouched. */
function fireTimeLabel(at: string, now: number, timezone?: string): string {
  // Imminent (at/past fire time) → the honest "sending shortly", no absolute.
  if (new Date(at).getTime() <= now) return 'sending shortly';
  // Future → "sends in Nh - <absolute>" (sendRelative is the shared wording).
  return [sendRelative(at, now), dateTime(at, timezone)].filter(Boolean).join(' - ');
}

/** Every string this line can carry is a PROMISE that the message goes out at a
 *  time. A held-back rung (manual-only hold-back) breaks that promise, so it gets
 *  the state instead of a time - "sending shortly" or "sends in 6 days" over a
 *  line reading "Paused" is a card arguing with itself. */
function scheduledLabel(
  item: TimelineScheduled,
  now: number,
  timezone?: string,
): string {
  if (item.suppression?.reason === 'paused') return 'Paused';
  return fireTimeLabel(item.at, now, timezone);
}

export function ScheduledCard({
  item,
  now = Date.now(),
  timezone,
}: {
  item: TimelineScheduled;
  /** Injectable clock for deterministic tests (defaults to Date.now()). */
  now?: number;
  /** IANA zone the body was composed in. Absent (older backend, a stale cached
   *  response, a failed bucket fetch) -> the absolute time keeps the browser
   *  zone, i.e. exactly today's behavior. */
  timezone?: string;
}): React.JSX.Element {
  // "Will wait" for quiet hours (the send is DEFERRED to quiet-end), "Will be
  // skipped" for every reason that really drops the message.
  const suppression =
    item.suppression !== undefined
      ? suppressionNote(
          item.suppression.reason,
          // `?? reason` (the RemindersPanel / DeadlinesNudgesCard posture): this
          // was the one caller without a fallback, and a reason the running
          // bundle does not know rendered the literal "Will be skipped -
          // undefined" on a real card. A raw reason string is ugly; "undefined"
          // is broken. Reachable whenever a client is older than its API.
          SUPPRESSION_COPY[item.suppression.reason] ?? item.suppression.reason,
        )
      : undefined;

  return (
    <div className={styles.scheduled}>
      <div className={styles.scheduledHead}>
        <span className={styles.scheduledClock} aria-hidden="true">
          🕐
        </span>
        <span className={styles.scheduledFire}>{scheduledLabel(item, now, timezone)}</span>
        <span className={styles.scheduledTag}>{SOURCE_TAG[item.source]}</span>
      </div>
      <div className={styles.scheduledBody}>{item.body}</div>
      {suppression !== undefined ? (
        // Quiet hours is a calm "sends later", not a problem - muted tone;
        // every real suppression stays amber.
        <p
          className={
            item.suppression?.reason === 'quiet_hours'
              ? styles.scheduledSkipMuted
              : styles.scheduledSkip
          }
        >
          {suppression}
        </p>
      ) : null}
    </div>
  );
}
