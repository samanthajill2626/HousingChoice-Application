// The ONE attribution rule for "which contact is this inbound row FROM",
// and the instant normalizer every last_heard_from_at writer shares (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2).

const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

/** Canonical ISO form of any parseable instant; undefined when unparseable.
 *  DynamoDB compares stored strings LEXICALLY, so every writer stores this
 *  form ('2026-09-01T10:00:00Z' sorts AFTER '2026-09-01T10:00:00.500Z'). */
export function normalizeInstant(s: string | undefined): string | undefined {
  if (!nonEmpty(s)) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
