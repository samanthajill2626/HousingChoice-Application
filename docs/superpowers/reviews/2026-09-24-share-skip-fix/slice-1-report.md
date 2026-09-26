# Slice 1 report - census, fix script, import default, RUNBOOK (plan Tasks 1-5)

Date: 2026-09-25. Build orchestrator (Fable 5.1, AUTO mode). Branch `feat/share-skip-fix`,
base main@bbaad87d. **Hand-off SHA: see the last section** (the source is at `7ecaf254`;
this report is a docs-only commit on top of it).

## What slice 1 delivers

- D1 `app/scripts/conversation-automation-census.ts` - read-only census of the `ai_mode`
  switch (counts by type/state, switched-off rows by cause, the breaker-tripped list with
  its evidence, pending tour rungs replayed through the reminder job's own routing as an
  upper bound, held nudges, import claim mismatches).
- D2 `app/scripts/enable-conversation-automation.ts` - dry-run-first fix script: bulk mode
  switches one-to-one `manual` rows to `auto` (typeless rows included, group threads and
  pointer items never; breaker-tripped rows excluded unless `--include-breaker-tripped`);
  single mode (`--conversation <id>`) resumes one row; every switch and its `mode_changed`
  audit event land in ONE `TransactWriteItems`; every write conditional.
- `app/scripts/lib/stageClient.ts` - the shared `--env local|dev|prod` resolver:
  `--lane <L>` selects a hermetic e2e lane's prefix AND access key; dev/prod assert account
  938565869261 on the `housingchoice` profile, build the client from those credentials,
  pin the regional DynamoDB endpoint, refuse any `AWS_ENDPOINT_URL*` shell variable;
  unknown, repeated and malformed arguments are usage refusals (exit 2).
- D3 `app/src/lib/import/apply.ts` - imported one-to-one conversations are `auto`; group
  rows stay `manual`; `if_not_exists` keeps a re-run from changing an existing row.
- D9 `RUNBOOK.md` - "One-to-one conversation automation switch (2026-09-25)": the
  census / dry run / apply sequence (dev then prod, from the pinned ops checkout), the
  per-environment import-window rule, and "a conversation tripped the breaker".
- `app/src/repos/auditRepo.ts` gains `transactPut` (the one audit item builder, shared with
  `append`); `app/src/lib/unreadFeed.ts` exports `POINTER_PARTITION_PREFIXES`.

## Commits (oldest first)

Records: 022e890c (build research + adjudications), 79641c09 (slice-1 review round 1),
5e233c4a (round 2). Source:

| Commit | Subject |
|---|---|
| 524fcf41 | feat(ops): conversation-automation census (read-only) + guarded stage resolver |
| c942ce20 | feat(ops): enable-conversation-automation - dry-run-first fix script (spec D2) |
| cd91837e | fix(import): one-to-one conversations import with ai_mode auto (spec D3) |
| 9a8021eb | docs(runbook): conversation automation switch - census, fix script, breaker resume (spec D9) |
| f0a6fbc0 | fix(ops): the breaker's send counter is trip evidence (slice-1 review item 1) |
| 1ba49fc0 | fix(ops): switch + audit event in ONE transaction per row (slice-1 review items 2, 12) |
| 9405d678 | fix(ops): parser + endpoint guards, pre-run failure wording, test hardening (items 3-11) |
| 5a85a01e | docs(runbook): automation switch - what the fix wave made true (items 1, 2, 12-14) |
| cff2f11c | fix(ops): pin the dev/prod DynamoDB endpoint; audited-trip evidence and time (r2 items 1-4) |
| 7ecaf254 | docs(runbook): automation switch - what wave 2 made true (r2 items 2, 4-7) |

## Review rounds

- Research (live-tree drift check, 3 readers): `build-research-*-findings.md`,
  `build-research-adjudications.md` - 2 MUST-ADJUST folded into Task 1 (parser tests) and
  Task 4 (`file://` recipes).
- Round 1 (spec-conformance + plan-blind adversarial on 9a8021eb):
  `slice-1-review-conformance.md` (0/5/6), `slice-1-review-adversarial.md` (0/4/4),
  `slice-1-review-adjudications.md` - 14 accepted items, fix wave f0a6fbc0..5a85a01e.
  The two mechanisms: a mid-run breaker trip cannot lose the conditional write (the trip
  writes `manual`), so the breaker's send counter is now trip evidence at planning, in the
  bulk write condition and in the census; and the switch + audit event are one transaction.
