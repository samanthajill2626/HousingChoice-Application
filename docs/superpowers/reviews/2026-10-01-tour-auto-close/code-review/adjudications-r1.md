# Adjudications - code review round 1 (feat/tour-auto-close)

- Date: 2026-10-04. Adjudicator: the build orchestrator (Claude Fable 5.1),
  on HEAD 339acd9d (54 commits over merge-base ae04122d).
- Inputs: `code-review/spec-conformance-r1.md` (CONFORMS; SC-1..SC-3 LOW,
  SC-4..SC-6 NOTE) and `code-review/adversarial-r1.md` (plan-blind; AD-1
  MEDIUM, AD-2..AD-6 LOW, AD-7..AD-9 NOTE), plus the orchestrator's own read
  of the gate-critical diff: `app/src/jobs/tourAutoClose.ts`,
  `app/src/repos/toursRepo.ts` (patch / autoCloseIf / reopenIf),
  `app/src/routes/tours.ts` (PATCH precondition block, reopen route),
  `app/src/worker.ts` (the poll block), `app/src/routes/dev.ts` (the tick),
  `app/src/services/relayCloseNag.ts`, `app/src/lib/toursModel.ts`
  (clock + reopen target), the harness fake, `TourDetail.tsx` (CTA ladder,
  kebab guard, confirmReopen, guarded close, Outcome card),
  `useTodayPastTours.ts`.
