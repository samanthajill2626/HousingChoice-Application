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

// ---------------------------------------------------------------------------
// The SYNCHRONOUS ensure seam (S5/T5.2 send-time backstop + S7 migration)
// ---------------------------------------------------------------------------
//
// S7 declared this seam inside `lib/import/convertGroups.ts` because the
// migration was its first consumer. The send path is the second, and a service
// reaching into the import subsystem for a rail type is the wrong direction, so
// the declarations moved HERE - beside the enqueue seam they are the sibling of
// - and convertGroups re-exports them unchanged. Same names, same shapes, same
// default: nothing about the migration contract changed.

export interface GroupRailRequest {
  conversationId: string;
  /** The roster the rail must contain. */
  members: ConversationParticipant[];
}

export interface GroupRailResult {
  /**
   * `created` - a new Conversations rail now backs this thread.
   * `existing` - a rail was already attached and its participant map verified.
   * `failed` - the rail could not be established; `reason` says why (this is
   *   where a 50407-class Twilio refusal surfaces).
   * `unavailable` - no rail service is wired into this run at all. Distinct
   *   from `failed`: nothing was attempted, so the run is INCOMPLETE rather
   *   than broken.
   */
  status: 'created' | 'existing' | 'failed' | 'unavailable';
  twilioConversationSid?: string;
  reason?: string;
  /** The MBxx -> member key map of the ensured rail, when one is available. */
  participantMap?: Record<string, string>;
}

/**
 * THE INJECTION POINT S6 BINDS TO. `ensureGroupRail` is the one authoritative
 * rail path (spec 15.3); its consumers never talk to Twilio and never touch an
 * adapter. T6.6(b)/(c) pass an adapter over the real service.
 *
 * It is called SYNCHRONOUSLY and must be idempotent: the migration calls it for
 * every expected id on every run, including ones converted long ago, and the
 * send path calls it whenever a thread turns out to be rail-less. It must not
 * throw for an ordinary rail failure (return `failed` with a reason); callers
 * catch a thrown error and treat it as `failed` anyway, so a bad row can never
 * abort the migration of the other 131 or crash a send with a stack trace.
 */
export interface GroupRailEnsurer {
  ensureGroupRail(request: GroupRailRequest): Promise<GroupRailResult>;
}

/**
 * The default until S6 lands: records the gap instead of pretending the step
 * succeeded. A migration run under this ensurer is deliberately INCOMPLETE, and
 * a send through it is refused rather than posted into a rail that is not there.
 */
export const RAIL_STEP_NOT_WIRED: GroupRailEnsurer = {
  async ensureGroupRail() {
    return { status: 'unavailable', reason: 'rail step not wired yet (S6 task T6.6(c))' };
  },
};