- Round 2 (fresh reviewer on the fix wave): `slice-1-review-r2.md` (0/2/7; 12 of 14
  round-1 items proven by mutation, 2 CLI-only), `slice-1-review-r2-adjudications.md` -
  7 accepted items, wave 2 cff2f11c..7ecaf254, re-verified by the orchestrator (diff read,
  suites, rehearsal, gates).

## Gates at 7ecaf254 (bare, output to files under `.superpowers/sdd/gates-s1/`)

- `npm run typecheck` -> `typecheck EXIT=0`
- `npm run smoke` -> `smoke-dist: OK - 1413 import specifier(s) across 248 emitted file(s) resolve under plain Node.` / `smoke EXIT=0`
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (11 files) -> `eslint EXIT=1`, exactly the two PRE-EXISTING errors (present at the merge base at :739:59 / :818:59, shifted by the Task 3 edit):
  `app/test/importApply.integration.test.ts 745:59 error Unexpected any @typescript-eslint/no-explicit-any` and `824:59` the same - no new errors (gate-5 rule: no NEW errors in touched files).
- `npm test` -> `EXIT=0`. Test Files per workspace (app; dashboard; e2e; fake-twilio; fake-twilio/web): 369 passed (369); 191 passed (191); 21 passed (21); 34 passed (34); 13 passed (13). `[dynamoAdmin]` lines: 0 (a nonzero count would be one real container fault, per AGENTS.md).
- Slice suites (implementer, one file per run, at 7ecaf254): stageClient 29/29,
  conversationAutomationCensus 2/2, enableConversationAutomation 10/10, unreadFeed 26/26,
  dynamoAccessKeyGuard 15/15, m14.integration 11/11, importGroupGuards 16/16,
  importApply.integration 32/32.
- ASCII: 0 non-ASCII bytes in every added line since the base (non-docs files).
- `npm run e2e` is NOT a slice gate (no UI or e2e change in slice 1; it runs at Task 15).

## Lane rehearsal (plan Task 5 Step 2, with the adjudicated additions)

Hermetic lane 15 (`hc-local-15-`, DynamoDB Local database `hclane15`) started by
`npm run e2e:session` from this worktree, lean seed. Every write below was made through the
lane's own key; nothing touched the live local stack, dev or prod. The scripts were run with
`--env local --lane 15`. Logs: `.superpowers/sdd/rehearsal-s1/*.log` (run state).
An earlier attempt misfired on the orchestrator's own driver script (a POSIX path handed to
node, so the lane number was empty): every CLI call was refused at parse time (exit 2),
nothing resolved, nothing written; the session was reseeded and stopped cleanly and rebooted.

