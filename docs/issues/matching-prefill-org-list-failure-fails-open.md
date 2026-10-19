---
id: matching-prefill-org-list-failure-fails-open
title: The blast composer's property prefill fails OPEN - a failed organization-list read, a failed property load, or a list read before an authority was added leaves a property's blast unfiltered by housing authority (DECIDE BEFORE MERGING feat/matching-blast-rules)
type: decision
severity: med
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx:229, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:231, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:232, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:363-379, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:490, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:752, dashboard/src/routes/broadcasts/authorityPrefill.ts:18, dashboard/src/routes/broadcasts/AudienceFilters.tsx:199, dashboard/src/routes/orgs/useOrgList.ts:107, dashboard/src/routes/orgs/useOrgList.ts:111, dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx:976, docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:283-297
---

**Problem.** With a property attached and the filters on, the blast composer
prefills the housing authority filter from the property's accepted
authorities (matching-blast-rules D3) and holds Preview until the prefill
settles. A failed organization-list read (`GET /api/organizations`) counts as
SETTLED: the gate lifts
(`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:229` - `orgLoading`
is false once the read fails), `prefillAuthorities` maps nothing while the
list is unknown (`dashboard/src/routes/broadcasts/authorityPrefill.ts:18`),
the composer shows "Couldn't load the organization list, so housing
authorities were not filled in from the property." (`BroadcastComposer.tsx:73-74`,
`:232`), and the picker is disabled for a failed read with nothing in hand
(`dashboard/src/routes/broadcasts/AudienceFilters.tsx:199`). `useOrgList`
reads once per mount and the composer never calls its `reload`
(`dashboard/src/routes/orgs/useOrgList.ts:111`).

Trigger: `?unitId=` (or a picked property) whose `accepted_authorities` is
["Atlanta Housing Authority"], and the list read answers 500 once (a throttled
read, a deploy blip). Effect: the draft carries no housing authority filter,
so "Reaches N" counts every Searching and Onboarding tenant of that voucher
size in EVERY authority, all starting checked on Review recipients; staff
cannot add the filter back (the picker is disabled), and the only remedy, a
page reload, is not offered. The failed tours and Not interested reads fail
CLOSED instead (503 with Try again, D5/D6), because a list without those rules
would check people the rules leave out - a missing authority filter does the
same. (When every accepted authority is off the list, the draft is likewise
unfiltered, but there the filters say "This blast is not limited by housing
authority.")

This is the APPROVED spec's explicit choice, not a build defect. Spec D3
(`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:288-290`)
says a failed list read counts as settled: nothing is prefilled and the
filters show the notice above. `BroadcastComposer.test.tsx:976` ("a failed
organization list read settles the prefill with its notice; the voucher size
still fills in") pins it. The state is visible: the notice, the reach count,
and each review row's housing authority column. Code review R1 ADV-2
(`docs/superpowers/reviews/2026-10-14-matching-blast-rules/code-review/r1-adversarial.md`),
ruled FILE in `r1-adjudications.md` (same folder) as Cameron's call: changing
it in the build would have silently departed from the approved contract.

**Two siblings settle on the same decision** (code review R2,
`code-review/r2-review.md` section 3, same folder):

- A FAILED PROPERTY LOAD also counts as settled (spec D3;
  `BroadcastComposer.tsx:231`, the load at `:363-379`). The draft then carries
  neither housing authorities NOR a voucher size - wider than the list case -
  and a `?unitId=` entry (the property page's "+ Send") offers no retry:
  `pickProperty`'s reset (`:490`) serves picker entries only, and the Change
  control renders only without `?unitId=` (`:752`), so the remedy is a page
  reload nobody offers. The pickers stay usable there, so staff CAN rebuild the
  filters by hand after reading the notice.
- A STALE LIST: the composer reads the organization list ONCE per mount
  (`useOrgList.ts:107`; it never calls `reload`), so an authority added to the
  list after the composer mounted maps to "Not used (not on the organization
  list)" and, when it is the property's only one, the blast is "not limited by
  housing authority".

Severity read: once a staff member sends past the visible notice, the outcome
is the review's worst class (people outside the property's housing
authorities texted by default). Code review R2 asked that Cameron decide this
BEFORE `feat/matching-blast-rules` merges; one decision covers all three paths.

**Suggested fix (Cameron decides).** The review's two options (option 2 also
closes the stale-list path; option 1 does not):

1. Hold: keep the prefill gate closed while the list read has failed with
   nothing in hand (no draft, Preview disabled), and show "Couldn't load the
   organization list" with Try again wired to `orgList.reload()`.
2. Prefill verbatim: put the property's own `accepted_authorities` in the
   filter as written. They are list-checked on write; the draft create's
   `checkList` answers 422 for one that has since left the list, and D3b then
   removes only that member.

Either option amends spec D3's failed-list sentence and rewrites the pinned
test `BroadcastComposer.test.tsx:976`. Regression test (the review's
ADV-failopen shape): `getOrgList` rejects 500 and the unit accepts
["Atlanta Housing Authority"]; assert (1) no draft is created and Preview
stays disabled until Try again re-reads the list, or (2) the last
`createBroadcast` body carries
`housing_authorities: ['Atlanta Housing Authority']`.
