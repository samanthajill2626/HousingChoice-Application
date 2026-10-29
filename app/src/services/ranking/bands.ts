// WP1 B2a spec D9 (charter 8): the band a score falls in. Starting values,
// tunable without a prompt change; changing them re-ranks nothing (bands are
// derived on read, never stored). Pure, no imports.

export type Band = 'strong' | 'good' | 'possible' | 'weak';

/** The lowest score of each band above Weak. */
export const BAND_FLOORS: Readonly<{ strong: number; good: number; possible: number }> = Object.freeze({
  strong: 80,
  good: 60,
  possible: 40,
});

/** Best band first: the read sorts by this order (spec D9). */
export const BAND_ORDER: readonly Band[] = Object.freeze(['strong', 'good', 'possible', 'weak'] as const);

export function bandOf(score: number): Band {
  if (score >= BAND_FLOORS.strong) return 'strong';
  if (score >= BAND_FLOORS.good) return 'good';
  if (score >= BAND_FLOORS.possible) return 'possible';
  return 'weak';
}
