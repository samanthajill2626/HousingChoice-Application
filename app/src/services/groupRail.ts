// The group-text RAIL seam (native group texting, spec 6.1 DETECTION).
//
// A `group_text` thread is backed by a Twilio Conversations "rail" - a
// Conversation whose participants are the roster's handsets - which is how the
// app SENDS into a carrier group. Detection creates that rail ASYNCHRONOUSLY:
// the webhook has a 5s budget and the rail only has to exist before a human
// could plausibly reply, so ingestion ENQUEUES rather than calling Twilio.
//
// THIS SLICE DEFINES THE SEAM ONLY. Slice S6 builds `ensureGroupRail` (the job
// and the Conversations adapter) and wires the real enqueue in T6.6(a)/(d). The
// default below records `unavailable` - "nothing was attempted" - which is
// deliberately DISTINCT from `failed`, exactly as the migration runner's
// `GroupRailEnsurer` (lib/import/convertGroups.ts) distinguishes them. This
// module makes no Twilio call and imports no vendor SDK.
//
// Spec 15.3: ANY group inbound filed onto a thread with no active rail
// (re-)enqueues this seam. It is idempotent by contract, which is what closes
// the create-then-crash-before-enqueue window.
import type { ConversationItem, ConversationParticipant } from '../repos/conversationsRepo.js';

export interface GroupRailEnqueueRequest {
  conversationId: string;
  /** The roster the rail must contain. */
  members: ConversationParticipant[];
  /**
   * `created` - the group thread was just minted by this inbound.
   * `rail_missing` - an existing thread was found with no active rail; this is
   *   the crash-window heal, and it repeats on every inbound until a rail lands.
   */
  reason: 'created' | 'rail_missing';
}

export interface GroupRailEnqueueResult {
  /**
   * `enqueued` - a rail job is now queued for this thread.
   * `failed` - the enqueue itself was refused/threw; `reason` says why.
   * `unavailable` - no rail service is wired into this process at all. Nothing
   *   was attempted, so the thread is rail-less by OMISSION, not by breakage.
   */
  status: 'enqueued' | 'failed' | 'unavailable';
  jobId?: string;
  reason?: string;
}

export interface GroupRailEnqueuer {
  enqueueGroupRail(request: GroupRailEnqueueRequest): Promise<GroupRailEnqueueResult>;
}

/** The S3 default. S6/T6.6(a) replaces it with the real `jobs.enqueue()` call. */
export const GROUP_RAIL_ENQUEUE_NOT_WIRED: GroupRailEnqueuer = {
  async enqueueGroupRail() {
    return { status: 'unavailable', reason: 'group rail job not wired yet (S6 task T6.6(a)/(d))' };
  },
};

/**
 * Does this thread already have an ACTIVE rail? The rail is active once
 * `twilio_conversation_sid` is stamped (conversationsRepo.setTwilioConversation,
 * the fenced finalize). An in-flight `rail_creating` claim is NOT active - it
 * may belong to a claimant that has since died, and the enqueue is idempotent.
 */
export function hasActiveGroupRail(item: Pick<ConversationItem, 'twilio_conversation_sid'>): boolean {
  return (
    typeof item.twilio_conversation_sid === 'string' && item.twilio_conversation_sid.length > 0
  );
}
