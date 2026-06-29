// broadcast.send (M1.8a) — fan a filtered share-broadcast ("Share Properties")
// out to each matching TENANT's 1:1 conversation, throttled and idempotent.
//
// Modeled on relayFanOut.ts, but the unit differs: a broadcast sends a 1:1
// message to EACH tenant (its own conversation) via the sendMessage wrapper —
// not a relay fan-out from a pool number. Per recipient:
//   - resolve the broadcast's recipient slot; skip if already TERMINAL
//     (sent/delivered/failed/skipped) — the per-recipient idempotency layer;
//   - re-check the contact's opt-out/unreachable flags → SKIP (bump
//     skipped_opted_out, NO token spent, NO send) — the TCPA second fence;
//   - render the body for this recipient (merge fields) and sendMessage into
//     the tenant's 1:1 conversation, STAMPED with broadcast_id so the delivery
//     callback can roll delivered/failed into the broadcast stats;
//   - on a RESOLVED send (message reached the adapter) acquire ONE A2P token —
//     a SendRefusedError (conversation-level opt-out/breaker/manual) throws
//     before the adapter, so a refused/skipped recipient spends NO token;
//   - record the recipient slot + bump `sent`.
//
// Idempotency (SQS at-least-once + our own continuation re-enqueues):
//   - the job execution marker guards the WHOLE job per envelope jobId;
//   - per recipient, a TERMINAL broadcast slot is SKIPPED, so a redelivered /
//     continuation job never double-sends.
//
// Error handling per recipient (mirrors relay):
//   - SendRefusedError (opt-out/breaker/manual) → recipient 'skipped' (bump
//     skipped_opted_out), continue (a by-design refusal, not a failure);
//   - 429 / 30022 (transient) → leave the slot 'queued' + add to the
//     continuation's remaining list (capped at MAX_BROADCAST_ATTEMPTS);
//   - 30007 (carrier filtering) → recipient 'failed', NEVER retried;
//   - 30005 / 30006 (invalid number / landline) → recipient 'failed' + flag the
//     contact sms_unreachable (prompt voice; never retry).
//
// PII (doc §9): NEVER log bodies/phones/names — broadcastId / contactKeys /
// counts / SIDs only, correlated via the pino mixin (relayFanOut precedent).
import { loadConfig, type AppConfig } from '../lib/config.js';
import { getContext } from '../lib/context.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import { buildUnitMergeContext, renderBody } from '../lib/mergeFields.js';
import {
  createBroadcastsRepo,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastsRepo,
} from '../repos/broadcastsRepo.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';
import {
  createListingSendsRepo,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const BROADCAST_SEND_JOB = 'broadcast.send';

/** Continuation cap: a transient failure re-enqueues at most this many times. */
export const MAX_BROADCAST_ATTEMPTS = 3;

/** Exponential backoff for the transient-failure continuation: 5s, 10s, 20s. */
export function broadcastBackoffMs(attempt: number): number {
  return 5_000 * 2 ** (attempt - 1);
}

/** Twilio transient error codes that warrant a backed-off continuation. */
const TRANSIENT_CODES = new Set(['429', '30022']);
/** Twilio carrier-filtering: NEVER retry. */
const CARRIER_FILTERED_CODE = '30007';
/** Invalid number / landline: flag the contact unreachable, never retry. */
const UNREACHABLE_CODES = new Set(['30005', '30006']);

export interface BroadcastSendPayload {
  broadcastId: string;
  /** Remaining contactKeys (continuation); absent = all from the snapshot. */
  recipientKeys?: string[];
  /** 1-based continuation attempt (absent = first run, treated as 1). */
  attempt?: number;
}

export function parseBroadcastSendPayload(payload: unknown): BroadcastSendPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('broadcastFanOut: payload is not an object');
  }
  const p = payload as Partial<BroadcastSendPayload>;
  if (typeof p.broadcastId !== 'string' || p.broadcastId.length === 0) {
    throw new Error('broadcastFanOut: missing broadcastId');
  }
  const attempt =
    typeof p.attempt === 'number' && Number.isInteger(p.attempt) && p.attempt >= 1 ? p.attempt : 1;
  const recipientKeys =
    Array.isArray(p.recipientKeys) && p.recipientKeys.every((k) => typeof k === 'string')
      ? p.recipientKeys
      : undefined;
  return {
    broadcastId: p.broadcastId,
    attempt,
    ...(recipientKeys !== undefined && { recipientKeys }),
  };
}

/** Terminal recipient slot states never re-sent (idempotency). */
function isTerminal(status: BroadcastRecipient['status'] | undefined): boolean {
  return (
    status === 'sent' || status === 'delivered' || status === 'failed' || status === 'skipped'
  );
}

