// Tour reminder arm/cancel/poll (Tours feature, Task 4).
//
// armTourReminders — writes the ladder of reminder rows for a tour at the
//   computed dueAt offsets relative to scheduledAt, each CLAMPED out of the
//   org's quiet-hours window (spec 2026-08-03) so a stored dueAt is the real
//   send time. A rung that cannot usefully fire is RETIRED at arm time, and
//   almost every retirement writes a VISIBLE skipped row rather than leaving a
//   gap: landing at/after the tour start, colliding with a later rung's slot,
//   a stale day_before on the tour's own local date, and (spec 2026-08-26) a
//   day_before or morning_of armed too late to be worth sending. The ONE
//   silent retirement left is a clamped dueAt that is already in the past
//   relative to `now`, which after the booked-too-late rules is reachable only
//   for en_route and for clamped rungs. See the rule list in the loop.
//
// cancelTourReminders — marks all pending (unsent) rows as canceled.
//
// runDueTourReminders — stateless poll: queries listDue(now), then for each
//   row: CLAIMS it (claimSend) BEFORE sending. Only sends when the claim
//   succeeds — two concurrent poll ticks over the same row both see it in
//   listDue but only the first to claim wins. A row canceled between listDue
//   and the claim also loses (cancelForTour sets canceledAt; the claim
//   condition requires attribute_not_exists(canceledAt)). This closes both
//   the double-send window and the cancel-then-poll race in one atomic step,
//   mirroring the missedCallAutoText putJobExecutionMarker pattern.
//   Designed to be called by a setInterval in worker.ts.
//
// forceSendReminder - "Send now": a human sends ONE pending rung immediately
//   through the SAME resolve/claim/send path (resolveReminderTarget is shared
//   with the poll). It bypasses quiet hours, manual mode and the breaker
//   (automated: false) but respects the kill switch, opt-out, soft-deletion and
//   JIT consent - all checked BEFORE the claim, so a refusal never consumes the row.
//
// IDEMPOTENCY: listDue filters out rows with sentAt or canceledAt. claimSend
// atomically stamps sentAt BEFORE the send; the conditional also blocks
// canceledAt rows. Both conditions together = exactly-once delivery.
//
// PII (doc §9): NEVER log a phone number. Log only reminderId/tourId/tenantId/kind.
import { randomUUID } from 'node:crypto';
import type { MessagingAdapter } from '../adapters/messaging.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../repos/conversationsRepo.js';

