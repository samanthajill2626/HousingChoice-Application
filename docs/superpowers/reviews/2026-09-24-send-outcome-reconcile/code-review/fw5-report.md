# Fix wave FW5 - round 3's fixes: a list error mid-walk judges what was read; the carry line names both writes

Implementer: Claude Opus 5.5 (1M context). Worktree `W:\tmp\send-outcome-reconcile`,
start HEAD ddd3e134 (code 4eef5efa), end HEAD 52220729. Scope:
`r3-adjudications.md` section 1 (FW5-1, FW5-2). The tree is clean; no
MERGE_HEAD at either commit; only 4 files changed (sendReconcile.ts,
broadcastFanOut.ts and their two test files); no fenced file touched
(twilio.ts, jobs.ts, sqsJobConsumer.ts, retrySend.ts, the run-once marker); 0
non-ASCII bytes in the added lines.

Record note: the implementer returned this report as TEXT (the harness refuses
report files from implementer subagents); the orchestrator landed it here with
its checkpoint appended, per AGENTS.md.

Short version: a list error mid-walk now judges what was already read; the
carry WARN names both writes. 11 of 11 real mutants were killed (one more was
equivalent), and every gate asked for is green.

## Commits

- `4e7a8154 fix(jobs): send.reconcile judges what it read when a list call fails mid-walk - the orphan already read is adopted; with nothing adopted the error stays the verdict (provider_error / provider_unreachable) ahead of every other cause, so such a walk never rules never_sent (code review round 3 NEW-1; FW5-1)`
- `52220729 fix(jobs): log text only - the broadcast carry WARN names both writes its guardWrite covers: the rejection's slot or stats write failed, and the recipient is carried with the attempt still open (code review round 3 D-2; FW5-2)`

## FW5-1 (app/src/jobs/sendReconcile.ts, `lookup`) - file:line at HEAD

- :839-842 - the list catch no longer returns: it records
  `listFailure = { err }` and breaks into the judge loop over the candidates
  already read; an adoptable one is adopted exactly as before.
- :892-896 - nothing adopted: the error verdict comes first, exactly as before
  - before the last check `continue` / provider_error with err; at the last
  check `unresolved` / provider_unreachable with extra { err }. It sits ahead of
  :897-906, unchanged: page_bound / nothing_adoptable, page_bound,
  unidentified_candidate, same_fingerprint_sibling, never_sent. So a walk that
  met a list error never rules never_sent.
- A page-1 failure reads nothing, so it behaves exactly as today. `cut` and
  `listFailure` cannot both be set in one walk: the bound breaks before the
  next call.
- Comments kept truthful: :760-763 the lookup docblock; :814-817 the early-stop
  block (the last check walks on "unless a list call fails first"); :824-829
  the new walk comment and `let listFailure`; :883-891 the "Nothing adopted"
  comment.

## FW5-1 tests (app/test/sendReconcile.test.ts, "the broadcast owner", after FW4's test E)

New helper `scriptCalls` (:1040) scripts the list call by call - a page
answers, an Error throws; `unavailable()` (:1052) builds a 503 error. FW4's
`scriptList` is unchanged. The red runs used the same test file as HEAD, so
the line numbers are HEAD's.

- T1 :1054 "FW5-1 (NEW-1): the list fails at checks 0-1; at the LAST check page
  1 holds our orphan with a next page and the page-2 call throws - the orphan
  already read is adopted, never closed provider_unreachable". Setup: page 1
  throws at checks 0 and 1; at the last check page 1 answers [orphan, old
  message] with a next page, and the page-2 call throws. Red on the unchanged
  code at :1075 `expect(await recordOf(owner)).toMatchObject({ state: 'done',
  outcome: 'adopted', sid: 'SMorphan' })`: "AssertionError: expected { ...(13)
  } to match object { state: 'done', ...(2) }", received outcome "unresolved".
  Green: adopted; list calls [u,u,u,'1']; slot sent; no re-drive; 0 ERROR; 2
  provider_error WARNs carrying err.
