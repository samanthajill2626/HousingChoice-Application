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
  patchTourReminder,
  postReminderSendNow,
  sendNowErrorMessage,
  suppressionNote,
  useEventStream,
  ApiError,
  REMINDER_KIND_LABELS,
  REMINDER_SKIP_REASON_LABELS,
  REMINDER_SUPPRESSION_LABELS,
  type TourReminderEarlierView,
  type TourReminderView,
  type TourUpdatedEvent,
} from '../../api/index.js';
import { sendRelative, dateTime } from '../placements/placementsFormat.js';
import { Card } from '../contact/Card.js';
import styles from './RemindersPanel.module.css';

// dueAt-anchored refetch tuning. FIRE_BUFFER: the worker stamps the rung just
// after dueAt, so aim slightly past it. OVERDUE_POLL: while a rung is past due
// but still shows upcoming (the worker's poll runs every 30s by default -
// WORKER_POLL_INTERVAL_MS), re-check on this
// interval. MAX_ANCHOR: clamp far-future timers (setTimeout overflows past
// ~24.8 days; a few no-op re-anchors per day cost nothing).
const FIRE_BUFFER_MS = 2_000;
const OVERDUE_POLL_MS = 20_000;
const MAX_ANCHOR_MS = 6 * 3_600_000;

/**
 * How long until the panel should refetch on its own, or null when nothing is
 * pending (no upcoming rung → no timer). Pure — tested in isolation.
 *
 * A DISCONTINUED rung is not pending in the sense this timer means. The 20s
 * overdue re-check exists because the worker will flip a past-due rung within a
 * tick or two; a discontinued rung never flips by any path, so anchoring on one
 * is an unbounded 20s poll of a route that reads the tour, the unit, two
 * contacts, settings and the whole ladder. A `paused` rung is deliberately NOT
 * skipped - a human can still send it, and the panel should notice when they do.
 *
 * A SUPERSEDED rung (2026-09-01) is skipped on the same argument, and it is the
 * likelier of the two to sit here past-due: the poll only meets a rung at its
 * dueAt, so between the reschedule and the fire time nothing retires it, and a
 * rung the sweep missed can stay upcoming-and-overdue indefinitely.
 *
 * A CONVERSION_IN_PROGRESS rung is deliberately NOT skipped (review round
 * NEW-3), for the same reason `paused` is not: the state RESOLVES. The claim
 * lives for milliseconds on the happy path, and when it clears the rung either
 * fires or is swept - both of which the panel should notice. Skipping it here
 * would leave the operator looking at "Converting" long after the conversion
 * landed. Anchoring on it costs the 20s overdue re-check at worst, and the
 * grace window bounds even a crashed claim.
 *
 * Shared with the placement-nudge card (usePlacementNudges), hence the
 * structural `suppression` shape rather than a view-specific type.
 *
 * That sharing is NOT in tension with the same wave reverting the placement
 * card's `discontinued` chip branch (spec 3.1a): the revert concerned
 * surface-specific RENDERING of copy a placement writer can never produce,
 * while this is a pure helper keyed on the shared WIRE UNION - it reads a field
 * the union defines and the tour panel needs. Different rule, same wave.
 */
export function nextReminderRefetchDelay(
  reminders: (Pick<TourReminderView, 'state' | 'dueAt'> & {
    suppression?: { reason: string };
  })[],
  now: number,
): number | null {
  let earliest: number | null = null;
  for (const r of reminders) {
    if (r.state !== 'upcoming') continue;
    if (r.suppression?.reason === 'discontinued') continue;
    if (r.suppression?.reason === 'superseded') continue;
    const t = new Date(r.dueAt).getTime();
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) return null;
  const untilFire = earliest - now;
  if (untilFire <= 0) return OVERDUE_POLL_MS; // due — waiting on the worker's poll
  return Math.min(untilFire + FIRE_BUFFER_MS, MAX_ANCHOR_MS);
}

/** A compact state chip for a single rung, mirroring DeadlineChip's tone pattern.
 *  `timezone` is the zone the LIST response composed the bodies in (spec D8):
 *  the absolute sent-at renders in it so the chip and the body underneath it
 *  quote the same clock. Absent (a stale response that predates the field) ->
 *  the browser zone, i.e. exactly today's behavior. */
