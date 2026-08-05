// Tour reminders endpoint (scheduled-message-visibility, Task 2 + operator
// cancel/restore, 2026-07-14).
//
//   GET   /api/tours/:tourId/reminders
//        → { reminders: TourReminderView[]; next?: TourReminderView }
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
import { resolveMessage } from '../messages/index.js';
import {
  createTourRemindersRepo,
  type ReminderKind,
  type ReminderSkipReason,
  type TourReminderItem,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  evaluateScheduledSendSuppression,
  type ScheduledSuppression,
} from '../services/scheduledSendSuppression.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import {
  forceSendReminder,
  readQuietHoursWindow,
  type RunDueTourRemindersDeps,
} from '../jobs/tourReminders.js';
import { isQuietTime } from '../lib/quietHours.js';
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
  /** Quiet-hours window source for the suppression estimate (narrow read-only
   *  shape - the `resolveWithSettings` precedent). */
  settingsRepo?: Pick<SettingsRepo, 'getOrgSettings'>;
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
  /** The unit's address for the composed reminder copy (both the send-now path
   *  and the previews below). */
  unitsRepo?: UnitsRepo;
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
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
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
    sendMessageService:
      deps.sendMessageService ?? createSendMessageService({ config, logger: deps.logger }),
    settingsRepo: settings,
    adapter: deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger }),
    messagesRepo: deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger }),
    unitsRepo: units,
    events,
    ...(deps.logger !== undefined && { logger: deps.logger }),
  };

  const router = Router();

  /** Project one stored row → its wire view (no suppression estimate — the
   *  PATCH response is a state echo; GET recomputes estimates on refetch). */
  const viewOf = (row: TourReminderItem): TourReminderView => {
    const state = stateOf(row);
    return {
      reminderId: row.reminderId,
      kind: row.kind,
      dueAt: row.dueAt,
      state,
      body: resolveMessage(`tour.${row.kind}`),
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
    if (!won) {
      log.info(
        { tourId, reminderId, wanted: canceled ? 'cancel' : 'restore', state: stateOf(after) },
        'tour reminder cancel/restore lost the claim — reporting current state',
      );
      res.status(409).json({
        error: canceled ? 'reminder_not_cancelable' : 'reminder_not_restorable',
        reminder: viewOf(after),
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
    res.json({ reminder: viewOf(after) });
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

    if (result.outcome === 'sent') {
      await audit.append(`tours#${tourId}`, 'reminder_force_sent', {
        reminderId,
        kind: after.kind,
        ...(actor !== undefined && { actor }),
      });
      log.info({ tourId, reminderId, kind: after.kind }, 'tour reminder force-sent via api');
      res.json({ reminder: viewOf(after) });
      return;
    }

    // 'not_pending' (already terminal / lost claim) vs a refusal reason vs the
    // post-claim race - the UI shows the reason verbatim, never a silent no-op.
    const error = result.outcome === 'not_pending' ? 'reminder_not_pending' : result.reason;
    log.info(
      { tourId, reminderId, kind: after.kind, outcome: result.outcome, error },
      'tour reminder send-now refused',
    );
    res.status(409).json({ error, reminder: viewOf(after) });
  });

  router.get('/:tourId/reminders', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');

    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }

    const rows = await reminders.listByTour(tourId);

    // Resolve the tenant's send-time suppression estimate ONCE per request (the
    // same conversation/contact backs every 1:1-routed rung). Only needed when
    // the tour has at least one UPCOMING rung on a 1:1 route — for THIS task the
    // unambiguous self_guided route (Task 4 tightens the group case). A
    // non-self_guided tour never gets an estimate here.
    const hasUpcoming = rows.some((r) => stateOf(r) === 'upcoming');
    let suppressionOf: ((dueAt: string) => ScheduledSuppression | undefined) | undefined;
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
      const window = await readQuietHoursWindow(settings, log);
      const nowIso = new Date().toISOString();
      const wallClockQuiet = isQuietTime(nowIso, window);
      // The tenant's contact/thread inputs cost IO and back EVERY 1:1-routed
      // rung identically, so they are resolved once; only the quiet flag is
      // per-row. Stored dueAts are already normalized ISO, so `<=` compares
      // them lexicographically against the normalized nowIso.
      const evaluate = await resolveTenantSuppression(tour, config, contacts, conversations);
      suppressionOf = (dueAt: string): ScheduledSuppression | undefined =>
        evaluate((dueAt > nowIso && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= nowIso));
    }

    const reminderViews: TourReminderView[] = rows
      .map((row) => {
        const state = stateOf(row);
        const suppression =
          state === 'upcoming' && suppressionOf !== undefined ? suppressionOf(row.dueAt) : undefined;
        const view: TourReminderView = {
          reminderId: row.reminderId,
          kind: row.kind,
          dueAt: row.dueAt,
          state,
          body: resolveMessage(`tour.${row.kind}`),
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

    const next = reminderViews.find((v) => v.state === 'upcoming');

    log.info(
      {
        tourId,
        count: reminderViews.length,
        hasNext: next !== undefined,
        suppressed: reminderViews.some((v) => v.suppression !== undefined),
      },
      'tour reminders read',
    );

    res.json({ reminders: reminderViews, ...(next !== undefined && { next }) });
  });

  // GET /:tourId/no-show-checkin-draft -> the templated body for the MANUAL
  // no-show check-in send. The no_show_checkin rung is no longer auto-armed
  // (jobs/tourReminders.ts), so there is no armed row to read the copy from; the
  // tour page fetches it here to PREFILL the tenant 1:1 composer. Copy is
  // tour-independent and var-less; resolveMessage keeps it in sync with any
  // editable override, exactly like the reminder-body resolution above.
  router.get('/:tourId/no-show-checkin-draft', async (req, res) => {
    // 404 on an unknown tour, mirroring GET /:tourId/reminders. The copy itself is
    // tour-independent, but a draft is always requested for a real tour, so a
    // bogus id is a client error, not a 200 with the template.
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    res.json({ body: resolveMessage('tour.no_show_checkin') });
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
): Promise<(quietNow: boolean) => ScheduledSuppression | undefined> {
  const contact = await contacts.getById(tour.tenantId);
  const phone = contact?.phone;
  const convs =
    typeof phone === 'string' && phone.length > 0
      ? await conversations.findByParticipantPhone(phone)
      : [];
  const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');

  return (quietNow: boolean) =>
    evaluateScheduledSendSuppression({
      smsSendingEnabled: config.smsSendingEnabled,
      convOptOut: conv?.sms_opt_out,
      contactOptOut: contact?.sms_opt_out === true,
      aiMode: conv?.ai_mode,
      quietNow,
    });
}
