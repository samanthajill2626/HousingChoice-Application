---
id: join-repeat-signup-answer-unreachable
title: A repeat /join sign-up's housing authority answer is kept only in the audit trail, where no staff screen shows it
type: improvement
severity: low
status: open
area: app/public
created: 2026-10-12
refs: app/src/routes/public.ts, app/scripts/backfill-join-housing-authority.ts
---

**Problem.** Since join-housing-authority (spec 2026-10-12 D6/D7), a `/join` sign-up from
a phone that is already a contact writes nothing to that contact; the authority it chose
is recorded only in its `housing_fair_signup` audit event (`payload.housingAuthority`,
`signupVersion: 2`). Nothing in the app reads a `contacts#` audit partition except the
lead backfill script, and `housing_fair_signup` is rendered on no staff screen. So:

- a pre-change lead who answers on `/join` after the deploy is left out of the backfill
  (`signed up again after the change`) and keeps no authority; the backfill report names
  the reason but not the answer it just read;
- a lead already holding an authority (backfilled or staff-set) who later chooses a
  different one on `/join` keeps the old one, silently.

The spec deliberately left "changing an existing contact from a repeat sign-up" out of
scope (a public, unauthenticated form must not edit an existing person's record); this
records the gap it leaves so staff can act on it. Found by the join-housing-authority R1
adversarial review (R1-ADV-3), 2026-10-12.

**Suggested fix.** Cheapest: the backfill report appends the latest v2 answer to each
`signed up again` line so the operator can set it by hand. Better: show
`housing_fair_signup` (with its authority) in the contact's activity, or raise a pending
suggestion for staff instead of discarding the answer.
