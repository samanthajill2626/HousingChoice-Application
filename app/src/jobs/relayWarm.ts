// relay.warmNumber (relay number buying strategy T4) - buy ONE pool number and
// park it WARMING until Twilio's A2P registration event promotes it.
//
// Producers: refillBufferIfNeeded (one per missing spare) and the connect-when-
// ready path (T6, tagged with a conversationId). This handler dispatches straight
// to poolNumbersService.warmOneNumber(conversationId, postalCode).
//
// NOT a token-bucket job: warming is an SDK provision + messaging-service attach
// (a purchase, not an outbound SMS), so it draws NO token from the shared A2P
// bucket the send handlers share. Registered in registerHandlers.ts (the single
// source of truth for both worker.ts and the app's in-process path).
//
// PII (doc section 9): the payload carries only a conversationId (an internal id)
// and an optional property ZIP search hint - never a phone number, and neither
// value is ever logged (warmOneNumber logs the hint TYPE only).
//
// AT REST, though, the payload IS the SQS message body: the ZIP persists in the
// jobs queue for the life of the message and, if the job exhausts maxReceiveCount,
// for up to 14 days in the jobs DLQ (infra/modules/jobs/main.tf), where operators
// read bodies in the console. ACCEPTED exposure - a property ZIP is coarse
// business data about a UNIT, not a person, and the pairing with a conversationId
// is no more locating than the unit record itself. Named here so the surface is
// stated rather than implied absent by the logging sentence above.
import type { Logger } from '../lib/logger.js';
import {
  createPoolNumbersService,
  RELAY_WARM_JOB,
  type PoolNumbersService,
} from '../services/poolNumbers.js';
import { defineJobHandler } from './jobs.js';

export interface RelayWarmPayload {
  /**
   * The connecting group awaiting this number (connect-when-ready, T6). When
   * present it is threaded to warmOneNumber -> createWarming as the
   * pending_conversation_id earmark, so the promotion routes back to that group.
   * Absent for a plain buffer refill (an untagged spare).
   */
  conversationId?: string;
  /**
   * Property ZIP hint for the buy (area-code preference): tier-3 buys for a
   * tour/placement group prefer numbers local to the unit. Absent for buffer
   * refills and standalone groups (Atlanta-default ladder). Riding the payload
   * keeps the hint across job retries.
   */
  postalCode?: string;
}

/**
 * Hand-rolled payload guard (mirrors parseRelayFanOutPayload): a refill enqueues
 * {}, so a missing / empty / non-string conversationId is tolerated and simply
 * omitted; only a non-empty string surfaces as the earmark. postalCode gets the
 * same tolerance - an absent/blank/non-string hint simply means no hint (the
 * ladder falls back to the preferred area codes), never a failed job.
 */
export function parseRelayWarmPayload(payload: unknown): RelayWarmPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayWarm: payload is not an object');
  }
  const p = payload as Partial<RelayWarmPayload>;
  const conversationId =
    typeof p.conversationId === 'string' && p.conversationId.length > 0
      ? p.conversationId
      : undefined;
  const postalCode =
    typeof p.postalCode === 'string' && p.postalCode.length > 0 ? p.postalCode : undefined;
  return {
    ...(conversationId !== undefined && { conversationId }),
    ...(postalCode !== undefined && { postalCode }),
  };
}

export interface RelayWarmJobDeps {
  /** Injected in tests; lazily built from config on first job run otherwise. */
  poolNumbersService?: PoolNumbersService;
  logger?: Logger;
}

/**
 * Consumer side: register the relay.warmNumber handler. Lazy-builds the
 * poolNumbersService on first run (config + adapter + repos are touched only
 * then), matching the other registrars. NO token bucket (see the file header).
 */
export function registerRelayWarmJobHandler(deps: RelayWarmJobDeps = {}): void {
  let poolNumbers = deps.poolNumbersService;

  defineJobHandler(RELAY_WARM_JOB, async (rawPayload) => {
    const payload = parseRelayWarmPayload(rawPayload);
    poolNumbers ??= createPoolNumbersService({ logger: deps.logger });
    await poolNumbers.warmOneNumber(payload.conversationId, payload.postalCode);
  });
}
