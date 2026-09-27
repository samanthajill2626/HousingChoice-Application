// app/src/lib/sendAttemptGate.ts
// The D8 gate (SOR spec D8, revision 11), in ONE place (code review ADV-10):
// the broadcast fan-out, the relay fan-out and the relay retry rung each held
// a byte-identical copy, and a fourth copy of the same state machine lives in
// the attempt repo's claim - so three drifting copies became one.
import type { SendAttemptOwner, SendAttemptRecord, SendAttemptsRepo } from '../repos/sendAttemptsRepo.js';
import { SEND_CLAIM_TTL_MS } from './sendOutcome.js';

/** What the D8 gate decided for one recipient (spec D8, revision 11). */
export type GateResult =
  | { kind: 'proceed'; record?: SendAttemptRecord }
  | { kind: 'skip' }
  | { kind: 'defer' }
  | { kind: 'taken_over'; record: SendAttemptRecord };

/**
 * Spec D8 (revision 11): a pre-claim decline or a close by another writer
 * touches the slot ONLY when the recipient's attempt record cannot belong to a
 * live attempt. An ALLOW-list: an ABSENT record, done/retryable and redriven
 * PROCEED (a redriven record is claimable by ANY pass, so any pass's decline
 * may close it - the caller then runs closeRedriven); done with any other
 * outcome SKIPS (terminal, never carried forward); a STALE attempting record
 * (older than the claim TTL) is TAKEN OVER into reconcile and returned - the
 * CALLER hands off, exactly once: this gate never enqueues; a fresh attempting
 * or a reconciling record DEFERS. The repo is a parameter (build findings T7-4,
 * G6) and the read is strongly consistent; a read that throws is the caller's
 * to handle (a prepare-phase throw in a recipient unit; a per-key catch in a
 * cap-close; out of the job on the retry rung - build finding T9-7).
 */
export async function gateFor(attempts: SendAttemptsRepo, owner: SendAttemptOwner, nowMs: number): Promise<GateResult> {
  const rec = await attempts.get(owner);
  if (rec === undefined) return { kind: 'proceed' };
  if (rec.state === 'done') return rec.outcome === 'retryable' ? { kind: 'proceed', record: rec } : { kind: 'skip' };
  if (rec.state === 'redriven') return { kind: 'proceed', record: rec };
  if (rec.state === 'attempting' && nowMs - Date.parse(rec.attemptedAt) > SEND_CLAIM_TTL_MS) {
    return (await attempts.takeOver(owner, rec)) ? { kind: 'taken_over', record: rec } : { kind: 'defer' };
  }
  return { kind: 'defer' };
}