- T2 :1081 "FW5-1: a page-2 error at the LAST check with nothing adoptable is
  unresolved provider_unreachable carrying that error - never never_sent or
  page_bound, and ahead of an unmatched candidate and of an open
  same-fingerprint sibling". Three recipients: nothing in the window; a STOP
  auto-reply in the window on page 1; an open same-fingerprint sibling. Each
  ends provider_unreachable with one ERROR carrying err { message: 'page 2
  down ...' } at checkNo 2, no re-drive, and no page_bound line. It PASSES on
  the unchanged code by construction (4eef5efa returned provider_unreachable on
  any list error before judging - exactly the verdict T2 pins). For a real red,
  the naive fix was written first (judge what was read, without the error-first
  rule): T2 failed there at :1113 `expect(walk.record).toMatchObject({ state:
  'done', outcome: 'unresolved', cause: 'provider_unreachable' })`: "expected {
  ...(11) } to match object { state: 'done', ...(2) }", received state
  "redriven" (never_sent).
- T3 :1123 "FW5-1: a page-2 error at CHECK 0 with our orphan on page 1 - the
  orphan already read is adopted at check 0; with nothing adoptable the check
  continues provider_error carrying that error". Red on the unchanged code at
  :1137 `expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome:
  'adopted', sid: 'SMorphan', checkNo: 1 })`: "expected { ...(11) } to match
  object { state: 'done', ...(3) }", received state "reconciling". Its second
  phase (nothing adoptable: continue provider_error, one WARN carrying err,
  never nothing_adoptable) passes on the old code by construction; it failed
  against the naive fix at :1158 `expect(warned).toHaveLength(1)`: "expected []
  to have a length of 1 but got +0".
- The naive fix, whole file: 4 failed - T1 :1072, T2 :1113, T3 :1158, test 12
  :1241.

A page-1 error keeps today's verdicts - existing pins that hold it: test 12
"12 a provider that throws on every check ..." at :1232 is the real pin (page 1
fails at every check: checks 0-1 continue provider_error with 2 WARNs carrying
err; check 2 is unresolved provider_unreachable with ONE ERROR carrying err {
message: 'connect ECONNREFUSED' }); ADV-2 (zz-adv-3) at :1568 also holds a
page-1 503 at the last check, but its record fence is lost, so it cannot tell
provider_unreachable from never_sent; the e2e spec
(send-outcome-reconcile.spec.ts:508 failList count 3, :559) is a page-1
failure at each check, so it is unchanged (not run by the implementer).

Restated pins: NONE. No existing pin encoded return-before-judging on a
mid-walk list error; the only list-throwing pins (test 12, ADV-2) fail on page
1, and every existing pin passed after the fix.

## FW5-2 (app/src/jobs/broadcastFanOut.ts, onRejected) - file:line at HEAD

- :763 new text: "broadcastFanOut: provider rejection - its slot or stats write
  failed; the recipient is carried with the attempt still open". It drops
  "provider rejection not recorded" and does not contain the e2e-polled "send
  rejected by the provider".
- Why "slot or stats" fits both arms: the known arms write the slot, then
  bumpStats, in one guardWrite; the generic arm's recordRecipientOutcome is one
  UpdateCommand holding both; the emit cannot fail the guardWrite (the event bus
  isolates listener throws).
- :756-760 the inline comment: its old line "the recipient has not failed" was
  false in the D-2 sub-case; it now says the slot already reads failed when only
  the stats bump threw (R2C-5).
- :681-685 the docblock sentence describing the log lines.
- No write, carry, flag or counter moved.

FW5-2 pins (app/test/broadcastFanOut.test.ts); each restated pin changes its
filter from 'rejection not recorded' to 'slot or stats write failed', because
the old text is gone:

