# Fix wave 2 - round-2 adjudications

Base `@8d608be7`, head `@32f28617`. Six commits, all six adjudication items
implemented, no item deferred. Strict TDD: every behavioural change was watched
RED first, and the RED is quoted below rather than asserted.

## Commits

| commit | what |
| --- | --- |
| `53833e58` | fix 1 - the sweep is generation-scoped and TRANSACTIONAL (repo + fake + DDB-Local tests, callers pass their pointer) |
| `64b10aaa` | fix 3 - opt-in `consistentRead` on `toursRepo.get` |
| `c3dc8fb6` | fix 2 + fix 6 - the three callers reordered, ownership reads gone, B1's caveat cleaned up |
| `b6630fcf` | fix 4 - `conversionClaimedAt` |
| `f92d506b` | fix 5 - `conversion_in_progress` on the three preview surfaces + the dashboard census |
| `32f28617` | gate-5 follow-up - the `DeleteCommand` import the rewrite orphaned |

## The new sweep contract, byte for byte

```ts
deleteSupersededForTour(tourId: string, expectedPointer: string): Promise<void>;
```

- Candidates: `rows.filter((r) => r.sentAt === undefined && r.ladderId !== expectedPointer)`.
- One `TransactWriteCommand` per candidate, items in this ORDER (the order is
  load-bearing - `CancellationReasons` comes back positionally):
  - item 0 `ConditionCheck` on the TOURS table, `Key: { tourId }`,
    `ConditionExpression: '#cl = :expected'`, `#cl = currentLadderId`,
    `:expected = expectedPointer`.
  - item 1 `Delete` on the reminders table, `Key: { reminderId }`,
    `ConditionExpression: 'attribute_not_exists(#sentAt)'`.
- Sequential loop, not `Promise.allSettled` (a lost pointer check must stop the
  rest; ladders are five rungs at most).
- `TransactionCanceledException` handling: reason[0] `ConditionalCheckFailed` ->
  `log.info` "a newer generation owns this tour - stopping" and `break`;
  reason[1] `ConditionalCheckFailed` -> `log.debug` "row was sent since the list
  - keeping" and `continue`; anything else -> `log.error` and continue. Never
  throws for any of the three.
- Summary `log.info({ tourId, expectedPointer, deleted }, 'superseded tour
  reminders deleted')` always runs, `break` included.
- The tours table name comes from `tableName('tours', deps.env)`, resolved once
  in the factory beside the repo's own table.

FAKE (`twilioWebhookHarness.ts`): same two filters, then a synchronous
`toursMap.get(tourId)?.currentLadderId !== expectedPointer` re-check BEFORE each
delete, returning (stopping) on a mismatch. No transactions - the map is
strongly consistent, so the re-check is the honest mirror.

TransactWriteItems behaved normally against DynamoDB Local across both tables.
Nothing to escalate.

## Per fix

### 1. Transactional generation sweep - DONE

RED: with a plain per-row `DeleteCommand` (candidate filter already in place),
the new "the POINTER moving mid-sweep STOPS the sweep and the remaining rows
SURVIVE" case reported `expected [] to have a length of 2 but got +0` - all
three candidates deleted. The naive version also could not fail the injected
per-row error case (`expected [] to have a length of 1 but got +0`), because
that fixture now throws on a `TransactWriteCommand`.

Three DDB-Local cases as briefed, in the existing `deleteSupersededForTour`
describe: (a) the normal sweep, extended with a CURRENT-ladder unsent row that
must survive - which is what lets the re-arm caller sweep after it arms; (b) the
pre-existing sentAt-mid-sweep case, retargeted; (c) the pointer-moves case
above, driven by an injected doc wrapper that rotates the tour on the first
delete-shaped command, asserting two survivors, the info line and ZERO error
lines. Fake parity case added alongside.

### 2. Callers reordered - DONE

Re-arm: `arm -> setLadderIdIf -> if WON sweep(tourId, ladderId)`. CAS loss
sweeps nothing, keeps its `log.error`, and rebuilds the response from
`tours.get(tourId, { consistentRead: true })`. Arm failure keeps its log and
rethrow.

TWO consequences of the sweep moving below the arm, both deliberate and both
re-asserted in the tests that used to encode the old order:
- an ARM failure now leaves the OLD generation in the store (unpointed, refused,
  `earlier[]`-visible) instead of an empty ladder. Strictly more recoverable.
