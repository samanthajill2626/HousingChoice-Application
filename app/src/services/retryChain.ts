// retry-send-adoption: the one-to-one 30003 retry CHAIN helpers - pure reads
// over the lineage every retry row carries at append (retry_of, retry_attempt,
// and since this branch retry_root). Spec section 0 names two rows: the
// RETRIED ROW (the one a retry job names by SID, whose promise it keeps) and
// the ROOT (the chain's first send). The retry job, the reconcile's
// retry_send owner and the manual Retry route read the chain through these
// functions, so the walk, the recipient key and the retryable-thread rule have
// one copy each.
//
// Every read is a strongly consistent point-get on the base table (D11): a
// lineage walk that lags a just-appended row would name the wrong root or
// miss a predecessor.
import { MAX_SEND_RETRY_ATTEMPTS } from '../lib/retrySendWindow.js';
import type { ConversationItem } from '../repos/conversationsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';

/** The one read the walks need: messagesRepo's consistent point-get. */
export interface LineageReader {
  getByTsMsgIdConsistent(conversationId: string, tsMsgId: string): Promise<MessageItem | undefined>;
}

/**
 * FW3 (planner re-review R4): the bound of resolveRetryRoot's LEGACY walk ONLY - automaticAncestry keeps
 * MAX_SEND_RETRY_ATTEMPTS (it walks automatic rows only). A manual Retry extends a chain past three rows: three
 * manual retries each carrying a full three-rung automatic ladder are 3 x (1 + 3) = 12 rows, which a walk up from
 * the deepest of them crosses within 12 hops (a root's own ladder above the first manual retry adds up to three
 * more rows). Every row appended since retry-send-adoption carries retry_root and returns at hop 0, so only
 * pre-deploy rows pay the reads - and a wrong root would be written once and inherited by every later row of the
 * chain.
 */
export const RETRY_ROOT_WALK_MAX_HOPS = 12;

/** Spec section 0: the chain ROOT of `row` - its retry_root when it carries one; a row with no retry_of is its own root; a pre-deploy retry row is walked up retry_of (consistent reads, at most RETRY_ROOT_WALK_MAX_HOPS hops); a broken link or the bound stops at the last row read. */
export async function resolveRetryRoot(messages: LineageReader, row: MessageItem): Promise<string> {
  let current = row;
  for (let hop = 0; hop < RETRY_ROOT_WALK_MAX_HOPS; hop += 1) {
    if (typeof current.retry_root === 'string' && current.retry_root.length > 0) return current.retry_root;
    if (typeof current.retry_of !== 'string' || current.retry_of.length === 0) return current.tsMsgId;
    const parent = await messages.getByTsMsgIdConsistent(row.conversationId, current.retry_of);
    if (parent === undefined) return current.tsMsgId;
    current = parent;
  }
  return current.tsMsgId;
}

/** R4: the AUTOMATIC predecessors' rows - the walk from `retriedRow` up retry_of while each row carries retry_attempt; it stops at the first row without one (the root, or a manual row) and at a broken link. `retriedRow` itself is first when it is automatic. */
export async function automaticAncestry(messages: LineageReader, retriedRow: MessageItem): Promise<MessageItem[]> {
  const walked: MessageItem[] = [];
  let current: MessageItem | undefined = retriedRow;
  for (let hop = 0; hop < MAX_SEND_RETRY_ATTEMPTS && current !== undefined; hop += 1) {
    if (typeof current.retry_attempt !== 'number' || typeof current.retry_of !== 'string' || current.retry_of.length === 0) break;
    walked.push(current);
    current = await messages.getByTsMsgIdConsistent(retriedRow.conversationId, current.retry_of);
  }
  return walked;
}

/** R1: the recipient key of a retry attempt, from IMMUTABLE data - the retried row's recorded recipient, else the thread's number. Undefined when neither exists (the attempt is unaddressable). */
export function retryRecipientKey(
  row: Pick<MessageItem, 'recipient_contact_id'>,
  conversation: Pick<ConversationItem, 'participant_phone'> | undefined,
): string | undefined {
  if (typeof row.recipient_contact_id === 'string' && row.recipient_contact_id.length > 0) return row.recipient_contact_id;
  const phone = conversation?.participant_phone;
  return typeof phone === 'string' && phone.length > 0 ? `phone#${phone}` : undefined;
}

/** The webhook decision's own decline vocabulary (services/oneToOneRetryDecision.ts). */
export type ConversationRetryDecline = 'conversation_missing' | 'group_text' | 'not_one_to_one';

/** R2 step 3: a DESIGNED decline, in the webhook decision's own vocabulary and with its own reading (services/oneToOneRetryDecision.ts:90-97: a group text is `group_text`; a relay group or a phone-less thread is `not_one_to_one`) - never a throw. */
export function conversationRetryDecline(
  conversation: Pick<ConversationItem, 'type' | 'participant_phone'> | undefined,
): ConversationRetryDecline | undefined {
  if (conversation === undefined) return 'conversation_missing';
  if (conversation.type === 'group_text') return 'group_text';
  if (
    conversation.type === 'relay_group' ||
    typeof conversation.participant_phone !== 'string' ||
    conversation.participant_phone.length === 0
  ) {
    return 'not_one_to_one';
  }
  return undefined;
}
