# Planner's independent review - adjudications

Date: 2026-09-02 (overnight battery, Cameron asleep)
Reviewers: planner-review-conformance.md (opus, spec-conformance),
planner-review-adversarial.md (fable, plan-blind). Both cold, both barred from
the orchestrator's own review records.

Verdicts: conformance "delivers-the-spec" (1 MEDIUM, 4 LOW); adversarial
"mergeable" (2 MEDIUM, 6 LOW). No BLOCKING, no HIGH, from either.

## Fixed in the planner's fix wave

**C-1 (MED) - acceptance 5 (Fixture B, clean sweep) encoded by no test.
ACCEPT, FIX.** Both preview-bucket suites build only Fixture A (the sweep-miss).
The delete itself is proven at three layers, so this was an evidence gap, not a
defect - but the A/B distinction was the round-5 spec contradiction, so it gets
its test: after a clean sweep both Upcoming buckets return nothing for the
superseded ladder because the rows are GONE, not filtered.

## Deferred to the issue registry (not fixed tonight)

**A-1 (MED) - a crashed conversion claim is a permanent dead end, and Send now's
copy lies about it.** No unclaim path exists; a from-tour retry 409s on the
stuck sentinel itself (`placements.ts:665-671`); after the 1h grace the ladder
retires `conversion_stalled`, while the copy says "try again once that
finishes" - which will never happen. The MECHANISM gap (an operator unclaim
path) is real ops-recovery work touching the conversion state machine - not a
2am unsupervised change. Filed as an issue with the copy fix folded in, for
Cameron's call.

**A-2 (MED) - block-vanish re-derivation reads post-append geometry.** When the
Upcoming bucket empties in the same commit that appends the fired reminder's
message, an at-bottom operator can get a pill instead of follow whenever the
new bubble exceeds the 48px slack. Real, narrow (requires the empty-and-append
in one commit and a tall bubble), and it lands in the ONE region of this branch
that was hand-QA'd on a phone - changing it overnight without re-running that QA
trades a wrinkle for an unverified anchor. Filed for a follow-up with phone QA
attached.

**A-3 (LOW) - pre-existing PATCH-vs-conversion TOCTOU** (a reschedule straddling
a completed conversion arms a live ladder on a closed tour; the poll has no
tour-status gate). Pre-existing class, wider than this feature; filed.

**A-4 (LOW) - forceSendReminder reads the tour eventually-consistently** for the
supersession judgment. The claim guards still bound the damage; noted in the
same issue as A-3 (both are "the poll/send trusts a stale tour read").

**A-5, A-6, A-7, A-8 (LOW) and C-4, C-5 (LOW)** - echo `body: ''` overload,
TransactionConflict undecoded, `next` decorating a Converting rung, sentinel
gap cosmetics, deferral-vs-superseded precedence chip, sweep-failure 500 -
recorded as residues on the existing adjudication trail; none changes merge
posture.

**C-2, C-3 (LOW)** - acceptance 13's post-send clause and acceptance 14's
"more messages" clause are unproven by automated test; both were verified in
the orchestrator's live phone QA (self-qa.md) and C-2 is an inherited hole
(untested on main too). No action.

## Verified directly by the planner

- IAM `dynamodb:ConditionCheckItem` IS granted (`infra/modules/ec2/main.tf:55`)
  - the handback's "no Terraform owed" claim holds; closes the conformance
  reviewer's one unverifiable item.
- The transactional sweep, the conversion finalize-rotation, and
  `streamAnchor.ts` read per spec (planner's own diff read, before the
  reviewers landed).

## The worktree-deletion incident (cause undetermined)

At ~22:29 local, mid-battery, 1,158 tracked files (all of `app/`, part of
`dashboard/`) were deleted from the WORKING TREE of this worktree. HEAD was
never touched; `git restore .` recovered everything byte-identical; the two
in-flight reviewers had already read the intact tree and the adversarial one
reported the deletion in real time. The e2e run in flight at the time watched
its own app vanish (mass 0ms failures, Vite full-reload on "changed tsconfig")
and its result was DISCARDED; gates G1-G3 and G5 completed BEFORE the deletion
on an intact tree and stand. Suspects, neither proven: the planner's throwaway
eslint-baseline worktree (created/removed around that window, with an MSYS
symlink involved) or the killed-run-orphan e2e stack interacting with the live
lane. Mitigation adopted: no temp-worktree surgery while a suite runs from the
tree, and never symlink node_modules across worktrees. G4 was re-run on the
restored tree; its result is the one quoted in the verdict.
