# Share sent outcome (Branch B) - planner's verdict

Date: 2026-09-28. Planner: Claude Fable 5.1. Branch `feat/share-sent-outcome`,
worktree `W:\tmp\share-sent-outcome`.

**VERDICT: MERGE-READY at d653d4be (code final 70e49441 on top of the build's
e824a452; d653d4be is the second main sync, docs-only), UNMERGED - the human
merges.**

## The five gates, run by the planner on the FINAL tree (d653d4be), bare, each its own command, on a quiet tree

- `npm run typecheck` -> `EXIT=0`.
- `npm test` (after `npm run db:stop; npm run db:start`) -> `EXIT=0`: Test
  Files 399 passed (app), 210 (dashboard), 21 (e2e workspace), 34
  (fake-twilio), 13 (fake-twilio-web); zero `[dynamoAdmin]` lines.
- `npm run smoke` -> `EXIT=0` (1545 import specifiers across 268 emitted files
  resolve under plain Node).
- `timeout 1800 npm run e2e` -> `EXIT=0`: `304 passed (25.3m)`. The lane's
  ports were free afterwards (only DynamoDB Local on 8000 listens).
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts'
  '*.tsx' '*.js' '*.mjs' '*.cjs')` -> `EXIT=0` over 72 files, zero output.

The same five were green on the build's handback tree (6e449c22, before the
planner's fix wave: e2e `304 passed (23.0m)`), and the orchestrator's own
final battery at 6e449c22 quoted the same.

## What the planner did after the handback (a33e0d7f)

1. Read the handback and the riskiest diffs (the slot-transition service, the
   webhook hunk, the reconcile and job insertions) and the self-QA
   screenshots (seven states; all as specified; one mis-timed 404 capture
   superseded by scenario (b)'s pending capture).
2. Two read-only reviewers in parallel: spec conformance
   (`planner-review-conformance.md`: 92 items, 89 CONFORMS / 3 PARTIAL / 0
   MISSING; every declared deviation allowed) and plan-blind adversarial
   (`planner-review-adversarial.md`: 0 CRITICAL / 1 HIGH / 1 MEDIUM / 8 LOW).
3. Adjudicated both (`planner-review-adjudications.md`): four small code
   fixes and docs; the HIGH REJECTED as a defect of this branch (spec D2 and
   I7 chose it: a retry's acceptance is written by nobody, the slot learns a
   retry from its receipts; the residual - both the `sent` confirmation and
   the terminal receipt lost - is filed as
   `share-retry-rollup-lost-past-reread-bound` and healed by a repair re-run).
4. The fix wave (one Opus implementer; `planner-fix-wave.md` @8017f30e):
   68cfde58 the repair leaves an empty-chain failed-30003 slot's legacy
   ledger row alone (the spec's "left as they are"); 72325cb3 a miss is
   `slot_unmatched` (WARN: the record phase pending or an unstamped chain) or
   `no_slot` (ERROR: a routing bug), and the RUNBOOK's re-run list and its
   Logs Insights query carry those lines plus the webhook's unknown-SID drop;
   8e061e5a the retry job's arms bound their slot write like every other
   site; 70e49441 the repair's stale bound reads the last reconcile delay;
   9d8368e9 docs (the handback's issues sentence, two more declared
   deviations, the residuals, spec D6/D7 errata, the RUNBOOK's cap note and
   unmeasured-cost note). Spec D1 erratum committed at aa2f61d6 (the
   milestone's words are D6's, not a strict reading).
5. Synced main a second time (d653d4be): main had gained docs-only commits
   (the human's cleanup of the share-skip-fix and retry-send-window branches);
   a clean merge, RUNBOOK auto-merged without conflict.
6. The final battery above.

## For Cameron at the merge

- CONFIRM the D1/D6 ruling: the tenant's "Property sent" pin reads "Property
  sent" while a retry is pending (D6, as gated); D1 is corrected to say so.
  If you meant the strict reading, it is a one-word change in
  `propertySentWords` plus its tests - say so.
- The filter tabs go by STORED status while the pills derive from the
  recipients (spec D4 kept the tabs): the "Failed" tab can hold a "Sent"
  pill and a finished share reading "Sending" is not under the "Sending"
  tab. A UX call for later, not a defect.
- The recipient cap is now 1000 (you approved it at the spec gate); a
  1001-1500 blast is refused and the preview is cut at 1000.

## Post-merge obligations (LOUD; nothing infra)

1. Deploy as usual (no Terraform, no secrets, no flags, no schema, no
   dependency; the ledger's byContact index goes sparse by attribute absence -
   a contract note only).
2. THE REPAIR, IN THIS ORDER, DEV THEN PROD, BEFORE THE NEXT PROPERTY BLAST:
   `npx tsx app/scripts/repair-share-outcomes.ts --env dev` (the census - read
   the report; time it), then the same with `--apply`, then prod the same
   way (RUNBOOK "Share outcomes repair (2026-09-28)"). Until the apply runs,
   a tenant whose 30003 retry delivered BEFORE the deploy is not flagged
   "Already sent" on a new share of that property (the historical error flips
   from over-flagging to under-flagging - a double text at most). An apply
   that exits 1 "COMPLETED WITH FAILURES" closed the window for every slot
   except the ones its ERROR lines name; an ABORTED apply for none - fix and
   re-run. The repair is re-runnable; the RUNBOOK names the log lines that
   mean "re-run it".
3. The three closed issues already read `status: resolved` on the branch; the
   merge carries them. Seven LOW residuals are filed with their own issues.
4. Cleanup (this worktree, the pinned `share-skip-fix-ops` worktree, the
   scratchpad plan parts) only on your explicit ask.

## The merge command (from the shared main checkout; never from a worktree)

```
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/share-sent-outcome
```

## Records

`docs/superpowers/reviews/2026-09-27-share-sent-outcome/`: the spec and plan
review rounds (four each, with adjudications), three research records, the
mission block, five slice reports and two fix-wave reports under `build/`,
five code-review files, `self-qa.md`, `handback.md`, the planner's two review
reports and adjudications, `planner-fix-wave.md`, this verdict. The gitignored
`.superpowers/` holds the ledger, the live log, the gate logs
(`.superpowers/planner/final/*.log` are the planner's) and the byte-exact
research references.
