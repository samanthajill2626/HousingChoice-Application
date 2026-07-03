// Matrix seed items — cross-entity story snapshots that exercise every status
// model state in combination (tours, placements at each stage, reminder rows,
// relay groups, listing-sends, broadcasts, etc.).
//
// Implemented in Task 2 of the seed clean-slate build (see .superpowers/sdd/).
// Returns an empty object until then so the 'full' profile compiles and runs.

/** Cross-cutting story-snapshot items that complement the cast. Merged on top
 *  of SEED + castItems() by seedAll('full'). */
export function matrixItems(): Record<string, Record<string, unknown>[]> {
  return {};
}
