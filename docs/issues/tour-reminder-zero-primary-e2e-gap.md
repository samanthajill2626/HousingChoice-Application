---
id: tour-reminder-zero-primary-e2e-gap
title: Three tour-reminder paths the e2e harness cannot reach - the zero-primary property-contact fallback, the landlord-led en_route body, and any SKIPPED rung
type: debt
severity: low
status: open
area: e2e
created: 2026-08-26
refs: e2e/scenarios/steps.ts, app/test/tourContacts.test.ts, app/test/tourReminders.test.ts, app/test/relayApi.test.ts, app/test/tourRemindersApi.test.ts
---

**Problem.** The tour-reminder ladder rewrite (spec
`docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`, landed on
`feat/tour-reminder-ladder`) left THREE behaviours with unit/API coverage but no
end-to-end path. None is a defect; each is a place where a future regression
would go unnoticed by the e2e gate, so they are recorded together rather than
rediscovered one at a time.

1. **The zero-primary property-contact fallback has no e2e path.** Name
   resolution picks the unit roster's `primaryContact` first and falls back to
   the landlord of record (`app/src/lib/tourContacts.ts`, the established rule
   from `app/src/lib/rosterResolution.ts`). Both the ZERO-ROSTER and the
   ZERO-PRIMARY legs are pinned at unit level
   (`app/test/tourContacts.test.ts`, `app/test/tourReminders.test.ts`), but the
   lean e2e seed contains no unit with a roster that has zero primaries, so no
   Playwright spec exercises the fallback. Giving it one means changing the
   BYTE-STABLE lean seed, which is its own change with its own blast radius -
   deferred by adjudication 2026-08-26, not overlooked.

2. **The step helpers cannot compose an exact `en_route` LANDLORD-LED body.**
   `tourReminderBody()` composes through the app's own composer, but the
   harness records no property-contact name against the active tour
   (`requireTourReminderContext` in `e2e/scenarios/steps.ts` says so in its
   docblock), so `names` carries only the tenant and the context composes the
   SELF-GUIDED wording for that rung - correctly, since that is exactly what
   the server does for a nameless property contact. A spec that needs the
   landlord-led body must compose it spec-locally with an explicit `names`
   object. Until someone threads the landlord's name through the Scenario
   verbs, that body's only pins are unit/API level:
   `app/test/relayApi.test.ts` and `app/test/tourRemindersApi.test.ts`. No
   current spec asserts it, so nothing is silently wrong today.

3. **No Scenario verb can assert a SKIPPED rung at all, so `booked_too_late`
   has no e2e verb.** `expectReminderRung`'s state union in
   `e2e/scenarios/steps.ts` has no `'skipped'` member. Phase A owes no e2e
   proof of the new skip reason (the spec's testing section owes a unit test on
   the operator LABEL only, which
   `dashboard/src/routes/tours/RemindersPanel.test.tsx` carries), so the union
   was deliberately NOT widened on that branch. The consequence is broader than
   one reason token: `booked_too_late`, `past_event`,
   `quiet_hours_superseded` and every other visible skip row are invisible to
   the Scenario vocabulary, even though the panel renders them.

**Suggested fix.** Independent, and worth doing in this order because each is
cheaper than the one before it:

- (3) first: widen `expectReminderRung`'s state union with `'skipped'` and give
  it an optional expected skip reason. Cheapest, unlocks assertions for every
  visible skip row, and needs no seed change.
- (2) next: record the property contact's first name on the harness's active
  tour when a landlord-led tour is created, so `tourReminderContext` can
  compose the landlord-led wording the way the server does.
- (1) last, and only with a deliberate decision about the lean seed: add a unit
  whose roster carries contacts but no `primaryContact`, or provide a
  dev-only seam that clears the flag on an existing unit for one spec.
