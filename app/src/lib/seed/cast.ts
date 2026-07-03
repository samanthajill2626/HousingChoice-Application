// Cast seed items — a richer cast of personas covering the full sequence-diagram
// states (triage-queue unknowns, mid-intake tenants, landlord lead funnel, etc.).
//
// Implemented in Task 3 of the seed clean-slate build (see .superpowers/sdd/).
// Returns an empty array until then so the 'full' profile compiles and runs.

/** Additional contacts/units/etc. that fill out the narrative cast beyond the
 *  lean base fixtures. Merged on top of SEED by seedAll('full'). */
export function castItems(): Record<string, Record<string, unknown>[]> {
  return {};
}
