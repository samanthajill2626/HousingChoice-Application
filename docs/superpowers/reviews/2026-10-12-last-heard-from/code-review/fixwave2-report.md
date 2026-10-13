# Code review round 2 - fix wave 2 (FW2) - decisions record

Date: 2026-10-13. Branch `feat/last-heard-from`, base d790d199 (round-2
adjudications + spec 14.7). Scope: every ACCEPTED item of
`adjudications-round2.md` except A R2-3 (issue filing - the orchestrator's)
and A R2-4 (filed, no change). Strict TDD: a RED test before every behavior
change, run and confirmed red for the stated reason. No slow gate was run
(no `npm test`, `npm run e2e`, `npm run smoke`); Playwright was not run.

## Commits (one per item; 2+3 and 4+5 were NOT combined)

| item | commit | what |
|---|---|---|
| 1 A R2-1 | 830c07b0 | durable tour supersession: `deriveTourActivityAt` counts every tour's createdAt, qualifying tours' lastMarkedAt only |
| 2 B R2-1 | 2133a181 | `clearDeclined(..., { expectedAt })` compare-and-clear; Interested clears only the decline it read; never a 404 from that clear |
| 3 B R2-2 (1) | ade0b9b6 | Interested clears the decline it read whatever its effectiveness; cleared event only when effective |
| 4 B R2-2 (2) + A R2-2 | b9fe2638 | any throw after a write answers 503 `{ error: 'outcome_unavailable', saved: true }`, logged with ids |
| 5 B R2-3 | 421c8e37 | Undo sets `wrote` from `hadDecline`; outcome route header states the final behavior (spec 14.7) |
| 6 B R2-4 | e6d6d79a | FollowUpView resolves from the RETURNED row (`row.outcome`, `row.tour`) |
| 7 B R2-5 | 21258378 | 409 `tour_type_required` on a route-mode Interested falls through to the form path (`isTourTypeRequired`) |

`npm run typecheck` exit 0 after every commit. eslint exit 0 on every
touched `.ts` / `.tsx` file. Every added line ASCII (checked on the diff).

## Per item - evidence and decisions

### 1. A R2-1 - durable supersession (830c07b0)
- Change: `app/src/lib/listingSendTour.ts:116-129` - a non-qualifying tour
  contributes `[createdAt]`, a qualifying one `[createdAt, lastMarkedAt]`
  (:119). `deriveTourSignal` (the wire `tour`) is untouched. Doc comment and
  module header restate the rule citing 14.7; the `declined` field comment
  at `app/src/repos/listingSendsRepo.ts:106-118` now states the durable rule
  (and that a superseded record stays on the row, simply ineffective).
- RED: `app/test/listingSendTour.test.ts:215` (expected undefined to be
  '2026-11-01...') and the three "created T2 > T1 later canceled / no_show /
  closed not a fit -> NOT not_interested" cases in
  `app/test/listingSendOutcome.test.ts:107` (expected true to be false).
  The "created T0 < T1, marked T3 > T1 -> still not_interested" cases and the
  qualifying-reschedule contrast are green on the old code by design (the
  mark-never-supersedes half did not change).
- Every outcome surface takes the rule through the one function (units
  recipients + outcome route, contacts listings-sent, broadcasts
  effectiveDeclines, followUps) - no caller changed.
- Observation: `listingSendOutcomeApi.test.ts` "409 tour_type_required ...
  decline kept" seeds a canceled tour stamped at the harness's now, which
  under 14.7 supersedes its 06-25 decline; the test asserts only the 409 and
  the stored record, so it is unaffected (the 409 precedes any clear).

### 2. B R2-1 - compare-and-clear (2133a181)
- Repo: `listingSendsRepo.ts:204-211` (interface doc) and :398-427 - with
  `expectedAt` the condition gains `#declined.#at = :readAt` (:410); an
  absent record fails it too. ConditionalCheckFailed -> 'not_found' as
  before. Without `opts` the clear is the old idempotent one (the Undo
  branch still uses it - see "not changed").
- Fake: `app/test/helpers/twilioWebhookHarness.ts:3476-3481`; parity case
  `twilioWebhookHarnessRepoAdditions.integration.test.ts:1060` (absent row,
  no record, stale record, uncounted row -> not_found; the named record
  clears once). Integration: `listingSendsRepo.integration.test.ts:203`,
  :222.
- Route: `app/src/routes/units.ts:1357-1361` passes the read decline's `at`.
  A 'not_found' records nothing and is NEVER a 404 (the round-1 "404 when
  no create" branch is gone); it falls through to the re-projection.
- RED: integration :203 (expected 'ok' to be 'not_found'); parity step 2;
  route `listingSendOutcomeApi.test.ts:544` (B's interleaving: clearDeclined
  not called with the expected record), :570 (outcome interested, B's
  decline lost), :592 (expected 404 to be 200). The uncounted integration
  case :222 is a pin (green before - the counted condition already failed).
- Decision: when the compare loses because the row stopped counting and no
  tour was created, the re-projection answers the plain 503 (the click wrote
  nothing) rather than the old 404.

### 3. B R2-2 part 1 - clear what was read (ade0b9b6)
- Route `units.ts:1357-1371`: the clear runs whenever the row carried a
  decline; `wrote` on 'ok' (:1360); `listing_decline_cleared` only when
  `declineEffective` (:1361, judged on the tours as read, before the create).
- RED: `listingSendOutcomeApi.test.ts:356` (clear not called), :373 (the
  retry left the stale decline), :397 (503 lacked saved).
- Decision: clearing a SUPERSEDED record counts as a write for `saved` (it
  changed the row though not the outcome); pinned at :397.
- Knowing rewrite: "a SUPERSEDED decline is left on the row (inert) - no
  clear, no event" became :356 "a SUPERSEDED decline is cleared too ... - no
  event".

### 4. B R2-2 part 2 + A R2-2 - never a bare 500 after a write (b9fe2638)
- Route `units.ts:1290-1442`: the whole write + re-projection section runs
  under one try; the catch rethrows when `!wrote` (a throw before any write
  stays the generic 500 - the existing create-failure pin still answers
  500) and otherwise logs `outcome: failed after a write - 503 saved` at
  error with `{ err, unitId, contactId, outcome, tourCreated }` and answers
  503 `{ error: 'outcome_unavailable', saved: true }` (:1439-1441).
- Divergence (form, not contract): one guard around the section rather
  than a try around the one throwing call, so "any throw after a write" holds
  for future code too. The 140 lines are re-indented under the try (done by
  a line-indent script, verified by `git diff -w`: +11 lines).
- RED: `listingSendOutcomeApi.test.ts:499` (expected 500 to be 503). It also
  asserts the log line carries the ids and no name or phone.

### 5. B R2-3 - Undo `wrote` from `hadDecline` (421c8e37)
- Route `units.ts:1395`. RED: `listingSendOutcomeApi.test.ts:181` (the 503
  carried saved). A sibling pin (an Undo that removed a decline -> 503
  saved:true) is green before and after.
- The route header comment (`units.ts:1207-1243`) and the `wrote` comment
  now state the final behavior exactly, citing spec 14.7.

### 6. B R2-4 - FollowUpView resolves from the returned row (e6d6d79a)
- `dashboard/src/routes/broadcasts/FollowUpView.tsx:80-85` (the resolution at
  :83-85): `interested` ->
  the tour chip (or "Interested"), `not_interested` -> the chip + Undo,
  anything else (no_reply / replied) -> `onUnresolve` (back to waiting).
- RED: `FollowUpView.test.tsx:194`, :206, :216 (the row showed the outcome
  the click asked for).
- Knowing rewrite: the action tests' mocks answered a bare `{ row: {} }`;
  they now carry the outcome the route would re-project (:125-130 and the
  others named in the commit).
- Note: a row put back to waiting keeps the served item's chip text
  (`item.outcome` / `waitingSince`), as Undo already did.

### 7. B R2-5 - 409 tour_type_required falls through to the form (21258378)
- Helper `isTourTypeRequired(err)` at
  `dashboard/src/lib/listingOutcomeErrors.ts:25` (ApiError, 409, code
  `tour_type_required`). SendRosterRow (`dashboard/src/routes/contact/Card.tsx:329`)
  calls `onOpenTourForm` for an `interested` failure when the host passes
  one, else shows the existing "Couldn't save - try again."; FollowUpView
  (`FollowUpView.tsx:89`) navigates to `tourFormPath` (:72, the same URL its
  form-mode click uses, now shared).
- RED: `listingOutcomeErrors.test.ts` (not a function),
  `SendRosterRow.test.tsx:190` (onOpenTourForm not called),
  `FollowUpView.test.tsx:232` (path unchanged). :200 (no host -> the error
  line) is a pin.

## Not changed (outside the ruled list)
- The Undo (clear) branch still uses the bare idempotent `clearDeclined`; a
  decline someone records while an Undo is in flight could still be removed
  by it. Not ruled; recorded for the orchestrator.
- A R2-3 (issues) and A R2-4 (Undo accessible names) untouched, as ruled.

## Knowing rewrites (rewritten, never deleted)
- `app/test/listingSendOutcome.test.ts:99-149` - the round-1 ADV-1 PIN now
  pins the durable rule in both directions (item 1).
- `app/test/listingSendTour.test.ts:211-233` - "non-qualifying tours
  contribute nothing" now pins createdAt-only (item 1).
- `app/test/listingSendOutcomeApi.test.ts:351-371` - the superseded decline
  is cleared, no event (item 3).
- `dashboard/src/routes/broadcasts/FollowUpView.test.tsx` - the action mocks
  carry `outcome` (item 6).

## Test runs (final, after the last code commit)
- app: listingSendOutcome 46, listingSendTour 25, listingSendOutcomeApi 41,
  listingSendsApi 25, listingSendsRepo.integration 14,
  twilioWebhookHarnessRepoAdditions.integration 25, followUps 14,
  followUpsApi 4, broadcastApi 109 - 9 files, 303 passed; no
  `[dynamoAdmin]` line.
- dashboard: SendRosterRow 22, FollowUpView 22, BroadcastsList 26,
  ListingDetail 102, files 53, listingOutcomeErrors 3, ContactDetail 132,
  TenantFile 5 - 8 files, 365 passed.
- `npm run typecheck` exit 0.
