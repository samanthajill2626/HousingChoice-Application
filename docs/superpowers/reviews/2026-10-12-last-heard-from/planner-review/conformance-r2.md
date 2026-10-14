# Planner spec-conformance review, round 2 - feat/last-heard-from @ 814cc258

Reviewer: the planner's spec-conformance reviewer (read-only; a gate battery
was live, so no tests, npm or npx were run). Scope: the planner fix wave
`.superpowers/review/planner-fixwave.diff` (8d365094, 814cc258 on 6f0673c9),
the planner's `adjudications.md`, and a second pass over the branch against
the spec.

## Result

Nothing new. No BLOCKING, HIGH, MEDIUM or LOW findings in this round. The fix
wave is correct, not just plausible. I contest none of the adjudications.

## 1. What did we all miss against the spec?

Nothing I can defend with a file:line. I re-checked areas round 1 only skimmed.
All conform:

- Spec 5.6, ordering of groups by their oldest waiting row: the server sorts
  globally by oldest `waitingSince` (`app/src/services/followUps.ts`, the step-5
  sort), and `groupByUnit` keeps the order each property first appears
  (`dashboard/src/routes/broadcasts/FollowUpView.tsx:39-50`). So group order =
  oldest row first.
- Spec 5.6 option C, "one extra request per Properties list load, no second
  walk": its own hook makes one `getFollowUps` call per mount
  (`dashboard/src/routes/listings/useFollowUpCounts.ts`) and reads the same
  `byUnit` the tab reads.
- Spec 14.4, the count fetch runs on Matching mount whatever tab is active:
  `useFollowUps()` is called unconditionally (`BroadcastsList.tsx:58`).
- Spec 5.3, a hand-added row keeps its "Added" tag and slots into place:
  `RecipientPreview.tsx:581-586` plus the combined `orderedRows` sort (`:194-206`).
- Spec 5.4, the contact host's per-click unit override is cleared on close and
  on create (`ContactDetail.tsx:1386-1398`).
- Spec 5.1, the email attribution thread is the ALL_NEW snapshot from
  `touchLastActivity`, else a re-read (`inboundEmail.ts:822`).
- Spec 5.1, native-group dedupe onto a foreign conversation returns before the
  touch (`twilio.ts:2115-2125`), so a touch never attributes on the wrong thread.

The adversarial A2 (an email auto-reply moves the value) is not a spec miss.
G1 counts any "inbound email from that contact", and "outbound and automated
sends never move it" refers to OUR sends (spec 2, 5.1). Filing it as an issue
is the right call (see section 3).

## 2. The fix wave (unreviewed code)

### 8d365094 - follow-ups drop sends outside LOOKBACK before any join

`app/src/services/followUps.ts`, step 2: `lookbackFloor = deps.now -
FOLLOW_UP_LOOKBACK_MS`. A row is kept when `Date.parse(sentAt)` is finite and
`>= lookbackFloor`.

- It never drops a row that could wait. `isWaiting` excludes a row when
  `now - sentMs > FOLLOW_UP_LOOKBACK_MS` (`app/src/lib/listingSendOutcome.ts:246`),
  so it keeps exactly `sentMs >= now - LOOKBACK`. That is the same predicate,
  the same clock (`deps.now`) and the same parse (`Date.parse`, finite only;
  `instantMs` `:155-159`). The old row loop also skipped a row with no string
  `sentAt` (step 4 type guard), so that behavior is unchanged too. The set of
  waiting rows is therefore identical before and after the change.
- LOOKBACK is still 14 days: the module's own constant is imported and not
  redefined (`listingSendOutcome.ts:145`).
- `byUnit` is still counted from the KEPT `items` (step 5, unchanged), so it
  equals the item count per unit; a property whose rows are all old now gets
  no key, which is what it got before.
- `truncated` comes from the units walk (step 1, unchanged), so the cap still
  counts KEPT units, not units with recent sends. That matches spec 5.6 / 14.4
  B5.
- D12 still holds: the recent rows' contacts are read in one `requireComplete`
  batch, and a failed tours or contacts read still rejects, so the route
  answers 503 (`broadcasts.ts:1072-1085`). Narrowing the batch to recent
  recipients cannot hide a row, because the dropped rows could never be served.
- Side effects that are fine: a unit with no recent sends gets no tours read
  (already true for a unit with no sends), and a missing contact behind an old
  row no longer matters (it could never be shown).
- Tests: the new unit cases pin the work saved, i.e. no tours read and no
  contacts read for old rows (`app/test/followUps.test.ts:+246-277`). The
  existing "15 days drops / 13 days stays" case (`:128`) and the exact-boundary
  `isWaiting` case (`listingSendOutcome.test.ts:225`) still pin the boundary.
  I did not run them; the handback's gate results do not cover this commit.

Verdict: CORRECT. It only changes which rows get read before the filter, not
what the list shows.

### 814cc258 - the Tenants facets e2e proves the placed tenant comes back

`e2e/tests/dashboard-next/contacts-list-facets.spec.ts`:
- After "Show all statuses" and an empty search, it now asserts the placed row
  AND the inactive row are listed. All seven chips are lit, so
  `matchesStatus` passes both (`tenantFacets.ts:270-273`).
- Starting from the default + Inactive, a Placed chip click adds placed. The
  test asserts `aria-pressed=true`, the placed row listed and `status=placed`
  in the URL. Default + inactive + placed is all seven, which is not the
  default, so `applyToParams` writes every value (`tenantFacets.ts:224-236`).
  The test then toggles placed back off.
- The later Sort-by/reload block still expects Inactive pressed and Placed
  unpressed. That stays consistent, because placed was toggled off before it.
- The rows are matched on run-unique first names (`StatusPlaced...`,
  `StatusInactive...`, `StatusReplied...`), which do not collide.

This now meets spec 8 (2), "the status chips bring them back", for both hidden
statuses. Spec 14.5 F1/F12 behavior is untouched, and the chip toggling relies
on the inverted-set rule as designed. Closes round-1 finding 3 (C3).

## 3. Adjudications

- C1, C2 (spec 14.7 goes to Cameron, recommend approve): concede.
- C3 (fixed): concede; verified above.
- C4 (defer the aria-hidden header as a low issue): concede. The spec does not
  require accessible column headers, and plan P1 holds.
- C5, C6 (note only): concede.
- D1-D3: concede (I already agreed with all three in round 1).
- A1 (fixed): concede; verified above.
- A2 (defer the email auto-reply as a med issue): concede. Not a spec
  violation (G1 counts any inbound email), and fixing it needs headers the
  ingest stores only partially.
- A3, A4, A5 (note): concede. A4 is the spec's own one attribution rule
  (5.1 / 14.2).
- A6 (defer the join duplication as a low issue): concede.

Contested: none.

## 4. Correct or merely plausible?

Correct. The early filter is the same predicate `isWaiting` already applied,
moved before the reads. Its result set, `byUnit` and `truncated` are provably
unchanged, and the e2e additions assert exactly what spec 8 (2) says. One
caveat: no reviewer has run the new tests; that evidence has to come from the
running gate battery.