- 13b (:1765, assertion :1791) - old: 0 lines containing 'rejection not
  recorded'; new: 0 lines containing 'slot or stats write failed'. Why: the old
  substring no longer exists, so the old pin would pass vacuously. It passes on
  the old code by design (the success path logs no carry line).
- C-2 (probe P1) 21211 (:2255, :2274) - old: 1 carry WARN containing 'rejection
  not recorded'; new: 1 containing 'slot or stats write failed', plus the
  message contains 'the recipient is carried with the attempt still open'; its
  comment updated. Red on the unchanged source at :2275
  `expect(carried).toHaveLength(1)`: "expected [] to have a length of 1 but got
  +0".
- C-2 known arms 30007 (:2280, :2295) - the same restatement; red at :2296, the
  same message.
- C-2 / FW4-2 30005 (:2300, :2314) - the same restatement; red at :2315, the
  same message.
- NEW :2319 "C-2 / FW5-2 (D-2): a 30007 whose STATS bump throws after its slot
  write keeps the slot failed/30007 and carries the recipient - the carry WARN
  names the slot or stats write, never "recipient failed"". Red on the unchanged
  source at :2337 `expect(carried).toHaveLength(1)`: "expected [] to have a
  length of 1 but got +0". Its earlier assertions all held on the old code,
  which confirms the reviewer's mechanism: slot {failed, 30007}, record
  attempting attemptNo 1, continuation ['t-1'], error labels ['rejectSlot'], no
  'recipient failed' line.

## Text grep (app/ e2e/ infra/ dashboard/ scripts/ fake-twilio/, before and after)

- Before: "provider rejection not recorded" and "its slot write failed" - only
  broadcastFanOut.ts:758; "rejection not recorded" - broadcastFanOut.test.ts
  :1791, :2273, :2293, :2312 (all restated above); "carried with the attempt
  still open" - broadcastFanOut.ts :683, :755, :758 and a test comment at
  broadcastFanOut.test.ts:2271; infra/ and e2e/: no match for any of these.
- After: the old texts have zero matches anywhere; "slot or stats write failed"
  appears at broadcastFanOut.ts:763 and in the 5 test pins; the e2e spec :475
  still polls "send rejected by the provider" for the unchanged success line at
  broadcastFanOut.ts:751, and the carry line does not contain it; infra/ has no
  match for the old or the new text.

## Mutants (FW5-1 lines)

Method: the pristine copy was verified equal to HEAD (`git diff --quiet`); each
mutant was written by exact-text edits that must match exactly once; a Node
runner restored the ORIGINAL bytes in `finally`, with a Buffer compare; Bash ran
`cmp` against the pristine copy after each mutant (identical 12/12); `git diff
--quiet HEAD -- app/src` held after the batch. Target: test/sendReconcile.test.ts
(118 tests).

| Mutant | Result | Change | Killed by |
|---|---|---|---|
| M01 | KILLED | return before judging on a list error, every check (the 4eef5efa shape) | T1, T3 |
| M02 | KILLED | error verdict removed (a list-error walk judged as complete; never_sent reachable) | T1, T2, T3, test 12 |
| M03 | KILLED | error verdict after the page_bound / nothing_adoptable lines | T1, T3, test 12 |
| M04 | KILLED | last check: unidentified_candidate ahead of the error | T2 only |
| M05 | KILLED | last check: same_fingerprint_sibling ahead of the error | T2 only |
| M06 | KILLED | unresolved verdict drops the error (no extra.err) | T2, test 12 |
| M07 | KILLED | continue verdict drops the error | T1, T3, test 12 |
| M08 | KILLED | error verdict swapped (continue at the last check, unresolved before it) | T1, T2, T3, test 12 |
| M09 | KILLED | only a page-1 failure flags the error (a mid-walk failure judged as complete) | T2, T3 |
| M10 | KILLED | return before judging at the last check only | T1 only |
| M11 | KILLED | return before judging before the last check only | T3 only |
| M12 | SURVIVED (equivalent) | a list error also sets cut | none; cut is never read on an error walk because the error returns first |