| Step | Command / action | Result (quoted from the log) |
|---|---|---|
| 01 | census, untouched lean world | `scannedRows:3, pointerRows:0, byType:{group_text:{manual:1}, tenant_1to1:{unset:1}, relay_group:{manual:1}}, manualByCause:{groupThread:2, breakerTrip:0, imported:0, other:0}`, `breakerTrippedUnaudited:0`, EXIT=0 |
| 02 | dry run, untouched | `groupRows:2, alreadyOn:0, unset:1, breakerTrippedExcluded:0, planned:0, enabled:0` (DRY RUN - nothing written), EXIT=0 |
| 03 | flip `conv-0001` to `manual` (AWS CLI, key hclane15) | `"ai_mode": {"S": "manual"}`, EXIT=0 |
| 04 | census after the flip | `tenant_1to1:{manual:1}`, `manualByCause:{groupThread:2, breakerTrip:0, imported:0, other:1}`, EXIT=0 |
| 05 | dry run | `DRY RUN: would switch on conv-0001 (tenant_1to1)`; `planned:1, enabled:0, byType:{tenant_1to1:1}`, EXIT=0 |
| 06 | `--apply` | `conversation switched on conv-0001 reason bulk_enable`; `planned:1, enabled:1, byType:{tenant_1to1:1}, skippedOnCondition:0, failed:0`, EXIT=0 |
| 07 | `--apply` again | `alreadyOn:1, planned:0, enabled:0` (a no-op), EXIT=0 |
| 08 | census after the apply | `tenant_1to1:{auto:1}`, `manualByCause.other:0`, EXIT=0 |
| 09 | flip `conv-0001` to `manual` again | EXIT=0 |
| 10 | `--apply --conversation conv-0001` (single mode) | `single mode: targeting one conversation conv-0001`; `switched on reason operator_resume`; `scanned:1, planned:1, enabled:1`, EXIT=0 |
| 11 | single mode again | `alreadyOn:1, planned:0, enabled:0`, EXIT=0 |
| 12 | flip to `manual` AND stamp `outbound_minute_bucket=2026-09-25T17:00`, `outbound_minute_count=11` (a trip whose audit event is missing) | EXIT=0 |
| 13 | census | `manualByCause.breakerTrip:1`; listed `conv-0001 tenant_1to1 trippedAt 2026-09-25T17:00 evidence send_counter`; done line `breakerTripped:1, breakerTrippedUnaudited:1`, EXIT=0 |
| 14 | dry run | `breaker-tripped row excluded ... evidence send_counter`; `breakerTrippedExcluded:1, planned:0`, EXIT=0 |
| 15 | `--apply` | still excluded: `breakerTrippedExcluded:1, planned:0, enabled:0`, EXIT=0 |
| 16 | `--apply --include-breaker-tripped` | `switched on conv-0001 reason bulk_enable`; `breakerTrippedExcluded:0, planned:1, enabled:1`, EXIT=0 |
| 17 | census, final | `tenant_1to1:{auto:1}`, `breakerTrip:0`, `breakerTrippedUnaudited:0`, EXIT=0 |
| 18 | `--env local --lane 15 --env local` (repeated `--env`) | usage printed, EXIT=2, no stage resolved |
| 19 | `--apply --conversation conv-0001 --include-breaker-tripped` | usage printed, EXIT=2, no stage resolved |
| 20 | `--env local --lane 0` | usage printed, EXIT=2 |
| 21 | `--dry-run` (unknown flag) | usage printed, EXIT=2 |
| 22 | `--apply --conversation <the lean group_text id>` | `conversation ... is not a one-to-one conversation - refusing`, EXIT=2 |
| 23 | `--apply --conversation conv-does-not-exist` | `conversation conv-does-not-exist not found`, EXIT=2 |
| 24 | Query `conversations#conv-0001` in the lane's audit table | three `mode_changed` items, newest first: `bulk_enable` (step 16), `operator_resume` (step 10), `bulk_enable` (step 06) - one event per switch, each landed with its switch (the transaction) |
| 25 | `npm run e2e:reseed` (restore the lean world) | EXIT=0 |
| 26 | `npm run e2e:stop` | EXIT=0; the lane's four ports free afterwards |

Every count matches the plan's expectation (planned 0 on the untouched lean world before
Task 13's Dario row lands; dry run and apply agree; the second apply is a no-op) and the
adjudicated additions (a written apply, single-mode resume, the send-counter path, the CLI
refusals the round-2 reviewer asked for). The first log line of every run named the target
(`DynamoDB Local http://localhost:8000 database hclane15 (e2e lane 15)`, prefix
`hc-local-15-`).

## For Cameron's runs (the planner hands these over)

Pinned checkout at the hand-off SHA, `npm ci` there, then from that directory, dev first:
`npx tsx app/scripts/conversation-automation-census.ts --env dev`;
`npx tsx app/scripts/enable-conversation-automation.ts --env dev` (dry run);
`npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply`; then the same
three with `--env prod`. The RUNBOOK section carries the reading guide (breaker list with
its `evidence`, `planned` vs `enabled`, `skippedOnCondition`, the per-environment
import-window rule, exit codes). The prod census numbers and the apply outcome are his to
report back; the handback carries them as PENDING until then.

## Recorded, not built (all in the adjudication files)

- The census copies the reminder job's private one-to-one rung route and casts
  `resolveUsableGroup`'s deps; the scripts' import closure (47 modules) is why the pinned
  checkout exists; no test drives argv -> exit code (the rehearsal above is that proof);
  imported conversation ids are phone-derived pseudonyms (spec D1 lists ids by design);
  an app write to a row during that row's transaction can fail once with
  `TransactionConflictException` (RUNBOOK says so).
- To be FILED at handback (pre-existing, out of scope): `RUNBOOK.md:1797`'s inline-JSON
  `scan` recipe (PS 5.1 strips the quotes); `import-apply.ts` / `rail-verify.ts` build
  their AWS clients without a pinned endpoint (the same exposure the stage resolver now
  closes for these two scripts); `app/scripts/backfill-unread-flag.ts` keeps its own
  pointer-prefix copy.

## Hand-off SHA

**Hand-off SHA: `280186f3`** - a docs-only commit (this report plus the three
issue filings) on top of the proven source SHA `7ecaf254`. Nothing under
`app/`, `e2e/` or `RUNBOOK.md` changes between the two, so every gate and
rehearsal result above applies to `280186f3` verbatim. The planner cuts the
pinned ops worktree at this SHA: `git worktree add --detach
W:\tmp\share-skip-fix-ops 280186f3` from the shared repo, `npm ci` there, then
census / dry run / apply, dev then prod.
