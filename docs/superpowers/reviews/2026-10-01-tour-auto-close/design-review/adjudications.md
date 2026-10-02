# Design review adjudications - tour auto-close and reopen

Planner adjudication of the adversarial spec and plan reviews. ACCEPT = the
doc changes; REJECT = with the reason; DEFER = filed to `docs/issues/`.
"Decision changed" is the planner's call (what gets built, a surface added or
removed, an invariant moved), not the reviewer's severity.

## Spec round 1 (draft 1 @edc045c3)

Two independent reviewers, same brief: A = `spec-r1-a.md`, B = `spec-r1-b.md`.

### Reviewer A

| # | finding | ruling | decision changed? |
|---|---|---|---|
| A1 | A staff PATCH whose read precedes the close lands on top of it (read `tours.ts:1057` is eventually consistent; `toursRepo.patch` conditions on existence only, `toursRepo.ts:422`) -> live tour carrying `no_outcome`, unreachable by any button | ACCEPT. Verified. PATCH gains a consistent read plus a write-time precondition on the status it read (`status = :read` -> 409 `tour_changed`; a failed condition on a missing tour stays 404). Section 8 changes; the issue `tours-patch-status-precondition` is narrowed (server-side window closed; the client's stale-list window remains, its residual stays open). The relay-open race on the same root cause (`tourOpenGuard` on a read, `claimGroupThread` with no status condition) is DEFERRED: same pre-existing class as two staff racing today, needs a 14-day-old tour opened in the same second it closes | YES (PATCH contract, new 409) |
| A2 | `today-past-tours.spec.ts` asserts no-shows are NOT on Today; stale comments in `Today.tsx` / `useTodayPastTours.ts` | ACCEPT. Section 11 lists the spec rewrite (it becomes the home of e2e item 4) and the comments | YES (surface added) |
| A3 | The section 13 preview (Past tab) is blind past 90 days; a reopened tour older than 90 days is on no list | ACCEPT as a correction: section 13 states the blind spot (those tours are on no list today either, so closing them hides nothing) and adds the after-the-fact check (Closed tab, newest first, "No outcome recorded" badge); 7.5 / 9.3 state that such a reopened tour is reached from its page or the contact / property tour cards | NO (text) |
| A4 | A tour recorded late (Mark already toured with an old date, Book / Reschedule "anyway" into the past) is already due and closes within one sweep interval, while the undated twin gets 14 days | ACCEPT. The clock gains a floor: it never starts before the tour was created or last marked by a person (new `lastMarkedAt`, stamped by every PATCH that writes `status` or `scheduledAt`, and by reopen). Clock = max(`scheduledAt`, `createdAt`, `lastMarkedAt`) + 14 days; undated tours use max(`createdAt`, `lastMarkedAt`). This replaces `reopenedAt` and the `updatedAt` clock of D3. Planner decision recorded as D3 (rewritten) - it refines Cameron's "exactly 14 days after the tour time" for tours marked after their date | YES (clock rule, attribute set) |
| A5 | Section 10.2 claims the Past tab refetches on `tour.updated`; it subscribes to nothing | ACCEPT as a correction. Live refresh of the Past / Closed tabs stays out of scope (a loaded list; bulk actions reload; a stale row's action meets the 409s) | NO |
| A6 | The e2e "+15 days" tick sweeps the whole lane; clocks mixed | ACCEPT. The dev tick takes an optional `tourIds` list that scopes the sweep to those tours (dev-only); the e2e spec always passes it. Stamps (`autoClosedAt`, `updatedAt`, the nag) use the wall clock; the injected `now` only selects due tours (stated in 6.3) | YES (dev seam shape) |
| A7 | An undated `no_show` is reachable through the API and would never close | ACCEPT. Resolved by A4's rule: every undated candidate uses max(`createdAt`, `lastMarkedAt`); no status-specific undated branch | NO (folded into A4) |
| A8 | Three inaccurate statements (moveForward/convertible can be false on a candidate; the sweep deletes skipped/canceled history rows too; section 1 "any closed tour") | ACCEPT. Text fixed; e2e must not expect a `booked_too_late` row to survive a close | NO |
| A9 | Which CTA wins on a closed, unconverted tour with `convertible: true` (performance seed `performance.ts:660-664`, or the API) | ACCEPT. "Start placement" stays primary (existing ladder order); "Reopen tour" is ALSO always offered in the kebab when the tour is reopenable, and is the primary CTA only when the ladder has nothing else | YES (UI placement) |

### Reviewer B

| # | finding | ruling | decision changed? |
|---|---|---|---|
| B1 | = A1 (PATCH race) | ACCEPT (merged with A1) | YES (see A1) |
| B2 | = A3, plus: the range read is also ONE page | ACCEPT (merged with A3; the blind-spot text names both limits) | NO |
| B3 | Section 15 marks `past-tab-no-show-rows-need-an-exit` resolved although staff still have no exit; Today then carries un-clearable no-show rows for 14 days under "Past tours needing an outcome" | PARTLY ACCEPT. The issue is closed BY PRODUCT DECISION (Sam, Sep 30: "the two-week close above covers it"; no manual exit) and the RESOLVED block must say exactly that, not claim a staff exit. The 14-day Today residency and "All caught up" not showing meanwhile are stated as accepted consequences of decision 5. REJECT renaming the Today heading: Sam's tracker and the shipped copy use "Past tours needing an outcome", the rows link to the follow-up action, and a rename churns e2e selectors and the tracker for a cosmetic gain - offered to Cameron as a copy option in the handback | NO (text; heading unchanged) |
| B4 | = A2 (today-past-tours.spec), plus: with every row listed the link changes from "See all N" to "Open the Past tab" (`Today.tsx:241`, `:255-257`) | ACCEPT (merged with A2; the link rule is named in 9.4 / 11) | YES (surface, see A2) |
| B5 | = A5 | ACCEPT (merged) | NO |
| B6 | = A8 (reminder history deletion), plus: the first production run deletes that history across the whole backlog | ACCEPT; section 13 states it | NO |
| B7 | = A7 + A8 (undated no_show also via toured -> no_show; moveForward/convertible false; section 1 wording) | ACCEPT (merged; the clock rule of A4 covers undated tours of every candidate status) | NO |
| B8 | = A9 | ACCEPT (merged) | YES (see A9) |
| B9 | The first run writes "closed automatically" pins dated the deploy day on tenant AND landlord timelines (and property + tour activity); decision 4 names only the tenant | ACCEPT as text: 4 / 10.1 name both parties (every tour event already writes both), section 13 describes the burst. REJECT that the label becomes false for the backlog: "no outcome recorded after two weeks" is still true of a tour that went months without one | NO |
| B10 | D8 calls the listing-send chip "unchanged", but every toured-no-outcome tour loses its "Toured" chip on the first sweep; the chip spec's honest-floor rationale applies to `autoClosedFrom: 'toured'` | ACCEPT. `listingSendTour.ts` treats a closed tour with `autoClosedFrom === 'toured'` as "Toured" (the visit happened; only the decision is missing). Auto-closed from `scheduled` / `no_show` keeps no chip | YES (reader changed) |
| B11 | = A4 | ACCEPT (merged) | YES (see A4) |
| B12 | = A6 | ACCEPT (merged) | YES (see A6) |
| B13 | Chaining Reopen into Record outcome repeats the modal-slot trap (`TourDetail.tsx:820-829`; every modal in `TourModals.tsx` calls onConfirm then onClose) | ACCEPT. 9.2 requires the reopen dialog's close to use the same guarded functional update the "already toured" dialog uses | NO (precision) |
| B14 | Widening the dashboard `TourOutcome` lets `patchTour` compile `outcome: 'no_outcome'`, which the server 400s | ACCEPT. Dashboard gains `StaffTourOutcome`; `patchTour` and the Record outcome dialog type with it | NO (precision) |

### Round 1 result

Decisions changed (PATCH contract, clock rule and attribute set, dev seam
shape, CTA placement, listing chip reader, e2e surface) -> round 2 runs on
draft 2. Reviewer B landed more accepted unique findings (B3, B9, B10, B13,
B14) and is continued with SendMessage; it gets A's report path.

Planner self-corrections folded into draft 2 (found while reading for the
plan, not by a reviewer):

- C1 Conditional writes use FIELD equality, never `updatedAt` equality: every
  repo write stamps `new Date().toISOString()`, so two writes in the same
  millisecond are indistinguishable (a flaky guard, worst in the harness fake
  under fast tests).
- C2 `autoClosedAt` / `updatedAt` are stamped with the wall clock (repo
  convention); the sweep's injected `now` only selects due tours.
- C3 The in-memory harness `toursRepo` must implement the new conditional
  methods with the SAME conditions as the real repo, plus a DynamoDB Local
  integration test of the real ones.

## Spec round 2 (draft 2 @87d4bf2e)

One reviewer (B, continued). Report: `spec-r2-b.md`.

| # | finding | ruling | decision changed? |
|---|---|---|---|
| R2-1 | Rows marked BEFORE the deploy carry no `lastMarkedAt`, so the first run closes tours marked toured / no-show / rescheduled in the two weeks before the deploy whose date or creation is older - the case D3 exists to prevent; legacy undated rows got worse than draft 1; the preview text ("created or changed") matches neither the sweep nor the Past tab | ACCEPT. Clock floor = `lastMarkedAt` when present, otherwise `updatedAt` (for a row no person has marked since the feature shipped, `updatedAt` is never earlier than its last mark; no migration). Section 2.1 and 13 re-worded to match. The reviewer's UNVERIFIED point is settled: the Past tab is live in production since Sep 28 (tracker #18 note), so the preview can be run before deploying | YES (clock rule) |
| R2-2 | 6.2 dropped draft 1's null guard (`null <= n` is true in JS); in the `tourIds` path a non-candidate status would pass the 6.3 condition | ACCEPT. 6.2 names `isAutoCloseDue` (null-safe); `autoCloseIf` refuses a non-candidate status up front without writing (defense in depth) | NO (precision) |
| R2-3 | Section 12's seed claim is false: the matrix writes past `createdAt` / `scheduledAt` (`matrix.ts:911-916`, `:957-963`); its no-shows are due 9 and 11 days after a full reseed | ACCEPT as a correction (local demo world only; e2e uses lean, which has no tours) | NO |
| R2-4 | The Past tab sentence ("two weeks after their date") is false for the common case under D3 | ACCEPT. Copy: "Tours with no outcome close on their own two weeks after their date or their last update." | NO (copy) |
| R2-5 | "Reopen tour" can be three same-named buttons (primary, a kebab that today renders nothing for a closed tour, and the dialog's confirm); the shared Modal does not make the page inert, so a page-scoped selector hits two | ACCEPT. One placement per state: primary CTA when the ladder has nothing else; kebab ONLY when "Start placement" holds the primary slot. The dialog's confirm button is "Yes, reopen" (not a substring collision with "Reopen tour") | YES (UI placement) |
| R2-6 | The 409 `detail` is not standalone copy (the page shows `code (detail)`); after a close, the commoner refusal (`illegal_exit_gate` from an open Record outcome dialog) shows "please try again", which cannot succeed | ACCEPT. Spec stops calling the detail staff copy (it renders like every other 409 today). The Record outcome dialog maps an `ApiError` 409 to "This tour changed since the page loaded - reload and try again." (the Reopen dialog's copy); other tour dialogs unchanged | YES (small surface) |

Contests: B3 (heading rename) and B9 (label "false") - the reviewer CONCEDED
both (with the correction that the Today spec's heading is one constant, so
the e2e churn cost was overstated; the rename stays Cameron's copy call).

Fixes the reviewer verified as correct: the PATCH precondition and
consistent read (parked tests park after the real write), field-equality
conditions (including the close -> reopen -> same-status ABA case), the
guarded close, the listing chip, `StaffTourOutcome`, the Today e2e rewrite,
`tourIds` scoping, and that the harness fake is the only other `ToursRepo`.

### Round 2 result

Decisions changed (legacy clock floor, Reopen placement, Record outcome 409
copy) -> round 3 on draft 3, same reviewer, in parallel with plan round 1.

## Spec round 3 (draft 3 @579a810b)

Reviewer B continued. Report: `spec-r3-b.md`. Headline: nothing at MEDIUM or
above; every writer of a tour's `updatedAt` is person-triggered or at create
time (background jobs only read tours), so the legacy floor can neither hold
a candidate open forever nor close one early.

| # | finding | ruling | decision changed? |
|---|---|---|---|
| R3-1 | The `updatedAt` fallback governs every tour no person has marked yet, not only pre-deploy rows (create writes no `lastMarkedAt`), so a group open or roster edit after the date postpones a never-marked tour's close | ACCEPT as a statement in 5.3 (no build change): the effect can only postpone, never strand or close early; stamping `lastMarkedAt` at create was considered and not taken - it adds a write surface for a practically nil difference (writes to a never-marked tour after its date are rare) | NO (text) |
| R3-2 | D14's reason applies equally to the Reschedule / Book and Cancel dialogs (and Mark already toured): a 409 there also says "please try again" | ACCEPT. D14 widened to every writing tour dialog (one shared constant); the same decision applied consistently, no new mechanism | NO (precision of D14) |
| R3-3 | Section 13 claims the tour page's history shows when an undated row last changed; it does not (roster edits / outcome-only patches move `updatedAt` with no history row) | ACCEPT. Text corrected; that part of the preview errs safe | NO (text) |

### Round 3 result - TERMINAL

No accepted finding changed what gets built, added or removed a surface, or
moved an invariant (R3-2 completes D14's own coverage). Precision edits
folded in; the spec is APPROVED by the planner under Cameron's overnight
authority (2026-10-01). Spec rounds: 3 of the 4-round cap.
