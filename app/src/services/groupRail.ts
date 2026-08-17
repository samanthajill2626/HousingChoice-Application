// The group-text RAIL seam (native group texting, spec 6.1 DETECTION).
//
// A `group_text` thread is backed by a Twilio Conversations "rail" - a
// Conversation whose participants are the roster's handsets - which is how the
// app SENDS into a carrier group. Detection creates that rail ASYNCHRONOUSLY:
// the webhook has a 5s budget and the rail only has to exist before a human
// could plausibly reply, so ingestion ENQUEUES rather than calling Twilio.
//
// S3 defined the SEAMS here; S6 (below the seam declarations) implements
// `createGroupRailService` - the ONE authoritative `ensureGroupRail`. The
// `unavailable` defaults are kept because they still describe a process with no
// rail service wired ("nothing was attempted"), which is deliberately DISTINCT
// from `failed`, exactly as the migration runner distinguishes them.
//
// Spec 15.3: ANY group inbound filed onto a thread with no active rail
// (re-)enqueues this seam. It is idempotent by contract, which is what closes
// the create-then-crash-before-enqueue window.
import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../lib/config.js';
// A raw Twilio SDK failure is an AxiosError carrying the request config - the
// Authorization header and the whole roster in `data`. Every catch in this file
// logs the SUMMARY, never the error object (fix wave 5, adversarial 4).
import { summarizeError } from '../lib/errors.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createGroupConversationsAdapter,
  MAX_RAIL_PARTICIPANTS,
  type GroupConversationRef,
  type GroupConversationsPort,
  type GroupParticipantRef,
} from '../adapters/groupConversations.js';
import { groupMemberKey } from './groupMembers.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';

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

/**
 * Was this rail VERIFIED to carry `businessNumber` as its projected-address
 * participant - i.e. can a post authored as that number succeed? False for a
 * rail finalized before the author was recorded (every rail before 2026-08-17)
 * and for a rail verified under a previous BUSINESS_PHONE_NUMBER. Either way
 * the rail is not trusted: `ensureGroupRail` re-reads Twilio and repairs, and
 * `groupSend` routes through it before posting (prod incident 2026-08-17: 135
 * stamped rails could not be posted to, and every staff reply failed 50513).
 */
