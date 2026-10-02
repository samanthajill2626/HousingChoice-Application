# Spec review r2-b - tour auto-close and reopen (DRAFT 2 @87d4bf2e)

- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` @ 87d4bf2e
- Inputs: the diff edc045c3..87d4bf2e, `adjudications.md`, `spec-r1-a.md`
- Method: read-only. Every claim was checked in the worktree; one TypeScript
  check was run on a scratch file outside the repo (noted under R2-2).

## New findings (draft 2 material first)

### R2-1 [MEDIUM] Rows marked before the deploy have no clock floor, so the first run closes the exact tours D3 exists to protect

**What is wrong.** D3 / 5.3 start the clock at the latest of `createdAt`,
`scheduledAt` and `lastMarkedAt`. `lastMarkedAt` is new: no row written before
the deploy carries it, and there is no migration (section 13). For every
existing row, the clock is therefore `max(createdAt, scheduledAt)`. A mark made
before the deploy counts for nothing.

**Evidence.**
- 5.2: `lastMarkedAt` is written only by the new PATCH (8.4) and by reopen. On main today `app/src/routes/tours.ts:1156-1177` builds no such field.
- D3 states the failure it prevents: "'Mark toured' on day 13 closes the tour within 15 minutes of being recorded - before anyone can record the outcome." For a tour dated more than 14 days ago and marked toured or no-show in the 14 days BEFORE the deploy, the first run does exactly that.
- The Past tab's bulk "Mark toured" (`dashboard/src/routes/tours/ToursPage.tsx:419-476`, on main since late September) exists to mark old "Not marked" rows, so recently marked "Needs outcome" rows dated more than 14 days ago are the expected population, not an edge case.
- Undated toured rows got worse than in draft 1. Section 2.1 still says "An undated toured tour closes 14 days after it was last changed", but 5.3 now uses `max(createdAt, lastMarkedAt)`, which is `createdAt` alone for a legacy row. Example: a requested tour created five weeks ago and marked "already toured" (no date) last week closes on the first run. Draft 1's `updatedAt` clock would have given it until next week.
- The section 13 preview says "plus toured 'Undated' rows created or changed more than 14 days ago". The sweep ignores "changed" for legacy rows. Neither date is visible on the Past tab either: undated rows show only "Undated" (`ToursPage.tsx:195-197`); the creation date is on the tour page (`TourDetail.tsx:298`, `:646`).
- UNVERIFIED: whether the Past tab is deployed to production. RUNBOOK.md has no deploy record for it, and it landed on main 2026-09-27..30 (`git log` of `ToursPage.tsx` / `useTours.ts`). If it ships in this same deploy, the section 13 "preview before deploying" cannot be run.

**What it implies.** The first production run silently closes every
undecided tour marked in the two weeks before the deploy whose date or creation
is older - "No outcome recorded" on tours staff are working right now - and
each one must be reopened by hand (no switch, no bulk reopen). Either give
legacy rows a floor (for example `updatedAt` when `lastMarkedAt` is absent;
for those rows it is never earlier than the last mark, and it needs no
migration), or state in D3, 2.1 and section 13 that marks made before the
deploy are not floored, and fix the preview text to match.

### R2-2 [LOW] 6.2's due filter dropped draft 1's null guard, and nothing in 6.3 backstops it

**What is wrong.** Draft 1 filtered by `autoCloseDueAtMs(tour) !== null && due <= now`.
Draft 2 writes `filtered by autoCloseDueAtMs(tour) <= now`. In JavaScript
`null <= n` is true. `tsc --strict` rejects the literal form (TS2531 "Object is
possibly 'null'", checked with the repo's own `node_modules/typescript` on a
scratch file outside the worktree), so the builder has to add a guard. The
quickest compile fix, `(autoCloseDueAtMs(t) ?? 0) <= now`, makes every
non-candidate due.

**Evidence.** Spec 6.2 vs draft 1 6.2. 6.3's condition pins `status = <status as read>`, not membership in `AUTO_CLOSE_STATUSES`. In the full sweep the read comes from three candidate partitions, so a bad filter is harmless: outcome, convertible and conversion are all in the condition. In the `tourIds` path (6.1), tours are read by id at any status. A canceled, requested, or closed-without-outcome tour would then pass the condition and be closed with `outcome: no_outcome` and `autoClosedFrom: 'canceled'`, a value 7.2 refuses to reopen.

**What it implies.** The path is dev-only, but the spec text is a regression.
Restore the explicit null check in 6.2. Defense in depth would add
`status IN ('scheduled','toured','no_show')` to the 6.3 condition.

### R2-3 [LOW] Section 12's seed claim is false: matrix tours are not "created at seed time"

**What is wrong.** "Full-profile tours are created at seed time, so none is due
for 14 days." The matrix writes explicit PAST `createdAt` and `scheduledAt`.

**Evidence.** `app/src/lib/seed/matrix.ts:911-916` (no_show dated 3 and 5 days back) and `:957-963` (`createdMs = scheduledMs - (2 + rep) days`; the tour item carries that `createdAt`, `:988-999`). Under 5.3 the two matrix no-shows are due 11 and 9 days after a full reseed. Cast and live are as stated: `app/src/lib/seed/live.ts:357-397` uses the seed clock.

**What it implies.** Only the long-lived local demo world is affected (e2e
runs are hours long). Correct the sentence.

### R2-4 [LOW] The new Past tab sentence is false for the common case under D3

**What is wrong.** Section 2 (accepted defaults) and 9.3 append "Tours with no
outcome close on their own two weeks after their date." Under D3, a toured or
no-show tour closes 14 days after its MARK, and those statuses are normally
marked after the date. A tour marked toured a week late closes three weeks
after its date.

**Evidence.** Spec 5.3 "Consequences" and the D3 cost line.

**What it implies.** The staff-facing copy promises an earlier close than the
mechanism delivers. Say "two weeks after their date or their last update"
(or similar).

### R2-5 [LOW] "Reopen tour" becomes up to three same-named controls, two of them on screen at once

**What is wrong.** 9.2 puts Reopen in the kebab "whenever the tour is
reopenable" AND makes it the primary CTA "when the ladder has nothing else" -
which is every reopenable tour without `convertible: true`. The confirm dialog's
title and confirm button are also "Reopen tour".

**Evidence.**
- Today the kebab renders nothing for a closed tour (`dashboard/src/routes/tours/TourActionsMenu.tsx:7`, `:79-89`). Now it appears with a single item that duplicates the visible primary button.
- The shared Modal sets no `inert` or `aria-hidden` on the page behind it (`dashboard/src/routes/contact/Modal.tsx`), so while the dialog is open the header CTA and the dialog's confirm button are both `button` "Reopen tour". A page-scoped `getByRole('button', { name: 'Reopen tour' })` matches two elements (Playwright strict-mode failure), and assistive tech reads two identical buttons.

**What it implies.** Pick one placement per state (kebab only when Start
placement holds the primary slot), and give the confirm button a distinct name.
At least, the e2e must scope to the dialog.

### R2-6 [LOW] The new 409's staff copy does not render as written, and the commoner post-close refusal tells staff to retry

**What is wrong.** 8.3 writes a human `detail` ("This tour changed while you
were saving - reload and try again."). The tour page's direct actions show
`err.message`, which the client builds as `${code} (${detail})`. After a close,
the more common refusal is not `tour_changed` but the existing 409s, which the
consistent read now produces (`illegal_exit_gate`, `illegal_status_transition`).
In the Record outcome dialog they surface as a retry prompt that cannot succeed.

**Evidence.** `dashboard/src/api/client.ts:75-80`; `TourDetail.tsx:348` (runDirect); `TourModals.tsx:304` ("Couldn't record the outcome - please try again.").

**What it implies.** Staff see "tour_changed (This tour changed ...)". In the
outcome dialog they are told to retry a write the server will keep refusing. The
page does self-correct on the `tour.updated` refetch. Either route `detail` (or
a code-to-copy map) to the UI, or drop the claim that the sentence is staff copy.

## Adjudication contests

- B3 (heading rename): CONCEDE. It is a copy call, and D12 surfaces it to
  Cameron. One correction to the stated cost: 11.2 already rewrites
  `today-past-tours.spec.ts`, whose heading is a single constant (`:29`), so
  "churns e2e selectors" is not a real cost.
- B9 (label false for the backlog): CONCEDE. A close needs at least 14 days
  since the latest of the clock anchors, so "after two weeks" is always
  literally true at close time.

## Fixes checked (are they correct, not just plausible)

- B1/A1, PATCH precondition: CORRECT. The consistent read
  (`toursRepo.get(..., { consistentRead: true })` already exists,
  `app/src/repos/toursRepo.ts:325-336`) plus `status = :expected` on the main
  write refuses every pre-close read, because candidates are never `closed`.
  The 404/409 split on CCFE is sound. No later write in the handler touches
  status (`setLadderIdIf` and the reminder sweep are pointer-conditioned).
  The parked-PATCH tests park AFTER the real write (`app/test/toursApi.test.ts:2042-2051`,
  `:2120-2129`), so forwarding the third argument keeps them green with the
  precondition live. Concurrent reschedules still both pass (status unchanged).
  Concurrent bookings or terminals now 409 the loser, which is an improvement.
- B11/A4, clock floor: correct for marks made after the deploy; see R2-1 for
  rows from before it.
- Field-equality conditions (C1): the 6.3 set covers every input of 5.3
  (`createdAt` is immutable). `lastMarkedAt` equality also defeats the ABA case
  close -> reopen -> back to the read status. The 7.3 set is sufficient: a
  second reopen fails `status = 'closed'`; a conversion claim fails
  `attribute_not_exists(convertedPlacementId)`.
- B12/A6, `tourIds` scope: correct apart from R2-2. With the floor, the lane's
  real worker can never close a tour created during a run, so 11.3 (leave the
  fixed-date specs alone) holds.
- B13, guarded close: correct, provided the modal union gains `'reopen'` and
  the dialog keeps the onConfirm-then-onClose order (`TourModals.tsx:218-219`
  pattern).
- B10 (chip), B14 (StaffTourOutcome), B4/A2 (today-past-tours rewrite): correct.
  The rewrite's "Open the Past tab" (3 of 3 listed) and "See all 7" (5 of 7)
  both follow from `Today.tsx:241`.
- The only `ToursRepo` implementation besides the real one is the harness fake
  (`app/test/helpers/twilioWebhookHarness.ts:3463`), so the two new methods
  need no other test fakes.
