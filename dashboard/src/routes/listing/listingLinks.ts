// listingLinks — the public flyer link for a unit. The flyer is a live public
// page served at /public/units/:unitId/flyer (a REAL route, no "create" step);
// "View flyer ↗" opens this path and "Copy public link" copies its absolute URL.
export function flyerPath(unitId: string): string {
  return `/public/units/${encodeURIComponent(unitId)}/flyer`;
}
