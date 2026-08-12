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

      // Already railed AND verifiable: no claim, no Twilio call. This is the
      // overwhelmingly common case on a migration re-run.
      if (hasActiveGroupRail(thread)) {
        const stored = thread.twilio_participant_map ?? {};
        const missing = missingFromMap(members, stored);
        if (missing.length === 0) {
          return {
            status: 'existing',
            twilioConversationSid: thread.twilio_conversation_sid as string,
            participantMap: stored,
          };
        }
        // A rail whose stored map does not cover the roster: fall through to the
        // claimed path, which re-reads participants from Twilio and re-finalizes
        // the SAME conversation (adopt-by-UniqueName finds it).
        log.warn(
          { event: 'group_rail_map_incomplete', conversationId, missing: missing.length },
          'group rail participant map does not cover the roster - refreshing from Twilio',
        );
      }

      if (members.length > MAX_RAIL_MEMBERS) {
        // Structural, permanent, and knowable without spending a Twilio call.
        const reason = `roster of ${members.length} exceeds the ${MAX_RAIL_MEMBERS} members a rail can hold`;
        log.warn({ event: 'group_rail_roster_too_large', conversationId }, reason);
        return { status: 'failed', reason };
      }

      const author = businessNumber();
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
      try {
        // ADOPT-OR-CREATE. The adopt half runs FIRST: a 404 here is `undefined`
        // while an auth failure or a 5xx re-throws (adapter contract), so an
        // outage can never read as "no rail exists" and start a duplicate storm.
        const adopted = await port.fetchByUniqueName(conversationId);
        if (adopted !== undefined) {
          ref = adopted;
        } else {
          const created = await port.createConversationWithParticipants({
            uniqueName: conversationId,
            businessNumber: author,
            members: members.map((m) => m.phone),
          });
          ref = created.conversation;
          participants = created.participants;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: summarizeError(err), event: 'group_rail_ensure_failed', conversationId },
          'group rail creation failed - the thread stays inbound-only',
        );
        await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
        return { status: 'failed', reason };
      }

      // A conversation that failed or closed during attach is rail-FAILED, not a
      // rail. Posting into a closed conversation is a silent no-delivery.
      const state = ref.state ?? 'active';
      if (state === 'closed' || state === 'failed') {
        const reason = `Conversation ${ref.conversationSid} is ${state}`;
        log.warn({ event: 'group_rail_ensure_failed', conversationId, state }, reason);
        await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token);
        return { status: 'failed', reason };
      }

      try {
        participants ??= await port.fetchParticipants(ref.conversationSid);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
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
          const reason = err instanceof Error ? err.message : String(err);
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

      const finalized = await conversations.setTwilioConversation(
        conversationId,
        ref.conversationSid,
        participantMap,
        token,
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
