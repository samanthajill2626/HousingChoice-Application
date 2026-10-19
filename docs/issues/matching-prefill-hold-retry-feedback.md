---
id: matching-prefill-hold-retry-feedback
title: The Matching composer's prefill hold (AR44) gives no feedback while Try again runs or fails again, keeps "Estimating reach..." and an older error on screen, and has no way back from "Add more tenants by filters"
type: improvement
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: dashboard/src/routes/orgs/useOrgList.ts:77-78, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:403-404, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:489-499, dashboard/src/routes/broadcasts/AudienceFilters.tsx:273-274, dashboard/src/routes/broadcasts/useComposerDraft.ts:177-189, docs/superpowers/reviews/2026-10-14-matching-blast-rules/planner-review/adversarial.md
---

**Problem.** Since `feat/matching-blast-rules` (spec revision 7, plan AR44,
Cameron 2026-10-19), a failed property load or organization-list read HOLDS
the blast composer's prefill with a "Try again" button instead of letting the
blast go out unfiltered by housing authority. The hold itself is correct (it
never sticks after a successful retry, never lets an unfiltered draft or
send out, and does not block direct sends). How it READS while it lasts has
gaps, found in the planner's review round 2 (`planner-review/adversarial.md`,
R2-1 to R2-5):

- R2-1 (low): Try again shows no in-flight state and no "failed again"
  signal. After a repeat failure the alert is unchanged (for the list read
  nothing re-renders), so a failed retry looks like a dead button and a
  screen reader does not re-announce it. A second click aborts the read
  still in flight and starts over (`useOrgList.ts:77-78`, the composer's
  effect cleanup at `BroadcastComposer.tsx:403-404`), so a read slower than
  the user's patience never lands. The tours-read Try again (the 503 alert)
  already disables itself with "Loading..." and re-shows on a repeat failure.
- R2-2 (info): during a failure hold the reach line still says "Estimating
  reach..." (`AudienceFilters.tsx:273-274`), though nothing is being
  estimated.
- R2-3 (info): an earlier property's "Couldn't estimate the audience" error
  can stay on screen beside the hold notice (two failures in a row needed):
  the no-message reset (`useComposerDraft.ts:179-189`) never clears `error`,
  and the hold returns at `:177` first.
- R2-4 (info): on a `?contactId=` direct send, clicking "Add more tenants by
  filters" (`BroadcastComposer.tsx:489-499`) during an organization-list
  outage turns the working 1:1 send into a hold with no way back short of a
  page reload. Related: `matching-enable-filters-keeps-one-tenant-message`.
- R2-5 (info): a `?unitId=` that does not exist (404) now holds with a Try
  again that can never succeed; it was a dead end before too, but "can't be
  filled in yet" promises too much.

Test gap (planner review round 2, `planner-review/conformance.md` R2-11): an
ABORTED organization-list read is untested - the code is right
(`useOrgList.ts:91` sets neither `loading` nor `error`), but the only aborted
read test is the property's (`BroadcastComposer.test.tsx:1054`), and under
AR44 a mishandled list abort would now show a hold notice. Add it with the
fix below.

**Suggested fix.** Mirror the tours-read Try again: a per-notice retrying
flag that disables the button and shows "Loading...", a fresh alert on each
repeat failure, no "Estimating reach..." during a failure hold, clear the
draft error when the hold starts, a way back to the direct send, and a
not-found property message without a retry.
