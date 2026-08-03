// Relay-group provisioning (M1.7 primitive, shared in M1.10) — the one chain
// that stands up a masked relay thread: provision a pool number → create the
// relay_group conversation → assign the number → audit → enqueue the intro →
// emit conversation.updated. Both entry points use it so the kill-switch /
// voice-capability handling and the intro/audit/SSE tail never drift:
//   • the standalone POST /api/relay-groups (test scaffold; routes/relayGroups.ts)
//   • the placement-scoped POST /api/placements/:placementId/relay (the product trigger; routes/placements.ts)
//
// It does NOT catch RelayProvisioningDisabledError / VoiceCapabilityError —
// those propagate so each route maps them to its own 503 + refusal audit (the
// reason differs: 'create' vs 'placement' vs 'reopen').
//
// PII (doc §9): logs conversationId/placementId/memberCount/actor only — never a
// member phone/name or the placement tag.
import { mergeContext } from '../lib/context.js';
import { toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { RELAY_INTRO_JOB } from '../jobs/relayFanOut.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
  RelayOwner,
} from '../repos/conversationsRepo.js';
import { RELAY_WARM_JOB, type PoolNumbersService } from './poolNumbers.js';

export interface ProvisionRelayDeps {
  conversationsRepo: ConversationsRepo;
  poolNumbersService: PoolNumbersService;
  auditRepo: AuditRepo;
  events: EventBus;
  logger: Logger;
}

export interface ProvisionRelayInput {
  members: ConversationParticipant[];
  /** Operator placement label (mirrored onto the pool number). */
  tag?: string;
  /** Legacy back-reference (M1.10). Prefer `owner` for new callers. */
  placementId?: string;
  /**
   * Generalized owner (Task 5). When provided, overrides `placementId`.
   * `{type:'tour', id}` creates a tour-owned thread; `{type:'placement', id}`
   * is equivalent to providing `placementId`; `{type:null}` creates an
   * unowned (standalone) thread.
   */
  owner?: RelayOwner;
  /** Acting user for the audit (byActor GSI key). */
  actor?: string;
  /**
   * Property ZIP (5 digits) for the pool-number buy when this group is owned
   * by a tour/placement (area-code preference). Used ONLY on the tier-3
   * connect-when-ready path (rides the warm-job payload); tiers 1/2 assign an
   * existing number and ignore it. Never required - absent means the
   * Atlanta-default ladder.
   */
  postalCode?: string;
}

/**
 * Provision a relay group and return the created conversation. THROWS
 * RelayProvisioningDisabledError (kill-switch off) or VoiceCapabilityError (no
 * voice-capable number) BEFORE any conversation is created — the caller maps
 * these to a 503. Pool-number assignment + the intro enqueue are best-effort
 * (the group exists regardless; a failure there is logged, not fatal).
 */
