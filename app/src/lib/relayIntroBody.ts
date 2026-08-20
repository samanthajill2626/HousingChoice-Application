// The operator-edited relay group intro (2026-08-20). One definition of the
// rule, shared by all three surfaces that can open a group: the standalone
// create (routes/relayGroups.ts), the tour open (routes/tours.ts) and the
// placement open (routes/placements.ts).
//
// FOUNDER DECISION, recorded so a later reader does not "fix" it: this body is
// FREE OPERATOR TEXT on a first-contact SMS, and it is validated for LENGTH
// ONLY. It carries no brand and no "Reply STOP to opt out." line. That is not an
// oversight - the founder directed the removal of both from the group intro
// (2026-08-18 for the opt-out line, 2026-08-20 for the brand), engineering
// stated the exposure each time, and she chose it anyway. Do not add opt-out or
// brand validation here without asking her first. See the relay.intro entry in
// messages/catalog.ts for the full attribution.

/**
 * Longest an edited intro may be. The composed default already runs ~215
 * characters and the whole point of the edit is to ADD to it (a property
 * address, who the landlord is), so the 320-char cap the canned-reply templates
 * use would bind almost immediately. 480 is roughly three SMS segments: room to
 * say something real, still a message rather than an essay.
 */
export const RELAY_INTRO_MAX_CHARS = 480;

export type ParsedIntroBody = { body: string | undefined } | { error: string };

/**
 * Validate a client-supplied intro body. Absent/undefined is the ordinary case
 * (the operator did not touch the preview) and yields `{ body: undefined }` -
 * the caller stores nothing and relayFanOut composes from the catalog as always.
 *
 * A whitespace-only edit is treated as "not edited" rather than refused: it is
 * indistinguishable in intent from clearing the box, and an intro that sends
 * blank is worse than one that falls back to the default.
 */
export function parseIntroBody(raw: unknown): ParsedIntroBody {
  if (raw === undefined || raw === null) return { body: undefined };
  if (typeof raw !== 'string') {
    return { error: 'introBody must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { body: undefined };
  if (trimmed.length > RELAY_INTRO_MAX_CHARS) {
    return { error: `introBody must be ${RELAY_INTRO_MAX_CHARS} characters or fewer` };
  }
  return { body: trimmed };
}