import {
  type ReminderKind,
  type ReminderSkipReason,
  type TourReminderItem,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import type { UnitItem, UnitsRepo } from '../repos/unitsRepo.js';
import { isOnRoster, resolveRoster, rosterWaitExpired } from '../lib/rosterResolution.js';
import {
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { sendRelayAnnouncement } from '../services/relayAnnouncements.js';
import type { MessagesRepo } from '../repos/messagesRepo.js';
import {
  assessNamesReadFailure,
  composeTourReminderBody,
  UncomposableReminderError,
} from '../messages/tourCopy.js';
import { resolveTourContactNames } from '../lib/tourContacts.js';
import { shiftLocalDate } from '../lib/localTime.js';
import {
  clampOutOfQuietHours,
  instantAtLocalTime,
  isQuietTime,
  localDateOf,
  quietHoursWindowOf,
  resolveQuietHoursTimezone,
  type QuietHoursWindow,
} from '../lib/quietHours.js';
import { DEFAULT_ORG_SETTINGS, type SettingsRepo } from '../repos/settingsRepo.js';
import {
  rosterActionIdFor,
  type PendingRosterActionsRepo,
} from '../repos/pendingRosterActionsRepo.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { isKillSwitchOff, isOptedOut } from '../services/scheduledSendSuppression.js';

/** Thrown by composeBodyForRow when a repo read that this rung's copy
 *  actually NEEDS threw (spec 6.3b via assessNamesReadFailure's blocksSend -
 *  failure is not absence, and must not degrade into a wrong-but-valid
 *  message; but a failure the copy never renders degrades exactly like
 *  absence and the message still goes out). The poll leaves the rung
 *  UNCLAIMED - it re-lists next tick; a force-send REFUSES with
 *  'names_unavailable' so the human gets an answer (the no-show DRAFT route
 *  makes the same refusal with the same token, without this error class).
 *  Never thrown for genuine absence: absent or nameless contacts compose
 *  the fallbacks. */
export class ReminderNamesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderNamesUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// armTourReminders
// ---------------------------------------------------------------------------

/**
 * Compute the RAW dueAt for each reminder kind relative to scheduledAt (the
 * caller clamps it out of quiet hours - see armTourReminders). The window is
 * passed in because `day_before` is anchored to the ORG's local day, not UTC.
 *
 * EXPORTED for app/test/computeDueAt.test.ts, which pins the raw table
 * directly. The returned instant is RAW and UNCLAMPED - never add clamping
 * here; the caller owns it.
 */
export function computeDueAt(
  kind: ReminderKind,
  scheduledAt: string,
  now: string,
  window: QuietHoursWindow,
): string {
  const scheduled = new Date(scheduledAt).getTime();
  switch (kind) {
    case 'confirmation':
      return now; // immediate (clamped by the caller like every rung)
    case 'day_before':
      // 19:30 ORG-LOCAL the evening before the tour's LOCAL date (founder
      // retiming, Cameron 2026-08-26; was scheduledAt - 24h). Calendar-day
      // step via shiftLocalDate, local-time anchor via instantAtLocalTime -
      // the same mechanism the old 08:00 morning_of rung used. "7:30pm EST"
      // means 7:30pm local to the property; we hold one org-level zone
      // (spec 7).
      return instantAtLocalTime(
        shiftLocalDate(localDateOf(scheduledAt, window.timezone), -1),
        '19:30',
        window.timezone,
      );
    case 'morning_of':
      // FOUR hours before the tour (founder retiming, Cameron 2026-08-26;
      // was 08:00 org-local). The persisted KIND keeps its name - renaming
      // would orphan in-flight rows (spec 9); the staff-facing LABEL is
      // relabelled instead (dashboard REMINDER_KIND_LABELS).
      return new Date(scheduled - 4 * 60 * 60 * 1000).toISOString();
    case 'en_route':
      // ONE hour before (founder decision 2026-08-18, was two). Sam had always
      // read this rung as the "hour before" message, and its copy asks the
      // tenant to text when they are on the way - which is a stretch at two
      // hours out. (The older gloss here quoted a "see you soon" wording that
      // the 2026-08-26 founder rewrite replaced.) Keep the offset and the
      // wording in step if either moves again.
      return new Date(scheduled - 1 * 60 * 60 * 1000).toISOString();
    case 'no_show_checkin':
      return new Date(scheduled + 30 * 60 * 1000).toISOString();
  }
}

/**
 * THE past-tour predicate (Phase B 6.1a): a rung whose OWN dueAt precedes the
 * tour, on a tour that has already started, must not send - its copy assumes
 * the tour has not happened yet. no_show_checkin (dueAt = scheduledAt + 30m)
 * is exempt BY CONSTRUCTION, never by a name in a list: its dueAt does not
 * precede the tour. Absent/unparseable scheduledAt -> false; invalid_schedule
 * owns those rows and this gate must not steal the more accurate token.
 *
 * NOT called "start passed": that already names a different, CLIENT-side gate
 * (e2e/tests/tour-no-show-checkin.spec.ts) on the very kind this one exempts.
 *
 * SHARED with scripts/retire-paused-tour-reminders.ts (sweep population A) so
 * the sweep and the runtime can never disagree about the same row.
 *
 * INCLUSIVE at the start instant (`now >= start`): at t=start the forward-
 * looking copy is already stale. jobs/relayFanOut.ts's past-tour guard gates the
 * same sentence and uses the same boundary - one instant, one answer.
 */
export function retiredByTourStart(
  row: Pick<TourReminderItem, 'dueAt'>,
  scheduledAt: string | undefined,
  now: string,
): boolean {
  if (typeof scheduledAt !== 'string') return false;
  const start = Date.parse(scheduledAt);
  if (!Number.isFinite(start)) return false;
  // BOTH sides are compared as INSTANTS, not as text. A stored '...T15:00:00Z'
  // sorts BEFORE '...T14:00:00.000Z', and a dueAt written with a UTC offset
  // ('...T11:00:00-05:00' is 16:00Z) sorts by its printed hour - so string
  // order decides either operand by lexicographic accident rather than by time.
  // Every dueAt computeDueAt writes is canonical, but the sweep
  // (scripts/retire-paused-tour-reminders.ts) scans the WHOLE table, so a
  // hand-seeded or imported row reaches here too. An unparseable dueAt yields
  // no honest answer -> false, matching the unparseable-scheduledAt rule above.
  const due = Date.parse(row.dueAt);
  if (!Number.isFinite(due)) return false;
  // ALL THREE operands follow the ONE rule (round 2, B NOTE-4). `now` is
  // runtime-produced at every call site today, so a text compare was not
  // reachable - but an exported predicate whose arguments follow two different
  // rules is precisely where the next half-normalized comparison hides, which is
  // the finding that produced the dueAt half above.
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return false;
  return due < start && nowMs >= start;
}

/**
 * Ladder order by proximity to the event. Supersession keeps the LATEST rung of
 * a colliding pair, because the later rung's copy is the current one ("your
 * tour is tomorrow" must not land beside "your tour is today").
 *
 * THE COMPARISON IS AN INEQUALITY, NOT AN EQUALITY, and this paragraph is why
 * (Phase B spec 6.2). An earlier draft of this docblock said clamping "can only
 * push an EARLIER rung forward onto a later one's slot" - true while EVERY rung
 * clamped to the same window edge, which is what made `otherDue === dueAt` a
 * sufficient test. The en_route quiet-hours exemption (spec 6) breaks that
 * coincidence: for an 08:30 tour, en_route stays at its raw 07:30 while
 * morning_of clamps forward to 08:00, so the ladder INVERTS - a later rung now
 * fires BEFORE an earlier one, and equality would arm both. The rule the
 * equality was only ever a proxy for is "a rung is stale when a LATER rung
 * fires at or before it", so that is what supersededBySlot tests. Do not
 * narrow it back to equality.
 *
 * Exported for the fire-time backstop's batch check.
 */
export const LADDER_ORDER: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
  'no_show_checkin',
];

/**
 * do-not-remove-without-reading - the TEMPORARY human hold. EMPTY today.
 *
 * What this set is FOR: pausing a rung kind's AUTOMATIC send while leaving the
 * rung fully alive. A kind listed here still arms on booking, still shows its
 * schedule and draft copy on the tour panel, and still has a working "Send now"
 * - the poll simply never claims it, so a human decides when it goes out. The
 * panel chips "Paused - send manually" so nobody reads a fire-time promise that
 * is not coming.
 *
 * It is EMPTY, which means the ladder is fully automatic again as of 2026-08-31
 * (Phase B). The empty state is the point: it is what "TO RESTORE: empty this
 * set. Nothing else has to change" always meant, and it now holds.
 *
 * HISTORY, because the shape of the decision matters more than the dates:
 * 2026-08-20 (founder decision, Cameron) every auto-armed kind went in here -
 * mirroring the application-nudge pause of 2026-08-18
 * (jobs/placementNudges.ts MANUAL_ONLY_NUDGE_KINDS), and for the same root
 * reason: automated sends were going out under a founder who did not yet have a
 * settled model of when the system speaks for her, and an unexpected text to a
 * tenant or landlord is more expensive than a missed one. `confirmation` was
 * INCLUDED then by Cameron's explicit call, and on 2026-08-24 Sam retired that
 * rung outright ("No confirmation text at all - I'm scheduling manually, so it's
 * redundant"). That is a different decision with a different meaning, so it left
 * this set entirely.
 *
 * `no_show_checkin` was never here because it was never auto-armed at all (see
 * REMINDER_KINDS) - it has always been manual.
 *
 * TO PAUSE AGAIN: add kinds here. Nothing else has to change for the poll, the
 * tour panel, or the contact timeline - the three surfaces that read this set.
 * ONE scheduled surface does not and never did: routes/relayGroups.ts's group
 * scheduled view carries no paused chip (it reads DISCONTINUED_REMINDER_KINDS
 * only), so a re-pause would show there as a plain upcoming rung.
 *
 * A kind that must NEVER send belongs in DISCONTINUED_REMINDER_KINDS below, not
 * here. The two are deliberately separate: "paused" means a human decides WHEN,
 * so Send now must keep working; "discontinued" means it never goes out at all,
 * so Send now must refuse. Listing a retired kind here would have left a live
 * Send now button beside a "Paused" chip on a message we had decided to stop
 * sending.
 *
 * NOT the same thing as emptying REMINDER_KINDS: that stops the ARMING, and
 * takes the schedule and its copy off the tour page entirely.
 */
export const MANUAL_ONLY_REMINDER_KINDS: ReadonlySet<ReminderKind> = new Set<ReminderKind>([]);

/**
 * do-not-remove-without-reading - PERMANENT, Phase B (2026-08-31).
 *
 * Kinds that are DISCONTINUED: no path may ever send one. Distinct from
 * MANUAL_ONLY_REMINDER_KINDS on purpose - "paused" means a human decides WHEN
 * this goes out (Send now works, chip says Paused); "discontinued" means it
 * NEVER goes out (force-send refuses kind_retired, chip says "no longer
 * sent"). Conflating them put a working Send now button beside a Paused chip
 * on a kind we had retired.
 *
 * FIVE surfaces read this set, all mandatory. Two SEND surfaces: the poll's
 * due-row filter below, and forceSendReminder. Three READ surfaces, each with
 * its OWN read rather than inheriting another's answer - the tour panel
 * (routes/tourReminders.ts), the contact timeline (routes/contactTimeline.ts),
 * and the relay group thread's scheduled bucket (routes/relayGroups.ts). Miss
 * any read surface and it goes on promising "sends in Nh" for a rung that can
 * never send, which is the exact lie this mechanism exists to end. If you add
 * a sixth surface that renders a pending rung, it reads this set too.
 *
 * NOT injectable via deps - e2e must never grow a send path production lacks.
 *
 * confirmation: founder decision, Sam 2026-08-24 - "No confirmation text at
 * all - I'm scheduling manually, so it's redundant." Armed rows from the
 * pause era are retired by scripts/retire-paused-tour-reminders.ts; this set
 * is what makes that sweep hygiene rather than a race against the deploy.
 */
export const DISCONTINUED_REMINDER_KINDS: ReadonlySet<ReminderKind> = new Set<ReminderKind>([
  'confirmation',
]);

/**
 * Read the org quiet-hours window. A settings failure falls back to the
 * DEFAULTS rather than breaking arming/sending (the `resolveWithSettings`
 * posture in messages/resolve.ts) - never to "no quiet hours".
 */
export async function readQuietHoursWindow(
  settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>,
  log: Logger,
): Promise<QuietHoursWindow> {
  try {
    const settings = await settingsRepo.getOrgSettings();
    return quietHoursWindowOf({
      quietHoursEnabled: settings.quietHoursEnabled,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      timezone: resolveQuietHoursTimezone(settings),
    });
  } catch (err) {
    log.warn({ err }, 'quiet hours: settings read failed - falling back to defaults');
    return quietHoursWindowOf(DEFAULT_ORG_SETTINGS);
  }
}

// no_show_checkin is intentionally NOT auto-armed: whether a no-show happened is
// a human judgment the system cannot verify, so it is sent manually from the tour
// page ("Send no-show check-in"). The kind stays valid everywhere else (catalog,
// ReminderKind union, computeDueAt case) for that manual send.
//
// confirmation is intentionally NOT auto-armed either, for a different reason:
// the founder retired the rung outright (Sam, 2026-08-24 - "No confirmation text
// at all - I'm scheduling manually, so it's redundant"), so arming stopped
// 2026-08-31 (Phase B). The kind likewise stays valid everywhere else - the
// ReminderKind union, computeDueAt, LADDER_ORDER and the message catalog all
// keep it, so in-flight rows armed during the pause and rows in seeded history
// still compose, sort and display. SENDING is guarded separately by
// DISCONTINUED_REMINDER_KINDS above; this list only stops NEW rows being born.
const REMINDER_KINDS: ReminderKind[] = ['day_before', 'morning_of', 'en_route'];

export interface ArmTourRemindersDeps {
  tourRemindersRepo: TourRemindersRepo;
  /**
   * Quiet-hours source (REQUIRED so every call site is forced to supply one -
   * an unclamped armer would re-introduce the 4am text). Narrow read-only shape
   * (the `resolveWithSettings` precedent) so tests stub one method.
   */
  settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>;
  logger?: Logger;
}

/**
 * Arm the full reminder ladder for a tour. Every rung's dueAt is CLAMPED out of
 * the org's quiet-hours window before it is written, so a stored dueAt is the
 * real send time.
 *
 * MOST arm-time retirements write a VISIBLE skipped row (skippedAt +
 * skipReason stamped at birth) so the panel shows an honest trace instead of a
 * silent gap: a rung landing at/after the tour start, one colliding with a
 * LATER rung's slot, a day_before whose clamped time lands on the tour's own
 * local date, and - since 2026-08-26 - a day_before or morning_of armed too
 * late to be worth sending (`booked_too_late`, spec section 8). The single
 * SILENT retirement is a clamped dueAt already behind `now`; the two
 * booked-too-late rules run AHEAD of it precisely so the most-late booking
 * still leaves a trace. See the skip-rule comment in the loop below.
 *
 * `now` is the ARM instant, not the booking instant: this runs on booking, on
 * reschedule and on a status revival, and every rule is evaluated against it.
 *
 * GENERATION (supersession, 2026-09-01): one `ladderId` is minted per CALL and
 * stamped on every row the call creates, rows born already-skipped included.
 * A UUID and not a timestamp because `routes/tours.ts` takes an injectable
 * `deps.now` and the app suite injects a constant, so two arms of one tour can
 * share an instant (spec 3.1).
 *
 * Returns `{ ladderId, rows }`: the created TourReminderItem rows, plus the
 * generation id to point the tour at - `null` exactly when no row was written,
 * so a caller never writes a pointer that matches nothing. The CALLER owns the
 * tour-row write (spec D3a); `ArmTourRemindersDeps` has no `toursRepo` and this
 * function reads and writes reminder rows only.
 */
export async function armTourReminders(
  tour: TourItem,
  now: string,
  deps: ArmTourRemindersDeps,
): Promise<{ ladderId: string | null; rows: TourReminderItem[] }> {
  const log = deps.logger ?? defaultLogger;
  const created: TourReminderItem[] = [];
  // Minted up front and used by every create below, so the whole ladder shares
  // one generation. Unused (and never returned) when the call writes no row.
  const ladderId = randomUUID();

  // Invariant: no reminder rows may ever exist for a time-less ('requested')
  // tour. Callers gate arming on scheduledAt presence, but guard anyway
  // (booking arms the ladder later).
  const scheduledAt = tour.scheduledAt;
  if (typeof scheduledAt !== 'string') {
    log.warn({ tourId: tour.tourId }, 'tour reminders not armed (no scheduledAt)');
    return { ladderId: null, rows: created };
  }

  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  const scheduledIso = new Date(scheduledAt).toISOString();

  // Pass 1: compute every rung's RAW dueAt AND its CLAMPED dueAt. BOTH maps
  // are load-bearing and neither substitutes for the other:
  //   - `dues` is what gets STORED (the stored time IS the real send time -
  //     the dashboard's honesty depends on it) and what supersession compares.
  //   - `raws` is what the booked-too-late rules compare against (spec section
  //     8 is defined on the RAW offsets, BEFORE clamping). Comparing those
  //     rules against `dues` happens to agree whenever nothing clamps, which is
  //     most fixtures - and is wrong for every tour whose day_before does.
  const raws = new Map<ReminderKind, string>();
  const dues = new Map<ReminderKind, string>();
  for (const kind of REMINDER_KINDS) {
    const raw = computeDueAt(kind, scheduledAt, now, window);
    raws.set(kind, raw);
    // EN_ROUTE IS EXEMPT FROM QUIET HOURS (founder decision, Sam 2026-08-31;
    // Phase B spec 6). Its whole value is landing an hour before the tour - a
    // clamped "she is headed that way shortly" at 08:00 for an 08:30 tour is
    // not a late reminder, it is a wrong one, and for a tour at or before 08:00
    // the clamp meant NO reminder at all. There is no floor on the tour hour:
    // a 04:00 tour really does text at 03:00 (spec 6.1, handback item).
    // The exemption lives HERE, at the call site, by kind:
    // clampOutOfQuietHours is shared with the placement ladder and the
    // timeline and must stay kind-blind. The fire-time backstop in
    // processReminderRow carries the mirror-image exemption; one without the
    // other reopens the hole.
    dues.set(kind, kind === 'en_route' ? raw : clampOutOfQuietHours(raw, window));
  }

  // Spec 7.1: an org whose quiet window contains 19:30 makes every day_before
  // clamp onto the tour morning, where staleDayBefore (rule (e) below) retires
  // it 100% of the time as "superseded". Never fail and never validate the
  // setting - quiet hours are a general setting and must not be constrained by
  // one rung - just name the cause so the panel's permanent chips are
  // explainable. isQuietTime gates on window.enabled, so a disabled window
  // never warns. Fires once per ARM (booking, reschedule, revival, seed) with
  // no dedupe, which is acceptable because the default 21:00 start never trips
  // it.
  const rawDayBefore = raws.get('day_before');
  if (rawDayBefore !== undefined && isQuietTime(rawDayBefore, window)) {
    log.warn(
      {
        tourId: tour.tourId,
        rawDayBefore,
        quietHoursStart: window.start,
        quietHoursEnd: window.end,
      },
      'tour reminders: the 19:30 day_before anchor is inside the org quiet window - every day_before will clamp to the tour morning and be retired as superseded',
    );
  }

  // Pass 2: arm, applying the spec's skip rules. Rules (b) through (e) all
  // write a VISIBLE skipped row; only (a) writes nothing at all:
  //  (e) booked-too-late: day_before armed inside 4h of its RAW time, or a
  //      SAME-DAY morning_of armed inside 6h of the tour (spec section 8,
  //      2026-08-26). Evaluated FIRST, ahead of (a) - see the branch below.
  //  (a) past-dueAt (pre-existing rule) - the ONLY silent skip, and after (e)
  //      it is reachable only for en_route and for clamped rungs.
  //  (b) past-event: a clamp landing at-or-past the tour start,
  //  (c) same-slot supersession: an earlier rung clamped onto a later rung's
  //      slot loses (the later rung's copy is the current one),
  //  (d) copy-validity: day_before landing on the tour's LOCAL date is stale
  //      ("your tour is tomorrow" on tour day) regardless of exact slot.
  const tourLocalDate = localDateOf(scheduledIso, window.timezone);
  for (const kind of REMINDER_KINDS) {
    const dueAt = dues.get(kind);
    if (dueAt === undefined) continue;
    // BOOKED-TOO-LATE (spec section 8) - evaluated FIRST, ahead of the silent
    // past-dueAt drop below: for a same-day tour day_before's RAW is already
    // past, and for a sub-4h booking morning_of's RAW is already past, so the
    // MOST-late booking - exactly the one the founder needs explained - is the
    // one that would otherwise vanish without a trace (spec 8.1). RAW offsets,
    // BEFORE clamping; boundaries strictly '>'; `now` is the ARM instant, so a
    // reschedule or a status revival re-evaluates both rules against THAT
    // moment (spec 11). The shipped operator label is
    // 'booked too late for this reminder' (REMINDER_SKIP_REASON_LABELS in
    // dashboard/src/api/types.ts) - on a reschedule or a revival the "booking"
    // it names is the RE-ARM, not the original creation, so the row can read
    // "booked too late" on a tour first booked days earlier. Spec 11 accepts
    // that and rules only that the wording must not ACCUSE the operator; if the
    // phrasing is ever revisited, change the label, not this precedence.
    //
    // Precedence for these two rungs: booked-too-late > past-dueAt >
    // past-event > supersession/staleDayBefore. Known, accepted
    // mis-attribution: a rung that is ALSO clamped past the tour reports
    // booked_too_late (spec 8.1). Do NOT "fix" it by reordering - that reopens
    // the vanishing-row problem this precedence exists to solve.
    const rawAt = raws.get(kind);
    const bookedTooLate =
      rawAt !== undefined &&
      ((kind === 'day_before' &&
        now > new Date(new Date(rawAt).getTime() - 4 * 60 * 60 * 1000).toISOString()) ||
        (kind === 'morning_of' &&
          localDateOf(now, window.timezone) === tourLocalDate &&
          now > new Date(new Date(scheduledIso).getTime() - 6 * 60 * 60 * 1000).toISOString()));
    if (bookedTooLate) {
      const row = await deps.tourRemindersRepo.create({
        tourId: tour.tourId,
        kind,
        dueAt, // the CLAMPED value, like every arm-time skip row (spec 8.2)
        skipped: { at: now, reason: 'booked_too_late' },
        ladderId,
      });
      created.push(row);
      log.info(
        { tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId },
        'tour reminder retired at arm (booked too late for this rung) - visible skipped row',
      );
      continue;
    }
    // Skip rows that are already past (they would never be polled).
    if (dueAt < now) {
      log.info({ tourId: tour.tourId, kind, dueAt }, 'tour reminder skipped (dueAt in the past)');
      continue;
    }
    if (dueAt >= scheduledIso) {
      // Born skipped, not silently absent: a near-tour night booking would
      // otherwise arm NOTHING with no UI trace (Cameron 2026-08-04). The row is
      // display-only from birth - listDue and every claim exclude skippedAt.
      const row = await deps.tourRemindersRepo.create({
        tourId: tour.tourId,
        kind,
        dueAt,
        skipped: { at: now, reason: 'past_event' },
        ladderId,
      });
      created.push(row);
      log.info(
        { tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId },
        'tour reminder retired at arm (lands at/past tour start) - visible skipped row',
      );
      continue;
    }
    const myOrder = LADDER_ORDER.indexOf(kind);
    const supersededBySlot = REMINDER_KINDS.some((other) => {
      if (LADDER_ORDER.indexOf(other) <= myOrder) return false;
      const otherDue = dues.get(other);
      // WIDENED (Phase B 6.2): a LATER rung firing at or BEFORE this one makes
      // this one's copy stale - equality was only ever a proxy that held while
      // every rung clamped to the same window edge; the en_route exemption
      // breaks that coincidence (08:30 tour: en_route 07:30, morning_of
      // clamped 08:00 - reverse ladder order without this). On an unclamped
      // ladder rungs are strictly increasing, so this is false for every pair.
      // `undefined` never supersedes: absence is not an earlier send time.
      // The trailing conjunct is unchanged: the later rung must itself be
      // armable (not past-event) to supersede.
      return otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso;
    });
    const staleDayBefore =
      kind === 'day_before' && localDateOf(dueAt, window.timezone) === tourLocalDate;
    if (supersededBySlot || staleDayBefore) {
      // Same visible-trace shape as past_event above.
      const row = await deps.tourRemindersRepo.create({
        tourId: tour.tourId,
        kind,
        dueAt,
        skipped: { at: now, reason: 'quiet_hours_superseded' },
        ladderId,
      });
      created.push(row);
      log.info(
        { tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId },
        'tour reminder retired at arm (superseded by a later rung) - visible skipped row',
      );
      continue;
    }
    const row = await deps.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind,
      dueAt,
      ladderId,
    });
    created.push(row);
    log.info({ tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId }, 'tour reminder armed');
  }

  // null when the loop wrote nothing (every kind hit the SILENT past-dueAt skip
  // at the top of the loop - the only path through pass 2 that creates no row).
  // A pointer that matches no row means "no live ladder", which is a rotation
  // the caller performs deliberately, never a side effect of an empty arm.
  return { ladderId: created.length === 0 ? null : ladderId, rows: created };
}

