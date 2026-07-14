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
import type { MessagingAdapter } from '../adapters/messaging.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import type {
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
import {
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { sendRelayAnnouncement } from '../services/relayAnnouncements.js';
import type { MessagesRepo } from '../repos/messagesRepo.js';
import { resolveMessage } from '../messages/index.js';

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

  // Invariant: no reminder rows may ever exist for a time-less ('requested')
  // tour. Callers gate arming on scheduledAt presence, but guard anyway
  // (booking arms the ladder later).
  const scheduledAt = tour.scheduledAt;
  if (typeof scheduledAt !== 'string') {
    log.warn({ tourId: tour.tourId }, 'tour reminders not armed (no scheduledAt)');
    return created;
  }

  for (const kind of REMINDER_KINDS) {
    const dueAt = computeDueAt(kind, scheduledAt, now);
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
  /**
   * Direct provider sends for the GROUP route (landlord_led / pm_team tours
   * with a usable group thread). Named `adapter` to match the repo idiom
   * (RelayFanOutJobDeps / SendMessageServiceDeps). The group route CANNOT go
   * through sendMessageService — it throws RelaySendNotSupportedError for
   * relay_group conversations — and the worker cannot enqueue relay.fanOut
   * (no OutboundQueueAdapter in the worker process), so reminders go through
   * sendRelayAnnouncement (the relay.intro chain): persist the rung ONCE in
   * the thread, then per-member adapter sends FROM the pool number.
   */
  adapter: MessagingAdapter;
  /**
   * Message persistence for the GROUP route: sendRelayAnnouncement stores each
   * rung as a system announcement in the relay thread (founder decision
   * 2026-07-14: everything sent into a group text must be visible in its
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
   * timeline's Upcoming bucket refetch the ladder. NOTE the lib/events.ts
   * single-instance seam: this reaches SSE clients only when the poll runs in
   * the APP process (the hermetic dev tick / e2e); the deployed worker's emit
   * goes nowhere until the seam is bridged — the panel's dueAt-anchored
   * refetch covers that case client-side.
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

/**
 * Retire a rung the poll cannot deliver (claim-skip): stamps skippedAt +
 * skipReason so the row leaves listDue exactly once (instead of being
 * re-listed and re-skipped every 60s forever — the perpetual "sending
 * shortly" bug), and tells live surfaces to refetch so the panel flips to
 * its "Skipped - <reason>" chip.
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

async function processReminderRow(
  row: TourReminderItem,
  now: string,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<void> {
  // Resolve the tour.
  const tour = await deps.toursRepo.get(row.tourId);
  if (!tour) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId },
      'tour reminder: tour not found — retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'tour_missing', now, deps);
    return;
  }

  // Route decision (founder decision 2026-07-02): reminders for landlord_led /
  // pm_team tours go to the tour's masked GROUP thread — the landlord/PM should
  // see them too. self_guided stays tenant-1:1 EVEN IF a group thread exists.
  // A non-self_guided tour with no USABLE group (no groupThreadId, conversation
  // missing, not a relay_group, closed, or no pool/roster) falls back to the
  // tenant-1:1 path below — a reminder must never be lost.
  if (tour.tourType !== 'self_guided') {
    const group = await resolveUsableGroup(tour, row, deps, log);
    if (group) {
      await sendGroupReminder(row, tour, group, now, deps, log);
      return;
    }
  }

  // Resolve the tenant contact.
  const contact = await deps.contactsRepo.getById(tour.tenantId);
  if (!contact) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: contact not found — retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'contact_missing', now, deps, tour.tenantId);
    return;
  }

  // Primary phone (scalar back-compat, never logged).
  const phone = contact.phone;
  if (typeof phone !== 'string' || phone.length === 0) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: contact has no phone — retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'contact_no_phone', now, deps, tour.tenantId);
    return;
  }

  // Find the tenant's 1:1 conversation via phone lookup.
  const convs = await deps.conversationsRepo.findByParticipantPhone(phone);
  const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
  if (!conv) {
    log.warn(
      { reminderId: row.reminderId, tourId: row.tourId, tenantId: tour.tenantId },
      'tour reminder: no 1:1 conversation found — retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'no_conversation', now, deps, tour.tenantId);
    return;
  }

  const body = resolveMessage(`tour.${row.kind}`);

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
 * everything sent into a group text must be visible in its dashboard thread),
 * then sends per member FROM the pool number with opt-out suppression, A2P
 * pacing, and per-member delivery slots. sendMessageService is unusable here
 * (it throws RelaySendNotSupportedError for relay_group threads) and the
 * worker cannot enqueue relay.fanOut (no OutboundQueueAdapter in the worker
 * process). Per-member failures are the service's accepted post-claim
 * tradeoff: the claim is already stamped, a failed member is not retried.
 */
async function sendGroupReminder(
  row: TourReminderItem,
  tour: TourItem,
  group: UsableGroup,
  now: string,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<void> {
  const body = resolveMessage(`tour.${row.kind}`);

  // CLAIM-BEFORE-SEND (same atomic claim as the 1:1 path): claim ONCE for the
  // whole group — losing the claim (concurrent tick / cancel) skips silently.
  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, now);
  if (!claimed) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder claim lost (concurrent tick or canceled) — skipping',
    );
    return;
  }
  // Rung flipped to sent — same live-surface nudge as the 1:1 path.
  (deps.events ?? appEvents).emit('scheduled.updated', { contactId: tour.tenantId });

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
    { conversationId: group.conversationId, body, kind: `tour.${row.kind}` },
  );

  log.info(
    {
      reminderId: row.reminderId,
      tourId: row.tourId,
      tenantId: tour.tenantId,
      kind: row.kind,
      route: 'group',
      conversationId: group.conversationId,
      memberCount: group.members.length,
      sentCount: result?.sentCount ?? 0,
    },
    'tour reminder sent',
  );
}

