// Tour reminders endpoint (scheduled-message-visibility, Task 2 + operator
// cancel/restore, 2026-07-14).
//
//   GET   /api/tours/:tourId/reminders
//        → { reminders: TourReminderView[]; next?: TourReminderView }
//          ... plus `timezone`: the ORG zone the bodies were composed in
//          (spec D8), which the panel formats its own time labels with
//   PATCH /api/tours/:tourId/reminders/:reminderId  { canceled: boolean }
//        → { reminder: TourReminderView } | 409 (already sent/skipped, or the
//          transition raced the poll — the honest current state is returned)
//   POST  /api/tours/:tourId/reminders/:reminderId/send-now
//        -> { reminder: TourReminderView } | 409 { error, reminder } - "Send
//           now" (quiet-hours spec section 7): a human sends ONE pending rung
//           immediately through the poll's own resolve/claim/send path.
//
// Mounted under /api/tours (behind requireAuth via the /api mount). GET
// surfaces each armed reminder rung's state (upcoming|sent|canceled|skipped)
// + its canned body so the dashboard can show a tenant WHAT scheduled texts
// are queued and which already fired. PATCH is the operator's per-rung
// cancel/un-cancel: atomic conditional writes (repo cancel/uncancel), so a
// cancel racing the poll's send claim resolves to exactly one outcome — a
// lost race 409s with the row's real state instead of lying. Restoring a
// PAST-DUE rung is allowed and fires on the next poll tick (deliberate: an
// un-canceled confirmation means "send it after all"; the panel shows
// "sending shortly").
//
// SUPPRESSION ESTIMATE (upcoming, 1:1-routed rungs only): an honest preview of
// whether the automated send WOULD be refused (or, for quiet hours, DEFERRED) at
// fire time - kill-switch / opt-out / manual mode / quiet hours - computed via
// the shared evaluateScheduledSendSuppression (Task 1) against config, the
// tenant's conversation/contact, and the org quiet-hours window evaluated
// against each rung's OWN dueAt (see the GET handler). It is deliberately
// scoped to rungs that route 1:1 — for THIS task, that is the unambiguous
// self_guided route; Task 4 exports resolveUsableGroup and tightens the
// group-routed (landlord_led / pm_team) case. Non-1:1 rungs carry no estimate.
//
// PII (doc §9): the response carries bodies/state to the authed client; log lines
// stay IDs/counts only.
import { json, Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  assessNamesReadFailure,
  composeTourReminderBody,
  UncomposableReminderError,
  type TourContactNames,
} from '../messages/tourCopy.js';
import { resolveTourContactNames } from '../lib/tourContacts.js';
import type { Address } from '../lib/address.js';
import {
  createTourRemindersRepo,
  type ReminderKind,
  type ReminderSkipReason,
  type TourReminderItem,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  evaluateScheduledSendSuppression,
  type ScheduledSuppression,
} from '../services/scheduledSendSuppression.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import {
  DISCONTINUED_REMINDER_KINDS,
  forceSendReminder,
  readQuietHoursWindow,
  MANUAL_ONLY_REMINDER_KINDS,
  type RunDueTourRemindersDeps,
} from '../jobs/tourReminders.js';
import { isQuietTime } from '../lib/quietHours.js';
import { isSupersededRung } from '../lib/ladderPointer.js';
import {
  flushComposeFailTally,
  newComposeFailTally,
  recordComposeFail,
  type ComposeFailTally,
} from '../lib/composeFailTally.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
import { createSendMessageService, type SendMessageService } from '../services/sendMessage.js';
import type { AuthedRequest } from '../middleware/auth.js';