function StateChip({
  rung,
  timezone,
}: {
  // Typed on the EARLIER view rather than on TourReminderView so the one chip
  // ladder serves both lists: the earlier view is the wider of the two (`body`
  // optional, everything else identical), so a current rung is assignable to
  // it. The chip reads no body, so there is nothing to lose.
  rung: TourReminderEarlierView;
  timezone?: string;
}): React.JSX.Element {
  if (rung.state === 'sent') {
    const when = rung.sentAt !== undefined ? dateTime(rung.sentAt, timezone) : '';
    return (
      <span className={`${styles.chip} ${styles.sent}`}>
        {when ? `Sent - ${when}` : 'Sent'}
      </span>
    );
  }
  if (rung.state === 'canceled') {
    return <span className={`${styles.chip} ${styles.canceled}`}>Canceled</span>;
  }
  if (rung.state === 'skipped') {
    // The poll retired the rung UNSENT (claim-skip) — say why, so the chip is
    // never a permanent "sending shortly" lie. Plain-hyphen copy (Cameron).
    const reason =
      rung.skipReason !== undefined ? REMINDER_SKIP_REASON_LABELS[rung.skipReason] : undefined;
    return (
      <span className={`${styles.chip} ${styles.skipped}`}>
        {reason !== undefined ? `Skipped - ${reason}` : 'Skipped'}
      </span>
    );
  }
  // TERMINAL: the rung's KIND is retired, so nothing will ever fire it and no
  // person can either (Send now refuses with kind_retired). ABOVE `paused`
  // deliberately - "Paused" would invite exactly that refused click.
  //
  // CHIP ORDER: the `overdue` chip sits BELOW this branch and ABOVE `paused`.
  // A rung that will never send is never "overdue".
  if (rung.suppression?.reason === 'discontinued') {
    return <span className={`${styles.chip} ${styles.paused}`}>No longer sent</span>;
  }
  // TERMINAL for a different cause (supersession 2026-09-01): the KIND still
  // sends, but this rung belongs to a ladder the tour has already replaced, so
  // the poll claim-skips it and Send now answers 409 superseded. Its own word,
  // never "No longer sent" (which says the kind was retired) and never
  // "Paused" (which invites the refused click). ABOVE `overdue` for the reason
  // written above: a rung that will never send is never "overdue".
  if (rung.suppression?.reason === 'superseded') {
    return <span className={`${styles.chip} ${styles.paused}`}>Replaced</span>;
  }
  // TEMPORARY, and the only one of these three that is (review round NEW-3):
  // the tour is mid-conversion to a placement, so the poll defers this rung
  // unclaimed and Send now answers 409 conversion_in_progress - but the claim
  // resolves. ABOVE `overdue` for the reason the two above give (a rung nothing
  // is attempting is not "overdue"), and its own word rather than "Replaced" or
  // "No longer sent", both of which would declare the rung dead just before it
  // came back. TONE: `upcoming`, not the muted `paused` tone the two permanent
  // chips take - this is an in-progress state, and it should not look retired.
  if (rung.suppression?.reason === 'conversion_in_progress') {
    return <span className={`${styles.chip} ${styles.upcoming}`}>Converting</span>;
  }
  // OVERDUE (spec 8): the server says this rung's send time has passed and it
  // still has not sent. It REPLACES the fire-time promise below rather than
  // decorating it - "sending shortly" on a rung that has been sending shortly
  // for a fortnight is the perpetual-promise lie in a politer register, and
  // `state` alone cannot see it (it is derived from terminal markers, which a
  // deferred rung has none of). Above `paused` deliberately: a rung a human
  // still has to send by hand has earned the more urgent word, and the paused
  // NOTE underneath still carries the "send manually" half. Never computed
  // here - the panel does no clock arithmetic of its own, so a stale tab
  // cannot invent an overdue rung.
  if (rung.overdue === true) {
    return <span className={`${styles.chip} ${styles.upcoming}`}>Overdue</span>;
  }
  // Held back from automatic sending (manual-only hold-back): the rung is armed
  // and sendable, but NOTHING is going to fire it. The fire-time wording below
  // is a promise, so it must not be reached here - a chip reading "sending
  // shortly" above a line reading "Paused" is precisely the perpetual-"sending
  // shortly" lie this feature exists to end, and the chip is what gets read
  // first. The note underneath carries the "send manually" half.
  if (rung.suppression?.reason === 'paused') {
    return <span className={`${styles.chip} ${styles.paused}`}>Paused</span>;
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
  /** Survivors of ladders this tour has replaced (supersession spec 3.4).
   *  Lives HERE beside `reminders` rather than in its own state slot on
   *  purpose: the two describe one response, so a refetch that clears one must
   *  clear the other, and holding them in one object makes that structural
   *  rather than a thing to remember. */
  earlier: TourReminderEarlierView[];
  nextId: string | undefined;
  error: string | null;
  /** Which tourId this state describes. */
  forId: string;
  /** False until the first fetch for forId lands. */
  loaded: boolean;
  /** The zone the LIST response composed these bodies in (spec D8), held HERE
   *  rather than read per-row: the PATCH / send-now payloads return a single row
   *  and carry no zone, so a chip re-rendered from one of those would otherwise
   *  fall back to the browser zone and reintroduce the mismatch. Undefined until
   *  the first list lands (and on a response that predates the field). */
  timezone: string | undefined;
}

export function RemindersPanel({ tourId }: { tourId: string }): React.JSX.Element {
  const [state, setState] = useState<Committed>({
    reminders: [],
    earlier: [],
    nextId: undefined,
    error: null,
    forId: tourId,
    loaded: false,
    timezone: undefined,
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
          // OMITTED by the server on the common single-generation tour, and on
          // every wholly pre-migration one.
          earlier: page.earlier ?? [],
          nextId: page.next?.reminderId,
          error: null,
          forId: tourId,
          loaded: true,
          timezone: page.timezone,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setState({
          reminders: [],
          // Cleared WITH the ladder: an error banner over a stale disclosure
          // would show rows from a tour whose ladder the panel just said it
          // could not read.
          earlier: [],
          nextId: undefined,
          error: err instanceof ApiError ? err.message : 'Failed to load reminders',
          forId: tourId,
          loaded: true,
          timezone: undefined,
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

  // Cancel/restore one rung (2026-07-14): PATCH, then refetch for the honest
  // ladder (the server also emits scheduled.updated — the refetch here just
  // beats the SSE round-trip). A 409 means the transition lost a race (e.g.
  // the rung fired between render and click) — refetch shows the real state;
  // no error banner needed, the ladder IS the answer. One in-flight action at
  // a time (busyId) so a double-click can't fire two PATCHes.
  const [busyId, setBusyId] = useState<string | null>(null);
  // The last Send-now refusal, keyed to the rung it belongs to (see onSendNow).
  const [actionError, setActionError] = useState<{
    reminderId: string;
    message: string;
  } | null>(null);
  const onToggleCanceled = useCallback(
    // A Pick, not the whole view: the disclosure's Cancel (spec 3.4's one
    // allowlisted earlier action) hands it a TourReminderEarlierView, and
    // these two fields are all this handler has ever read.
    (rung: Pick<TourReminderView, 'reminderId' | 'state'>) => {
      if (busyId !== null) return;
      setBusyId(rung.reminderId);
      setActionError(null);
      patchTourReminder(tourId, rung.reminderId, rung.state === 'upcoming')
        .catch(() => {
          /* 409 race / transient — the refetch below reports the honest state */
        })
        .finally(() => {
          setBusyId(null);
          fetchNow();
        });
    },
    [busyId, tourId, fetchNow],
  );

  // Send now (quiet-hours spec section 7): force ONE pending rung out
  // immediately - a human send, so the server bypasses quiet hours, manual mode
  // and the breaker but still honors the kill switch, opt-out and consent.
  // Unlike cancel/restore, a refusal must be VISIBLE and never a silent no-op,
  // so the failure lands in a PER-RUNG slot beside the row. It deliberately does
  // NOT reuse `state.error` - that path REPLACES the whole ladder, and erasing
  // the list is exactly the wrong answer to "this one rung would not send".
  // Shares the single `busyId` slot with Cancel so the two can never race.
  const onSendNow = useCallback(
    (rung: TourReminderView) => {
      if (busyId !== null) return;
      setBusyId(rung.reminderId);
      setActionError(null);
      postReminderSendNow(tourId, rung.reminderId)
        .catch((err: unknown) => {
          setActionError({
            reminderId: rung.reminderId,
            // NEVER err.message - that is the raw machine code.
            message: sendNowErrorMessage(err instanceof ApiError ? err.code : ''),
          });
        })
        .finally(() => {
          setBusyId(null);
          fetchNow();
        });
    },
    [busyId, tourId, fetchNow],
  );

  // Committed state is for a previous tourId (or nothing landed yet) -> loading.
  const loading = state.forId !== tourId || !state.loaded;
  const { reminders, earlier, nextId, error } = state;

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
            const kindLabel = REMINDER_KIND_LABELS[rung.kind] ?? rung.kind;
            // "Will wait" for quiet hours (a DEFERRAL - the rung fires at
            // quiet-end), "Will be skipped" for every reason that really drops
            // the message. suppressionNote owns that branch for all surfaces.
            const suppression =
              rung.suppression !== undefined
                ? suppressionNote(
                    rung.suppression.reason,
                    REMINDER_SUPPRESSION_LABELS[rung.suppression.reason] ?? rung.suppression.reason,
                  )
                : undefined;
            const rowError =
              actionError !== null && actionError.reminderId === rung.reminderId
                ? actionError.message
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
                    {kindLabel}
                  </span>
                  {isNext ? <span className={styles.nextTag}>Next</span> : null}
                  <StateChip rung={rung} timezone={state.timezone} />
                  {/* Send now: only a PENDING rung can be forced out. Distinct
                      accessible name per rung (A10) - a bare repeated "Send now"
                      would be a strict-mode violation for the e2e harness.
                      The "the" is load-bearing English, not decoration: the
                      kind label is interpolated, and the 2026-08-26 relabel of
                      morning_of to "4 hours before" turns the older bare form
                      into "Send 4 hours before reminder now". Both aria
                      sentences below carry it, uniformly for every kind, and
                      e2e/support/selectors.md pins the send-now pattern.
                      NOT rendered for a DISCONTINUED rung: the server refuses it
                      permanently (409 kind_retired), so the button could only
                      ever produce an error toast. The chip above already changed
                      to stop inviting the click - "Paused" would invite exactly
                      that refused click - and this is the other half of it.
                      Cancel/Restore below stay: a discontinued rung is still a
                      pending row an operator may want off the ladder.
                      NOT rendered for a SUPERSEDED rung either (2026-09-01),
                      for the identical reason: the server refuses it 409
                      superseded, permanently, because its ladder no longer
                      exists. The current ladder's own rungs still offer the
                      button, which is where a send can actually be made.
                      NOT rendered during a CONVERSION either (review round
                      NEW-3), and this is the one TEMPORARY member of the set:
                      the server refuses with 409 conversion_in_progress while
                      the tour's `pending:` claim stands, so the button's only
                      possible answer right now is that refusal. It comes BACK
                      on its own when the claim resolves and the rung survives -
                      which is why the chip above says "Converting" rather than
                      retiring the row. */}
                  {rung.state === 'upcoming' &&
                  rung.suppression?.reason !== 'discontinued' &&
                  rung.suppression?.reason !== 'superseded' &&
                  rung.suppression?.reason !== 'conversion_in_progress' ? (
                    <button
                      type="button"
                      className={styles.action}
                      disabled={busyId !== null}
                      aria-label={`Send the ${kindLabel} reminder now`}
                      onClick={() => onSendNow(rung)}
                    >
                      Send now
                    </button>
                  ) : null}
                  {rung.state === 'upcoming' || rung.state === 'canceled' ? (
                    <button
                      type="button"
                      className={styles.action}
                      disabled={busyId !== null}
                      aria-label={`${rung.state === 'upcoming' ? 'Cancel' : 'Restore'} the ${kindLabel} reminder`}
                      onClick={() => onToggleCanceled(rung)}
                    >
                      {rung.state === 'upcoming' ? 'Cancel' : 'Restore'}
                    </button>
                  ) : null}
                </div>
                {/* GIVE THE BLANK A SENTENCE. The server empties `body` for two
                    reasons - an unusable tour time, and a read the copy needed
                    that threw (the entry-fork withhold) - and BOTH leave Send
                    now refusing, so one cause-agnostic sentence is true for
                    both. Without it the row shows a kind label, a chip, a LIVE
                    Send-now button and no text, which reads as a broken app
                    rather than a degraded read.

                    DELIBERATELY STATE-AGNOSTIC: an empty body can ride any
                    state, and a bare empty paragraph under a "Skipped -" chip
                    or a struck-through canceled row reads just as broken as the
                    upcoming case. */}
                {rung.body === '' ? (
                  <p className={styles.bodyUnavailable}>
                    Preview unavailable - this message cannot be composed right now.
                  </p>
                ) : (
                  <p className={`${styles.body} ${rung.state === 'canceled' ? styles.struck : ''}`}>
                    {rung.body}
                  </p>
                )}
                {suppression !== undefined ? (
                  // Quiet hours is a calm "sends later", not a problem - muted
                  // tone (Cameron 2026-08-04); every real suppression stays amber.
                  // `paused` takes the muted tone for the same reason and one
                  // more: while the ladder is paused EVERY rung of EVERY tour
                  // carries this line, and an amber panel that is amber always
                  // stops reading as a warning at all. `discontinued` joins them
                  // on the same argument: it is a settled decision, not a
                  // problem to act on, and it recurs on every tour that still
                  // has a pause-era rung. `superseded` is muted on exactly that
                  // argument: it reports the consequence of a change the
                  // operator themselves made (a reschedule, a conversion), and
                  // every stale rung of a rescheduled tour carries the line.
                  <p
                    className={
                      rung.suppression?.reason === 'quiet_hours' ||
                      rung.suppression?.reason === 'paused' ||
                      rung.suppression?.reason === 'discontinued' ||
                      rung.suppression?.reason === 'superseded'
                        ? styles.suppressionMuted
                        : styles.suppression
                    }
                  >
                    {suppression}
                  </p>
                ) : null}
                {rowError !== undefined ? (
                  <p className={styles.rowError} role="alert">
                    {rowError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {/* EARLIER REMINDERS (supersession spec 3.4) - a SECOND CHILD of the
          Card, deliberately OUTSIDE the ternary above. A terminal or converted
          tour has an EMPTY current ladder and a full history, so a disclosure
          written inside that chain would be invisible on precisely the tour
          with the most to show; here "No reminders armed." and the disclosure
          render together, which is the honest pair.

          A raw <details>/<summary>: this dashboard has no shared disclosure
          component, and the four existing sites (Timeline's transcript and
          email blocks, UnmatchedRow, AiRunDetail) all do exactly this. Closed
          by default because <details> has no `open` - decision D2 puts this
          list out of the default view, and the native element gives us the
          keyboard and screen-reader behaviour for free.

          Gated on loading/error so it follows the ladder: a stale disclosure
          under a loading or errored panel would be the one part of the card
          still claiming to describe this tour. */}
      {!loading && error === null && earlier.length > 0 ? (
        <details className={styles.earlier}>
          <summary className={styles.earlierToggle}>Earlier reminders ({earlier.length})</summary>
          <ul className={`${styles.rows} ${styles.earlierRows}`}>
            {earlier.map((rung) => {
              const kindLabel = REMINDER_KIND_LABELS[rung.kind] ?? rung.kind;
              const suppression =
                rung.suppression !== undefined
                  ? suppressionNote(
                      rung.suppression.reason,
                      REMINDER_SUPPRESSION_LABELS[rung.suppression.reason] ??
                        rung.suppression.reason,
                    )
                  : undefined;
              return (
                <li key={rung.reminderId} className={styles.row}>
                  <div className={styles.rowHead}>
                    <span
                      className={`${styles.kind} ${rung.state === 'canceled' ? styles.struck : ''}`}
                    >
                      {kindLabel}
                    </span>
                    <StateChip rung={rung} timezone={state.timezone} />
                    {/* THE ACTION ALLOWLIST, BY STATE (spec 3.4's table) -
                        written out here rather than inherited from the ladder
                        above, which keys off `state` alone and would therefore
                        offer Send now on this unsent rung (the server refuses
                        it 409 superseded) and Restore on a canceled one, which
                        would resurrect a rung into a ladder that no longer
                        exists. sent / canceled / skipped get NOTHING.

                        Cancel on a sweep miss is the operator's remedy of last
                        resort. It cannot beat a rung the poll already
                        claim-skipped - the repo's cancel requires
                        attribute_not_exists(skippedAt) - and the refetch then
                        reports the honest state, which is the right answer.

                        "the earlier" is load-bearing, not decoration: the
                        ladder's own Cancel interpolates the same kind label,
                        so a bare reuse would give two buttons ONE accessible
                        name - the strict-mode collision the comment above
                        records and e2e/support/selectors.md pins. */}
                    {rung.state === 'upcoming' ? (
                      <button
                        type="button"
                        className={styles.action}
                        disabled={busyId !== null}
                        aria-label={`Cancel the earlier ${kindLabel} reminder`}
                        onClick={() => onToggleCanceled(rung)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                  {/* NO BODY, NOT "Preview unavailable" (spec 3.4, T7.7). The
                      server sends a body here only when the row carries the
                      claim-time snapshot; absence means there is nothing
                      honest to show, which is a different thing from the
                      ladder's empty-string "we could not compose it right
                      now". Borrowing that sentence would send a navigator
                      hunting for an outage that is not happening. */}
                  {rung.body !== undefined && rung.body !== '' ? (
                    <p
                      className={`${styles.body} ${rung.state === 'canceled' ? styles.struck : ''}`}
                    >
                      {rung.body}
                    </p>
                  ) : null}
                  {suppression !== undefined ? (
                    // Always the muted tone here: every note in this list is
                    // `Replaced`, which reports the consequence of a change the
                    // operator themselves made. Amber would make a history
                    // drawer read as a list of problems.
                    <p className={styles.suppressionMuted}>{suppression}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
