import { createHash } from 'node:crypto';

/**
 * Pure identity helpers for the relay 30003 retry ladder (spec D3, D5, D6).
 *
 * Deliberately dependency-free - no repo, no adapter, no vendor SDK - so the
 * webhook that CLAIMS a rung and the job that SENDS it derive the same provider
 * SID from the same inputs, and so both are testable without DynamoDB.
 */

/** Total retry attempts for one failed relay leg - the 1:1 ladder's cap
 *  (`jobs/retrySend.ts:37`), spec D6. */
export const MAX_RELAY_RETRY_ATTEMPTS = 3;

/** 60s, 120s, 240s for attempts 1..3 (`retrySend.ts:39-42`). */
export function relayRetryBackoffMs(attempt: number): number {
  return 60_000 * 2 ** (attempt - 1);
}

/** The ladder's identity: root message + DESTINATION handset (D5 - the
 *  destination, not the member key, because one contactId on two numbers
 *  collapses into one member key). Hashed, never raw: this value ends up inside
 *  a sort key, where a phone number must never appear, and `splitTsMsgId`
 *  (`messagesRepo.ts:204-209`) splits on the FIRST '#'. */
export function relayRetryDigest(rootTsMsgId: string, destinationE164: string): string {
  return createHash('sha256')
    .update(`${rootTsMsgId}|${destinationE164}`)
    .digest('hex')
    .slice(0, 16);
}

/** The synthetic provider SID whose `sid#` pointer IS the atomic claim (D3). */
export function relayRetryProviderSid(digest: string, attempt: number): string {
  return `relayretry-${digest}-${attempt}`;
}

/**
 * Why no retry is running - the shared vocabulary of D23's `retryClaim` log
 * field, extended by adjudication S2a to the eleven outcomes that rule actually
 * has to describe. It lives HERE, in the pure module, so the webhook (which
 * claims) and the retry job (which closes) cannot disagree about the name of an
 * outcome, and so neither has to import the other.
 *
 * `claimed` and `already_claimed` mean a ladder is (or already was) running;
 * every other value is a decline or a terminal close.
 */
export type RelayRetryClaimOutcome =
  | 'claimed'
  | 'already_claimed'
  | 'cap_exhausted'
  | 'gate_refused'
  | 'fenced_announcement'
  | 'to_missing'
  | 'to_malformed'
  | 'source_unreadable'
  | 'slot_ineligible'
  | 'code_not_retryable'
  | 'enqueue_failed';
