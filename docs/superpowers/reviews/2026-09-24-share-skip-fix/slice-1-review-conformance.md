# Slice 1 review - SPEC CONFORMANCE (share-skip-fix, Branch A)

Date: 2026-09-25. Reviewer: spec-conformance (read-only). Branch `feat/share-skip-fix`,
HEAD `9a8021eb`, base `main@bbaad87d`. Contract: spec
`docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (D1, D2, D3, D9, I5-I7,
sections 5, 6.1, 7, 8); plan Tasks 1-5; build-research adjudications F1/F2; the
implementer report.

Method: read the whole diff package, the spec, plan Tasks 1-5, the adjudications and the
implementer report; checked every cited runtime anchor in the live tree
(`sendMessage.ts`, `tourReminders.ts`, `auditRepo.ts`, `unreadFeed.ts`, `hcAws.mjs`,
`import/apply.ts`, the repos the census reads, infra alarms, RUNBOOK cross-references).
One THROWAWAY vitest file (6 probes, P1-P6 below) ran once against DynamoDB Local, exit 0,
6/6 passed, then was deleted; `git status` is clean. Both CLIs were run ONLY on their usage
path (`--env staging` / no arguments): exit 2 each, usage printed, no environment resolved.
No script was run with `--env local|dev|prod`; no `npm test` / e2e.

Paths below: `census.ts` = `app/scripts/conversation-automation-census.ts`, `enable.ts` =
`app/scripts/enable-conversation-automation.ts`, `stageClient.ts` =
`app/scripts/lib/stageClient.ts`, tests are under `app/test/`.

## Verdict table

| Work-map item | Verdict | Evidence |
|---|---|---|
| D1 rows by type and switch state; pointer items excluded; typeless rows their own group | CONFORMS | census.ts:61, :92-100, :170-180; conversationAutomationCensus.test.ts:118-126 |
| D1 switched-off by cause, precedence group > breaker > imported > other | CONFORMS | census.ts:181-202; test :127 (c-breaker is imported AND tripped -> breakerTrip) |
| D1 breaker-tripped list (id, type, trip time) | CONFORMS | census.ts:106-120, :190-199, :286-288; test :128-130 |
| D1 pending tour rungs, job routing replayed, reported as upper bound | CONFORMS | census.ts:213-274, :290-297 (job's own exports tourReminders.ts:184, :312, :1496; 1:1 half is a copy, see F9); test :135-144 |
| D1 pending nudges reported separately | CONFORMS | census.ts:277-278; test :145 |
| D1 import claim mismatches | CONFORMS (code); test PARTIAL | census.ts:181-183, :207-211; test :131 proves nothing about the missing-claim rule (F4c) |
| D1 counts only, no PII | CONFORMS | census.ts:284-299 logs counts + ids; ids are uuidv5 (app/src/lib/import/ids.ts:64-65) |
| D1 read-only proven by test | PARTIAL | test :153-155 compares 3 of the 6 tables read; P2 proves all six (F4b) |
| D2 dry run default; explicit `--apply` | CONFORMS | enable.ts:239-240, :300; stageClient.test.ts:98-105; enableConversationAutomation.test.ts:73-96 (weak, F4a) |
| D2 population: `ai_mode` exactly manual, not relay_group/group_text, typeless in, pointers never | CONFORMS | enable.ts:106-116, :164-170; unreadFeed.ts:295-297; test :98-110 |
| D2 breaker-tripped excluded unless flagged | CONFORMS | enable.ts:114, :209-211; test :82, :124-130 |
| D2 single mode resumes one; refuses group / unknown | CONFORMS | enable.ts:246-254; test :131-154; P6 (group_text and pointer ids refused too) |
| D2 every write conditional | CONFORMS (code) | enable.ts:161-183; test :156-184 exercises only the ai_mode half; P3/P4 prove the type and existence halves (F4d) |
| D2 audit event per enable; reason bulk vs resume | CONFORMS | enable.ts:189-202; test :111-118, :137-141 |
| D2 output counts by type (+ the one id in single mode) | CONFORMS | enable.ts:80, :152-156, :236-238; test :89, :143 (byType = planned, F10) |
| D2 target safety (prefix, target logged before first read, 938565869261 on the profile, client from those credentials, injectable guard) | CONFORMS | stageClient.ts:96-98, :121-139; census.ts:313-318; enable.ts:303; hcAws.mjs:14, :30-31; stageClient.test.ts:53-82 (argv hole, F3) |
| D2 only Cameron runs it on dev/prod (documented) | CONFORMS | RUNBOOK.md:372; enable.ts:39-43; census.ts:30-35 |
| D3 import default (1:1 auto, group manual, re-run never changes a switch) | CONFORMS | app/src/lib/import/apply.ts:1087-1093, :1114; importGroupGuards.test.ts:201-221; importApply.integration.test.ts:245-252 |
| D9 RUNBOOK (trip-finding x4, single-mode resume, D1/D2 dev+prod, import-window rule, file:// recipes) | PARTIAL | RUNBOOK.md:337-372: every element present, file:// at :350 and :365; step 3 states a false mechanism (F1); import window narrower than spec 6.1 (F5); resume wording (F7) |
| I5 nothing turns a switch OFF | CONFORMS | enable.ts:164 (only `SET ai_mode = :auto`); apply.ts:1114 writes manual only for groups, unchanged, under `if_not_exists` (:1093); census and dry run issue only reads (P2) |
| I6 D2 only on, only 1:1, audits every change (incl. lost audit) | PARTIAL | enable.ts:161-202; test :186-206 (thrown audit write named + exit 1); an interrupt between the two writes is silent (F2) |
| I7 prod written only by the Cameron-run script; no infra/index/dependency change | CONFORMS | diff touches 10 files; `git diff --stat bbaad87d..HEAD -- package.json app/package.json package-lock.json infra dashboard e2e scripts` is empty |
| Spec 7 D2 acceptance list | PARTIAL | 5 of 7 bullets proved; 2 under-proved (mapping below) |
| Global: ASCII added lines; no new runtime dependency; nothing touches dev/prod | CONFORMS | 0 non-ASCII bytes in added lines of all 10 files; no package change; stageClient.test.ts builds dev/prod clients only with injected fakes and never sends |

## Spec section 7 - D2 acceptance mapping

| Acceptance bullet | Test (file:line) | Verdict |
|---|---|---|
| the dry run writes nothing | enableConversationAutomation.test.ts:73-96 (asserts c-import and c-typeless still manual :92-93, no mode events for c-import :94) | PARTIAL - two rows and one audit partition, not the tables (F4a); P2 shows the dry run issues only Scan/Query |
| apply switches on only 1:1 manual rows (typeless in, groups never) | :98-110 (:103 typeless on, :108-109 groups untouched, unset and pointer untouched) | CONFORMS |
| breaker-tripped rows skipped unless included | :82, :105, :124-130 | CONFORMS |
| single mode refuses group threads | :146-149 (relay_group), :150-152 (unknown id) | CONFORMS (group_text shares the predicate; P6) |
| a re-run changes nothing | :119-121 | CONFORMS |
| every change is audited | :111-118 (c-import only), :137-141 (operator_resume), :186-206 (lost audit) | PARTIAL - c-typeless's event is never asserted (F4e); the interrupt gap is untestable by design (F2) |
| a real-AWS run on the wrong account refuses | stageClient.test.ts:61-67 | CONFORMS |

## Throwaway probes (run once, file deleted)

- P1 `parseStageArgs(['--env','dev','--apply','--env','prod'])` -> target `prod`; a repeated `--conversation a ... b` -> `b`. PASS (confirms F3).
- P2 A command-recording client around the census (all 6 tables seeded) and the fix-script dry run: census sent only GetCommand/QueryCommand/ScanCommand (10 commands), dry run only QueryCommand/ScanCommand (3). PASS - read-only holds across every table.
- P3 Between the Scan and the write, c-import's type set to group_text -> `{ planned: 1, enabled: 0, skippedOnCondition: 1 }`, row still manual. PASS.
- P4 Between the Scan and the write, c-import deleted -> `skippedOnCondition: 1`, row NOT resurrected. PASS.
- P5 The breaker's real order (sendMessage.ts:352 setMode FIRST, :354-358 audit append SECOND): row already manual, the `breaker_trip` event appended right after the run's trip Query -> `{ planned: 1, enabled: 1, skippedOnCondition: 0, breakerTrippedExcluded: 0 }`, row back to auto, events `[breaker_trip, bulk_enable]`. PASS (confirms F1).
- P6 Single mode on a row with no `ai_mode` -> `{ unset: 1, alreadyOn: 0, planned: 0 }`; group_text id and `phone#` id -> UsageError. PASS.

