// app/src/jobs/sendReconcile.ts
// The `send.reconcile` job (SOR spec Sec 5, D11-D16): resolves a send whose
// provider outcome was left ambiguous by looking the message up at the
// provider. THIS FILE IS THE STUB the send sites enqueue through (SOR Task 7):
// the job name, the payload shape, the owner reference and the check delays.
// The handler itself is added by SOR Task 10; until then an enqueued
// `send.reconcile` envelope has no handler.
//
// The payload carries identifiers only (D12): the owner reference with the
// HASHED recipient key, the attempt start every condition keys on, the check
// number and, for relay, the continuation context. Never a body or a phone.
import { hashRecipientKey } from '../lib/sendFingerprint.js';
import { RECONCILE_CHECK_DELAYS_MS } from '../lib/sendOutcome.js';
import type { SendAttemptOwner } from '../repos/sendAttemptsRepo.js';
import { enqueue } from './jobs.js';

export const SEND_RECONCILE_JOB = 'send.reconcile';

export type SendAttemptOwnerRef =
  | { kind: 'broadcast'; broadcastId: string; recipientKeyHash: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; recipientKeyHash: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; recipientKeyHash: string };

export interface SendReconcilePayload {
  owner: SendAttemptOwnerRef;
  attemptedAt: string;
  checkNo: number;
  continuation?: { senderKey: string; senderNameOverride?: string };
}

/** The owner as the payload carries it: the recipient key HASHED (never a phone in a payload). */
export function toOwnerRef(owner: SendAttemptOwner): SendAttemptOwnerRef {
  switch (owner.kind) {
    case 'broadcast':
      return { kind: 'broadcast', broadcastId: owner.broadcastId, recipientKeyHash: hashRecipientKey(owner.contactKey) };
    case 'relay_leg':
      return {
        kind: 'relay_leg',
        relayConversationId: owner.relayConversationId,
        sourceTsMsgId: owner.sourceTsMsgId,
        recipientKeyHash: hashRecipientKey(owner.memberKey),
      };
    case 'relay_rung':
      return {
        kind: 'relay_rung',
        relayConversationId: owner.relayConversationId,
        retryTsMsgId: owner.retryTsMsgId,
        recipientKeyHash: hashRecipientKey(owner.memberKey),
      };
  }
}

/** Lane-overridable ONLY when no real queue is configured (the hermetic e2e lane). */
export function reconcileCheckDelaysMs(): readonly number[] {
  const raw = process.env['E2E_SEND_RECONCILE_DELAYS_MS'];
  if (raw === undefined || (process.env['JOBS_QUEUE_URL'] ?? '') !== '') return RECONCILE_CHECK_DELAYS_MS;
  const parsed = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  return parsed.length === 3 && parsed.every((n) => Number.isFinite(n) && n >= 0) ? parsed : RECONCILE_CHECK_DELAYS_MS;
}

/** Check k runs at attemptedAt + delays[k]; never negative. Reads the LANE delays. */
export function reconcileDelayMs(attemptedAt: string, checkNo: number, nowMs: number): number {
  return Math.max(0, Date.parse(attemptedAt) + reconcileCheckDelaysMs()[checkNo]! - nowMs);
}

/** EnqueueOptions is `{ runAt }` ONLY (jobs.ts): the delay becomes a runAt. */
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void> {
  await enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) });
}