/** Best-effort provider error-code extraction (Twilio attaches `code`). */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code.length > 0) return code;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return String(status);
  }
  return undefined;
}

export interface BroadcastSendJobDeps {
  config?: AppConfig;
  broadcastsRepo?: BroadcastsRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  unitsRepo?: UnitsRepo;
  sendMessageService?: SendMessageService;
  /** BE2/C2: emit a `listing_sent` milestone per recipient actually sent. */
  activityEventsRepo?: ActivityEventsRepo;
  /** BE4/C4: record the listing-send row per recipient sent (when unit-targeted). */
  listingSendsRepo?: ListingSendsRepo;
  /** Shared A2P token bucket (worker boot). Optional — tests may omit pacing. */
  tokenBucket?: TokenBucket;
  events?: EventBus;
  logger?: Logger;
}

export function registerBroadcastSendJobHandler(deps: BroadcastSendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/services/config touch DynamoDB only on first job run.
  let config = deps.config;
  let broadcasts = deps.broadcastsRepo;
  let contacts = deps.contactsRepo;
  let conversations = deps.conversationsRepo;
  let units = deps.unitsRepo;
  let sendMessage = deps.sendMessageService;
  const events = deps.events ?? appEvents;

  defineJobHandler(BROADCAST_SEND_JOB, async (rawPayload) => {
    const payload = parseBroadcastSendPayload(rawPayload);
    config ??= loadConfig();
    broadcasts ??= createBroadcastsRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    units ??= createUnitsRepo({ logger: deps.logger });
    const messages: MessagesRepo =
      deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
    const activityEvents: ActivityEventsRepo =
      deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
    const listingSends: ListingSendsRepo =
      deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
    sendMessage ??= createSendMessageService({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      messagesRepo: messages,
      contactsRepo: contacts,
      events,
    });

    // Whole-job duplicate-delivery guard (existing pattern): conditionally mark
    // this envelope jobId executed BEFORE any send. A redelivery resolves as a
    // no-op so the consumer deletes the message. Per-recipient terminal skips
    // are the second layer (a continuation reuses recipientKeys).
    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.broadcastId);
      if (!first) {
        log.info({ jobId, broadcastId: payload.broadcastId }, 'broadcast send duplicate delivery suppressed');
        return;
      }
    } else {
      log.warn(
        { broadcastId: payload.broadcastId },
        'broadcastFanOut: no jobId in context — duplicate-delivery guard skipped',
      );
    }

    const broadcast = await broadcasts.getById(payload.broadcastId);
    if (!broadcast) {
      log.warn({ broadcastId: payload.broadcastId }, 'broadcastFanOut: broadcast not found — nothing to send');
      return;
    }

    // Resolve the unit-derived merge context ONCE (constant for the broadcast);
    // only [TenantName] is per-recipient.
    const unit =
      typeof broadcast.unitId === 'string' && broadcast.unitId.length > 0
        ? await units.getById(broadcast.unitId)
        : undefined;
    const unitContext = buildUnitMergeContext(unit, config.publicBaseUrl);

    // The recipient set: the continuation's remaining keys, else every key from
    // the persisted snapshot.
    const allKeys = Object.keys(broadcast.recipients ?? {});
    const keys =
      payload.recipientKeys !== undefined
        ? allKeys.filter((k) => payload.recipientKeys!.includes(k))
        : allKeys;

    const transientRemaining: string[] = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const contactKey of keys) {
      const slot = broadcast.recipients[contactKey];
      if (isTerminal(slot?.status)) continue; // already terminal — never re-send

      // Resolve the contact (the snapshot holds keys; re-read flags fresh so a
      // STOP since send-time is honored).
      const contact = await resolveContact(contacts, contactKey);
      if (!contact || typeof contact.phone !== 'string' || contact.phone.length === 0) {
        await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'failed', errorCode: 'no_contact' });
        await broadcasts.bumpStats(payload.broadcastId, { failed: 1, queued: -1 });
        failedCount += 1;
        log.warn({ broadcastId: payload.broadcastId, contactKey }, 'broadcastFanOut: recipient has no resolvable contact/phone — marked failed');
        continue;
      }

      // TCPA first fence: skip opted-out / unreachable here (NO token spent, NO
      // send). sendMessage's opt-out gate is the second fence.
      if (contact.sms_opt_out === true || contact.sms_unreachable === true) {
        await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'skipped' });
        await broadcasts.bumpStats(payload.broadcastId, { skipped_opted_out: 1, queued: -1 });
        skippedCount += 1;
        continue;
      }

      // Resolve/find the tenant's 1:1 conversation by phone, then send INTO it.
      const conversation = await conversations.createOrGetByParticipantPhone(contact.phone, 'tenant_1to1');
      const body = renderBody(broadcast.body_template, unitContext, firstNameOf(contact));

      try {
        // A2P meter: ONE token per REAL outbound SMS. sendMessage runs FIRST —
        // it may throw SendRefusedError (conversation-level opt-out / breaker /
        // manual) BEFORE any adapter send, and a refusal must spend NO token.
        // A resolved sendMessage means the message reached the adapter, so we
        // acquire the token in the SUCCESS path. Pacing is preserved: one token
        // per actual send still rate-limits against the shared ~1/s bucket
        // (post-send pacing — the next recipient waits behind this token).
        const outcome = await sendMessage({
          conversationId: conversation.conversationId,
          body,
          author: 'teammate',
          automated: true,
          broadcastId: payload.broadcastId,
        });
        await deps.tokenBucket?.acquire(1);
        await recordRecipient(broadcasts, payload.broadcastId, contactKey, {
          conversationId: outcome.conversationId,
          tsMsgId: outcome.tsMsgId,
          status: 'sent',
        });
        await broadcasts.bumpStats(payload.broadcastId, { sent: 1, queued: -1 });
        sentCount += 1;
        // BE2/C2: a delivered property is a `listing_sent` milestone on the
        // tenant's timeline. Prefer the unit (the thing sent) as the deep-link
        // target; fall back to the broadcast when the broadcast has no unitId.
        // Best-effort — a milestone failure must NEVER fail the send (the SMS is
        // already out + the recipient slot recorded), so it is swallowed + logged.
        try {
          const hasUnit = typeof broadcast.unitId === 'string' && broadcast.unitId.length > 0;
          await activityEvents.record({
            contactId: contact.contactId,
            type: 'listing_sent',
            label: 'Property sent',
            refType: hasUnit ? 'unit' : 'broadcast',
            refId: hasUnit ? broadcast.unitId! : payload.broadcastId,
          });
        } catch (milestoneErr) {
          log.error(
            { err: milestoneErr, broadcastId: payload.broadcastId, contactKey },
            'broadcastFanOut: recording listing_sent milestone failed (best-effort)',
          );
        }
        // BE4/C4: record the unit↔contact listing-send row so the "Sent to
        // tenants" / "Properties sent" pages light up. ONLY when the broadcast
        // targets a unit (a unit-less broadcast records nothing — there is no
        // property to attribute). Best-effort + idempotent: the upsert is safe on
        // SQS redelivery (and the job's terminal-recipient skip already prevents
        // re-entry), and a failure must NEVER fail the send (the SMS is already
        // out + the recipient slot recorded) — so it is swallowed + logged.
        if (typeof broadcast.unitId === 'string' && broadcast.unitId.length > 0) {
          try {
            await listingSends.recordSend({
              contactId: contact.contactId,
              unitId: broadcast.unitId,
              via: 'broadcast',
              broadcastId: payload.broadcastId,
            });
          } catch (sendErr) {
            log.error(
              { err: sendErr, broadcastId: payload.broadcastId, contactKey },
              'broadcastFanOut: recording listing-send row failed (best-effort)',
            );
          }
        }
      } catch (err) {
        if (err instanceof SendRefusedError) {
          // Opt-out / breaker / manual — a by-design refusal for THIS recipient.
          // Treat as a skip (no token "wasted" on a real send; the recipient is
          // simply not reachable for this automated broadcast).
          await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'skipped', errorCode: err.code });
          await broadcasts.bumpStats(payload.broadcastId, { skipped_opted_out: 1, queued: -1 });
          skippedCount += 1;
          log.warn({ broadcastId: payload.broadcastId, contactKey, refusal: err.code }, 'broadcastFanOut: send refused — recipient skipped, continuing');
          continue;
        }
        const code = errorCodeOf(err);
        if (code === CARRIER_FILTERED_CODE) {
          await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'failed', errorCode: code });
          await broadcasts.bumpStats(payload.broadcastId, { failed: 1, queued: -1 });
          failedCount += 1;
          log.error({ broadcastId: payload.broadcastId, contactKey, errorCode: code }, 'broadcastFanOut: carrier filtering (30007) — recipient failed, NOT retried');
          continue;
        }
        if (code !== undefined && UNREACHABLE_CODES.has(code)) {
          await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'failed', errorCode: code });
          await broadcasts.bumpStats(payload.broadcastId, { failed: 1, queued: -1 });
          failedCount += 1;
          // Flag the contact unreachable (prompt voice; never retry SMS).
          try {
            await contacts.setFlag(contact.contactId, 'sms_unreachable');
          } catch (flagErr) {
            log.error({ err: flagErr, broadcastId: payload.broadcastId, contactKey }, 'broadcastFanOut: failed to flag contact sms_unreachable');
          }
          log.warn({ broadcastId: payload.broadcastId, contactKey, errorCode: code }, 'broadcastFanOut: invalid number/landline — recipient failed, contact flagged unreachable');
          continue;
        }
        if (code !== undefined && TRANSIENT_CODES.has(code)) {
          // Defer to a backed-off continuation; keep the slot 'queued'.
          await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'queued', errorCode: code });
          transientRemaining.push(contactKey);
          log.warn({ broadcastId: payload.broadcastId, contactKey, errorCode: code, attempt: payload.attempt }, 'broadcastFanOut: transient send error — deferring recipient to continuation');
          continue;
        }
        // Unknown error: leave the recipient queued and let the job FAIL so SQS
        // redelivers the whole envelope (a fresh jobId via the visibility
        // timeout; the marker is per-jobId).
        throw err;
      }
    }

    log.info(
      {
        broadcastId: payload.broadcastId,
        recipientCount: keys.length,
        sentCount,
        skippedCount,
        failedCount,
        deferred: transientRemaining.length,
        attempt: payload.attempt,
      },
      'broadcast send pass complete',
    );

    // Transient continuation: re-enqueue the remaining recipients with backoff,
    // capped. Beyond the cap → mark those failed (no silent black hole).
    if (transientRemaining.length > 0) {
      const nextAttempt = (payload.attempt ?? 1) + 1;
      if (nextAttempt > MAX_BROADCAST_ATTEMPTS) {
        for (const contactKey of transientRemaining) {
          await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'failed', errorCode: 'transient_cap' });
          await broadcasts.bumpStats(payload.broadcastId, { failed: 1, queued: -1 });
        }
        log.error(
          { broadcastId: payload.broadcastId, deferred: transientRemaining.length, attempt: payload.attempt },
          'broadcastFanOut: transient retry cap reached — remaining recipients marked failed',
        );
        await finalize(broadcasts, events, payload.broadcastId, log);
        return;
      }
      await enqueue(
        BROADCAST_SEND_JOB,
        {
          broadcastId: payload.broadcastId,
          attempt: nextAttempt,
          recipientKeys: transientRemaining,
        } satisfies BroadcastSendPayload,
        // The continuation runs AS nextAttempt, so it waits ITS OWN backoff
        // (attempt 1→2 waits the 2nd-step delay = 10s, 2→3 = 20s). Using the
        // current attempt's delay here would under-wait by one step.
        { runAt: new Date(Date.now() + broadcastBackoffMs(nextAttempt)) },
      );
      // A continuation is still pending — do NOT finalize yet.
      return;
    }

    // No recipients remain → terminal. markSent unless EVERY recipient failed.
    await finalize(broadcasts, events, payload.broadcastId, log);
  });
}