// ---------------------------------------------------------------------------
// cancelTourReminders
// ---------------------------------------------------------------------------

export interface CancelTourRemindersDeps {
  tourRemindersRepo: TourRemindersRepo;
  logger?: Logger;
}

/**
 * Cancel all pending (unsent, uncanceled) reminders for a tour.
 * Used on reschedule and tour cancellation.
 */
export async function cancelTourReminders(
  tourId: string,
  deps: CancelTourRemindersDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  await deps.tourRemindersRepo.cancelForTour(tourId);
  log.info({ tourId }, 'tour reminders canceled');
}

// ---------------------------------------------------------------------------
// runDueTourReminders
// ---------------------------------------------------------------------------

export interface RunDueTourRemindersDeps {
  tourRemindersRepo: TourRemindersRepo;
  /**
   * Rung kinds this poll holds back from an AUTOMATIC send, leaving them
   * pending. Defaults to MANUAL_ONLY_REMINDER_KINDS, which is EMPTY today - so
   * this is now a TEST SEAM: it is how a suite exercises pause-mode behaviour
   * that production no longer exhibits by default. Mirrors
   * RunDuePlacementNudgesDeps.manualOnlyKinds (whose own set is NOT empty).
   *
   * It does NOT reach DISCONTINUED_REMINDER_KINDS, and must never be made to:
   * a discontinued kind is unsendable by every path, and a seam that could
   * switch that off would give e2e a send path production does not have.
   */
  manualOnlyKinds?: ReadonlySet<ReminderKind>;
  /**
   * Pending roster actions (contact-rosters D7), OPTIONAL: when supplied, a
   * group-eligible rung whose tour has a PENDING open_group WAITS for the open
   * instead of falling back to the tenant 1:1. Omitted (older call sites, unit
   * tests) = today's immediate fallback, unchanged.
   */
  pendingRosterActionsRepo?: Pick<PendingRosterActionsRepo, 'getById'>;
  toursRepo: ToursRepo;
  contactsRepo: ContactsRepo;
  conversationsRepo: ConversationsRepo;
  /**
   * ONE unit read serving THREE consumers - all must survive any future edit:
   *   1. Roster resolution (contact-rosters D11): the tenant-1:1 suppression
   *      check resolves the tour's CURRENT roster, whose default rung is the
   *      property's primary contact. REQUIRED so no call site can silently
   *      skip the check.
   *   2. The ADDRESS in composed reminder copy (tour-reminder-details). A
   *      missing unit or a read failure degrades to the no-address variant -
   *      never blocks a send, WITH the one carve-out consumer 3 states.
   *   3. The PROPERTY CONTACT behind {propertyContactFirstName} in the
   *      landlord-led en_route copy (tour-reminder-ladder, 2026-08-26): the
   *      unit is what resolveTourContactNames reads the primary-contact /
   *      landlord-of-record rule from. THE CARVE-OUT: on an en_route rung of a
   *      non-self_guided tour a THROWING unit read now BLOCKS the send
   *      (ReminderNamesUnavailableError) rather than degrading, because it
   *      would flip which catalog entry composes; every other rung keeps rule
   *      2 unchanged.
   * Merged from both sides at the 2026-08-06 second main sync: each branch had
   * declared this dep for its own consumer. Dropping any consumer still
   * compiles, and is silently wrong.
   */
  unitsRepo: UnitsRepo;
  sendMessageService: SendMessageService;
  /**
   * Quiet-hours source for the FIRE-TIME BACKSTOP (REQUIRED - an unfenced
   * poller would still fire every legacy 4am row). Read ONCE per tick. Narrow
   * read-only shape (the `resolveWithSettings` precedent) so tests stub one
   * method.
   */
  settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>;
  /**
   * Direct provider sends for the GROUP route (landlord_led / pm_team tours
   * with a usable group thread). Named `adapter` to match the repo idiom
   * (RelayFanOutJobDeps / SendMessageServiceDeps). The group route CANNOT go
   * through sendMessageService - it throws RelaySendNotSupportedError for
   * relay_group conversations - so reminders go through sendRelayAnnouncement
   * (the relay.intro chain): persist the rung ONCE in the thread, then
   * per-member adapter sends FROM the pool number.
   *
   * STALE REASON REMOVED (prod incident 2026-08-16): this used to cite a
   * second justification - "the worker cannot enqueue relay.fanOut (no
   * OutboundQueueAdapter in the worker process)". That was a DEFECT being
   * described as a design constraint, and it is now fixed: the worker wires
   * the same adapters the app does (jobs/queueWiring.ts). Enqueueing
   * relay.fanOut from here is therefore possible today. The direct path stays
   * on its own merits - the in-thread visibility requirement documented on
   * sendGroupReminder below - NOT because the wiring forbids the alternative.
   */
  adapter: MessagingAdapter;
  /**
   * Message persistence for the GROUP route: sendRelayAnnouncement stores each
   * rung as a system announcement in the relay thread (founder decision
   * 2026-07-14: everything sent into a relay group must be visible in its
   * dashboard thread) and records per-member delivery slots on it.
   */
  messagesRepo: MessagesRepo;
  /**
   * Shared A2P pacing bucket (optional): group-route reminders send N member
   * messages per rung through the raw adapter, so they must draw from the SAME
   * combined-outbound-rate bucket the relay fan-out / intro paths use
   * (relayFanOut.ts acquires before every adapter send). Left unset by the
   * hermetic dev tick — the fake provider needs no pacing.
   */
  tokenBucket?: { acquire(n: number): Promise<void> };
  /**
   * Live-update bus (defaults to the appEvents singleton). A successful CLAIM
   * emits `scheduled.updated` so the tour page's Reminders panel / the contact
   * timeline's Upcoming bucket refetch the ladder. In-app runs (dev tick /
   * e2e) reach SSE clients directly; when the poll runs in the WORKER process
   * the emit crosses the event bridge (lib/eventBridge.ts -> POST
   * /internal/events) whenever EVENT_BRIDGE_URL is set - the panel's
   * dueAt-anchored refetch remains the client-side backstop for bare
   * unset-URL runs.
   */
  events?: EventBus;
  logger?: Logger;
}

