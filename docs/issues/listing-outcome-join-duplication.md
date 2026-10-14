---
id: listing-outcome-join-duplication
title: The listing-send outcome join is assembled in four places, with repeated group-by-tenant loops and constants
type: debt
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/routes/units.ts, app/src/routes/contacts.ts, app/src/routes/broadcasts.ts, app/src/services/followUps.ts, app/scripts/backfill-last-heard-from.ts
---

**Problem.** Deriving a send's outcome needs the same join everywhere: the
listing_sends row, the pair's tours (signal + activity), and the recipient's
type, status and last heard from. `feat/last-heard-from` assembles it four
times - the units recipients route, the contact listings-sent route, the
broadcasts preview's decline labels, and the follow-ups builder - with three
copies of the group-tours-by-tenant loop. `GROUP_THREAD_TYPES` is
re-declared in the backfill script, and a third copy of `TEAM_SENDER_KEY` has
no test pinning it. Each copy is correct today; the risk is drift when the
derivation changes (Work Package 3 will add an engine writer). Found by the
planner's plan-blind adversarial review (2026-10-13).

**Suggested fix.** One `loadOutcomeJoin({ unitIds | contactId })` service that
returns rows + tours-by-pair + recipient displays, used by all four readers;
export the two constants from their owning modules and import them.