## Findings

### F1 - SHOULD-FIX - RUNBOOK step 3 promises the opposite of spec section 8 about a mid-run breaker trip

Evidence: RUNBOOK.md:347 says "a breaker trip that lands mid-run keeps the runtime's
outcome (`skippedOnCondition`)"; enable.ts:23-25 says "a concurrent runtime write [is]
safe: a lost condition is counted `skippedOnCondition`". The only runtime writer of the
switch is the breaker, and it WRITES `manual` (sendMessage.ts:352), which the condition
`ai_mode = :manual` (enable.ts:168-170) ACCEPTS - no trip can ever lose the condition. A
trip can only reach a row that is `auto` (the manual refusal precedes the counter,
sendMessage.ts:349-350): if the Scan already saw it `auto` it is counted `alreadyOn`; if
the setMode landed before the Scan but the audit event is not yet readable by the trip
Query (appended after setMode, sendMessage.ts:354-358; eventually consistent Query,
census.ts:106-120), the run switches it back on and counts it `enabled` (P5). That is
exactly spec section 8's accepted risk ("may be switched back on by that run"), so the
CODE conforms; the Cameron-facing text does not. The committed test
enableConversationAutomation.test.ts:156 is named "a row the breaker switches OFF again
mid-run keeps the runtime outcome" but its race (:160-173) switches the row ON (`auto`);
it proves idempotency against a concurrent run, not the named spec behavior. Related, same
root: a trip whose own audit append failed has no `mode_changed` event at all, so both
scripts file it as imported/other and the bulk apply enables it (spec-conformant: D1/D2
define "on record" as the audit event).