/**
 * The stateless poll handler. Queries all pending reminders due at or before
 * `now`, then for each row: resolves the tour, routes to the tour's masked
 * GROUP thread (landlord_led/pm_team with a usable group — direct per-member
 * adapter sends from the pool number) or to the tenant's 1:1 conversation
 * (self_guided, or any unusable group), and sends.
 *
 * Idempotent: listDue filters out rows with sentAt already set. On send
 * success, stamps sentAt so the row won't reappear.
 *
 * Error handling:
 * - SendRefusedError → log + markSent anyway (no retry — same as missedCallAutoText).
 * - Other send error → log, skip markSent (next poll will retry).
 * - Missing tour/contact/conversation → log + skip.
 */
export async function runDueTourReminders(
  now: string,
  deps: RunDueTourRemindersDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;

  const allDueRows = await deps.tourRemindersRepo.listDue(now);

  // HELD-BACK FILTER - two INDEPENDENT causes, both leaving the row PENDING:
  //   - manual-only (MANUAL_ONLY_REMINDER_KINDS, empty today): a human decides
  //     when this goes out, so "Send now" must keep working;
  //   - discontinued (DISCONTINUED_REMINDER_KINDS): this kind never goes out at
  //     all, and forceSendReminder refuses it too.
  // Neither is a claim-skip, on purpose: "Send now" (forceSendReminder) only
  // works on a row that is still pending, so retiring a PAUSED row here would
  // silently disable the very button the pause exists to preserve - and a
  // discontinued row is retired by scripts/retire-paused-tour-reminders.ts,
  // which is the ONE writer of the kind_retired skip token (spec 3.1). Both
  // panels stay honest through their own reads of the same two sets, NOT
  // through a skip stamp.
  //
  // The filtered array is ALSO what feeds the supersession backstop below (the
  // `batch` argument), and that is deliberate: supersession retires an EARLIER
  // rung when a LATER one is releasable in the same batch, so a rung that will
  // NOT send must not suppress an earlier rung that will.
  //
  // The counts are separated because the two causes call for opposite actions:
  // a manual-only count is a queue somebody has to work through, a discontinued
  // count is rows the sweep has not reached yet.
  const manualOnly = deps.manualOnlyKinds ?? MANUAL_ONLY_REMINDER_KINDS;
  const blocked = (r: TourReminderItem): boolean =>
    manualOnly.has(r.kind) || DISCONTINUED_REMINDER_KINDS.has(r.kind);
  const dueRows = allDueRows.filter((r) => !blocked(r));
  const heldBack = allDueRows.length - dueRows.length;
  if (heldBack > 0) {
    // A kind in BOTH sets is counted ONCE, under discontinued: the two counters
    // exist to tell two OPPOSITE actions apart (a queue a human has to work
    // through vs rows the sweep has not reached), and a discontinued kind has
    // no queue - nothing can send it, by hand or otherwise. Unreachable while
    // MANUAL_ONLY_REMINDER_KINDS is empty; the mechanism is kept alive for a
    // re-pause, which is exactly when the overlap becomes possible.
    const heldBackManualOnly = allDueRows.filter(
      (r) => manualOnly.has(r.kind) && !DISCONTINUED_REMINDER_KINDS.has(r.kind),
    ).length;
    const heldBackDiscontinued = allDueRows.filter((r) =>
      DISCONTINUED_REMINDER_KINDS.has(r.kind),
    ).length;
    log.info(
      { heldBack, heldBackManualOnly, heldBackDiscontinued, now },
      'tour reminder poll: rungs left pending (no automatic send)',
    );
  }
  if (dueRows.length === 0) return;

  log.info({ count: dueRows.length, now }, 'tour reminder poll: processing due rows');

  // ONE settings read per tick (not per row) - the window is the same for every
  // row in the batch, and a settings failure falls back to the defaults.
  const window = await readQuietHoursWindow(deps.settingsRepo, log);

  for (const row of dueRows) {
    try {
      await processReminderRow(row, now, window, dueRows, deps, log);
    } catch (err) {
      // Per-row errors are isolated: log + continue so one bad row doesn't
      // block the rest of the batch.
      log.error(
        { err, reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder poll: unexpected error processing row',
      );
    }
  }
}

/**
 * Retire a rung the poll cannot deliver (claim-skip): stamps skippedAt +
 * skipReason so the row leaves listDue exactly once (instead of being
 * re-listed and re-skipped every poll forever — the perpetual "sending
 * shortly" bug), and tells live surfaces to refetch so the panel flips to
 * its "Skipped - <reason>" chip.
 *
 * `reason` is the FULL ReminderSkipReason union, so the compiler cannot stop
 * you: `'booked_too_late'` is an ARM-ONLY reason (armTourReminders decides it
 * from the RAW offsets before any row exists) and must NEVER be passed here.
 *
 * There is a THIRD category since Phase B: SWEEP-ONLY reasons, which no poll
 * path passes either. `'kind_retired'` is written exclusively by
 * scripts/retire-paused-tour-reminders.ts (a discontinued kind never reaches
 * the poll at all, so there is nothing here to retire), while
 * `'tour_already_passed'` is written by BOTH the sweep and the fire-time gate
 * above - which is the point: the sweep is cleanup of a condition the runtime
 * also enforces, not the only thing enforcing it.
 *
 * The supersession pair (2026-09-01) is a FOURTH category: POLL-ONLY.
 * `'superseded'` (the rung's ladderId does not match its tour's
 * currentLadderId) and `'conversion_stalled'` (a `pending:` conversion claim
 * outlived CONVERSION_CLAIM_GRACE_MS) are both stamped HERE and nowhere else -
 * not at arm time (neither condition can exist on a row the armer is writing)
 * and not by the sweep script. forceSendReminder REFUSES on the first of them
 * rather than passing it here, because a human action never retires a rung.
 */
async function claimSkipRow(
  row: TourReminderItem,
  reason: ReminderSkipReason,
  now: string,
  deps: RunDueTourRemindersDeps,
  tenantId?: string,
): Promise<void> {
  const claimed = await deps.tourRemindersRepo.claimSkip(row.reminderId, now, reason);
  if (claimed) {
    (deps.events ?? appEvents).emit('scheduled.updated', {
      ...(tenantId !== undefined && { contactId: tenantId }),
    });
  }
}

/**
 * Compose one rung's body, resolving the unit, the two NAMES and the timezone.
 * Total EXCEPT for UncomposableReminderError, which the caller must contain (see
 * the module header). A unit-read failure degrades to no address rather than
 * propagating - a reminder must never be lost over a missing street.
 *
 * CARVE-OUT (2026-08-26, tour-reminder-ladder): the unit read also FEEDS the
 * property-contact resolution now, so on an `en_route` rung of a non-self_guided
 * tour a THROWING unit read raises ReminderNamesUnavailableError instead of
 * degrading - the failed read would flip WHICH catalog entry composes, and a
 * wrong-but-valid message is worse than a deferred one (spec 6.3b). Every other
 * rung keeps the never-lost-over-a-street rule; the scope is decided by
 * assessNamesReadFailure, which derives it from the catalog templates.
 *
 * FAILURE IS NOT ABSENCE (spec 6.3b): resolveTourContactNames never throws, so
 * a failed CONTACT read arrives here as a per-read FLAG rather than an
 * exception. Where the copy renders what that read supplies, this function
 * throws ReminderNamesUnavailableError - the poll defers the rung, force-send
 * refuses. Genuine absence (a missing or nameless contact) still composes the
 * fallbacks and still sends.
 *
 * EVERY caller must run this ABOVE its claimSend: the claim IS the sentAt stamp,
 * so a compose that threw after it would burn the rung permanently (spec W6).
 */
async function composeBodyForRow(
  row: TourReminderItem,
  tour: TourItem,
  window: QuietHoursWindow,
  deps: Pick<RunDueTourRemindersDeps, 'unitsRepo' | 'contactsRepo'>,
  log: Logger,
  /** The poll's 1:1 route has already fetched the tenant
   *  (resolveReminderTarget target.contact) - pass it through rather than
   *  reading twice. The GROUP route has read nothing; both reads happen
   *  here (spec 6.3a, ruled in scope). */
  tenantContact?: ContactItem,
): Promise<string> {
  let unit: UnitItem | undefined;
  let unitReadFailed = false;
  try {
    unit = await deps.unitsRepo.getById(tour.unitId);
  } catch (err) {
    unitReadFailed = true;
    log.warn(
      { err, tourId: tour.tourId, kind: row.kind },
      'tour reminder: unit read failed - composing without an address',
    );
  }
  const resolved = await resolveTourContactNames({
    tenantId: tour.tenantId,
    unit,
    ...(tenantContact !== undefined && { tenantContact }),
    contactsRepo: deps.contactsRepo,
    logger: log,
  });
  // THE SHARED ASSESSOR, never a bare flag: which failures matter for THIS
  // rung is a catalog fact (assessNamesReadFailure derives it from the
  // templates), so a copy edit cannot silently desync the send semantics.
  const impact = assessNamesReadFailure({
    kind: row.kind,
    tourType: tour.tourType,
    tenantReadFailed: resolved.tenantReadFailed,
    propertyReadFailed: resolved.propertyReadFailed,
    unitReadFailed,
  });
  if (impact.blocksSend) {
    throw new ReminderNamesUnavailableError(
      `tour reminder name resolution read failed (tourId=${tour.tourId}, kind=${row.kind})`,
    );
  }
  return composeTourReminderBody({
    kind: row.kind,
    scheduledAt: tour.scheduledAt ?? '',
    timezone: window.timezone,
    tourType: tour.tourType,
    names: resolved.names,
    ...(unit?.address !== undefined && { address: unit.address }),
  });
}

/**
 * Why a rung has NO deliverable target. Each value is also a ReminderSkipReason,
 * because the poll retires such a rung with exactly that claim-skip.
 */
type ReminderResolutionFailure =
  | 'tour_missing'
  | 'contact_missing'
  | 'contact_no_phone'
  | 'no_conversation';

/**
 * Is the tour's tenant on the tour's CURRENT roster (contact-rosters D11)?
 *
 *   'on'          - deliver as usual.
 *   'off'         - the operator removed them (the caseworker-to-PM
 *                   arrangement). Every TENANT-1:1-routed rung is suppressed.
 *   'unavailable' - the roster could not be read (a thread pointer that will
 *                   not load). NOT an answer: the caller must neither send nor
 *                   retire the rung, exactly like the quiet-hours backstop.
 *
 * Consults `resolveRoster` - never `resolveUsableGroup`: a CLOSED thread returns
 * no usable group but its participants are still the roster FACT (D1), and
 * reading that as "no roster" would text a removed tenant.
 */
type TenantRosterGate = 'on' | 'off' | 'unavailable';

async function tenantRosterGate(
  tour: TourItem,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<TenantRosterGate> {
  const roster = await resolveRoster(
    {
      conversations: deps.conversationsRepo,
      units: deps.unitsRepo,
      contacts: deps.contactsRepo,
      log,
    },
    {
      type: 'tour',
      id: tour.tourId,
      tenantId: tour.tenantId,
      unitId: tour.unitId,
      ...(tour.groupThreadId !== undefined && { groupThreadId: tour.groupThreadId }),
      ...(tour.roster !== undefined && { roster: tour.roster }),
    },
  );
  if (roster.source === 'unavailable') return 'unavailable';
  return isOnRoster(roster, tour.tenantId) ? 'on' : 'off';
}

/** Where one rung would be delivered, resolved PRE-CLAIM. */
type ReminderTarget =
  | { route: 'group'; tour: TourItem; group: UsableGroup }
  | { route: 'one_to_one'; tour: TourItem; contact: ContactItem; conversation: ConversationItem }
  | { unresolvable: ReminderResolutionFailure; tenantId?: string };

/**
 * Resolve a rung's send target: the tour, then the masked GROUP thread
 * (landlord_led / pm_team with a usable group) or the tenant's 1:1
 * conversation. Read-only - it claims nothing and sends nothing, so each caller
 * decides what "unresolvable" MEANS: the poll retires the rung (claim-skip with
 * the returned reason), a human force-send refuses and leaves it pending.
 *
 * `prefetchedTour` exists so the poll's past-tour gate (Phase B 6.1a), which
 * runs ABOVE every other pre-claim gate and therefore needs the tour first, is
 * a HOIST of this read rather than a second one. When it is absent (the
 * force-send path) the read happens here as it always did, and the
 * `tour_missing` answer is byte-identical either way.
 */
async function resolveReminderTarget(
  row: TourReminderItem,
  deps: RunDueTourRemindersDeps,
  log: Logger,
  prefetchedTour?: TourItem,
): Promise<ReminderTarget> {
  const tour = prefetchedTour ?? (await deps.toursRepo.get(row.tourId));
  if (!tour) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId },
      'tour reminder: tour not found',
    );
    return { unresolvable: 'tour_missing' };
  }

  // Route decision (founder decision 2026-07-02): reminders for landlord_led /
  // pm_team tours go to the tour's masked GROUP thread - the landlord/PM should
  // see them too. self_guided stays tenant-1:1 EVEN IF a group thread exists.
  // A non-self_guided tour with no USABLE group (no groupThreadId, conversation
  // missing, not a relay_group, closed, or no pool/roster) falls back to the
  // tenant-1:1 path below - a reminder must never be lost.
  if (tour.tourType !== 'self_guided') {
    const group = await resolveUsableGroup(tour, row, deps, log);
    if (group) return { route: 'group', tour, group };
  }

  // Resolve the tenant contact.
  const contact = await deps.contactsRepo.getById(tour.tenantId);
  if (!contact) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: contact not found',
    );
    return { unresolvable: 'contact_missing', tenantId: tour.tenantId };
  }

  // Primary phone (scalar back-compat, never logged).
  const phone = contact.phone;
  if (typeof phone !== 'string' || phone.length === 0) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: contact has no phone',
    );
    return { unresolvable: 'contact_no_phone', tenantId: tour.tenantId };
  }

  // Find the tenant's 1:1 conversation via phone lookup.
  const convs = await deps.conversationsRepo.findByParticipantPhone(phone);
  const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
  if (!conv) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: no 1:1 conversation found',
    );
    return { unresolvable: 'no_conversation', tenantId: tour.tenantId };
  }

  return { route: 'one_to_one', tour, contact, conversation: conv };
}