- a SWEEP failure is no longer the disarmed end state at all - the pointer names
  a real ladder - so the log line was reworded from "tour is DISARMED until the
  next reschedule" to "the superseded generation survives, refused but visible,
  until the next sweep".

DEVIATION (small, recorded): when the arm returns `ladderId === null` there is
no pointer write to win or lose, so the branch sweeps against `rotation`, which
is then final and matches nothing - the terminal branch's exact shape. Without
it, a re-arm that arms nothing would leave the old ladder alive, which is the
one case the old pre-arm sweep covered for free. The spec's step 4 says nothing
about this cell.

Terminal: `patchedStatus !== currentStatus` added (NEW-4), same transactional
sweep against `rotation`, try/catch + `log.error` + rethrow, and the stale
"no try/catch posture" comment replaced.

Conversion: post-finalize read removed; sweep in the existing best-effort
try/catch.

RED evidence:
- NEW-4's "REPEAT terminal PATCH ..." fails against the previous callers
  (`vitest -t "REPEAT terminal PATCH"` exit 1).
- R2-1's "TERMINAL vs REVIVAL ..." fails with the generation guard neutered
  (`expected false to be true` - the revival's row is deleted). **It PASSES
  against the old caller order once the sweep is generation-scoped**, because
  the defect dies with the sweep redesign rather than with the reordering. Both
  neuterings were temporary and fully reverted (`git diff --stat` clean on both
  files before the commit).
- Four pre-existing tests broke as predicted and were updated, not deleted:
  the conversion concurrency test (now asserts the store refused the sweep and
  that NOTHING is logged at error), the B1 test (fix 6), the arm-failure test
  and the sweep-failure test.

### 3. Consistent read - DONE

`get(tourId, opts?: { consistentRead?: boolean })`, `ConsistentRead` spread in
only when asked (never written `false`). Fake ignores it, with a comment saying
why. Used at exactly one call site: the CAS-loss re-read in `tours.ts`.

RED: the repo test asserts the `GetCommand` input through an injected doc
wrapper and saw `[undefined, undefined, undefined]` against the expected
`[undefined, true, undefined]`.

### 4. conversionClaimedAt - DONE

`claimConversion` SETs `#cca` in the same write as the sentinel;
`releaseConversionClaim` REMOVEs both; `TourItem.conversionClaimedAt?: string`;
`conversionClaimExpired(dueAt, tour, nowIso)` measures from
`max(dueAt, tour.conversionClaimedAt ?? tour.updatedAt)`, unparseable/absent ->
keep waiting. Docblocks rewritten to name `updatedAt` as the defensive fallback
only. Fake mirrors both halves.

NOTE, recorded rather than fixed: a FINALIZE does not remove the stamp (it
patches `convertedPlacementId` to a real id). The stamp is then inert - every
reader gates on the `pending:` prefix first - and the type's doc comment says so
explicitly rather than claiming an absence that is not there.

RED, in both directions (the anti-vacuity pair):
- a fresh claim on a tour last written two hours ago was RETIRED under the
  updatedAt basis: `expected '2026-12-07T07:00:00.000Z' to be undefined`.
- a two-hour-old claim on a tour being edited right now was DEFERRED forever:
  `expected undefined to be '2026-12-07T08:00:00.000Z'`. That is NEW-2 exactly.
A third case pins the legacy fallback (no stamp -> measured from updatedAt). The
finalized-tour case already existed and still passes untouched.

### 5. conversion_in_progress on the three surfaces - DONE

Token added to `ScheduledSuppressionReason` (app + dashboard mirror) and the
head comment's short-circuit list. All three surfaces short-circuit on the
`pending:` prefix using the tour they already hold - no new read anywhere.

DEVIATION, deliberate: the dispatch fixed the order only as "after the
`superseded` arm". It also sits BELOW `discontinued`. Both `superseded` and
`discontinued` are PERMANENT and this one RESOLVES, and the suppression ladder's
own rationale is that the harder reason wins - a chip reading "Converting" over
a rung whose kind will never send again would flip to the permanent truth
minutes later. It stays ABOVE the recipient-state evaluator, because a claim in
flight is what actually gates the next tick.

Census walk, all of it:
- FORCED (compile): `REMINDER_SUPPRESSION_LABELS`, `SUPPRESSION_COPY`,
  `NUDGE_SUPPRESSION_LABELS` (compile-completeness entry, no chip branch, marked
  as such like `superseded` above it).
- MANUAL: `suppressionLead` -> `'On hold'` (its own word: "Will wait" promises
  the rung goes out afterwards, which the conversion's sweep usually makes
  false); `SUPPRESSION_REASONS` hand-list in `types.test.ts`; `scheduledLabel`
  -> `'On hold'` above the fire-time fall-through; `StateChip` -> `'Converting'`
  in the UPCOMING tone, NOT the muted `paused` tone the two permanent chips take
  (an in-progress state should not look retired - commented at the site);
  Send-now button hidden; `nextReminderRefetchDelay` NOT skipping it, with the
  comment saying why (the state resolves and the panel should notice).
- ABSENT, deliberately: `ReminderSkipReason`, `PERMANENT_REFUSALS`.
- No surface outside the round-1 map turned up.

RED: with the three route short-circuits stashed, the three new surface tests
failed (`3 failed | 174 passed`). Panel and card tests added on the dashboard
side. Anti-vacuity everywhere: a FINALIZED tour keeps its promise, `superseded`
still outranks a claim, and releasing the claim gives all three relay rungs
their promises back with nothing stamped.

### 6. B1 caveat cleanup - DONE

The round-1 B1 test keeps its parking point (between the rotation and everything
after it) and LOSES the caveat. Its comment now says there is no accepted window
left to park outside of: A can be parked anywhere after its rotation, because
the STORE refuses the delete. Its assertions changed with the contract - A now
arms and then loses the CAS, so its rows are the named
earlier[]-until-next-sweep residue rather than absent, and the single error line
is the compare-and-set's, not the deleted ownership line. The response assertion
gained `scheduledAt === FARTHEST`, which is the half NEW-1 actually broke.

## Where the adjudication was imprecise

1. **R2-1 is closed by fix 1, not by fix 2.** The adjudication presents the
   caller reordering as what fixes the terminal path. Measured: once
   `deleteSupersededForTour` takes a pointer and rides the ConditionCheck, the
   terminal branch is safe with its ORIGINAL ordering. The reordering is still
   right - it is what removes the reads - but the R2-1 regression test cannot
   distinguish the two, and I have said so rather than letting the test imply a
   coverage it does not have.
2. **The `ladderId === null` re-arm cell is unspecified.** "IF the write WON /
   IF the write LOST" does not cover "no write was attempted". Called as
   sweep-against-the-rotation; see fix 2 above.
3. **The conversion_in_progress ordering was under-specified**, and the obvious
   reading (straight after `superseded`, i.e. above `discontinued`) contradicts
   the suppression module's own stated ladder. Called the other way; see fix 5.

## Final gates (bare, real exit codes, logs in this directory)

| gate | exit | counts |
| --- | --- | --- |
| `npm run typecheck` | 0 | all five workspaces clean |
| app vitest (7 files) | 0 | `Test Files 7 passed (7)` / `Tests 569 passed (569)` |
| dashboard vitest (3 files) | 0 | `Test Files 3 passed (3)` / `Tests 96 passed (96)` |
| `npx eslint <branch files>` | 1 | 13 errors, 5 warnings - see below |

Gate 5 attribution. ONE error was MINE and is fixed in `32f28617`: the sweep
rewrite removed the last USE of `DeleteCommand`, so `no-unused-vars` fired on
the IMPORT line - a line the diff never touched, which reads as pre-existing by
line number and is exactly the trap AGENTS.md names. `npx eslint
app/src/repos/tourRemindersRepo.ts` now exits 0.

The remaining 12 errors + 5 warnings are PRE-EXISTING, in
`app/src/lib/seed/{cast,live,matrix}.ts`, `app/src/routes/placements.ts`
(`nameFromContact`), `app/src/routes/relayGroups.ts` (`resolveMessage`),
`app/src/routes/tours.ts` (`TourOutcome`),
`dashboard/src/routes/contact/ScheduledCard.tsx` (`Date.now` default parameter)
and `dashboard/src/routes/contact/Timeline.tsx` (setState in an effect).
Attributed by symbol rather than by line: `git diff 8d608be7 HEAD` over those
four touched files matches NONE of `nameFromContact`, `resolveMessage`,
`TourOutcome` or `Date.now`, so this wave neither created them nor deleted a
last use. Named here so the next reader does not re-diagnose them.

Not run, per the dispatch: `npm test`, `npm run smoke`, `npm run e2e`, Playwright.
