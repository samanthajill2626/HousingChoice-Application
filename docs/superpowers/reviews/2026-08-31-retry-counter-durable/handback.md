# Handback - feat/retry-counter-durable (bundle M5)

Build orchestrator (Claude Fable 5, MANUAL mode), 2026-09-01.
Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`,
final commit **b1d62cfe**. Cut from main@5ce9912f; the branch's SINGLE mainline
sync is merge commit **8c8b7100** (main@1af02926, 37 commits, clean).

## Verdict line

MERGE-READY @b1d62cfe on feat/retry-counter-durable (W:\tmp\retry-counter-durable),
4 behind main, UNMERGED (human gate).
**NO infra, NO new dependencies, NO env, NO schema migration - nothing owed
post-merge.** The new `fanout_attempt` attribute is optional and self-creating
(D4).

## Gates - final battery, all on b1d62cfe, bare, from the worktree

| gate | exit | evidence (logs under .superpowers/gates/) |
|---|---|---|
| 1 npm run typecheck | 0 | final-g1-typecheck.log |
| 2 npm test | 0 | "Test Files 347 passed / 1 skipped (348); Tests 6428 passed / 9 skipped (6437)" - app 2891/2891 among them (final-g2-test.log) |
| 3 npm run smoke | 0 | "smoke-dist: OK - 1365 import specifier(s) across 240 emitted file(s) resolve under plain Node." |
| 4 npm run e2e | 0 | "Running 263 tests using 1 worker" -> "263 passed (21.9m)" - g4-final.log |
| 5 npx eslint (25 touched files) | 1* | final-g5-eslint.log |

*Gate 5: exactly 2 errors, BOTH PRE-EXISTING at merge base 1af02926, proven by
running the same command on the same files at the detached merge base
(g5-eslint-baseline.log): `app/src/lib/import/convertGroups.ts:32`
no-unused-vars (base :32) and `dashboard/src/routes/contact/Timeline.tsx:1265`
react-hooks/set-state-in-effect (base :1240; shifted by added comment lines).
**No new lint errors in touched files - the gate PASSES by AGENTS.md's
ratchet.** Known hole reminder: the eslint config lints .ts/.tsx only, so the
one .spec.ts e2e file was linted but any .mjs would have been silently skipped
(none was touched).

An earlier IDENTICAL battery was green on d2d15b4e (pre-fix-waves): typecheck 0,
test 6426/6426+9skip, smoke 0, e2e 263/263 in 24.3m (g2-test.log, g4-e2e.log).
No flakes in either run; the DynamoDB-contention re-run protocol was never
triggered (both npm test runs green first try).

## Work map - all shipped

| item | state | key commits |
|---|---|---|
| S0+S1 claimFanoutPass both repos + fanout_attempt + 4 fakes + DDB Local integration tests (concurrency, slot-survival) | shipped | 1dd28853, 18e4a00b |
| S5b transient_cap + enqueue_failed in INTERNAL_CODE_REASONS, four positions, no tail | shipped | 0d031710, 5298bbcb, 8ffbfce6 |
| S2 broadcastFanOut durable claim + three closes + cap test rewritten (close A driven real, close B seeded, close C RED-first) | shipped | c7d3b5f0 |
| S3 relayFanOut same shape, backoff arg preserved (D11), inbound-source close B, NEW cap coverage (none existed) | shipped | 58764d87 |
| S4 groupRail binding ladder, both read points, own try/catch on point 1, 3 callers, groupSend untouched | shipped | b945fec5, 4382cb95 |
| S5a relay 30003 override, 3 positions, tail kept, group-text/1:1/email/badge pinned unchanged, precedence pinned | shipped | 9c5cfe7d, 1c72d172, f1347e3b |
| S6 provider-status sweep (52 sites) + 2 false-comment corrections + out-of-region issue | shipped | 8cebbebf, b3817fcf |
| S7 e2e spec + anchor Resolution + rail partial + 4 filings + lineage facts + _CLUSTERS M5 + D8 note | shipped | 59f3f9ad, d9365a68, e50ae4f7 |
| Review fix waves 1+2 | shipped | 5c3913a9, 08007e15, e421f687, b1d62cfe |

Net delta vs merge base: 68 files, +14550/-90 at review time, +~120 more from
wave 2 (mostly mission records; code is the repos, two fan-outs, groupRail,
deliveryStatus/Timeline, tests, one e2e spec).

## Recorded deviations that matter (full lists in build/slice-*.md)

- Backoff asserted as adapter-observed `delaySeconds` integers (10/20, 5/10) -
  `runAt` NEVER reaches the adapter (jobs.ts converts it). Plan said
  milliseconds-off-runAt; impossible as written.
- The relay dashboard flag shipped as boolean `relay` on DeliveryReasonOptions
  (plan sketched `rosterKind` on the bag) - behaviorally identical, recorded.
- S6's in-region fix-or-file rule got a SECOND recorded exception:
  `isDeadRailState` analyzed per-consumer and FILED (fixing one consumer would
  reinstate the healRail loop; the adopt-keep default is correct) - analysis in
  provider-status-sweep.md.
- D6 known bounded deviation (a pass whose recipients all skip in-loop still
  consumes a rung) is WIDER on relay (opt-out suppression); accepted + stated.

## Review rounds + adjudications (code-review/ dir)

R1: conformance all-CONFORMS; adversarial 3 should-fix. Adjudicated
(adjudications-r1.md): SF2 fixed (close log now carries fanoutAttempt +
envelopeAttempt; close B asserts stored 3 vs envelope 1); SF1 accepted as
evidence, remedy out-of-fence, FILED as
group-text-30003-leg-retry-promise-unverified (instance FIVE of the mission's
"mechanism credited by name without tracing the path" pattern); SF3 rejected -
re-litigates the D9/R5 redelivery-suppression reversal.
R2 (continued reviewers): 1 should-fix (NF1 TDZ hazard - fixed by hoisting
`let claim`), missing-arm tests added (M3), two comment trims; adversarial
CONCEDED its R1 N2 outright; SF1 filing verified faithful; claim x rail-ladder
walked and found uncoupled. Adjudications-r2.md has the full disposition.
Wave-2 diff was mechanical and orchestrator-reviewed directly (declaration
move + tests + comments); the full battery above re-ran on its result.

## Self-QA (self-qa.md, orchestrator-driven, lane 3 @08007e15)

Real dashboard, real connect-when-ready chain, fake-armed 30003: rollup chip
`delivered 1/2 - 1 failed - Phone unreachable (error 30003)`; accessible-name
recital carries the same copy per member; per-recipient list ABSENT until the
bubble click, then `Undelivered - Phone unreachable (error 30003)`; "will
retry" appears NOWHERE. Server side: the leg logged `delivery_failed 30003
relay:true` at WARN - live confirmation of the filed
relay-30003-classified-transient-retrying. Screenshot in the main checkout's
.playwright-mcp/m5-selfqa-relay-30003-three-positions.png.

## Issues: resolved / updated / filed

- RESOLVED: retry-counter-in-envelope-makes-caps-unreachable (anchor, high) -
  with the explicit note that retrySend.ts:74 needed NO change.
- UPDATED: rail-binding-propagation-retry (PARTIAL - live on groupSend.ts:381
  + healRail:425 by D16; rail-verify's flag inert except delete-and-recreate);
  relay-30003-retry-lineage (+ the five design facts + substrate note);
  throw-for-redelivery-defeated-by-job-marker (refs refreshed);
  _CLUSTERS.md M5 amended; spec D8 precision clause.
- FILED: provider-status-unenumerated-defaults (med),
  relay-hub-message-delivery-status-never-terminal (med),
  group-text-30003-leg-retry-promise-unverified (low),
  rail-adopt-path-binding-propagation (low),
  rail-repair-refusal-log-noise (low),
  relay-30003-classified-transient-retrying (low).

## Known pre-existing issues NAMED so nobody re-diagnoses them as ours

- convertGroups.ts:32 unused import + Timeline.tsx set-state-in-effect (gate 5,
  baseline-proven).
- npm run issues warns once about perf-selfqa-route-contract-drift.md's
  severity token (pre-existing).
- The lean seed's stuck-connecting fixture logs one level-50
  relay_connecting_stuck per session lane boot (seen in self-QA; not ours).

## Sub-threshold notes (not blocking - the orchestrator's eye)

- The operator close log line is NEW ('fan-out closed - remaining recipients
  marked failed' + closeCode/fanoutAttempt/envelopeAttempt fields; the old
  'transient retry cap reached' string is gone) - anything grepping the old
  string should switch.
- Four pre-existing log sites still emit the bare `attempt` (envelope) field
  in the fan-outs; renaming them is operator-visible churn we declined.
- A duplicated roster member would double-count `deferred` in the relay close
  log line (writes idempotent; log-only).
- There is no re-drive tool for a closed broadcast (markSending is draft-only)
  - same gap main's cap-close has; close C makes it reachable on pass 1.
- Close-B copy on an INBOUND relay source writes slots the UI never renders
  (rows render on outbound bubbles only); the ERROR log is the visible surface.
- The rail ladder adds up to ~2s x 2 read points per short-read rail on the
  batch paths (~40s worst case on a 132-thread migration-shaped run).

## Main drift at handback (reported, not chased - one-sync rule)

4 commits: 065258b9 ("It's Sam." tour/placement intro copy - touches the intro
composition path, NOT this branch's edited regions), plus three doc-retirement
commits (725a8746, b1dc8489, 1ce48fef). No file overlap with this branch's
code; the merge should be trivial.

## What Cameron does next

1. Merge feat/retry-counter-durable into main (nothing else is gated on it).
2. No post-merge ops of any kind for this branch.
3. Optional next missions unlocked: relay-30003-retry-lineage (its own
   mission, design facts carried forward) and the six filed follow-ups.