async function processReminderRow(
  row: TourReminderItem,
  now: string,
  window: QuietHoursWindow,
  batch: TourReminderItem[],
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<void> {
  // PAST-TOUR GATE (Phase B 6.1a) - FIRST, above supersededInBatch and above
  // the quiet-hours backstop. POSITION IS BEHAVIOUR here:
  //   - Below supersededInBatch, a post-tour catch-up batch retires morning_of
  //     as "superseded by" an en_route this gate then retires, putting
  //     "superseded by a later reminder" on the panel beside the rung it names
  //     reading "the tour had already happened" - on the ROUTINE
  //     worker-downtime path, not a three-way coincidence.
  //   - Below isQuietTime, a past-tour rung due inside the window re-lists
  //     unclaimed every tick until quiet-end instead of retiring once.
  // The tour read MOVES UP here with the gate rather than being duplicated:
  // resolveReminderTarget takes the pre-fetched tour below, so this is a hoist,
  // not a second read. ACCEPTED CONSEQUENCE of the hoist, pinned by a test: a
  // row that is both superseded-in-batch AND tour-missing now reads
  // `tour_missing` (it used to read `quiet_hours_superseded`) - the truer
  // answer, since a rung whose tour is gone was not superseded by anything.
  const tour = await deps.toursRepo.get(row.tourId);
  if (!tour) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId },
      'tour reminder: tour not found',
    );
    await claimSkipRow(row, 'tour_missing', now, deps);
    return;
  }
  if (retiredByTourStart(row, tour.scheduledAt, now)) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder: tour already started - retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'tour_already_passed', now, deps, tour.tenantId);
    return;
  }

  // Both quiet-hours checks below run above the group-route branch (which
  // returns early), so landlord_led / pm_team rungs are covered too.

  // RELEASE SUPERSESSION (the backstop twin of arm-time supersession): if a
  // LATER rung of the SAME tour is also due in this batch, this rung's copy is
  // stale ("your tour is tomorrow" beside "your tour is today"), so retire it
  // unsent. Covers legacy rows released together at quiet-end (e.g. a
  // pre-feature 08:00-UTC morning_of alongside a deferred day_before). The
  // batch is deliberately the ONE listDue snapshot the tick started with.
  //
  // DELIBERATELY UNGATED on window.enabled: the defect it prevents is stale copy
  // on a CATCH-UP tick (worker downtime, a slow tick, a paused container stacks
  // same-tour rungs into one batch), and that happens whether or not quiet hours
  // are on - quiet-end release is just its most common cause. The skip token
  // keeps its name for the same reason the panel's label does
  // ("superseded by a later reminder"): both stay accurate in either mode. Pinned
  // by 'release supersession applies with quiet hours DISABLED too' in
  // app/test/tourReminders.test.ts.
  const myOrder = LADDER_ORDER.indexOf(row.kind);
  const supersededInBatch = batch.some(
    (other) =>
      other.tourId === row.tourId &&
      other.reminderId !== row.reminderId &&
      LADDER_ORDER.indexOf(other.kind) > myOrder,
  );
  if (supersededInBatch) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder superseded by a later due rung - retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'quiet_hours_superseded', now, deps);
    return;
  }

  // QUIET-HOURS BACKSTOP (spec section 6), PRE-CLAIM. Normal rows are clamped
  // at arm time, so this only fires for legacy rows and worker-downtime
  // catch-up. Returning WITHOUT claiming leaves the row in listDue - it
  // re-fires within one poll tick of quiet-end. This must NEVER become a
  // post-claim refusal: claimSend IS the sentAt stamp, so a refusal after it
  // would destroy the message permanently.
  //
  // EN_ROUTE IS EXEMPT (Phase B spec 6) - the mirror image of the arm-time
  // exemption above, and one without the other reopens the hole: an exempt row
  // stored at 03:00 would arrive here and be deferred to 08:00 anyway. Quiet
  // hours used to be the only brake on a worker returning from an outage
  // overnight, which is why the PAST-TOUR GATE runs first, above this branch:
  // it is what now bounds the catch-up backlog, retiring every en_route whose
  // tour has already happened instead of texting it. Removing that gate would
  // make this exemption unsafe.
  if (row.kind !== 'en_route' && isQuietTime(now, window)) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder due during quiet hours - deferred (not claimed)',
    );
    return;
  }

  // Resolve the send target (tour -> group route, or the tenant's 1:1). Shared
  // with forceSendReminder so a human send can never route differently from the
  // poll; the POLL retires an unresolvable rung with the same claim-skip
  // reasons it always used.
  const target = await resolveReminderTarget(row, deps, log, tour);
  if ('unresolvable' in target) {
    log.info(
      {
        reminderId: row.reminderId,
        tourId: row.tourId,
        kind: row.kind,
        reason: target.unresolvable,
      },
      'tour reminder undeliverable - retiring (claim-skipped)',
    );
    await claimSkipRow(row, target.unresolvable, now, deps, target.tenantId);
    return;
  }

  if (target.route === 'group') {
    await sendGroupReminder(row, target.tour, target.group, now, window, deps, log);
    return;
  }

  // `tour` is already in scope from the past-tour gate above (the same row the
  // target resolved against, since it was handed the pre-fetched one).
  const { conversation: conv } = target;

  // D7 REMINDER COUPLING (contact-rosters): this rung is GROUP-ELIGIBLE but fell
  // back to the tenant 1:1, and the tour has a PENDING open_group - the relay
  // group is confirmed, just held until quiet-end. Sending 1:1 now would deliver
  // the reminder to the tenant alone, minutes before the group it belongs in
  // exists. Leave the rung UNCLAIMED (the ladder's existing "wait" idiom: it
  // re-lists next tick, and the open applies within one tick of quiet-end).
  // BOUNDED BY TOUR START, and since Phase B (6.1a) the bound is enforced
  // ABOVE this branch, not by it. Every rung that can reach this wait has a
  // dueAt BEFORE the tour, so the past-tour gate at the top of this function
  // has already retired it by the time the tour starts - which is what makes
  // "a morning_of reminder can never be held past the tour" true, and makes
  // the at-or-after-start escape below unreachable for a pre-tour rung. The
  // `beforeStart` disjunct STAYS as defence-in-depth: it costs nothing, and a
  // post-tour-dueAt rung (no_show_checkin) is exempt from the gate and would
  // still need it.
  if (tour.tourType !== 'self_guided' && deps.pendingRosterActionsRepo !== undefined) {
    const pendingOpen = await deps.pendingRosterActionsRepo.getById(
      rosterActionIdFor({ ownerType: 'tour', ownerId: tour.tourId, action: 'open_group' }),
    );
    const beforeStart = typeof tour.scheduledAt === 'string' && now < tour.scheduledAt;
    if (pendingOpen?.status === 'pending' && beforeStart) {
      log.info(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder: group open is pending until quiet-end - leaving the rung unclaimed',
      );
      return;
    }
  }

  // D11 (contact-rosters): delivery has resolved to the TENANT 1:1 - the ONE
  // place both doors meet. A self_guided rung lands here, and so does a
  // landlord_led/pm_team rung whose group was unusable and fell back. The check
  // therefore binds to the ROUTING OUTCOME, not the rung kind: a tenant the
  // operator removed is never texted through either door.
  //
  // PRE-CLAIM, like the quiet-hours backstop above: an 'unavailable' roster
  // returns WITHOUT claiming (the next tick retries), because a transient blip
  // must neither text a possibly-removed tenant nor burn the rung with a false
  // skip. A removed tenant IS an answer, so that rung is retired visibly.
  const gate = await tenantRosterGate(tour, deps, log);
  if (gate === 'unavailable') {
    // BOUNDED BY TIME PAST DUE. 'unavailable' is not always transient: a
    // pointer at a conversation that no longer exists (or a provisioning
    // sentinel a crash left behind) never resolves, and an unbounded wait means
    // this rung re-lists every tick FOREVER - never sent, never visibly
    // skipped, nothing on the panel to say why. Past the grace window the state
    // is treated as permanent and the rung is retired with a VISIBLE skip.
    if (rosterWaitExpired(row.dueAt, now)) {
      log.error(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind, dueAt: row.dueAt },
        'tour reminder: roster STILL unreadable past the grace window - retiring (claim-skipped)',
      );
      await claimSkipRow(row, 'roster_unavailable', now, deps, tour.tenantId);
      return;
    }
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder: roster unreadable - leaving the rung unclaimed for the next tick',
    );
    return;
  }
  if (gate === 'off') {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder: tenant is not on this tour roster - retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'tenant_not_on_roster', now, deps, tour.tenantId);
    return;
  }

  // COMPOSE ABOVE THE CLAIM (spec W6), but BELOW the roster gates above (second
  // main sync, 2026-08-06). Both branches independently put work above the
  // claim - this one composes the body, the gates decide whether the rung may
  // be sent at all - and the merge had to pick an order. GATES FIRST, because:
  // composing is PURE (a unit read + composeTourReminderBody, which does no
  // I/O), so neither order can change what gets sent or to whom; the gates need
  // nothing composition produces, and vice versa; a skipped rung needs no body
  // (claimSkip stores none), so gate-first also skips composition's unit read
  // entirely on the suppressed paths. Decisively: composing first would let an
  // unusable scheduledAt retire a rung as 'invalid_schedule' while the roster
  // was merely UNREADABLE - overriding D11's rule that an unreadable roster
  // leaves the rung UNCLAIMED until the grace bound. Order therefore preserves
  // both intents; `forceSendReminder` merged to this same order on its own.
  //
  // An unusable scheduledAt cannot produce a body, and claimSend IS the sentAt
  // stamp - so this must still resolve BEFORE the claim. An uncontained throw
  // would escape into the caller's per-row catch, leaving the row unclaimed and
  // re-listed by every tick forever; the claim-skip retires it exactly once.
  let body: string;
  try {
    body = await composeBodyForRow(row, tour, window, deps, log, target.contact);
  } catch (err) {
    if (err instanceof UncomposableReminderError) {
      log.error(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder body uncomposable - retiring (claim-skipped)',
      );
      await claimSkipRow(row, 'invalid_schedule', now, deps, tour.tenantId);
      return;
    }
    if (err instanceof ReminderNamesUnavailableError) {
      // BOUNDED (Phase B spec 7, ledger item 7 - the acceptance that expired
      // with the pause): same grace as the roster twin above. Past it the copy
      // is stale regardless of recovery - an "on the way" text landing ninety
      // minutes late is worse than a chip saying it did not send - so retire
      // visibly instead of re-listing forever.
      if (rosterWaitExpired(row.dueAt, now)) {
        log.error(
          { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind, dueAt: row.dueAt },
          'tour reminder: name resolution STILL failing past the grace window - retiring (claim-skipped)',
        );
        await claimSkipRow(row, 'names_unavailable', now, deps, tour.tenantId);
        return;
      }
      log.warn(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder: name resolution read failed - leaving the rung unclaimed for the next tick',
      );
      return;
    }
    throw err;
  }

  // CLAIM-BEFORE-SEND: atomically stamp sentAt BEFORE the outbound send so two
  // concurrent poll ticks both see the same due row but only the first to claim
  // wins. The claim condition also blocks canceledAt rows, closing the
  // cancel-then-poll TOCTOU race in one atomic step.
  // If the claim fails (another tick or a cancelForTour won), skip silently —
  // a benign no-op, NOT an error (mirrors missedCallAutoText's marker pattern).
  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, now, body);
  if (!claimed) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder claim lost (concurrent tick or canceled) — skipping',
    );
    return;
  }
  // The rung just flipped to sent (whatever the send outcome below) — tell the
  // live surfaces to refetch the ladder. Advisory + ID-only (see the deps note).
  (deps.events ?? appEvents).emit('scheduled.updated', { contactId: tour.tenantId });

  // Claim succeeded — now send. A crash after this point drops this one
  // reminder (same accepted tradeoff as missedCallAutoText's marker pattern).
  try {
    await deps.sendMessageService({
      conversationId: conv.conversationId,
      body,
      author: 'teammate',
      automated: true,
    });
    log.info(
      {
        reminderId: row.reminderId,
        tourId: row.tourId,
        tenantId: tour.tenantId,
        kind: row.kind,
        route: 'tenant_1to1',
      },
      'tour reminder sent',
    );
  } catch (err) {
    if (err instanceof SendRefusedError) {
      // By-design refusal (opt-out / breaker / manual mode): the claim is
      // already stamped so no retry will fire. Same pattern as missedCallAutoText.
      log.warn(
        {
          reminderId: row.reminderId,
          tourId: row.tourId,
          tenantId: tour.tenantId,
          kind: row.kind,
          refusal: err.code,
        },
        'tour reminder refused (opt-out/breaker/manual) — claim already stamped, not retried',
      );
      return;
    }
    // Non-refusal error: the claim is already stamped (sentAt set), so this
    // reminder will NOT retry on the next poll — accepted tradeoff (mirrors
    // missedCallAutoText: a transient error after claim is not retried).
    log.error(
      { err, reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId, kind: row.kind },
      'tour reminder send failed (non-refusal) — claim already stamped, not retried',
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Group route (founder decision 2026-07-02)
// ---------------------------------------------------------------------------

interface UsableGroup {
  conversationId: string;
  poolNumber: string;
  members: ConversationParticipant[];
}

/**
 * Resolve the tour's group thread into a USABLE send target, pre-claim.
 * Usable = groupThreadId set, the conversation exists, is a `relay_group`,
 * is not closed, and carries a pool number + a non-empty member roster.
 * Anything else returns undefined → the caller falls back to the tenant-1:1
 * path (a reminder must never be lost).
 */
export async function resolveUsableGroup(
  tour: TourItem,
  row: TourReminderItem,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<UsableGroup | undefined> {
  const groupThreadId = tour.groupThreadId;
  if (typeof groupThreadId !== 'string' || groupThreadId.length === 0) return undefined;

  // T4.5 RULING - group_text: POSITIVE `type === 'relay_group'`. A tour's
  // `groupThreadId` only ever points at a relay group (rosterProvision is the
  // one writer and it provisions relay groups), but if one ever pointed at a
  // native group text this falls back to the tenant 1:1 with the WARN below -
  // never sends a relay reminder onto a carrier group (invariant 13.6).
  const conv = await deps.conversationsRepo.getById(groupThreadId);
  if (!conv || conv.type !== 'relay_group' || conv.status === 'closed') {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, conversationId: groupThreadId, kind: row.kind },
      'tour reminder: group thread unusable (missing/not relay_group/closed) — falling back to tenant 1:1',
    );
    return undefined;
  }

  const poolNumber = conv.pool_number;
  const members = (conv.participants ?? []) as ConversationParticipant[];
  if (typeof poolNumber !== 'string' || poolNumber.length === 0 || members.length === 0) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, conversationId: conv.conversationId, kind: row.kind },
      'tour reminder: group thread has no pool number/members — falling back to tenant 1:1',
    );
    return undefined;
  }

  return { conversationId: conv.conversationId, poolNumber, members };
}

