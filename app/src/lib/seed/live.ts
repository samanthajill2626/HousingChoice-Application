// Live seed items — items that require runtime-computed values (e.g. wall-clock
// timestamps, dynamic IDs) and therefore cannot be byte-stable across re-runs.
// These are seeded once on a fresh stack and intentionally NOT idempotent.
//
// Implemented in Task 4 of the seed clean-slate build (see .superpowers/sdd/).
// No-ops until then so the 'full' profile compiles and runs.

/** Side-effectful one-time seeding (e.g. live-timestamp items). Called by
 *  seedAll('full') after static items are written. */
export async function seedLive(_endpoint: string): Promise<void> {
  // Task 4 fills this in.
}