Fix (before the hand-off SHA): RUNBOOK.md:347 -> "Every write is CONDITIONAL on the row
still being a one-to-one conversation with the switch off, so a row another run switched
on, a row deleted, or a row turned into a group thread mid-run is counted
`skippedOnCondition`, and a re-run is a no-op. A breaker trip is not caught by the
condition (the trip writes `manual`): a trip landing within about a second of the run
checking that row can be switched back on (spec section 8; the breaker re-trips on its
next capped minute). Re-run the census after the apply and compare its breaker list."
Same correction in enable.ts:23-25. Rename test :156 to what it proves ("a row switched on
elsewhere mid-run loses the conditional write and is counted"). Optional: `ConsistentRead:
true` in findBreakerTrip (census.ts:111-118; queryAll passes it through) narrows the
eventual-consistency part; it cannot close the breaker's own setMode-then-append gap.

### F2 - SHOULD-FIX - I6: an interrupted apply leaves a switched-on row with no audit event, silently

Evidence: the switch write (enable.ts:161-179) and the audit append (:190-195) are two
operations. The lost-audit path (:196-201) covers a THROWN append only. A Ctrl-C, a closed
terminal or a killed process after the Update lands and before the Put lands leaves the
switch on, no `mode_changed` event, no ERROR line, and a re-run reports the row
`alreadyOn` (planRow :112) - spec I6 "audits every change" and the header's "never
silently not" (:32-33) both fail for that row. The window is one Put round trip per row,
i.e. a large share of any mid-apply interrupt.

Fix, minimal (RUNBOOK only, before hand-off): add to step 3 "Do not interrupt an apply. If
one was interrupted, find the LAST `conversation switched on` line: if no `audit event
appended` line with `entityKey: conversations#<that id>` follows it, query that partition
(the recipe below) and backfill with the step-3 recipe if the event is absent." Complete
fix (code): one TransactWriteItems per row (the conditional Update plus the audit Put,
item shape as auditRepo.ts:60-83) so both land or neither; a lost condition then surfaces
as `TransactionCanceledException` with reason `ConditionalCheckFailed` -> `skippedOnCondition`,
and the auditFailed path disappears.

### F3 - SHOULD-FIX - a repeated value flag silently takes the last value (`--env dev ... --env prod` -> prod)

Evidence: stageClient.ts:156-162 (`values.set(a, v)` overwrites); P1. dev and prod live
in ONE account (hcAws.mjs:14; stageClient.ts:121-129), so the account guard cannot catch a
dev/prod swap - argv is the only defense, and RUNBOOK.md:343 promises "a mistyped flag
must never turn a rehearsal into a live apply". Not a literal spec clause (D2 asks for an
explicit prefix and a logged target, both present), but it defeats the stated purpose of
the unknown-argument refusal. Implementer item d.

