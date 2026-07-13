// Tour reminders READ endpoint (scheduled-message-visibility, Task 2).
//
//   GET /api/tours/:tourId/reminders
//        → { reminders: TourReminderView[]; next?: TourReminderView }
//
// Mounted under /api/tours (behind requireAuth via the /api mount). Read-only:
// surfaces each armed reminder rung's state (upcoming|sent|canceled) + its
// canned body so the dashboard can show a tenant WHAT scheduled texts are queued
// and which already fired — the visibility half of the feature.
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
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
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

  const router = Router();

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