/**
 * Send one reminder rung into the tour's masked group: claim ONCE, then hand
 * the rung to sendRelayAnnouncement — the relay.intro chain. It persists the
 * rung as a SYSTEM announcement in the thread (founder decision 2026-07-14:
 * everything sent into a relay group must be visible in its dashboard thread),
 * then sends per member FROM the pool number with opt-out suppression, A2P
 * pacing, and per-member delivery slots. sendMessageService is unusable here
 * (it throws RelaySendNotSupportedError for relay_group threads). Per-member
 * failures are the service's accepted post-claim tradeoff: the claim is
 * already stamped, a failed member is not retried.
 *
 * The in-thread announcement is the REASON for this path, not a workaround: a
 * relay.fanOut enqueue would not persist the rung as a visible system message.
 * (It also used to be impossible - the worker had no OutboundQueueAdapter -
 * but that was a defect, fixed 2026-08-16; see the `adapter` dep note above.)
 */
async function sendGroupReminder(
  row: TourReminderItem,
  tour: TourItem,
  group: UsableGroup,
  now: string,
  window: QuietHoursWindow,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<void> {
  // COMPOSE ABOVE THE CLAIM (spec W6) - identical containment to the 1:1 path:
  // an unusable scheduledAt retires the rung with a claim-skip instead of
  // burning it post-claim or looping forever unclaimed.
  let body: string;
  try {
    body = await composeBodyForRow(row, tour, window, deps, log);
  } catch (err) {
    if (err instanceof UncomposableReminderError) {
      log.error(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder body uncomposable - retiring (claim-skipped)',
      );
      await claimSkipRow(row, 'invalid_schedule', now, deps, tour.tenantId);
      return;
    }
    // BOUNDED (Phase B spec 7, ledger item 7 - DISCHARGED here, not carried).
    // Phase A left this branch unbounded: no claim, no skip stamp, so a
    // PERMANENTLY failing read re-listed every tick forever. That was accepted
    // only because the production poll sat behind the manual-only filter, and
    // the filter is empty again. THIS route is the one that matters most: a
    // landlord_led / pm_team en_route rung is the ONLY rung whose copy forks on
    // the property-contact name, so it is the single rung-differential names
    // failure in the whole ladder - bounding the 1:1 twin alone would have
    // closed the smaller half of the hole. Same grace as that twin.
    if (err instanceof ReminderNamesUnavailableError) {
      if (rosterWaitExpired(row.dueAt, now)) {
        log.error(
          { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind, dueAt: row.dueAt },
          'tour reminder: name resolution STILL failing past the grace window - retiring (claim-skipped)',
        );
        await claimSkipRow(row, 'names_unavailable', now, deps, tour.tenantId);
        return;
      }
      log.warn(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder: name resolution read failed - leaving the rung unclaimed for the next tick',
      );
      return;
    }
    throw err;
  }

  // CLAIM-BEFORE-SEND (same atomic claim as the 1:1 path): claim ONCE for the
  // whole group — losing the claim (concurrent tick / cancel) skips silently.
  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, now, body);
  if (!claimed) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder claim lost (concurrent tick or canceled) — skipping',
    );
    return;
  }
  // Rung flipped to sent — same live-surface nudge as the 1:1 path.
  (deps.events ?? appEvents).emit('scheduled.updated', { contactId: tour.tenantId });

  const sentCount = await announceGroupReminder(row, group, body, deps);

  log.info(
    {
      reminderId: row.reminderId,
      tourId: row.tourId,
      tenantId: tour.tenantId,
      kind: row.kind,
      route: 'group',
      conversationId: group.conversationId,
      memberCount: group.members.length,
      sentCount,
    },
    'tour reminder sent',
  );
}