/** Resolve the contact behind a contactKey (contactId else `phone#<E164>`). */
async function resolveContact(
  contacts: ContactsRepo,
  contactKey: string,
): Promise<ContactItem | undefined> {
  if (contactKey.startsWith('phone#')) {
    return contacts.findByPhone(contactKey.slice('phone#'.length));
  }
  return contacts.getById(contactKey);
}

/** Resolved first name for [TenantName], or undefined. */
function firstNameOf(contact: ContactItem): string | undefined {
  const v = contact['firstName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Persist one recipient's slot on the broadcast. */
async function recordRecipient(
  broadcasts: BroadcastsRepo,
  broadcastId: string,
  contactKey: string,
  recipient: BroadcastRecipient,
): Promise<void> {
  await broadcasts.setRecipient(broadcastId, contactKey, recipient);
}

/**
 * Terminal-status the broadcast + emit the SSE event. markSent unless EVERY
 * recipient ended terminal-failed (then markFailed). Reads the fresh item so
 * the emitted stats are the rolled-up totals.
 */
async function finalize(
  broadcasts: BroadcastsRepo,
  events: EventBus,
  broadcastId: string,
  log: Logger,
): Promise<void> {
  const fresh = await broadcasts.getById(broadcastId);
  if (!fresh) {
    log.warn({ broadcastId }, 'broadcastFanOut: broadcast vanished before finalize');
    return;
  }
  const total = Object.keys(fresh.recipients ?? {}).length;
  const allFailed = total > 0 && fresh.stats.failed >= total;
  const finalItem: BroadcastItem = allFailed
    ? await broadcasts.markFailed(broadcastId, 'all recipients failed')
    : await broadcasts.markSent(broadcastId);
  events.emit('broadcast.updated', {
    broadcastId,
    status: finalItem.status,
    stats: finalItem.stats,
  });
  log.info(
    { broadcastId, status: finalItem.status, sent: finalItem.stats.sent, failed: finalItem.stats.failed, skipped: finalItem.stats.skipped_opted_out },
    'broadcast send finalized',
  );
}
