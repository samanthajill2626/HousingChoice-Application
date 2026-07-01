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
import type { PoolNumbersService } from './poolNumbers.js';

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
  const { members, tag, placementId, owner, actor } = input;

  // Resolve canonical owner: explicit `owner` wins; fall back to legacy
  // `placementId`; fall back to standalone (unowned).
  const resolvedOwner: RelayOwner =
    owner !== undefined
      ? owner
      : typeof placementId === 'string' && placementId.length > 0
        ? { type: 'placement', id: placementId }
        : { type: null };

  // Provision the pool number first (lazy reclaim → reuse → fresh). The
  // conversation is created AFTER the number is claimed, under a provisional id,
  // then the real conversationId is stamped back. Kill-switch / voice-capability
  // refusals throw here and propagate to the route's 503 mapping.
  const provisioned = await poolNumbersService.provisionForPlacement('relay-pending', tag);
  const poolNumber = provisioned.poolNumber;

  const conversation = await conversationsRepo.createRelayGroup({
    poolNumber,
    members,
    ...(tag !== undefined && { tag }),
    owner: resolvedOwner,
  });
  mergeContext({ conversationId: conversation.conversationId });

  // Stamp the real conversationId onto the pool number (claimed under the
  // provisional id above). Best-effort: relay routing keys on pool_number, not
  // this back-reference — a failure here is operational metadata only.
  try {
    await poolNumbersService.assignConversation(poolNumber, conversation.conversationId);
  } catch (err) {
    logger.error(
      { err, conversationId: conversation.conversationId },
      'relay provision: pool number reassign failed (operational only)',
    );
  }

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
