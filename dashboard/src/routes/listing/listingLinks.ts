// listingLinks - the public flyer link for a unit: the full-info PAGE at
// /p/:unitId (pre-2026-07-16 this wrongly pointed at the JSON API path
// /public/units/:id/flyer, so "View flyer" opened raw JSON). Bare (no ?cta)
// = the public form variant - right for a copied/shared link.
export function flyerPath(unitId: string): string {
  return `/p/${encodeURIComponent(unitId)}`;
}
