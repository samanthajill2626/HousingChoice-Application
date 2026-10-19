---
id: matching-prefill-org-list-failure-fails-open
title: The blast composer reads the organization list once per page load - a housing authority added to the list after that read is not prefilled from the property (shown as "Not used"; the blast is not limited by housing authority when it was the property's only one)
type: decision
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-19
updated: 2026-10-19
refs: dashboard/src/routes/orgs/useOrgList.ts:102-109, dashboard/src/routes/broadcasts/authorityPrefill.ts:14-32, dashboard/src/routes/broadcasts/AudienceFilters.tsx:220-227, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:242-251, docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:321-324
---

**Status 2026-10-19 - the failed reads are DECIDED and FIXED; only the
stale list stays open.** Cameron decided this issue at the planner's
handback review of `feat/matching-blast-rules`: "Hold + Try again". Spec
revision 7 (D3 Timing) and plan ruling AR44 record it, and commit `f0b33c94`
built it: with a property attached and the filters on, a FAILED property
load, or a FAILED organization-list read while the property accepts a
housing authority, no longer settles the prefill - no draft is created,
Preview stays disabled, and the filters show "Couldn't load the property, so
its housing authorities and voucher size can't be filled in yet." or
"Couldn't load the organization list, so housing authorities can't be filled
in from the property yet." with a Try again that re-runs only that read
(`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:242-251`). That
closes the failed-list path and the failed-property-load sibling below
(including the `?unitId=` entry, which had no retry), and the stalled-read
form (adversarial PA-9: a stalled read ends in an error, which now holds
with Try again). Severity lowered from med to low: what remains is visible
and needs an authority added while a composer is open.

**Open: the stale list.** The composer reads the organization list ONCE per
page load (`dashboard/src/routes/orgs/useOrgList.ts:102-109`; it re-reads
only on the failed-read Try again). An authority added to the list AFTER
that read - by another staff member, or in another tab - is not on the list
the prefill maps against (`dashboard/src/routes/broadcasts/authorityPrefill.ts:14-32`),
so a property that accepts it shows it as "Not used (not on the organization
list): <names>." and, when it is the property's only accepted authority,
"This blast is not limited by housing authority."
(`dashboard/src/routes/broadcasts/AudienceFilters.tsx:220-227`) - the draft
carries no housing authority filter. Spec D3
(`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:321-324`)
keeps this case on purpose as NOT a failure: a known, visible gap. The
picker cannot offer the new name either (its list is the same read); a page
reload fixes it.

**Suggested fix (Cameron decides, if ever).** Re-read the list when a
property is picked (or before the first draft of a property) so the prefill
maps against a fresh list; or prefill the property's own accepted names
verbatim (the review's option 2 below - the draft create's `checkList` maps
or refuses each, and D3b removes only a refused member). Either changes the
D3 sentence quoted above.

**History (as filed 2026-10-19, before the decision; line numbers as of
994be540).**

With a property attached and the filters on, the blast composer
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
