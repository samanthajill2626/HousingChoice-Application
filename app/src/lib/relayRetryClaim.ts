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
 * field, extended by adjudication S2a to the outcomes that rule actually has to
 * describe and by code review R1 (F2) to one more. It lives HERE, in the pure
 * module, so the webhook (which claims) and the retry job (which closes) cannot
 * disagree about the name of an outcome, and so neither has to import the other.
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
  /**
   * The member slot is ABSENT, or it is neither delivered nor terminal after
   * this callback's own write. An internal ANOMALY of the `source_unreadable`
   * class - the pointer resolved, the leg really did end terminally on 30003,
   * and yet the row it must be recorded on is missing or is not in a state any
   * callback should have left it in. ERROR, with its own message.
   *
   * Split out of the old catch-all by code review R2 (W1): whitelisting the
   * whole outcome at WARN also silenced these two shapes, which is the same
   * class of mistake the whitelist was correcting, pointed the other way.
   */
  | 'slot_ineligible'
  /**
   * The slot EXISTS and its own end state is already settled: it reads
   * `delivered` (the reordering `ALLOWED_PRIOR` correctly refused), or it is
   * terminal on a code other than 30003 - which was logged at ITS own severity
   * when it landed. WARN: this leg did NOT end on 30003, so a later
   * contradictory 30003 is not a new dead end. Code review R2 (W1).
   */
  | 'slot_settled'
  | 'code_not_retryable'
  | 'enqueue_failed'
  /**
   * An internal fault WHILE claiming - the claim helper threw (a DynamoDB
   * throttle or timeout on the consistent read, the roster read behind the leg
   * copy, or the retry row's own `append`, which rethrows a condition failure).
   * ERROR, and it takes its own message: nothing about the CARRIER failed, so a
   * line reading like an unreachable handset would misattribute ours as theirs.
   * Added by code review R1 (F2), which is also what stops the throw skipping
   * the webhook tail's failure marker, SSE and placement escalation. The
   * captured error is then RETHROWN after that tail (code review R2, W2), so
   * the callback still 5xxs and Twilio's redelivery can re-claim under D8's
   * state gate - the recovery the catch alone would have traded away.
   */
  | 'claim_failed';
