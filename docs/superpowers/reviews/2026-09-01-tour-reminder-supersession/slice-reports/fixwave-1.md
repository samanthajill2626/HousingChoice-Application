# Fix wave 1 - round-1 adjudications

Every ACCEPT-FIX item is fixed. Nine commits, `feat/tour-reminder-supersession`,
`e80e9211..9af87a2c`. Strictly TDD: each behavioural fix has a RED run recorded
below (evidence files under `.superpowers/sdd/reports/`).

## Per finding

### B1 + conformance F1 - ownership-guarded sweeps - FIXED @09a8bd8f

`routes/tours.ts` re-arm branch and `routes/placements.ts` post-finalize sweep
both re-read the tour immediately before the sweep. Re-arm: a pointer that no
longer holds this request's rotation skips the sweep AND the arm, logs
`a concurrent reschedule owns this ladder` at error, and returns the winner's
stored tour (`ladderChanged` stays false, so no emit). Conversion: skips only
the sweep, logs `a concurrent writer owns this ladder`; the 201 stands. F1
folded in: the re-arm sweep's rethrow now carries
`sweep failed after pointer rotation - tour is DISARMED ...`.

RED evidence:
- `red-b1.txt` - `expected false to be true` at the winner's-rows-by-identity
  assertion: request A's late sweep had deleted B's freshly armed ladder.
- `red-b1-convert.txt` - same shape on the conversion path (guard neutered to
  `owner === undefined`, then restored).

**DEVIATION, deliberate.** The prompt said to park request A inside
`deleteSupersededForTour`. That parks A *past* the ownership read, which is
exactly the residual window spec 3.2 names and accepts - the test could never go
green. The test instead parks A between its rotation (which rides the patch
write, step 1) and its sweep, which is the reviewer's interleaving faithfully:
A patches, B runs to completion underneath, A sweeps. The comment in the test
says so. The pre-existing parked-arm test is kept, untouched.

