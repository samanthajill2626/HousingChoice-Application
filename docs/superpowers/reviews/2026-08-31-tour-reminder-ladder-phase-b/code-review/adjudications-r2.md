# Code review round 2 - adjudications (orchestrator, 2026-09-01)

Reviewed: fix wave 1 (@8956118c + @adf4feeb) on the synced tree @9b6d972c. Reviewers
continued from round 1 (A = `r2-conformance.md`, B = `r2-adversarial.md`). Totals:
BLOCKING 1 (both reviewers, same item), MUST-FIX 1 (both, same item), SHOULD 4, NOTE 9.
Confirmed empirically before adjudicating: the full e2e on @9b6d972c = 261 passed,
1 failed (`relay-intro-variants.spec.ts:324`, the placement walk) - exactly R2-B1.

Ruling key as in round 1. The round-1 ruling for B-S5 is RE-ISSUED below (B-R2 s3):
its text "per-row try/catch ... continues" did not split PLAN failures from WRITE
failures, and the implementer followed it literally.

## Fix wave 2 (FIX)

| id | finding | ruling |
|---|---|---|
| R2-B1 / MF-R2-1 | Placement e2e reads `phone` off a roster payload that serves `phoneLast4` only -> `rosterPhones` is `[]`, leg-arrival never asserted, spec red | FIX. Assert against the MINTED phones the tour walk already uses (`relay-intro-variants.spec.ts:258-259` idiom); delete `rosterPhones` and its `as` cast. Every member's fake thread must be asserted. |
| R2-M1 / MF-R2-2 | Sweep's per-row catch swallows WRITE failures; a run that wrote nothing exits 0 and logs "done" | FIX, with the B-S5 ruling RE-ISSUED: (a) a PLAN-side failure (tour read throws, corrupt/blank `tourId`) counts `failed` and continues; (b) a WRITE failure other than `ConditionalCheckFailedException` ABORTS the run - re-throw out of the loop so the top-level catch logs the PARTIAL counters and sets exit 1 (the model sibling's behaviour, RUNBOOK `:95`); (c) `failed > 0` on an otherwise complete run logs at WARN and sets `process.exitCode = 1` so the operator investigates before re-running; RUNBOOK: replace "not a reason to stop" with the investigate-then-re-run instruction. Integration tests: corrupt row -> counted, others processed, exit code non-zero; write failure (inject a `doc` whose `send` rejects on `UpdateCommand`) -> aborts with the partial report. |
| R2-S1 | B-MF1's boundary is strictly-before while `retiredByTourStart` is inclusive at the start instant, and the comment cites the gate as authority | FIX: flip to `<=` (at `now === scheduledAt` the tour intro is naked). One instant, one answer, across the codebase. Update the boundary test. |
| R2-S2 | Sweep population B hardcodes `'confirmation'` instead of reading `DISCONTINUED_REMINDER_KINDS` | FIX: import the set; `DISCONTINUED_REMINDER_KINDS.has(row.kind)`. The planner test's expectations are unchanged. |
| R2-S3 | `hasUpcoming` (`routes/tourReminders.ts:513`) still counts a discontinued rung, so the suppression-estimate block does two reads for an answer the short-circuit discards | FIX: exclude discontinued kinds in `hasUpcoming`; a test that a self_guided tour whose only pending rung is a confirmation performs no tenant/conversation read (spy on the fake repos) and still chips `discontinued`. |
| B NOTE-4 | `retiredByTourStart` compares `due < start` as instants but `now >= startIso` as text | FIX: parse `now` too; unparseable `now` -> `false`. One test. |
| B NOTE-1 | The resolver docblock says a past tour is treated "exactly as a tour with no time" - true of precedence 2-4 only; an operator-EDITED `intro_body` (precedence 1) still sends verbatim | FIX (comment): say precedence 1 is exempt by design ("a human chose it"); no behaviour change. |
| B NOTE-5 | Unparseable `nowIso` fails OPEN (tour variant composes) | FIX (comment only): state it is a deliberate fail-open for a resolver that must never throw. |
| B NOTE-6 | `expectRungsSuperseded` is a clone of `expectRungsRetiredPastTour` | FIX: one helper taking the expected `skipReason`; keep both named verbs as thin wrappers or update the two call sites - whichever is smaller. |

## RECORD (accepted; stated so it is not re-derived)

| id | finding | ruling |
|---|---|---|
| R2-S4 / B NOTE-2 | `nextReminderRefetchDelay` (shared with `usePlacementNudges`) gained a `discontinued` skip in the same wave that reverted the placement card's chip branch | RECORD with the principle made explicit: the REVERT concerned surface-specific RENDERING on the excluded placement card (copy a placement writer can never produce); the refetch skip is a pure helper keyed on the shared WIRE UNION, and the tour panel needs it. Different rule, same wave. Add one sentence to the helper's docblock saying so. |
| B NOTE-3 | B-N1 is narrowed, not closed: `added` and `bodyFor` are decided from two different conversation reads, so a remove landing between them can still persist a body no leg carried | RECORD as an accepted residual: harmless copy on a sub-second race; the honest close would move the persisted-body decision after the roster loop, which changes `sendRelayAnnouncement`'s persist-before-send order. Not this mission. Filed as a NOTE in the handback. |
| R2-N3 | Independent confirmation that the `GetCommand` lint error is inherited (present once at the merge base, zero uses) | RECORD. |
| R2 A s3 | A-S6 split ruling upheld by reviewer A; B contests no RECORD ruling | RECORD. |

## Re-review charge (round 3, on continuation)
Confined to the fix-wave-2 diff: (1) anything missed in the two sweep-failure classes and
the e2e phone fix; (2) the new code cold; (3) are the 9 items closed. Full e2e is the
orchestrator's proof for R2-B1.