Fix: in parseStageArgs, refuse any value or flag seen twice (`if (values.has(a) ||
flags.has(a)) return { usage: true };`) and add `['--env','dev','--apply','--env','prod']`
and `['--env','dev','--conversation','a','--conversation','b']` to the usage `it.each`
at stageClient.test.ts:118-132.

### F4 - SHOULD-FIX - tests under-prove four spec clauses (question a)

- a. "The dry run writes nothing" (spec 7, first bullet) is asserted on two rows and one
  audit partition (enableConversationAutomation.test.ts:92-94). Fix: whole-table equality
  of conversations and audit_events before/after (as the census test does at
  conversationAutomationCensus.test.ts:153-155), or a command recorder asserting only
  Scan/Query/Get (P2 shows that holds today).
- b. Census "read-only proven by test" compares 3 of the 6 tables it reads (:153-155;
  contacts, tours, placementNudges unchecked). Fix: the same recorder (P2: 10 commands,
  Get/Query/Scan only).
- c. `importClaimMismatches: 1` (:131) follows from the fixture by construction: no
  imported one-to-one row lacks a claim, so an implementation that counted a MISSING claim
  as a mismatch also yields 1, and spec D1's "a missing claim is the normal state" is
  unproven; `importedOneToOneRows` is never asserted. Fix: seed one imported one-to-one
  row with no `phone#` claim; expect mismatches still 1 and `importedOneToOneRows` 3.
- d. The write condition's type half and existence half (enable.ts:168-170) are never
  exercised; spec D2 says the write is conditional on the row "still being a one-to-one
  conversation". Fix: add P3 and P4 as committed cases.
- e. "Every change is audited": the apply test asserts c-import's event only (:111-118);
  assert c-typeless's too (or count `mode_changed`/`bulk_enable` events == `enabled`).

(The census's routing counts are NOT fixture-by-construction: groupRouted/fallback run the
job's own exported `resolveUsableGroup`, and the retire gates run the job's
`retiredByTourStart` / `isSupersededRung` / `DISCONTINUED_REMINDER_KINDS`.)

### F5 - SHOULD-FIX - the import-window rule is narrower than spec 6.1

Evidence: RUNBOOK.md:355 starts the window at "the prod apply"; spec section 6 item 1 says
"between D2 apply and the merge" - so an `import:apply` from `main` into dev after the dev
apply (and before the merge) is not forbidden by the RUNBOOK and would recreate switched-off
dev rows. Fix: "between an environment's apply and the MERGE of this branch, do NOT run
`import:apply` from `main` against that environment ... If one must run, re-run step 3 for
that environment afterwards (idempotent)."

### F6 - NOTE - implementer items b-d (question c)

b (eventually consistent trip Query) is inside spec section 8's accepted risk, so it is not
a conformance gap; its only defect is the RUNBOOK text in F1. c (below, F8) is wording. d is
F3: not a literal spec clause, but it undermines D2's target-safety intent because dev and
prod share an account - hence SHOULD-FIX.

### F7 - NOTE - resume wording: a row with no switch value reports `unset`, not `alreadyOn`

Evidence: RUNBOOK.md:370 says single mode "reports `alreadyOn` when there is nothing to
do"; for a row with no `ai_mode` it reports `unset: 1` (planRow enable.ts:113; P6). Fix:
"reports `alreadyOn` (or `unset`: no switch value, which already sends) when there is
nothing to do".

