// Tour reminder arm/cancel/poll (Tours feature, Task 4).
//
// armTourReminders — writes the ladder of reminder rows for a tour at the
//   computed dueAt offsets relative to scheduledAt, each CLAMPED out of the
//   org's quiet-hours window (spec 2026-08-03) so a stored dueAt is the real
//   send time. Rows whose clamped dueAt is already in the past (relative to
//   `now`), lands at/after the tour start, or collides with a later rung's
//   slot are silently skipped.
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
//   (automated: false) but respects the kill switch, opt-out and JIT consent -
//   all checked BEFORE the claim, so a refusal never consumes the row.
//
// IDEMPOTENCY: listDue filters out rows with sentAt or canceledAt. claimSend
// atomically stamps sentAt BEFORE the send; the conditional also blocks
// canceledAt rows. Both conditions together = exactly-once delivery.
//
// PII (doc §9): NEVER log a phone number. Log only reminderId/tourId/tenantId/kind.
import type { MessagingAdapter } from '../adapters/messaging.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
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
import {
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { sendRelayAnnouncement } from '../services/relayAnnouncements.js';
import type { MessagesRepo } from '../repos/messagesRepo.js';
import { resolveMessage } from '../messages/index.js';
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
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { isKillSwitchOff, isOptedOut } from '../services/scheduledSendSuppression.js';

// ---------------------------------------------------------------------------
// armTourReminders
// ---------------------------------------------------------------------------

/**
 * Compute the RAW dueAt for each reminder kind relative to scheduledAt (the
 * caller clamps it out of quiet hours - see armTourReminders). The window is
 * passed in because `morning_of` is anchored to the ORG's local day, not UTC.
 */
function computeDueAt(
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
      return new Date(scheduled - 24 * 60 * 60 * 1000).toISOString();
    case 'morning_of':
      // 08:00 ORG-LOCAL on the tour's local day (quiet-hours spec 2026-08-03).
      // It used to be 08:00 UTC = 3-4am Eastern - the motivating 4am-text bug.
      return instantAtLocalTime(
        localDateOf(scheduledAt, window.timezone),
        '08:00',
        window.timezone,
      );
    case 'en_route':
      return new Date(scheduled - 2 * 60 * 60 * 1000).toISOString();
    case 'no_show_checkin':
      return new Date(scheduled + 30 * 60 * 1000).toISOString();
  }
}

/**
 * Ladder order by proximity to the event. Supersession keeps the LATEST rung of
 * a colliding pair: clamping can only push an EARLIER rung forward onto a later
 * one's slot, and when it does, the earlier rung's copy is the stale one
 * ("your tour is tomorrow" landing on tour day). Exported for the fire-time
 * backstop's batch check.
 */
