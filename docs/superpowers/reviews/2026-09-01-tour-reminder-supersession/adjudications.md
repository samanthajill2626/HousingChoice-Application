# Spec round 1 - adjudications

Date: 2026-09-01
Reviewers: A (`spec-r1-reviewer-a.md`), B (`spec-r1-reviewer-b.md`) - independent,
same brief, both blind to the design conversation.

30 findings, 7 BLOCKING across the two. The two reviewers converged
independently on the same three blocking defects (A1/B2, A3/B3, A4/B1), which
is the strongest signal in the round.

Verdict counts: ACCEPT 24, ACCEPT-AS-RISK 3, REJECT 0, MERGED-DUPLICATE 3.
Decisions changed: yes, substantially - the generation mechanism, the delete
mechanism and the layout anchoring all changed. This is NOT a terminal round.

## Blocking

**A1 / B2 - `claimSend` resurrects a deleted row. ACCEPT.**
Verified: `app/src/repos/tourRemindersRepo.ts:285` is an `UpdateCommand` whose
condition is only `attribute_not_exists(sentAt|canceledAt|skippedAt)`. On a row
the sweep deleted, all three hold, so DynamoDB CREATES the item and the claim
returns success - the poll then sends a reminder for a tour that was
rescheduled, and the resurrected row is a stub with no `tourId`, `kind` or
`dueAt`. The whole premise of D1 ("delete retires the rung") is false without a
guard. Spec now requires `attribute_exists(reminderId)` on `claimSend`,
`claimSkip` and `cancel`. `uncancel` already requires
`attribute_exists(canceledAt)` and is safe.

**A3 / B3 - `armedFor` is not a generation identifier. ACCEPT, redesigned.**
Verified against `app/src/routes/tours.ts:1172`: `rearmTrigger` fires on
`scheduledAtIso !== undefined || patch['status'] === 'scheduled'`, so a
status-only revival (canceled -> scheduled) re-arms at the STORED time, and a
no-op re-PATCH re-arms at an unchanged time. Both produce a new generation whose
`armedFor` equals the old one's, rejoining superseded sent rungs to the current
ladder. Replaced with `armedAt`: one ISO instant per arm CALL, stamped
identically on every row that call creates. Current ladder = the rows carrying
the greatest `armedAt` for that tour. This also dissolves A12 (the
canonicalization asymmetry - nothing compares times any more) and A7/B4 (legacy
rows now sort as earlier the moment any stamped row exists).

**A4 / B1 - a third `cancelTourReminders` caller. ACCEPT.**
Verified at `app/src/routes/placements.ts:716`: the tour-to-placement conversion
cancels the ladder between `claimConversion` and `create`, inside a
claim/release compensation. The spec asserted two call sites and ordered
`cancelForTour` deleted. Spec now enumerates three and rules on the conversion's
semantics explicitly.

## High

**A2 / B13 - the in-memory fake cannot reproduce the defect. ACCEPT.**
Verified at `app/test/helpers/twilioWebhookHarness.ts:2973`: the fake returns
`false` on a missing row, the opposite of the real upsert. Acceptance #2 would
have gone green against the fake while production shipped A1. Spec now requires
the race proven at the REPO layer against DynamoDB Local, and the fake corrected
to mirror the real conditional.

**A5 - two non-null assertions on a row the sweep can delete. ACCEPT.**
Verified at `app/src/routes/tourReminders.ts:395` and `:462`: both do
`.find(...)!` on a `listByTour` re-read. Once rows can vanish, that is
`undefined` flowing into a view composer - a 500 on operator Cancel or Send now.
Spec now requires an honest 404.

**A6 - legacy sent rows have no `sentBody`. ACCEPT.**
The spec claimed sent rungs "keep their `sentBody` snapshot" as the reason they
are safe to show. Rows claimed before that field existed compose LIVE, which for
an earlier generation means composing against the tour's CURRENT time - the
disclosure would show a past text advertising a future date. Spec now renders
those rows without a body rather than recomposing.

**B5 - the disclosure has no reachable render slot. ACCEPT.**
Verified at `dashboard/src/routes/tours/RemindersPanel.tsx:346`: an empty
`reminders[]` short-circuits to "No reminders armed." and returns. A canceled
tour is exactly that state with a non-empty `earlier[]`, so the disclosure would
be unreachable in the case that needs it most. This is the render-site class of
defect the 2026-08-27 inbox mission was burned by. Spec now specifies the slot
outside the short-circuit.

**A8 / B6 - D4 breaks bottom-anchoring. ACCEPT.**
Verified: the layout effect's deps are `[clusters, resetScrollKey,
paging?.olderPagesLoaded]` (`Timeline.tsx:1920`) - `upcoming` is absent, so a
change to the block's height inside the scroller never re-pins. `atBottom`'s 48px
slack (`:1838`) is smaller than the block. `overflow-anchor: none` (module CSS
:142) blocks browser compensation.

**A9 - uncapping the block can show FEWER messages. ACCEPT, resolved.**
The honest tension: `scrollTop = scrollHeight` plus an uncapped block means the
phone's bottom view is all scheduled cards. Resolution: the block keeps a height
cap inside the scroller. Capped-and-scrolling satisfies the stated intent (see
it at the bottom, gone when scrolled up) without letting it dominate; uncapping
it does not.

## Medium and low - all accepted, folded into the revision

A10 / B11 (e2e blast radius: `scenarios/scheduled-visibility.spec.ts:268` and
`scenarios/steps.ts:3615-3661` both encode the old retirement contract), A11 /
B10 (a terminal tour's panel goes empty - stated, not implied), A13 / B7
(acceptance 8 asserted behavior that already ships - rewritten to assert
deletion, not filtering), B8 (the "interrupted sweep" line was a slogan; only
call ORDER protects the new ladder - reworded), B12 (five `listByTour` sites in
the route, not three; `performanceSeed.ts:167` constructs the repo but writes no
rows), B14 (acceptance 4's `next` clause was vacuous), B15 (`.upcoming` is a
sibling of `.streamWrap`, not `.stream`; the failure code is 404, not 409), A14
(`app/scripts/retire-paused-tour-reminders.ts` is an unlisted writer).

## Accepted as risk, not redesigned

**B9 - `listByTour` is an eventually-consistent GSI query.** D1 makes staleness
user-visible for the first time (a deleted row can still come back on the
immediate re-read). Recorded as a risk with a UI consequence, not designed
around: the panel already refetches on `scheduled.updated` and on its own
dueAt anchor.

**A15 - `listByTour` is unpaginated.** Both the sweep and the read partition
inherit it. At five rungs per generation a tour needs hundreds of reschedules to
approach the 1MB page, but this repo has been bitten by exactly this class
before, so it is recorded rather than dismissed.

**B12 (partial) - `performanceSeed.ts`.** Constructs the reminders repo and
hands it on; whether it writes rows is a plan-time verification, not a spec
claim. Section 4 no longer asserts it does.