- Gate state at adjudication (all on 339acd9d, pre-sync): typecheck 0; `npm
  test` 0 (405 + 213 + 22 + 34 + 13 files, 0 `[dynamoAdmin]` lines); smoke
  0; eslint 0 NEW errors vs the merge base (HEAD 2 pre-existing, base 3 - the
  branch removed the unused `TourOutcome` import, D-a); e2e exit 1 - 306
  passed / 2 failed, `a2p-compliance.spec.ts:132` (run #2) and
  `contact-detail.spec.ts:161` (run #59), both a 60 s `devLogin` timeout
  waiting for "Continue as dev user"; the two FILES re-run alone on the
  branch: `31 passed (37.9s)`, exit 0. Verdict on gate 4: environmental
  (pass-alone, no feature code on the path, the four feature e2e tests
  passed in the full run); the post-sync full run is the deciding run, and a
  main baseline in the scratch worktree follows if it is red on unrelated
  specs again.

## 1. Rulings

| id | sev | ruling | action |
|---|---|---|---|
| AD-1 | MEDIUM | FIX - ruling A-1, a recorded deviation from spec 6.3's "Residual (accepted)" paragraph | `autoCloseIf` adds `updatedAt` equality to its condition WHEN the read carries no `lastMarkedAt` (then `updatedAt` IS the clock); with a mark present the term is omitted, as the clock ignores `updatedAt` then. Real repo + harness fake; integration, parity and job-level cases; the two overclaiming comments corrected; spec 6.3's residual paragraph rewritten and tagged with this ruling |
| AD-2 | LOW | ACCEPT-BY-SPEC (7.5 says it in so many words) | handback line for Cameron's eye |
| AD-3 | LOW | FIX comments only | `routes/tours.ts` precondition comment says "a concurrent STATUS change"; the `tours-patch-status-precondition` update block gets the same precision and names the remaining same-status window (two exit-gate PATCHes both land, two `tour_outcome` rows) as pre-existing and still open |
| AD-4 | LOW | ACCEPT-BY-SPEC (section 2's accepted default copy) | handback: a copy option for Cameron / Sam; the 14-day constant lives once in the app, the dashboard strings are copy |
| AD-5 | LOW | FILE | new issue `tour-reopen-edge-states` (with AD-7 and AD-8): an API-only path; spec 7.2's rule; D6 refused only the no-provenance case |
| AD-6 | LOW | ACCEPT (ruling F7; spec 8.3) | handback line |
| AD-7 | NOTE | FILE (same issue) | pre-existing asymmetry: Cancel arms the nag, a PATCH revival never clears it; the feature added the first clear, not the asymmetry |
| AD-8 | NOTE | FILE (same issue) | the ABA needs a stale reopen request to outlive a complete re-close - not a real-time case; the `lastMarkedAt`-equality option is noted |
| AD-9 | NOTE | ACCEPT (spec 13) | RUNBOOK and the handback carry the first-run effects; the preview recipe IS the dry run |
| SC-1 | LOW | FIX | a child logger carrying `tourId` at both call sites (the sweep's arm, the reopen route's clear) so the shared helpers' lines carry it; one job test pins the ERROR line (probe P6, committed) |
| SC-2 | LOW | FIX (tests) | job cases: a closed relay group and a non-relay thread named by `groupThreadId` - the close lands, no nag |
| SC-3 | LOW | FIX (test) | `scheduled` joins the undated case list |
| SC-4 | NOTE | orchestrator (S11) | main sync, gates on the merged HEAD, self-QA, handback |
| SC-5 | NOTE | FIX (hardening) | the fake mirrors the store's string-vs-absent branch for `scheduledAt` / `lastMarkedAt` (autoCloseIf) and `outcome` / `autoClosedFrom` (reopenIf); the parity file must stay green |
| SC-6 | NOTE | ACCEPT (ruling F3; already in the sub-threshold notes) | none |

### A-1 rationale (AD-1)

Spec 6.3 lists the condition fields and then accepts, as a residual, that "for
a row with no `lastMarkedAt`, an unrelated write (roster edit, group open)
racing the close is not detected - the condition does not compare
`updatedAt` (millisecond stamps make that guard unsound)". The adversarial
reviewer reproduced the hole against DynamoDB Local and through the whole
sweep on the fake: for a never-marked tour - every tour booked ahead and
never marked, the population the sweep exists for - `updatedAt` is the clock
input, so a write that restarts the clock between the sweep's read and its
write is overridden and the tour closes anyway.

Why fix rather than keep the accepted residual: the spec's own intent in the
same section is that "something changed between the read and the write - the
change wins, the sweep skips the tour this run and re-evaluates it next run".
The reason the spec gave for omitting the term describes a FALSE NEGATIVE
(two writes in one millisecond carry one stamp, so equality can miss a
change), which argues that the term is incomplete, not that it is harmful:
adding `#ua = :ua` can only turn a close into a skip, never a skip into a
close, and a skipped tour is re-evaluated fifteen minutes later with its
fresh two weeks. There is no product fork here - no copy, no rule, no screen
changes - so this is the orchestrator's call under the mission's
discrepancy rule. The term is added ONLY when the read carries no
`lastMarkedAt`: once a mark exists the clock ignores `updatedAt`, and
conditioning on it there would make roster edits and group opens block a due
close they do not postpone. Cost: none beyond the skip. Residual that
remains: the same-millisecond collision the spec named, now a false negative
of the guard rather than a blind spot. Recorded in the handback under the
decisions taken alone, so Cameron can reverse it by removing one term.

### Test-gap rulings (adversarial section 4)

- Worker wiring has no automated pin: ruling F12 stands (accepted). Note for
  the handback: `jobs/pollLoop.ts` logs nothing on a quiet tick and the job
  logs only when it closes or fails, so a lane's real poll with nothing due is
  unobservable in the logs; self-QA cannot prove it fired either.
- The unscoped candidate path (`listByStatus` over the `byStatus` GSI) never
  runs against DynamoDB Local in the new tests: `listByStatus` itself has
  integration coverage (`app/test/toursRepo.integration.test.ts:312-360`),
  and the orchestrator verified the GSI projects ALL attributes
  (`app/src/lib/tables.ts:14`), so the sweep evaluates full items. Accepted.
- The e2e "nothing is sent" read is a fixed settle on a self-guided tour: the
  compile-time pin that the job's deps hold no messaging adapter is the real
  proof (spec 6.5). Accepted.
- No test links Today's no-show listing to the server's `AUTO_CLOSE_STATUSES`:
  the app and the dashboard share no code by design; the e2e
  `tour-auto-close.spec.ts` is the cross-codebase check. Accepted; handback
  note.

## 2. Fix wave 1 - the complete list

| id | finding | files |
|---|---|---|
| FW-1 | AD-1 (A-1): `updatedAt` equality when no `lastMarkedAt`; comments | `app/src/repos/toursRepo.ts` (`autoCloseIf` + its interface doc), `app/test/helpers/twilioWebhookHarness.ts` (fake), `app/test/toursRepo.integration.test.ts` (+2: unmarked tour, unrelated write bumps `updatedAt` -> undefined, row unchanged; marked tour, same unrelated write -> still closes), `app/test/toursRepoFakeConditions.test.ts` (same two), `app/test/tourAutoClose.test.ts` (+1: an unrelated write between the list read and the close -> `{ due: 1, closed: 0, lost: 1 }`, no side effects), `app/src/jobs/tourAutoClose.ts` header comment |
| FW-2 | SC-1 | `app/src/jobs/tourAutoClose.ts` (arm call: `logger: log.child({ tourId })`), `app/src/routes/tours.ts` (reopen clear: same), `app/test/tourAutoClose.test.ts` (+1: a rejecting `getById` during the arm -> the run closes the tour and continues; the ERROR line carries `tourId`) |
| FW-3 | SC-2, SC-3 | `app/test/tourAutoClose.test.ts` (+2 nag cases), `app/test/toursModel.test.ts` (case 9 adds `scheduled`) |
| FW-4 | SC-5 | `app/test/helpers/twilioWebhookHarness.ts` (string-vs-absent branches in `autoCloseIf` / `reopenIf`); parity file green |
| FW-5 | AD-3 | `app/src/routes/tours.ts` comment (precondition block), `docs/issues/tours-patch-status-precondition.md` update block |
| FW-6 | A-1 text, AD-5 / AD-7 / AD-8 | spec 6.3 residual paragraph (tagged "ruling A-1, 2026-10-04"); new `docs/issues/tour-reopen-edge-states.md` (debt, low, app/tours, created 2026-10-04); `npm run issues` with no warning |
| FW-7 | report | `code-review/fix-wave-1-report.md` |

Re-review: AUTO mode, so a FRESH reviewer reads this file, both R1 reports
and the fix diff, charged first with what round 1 missed, then with the fix
diff as new unreviewed code, then with challenging these rulings, and only
then with whether the fixes are real.