export function railAuthorVerified(
  item: Pick<ConversationItem, 'twilio_projected_address'>,
  businessNumber: string | undefined,
): boolean {
  return (
    businessNumber !== undefined &&
    businessNumber.length > 0 &&
    item.twilio_projected_address === businessNumber
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

// ---------------------------------------------------------------------------
// T6.1 - THE implementation of ensureGroupRail
// ---------------------------------------------------------------------------
//
// One rail, three callers (detection's async job, the migration bulk runner,
// the send-time backstop), and NOTHING calls the adapter's create directly.
// What makes that safe is a four-part protocol, all of it visible below:
//
//  1. CLAIM BEFORE TWILIO. `rail_creating` carries an owner TOKEN + timestamp
//     and is taken with a conditional write. A concurrent caller loses the
//     condition, re-reads, and either adopts the winner's rail or reports that a
//     creation is in flight - it never talks to Twilio.
//  2. RE-CLAIMABLE EXPIRY. A claim older than RAIL_CLAIM_EXPIRY_MS is free
//     again, so a claimant that died mid-flight cannot strand a thread
//     rail-less against the hardened cutover gate (spec 14).
//  3. FENCED FINALIZE. setTwilioConversation only lands while we still own the
//     token, so the resurrected claimant of (2) loses rather than overwriting
//     the live rail. The expiry is a liveness heuristic; the fence is the
//     correctness mechanism.
//  4. DETERMINISTIC UNIQUENAME. `UniqueName` is our conversationId, so a crash
//     between the Twilio create and the local persist is healed by
//     fetch-by-UniqueName: the retry ADOPTS the very conversation the dead
//     attempt made instead of minting a second one.
//
// Nothing here throws for an ordinary failure. A rail failure is a REPORT
// (`{status:'failed', reason}`) plus a `rail_failed` record, because a thread
// that cannot get a rail is inbound-only, not broken - and one bad row must
// never abort the migration of the other 131.

/** How long a `rail_creating` claim is honored before it is re-claimable. */
export const RAIL_CLAIM_EXPIRY_MS = 5 * 60 * 1000;

/**
 * The outside-member cap. The rail holds MAX_RAIL_PARTICIPANTS (10) and our
 * projected address consumes one of them, so a roster above this is refused
 * BEFORE any Twilio call - the same bound the composer and groupSend enforce.
 */
export const MAX_RAIL_MEMBERS = MAX_RAIL_PARTICIPANTS - 1;

export interface GroupRailServiceDeps {
  conversationsRepo?: Pick<
    ConversationsRepo,
    'getById' | 'claimRailCreation' | 'setTwilioConversation' | 'recordRailFailure'
  >;
  groupConversations?: GroupConversationsPort;
  config?: AppConfig;
  logger?: Logger;
  /** The rail's projected address. Defaults to config.businessPhoneNumber. */
  businessNumber?: string;
  now?: () => Date;
  /** Owner-token minter (seam so a test can pin the token). */
  newToken?: () => string;
  claimExpiryMs?: number;
}

/** MBxx -> member key (`phone#<E164>`), the map late receipts are joined on. */
function buildParticipantMap(participants: GroupParticipantRef[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const participant of participants) {
    if (participant.address === undefined || participant.address.length === 0) continue;
    map[participant.participantSid] = groupMemberKey(participant.address);
  }
  return map;
}

/** Roster phones the rail's map does not cover. */
/**
 * The stored `rail_failed.reason` for a thrown vendor error.
 *
 * NEVER `err.message` (fix wave 2, adversarial 10). This string is PERSISTED on
 * the conversation row and surfaced to staff, and this project's own written
 * ruling (jobs/groupRail.ts) is that these strings can name members: Twilio's
 * address/validation family echoes the offending parameter into its message
 * ("The 'To' number +1555... is not a valid phone number"). The summary carries
 * a name, a numeric vendor code and a status - enough to diagnose, nothing a
 * vendor authors.
 */
function railFailureReason(err: unknown): string {
  const summary = summarizeError(err);
  const parts = [summary.name];
  if (summary.code !== undefined) parts.push(`code ${summary.code}`);
  if (summary.status !== undefined) parts.push(`status ${summary.status}`);
  return parts.join(', ');
}

/**
 * A Conversation state that can carry no further traffic. `closed` is Twilio's
 * terminal state (its auto-close timer, or an operator in the console);
 * `failed` is the create that never came up. Anything else - including
 * `initializing` and `inactive` - is a rail that still works or is about to.
 */
function isDeadRailState(state: string | undefined): boolean {
  const value = state ?? 'active';
  return value === 'closed' || value === 'failed';
}

function missingFromMap(members: ConversationParticipant[], map: Record<string, string>): string[] {
  const covered = new Set(Object.values(map));
  return members.filter((m) => !covered.has(groupMemberKey(m.phone))).map((m) => m.phone);
}

export function createGroupRailService(deps: GroupRailServiceDeps = {}): GroupRailEnsurer {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config;
  const conversations =
    deps.conversationsRepo ??
    createConversationsRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const port =
    deps.groupConversations ??
    createGroupConversationsAdapter({
      ...(config !== undefined && { config }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  const now = deps.now ?? ((): Date => new Date());
  const newToken = deps.newToken ?? ((): string => randomUUID());
  const claimExpiryMs = deps.claimExpiryMs ?? RAIL_CLAIM_EXPIRY_MS;

  function businessNumber(): string | undefined {
    if (deps.businessNumber !== undefined) return deps.businessNumber;
    return (config ?? loadConfig()).businessPhoneNumber;
  }

  return {
    async ensureGroupRail(request) {
      const { conversationId } = request;
      const thread = await conversations.getById(conversationId);
      if (thread === undefined) {
        return { status: 'failed', reason: `conversation ${conversationId} does not exist` };
      }
      // The ROW's roster is authoritative over the caller's copy: the migration
      // hands us the post-conversion members, detection hands us what it just
      // wrote, and a send hands us what it read - all the same row, but the row
      // is the one that cannot be stale.
      const members = thread.participants ?? request.members;

      // AN EMPTY ROSTER IS REFUSED LOUDLY (fix wave 5, adversarial 19). There
      // was an upper bound and no lower one, and every rail validation is
      // VACUOUS on the empty set: `missingFromMap([], anything)` is `[]`, so an
      // empty roster sailed through, `setTwilioConversation` stamped a sid with
      // an empty participant map, and `hasActiveGroupRail` then reported `true`
      // for a rail that can reach NOBODY - which suppresses the `rail_missing`
      // re-enqueue that would otherwise heal it. A group thread with no members
      // is a data fault, not a rail to build.
      if (members.length === 0) {
        const reason = 'group thread has an EMPTY roster - a rail would be able to reach nobody';
        log.error({ event: 'group_rail_roster_empty', conversationId }, reason);
        return { status: 'failed', reason };
      }

      // The ONE author every post uses. Resolved before the fast path because a
      // rail is only "existing" for the number it was verified to carry.
      const author = businessNumber();

      // Already railed AND verifiable: no claim, no Twilio call. This is the
      // overwhelmingly common case on a migration re-run.
      if (hasActiveGroupRail(thread)) {
        const stored = thread.twilio_participant_map ?? {};
        const missing = missingFromMap(members, stored);
        if (missing.length === 0 && railAuthorVerified(thread, author)) {
          return {
            status: 'existing',
            twilioConversationSid: thread.twilio_conversation_sid as string,
            participantMap: stored,
          };
        }
        // A rail whose stored map does not cover the roster, OR whose author was
        // never verified for the CURRENT business number: fall through to the
        // claimed path, which re-reads participants from Twilio, repairs, and
        // re-finalizes the SAME conversation (adopt-by-UniqueName finds it).
        if (missing.length > 0) {
          log.warn(
            { event: 'group_rail_map_incomplete', conversationId, missing: missing.length },
            'group rail participant map does not cover the roster - refreshing from Twilio',
          );
        } else {
          log.info(
            { event: 'group_rail_author_unverified', conversationId },
            'group rail is not verified for the current business number - verifying against Twilio',
          );
        }
      }

      if (members.length > MAX_RAIL_MEMBERS) {
        // Structural, permanent, and knowable without spending a Twilio call.
        const reason = `roster of ${members.length} exceeds the ${MAX_RAIL_MEMBERS} members a rail can hold`;
        log.warn({ event: 'group_rail_roster_too_large', conversationId }, reason);
        return { status: 'failed', reason };
      }

      if (author === undefined || author.length === 0) {
        return {
          status: 'failed',
          reason: 'BUSINESS_PHONE_NUMBER is not configured, so a rail has no projected address',
        };
      }

      const token = newToken();
      const at = now().toISOString();
      const expiredBefore = new Date(now().getTime() - claimExpiryMs).toISOString();
      const claim = await conversations.claimRailCreation(
        conversationId,
        { token, at },
        expiredBefore,
      );
      if (!claim.claimed) {
        const fresh = claim.item;
        if (fresh !== undefined && hasActiveGroupRail(fresh)) {
          return {
            status: 'existing',
            twilioConversationSid: fresh.twilio_conversation_sid as string,
            participantMap: fresh.twilio_participant_map ?? {},
          };
        }
        // Someone else holds a LIVE claim. Reporting `failed` is honest: this run
        // did not establish a rail, so a migration re-run is owed. The claim
        // expires, so a retry can never be blocked forever.
        return { status: 'failed', reason: 'another rail creation is already in flight' };
      }

      let ref: GroupConversationRef;
      let participants: GroupParticipantRef[] | undefined;
      /**
       * Did the create path attach the business number? The bulk create is
       * all-or-nothing, so a bulk success carries it; the individual-add
       * fallback reports a refused business add in `failures` under the business
       * address - which was never read (prod incident 2026-08-17: 132 rails
       * shipped without their author). An adoptee is checked against Twilio's
       * participant list below instead.
       */
      let authorRefusedOnCreate = false;
      /** Adopted rails are verified against Twilio's participant list, not trusted. */
      let wasAdopted = false;
      try {
        // ADOPT-OR-CREATE. The adopt half runs FIRST: a 404 here is `undefined`
        // while an auth failure or a 5xx re-throws (adapter contract), so an
        // outage can never read as "no rail exists" and start a duplicate storm.
        let adopted = await port.fetchByUniqueName(conversationId);

        // A DEAD ADOPTEE IS DELETED, NOT ADOPTED (fix wave 4, H1). This is the
        // heal the whole closed-rail recovery rests on, and without it the
        // recovery was a loop: a Conversation that CLOSES keeps its UniqueName,
        // our UniqueName is the conversationId, so `groupSend`'s healRail
        // cleared the stored sid, called back in here, adopted the very same
        // closed Conversation, fell into the state check below and recorded
        // `rail_failed` - every time, forever. The thread was permanently
        // inbound-only and the ONLY escape was a 20404, i.e. an operator
        // deleting the Conversation by hand in the Twilio console.
        //
        // WHY DELETE-AND-RECREATE rather than a generation-suffixed UniqueName
        // (`<conversationId>#2`): the UniqueName being DETERMINISTIC is what
        // heals a crash between the Twilio create and the local persist - the
        // retry adopts the conversation the dead attempt made instead of minting
        // a second one (protocol note 4 above). A generation suffix needs a
        // durable counter to stay deterministic, and a counter written outside
        // the claim re-opens exactly the duplicate-rail window the UniqueName
        // closes. Deleting is safe precisely because the resource is CLOSED: it
        // can carry no further traffic, and it holds no history we need - every
        // message, receipt and roster fact lives in our own table under our own
        // conversationId. We are reclaiming a name, not discarding data.
        //
        // It runs UNDER THE CLAIM, so no concurrent ensure can delete a rail
        // another claimant is mid-create on, and a delete that fails for any
        // reason other than "already gone" throws into the catch below and is
        // recorded as a rail failure rather than being followed by a create that
        // would collide on the UniqueName.
        if (adopted !== undefined && isDeadRailState(adopted.state)) {
          log.warn(
            {
              event: 'group_rail_dead_adoptee_deleted',
              conversationId,
              conversationSid: adopted.conversationSid,
              state: adopted.state,
            },
            'the Conversation holding this rail UniqueName is closed - deleting it so a fresh rail can take the name',
          );
          // A crash between this delete and the create below is recoverable
          // (the deterministic UniqueName means the retry simply creates), but
          // the thread stays unsendable until the dead claimant's rail_creating
          // claim expires - up to RAIL_CLAIM_EXPIRY_MS (~5 min). Bounded and
          // strictly better than the permanent refusal it replaced.
          await port.removeConversation(adopted.conversationSid);
          adopted = undefined;
        }

        if (adopted !== undefined) {
          ref = adopted;
          wasAdopted = true;
        } else {
          const created = await port.createConversationWithParticipants({
            uniqueName: conversationId,
            businessNumber: author,
            members: members.map((m) => m.phone),
          });
          ref = created.conversation;
          participants = created.participants;
          authorRefusedOnCreate = created.failures.some((f) => f.address === author);
        }
      } catch (err) {
        const reason = railFailureReason(err);
        log.warn(
          { err: summarizeError(err), event: 'group_rail_ensure_failed', conversationId },
          'group rail creation failed - the thread stays inbound-only',
        );
        await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
        return { status: 'failed', reason };
      }

      // A conversation that failed or closed during attach is rail-FAILED, not a
      // rail. Posting into a closed conversation is a silent no-delivery.
      //
      // Only a FRESHLY CREATED conversation can reach this now: a dead ADOPTEE
      // was deleted and recreated above. A create that comes back closed is
      // pathological (a service-level timer set to zero, say), so it stays a
      // recorded failure - deleting and re-creating that in a loop would just
      // spend Twilio calls on a condition no retry can fix.
      const state = ref.state ?? 'active';
      if (isDeadRailState(state)) {
        const reason = `Conversation ${ref.conversationSid} is ${state}`;
        log.warn({ event: 'group_rail_ensure_failed', conversationId, state }, reason);
        await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
        return { status: 'failed', reason };
      }

      try {
        participants ??= await port.fetchParticipants(ref.conversationSid);
      } catch (err) {
        const reason = railFailureReason(err);
        log.warn(
          { err: summarizeError(err), event: 'group_rail_ensure_failed', conversationId },
          'group rail participant read failed - the thread stays inbound-only',
        );
        await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
        return { status: 'failed', reason };
      }

      // VALIDATE BEFORE COMPOSE IS ENABLED (spec 6.1). A map that does not cover
      // the roster would send to a subset while the UI showed the whole group,
      // and every receipt for the missing member would be unattributable.
      let participantMap = buildParticipantMap(participants);
      let missing = missingFromMap(members, participantMap);

      // REPAIR, DO NOT RE-FAIL. The individual-add fallback can attach 8 of 9
      // when one add throws (a 429 or a 5xx). Before `addParticipants` existed
      // that thread was stranded PERMANENTLY: every retry adopted the same
      // Conversation by UniqueName, re-read the same incomplete list, and
      // recorded `rail_failed` again - against a cutover gate (spec 14) that
      // requires ZERO unresolved rail failures over 132 real threads, with no
      // in-app remedy at all. A retry now attaches exactly the members the rail
      // is short and re-reads the truth from Twilio.
      if (missing.length > 0) {
        log.warn(
          { event: 'group_rail_participants_incomplete', conversationId, missing: missing.length },
          'group rail is short of its roster - attaching the missing members',
        );
        try {
          const failures = await port.addParticipants(ref.conversationSid, missing);
          if (failures.length > 0) {
            log.warn(
              {
                event: 'group_rail_repair_partial',
                conversationId,
                refused: failures.length,
                errorCodes: [...new Set(failures.map((f) => f.errorCode ?? 'unknown'))],
              },
              'Twilio refused some of the members this rail was short',
            );
          }
          // The re-read is authoritative: an add can "succeed" and still leave
          // a shape Twilio will not bind, and a repair that trusted its own
          // return value would store a map that does not describe the rail.
          participants = await port.fetchParticipants(ref.conversationSid);
          participantMap = buildParticipantMap(participants);
          missing = missingFromMap(members, participantMap);
        } catch (err) {
          const reason = railFailureReason(err);
          log.warn(
            { err: summarizeError(err), event: 'group_rail_ensure_failed', conversationId },
            'group rail participant repair failed - the thread stays inbound-only',
          );
          await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
          return { status: 'failed', reason };
        }
      }

      if (missing.length > 0) {
        const reason = `rail participants do not cover the roster: ${missing.join(', ')}`;
        log.warn(
          { event: 'group_rail_mb_map_mismatch', conversationId, missing: missing.length },
          'group rail participant map does not cover the roster even after a repair attempt - recorded rail-failed',
        );
        await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
        return { status: 'failed', reason };
      }

      // VERIFY THE AUTHOR BEFORE FINALIZE (prod incident 2026-08-17). Roster
      // coverage says the rail can REACH everyone; it says nothing about whether
      // WE can post into it. A post is authored as the business number, and
      // Twilio accepts it only if that exact number is a projected-address
      // participant of the rail (else 50513). Two live failure shapes:
      //   - the participant is ABSENT (the individual-add fallback's business
      //     add was refused; or a read-back that never included it) - attach it;
      //   - it names a PREVIOUS business number (BUSINESS_PHONE_NUMBER changed
      //     under the rail) - drop the stale one, attach the current one.
      // A refused attach is a recorded rail failure, exactly like a refused
      // member: the next ensure re-adopts and retries, and nothing is stamped
      // that cannot be posted to. The bulk-create path is trusted for the
      // participant it was asked to create (all-or-nothing) and only checked
      // against the read-back when that read-back happens to include it - the
      // async binding propagation that makes fresh reads roster-incomplete
      // (rail-binding-propagation-retry) applies to the projected one too.
      const projectedParticipants = participants.filter(
        (p) => p.projectedAddress !== undefined && p.projectedAddress.length > 0,
      );
      const staleAuthors = projectedParticipants.filter((p) => p.projectedAddress !== author);
      const authorPresent =
        !authorRefusedOnCreate &&
        (!wasAdopted || projectedParticipants.some((p) => p.projectedAddress === author));
      if (staleAuthors.length > 0 || !authorPresent) {
        log.warn(
          {
            event: 'group_rail_author_repair',
            conversationId,
            conversationSid: ref.conversationSid,
            stale: staleAuthors.length,
            missing: !authorPresent,
          },
          'group rail does not carry the current business number as its projected-address participant - repairing',
        );
        try {
          for (const stale of staleAuthors) {
            await port.removeParticipant(ref.conversationSid, stale.participantSid);
          }
          if (!authorPresent) {
            const attached = await port.addProjectedParticipant(ref.conversationSid, author);
            if (attached.projectedAddress !== author) {
              throw new Error(
                `rail author attach returned participant ${attached.participantSid} without the projected address`,
              );
            }
          }
        } catch (err) {
          const reason = `rail has no participant for the business number: ${railFailureReason(err)}`;
          log.warn(
            { err: summarizeError(err), event: 'group_rail_ensure_failed', conversationId },
            'group rail author repair failed - the thread stays inbound-only',
          );
          await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
          return { status: 'failed', reason };
        }
      }

      const finalized = await conversations.setTwilioConversation(
        conversationId,
        ref.conversationSid,
        participantMap,
        token,
        author,
      );
      if (finalized === undefined) {
        // We lost the fence. Because UniqueName is deterministic, the winner's
        // rail IS this same conversation - there is no orphan to clean up, and
        // the winner's stored map is the live one.
        const fresh = await conversations.getById(conversationId);
        if (fresh !== undefined && hasActiveGroupRail(fresh)) {
          return {
            status: 'existing',
            twilioConversationSid: fresh.twilio_conversation_sid as string,
            participantMap: fresh.twilio_participant_map ?? {},
          };
        }
        return { status: 'failed', reason: 'rail finalize lost its claim and no rail is stored' };
      }

      log.info(
        { event: 'group_rail_created', conversationId, memberCount: members.length },
        'group text rail established',
      );
      return { status: 'created', twilioConversationSid: ref.conversationSid, participantMap };
    },
  };
}