/**
 * Hand ONE rung to sendRelayAnnouncement with the poll's exact deps/args.
 * Single-sourced so the human force-send rides the identical announcement chain
 * (per-member opt-out suppression and A2P pacing live INSIDE the service).
 * Post-claim by contract: both callers claim first. Returns the member count
 * actually sent (0 when the service no-ops on an unusable thread).
 *
 * The BODY is composed by the caller, never here: composition can fail, and it
 * must fail ABOVE the claim (spec W6). This function runs after the claim, so
 * it takes the already-composed string - the same one snapshotted onto the row.
 */
async function announceGroupReminder(
  row: TourReminderItem,
  group: UsableGroup,
  body: string,
  deps: RunDueTourRemindersDeps,
): Promise<number> {
  const result = await sendRelayAnnouncement(
    {
      conversationsRepo: deps.conversationsRepo,
      messagesRepo: deps.messagesRepo,
      contactsRepo: deps.contactsRepo,
      adapter: deps.adapter,
      ...(deps.tokenBucket !== undefined && { tokenBucket: deps.tokenBucket }),
      ...(deps.events !== undefined && { events: deps.events }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    },
    {
      conversationId: group.conversationId,
      body,
      // The kind tag stays derived from the RUNG, never from a catalog id: an
      // address-variant fork would fork every log line downstream (spec s6).
      kind: `tour.${row.kind}`,
    },
  );
  return result?.sentCount ?? 0;
}

// ---------------------------------------------------------------------------
// forceSendReminder (Send now - quiet-hours spec section 7)
// ---------------------------------------------------------------------------

/**
 * Why a human force-send was refused BEFORE the row was claimed.
 *
 * NOTE the asymmetry with the nudge twin: tours' refusal union does NOT include
 * ReminderSkipReason, so a reason that is BOTH a claim-skip and a refusal (D11's
 * `tenant_not_on_roster`) has to be listed here explicitly.
 */
export type ForceSendRefusal =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'contact_deleted'
  | 'no_consent'
  /** D11: the rung targets the tenant 1:1, but the tenant is off the roster. */
  | 'tenant_not_on_roster'
  /**
   * D11, the other half: the roster could not be READ (an unloadable thread
   * pointer). On the HUMAN path this is only ever a refusal - the row is left
   * pending and the operator is told to try again, rather than being allowed to
   * text a tenant who may have been removed. (The POLL does eventually retire
   * such a rung, once it is more than ROSTER_UNAVAILABLE_GRACE_MS past due -
   * that is the same token as a ReminderSkipReason, listed here because tours'
   * refusal union does not include the skip union.) Deliberately absent from
   * the dashboard's copy map: `sendNowErrorMessage` falls back to its generic
   * retry sentence, which is exactly the right thing to say.
   */
  | 'roster_unavailable'
  /** The tour has no usable scheduledAt, so no body can be composed. Refused
   *  PRE-claim and left pending: a human action must never retire a rung (the
   *  poll's own claim-skip is what retires it). */
  | 'invalid_schedule'
  /** A repo read this send needed threw (spec 6.3b): the compose gate's
   *  name resolution, or ANY read inside target resolution (tour /
   *  recipient / conversation lookups) - the latter refuses every kind,
   *  confirmation included, because the failed read is the recipient
   *  lookup, not a name. Pre-claim, row left pending; the operator copy is
   *  deliberately cause-agnostic ("everything this message needs"). */
  | 'names_unavailable'
  /** Phase B: the tour had already started, so this rung's copy is stale (the
   *  same fire-time gate the poll applies). Permanent - never a retry. */
  | 'tour_already_passed'
  /** Phase B: the rung's KIND is discontinued (confirmation), so no path may
   *  send it - the human path least of all. Permanent - never a retry. */
  | 'kind_retired'
  | ReminderResolutionFailure;

export type ForceSendResult =
  /** Claimed and handed to the send path. */
  | { outcome: 'sent' }
  /** Already sent/canceled/skipped, or the poll won the claim race. */
  | { outcome: 'not_pending' }
  /** Refused PRE-claim: the row is untouched and still pending. */
  | { outcome: 'refused'; reason: ForceSendRefusal }
  /** The narrow post-claim race (see forceSendReminder): claim KEPT, nothing sent. */
  | { outcome: 'refused_post_claim'; reason: SendRefusedError['code'] };

/**
 * Send ONE pending rung immediately, on a human's click.
 *
 * Semantics (spec section 7): being human-triggered it BYPASSES quiet hours,
 * manual mode and the per-conversation circuit breaker - the 1:1 send goes out
 * with `automated: false`. It still RESPECTS the absolute gates (kill switch,
 * opt-out, soft-deleted contact) and the JIT consent gate, and EVERY gate runs BEFORE `claimSend`,
 * because the claim IS the sentAt stamp: a refusal after it would leave the row
 * claimed-but-unsent and destroy the message. A refusal therefore leaves the row
 * exactly as it found it - still pending, still the poll's to deliver at dueAt
 * (never a claim-skip: a human failure must not retire a rung).
 *
 * Force-sending one rung does NOT touch the ladder's other rungs; their dueAts
 * stand and supersession applies to them normally at their own fire time.
 *
 * The one race that survives: an opt-out (or a breaker trip) landing between the
 * pre-check and the provider call surfaces as a post-claim SendRefusedError.
 * The claim is KEPT (poller parity - a stamped row must never be re-sent), and
 * the outcome is reported as `refused_post_claim` so the route can show the
 * operator an honest error instead of a false "sent".
 *
 * PII (doc s9): log ids/kinds/refusal codes only - never a phone/name/body.
 */
export async function forceSendReminder(
  reminderId: string,
  tourId: string,
  nowIso: string,
  smsSendingEnabled: boolean | undefined,
  deps: RunDueTourRemindersDeps,
): Promise<ForceSendResult> {
  const log = deps.logger ?? defaultLogger;

  const rows = await deps.tourRemindersRepo.listByTour(tourId);
  const row = rows.find((r) => r.reminderId === reminderId);
  if (row === undefined) return { outcome: 'refused', reason: 'tour_missing' };
  if (row.sentAt !== undefined || row.canceledAt !== undefined || row.skippedAt !== undefined) {
    return { outcome: 'not_pending' };
  }
  // DISCONTINUED KIND (Phase B spec 3.1): the human path least of all. Placed
  // HERE, above target resolution, so it is FIRST in the refusal precedence -
  // ahead of names_unavailable and tour_already_passed. That ordering is the
  // honest one: those two invite a retry ("try again", "next time"), and this
  // one never will. It also costs no reads to say so. INLINE, like the two
  // returns above it: `refuse` is declared further down, past the gates that
  // need a resolved target. Never a claim-skip - a human action does not retire
  // a rung; scripts/retire-paused-tour-reminders.ts is what stamps kind_retired.
  if (DISCONTINUED_REMINDER_KINDS.has(row.kind)) {
    log.warn(
      { reminderId, tourId, kind: row.kind, reason: 'kind_retired' },
      'tour reminder force-send refused (pre-claim) - row left pending',
    );
    return { outcome: 'refused', reason: 'kind_retired' };
  }

  // CONTAINED (spec 6.3b): target resolution does FOUR bare reads - the tour
  // (:851), the group conversation, the tenant contact (:872) and the 1:1
  // conversation lookup. Uncontained, any of them escapes the route unwrapped
  // as a 500, where 6.3b demands "a REFUSAL the route can render, not silence"
  // - a panel that degrades gracefully beside a Send-now button that 500s on
  // the same outage would be indefensible.
  //
  // THE BLANKET STAYS A BLANKET, deliberately: narrowing this to the tenant
  // read alone would re-open the 500 escape for the other three, trading one
  // wrong behaviour for another. What must not lie is the COPY, so the shared
  // names_unavailable sentence is cause-agnostic - true for all four reads AND
  // for the compose gate. Note the boundary: a target-resolution failure
  // refuses EVERY kind, `confirmation` included (the failed read is the
  // recipient lookup, not a name); the per-copy scoping applies at the COMPOSE
  // gate only. The POLL side of the same read is deliberately untouched - its
  // throw already lands in the per-row catch and leaves the rung unclaimed,
  // the right net outcome. The row lookups above (listByTour, and the route's
  // own) stay bare: those are row reads, and 6.3b's obligation is scoped to
  // resolving the SEND. The `refuse` helper is declared below this point, so
  // the return is inlined.
  let target: ReminderTarget;
  try {
    target = await resolveReminderTarget(row, deps, log);
  } catch (err) {
    log.warn(
      { err, reminderId, tourId, kind: row.kind },
      'tour reminder force-send: target resolution read failed - row left pending',
    );
    return { outcome: 'refused', reason: 'names_unavailable' };
  }
  if ('unresolvable' in target) {
    log.warn(
      { reminderId, tourId, kind: row.kind, reason: target.unresolvable },
      'tour reminder force-send refused (pre-claim) - row left pending',
    );
    return { outcome: 'refused', reason: target.unresolvable };
  }

  // PRE-CLAIM ABSOLUTE GATES. Manual mode and the breaker are deliberately NOT
  // checked - this is a human send (the composer bypasses both today).
  const refuse = (reason: ForceSendRefusal): ForceSendResult => {
    log.warn(
      { reminderId, tourId, kind: row.kind, reason },
      'tour reminder force-send refused (pre-claim) - row left pending',
    );
    return { outcome: 'refused', reason };
  };
  // PAST-TOUR REFUSAL (Phase B 6.1a), the SAME predicate as the poll gate - a
  // rung whose own dueAt precedes the tour, on a tour that has started. Never a
  // name-in-a-list exception: no_show_checkin's dueAt FOLLOWS the tour, so the
  // one rung an operator needs after a no-show passes this untouched. A
  // REFUSAL, never a claim-skip: a human action does not retire a rung.
  if (retiredByTourStart(row, target.tour.scheduledAt, nowIso)) {
    return refuse('tour_already_passed');
  }
  if (isKillSwitchOff(smsSendingEnabled)) return refuse('sms_sending_disabled');
  if (target.route === 'one_to_one') {
    // D11 (contact-rosters): this send targets the tenant 1:1, so the roster
    // rule applies to the human path too - pressing "Send now" on a rung aimed
    // at a REMOVED tenant is refused, mirroring the poll's claim-skip. It stays
    // a REFUSAL (never a claim-skip): a human failure must not retire a rung.
    const gate = await tenantRosterGate(target.tour, deps, log);
    if (gate === 'unavailable') return refuse('roster_unavailable');
    if (gate === 'off') return refuse('tenant_not_on_roster');
    // Opt-out is absolute; consent is required because `automated: false` is
    // subject to the JIT consent gate (services/sendMessage.ts) - checking it
    // here is what keeps that gate from firing AFTER the claim.
    if (isOptedOut(target.conversation.sms_opt_out, target.contact.sms_opt_out === true)) {
      return refuse('contact_opted_out');
    }
    // A soft-deleted contact is unreachable until restored: sendMessage refuses
    // the 1:1 with ContactDeletedError regardless of `automated`. Deleted-ness is
    // DETERMINISTIC and already in hand, so it is checked here rather than left
    // to the post-claim race - otherwise the claim (which IS the sentAt stamp)
    // would land first and burn the rung. Mirrors sendMessage's own ordering:
    // after opt-out (TCPA wins), before consent.
    if (isDeleted(target.contact)) return refuse('contact_deleted');
    if (!hasSmsConsent(target.contact)) return refuse('no_consent');
  }

  // COMPOSE ABOVE THE CLAIM (spec W6), ONCE for BOTH routes - the claim below
  // covers them both, and it IS the sentAt stamp. forceSendReminder takes no
  // window (only the poll reads one per tick), so it reads its OWN here purely
  // for the composing TIMEZONE: quiet hours are deliberately bypassed by a human
  // send, and readQuietHoursWindow is what routes the zone through
  // resolveQuietHoursTimezone (never settings.timezone directly - spec D8/W5).
  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  let body: string;
  try {
    body = await composeBodyForRow(
      row,
      target.tour,
      window,
      deps,
      log,
      target.route === 'one_to_one' ? target.contact : undefined,
    );
  } catch (err) {
    if (err instanceof UncomposableReminderError) {
      // PRE-CLAIM REFUSAL, never a claim-skip: a human action must not retire a
      // rung. The row stays pending and the poll still owns it.
      return refuse('invalid_schedule');
    }
    // The compose gate's half of the same posture (spec 6.3b): a read this
    // rung's copy NEEDS threw, so the human gets an answer rather than a
    // wrong-but-valid message.
    if (err instanceof ReminderNamesUnavailableError) {
      return refuse('names_unavailable');
    }
    throw err;
  }

  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, nowIso, body);
  if (!claimed) {
    log.info(
      { reminderId, tourId, kind: row.kind },
      'tour reminder force-send claim lost (concurrent poll tick or cancel)',
    );
    return { outcome: 'not_pending' };
  }
  // The rung just flipped to sent - tell the live surfaces to refetch.
  (deps.events ?? appEvents).emit('scheduled.updated', { contactId: target.tour.tenantId });

  if (target.route === 'group') {
    const sentCount = await announceGroupReminder(row, target.group, body, deps);
    log.info(
      {
        reminderId,
        tourId,
        tenantId: target.tour.tenantId,
        kind: row.kind,
        route: 'group',
        conversationId: target.group.conversationId,
        memberCount: target.group.members.length,
        sentCount,
      },
      'tour reminder force-sent',
    );
    return { outcome: 'sent' };
  }

  try {
    await deps.sendMessageService({
      conversationId: target.conversation.conversationId,
      body,
      author: 'teammate',
      // Human force-send: bypasses manual mode + the breaker (and IS subject to
      // the JIT consent gate pre-checked above).
      automated: false,
    });
    log.info(
      {
        reminderId,
        tourId,
        tenantId: target.tour.tenantId,
        kind: row.kind,
        route: 'tenant_1to1',
      },
      'tour reminder force-sent',
    );
    return { outcome: 'sent' };
  } catch (err) {
    if (err instanceof SendRefusedError) {
      log.warn(
        { reminderId, tourId, kind: row.kind, refusal: err.code },
        'tour reminder force-send refused POST-claim (race) - claim kept, not retried',
      );
      return { outcome: 'refused_post_claim', reason: err.code };
    }
    // Non-refusal error: the claim is already stamped, so this rung will NOT
    // retry - same accepted tradeoff as the poll. Surface it as a 500.
    log.error(
      { err, reminderId, tourId, kind: row.kind },
      'tour reminder force-send failed (non-refusal) - claim already stamped, not retried',
    );
    throw err;
  }
}

