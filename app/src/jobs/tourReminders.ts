// Tour reminder arm/cancel/poll (Tours feature, Task 4).
//
// armTourReminders — writes the ladder of reminder rows for a tour at the
//   computed dueAt offsets relative to scheduledAt. Rows whose computed dueAt
//   is already in the past (relative to `now`) are silently skipped.
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
// IDEMPOTENCY: listDue filters out rows with sentAt or canceledAt. claimSend
// atomically stamps sentAt BEFORE the send; the conditional also blocks
// canceledAt rows. Both conditions together = exactly-once delivery.
//
// PII (doc §9): NEVER log a phone number. Log only reminderId/tourId/tenantId/kind.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  type ReminderKind,
  type TourReminderItem,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import {
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';

// ---------------------------------------------------------------------------
// Canned reminder text
// ---------------------------------------------------------------------------

const REMINDER_BODIES: Record<ReminderKind, string> = {
  confirmation: "[AUTO] Your tour is confirmed. We'll send reminders as it approaches.",
  day_before: '[AUTO] Reminder: your property tour is tomorrow.',
  morning_of: '[AUTO] Good morning! Your property tour is today.',
  en_route: '[AUTO] Your tour is coming up soon. Text us when you\'re on the way!',
  no_show_checkin: '[AUTO] Hi! We noticed you may have missed your tour. Want to reschedule?',
};

// ---------------------------------------------------------------------------
// armTourReminders
// ---------------------------------------------------------------------------

/**
 * Compute the dueAt for each reminder kind relative to scheduledAt.
 * Returns undefined when a kind has no meaningful dueAt (shouldn't happen,
 * but keeps the type safe).
 */
function computeDueAt(kind: ReminderKind, scheduledAt: string, now: string): string {
  const scheduled = new Date(scheduledAt).getTime();
  switch (kind) {
    case 'confirmation':
      return now; // immediate
    case 'day_before':
      return new Date(scheduled - 24 * 60 * 60 * 1000).toISOString();
    case 'morning_of': {
      // 08:00 UTC on the day of the tour
      const d = new Date(scheduledAt);
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0, 0),
      ).toISOString();
    }
    case 'en_route':
      return new Date(scheduled - 2 * 60 * 60 * 1000).toISOString();
    case 'no_show_checkin':
      return new Date(scheduled + 30 * 60 * 1000).toISOString();
  }
}

const REMINDER_KINDS: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
  'no_show_checkin',
];

export interface ArmTourRemindersDeps {
  tourRemindersRepo: TourRemindersRepo;
  logger?: Logger;
}

/**
 * Arm the full reminder ladder for a tour. Rows whose dueAt is already past
 * (< now) are skipped — except `confirmation` which always uses `now` and is
 * therefore always armed.
 *
 * Returns the created TourReminderItem rows.
 */
export async function armTourReminders(
  tour: TourItem,
  now: string,
  deps: ArmTourRemindersDeps,
): Promise<TourReminderItem[]> {
  const log = deps.logger ?? defaultLogger;
  const created: TourReminderItem[] = [];

  // Invariant: armTourReminders must never be called for a time-less
  // ('requested') tour. If scheduledAt is absent, return immediately so that
  // no reminder rows are ever created (reminder-invariant guard).
  if (typeof tour.scheduledAt !== 'string') {
    log.info({ tourId: tour.tourId }, 'tour reminder arm skipped (no scheduledAt — requested tour)');
    return created;
  }

  for (const kind of REMINDER_KINDS) {
    const dueAt = computeDueAt(kind, tour.scheduledAt, now);
    // Skip rows that are already past (they would never be polled).
    // `confirmation` is always `now`, so it always passes this check.
    if (dueAt < now) {
      log.info({ tourId: tour.tourId, kind, dueAt }, 'tour reminder skipped (dueAt in the past)');
      continue;
    }
    const row = await deps.tourRemindersRepo.create({ tourId: tour.tourId, kind, dueAt });
    created.push(row);
    log.info({ tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId }, 'tour reminder armed');
  }

  return created;
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
  toursRepo: ToursRepo;
  contactsRepo: ContactsRepo;
  conversationsRepo: ConversationsRepo;
  sendMessageService: SendMessageService;
  logger?: Logger;
}

/**
 * The stateless poll handler. Queries all pending reminders due at or before
 * `now`, then for each row: resolves the tour→contact→conversation→sends.
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

  const dueRows = await deps.tourRemindersRepo.listDue(now);
  if (dueRows.length === 0) return;

  log.info({ count: dueRows.length, now }, 'tour reminder poll: processing due rows');

  for (const row of dueRows) {
    try {
      await processReminderRow(row, now, deps, log);
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

async function processReminderRow(
  row: TourReminderItem,
  now: string,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<void> {
  // Resolve the tour.
  const tour = await deps.toursRepo.get(row.tourId);
  if (!tour) {
    log.warn({ reminderId: row.reminderId, tourId: row.tourId }, 'tour reminder: tour not found — skipping');
    return;
  }

  // Resolve the tenant contact.
  const contact = await deps.contactsRepo.getById(tour.tenantId);
  if (!contact) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: contact not found — skipping',
    );
    return;
  }

  // Primary phone (scalar back-compat, never logged).
  const phone = contact.phone;
  if (typeof phone !== 'string' || phone.length === 0) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: contact has no phone — skipping',
    );
    return;
  }

  // Find the tenant's 1:1 conversation via phone lookup.
  const convs = await deps.conversationsRepo.findByParticipantPhone(phone);
  const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
  if (!conv) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: no 1:1 conversation found — skipping',
    );
    return;
  }

  const body = REMINDER_BODIES[row.kind];

  // CLAIM-BEFORE-SEND: atomically stamp sentAt BEFORE the outbound send so two
  // concurrent poll ticks both see the same due row but only the first to claim
  // wins. The claim condition also blocks canceledAt rows, closing the
  // cancel-then-poll TOCTOU race in one atomic step.
  // If the claim fails (another tick or a cancelForTour won), skip silently —
  // a benign no-op, NOT an error (mirrors missedCallAutoText's marker pattern).
  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, now);
  if (!claimed) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder claim lost (concurrent tick or canceled) — skipping',
    );
    return;
  }

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
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId, kind: row.kind },
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