export async function provisionRelayGroup(
  deps: ProvisionRelayDeps,
  input: ProvisionRelayInput,
): Promise<ConversationItem> {
  const { conversationsRepo, poolNumbersService, auditRepo, events, logger } = deps;
  const { members, tag, placementId, owner, actor, postalCode } = input;

  // Resolve canonical owner: explicit `owner` wins; fall back to legacy
  // `placementId`; fall back to standalone (unowned).
  const resolvedOwner: RelayOwner =
    owner !== undefined
      ? owner
      : typeof placementId === 'string' && placementId.length > 0
        ? { type: 'placement', id: placementId }
        : { type: null };

  // Resolve a pool number via the three-tier ladder (T5): reuse (prefer
  // multiplex) -> fresh spare -> connect-when-ready. It NEVER buys and NEVER
  // throws the kill-switch error - a tier-3 miss returns `needs_connecting`.
  const result = await poolNumbersService.provisionForGroup(
    members.map((m) => m.phone),
    tag,
  );

  // TIER 3 - CONNECT-WHEN-READY: no number available now. Create the group in the
  // CONNECTING state (no pool number - staff can open + QUEUE messages) and warm a
  // dedicated number for IT (D6): the warm job is tagged with this conversationId
  // so warmOneNumber stamps pending_conversation_id, and onNumberRegistered then
  // enqueues relay.numberReady back to this group. The intro is DEFERRED to the
  // ready handler (there is no number to send from yet).
  if (result.kind === 'needs_connecting') {
    const conversation = await conversationsRepo.createRelayGroup({
      // No poolNumber -> connecting create.
      members,
      ...(tag !== undefined && { tag }),
      owner: resolvedOwner,
    });
    mergeContext({ conversationId: conversation.conversationId });

    // Record the group + its roster (available to the ready handler for the
    // assign-time burn). `connecting: true` marks the deferred-open path.
    await auditRepo.append(`conversations#${conversation.conversationId}`, 'relay_group_created', {
      actor,
      memberCount: members.length,
      connecting: true,
      ...(tag !== undefined && { tag }),
      ...(resolvedOwner.type !== null && { ownerType: resolvedOwner.type, ownerId: resolvedOwner.id }),
      ...(resolvedOwner.type === 'placement' && { placementId: resolvedOwner.id }),
    });

    // Warm a dedicated number for THIS connecting group. Best-effort like the
    // intro enqueue: a queue hiccup leaves the group connecting, which the
    // stuck-connecting alert reconciles - never fatal to the created group.
    // The property ZIP (when the caller resolved one) rides the payload as a
    // BUY hint, so the search prefers a number local to the unit and the hint
    // survives job retries. Omitted entirely when absent - never a null key.
    try {
      await enqueueImmediate(RELAY_WARM_JOB, {
        conversationId: conversation.conversationId,
        ...(postalCode !== undefined && { postalCode }),
      });
    } catch (err) {
      logger.error(
        { err, conversationId: conversation.conversationId },
        'relay warm enqueue failed - connecting group created without a warm job (stuck-connecting alert will surface it)',
      );
    }

    // NO intro enqueue here (deferred to relay.numberReady). Surface the new
    // connecting group live so the dashboard can render it + queue on it.
    events.emit('conversation.updated', toConversationUpdatedEvent(conversation));
    logger.info(
      {
        conversationId: conversation.conversationId,
        memberCount: members.length,
        actor,
        connecting: true,
        ...(resolvedOwner.type !== null && { ownerType: resolvedOwner.type, ownerId: resolvedOwner.id }),
      },
      'relay group provisioned (connecting - awaiting a warm number)',
    );
    return conversation;
  }

  // TIER 1/2 - ASSIGNED: a number is available now -> today's OPEN-group behavior
  // (create with the pool number -> audit -> intro -> emit), unchanged.
  const poolNumber = result.poolNumber;

  const conversation = await conversationsRepo.createRelayGroup({
    poolNumber,
    members,
    ...(tag !== undefined && { tag }),
    owner: resolvedOwner,
  });
  mergeContext({ conversationId: conversation.conversationId });

  await auditRepo.append(`conversations#${conversation.conversationId}`, 'relay_group_created', {
    actor,
    memberCount: members.length,
    ...(tag !== undefined && { tag }),
    // PII (doc §9): log owner type + id only (never a phone).
    ...(resolvedOwner.type !== null && { ownerType: resolvedOwner.type, ownerId: resolvedOwner.id }),
    // Backward-compat: also emit placementId for placement-owned threads so
    // existing observability (Splunk/CloudWatch) is not silently broken by the
    // ownerType/ownerId rename. Additive only — no placement logic changes.
    ...(resolvedOwner.type === 'placement' && { placementId: resolvedOwner.id }),
  });

  // Intro: throttle-send to each member (names everyone connected). A failure to
  // enqueue must not fail provisioning — the group exists; log + continue.
  try {
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: conversation.conversationId });
  } catch (err) {
    logger.error(
      { err, conversationId: conversation.conversationId },
      'relay intro enqueue failed — group created without intro',
    );
  }

  events.emit('conversation.updated', toConversationUpdatedEvent(conversation));
  logger.info(
    {
      conversationId: conversation.conversationId,
      memberCount: members.length,
      actor,
      // PII (doc §9): log owner type + id only (never a phone).
      ...(resolvedOwner.type !== null && { ownerType: resolvedOwner.type, ownerId: resolvedOwner.id }),
    },
    'relay group provisioned',
  );
  return conversation;
}