export interface TourRemindersRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  /** ONE unit read, THREE consumers (two merged at the 2026-08-06 second main
   *  sync, the third added 2026-08-26): roster resolution for the send-now
   *  path's D11 check (contact-rosters); the unit's address for the composed
   *  reminder copy on both the send-now path and the previews below
   *  (tour-reminder-details); and the PROPERTY CONTACT behind
   *  {propertyContactFirstName} in the landlord-led en_route copy, which
   *  composeInputsOf resolves from this same unit. A failed read degrades the
   *  preview to the self-guided wording today; per Task 5 of the
   *  tour-reminder-ladder plan it will WITHHOLD that preview and BLOCK the
   *  send-now instead. */
  unitsRepo?: UnitsRepo;
  /** Quiet-hours window source for the suppression estimate (narrow read-only
   *  shape - the `resolveWithSettings` precedent). */
  settingsRepo?: Pick<SettingsRepo, 'getOrgSettings'>;
  /**
   * Rung kinds the POLL holds back, mirrored here so an upcoming rung the poll
   * will never claim chips `paused` instead of "sending shortly". Defaults to
   * MANUAL_ONLY_REMINDER_KINDS, which is EMPTY today (2026-08-31, Phase B).
   *
   * So this is now a TEST SEAM in the opposite direction from the one it was
   * built as: with nothing paused in production, a suite that wants to see the
   * `paused` chip INJECTS a non-empty set here. (It used to exist because the
   * production default paused everything and `paused` outranks quiet hours,
   * which made the quiet-hours preview below unobservable; the quiet suites now
   * need no injection at all.)
   *
   * It has NOTHING to do with DISCONTINUED_REMINDER_KINDS, which is permanent
   * and which no deps object anywhere can override.
   */
  manualOnlyKinds?: ReadonlySet<ReminderKind>;
  // ---- Send-now deps (quiet-hours spec section 7) --------------------------
  // The force-send reuses the poll's resolve/claim/send path, so this router
  // needs the poll's send-side deps too. All optional with factory defaults,
  // mirroring the dev.ts tick builders; api.ts threads the process-wide
  // instances so tests that inject fakes keep talking to fakes.
  /** 1:1 route: the shared send service (force-sends use automated: false). */
  sendMessageService?: SendMessageService;
  /** GROUP route: per-member provider sends via sendRelayAnnouncement. */
  adapter?: MessagingAdapter;
  /** GROUP route: persists the rung as a system announcement in the thread. */
  messagesRepo?: MessagesRepo;
  /** Records WHO clicked Send now (`reminder_force_sent` on `tours#<id>`). */
  auditRepo?: AuditRepo;
  /** Live-update bus (defaults to appEvents): a cancel/restore emits
   *  scheduled.updated so the Reminders panel + the timelines' Upcoming
   *  buckets refetch. */
  events?: EventBus;
}

/** One reminder rung as the dashboard renders it. */
export interface TourReminderView {
  reminderId: string;
  kind: ReminderKind;
  /** ISO 8601 — when the rung is/was scheduled to fire. */
  dueAt: string;
  state: 'upcoming' | 'sent' | 'canceled' | 'skipped';
  sentAt?: string;
  canceledAt?: string;
  /** Present when state === 'skipped': the poll retired the rung unsent. */
  skippedAt?: string;
  skipReason?: ReminderSkipReason;
  body: string;
  /** Only computed for `upcoming` 1:1-routed rungs (see file header). */
  suppression?: ScheduledSuppression;
  /** Derived, never stored: this rung's send time has passed and it still has
   *  not sent. Composes with `suppression`, which says WHY. */
  overdue?: boolean;
}

/** canceledAt wins over sentAt (a row is only canceled while unsent, but be safe);
 *  skippedAt is terminal like both, ranked after them (the claims are mutually
 *  exclusive by condition, so the order is belt-and-suspenders only). */
function stateOf(row: TourReminderItem): TourReminderView['state'] {
  if (row.canceledAt !== undefined) return 'canceled';
  if (row.sentAt !== undefined) return 'sent';
  if (row.skippedAt !== undefined) return 'skipped';
  return 'upcoming';
}

