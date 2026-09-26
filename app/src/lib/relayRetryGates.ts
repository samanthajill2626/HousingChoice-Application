// The relay 30003 retry ladder's four send gates, as ONE evaluator
// (retry-send-window spec D3).
//
// The retry JOB runs these gates right before it sends a rung
// (`jobs/relayRetryLeg.ts`). Since retry-send-window the status webhook's
// CLAIM previews the SAME gates before it creates a rung, so a rung the job
// would refuse is created already closed with that gate's code and the leg
// reads "Not retried - ..." at once instead of "Retrying" for 1 to 4 minutes.
// One function for both callers is what keeps them from drifting: the same
// checks, in the same order, naming the same code when two gates apply.
//
// The ORDER is the job's and it is load-bearing (the FIRST refusing gate names
// the code): group open -> member still on the roster -> destination number
// unchanged (digest compare) -> member not opted out.
//
// Reads NOTHING itself except through `isSuppressed`: the caller has already
// read the conversation and owns the suppression read (the job relies on it
// being the ONLY such read before its send - code review R2, W4). A rejection
// from `isSuppressed` propagates, so the caller fails CLOSED.
import type { ConversationItem, ConversationParticipant } from '../repos/conversationsRepo.js';
import { relayMemberKey } from '../repos/messagesRepo.js';
import { normalizeToE164 } from './phone.js';
import { relayRetryDigest } from './relayRetryClaim.js';

/** The four gate close codes. Each has operator copy in the dashboard's
 *  internal-code map ("Not retried - group closed" and its three siblings). */
export type RelayRetryGateCode =
  | 'retry_group_closed'
  | 'retry_member_removed'
  | 'retry_number_changed'
  | 'retry_opted_out';

export type RelayRetryGateResult =
  | { refused: false; conversation: ConversationItem; member: ConversationParticipant }
  | { refused: true; code: RelayRetryGateCode };

/** The relay retry job's four gates, in the job's order: group open, on the
 *  roster, number unchanged (digest compare), not opted out. Reads nothing
 *  itself except through `isSuppressed`. The job and the webhook claim both
 *  call it. */
export async function evaluateRelayRetryGates(args: {
  conversation: ConversationItem | undefined;
  memberKey: string;
  rootTsMsgId: string;
  destDigest: string;
  isSuppressed: (member: ConversationParticipant) => Promise<boolean>;
}): Promise<RelayRetryGateResult> {
  const { conversation, memberKey, rootTsMsgId, destDigest, isSuppressed } = args;
  // 1. Group open. The same authoritative check the fan-out uses: `status`,
  // not pool_number presence (a pool number is KEPT on close for
  // burn-multiplexing). An absent conversation is not open either, and the
  // four codes are a closed set - "group closed" is the truthful one of them.
  if (conversation === undefined || conversation.status !== 'open') {
    return { refused: true, code: 'retry_group_closed' };
  }
  // 2. Still on the roster, matched by the STORED member key.
  const member = (conversation.participants ?? []).find(
    (candidate) => relayMemberKey(candidate) === memberKey,
  );
  if (member === undefined) return { refused: true, code: 'retry_member_removed' };
  // 3. Destination unchanged. Compare DIGESTS, never the raw number: the
  // handset is not stored anywhere on the row, and a member whose phone
  // changed must never silently receive an old message at the new number. A
  // current number that cannot be normalized produces no matching digest, so
  // it refuses here too.
  const currentE164 = normalizeToE164(member.phone);
  if (currentE164 === undefined || relayRetryDigest(rootTsMsgId, currentE164) !== destDigest) {
    return { refused: true, code: 'retry_number_changed' };
  }
  // 4. Not opted out - the caller's read.
  if (await isSuppressed(member)) return { refused: true, code: 'retry_opted_out' };
  return { refused: false, conversation, member };
}