### F8 - NOTE - "FAILED (see the PARTIAL report above)" after a pre-run refusal

Evidence: enable.ts:320. An ACCOUNT GUARD, `--lane` with dev/prod, or STS failure rejects
inside resolveStageClient, before any PARTIAL report exists. Exit 1 and the refusal text
(`err`) are logged, so no safety impact. Fix: catch the resolve separately and log
"FAILED before the run started".

### F9 - NOTE - the census's one-to-one rung route is a copy, not a replay

Evidence: census.ts:259-266 duplicates tourReminders.ts:1072-1093 (resolveReminderTarget is
private); the retire gates and group routing do call the job's exports. Today they agree
line for line. A future change to the job's 1:1 predicate would not reach the census. The
`unresolvable` path and the `unset -> oneToOneSwitchedOn` path are not exercised by the test.
Acceptable for a one-time script; export resolveReminderTarget if it is kept.

### F10 - NOTE - `byType` counts PLANNED rows

Evidence: enable.ts:80, :236-238. On an apply with `skippedOnCondition > 0` it overstates
what changed by type; `enabled` and the per-id `conversation switched on` lines are the
truth. The handback's "what D2 changed" should quote `enabled`, not `byType`.

### F11 - NOTE - no test runs either CLI end to end; Task 5 Step 2 must precede the hand-off

Evidence: nothing exercises argv -> resolveStageClient -> run -> report -> exit code
(implementer item a). This review ran only the usage path under tsx on Windows: both
scripts load their module graph, `invokedDirectly` fires, usage prints, exit 2. No
`slice-1-report.md` exists at 9a8021eb, so the plan's lane rehearsal (plan Task 5 Step 2,
with adjudication F2b's one-row manual switch) has not been recorded yet; the hand-off SHA
should come after it and after the F1-F3/F5 fixes.

## Question b - RUNBOOK promises checked against the code

- Flags `--env`, `--lane`, `--apply`, `--conversation`, `--include-breaker-tripped`: TRUE
  (stageClient.ts:148-172; enable.ts:289-291).
- Exit codes: usage and single-mode refusal exit 2 (enable.ts:312-318; verified live for the
  usage path); `failed > 0` or `auditFailed > 0` exits 1 with `COMPLETED WITH FAILURES`
  (:272-280): TRUE.
- Counter names (`planned`, `breakerTrippedExcluded`, `groupRows`, `alreadyOn`, `unset`,
  `pointerRows`, `skippedOnCondition`, `auditFailed`, `failed`,
  `pendingTourRungs.oneToOneSwitchedOff` / `oneToOneBreakerTripped` / `groupRouted`): TRUE
  (enable.ts:69-89; census.ts:68-90).
- Reasons `bulk_enable` / `operator_resume`: TRUE (enable.ts:63, :193, :253, :266).
- Backfill item shape vs `auditRepo.append`: TRUE - `entityKey`, `ts` `<ISO>#<suffix>`,
  `event_type`, `payload`, no `actorId` for a system action (auditRepo.ts:60-83); the
  recipe (RUNBOOK.md:350) run in Windows PowerShell 5.1.19041.7548 writes BOM-free JSON
  (first byte 123) with exactly those four attributes; both recipes use `file://` (F1 of
  the research adjudications).
- Logs Insights query: TRUE - `msg` field and both log groups (RUNBOOK.md:2206-2212); the
  message and its fields `conversationId`, `count`, `capPerMinute`, with the em dash
  further along (sendMessage.ts:361-364); alarm thresholds 5 per 300 s and 3 consecutive
  periods (infra/modules/observability/main.tf:151-158, :187-196); Settings -> System
  status -> Recent errors exists (dashboard/src/routes/settings/RecentErrors.tsx);
  `message_sent` carries `providerSid` + `automated` (sendMessage.ts:433-437).
- UNTRUE: step 3's mid-run breaker-trip sentence (F1). IMPRECISE: resume "`alreadyOn`"
  (F7); import window (F5).

## Counts

MUST-FIX 0. SHOULD-FIX 5 (F1-F5). NOTE 6 (F6-F11).
