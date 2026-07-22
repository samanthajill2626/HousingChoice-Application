// relay.numberReady (relay number buying strategy T6, decision D6) - the
// connect-when-ready hand-off. onNumberRegistered (T3) enqueues this job when a
// warming number earmarked to a CONNECTING group (pending_conversation_id) has
// A2P-registered and been promoted to active. This handler opens the group onto
// that now-active dedicated number:
//   G1 (burn on assign): burn the group's roster onto the number (it was created
//       warming with an EMPTY burn, so a fresh assign never overlap-fails) - this
//       records the burn, preserving the burn-multiplexing invariant + enabling
//       future multiplex.
//   G3 (exactly-once): assignPoolNumberAndOpen is CONDITIONAL on the group still
//       being 'connecting', and a read-check up front short-circuits an
//       already-open group - so a redelivered job neither re-burns nor re-intros.
// Then the DEFERRED intro is enqueued (the connecting path skipped it). A queued-
// message FLUSH (T7) is added AFTER the intro by the next slice - see the seam.
//
// NOT a token-bucket job (no outbound SMS here - just a burn + a status flip + an
// intro enqueue). Registered in registerHandlers.ts (single source of truth for
// both worker.ts and the app's in-process path).
//
// PII (doc section 9): the payload + logs carry only ids (conversationId) and the
// pool number is NOT logged - never a member phone/name.
import type { Logger } from '../lib/logger.js';
import { logger as defaultLogger } from '../lib/logger.js';
import {
  createConversationsRepo,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createPoolNumbersService,
  RELAY_NUMBER_READY_JOB,
  type PoolNumbersService,
} from '../services/poolNumbers.js';
import { RELAY_INTRO_JOB } from './relayFanOut.js';
import { defineJobHandler, enqueueImmediate } from './jobs.js';

export interface RelayNumberReadyPayload {
  /** The connecting group to open (the D6 earmark that routed this job here). */
  conversationId: string;
  /** The now-registered, now-active dedicated pool number to assign. */
  poolNumber: string;
}

/**
 * Payload guard: BOTH fields are required (onNumberRegistered always emits both).
 * A missing/empty either throws - a poison payload the queue drops (no group to
 * open, no number to assign).
 */
export function parseRelayNumberReadyPayload(payload: unknown): RelayNumberReadyPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayNumberReady: payload is not an object');
  }
  const p = payload as Partial<RelayNumberReadyPayload>;
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) {
    throw new Error('relayNumberReady: missing conversationId');
  }
  if (typeof p.poolNumber !== 'string' || p.poolNumber.length === 0) {
    throw new Error('relayNumberReady: missing poolNumber');
  }
  return { conversationId: p.conversationId, poolNumber: p.poolNumber };
}

export interface RelayNumberReadyJobDeps {
  /** Injected in tests; lazily built from config on first job run otherwise. */
  poolNumbersService?: PoolNumbersService;
  conversationsRepo?: ConversationsRepo;
  logger?: Logger;
}

/**
 * Consumer side: register the relay.numberReady handler. Lazy-builds its service
 * + repo on first run (matching the other registrars). NO token bucket.
 */
export function registerRelayNumberReadyJobHandler(deps: RelayNumberReadyJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  let poolNumbers = deps.poolNumbersService;
  let conversations = deps.conversationsRepo;

  defineJobHandler(RELAY_NUMBER_READY_JOB, async (rawPayload) => {
    const { conversationId, poolNumber } = parseRelayNumberReadyPayload(rawPayload);
    poolNumbers ??= createPoolNumbersService({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });

    // G3 read-check: only a group STILL connecting is opened. A redelivered job
    // (group already open) / a closed or unknown conversation is an idempotent
    // no-op here - it never re-burns and never re-enqueues the intro.
    const conversation = await conversations.getById(conversationId);
    if (
      conversation === undefined ||
      conversation.type !== 'relay_group' ||
      conversation.status !== 'connecting'
    ) {
      log.info(
        { conversationId, event: 'relay_number_ready_noop' },
        'relay.numberReady: group not connecting (already opened, closed, or unknown) - no-op',
      );
      return;
    }

    // G1 burn on assign: claim the whole roster onto the now-active number. A
    // fresh dedicated number's burn is empty, so this cannot overlap-fail on a
    // genuine first assign; on a redelivery that raced past the read-check the
    // roster is already burned here (false) - benign, so we still proceed to the
    // idempotent assign below (never abort the open on a benign re-burn).
    const roster = (conversation.participants ?? [])
      .map((m) => m.phone)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (roster.length > 0) {
      const burned = await poolNumbers.burnGroupRoster(poolNumber, roster);
      if (!burned) {
        log.info(
          { conversationId, event: 'relay_number_ready_burn_noop' },
          'relay.numberReady: roster already burned on this number (redelivery) - continuing to assign',
        );
      }
    }

    // G3 assign: flip connecting -> open + stamp the number, CONDITIONAL on the
    // group still being connecting. undefined => a concurrent delivery already
    // opened it (past the read-check) - skip the intro so no member is intro'd
    // twice (exactly-once).
    const opened = await conversations.assignPoolNumberAndOpen(conversationId, poolNumber);
    if (opened === undefined) {
      log.info(
        { conversationId, event: 'relay_number_ready_assign_noop' },
        'relay.numberReady: group already opened by a concurrent delivery - intro not re-enqueued',
      );
      return;
    }

    // The group is now OPEN on its dedicated number - fire the DEFERRED intro (the
    // connecting provision path skipped it: there was no number to send from).
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: conversationId });

    // T7 SEAM (next slice): after the intro, flush any messages the composer
    // QUEUED (delivery_status 'queued_pending') while the group was connecting, in
    // created_at order, so they deliver right after the intro:
    //     await flushQueuedMessages(conversationId);
    // Deliberately NOT built here - left as a clear, ordered seam. The intro must
    // land first.

    log.info(
      { conversationId, event: 'relay_number_ready_opened' },
      'relay.numberReady: connecting group opened on its dedicated number, intro enqueued',
    );
  });
}
