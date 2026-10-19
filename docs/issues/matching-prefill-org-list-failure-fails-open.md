---
id: matching-prefill-org-list-failure-fails-open
title: A failed organization-list read lets a property's blast go out unfiltered by housing authority, and staff cannot put the filter back
type: decision
severity: med
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx:229, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:232, dashboard/src/routes/broadcasts/authorityPrefill.ts:18, dashboard/src/routes/broadcasts/AudienceFilters.tsx:199, dashboard/src/routes/orgs/useOrgList.ts:111, dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx:976, docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:283-297
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

**Suggested fix (Cameron decides).** The review's two options:

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