export function createTourRemindersRouter(deps: TourRemindersRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const reminders = deps.tourRemindersRepo ?? createTourRemindersRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const manualOnlyKinds = deps.manualOnlyKinds ?? MANUAL_ONLY_REMINDER_KINDS;
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  // Send-now (POST /:tourId/reminders/:reminderId/send-now) runs the SAME
  // resolve/claim/send path the worker poll runs, so it takes the poll's dep
  // bundle. Assembled ONCE at router creation (the dev.ts tick-builder shape):
  // every factory below only builds a client object, no network at construction.
  const pollerDeps: RunDueTourRemindersDeps = {
    tourRemindersRepo: reminders,
    toursRepo: tours,
    contactsRepo: contacts,
    conversationsRepo: conversations,
    // D11 (contact-rosters): the send-now path runs the poll's roster check.
    // Same repo also supplies the address for the composed body.
    unitsRepo: units,
    // D7: NOT wired on the send-now path - a human pressing "Send now" has
    // decided, and a pending group open must not silently refuse them. The
    // WAIT is a poll-only behavior (the poll re-lists; a human does not).
    sendMessageService:
      deps.sendMessageService ?? createSendMessageService({ config, logger: deps.logger }),
    settingsRepo: settings,
    adapter: deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger }),
    messagesRepo: deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger }),
    events,
    ...(deps.logger !== undefined && { logger: deps.logger }),
  };

  const router = Router();

  /** The composing inputs behind a tour's rungs, resolved ONCE per request:
   *  the unit (address + property-contact source), the two names, and the
   *  per-read failure flags. Read paths must never 500 the ladder over a
   *  name: absence composes the fallbacks here (Task 4), and Task 5 adds the
   *  failure consumers via assessNamesReadFailure (entry-corrupting failures
   *  render body: ''; token-blanking failures degrade) AND contains the
   *  OTHER tenant read on this route (resolveTenantSuppression - Task 5). */
  const composeInputsOf = async (
    tour: TourItem,
  ): Promise<{
    address?: Address | string;
    names: TourContactNames;
    tenantReadFailed: boolean;
    propertyReadFailed: boolean;
    unitReadFailed: boolean;
  }> => {
    let unit: UnitItem | undefined;
    let unitReadFailed = false;
    try {
      unit = await units.getById(tour.unitId);
    } catch (err) {
      unitReadFailed = true;
      log.warn(
        { err, tourId: tour.tourId },
        'tour reminder preview: unit read failed - composing without an address',
      );
    }
    const resolved = await resolveTourContactNames({
      tenantId: tour.tenantId,
      unit,
      contactsRepo: contacts,
      logger: log,
    });
    return {
      ...(unit?.address !== undefined && { address: unit.address }),
      names: resolved.names,
      tenantReadFailed: resolved.tenantReadFailed,
      propertyReadFailed: resolved.propertyReadFailed,
      unitReadFailed,
    };
  };

  /**
   * The body ONE rung previews as. A SENT rung renders what was actually sent
   * (the claim-time snapshot); only pending rungs recompose, so a reschedule or
   * an address edit can never rewrite history. Read-path containment (spec F1):
   * a rung whose tour has no usable scheduledAt renders `body: ''` instead of
   * failing the whole ladder - `body` is required on the wire view, on the
   * dashboard mirror and on TimelineScheduled, so it is emptied, never omitted.
   */
  // DUPLICATED SHAPE (3 copies, keep in sync): the sentBody-first read plus
  // BOTH `body: ''` rules - the UncomposableReminderError containment below AND
  // the entry-fork WITHHOLD above it - also live in
  // routes/contactTimeline.ts (tourReminderBodyOrEmpty) and
  // routes/relayGroups.ts (the scheduled-bucket map). Left duplicated on
  // purpose - consolidating would rewrite containment three review passes
  // verified. If you change either containment RULE here, change it in all
  // three or the preview surfaces diverge, which is precisely the drift the
  // shared composer exists to prevent.
  //
  // THE THREE COPIES DIFFER IN BRANCH ORDER, not only in content: relayGroups
  // has NO sentBody snapshot branch at all (its bucket is pending-only), so
  // its withhold check is unconditionally FIRST, while here and on the
  // timeline the snapshot renders above both. Do not "align" them by adding a
  // snapshot branch there or removing one here.
  //
  // NAME RESOLUTION IS HOISTED TO THE CALLER on all three copies (spec 6.3a):
  // the composer is synchronous, so the names arrive already resolved - here
  // from composeInputsOf, once per request, along with its three failure flags.
  const bodyFor = (
    row: TourReminderItem,
    tour: TourItem,
    tz: string,
    address: Address | string | undefined,
    names: TourContactNames,
    flags: {
      tenantReadFailed: boolean;
      propertyReadFailed: boolean;
      unitReadFailed: boolean;
    },
    tally?: ComposeFailTally,
  ): string => {
    if (row.sentAt !== undefined && typeof row.sentBody === 'string') return row.sentBody;
    // Spec 6.3a "never a different ENTRY": a failed read that would change
    // WHICH ENTRY composes renders NO body rather than a wrong one. A
    // failure that merely blanks a token the copy renders does NOT withhold:
    // per 6.3b the preview degrades to the absence fallbacks ("Hey there,")
    // while the SEND side waits - the spec's own split posture. No warn here:
    // the resolver and the unit catch already logged the underlying failure
    // once per request.
    if (
      assessNamesReadFailure({
        kind: row.kind,
        tourType: tour.tourType,
        tenantReadFailed: flags.tenantReadFailed,
        propertyReadFailed: flags.propertyReadFailed,
        unitReadFailed: flags.unitReadFailed,
      }).withholdPreview
    ) {
      return '';
    }
    try {
      return composeTourReminderBody({
        kind: row.kind,
        scheduledAt: tour.scheduledAt ?? '',
        timezone: tz,
        tourType: tour.tourType,
        names,
        ...(address !== undefined && { address }),
      });
    } catch (err) {
      if (err instanceof UncomposableReminderError) {
        // A tally means the caller is mapping a LADDER and will flush ONE warn
        // for the whole request (see ComposeFailTally). Without one - the
        // single-row PATCH / send-now responses - warn here, which is already
        // once per request.
        if (tally !== undefined) recordComposeFail(tally, row, tour);
        else
          log.warn(
            { reminderId: row.reminderId, tourId: tour.tourId, kind: row.kind },
            'tour reminder body uncomposable on a read path - returning an empty body',
          );
        return '';
      }
      throw err;
    }
  };

  /** Project one stored row → its wire view (no suppression estimate — the
   *  PATCH response is a state echo; GET recomputes estimates on refetch). The
   *  body is resolved ONCE per request by the handler and passed IN: composing
   *  needs async unit/settings AND CONTACT reads (the two names, since
   *  2026-08-26 - see composeInputsOf), and this projection is sync. */
  const viewOf = (row: TourReminderItem, body: string): TourReminderView => {
    const state = stateOf(row);
    // ITS OWN `nowIso` (spec 8.2). There is nothing to borrow: this path never
    // computes one, and the GET route's is block-scoped inside its
    // `self_guided && hasUpcoming` branch. The flag needs only row.dueAt and a
    // clock, so this adds no IO to the PATCH echo.
    const nowIso = new Date().toISOString();
    const overdue = state === 'upcoming' && row.dueAt < nowIso;
    return {
      reminderId: row.reminderId,
      kind: row.kind,
      dueAt: row.dueAt,
      state,
      body,
      ...(overdue && { overdue: true }),
      ...(row.sentAt !== undefined && { sentAt: row.sentAt }),
      ...(row.canceledAt !== undefined && { canceledAt: row.canceledAt }),
      ...(row.skippedAt !== undefined && { skippedAt: row.skippedAt }),
      ...(row.skipReason !== undefined && { skipReason: row.skipReason }),
    };
  };

  // PATCH /:tourId/reminders/:reminderId { canceled } — operator cancel/restore
  // of ONE rung (see file header for race + past-due semantics).
  router.patch('/:tourId/reminders/:reminderId', json(), async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const reminderId = String(req.params['reminderId'] ?? '');
    const canceled = (req.body as { canceled?: unknown } | undefined)?.canceled;
    if (typeof canceled !== 'boolean') {
      res.status(400).json({ error: 'canceled (boolean) is required' });
      return;
    }

    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const rows = await reminders.listByTour(tourId);
    if (!rows.some((r) => r.reminderId === reminderId)) {
      res.status(404).json({ error: 'reminder_not_found' });
      return;
    }

    const won = canceled
      ? await reminders.cancel(reminderId, new Date().toISOString())
      : await reminders.uncancel(reminderId);

    // Re-read for the HONEST post-write state (also what a lost race reports:
    // e.g. the poll sent the rung between our list and the conditional write).
    const after = (await reminders.listByTour(tourId)).find((r) => r.reminderId === reminderId)!;
    // Composing inputs for the echoed view, read AFTER the conditional write so
    // they add nothing to the list->write window the poll can race into. This
    // single-row response carries no timezone field of its own - the panel
    // reuses the zone from its list state.
    const window = await readQuietHoursWindow(settings, log);
    const { address, names, ...readFlags } = await composeInputsOf(tour);
    if (!won) {
      log.info(
        { tourId, reminderId, wanted: canceled ? 'cancel' : 'restore', state: stateOf(after) },
        'tour reminder cancel/restore lost the claim — reporting current state',
      );
      res.status(409).json({
        error: canceled ? 'reminder_not_cancelable' : 'reminder_not_restorable',
        reminder: viewOf(after, bodyFor(after, tour, window.timezone, address, names, readFlags)),
      });
      return;
    }

    // Same live-surface nudge the poll's claim emits: the Reminders panel and
    // the timelines' Upcoming buckets refetch (1:1 + group both key off it).
    events.emit('scheduled.updated', { contactId: tour.tenantId });
    log.info(
      { tourId, reminderId, kind: after.kind, canceled },
      canceled ? 'tour reminder canceled via api' : 'tour reminder restored via api',
    );
    res.json({
      reminder: viewOf(after, bodyFor(after, tour, window.timezone, address, names, readFlags)),
    });
  });

  // POST /:tourId/reminders/:reminderId/send-now - "Send now" (quiet-hours spec
  // section 7). Human-triggered, so it bypasses quiet hours / manual mode / the
  // breaker but respects the kill switch, opt-out and JIT consent - all checked
  // BEFORE the claim inside forceSendReminder, so a refusal leaves the rung
  // pending and the poll still owns it. Auth: any authed staff role via the
  // /api mount (staff can already send the same text from the composer), and
  // the mount's csrfOrigin check covers this first POST on the router.
  //
  // 200 { reminder } on success; 409 { error, reminder } for every refusal or
  // lost race, ALWAYS with the re-read (honest) view so the panel can correct
  // itself; 404 for an unknown tour / rung.
  router.post('/:tourId/reminders/:reminderId/send-now', json(), async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const reminderId = String(req.params['reminderId'] ?? '');
    const actor = (req as AuthedRequest).user?.userId;

    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const rows = await reminders.listByTour(tourId);
    if (!rows.some((r) => r.reminderId === reminderId)) {
      res.status(404).json({ error: 'reminder_not_found' });
      return;
    }

    const result = await forceSendReminder(
      reminderId,
      tourId,
      new Date().toISOString(),
      config.smsSendingEnabled,
      pollerDeps,
    );

    // Re-read for the HONEST post-write state (the send may have raced the poll).
    const after = (await reminders.listByTour(tourId)).find((r) => r.reminderId === reminderId)!;
    // Composing inputs for the echoed view (same no-timezone note as PATCH). A
    // rung the force-send just claimed renders its SNAPSHOT, not a recompose.
    const window = await readQuietHoursWindow(settings, log);
    const { address, names, ...readFlags } = await composeInputsOf(tour);
    const afterBody = bodyFor(after, tour, window.timezone, address, names, readFlags);

    if (result.outcome === 'sent') {
      await audit.append(`tours#${tourId}`, 'reminder_force_sent', {
        reminderId,
        kind: after.kind,
        ...(actor !== undefined && { actor }),
      });
      log.info({ tourId, reminderId, kind: after.kind }, 'tour reminder force-sent via api');
      res.json({ reminder: viewOf(after, afterBody) });
      return;
    }

    // 'not_pending' (already terminal / lost claim) vs a refusal reason vs the
    // post-claim race - the UI shows the reason verbatim, never a silent no-op.
    const error = result.outcome === 'not_pending' ? 'reminder_not_pending' : result.reason;
    log.info(
      { tourId, reminderId, kind: after.kind, outcome: result.outcome, error },
      'tour reminder send-now refused',
    );
    res.status(409).json({ error, reminder: viewOf(after, afterBody) });
  });

  router.get('/:tourId/reminders', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');

    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }

    const rows = await reminders.listByTour(tourId);

    // The composing inputs, read ONCE per request and ABOVE the suppression
    // guard below: EVERY response needs the zone (a landlord_led tour and all
    // four viewOf responses used to read settings zero times), and every rung of
    // this tour shares the one unit address AND the one pair of names.
    const window = await readQuietHoursWindow(settings, log);
    const { address, names, ...readFlags } = await composeInputsOf(tour);

    // Resolve the tenant's send-time suppression estimate ONCE per request (the
    // same conversation/contact backs every 1:1-routed rung). Only needed when
    // the tour has at least one UPCOMING rung on a 1:1 route — for THIS task the
    // unambiguous self_guided route (Task 4 tightens the group case). A
    // non-self_guided tour never gets an estimate here.
    // DISCONTINUED rungs do not count (round 2, R2-S3). This is the SECOND of
    // the two 'upcoming' equality predicates spec 8.1 names - `next` below is
    // the other - and they have to agree. A rung whose kind can never send
    // reaches the discontinued short-circuit in the projection, which discards
    // whatever this estimate produced, so counting one here buys a contact read
    // and a conversation read per GET for an answer nothing reads. No
    // correctness change: the chip is decided OUTSIDE the evaluator either way.
    const hasUpcoming = rows.some(
      (r) => stateOf(r) === 'upcoming' && !DISCONTINUED_REMINDER_KINDS.has(r.kind),
    );
    let suppressionOf:
      | ((dueAt: string, paused: boolean, quietExempt: boolean) => ScheduledSuppression | undefined)
      | undefined;
    // Distinguishes "nothing was suppressed" from "we could not tell": with the
    // containment below, a contacts outage silently flips the `suppressed` log
    // field from true to false, and an operator reading logs mid-incident would
    // see a calm ladder. This flag is the only other signal.
    let suppressionEstimateFailed = false;
    if (tour.tourType === 'self_guided' && hasUpcoming) {
      // Quiet hours (spec 2026-08-03): unlike the state-dependent reasons
      // (opt-out, manual mode), a rung's quiet-ness is a function of the RUNG's
      // OWN time against the DAILY-RECURRING window - knowable in advance - and
      // the chip is a claim about the future ("Will wait"). So it is evaluated
      // PER ROW, as two disjuncts:
      //   1. dueAt > now && isQuietTime(dueAt) - a FUTURE rung whose due
      //      instant falls inside an occurrence of the window, so the fire-time
      //      backstop WILL defer it when it comes due. A legacy/unclamped row
      //      due at 04:00 tomorrow chips honestly around the clock (including
      //      at noon), while a rung due Friday afternoon never chips at 03:00.
      //      The dueAt > now guard is the stalled-poller edge (N1): an OVERDUE
      //      rung whose dueAt sat inside a now-ENDED occurrence is one poll
      //      tick from sending - "Will wait" would be a lie about the past, so
      //      overdue rungs are disjunct 2's business alone.
      //   2. wallClockQuiet && dueAt <= now - a rung already due while the
      //      window is running is being deferred by that backstop RIGHT NOW even
      //      when its dueAt sits outside the window (worker-downtime catch-up
      //      that crossed window-start: the backstop's own motivating case).
      // Post-feature rows are clamped OUT of the window at arm time, so they
      // never chip - correct, they really will fire at their stored dueAt.
      // routes/placementNudges.ts and routes/contactTimeline.ts apply the same
      // formula; this comment is the single explanation for all three.
      const nowIso = new Date().toISOString();
      const wallClockQuiet = isQuietTime(nowIso, window);
      // The tenant's contact/thread inputs cost IO and back EVERY 1:1-routed
      // rung identically, so they are resolved once; only the quiet flag is
      // per-row. Stored dueAts are already normalized ISO, so `<=` compares
      // them lexicographically against the normalized nowIso.
      //
      // CONTAINED AT THE CALL SITE (spec 6.3b): resolveTenantSuppression does
      // the OTHER tenant read on this route, bare, and a rejection would 500
      // the whole ladder - making composeInputsOf's "read paths must never 500
      // over a name" aspirational rather than true.
      //
      // THE SHAPE MATTERS. Do NOT "simplify" this into an always-undefined
      // EVALUATOR: the chip ternary below reaches its no-IO
      // `paused ? { reason: 'paused' } : undefined` fallback ONLY while
      // suppressionOf is undefined, so a defined-but-empty evaluator would flip
      // every self_guided chip from "Paused" to the amber "sends in Nh" promise
      // during a contacts blip - the exact perpetual-"sending shortly" lie the
      // 2026-08-20 pause chip exists to end. Leaving suppressionOf UNASSIGNED
      // is what makes a failed read behave exactly like a group-routed tour: a
      // tenant-read failure changes the BODY, never the pause state.
      //
      // KNOWN AND ACCEPTED: this route now reads the same tenant contact TWICE
      // per request (composeInputsOf and this estimate). Deliberate - threading
      // the contact through would mean ResolvedTourNames handing a PII-bearing
      // ContactItem to every preview surface, or another interface revision,
      // for one saved read. The doubling is per-REQUEST, not per-rung, so spec
      // 10's batching rule holds. Do NOT couple the estimate's failure to the
      // body's by "optimizing" the two reads into one.
      try {
        const evaluate = await resolveTenantSuppression(tour, config, contacts, conversations);
        // `quietExempt` is the en_route carve-out (Phase B spec 6 addendum),
        // threaded in from the call site as a PRE-COMPUTED boolean rather than
        // decided by kind here: the poll no longer defers an en_route rung, so
        // chipping "Will wait" on one would be a promise the machinery breaks
        // within a poll tick. It forces the QUIET operand alone - opt-out, the
        // kill switch and manual mode still ride the shared evaluator, which is
        // what keeps the exemption from becoming "en_route is never suppressed".
        suppressionOf = (
          dueAt: string,
          paused: boolean,
          quietExempt: boolean,
        ): ScheduledSuppression | undefined =>
          evaluate(
            !quietExempt &&
              ((dueAt > nowIso && isQuietTime(dueAt, window)) ||
                (wallClockQuiet && dueAt <= nowIso)),
            paused,
          );
      } catch (err) {
        suppressionEstimateFailed = true;
        log.warn(
          { err, tourId },
          'tour reminders: suppression estimate read failed - falling back to the no-IO paused chip',
        );
      }
    }

    const tally = newComposeFailTally();
    // The list projection's OWN `nowIso` for the `overdue` flag (spec 8.2): the
    // one above is block-scoped inside the self_guided branch and is NOT lifted
    // - overdue-ness is a property of every rung on every tour type, and
    // hoisting a variable out of a branch to share it is how the two builders
    // would start disagreeing. viewOf computes a third for the same reason.
    const listNowIso = new Date().toISOString();
    const reminderViews: TourReminderView[] = rows
      .map((row) => {
        const state = stateOf(row);
        // The manual-only hold-back is a property of the KIND, so it is known
        // for EVERY tour - including the group-routed ones `suppressionOf`
        // never covers (it needs no recipient IO). Without the second branch a
        // landlord_led / pm_team panel would keep chipping "sending shortly"
        // for a rung the poll will never pick up: the perpetual-"sending
        // shortly" lie claimSkip exists to prevent.
        //
        // Where an estimate IS computed, `paused` goes THROUGH the shared
        // evaluator rather than around it, so a harder reason (opt-out, kill
        // switch, manual mode) still wins - see scheduledSendSuppression.ts for
        // why that ordering is the honest one.
        //
        // DISCONTINUED is checked FIRST and OUTSIDE the evaluator (spec 3.1a).
        // Not a style choice: `suppressionOf` is built only for self_guided
        // tours with an upcoming rung, so routing a kind-level fact through it
        // would lose it on every group-routed tour - the ones most likely to
        // have a relay group would chip "sending shortly" for a rung that can
        // never send. Nor does it belong IN the shared ordering: that ladder's
        // rationale is that a harder reason wins, and "we no longer send this
        // at all" is not a suppression anything should override.
        //
        // SUPERSEDED is checked FIRST OF ALL (spec 3.3, S6). The tour is
        // already in hand from the 404 gate above, so this costs no read. It
        // outranks even `discontinued` because it is a fact about THIS row's
        // storage rather than about its kind: a rung of a replaced ladder is
        // one both send paths already refuse, and `listDue` only picks a row up
        // at `dueAt <= now`, so without the check the panel would promise
        // "sends in 6 days" right up to the moment the poll retired it. The
        // comparison is the SHARED one (lib/ladderPointer.ts) - the poll and
        // the other two preview surfaces call the same function, which is the
        // only way four sites can be made unable to disagree about one row.
        const superseded = isSupersededRung(row, tour);
        const discontinued = DISCONTINUED_REMINDER_KINDS.has(row.kind);
        const paused = manualOnlyKinds.has(row.kind);
        const suppression =
          state !== 'upcoming'
            ? undefined
            : superseded
              ? ({ reason: 'superseded' } as const)
              : discontinued
                ? ({ reason: 'discontinued' } as const)
                : suppressionOf !== undefined
                  ? // en_route is exempt from quiet hours at BOTH runtime sites
                    // (spec 6), so the estimate must not promise a wait here.
                    suppressionOf(row.dueAt, paused, row.kind === 'en_route')
                  : paused
                    ? ({ reason: 'paused' } as const)
                    : undefined;
        // Spec 8: an ADDITIVE boolean, never a fifth `state` value - two
        // predicates on this route test 'upcoming' by equality, and an
        // 'overdue' state would drop overdue rungs out of the very places that
        // surface them. Omitted when false, matching the spreads below.
        const overdue = state === 'upcoming' && row.dueAt < listNowIso;
        const view: TourReminderView = {
          reminderId: row.reminderId,
          kind: row.kind,
          dueAt: row.dueAt,
          state,
          body: bodyFor(row, tour, window.timezone, address, names, readFlags, tally),
          ...(overdue && { overdue: true }),
          ...(row.sentAt !== undefined && { sentAt: row.sentAt }),
          ...(row.canceledAt !== undefined && { canceledAt: row.canceledAt }),
          ...(row.skippedAt !== undefined && { skippedAt: row.skippedAt }),
          ...(row.skipReason !== undefined && { skipReason: row.skipReason }),
          ...(suppression !== undefined && { suppression }),
        };
        return view;
      })
      // Ascending by dueAt (the ladder's chronological order).
      .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
    flushComposeFailTally(tally, log, 'tour_reminders_list');

    // `next` drives the panel's "Next" tag and its aria-current="step", so a
    // DISCONTINUED rung must be excluded even though it is still `upcoming`: a
    // pause-era confirmation's dueAt is the BOOKING instant, which makes it the
    // earliest rung on every ladder it sits on, and it stays pending until the
    // one-time sweep reaches it. Without this the panel would point a navigator
    // at the one row the same response chips "No longer sent".
    //
    // SUPERSEDED is excluded for the same reason and by the same shape (S6
    // T6.1): a rung of a replaced ladder is still `upcoming`, and a rescheduled
    // tour's OLD day_before is routinely the earliest row on the response - so
    // without this the panel would tag "Next" on the one row it also chips
    // "Replaced". Both exclusions read the ANNOTATION rather than recomputing
    // their predicate, so a rung can only lose `next` for a reason the same
    // response shows the operator. S7 makes this moot for supersession by
    // partitioning such rows into `earlier[]`; the exclusion stays regardless,
    // because `next` must never depend on a sibling task having run.
    const next = reminderViews.find(
      (v) =>
        v.state === 'upcoming' &&
        v.suppression?.reason !== 'discontinued' &&
        v.suppression?.reason !== 'superseded',
    );

    log.info(
      {
        tourId,
        count: reminderViews.length,
        hasNext: next !== undefined,
        suppressed: reminderViews.some((v) => v.suppression !== undefined),
        // Read `suppressed` WITH this: when the estimate read failed, a false
        // `suppressed` means "unknown", not "nothing is held back".
        suppressionEstimateFailed,
      },
      'tour reminders read',
    );

    // `timezone` is the zone the rung BODIES were composed in (spec D8): the
    // panel renders every timestamp beside them in THIS zone, so a navigator
    // outside the org's zone never reads a chip that contradicts the text. Only
    // this LIST response carries it - the single-row PATCH / send-now payloads
    // reuse the zone the panel is already holding.
    res.json({
      reminders: reminderViews,
      timezone: window.timezone,
      ...(next !== undefined && { next }),
    });
  });

  // GET /:tourId/no-show-checkin-draft -> the templated body for the MANUAL
  // no-show check-in send. The no_show_checkin rung is no longer auto-armed
  // (jobs/tourReminders.ts), so there is no armed row to read the copy from; the
  // tour page fetches it here to PREFILL the tenant 1:1 composer. The copy is
  // TENANT-SPECIFIC since the 2026-08-26 founder rewrite - it greets by first
  // name - so this handler resolves the tenant and goes through the ONE
  // composer, exactly like the reminder-body resolution above.
  //
  // THREE TERMINAL SHAPES since 2026-08-26 (it had two):
  //   200 { body }                        - the prefill
  //   404 { error: 'tour_not_found' }     - a bogus tour id
  //   409 { error: 'names_unavailable' }  - a read the copy NEEDS threw
  // The 409 is the SEND posture, not the preview one: this route is the head of
  // a HAND send, so it refuses rather than degrading (spec 6.3b).
  router.get('/:tourId/no-show-checkin-draft', async (req, res) => {
    // 404 on an unknown tour, mirroring GET /:tourId/reminders: the draft is
    // always requested for a real tour (whose tenant the copy now names), so a
    // bogus id is a client error, not a 200 with the template.
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const window = await readQuietHoursWindow(settings, log);
    const resolved = await resolveTourContactNames({
      tenantId: tour.tenantId,
      unit: undefined,
      contactsRepo: contacts,
      logger: log,
    });
    // THE FIFTH CONSUMER of the shared assessor, and the one Phase A actually
    // uses. It takes the SEND posture because it is the head of a hand send.
    const impact = assessNamesReadFailure({
      kind: 'no_show_checkin',
      tourType: tour.tourType,
      tenantReadFailed: resolved.tenantReadFailed,
      propertyReadFailed: resolved.propertyReadFailed,
      unitReadFailed: false, // the draft deliberately reads no unit
    });
    if (impact.blocksSend) {
      // A failure-masquerading "Hi there!" prefill would be hand-sent to a
      // real tenant - the exact wrong-but-valid message 6.3b forbids, on the
      // ONE path Phase A uses. Refuse with the same token as send-now; the
      // dashboard renders it through SEND_NOW_ERROR_COPY.
      res.status(409).json({ error: 'names_unavailable' });
      return;
    }
    // Through the ONE composer (spec 9.2): the entry now carries
    // {tenantFirstName}, and a bare resolveMessage would throw in strict
    // mode. unit: undefined is deliberate - this copy names no property.
    res.json({
      body: composeTourReminderBody({
        kind: 'no_show_checkin',
        scheduledAt: tour.scheduledAt ?? '',
        timezone: window.timezone,
        tourType: tour.tourType,
        names: resolved.names,
      }),
    });
  });

  return router;
}

