# Adjudications - code review round 2 (feat/tour-auto-close)

- Date: 2026-10-04. Adjudicator: the build orchestrator (Claude Fable 5.1),
  on HEAD 0278e8ea (fix wave 1 applied). Input: `code-review/re-review-r2.md`
  (fresh reviewer; charge: misses first, the fix diff as new code, challenge
  the round-1 rulings, then fix realness).
- Verdict carried: no runtime defect at HEAD; ruling A-1 sound and the right
  boundary; FW-1/2/3/5/6 REAL, FW-4 PLAUSIBLE (no committed test for value
  shapes no writer produces - accepted as is). ONE test-quality defect in the
  fix wave (R2-1) and two doc notes need a second, test-and-docs-only wave.

## 1. Rulings

| id | sev | ruling | action |
|---|---|---|---|
| R2-1 | MEDIUM | FIX (tests only) | The FW-1 `updatedAt` term masks 7 of the 8 DynamoDB Local race rows (`app/test/toursRepo.integration.test.ts:707-758`): each competing write on a never-marked tour also moves `updatedAt`, so every row now fails on that term whichever term it names - six real-repo mutants the S1-S2 slice killed survive again. Run each race row against a MARKED read as well (the term is absent there, so each row fails on its own term), add a raw-write row that sets a first mark WITHOUT moving `updatedAt` (isolates `attribute_not_exists(lastMarkedAt)`), correct the table's comment; mirror in `app/test/toursRepoFakeConditions.test.ts`. Prove it by stripping each real-repo term in turn (status, outcome, conversion claim, convertible, scheduledAt, lastMarkedAt) and recording which row goes red; restore before committing |
| R2-2 | NOTE | FIX (docs) | spec 6.6 (`:357-358`) and 11 (`:595-602`) still list the condition without the never-marked `updatedAt` term - one clause each, tagged "(ruling A-1)" |
| R2-3 | NOTE | FIX (docs) | `docs/issues/tour-reopen-edge-states.md:35` "Only reopen clears" is wrong: the group close (`relayGroups.ts:687`) and the "Keep it open" defer (`:772`) also write `close_nag_next_at`; say "the only TOUR event that clears it" |
| R2-4 | NOTE | ACCEPT | the fake's non-string branches have no committed test; the reviewer's probe confirmed fake == store; no writer produces those shapes |
| F12 dispute | LOW | ACCEPT the dispute - FIX (test) | the repo already pins `worker.ts` by reading its source (`app/test/jobQueueWiring.test.ts:129-139`), so a source-text pin that the auto-close poll block exists - `startPollLoop('tour auto-close'`, `TOUR_AUTO_CLOSE_INTERVAL_MS`, `runTourAutoClose` - is a one-test change in the repo's own idiom; deleting the block then turns a gate red |
| FW-2 route line | - | ACCEPT without a committed test | the reviewer's probe confirmed the reopen clear's line carries `tourId`, and the route's lines share a correlationId with `tour reopened via api`, which carries it |
| left-undone refs | - | FIX (docs) | fix wave 1 shifted line refs in `docs/issues/tour-relay-open-vs-auto-close-race.md` (`toursRepo.ts` :496 / :540 / :679 -> :502 / :546 / :685; `routes/tours.ts` :1544 etc. +8) and `tours-scheduled-range-query-unpaginated.md` (`toursRepo.ts:393` -> :399); re-derive every ref at HEAD |

## 2. Fix wave 2 - the complete list (tests and docs only; no runtime change)

| id | item | files |
|---|---|---|
| FW2-1 | R2-1 | `app/test/toursRepo.integration.test.ts`, `app/test/toursRepoFakeConditions.test.ts` |
| FW2-2 | F12 pin | `app/test/jobQueueWiring.test.ts` (or the worker wiring test that already reads `worker.ts`) |
| FW2-3 | R2-2 | the spec, sections 6.6 and 11 |
| FW2-4 | R2-3 + shifted refs | `docs/issues/tour-reopen-edge-states.md`, `tour-relay-open-vs-auto-close-race.md`, `tours-scheduled-range-query-unpaginated.md`; `npm run issues` clean |
| FW2-5 | report | `code-review/fix-wave-2-report.md`, with the mutant table (term stripped -> row red) |

Verification of this wave: the orchestrator re-runs the two race files and
one real-repo mutant itself (no third review round for a tests-and-docs
wave), then the affected gates on the final commit.