export const LADDER_ORDER: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
  'no_show_checkin',
];

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
const REMINDER_KINDS: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
];

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
 * real send time. A rung is skipped (no row at all) when its clamped dueAt is
 * already past, lands at/after the tour start, or collides with a LATER rung's
 * slot - see the skip-rule comment in the loop below.
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

  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  const scheduledIso = new Date(scheduledAt).toISOString();

  // Pass 1: compute every rung's CLAMPED dueAt (the stored time IS the real
  // send time - the dashboard's honesty depends on it).
  const dues = new Map<ReminderKind, string>();
  for (const kind of REMINDER_KINDS) {
    dues.set(kind, clampOutOfQuietHours(computeDueAt(kind, scheduledAt, now, window), window));
  }

  // Pass 2: arm, applying the spec's skip rules (a skip creates NO row - the
  // pre-existing past-dueAt precedent):
  //  (a) past-dueAt (pre-existing rule),
  //  (b) past-event: a clamp landing at-or-past the tour start,
  //  (c) same-slot supersession: an earlier rung clamped onto a later rung's
  //      slot loses (the later rung's copy is the current one),
  //  (d) copy-validity: day_before landing on the tour's LOCAL date is stale
  //      ("your tour is tomorrow" on tour day) regardless of exact slot.
  const tourLocalDate = localDateOf(scheduledIso, window.timezone);
  for (const kind of REMINDER_KINDS) {
    const dueAt = dues.get(kind);
    if (dueAt === undefined) continue;
    // Skip rows that are already past (they would never be polled).
    if (dueAt < now) {
      log.info({ tourId: tour.tourId, kind, dueAt }, 'tour reminder skipped (dueAt in the past)');
      continue;
    }
    if (dueAt >= scheduledIso) {
      log.info(
        { tourId: tour.tourId, kind, dueAt },
        'tour reminder skipped (quiet-hours clamp lands at/past tour start)',
      );
      continue;
    }
    const myOrder = LADDER_ORDER.indexOf(kind);
    const supersededBySlot = REMINDER_KINDS.some((other) => {
      if (LADDER_ORDER.indexOf(other) <= myOrder) return false;
      const otherDue = dues.get(other);
      // The later rung must itself be armable (not past-event) to supersede.
      return otherDue === dueAt && otherDue < scheduledIso;
    });
    const staleDayBefore =
      kind === 'day_before' && localDateOf(dueAt, window.timezone) === tourLocalDate;
    if (supersededBySlot || staleDayBefore) {
      log.info(
        { tourId: tour.tourId, kind, dueAt },
        'tour reminder skipped (quiet-hours superseded by a later rung)',
      );
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

  const dueRows = await deps.tourRemindersRepo.listDue(now);
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

/**
 * Why a rung has NO deliverable target. Each value is also a ReminderSkipReason,
 * because the poll retires such a rung with exactly that claim-skip.
 */
type ReminderResolutionFailure =
  | 'tour_missing'
  | 'contact_missing'
  | 'contact_no_phone'
  | 'no_conversation';

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
 */
async function resolveReminderTarget(
  row: TourReminderItem,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<ReminderTarget> {
  const tour = await deps.toursRepo.get(row.tourId);
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
  // Both quiet-hours checks below run FIRST - above the tour fetch and above
  // the group-route branch (which returns early), so landlord_led / pm_team
  // rungs are covered too.

  // RELEASE SUPERSESSION (the backstop twin of arm-time supersession): if a
  // LATER rung of the SAME tour is also due in this batch, this rung's copy is
  // stale ("your tour is tomorrow" beside "your tour is today"), so retire it
  // unsent. Covers legacy rows released together at quiet-end (e.g. a
  // pre-feature 08:00-UTC morning_of alongside a deferred day_before). The
  // batch is deliberately the ONE listDue snapshot the tick started with.
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
  if (isQuietTime(now, window)) {
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
  const target = await resolveReminderTarget(row, deps, log);
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
    await sendGroupReminder(row, target.tour, target.group, now, deps, log);
    return;
  }

  const { tour, conversation: conv } = target;
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

  const sentCount = await announceGroupReminder(row, group, deps);

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
 */
async function announceGroupReminder(
  row: TourReminderItem,
  group: UsableGroup,
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
      body: resolveMessage(`tour.${row.kind}`),
      kind: `tour.${row.kind}`,
    },
  );
  return result?.sentCount ?? 0;
}

// ---------------------------------------------------------------------------
// forceSendReminder (Send now - quiet-hours spec section 7)
// ---------------------------------------------------------------------------

/** Why a human force-send was refused BEFORE the row was claimed. */
export type ForceSendRefusal =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'no_consent'
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
 * opt-out) and the JIT consent gate, and EVERY gate runs BEFORE `claimSend`,
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

  const target = await resolveReminderTarget(row, deps, log);
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
  if (isKillSwitchOff(smsSendingEnabled)) return refuse('sms_sending_disabled');
  if (target.route === 'one_to_one') {
    // Opt-out is absolute; consent is required because `automated: false` is
    // subject to the JIT consent gate (services/sendMessage.ts) - checking it
    // here is what keeps that gate from firing AFTER the claim.
    if (isOptedOut(target.conversation.sms_opt_out, target.contact.sms_opt_out === true)) {
      return refuse('contact_opted_out');
    }
    if (!hasSmsConsent(target.contact)) return refuse('no_consent');
  }

  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, nowIso);
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
    const sentCount = await announceGroupReminder(row, target.group, deps);
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
      body: resolveMessage(`tour.${row.kind}`),
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

