// Time helpers shared by the display formatters.
//
// Our audit + activity-timeline SORT KEYS are `<ISO 8601>#<collision suffix>`
// (auditRepo / activityEventsRepo) — a value `new Date()` cannot parse, so a raw
// sort key would otherwise leak into the UI as its display timestamp. `isoOf`
// strips the suffix down to the ISO prefix so every formatter renders a
// human-readable time regardless of whether it was handed a clean instant or a
// composite key. Mirrors the server's `atOf` (app/src/routes/contactTimeline.ts).

/** The ISO prefix of a `<ISO>#<suffix>` sort key, or the value unchanged when it
 *  carries no `#` (already a clean instant). */
export function isoOf(value: string): string {
  const hash = value.indexOf('#');
  return hash > 0 ? value.slice(0, hash) : value;
}
