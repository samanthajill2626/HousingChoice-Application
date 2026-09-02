// The fan-out continuation ladder's pass claim (M5, design 2026-08-31 D1-D6).
//
// Both fan-out jobs used to count their passes in the ENQUEUED ENVELOPE, so the
// count only advanced when the queue accepted the next message: a broken queue
// froze it, the same value was recomputed forever, and the cap-and-close branch
// written to stop a stuck send was unreachable. The count now lives on the
// durable item as a TOP-LEVEL scalar (`fanout_attempt`) claimed atomically
// BEFORE the work it authorises, so every exit advances it and the cap is
// reachable.
//
// This module holds the shared result type ONLY. Neither repo imports the other,
// and both `claimFanoutPass` implementations return the same three outcomes, so
// a type-only module is what keeps the union from being written twice.

/**
 * The outcome of one claim.
 *
 * - `claimed` - this pass is ours; `attempt` is the 1-based pass number just
 *   taken (the post-increment value, as `UPDATED_NEW` returns it).
 * - `capped` - the ladder is spent; `attempt` is the UNCHANGED stored count.
 *   The caller closes the entity rather than sending.
 * - `missing` - the item is gone. Nothing to close; the caller logs and returns.
 *
 * `capped` and `missing` arrive as the SAME ConditionalCheckFailedException from
 * DynamoDB - only a strongly consistent re-read tells them apart, and the two
 * demand different handling, so they are separate outcomes rather than one
 * refusal.
 */
export type FanoutClaimResult =
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped'; attempt: number }
  | { outcome: 'missing' };
