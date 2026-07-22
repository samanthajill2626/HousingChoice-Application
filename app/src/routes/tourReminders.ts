// Tour reminders endpoint (scheduled-message-visibility, Task 2 + operator
// cancel/restore, 2026-07-14).
//
//   GET   /api/tours/:tourId/reminders
//        → { reminders: TourReminderView[]; next?: TourReminderView }
//   PATCH /api/tours/:tourId/reminders/:reminderId  { canceled: boolean }
//        → { reminder: TourReminderView } | 409 (already sent/skipped, or the
//          transition raced the poll — the honest current state is returned)
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
// whether the automated send WOULD be refused at fire time (kill-switch /
// opt-out / manual mode), computed via the shared evaluateScheduledSendSuppression
// (Task 1) against config + the tenant's conversation/contact. It is deliberately
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
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  evaluateScheduledSendSuppression,
  type ScheduledSuppression,
} from '../services/scheduledSendSuppression.js';

export interface TourRemindersRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
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
  const events = deps.events ?? appEvents;

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
    const suppression =
      tour.tourType === 'self_guided' && hasUpcoming
        ? await resolveTenantSuppression(tour, config, contacts, conversations)
        : undefined;

    const reminderViews: TourReminderView[] = rows
      .map((row) => {
        const state = stateOf(row);
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
          ...(state === 'upcoming' && suppression !== undefined && { suppression }),
        };
        return view;
      })
      // Ascending by dueAt (the ladder's chronological order).
      .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));

    const next = reminderViews.find((v) => v.state === 'upcoming');

    log.info(
      { tourId, count: reminderViews.length, hasNext: next !== undefined, suppressed: suppression !== undefined },
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
  router.get('/:tourId/no-show-checkin-draft', (_req, res) => {
    res.json({ body: resolveMessage('tour.no_show_checkin') });
  });

  return router;
}

/**
 * Resolve the tenant's 1:1 send-time suppression estimate for a tour. Mirrors the
 * poll's 1:1 route (jobs/tourReminders.ts): the tenant contact → primary phone →
 * their 1:1 conversation → conversation/contact opt-out + conversation ai_mode,
 * fed through the shared evaluator. `staleStage` is nudge-only, so it is never
 * passed for tour reminders. Returns undefined when nothing suppresses the send.
 */
async function resolveTenantSuppression(
  tour: TourItem,
  config: AppConfig,
  contacts: ContactsRepo,
  conversations: ConversationsRepo,
): Promise<ScheduledSuppression | undefined> {
  const contact = await contacts.getById(tour.tenantId);
  const phone = contact?.phone;
  const convs =
    typeof phone === 'string' && phone.length > 0
      ? await conversations.findByParticipantPhone(phone)
      : [];
  const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');

  return evaluateScheduledSendSuppression({
    smsSendingEnabled: config.smsSendingEnabled,
    convOptOut: conv?.sms_opt_out,
    contactOptOut: contact?.sms_opt_out === true,
    aiMode: conv?.ai_mode,
  });
}