/**
 * Resolve the tenant's 1:1 send-time suppression estimate for a tour. Mirrors the
 * poll's 1:1 route (jobs/tourReminders.ts): the tenant contact → primary phone →
 * their 1:1 conversation → conversation/contact opt-out + conversation ai_mode,
 * fed through the shared evaluator. `staleStage` is nudge-only, so it is never
 * passed for tour reminders.
 *
 * Returns an EVALUATOR rather than one verdict: those inputs are per-TENANT and
 * cost IO, but quiet-ness is per-RUNG (see the call site), so the caller passes
 * its own flag per row. The returned function yields undefined when nothing
 * suppresses the send.
 */
async function resolveTenantSuppression(
  tour: TourItem,
  config: AppConfig,
  contacts: ContactsRepo,
  conversations: ConversationsRepo,
): Promise<(quietNow: boolean, paused: boolean) => ScheduledSuppression | undefined> {
  const contact = await contacts.getById(tour.tenantId);
  const phone = contact?.phone;
  const convs =
    typeof phone === 'string' && phone.length > 0
      ? await conversations.findByParticipantPhone(phone)
      : [];
  const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');

  return (quietNow: boolean, paused: boolean) =>
    evaluateScheduledSendSuppression({
      smsSendingEnabled: config.smsSendingEnabled,
      convOptOut: conv?.sms_opt_out,
      contactOptOut: contact?.sms_opt_out === true,
      aiMode: conv?.ai_mode,
      quietNow,
      paused,
    });
}
