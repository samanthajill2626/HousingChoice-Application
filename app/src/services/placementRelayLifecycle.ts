// Lost-placement relay lifecycle (Post-Tour & Application, Task 5).
//
// When a placement is LOST, its masked relay thread is moot - close it so the
// deal that no longer exists can never fan out again. The pool number is KEPT
// (burn-multiplexing: a closed group stays resolvable so a late text intercepts
// to the sender's 1:1). This is invoked as the OPTIONAL
// `closeRelayForLostPlacement` hook on the ONE status-transition choke point
// (services/statusTransition.ts), best-effort (a failure there is caught +
// logged and never fails the transition).
//
// Mirrors the relayGroups close pattern (routes/relayGroups.ts): read the
// conversation FIRST, then atomically flip status->closed (conditional on
// status='open') so a concurrent/duplicate close is an idempotent no-op.
// Nothing is released. Finally audit `relay_group_closed`.
//
// PII (doc section 9): the audit payload carries IDs ONLY (reason + placementId)
// - never a phone number.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import type { PlacementItem } from '../repos/placementsRepo.js';

export interface PlacementRelayLifecycleDeps {
  conversationsRepo: ConversationsRepo;
  auditRepo: AuditRepo;
  logger?: Logger;
}

export interface PlacementRelayLifecycle {
  /** Close (and free the pool number of) a LOST placement's relay thread. */
  closeForLost(placement: PlacementItem): Promise<void>;
}

export function createPlacementRelayLifecycle(
  deps: PlacementRelayLifecycleDeps,
): PlacementRelayLifecycle {
  const { conversationsRepo, auditRepo } = deps;
  const log = deps.logger ?? defaultLogger;

  return {
    async closeForLost(placement: PlacementItem): Promise<void> {
      const conversationId = placement.group_thread;
      // No relay thread → nothing to close (the common case: no group text).
      if (typeof conversationId !== 'string' || conversationId.length === 0) return;

      // Read the conversation FIRST to capture the pool number to release.
      const conversation = await conversationsRepo.getById(conversationId);
      if (!conversation || conversation.type !== 'relay_group') {
        log.info(
          { placementId: placement.placementId, conversationId },
          'lost relay-close: no open relay group — skipping',
        );
        return;
      }
      // Atomic close: flip status='closed' conditional on status='open'. A
      // concurrent/duplicate close fails the precondition -> idempotent no-op.
      // The pool number is KEPT (burn-multiplexing) - nothing is released.
      try {
        await conversationsRepo.setRelayStatus(conversationId, 'closed', 'open');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { placementId: placement.placementId, conversationId },
            'lost relay-close: already closed - idempotent no-op',
          );
          return;
        }
        throw err;
      }

      // Audit the closure - IDs only, no phones (doc section 9).
      await auditRepo.append(`conversations#${conversationId}`, 'relay_group_closed', {
        reason: 'placement_lost',
        placementId: placement.placementId,
      });
    },
  };
}
