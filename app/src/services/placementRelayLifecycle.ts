// Lost-placement relay lifecycle (Post-Tour & Application, Task 5).
//
// When a placement is LOST, its masked relay thread is moot — close it and free
// its pool number so the deal that no longer exists can never fan out again. This
// is invoked as the OPTIONAL `closeRelayForLostPlacement` hook on the ONE status-
// transition choke point (services/statusTransition.ts), best-effort (a failure
// there is caught + logged and never fails the transition).
//
// Mirrors the relayGroups close pattern (routes/relayGroups.ts): read the
// conversation FIRST to capture the pool number, atomically flip status→closed
// (REMOVE pool_number, conditional on status='open') so an inbound arriving in the
// window can no longer resolve the thread, THEN release the captured number, and
// only if THIS call won the close (a concurrent/duplicate close fails the
// precondition → idempotent no-op, and we skip the release so we never double-
// quarantine). Finally audit `relay_group_closed`.
//
// PII (doc §9): the audit payload carries IDs ONLY (reason + placementId) —
// never a phone number.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import type { PlacementItem } from '../repos/placementsRepo.js';
import type { PoolNumbersService } from './poolNumbers.js';

export interface PlacementRelayLifecycleDeps {
  conversationsRepo: ConversationsRepo;
  poolNumbersService: PoolNumbersService;
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
  const { conversationsRepo, poolNumbersService, auditRepo } = deps;
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
      const oldPoolNumber = conversation.pool_number;

      // Atomic close: status='closed' + REMOVE pool_number, conditional on
      // status='open'. A concurrent/duplicate close fails the precondition →
      // idempotent no-op (and we skip the release below so we never double-free).
      try {
        await conversationsRepo.setRelayStatus(conversationId, 'closed', null, 'open');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { placementId: placement.placementId, conversationId },
            'lost relay-close: already closed — idempotent no-op',
          );
          return;
        }
        throw err;
      }

      // Release the captured number AFTER the close won — best-effort (the thread
      // is already closed; a failed release only leaks a number, never a message).
      if (typeof oldPoolNumber === 'string' && oldPoolNumber.length > 0) {
        try {
          await poolNumbersService.release(oldPoolNumber);
        } catch (err) {
          log.error(
            { err, placementId: placement.placementId, conversationId },
            'lost relay-close: pool number release failed — closed anyway',
          );
        }
      }

      // Audit the closure — IDs only, no phones (doc §9).
      await auditRepo.append(`conversations#${conversationId}`, 'relay_group_closed', {
        reason: 'placement_lost',
        placementId: placement.placementId,
      });
    },
  };
}
