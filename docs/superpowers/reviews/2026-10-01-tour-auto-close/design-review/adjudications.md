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