11 of 11 non-equivalent mutants killed.

## Gates (each run bare, output to scratch, the exit code read right after)

- Baseline at ddd3e134: the 5-file set EXIT 0, 513 passed.
- After 4e7a8154: the 5-file set EXIT 0, 516 passed, 0 `[dynamoAdmin]`;
  typecheck EXIT 0, 0 lines matching "error TS"; eslint on sendReconcile.ts and
  sendReconcile.test.ts EXIT 0, nothing reported.
- After 52220729 (final HEAD): the 5-file set EXIT 0, 517 passed (sendReconcile
  118, integration 4, broadcastFanOut 109, relayFanOut 152, relayRetryLeg 134),
  0 `[dynamoAdmin]`; typecheck EXIT 0, 0 lines matching "error TS"; eslint on
  all 4 touched files EXIT 0, nothing reported.
- The whole app workspace (`timeout 590 npx vitest run`, foreground) at
  52220729: EXIT 0, 383 files, 7676 passed / 1 skipped, 279.8 s (FW4 had 7672 /
  1; the +4 are the 3 FW5-1 tests and the 1 FW5-2 test); 0 bracketed
  "[dynamoAdmin]" lines (the only two "dynamoAdmin" substrings are test-name
  lines of the dynamoAdminRetry acceptance suite).
- ASCII check on the staged added lines: 0 before each commit.
- Not run, as instructed: root npm test, e2e, smoke.

## Deviations

1. T2, and T3's second phase, pass on 4eef5efa by construction, since the old
   code returned exactly the verdict they pin; their red run is against the
   naive fix, quoted above. The mutant pass shows T2 alone kills M04 and M05.
2. Interpretation, not pinned by a new test: on an error-ended walk, the judge
   loop's own sid_held_elsewhere return (a candidate this owner holds whose
   claim went to another owner - "the message exists, never re-sent") still wins
   over the error, as it already wins over the cut rule; the ruling's list of
   outcomes the error goes ahead of names only the causes after the loop.
3. FW5-2 also changed the docblock sentence and inline comment that describe the
   log line (comment text only). The C-2 docblock sentence "only once the slot
   write RESOLVED" was left as is: it is still true as a necessary condition,
   and the next sentence now names the guarded write.
4. FW5-2 adds one test beyond "update the pins": the D-2 sub-case itself. It
   also pins R2C-5's state (record attempting beside a failed slot), so an R2C-5
   fix would restate it.

## New residues

- The provider_unreachable ERROR carries no page count (the ruling said
  "exactly today's error verdict"): from the log line alone an operator cannot
  tell a page-1 failure from a mid-walk one.
- Otherwise none: an error-ended walk adopts only from a subset of what a
  complete walk would read - the property round 3 walked for cut walks.

## Concerns

- R2C-2 still stands: if queued messages are not listed at all, a message held
  past +240 s is still ruled never_sent.
- ADV-2 is a weak holder of the page-1 path; test 12 is the pin that decides.
- Scratch files (logs, the runner, the pristine copy, the mutant JSON) are only
  under the session scratchpad `FW5\`. No background process is running; the
  tree is clean at 52220729.

## Orchestrator checkpoint

Verified at 52220729: 4 files changed ddd3e134..52220729 (+204/-23); no fenced
file; 0 non-ASCII bytes in the added lines. The source diff was read in full:
the catch records `listFailure` and breaks; the judge loop is unchanged; with
nothing adopted the error verdict returns first - `continue` / provider_error
before the last check, `unresolved` / provider_unreachable at it - so an
error-ended walk never reaches never_sent; FW5-2 changes text and comments only.
Deviation 2 is ACCEPTED: sid_held_elsewhere is the judging's own verdict ("the
message exists, never re-sent"), exactly as it outranks the cut rule, and the
ruling ordered the error ahead of the causes AFTER the loop. The full gates run
on this code next.