Also added: `SWEEP FAILURE after the rotation is LOUD too` (F1's log).

### M3 - terminal branch fires only on a TRANSITION - FIXED @49d8d873

`terminal` now reads `patch['status']`, never `effectiveStatus`.

RED (`red-m3.txt`): PATCH `{ outcome: 'move_forward', moveForward: true }` on a
pre-migration `toured` tour - the legacy `canceledAt` row was HARD-DELETED
(`expected undefined to be '2026-07-13T14:00:00.000Z'`). Post-fix both rows are
untouched, the absent pointer stays absent, and no `scheduled.updated` is
emitted.

### M2 - grace from max(dueAt, updatedAt) - FIXED @a6890024

`conversionClaimExpired(dueAt, tourUpdatedAt, now)`; unparseable OR ABSENT
`updatedAt` answers false (keep waiting). Doc comment rewritten - it no longer
apologises for the dueAt basis.

RED (`red-m2.txt`): a rung five hours overdue with the claim written this
instant was stamped `conversion_stalled` (`expected '...T07:00:00.000Z' to be
undefined`). The paired anti-vacuity case (claim two hours stale -> retired)
passes in both directions.

### M1 - Send now refuses a claim in flight - FIXED @d5158660

New `ForceSendRefusal` member `conversion_in_progress` with the JSDoc the
adjudication asked for, placed AFTER the `superseded` check. Dashboard:
`SEND_NOW_ERROR_COPY` entry with its own sentence, NOT in `PERMANENT_REFUSALS`,
plus a `types.test.ts` case asserting it is neither the generic fallback nor the
`conversion_stalled` sentence.

RED (`red-m1.txt`): route answered 200 and sent. Three route tests now: the 409
with the row untouched, a FINALIZED tour still sending (the prefix predicate),
and `superseded` outranking the claim.

### m1 - echo bodies - FIXED @8cd06c0c

Both single-row responses (PATCH 200/409, send-now 200/409) build the echoed
body from `after.sentBody ?? ''` when `isSupersededRung(after, tour)`.

RED (`red-m1echo.txt`): the PATCH echo returned a freshly composed
`'Hey there, confirming your tour tomor...'`. The send-now 409 `superseded`
test gained the same assertion.

### m2 - anchor desync - FIXED @ec144ff7

`Timeline.tsx`: a `prevHasBlockRef` seeded with the MOUNT value; when
`hasUpcomingBlock` differs from it the layout effect re-derives `anchorRef` from
`currentAnchor(el)` and re-baselines `bottomGapRef` before the branch logic.
`hasUpcomingBlock` (the boolean) joins the deps; the `upcoming` array never does.

RED (`red-m2ui.txt`): `expected 250 to be 300` - the stale 150px gap left the
operator 50px above the newest message, with the pill suppressed. Post-fix, with
`hasBlock: false`, `below` is unreachable and the operator stays pinned at 300.

### m3 - matrix seed + missing invariant - FIXED @4f7ede6f

Canceled matrix tours no longer push the canceled `day_before` row; the sent
confirmation and the rotated pointer stay. `seedMatrixCoherence.test.ts` gains
the row-side pairing invariant (current ladder <-> live tour, rotated pointer
<-> terminal tour, both halves asserted to be real ids first) and the
canceled-tour shape assertion.

RED (`red-m3.txt`, seed temporarily reverted): `canceled tour-mx-canceled-01
rung rem-mx-tour-mx-canceled-01-dbf: expected '2026-06-28T06:00:00.000Z' to be
undefined`. Note the seed change and its invariant landed in one commit.

### m4 + conformance F5 - stale prose - FIXED @de5cf1b7

`retire-paused-tour-reminders.ts` (three comment sites: deleted is a fourth
concurrent outcome, `attribute_exists(reminderId)` is load-bearing),
`tourRemindersRepo.ts` header (row shape names `ladderId`; byTour backs a bulk
DELETE), `e2e/support/selectors.md` (a new row for the third aria sentence with
the `Earlier reminders (N)` disclosure and its scoping trap; the suppression
lead is per-reason, not one exception), and the two issue docs, each with a
parenthetical rather than a rewrite.

### N5 - RUNBOOK - FIXED @9af87a2c

New section: nothing owed, no backfill (pre-migration pairs exempt by
construction), no Terraform/GSI, the behaviour change an operator will notice,
and the independence of the Phase B sweep and this branch's delete in BOTH
directions (a row this branch deleted lands in the sweep's
`skippedOnCondition`).

## Gates (bare, redirected, real exit codes)

| gate | exit | result |
| --- | --- | --- |
| `npm run typecheck` | 0 | all five workspaces |
| app fast set (6 files) | 0 | 516 passed |
| dashboard fast set (2 files) | 0 | 148 passed |
| extra: `dashboard/src/routes/contact` + `routes/tours` | 0 | 73 files, 1378 passed |
| extra: contactTimeline, relayApi, ladderPointer, seedLive, retirePausedTourReminders, devGating | 0 | 185 passed |

Logs: `fixwave-gate-typecheck.txt`, `fixwave-gate-app.txt`,
`fixwave-gate-dash.txt`, `fixwave-extra-dash.txt`, `fixwave-extra-app.txt`.
Per-commit ASCII check printed 0 every time. Not run, per instruction:
`npm test`, `npm run e2e`, `npm run smoke`, Playwright.

## Fake changes

NONE were needed, and this was checked rather than assumed. Both ownership
checks live in the ROUTES and use `toursRepo.get`, which the harness fake
already implements with real semantics; `deleteSupersededForTour`'s signature is
unchanged, so the fake mirror needed no edit. The M2 change reads
`tour.updatedAt`, which the fake already maintains on every write.

## What the adjudication got slightly wrong

1. **B1's regression test cannot park at the sweep.** See the deviation above -
   parking there lands inside the accepted residual window, not the defect.
2. **m3's "missing coherence invariant" was half-present.** `seedMatrix.test.ts`
   already pairs pointers per status GROUP (scheduled equal / terminal not
   equal / requested absent). What was genuinely missing is the ROW-side walk,
   which is what a future edit to the pointer derivation would slip past, so
   that is what was added - in `seedMatrixCoherence.test.ts`, the file the
   reviewer named.
3. **M3's fix shape.** The adversarial review proposed
   `terminal && currentStatus !== effectiveStatus`; the adjudication and the
   spec amendment say "an EXPLICIT terminal `patch['status']`". The latter was
   implemented. The difference is a repeat `PATCH {status:'canceled'}` on an
   already-canceled tour, which still rotates and sweeps - harmless (it deletes
   rows that are already gone) and the simpler rule to state.

## Residue

Untouched by design (ACCEPT-RECORD): M1's three preview surfaces, N1-N4, S5's
`names_unavailable` token. The B1 ownership-read-to-sweep window is accepted and
documented in spec 3.2 and in the code comment.

## Follow-up: m2 regression, found in live QA - FIXED

`ec144ff7` re-derived the anchor whenever block presence FLIPPED, in both
directions. The MOUNT flip is the harmful half. TourConversation delivers a
thread's messages and its Upcoming block in ONE commit, so the re-derive ran
against a scrollTop no pin had yet run on: at 0 the sentinel sat 221px below the
viewport bottom, `deriveStreamAnchor` answered `null`, and the SAME effect pass
then took the `grew` branch. Measured on lane 1: scrollTop 0,
distanceFromBottom 655, the "New messages" pill visible ON OPEN. That breaks
acceptance 13 for every view that mounts messages and block together, and is
timing-flaky for the rest.

The mount flip cannot invalidate anything: the block renders BELOW the sentinel,
so it only adds content beneath the fold - a `sentinel` or `null` anchor stays
correct. m2's actual desync was always the UNMOUNT (a stale `below` plus a
bottom gap measured with the block present), so the re-derive is now gated on
that direction alone. Deps, `prevHasBlockRef` and the no-`upcoming`-array rule
are unchanged.

RED (`red-m2-regression.txt`): a commit delivering clusters and a non-empty
`upcoming` together, with the sentinel beyond the 48px band at scrollTop 0 ->
`expected +0 to be 200`, i.e. no pin at all, exactly the live shape. The m2
unmount test still passes, so the fix did not simply revert m2.

Gates: `npm run typecheck` exit 0; `Timeline.test.tsx` + `streamAnchor.test.ts`
exit 0, 141 passed. No e2e or stack action - an interactive session was live on
lane 1.
