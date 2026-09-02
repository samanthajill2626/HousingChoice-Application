# Code review round 2 - adjudications

Both round-1 reviewers CONTINUED (manual mode) against the fix-wave head
08007e15, charged first with what round 1 MISSED, then with the fix diff as
new unreviewed code, then with challenging round-1 adjudications. Reports:
r2-conformance.md, r2-adversarial.md (committed beside this file).

Counts: conformance - 0 must-fix, 3 notes (M2 M3 M4), fixes judged real, one
adjudication qualification. Adversarial - 0 must-fix, 1 should-fix (NF1),
5 notes, SF1 filing verified faithful, two round-1 notes CONCEDED (N1 partly,
N2 outright - the finalize flip claim was wrong, matching the orchestrator's
own derivation), SF3 rejection accepted with a sharpening.

## Accepted into wave 2

- NF1 (adversarial, should-fix): the fix made both hoisted close functions
  read `claim`, a `let` declared 40-61 lines below them. No call site sits in
  the TDZ window TODAY (conformance verified all 8), so nothing throws - but a
  future close added in that window would crash inside the function whose
  contract is "nothing left queued". Remedy: hoist `let claim` up beside the
  `const repo`/`const snapshot` pins in both files. Zero behavior change.
- M3 (conformance): the claim's `missing` arm - a new production branch - has
  zero coverage in either job suite. Remedy: one test per suite driving the
  handler with a repo whose claimFanoutPass reports `missing` (modelling the
  vanished-between-read-and-claim race); assert the warn, zero sends, no
  close, clean return.
- M4 + NF4 (comment precision): Timeline.tsx's "ONE derivation" comment
  overstates (the recital recomputes at :587 from the same prop - D21 still
  holds); the close-log comment overstates `capped`/`claimed` by one case
  (close C logs the claimed pass as context, not a decision input). Trim both.

## Recorded, no change

- NF2: close A's fanoutAttempt assertion is non-discriminating (envelope is
  also 3 there); close B's 3-vs-1 pair is the load-bearing one and exists in
  both suites. Nothing to add.
- NF3: four pre-existing log sites still emit the bare `attempt` field
  (transient-defer warns, continuation lines). They predate the branch, print
  no wrong number, and renaming operator-visible log fields is its own
  change. Named in the handback instead.
- NF5: claim x rail-ladder walked and found genuinely uncoupled; repairs
  round 1's serial-dispatch assumption (batch dispatch IS concurrent;
  the conditional-Put marker is what makes that safe).
- NF6: a duplicated roster member double-counts `deferred` in the relay close
  log line - log-only, the writes are idempotent. Handback note.
- M2: plan slice 3's "confirm by reading" on the third enqueuer was satisfied
  in fact (research F8 traced all four links; the reviewer re-traced them)
  but unrecorded in slice-3.md. Recorded here and in the handback.
- Adjudication sharpenings accepted as text, not code: N1's same-as-main
  ruling now argued on the better ground (close C's alternative on main was
  not a clean failure but the anchor bug), noting close C is newly reachable
  on pass 1; N4's bound now names its failure mode (the loser of the claim
  gets GroupRailUnavailableError at a staff request, and the competing claim
  can start from the inbound webhook).

## Wave 2 scope

1. Hoist `let claim` beside the pins (both fan-outs) - NF1.
2. Missing-arm test in each job suite - M3.
3. Two comment trims - M4, NF4.
4. Commit r2 reports, this adjudication, self-qa.md.

Wave 2's diff is mechanical (a declaration move, tests, comments); the
orchestrator reviews it directly rather than running a third reviewer round,
and the full five-gate battery re-runs on the resulting final commit.
