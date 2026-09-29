> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/fixwave-part2-report.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Fix-wave part 2 report - share-skip-fix (Branch A), whole-branch review fix wave

Run state (NOT committed). Date 2026-09-25. Worktree W:\tmp\share-skip-fix,
branch feat/share-skip-fix, started at 7f80905b (item 1 already done), now at
d23a2d23.

## RUN STATE: DONE - all remaining items built, gated, committed

Commit d23a2d23 `test(broadcasts): harden I8/fence-order/kill-switch/finalize-log
coverage + errorCode docs (share-skip-fix review)` - ONE commit for items 2-9,
6 files, +162/-15, explicit paths, trailer `Co-Authored-By: Claude Opus 5.5 (1M
context) <noreply@anthropic.com>`. Test + comment changes only; the only source
edits are comments (app/src/services/sendMessage.ts +2, app/src/repos/
broadcastsRepo.ts +10, dashboard/src/api/types.ts +6/-1). Tree clean after.

Every new or strengthened assertion passed on its FIRST run (they pin shipped,
correct behavior), so each was proven a real guard by a temporary in-place
source mutation: source file backed up to the scratchpad first, mutated with
Edit, the one test file run, then restored by copy and verified
byte-identical with `cmp` (RESTORED_IDENTICAL each time). No mutation was
committed; the final source diff was re-read and is comments only.

## Per item

### C2 - sendMessage.test.ts I8 (two new `it`s in the JIT-consent describe, :688, :703)
- (a) opted-out phone-matched contact (`c-dnc`, consent inbound_text,
  sms_opt_out) + clean `recipient` (`c-real`, verbal_in_person) -> rejects
  ContactOptedOutError; nothing sent, nothing appended.
  Mutation: sendMessage.ts opt-out gate `phoneContact?.sms_opt_out` ->
  `contact?.sms_opt_out`. Result: exit 1, "1 failed | 35 passed (36)", exactly
  this test: "promise resolved "{ conversationId: 'conv-1', ...(3) }" instead
  of rejecting".
- (b) deleted phone-matched contact (`c-gone`, consenting, deleted_at) + live
  `recipient` -> resolves SMfake-1, one send. Includes a control: the same fakes
  with NO recipient reject ContactDeletedError (proves the fixture's contact IS
  judged deleted when it is the one judged).
  Mutation: deleted gate also refuses on `isDeleted(phoneContact)`. Result:
  exit 1, "1 failed | 35 passed (36)", exactly this test: "promise rejected
  "ContactDeletedError: ..." instead of resolving".

### C3 - broadcastFanOut.test.ts I1 test (:405)
- Added `c-ud` (sms_unreachable + deleted_at) -> `{skipped, unreachable}` and
  `c-dnc` (deleted_at + consent_method undefined) -> `{skipped,
  contact_deleted}`. Persisted buckets now `{ skipped_opted_out: 2,
  skipped_no_consent: 1, skipped_other: 3 }` (c-del, c-ud, c-dnc in
  skipped_other; no_consent stays 1, so c-dnc never reached it). Title reworded
  from "(deleted judged AFTER opt-out)" to "(fence order: opt-out, unreachable,
  deleted, consent)".
- Mutation (i) deleted-before-unreachable (`sms_unreachable === true &&
  !isDeleted(contact)`): exit 1, "1 failed | 36 passed (37)", at the c-ud
  assertion: expected errorCode "unreachable", received "contact_deleted".
- Mutation (ii) consent-before-deleted (`isDeleted(contact) &&
  hasSmsConsent(contact)`): exit 1, "1 failed | 36 passed (37)", at the c-dnc
  assertion: expected "contact_deleted", received "no_consent".

### C4 - broadcastFanOut.test.ts kill switch for a DASHBOARD share (new `it`, :483)
- Item-4 seam (option (a), exact params):
  - `function testConfig(env: Record<string, string> = {})` - spreads `...env`
    LAST into the fixed literal passed to `loadConfig` (NODE_ENV test,
    MESSAGING_DRIVER console, PUBLIC_BASE_URL, SESSION_SECRET).
  - `function wireHandler(world, logger = ..., tokenBucket?: TokenBucket, env:
    Record<string, string> = {})` - builds `const config = testConfig(env)`,
    which feeds BOTH `createSendMessageService` and
    `registerBroadcastSendJobHandler`. Every existing call is unchanged.
  - The config field is what the wrapper reads: env key SMS_SENDING_ENABLED ->
    `config.smsSendingEnabled` (config.ts:787-802; console driver defaults it
    true); sendMessage.ts:296 `isKillSwitchOff(config.smsSendingEnabled)`. No
    stop trigger.
- Test: created_via 'dashboard', one consenting recipient, `wireHandler(world,
  logger, undefined, { SMS_SENDING_ENABLED: 'false' })` -> `world.sent` empty,
  no outbound message persisted, slot `{ status: 'skipped', errorCode:
  'sms_sending_disabled' }`, persisted skipped_other 1, skipped_opted_out 0,
  sent 0, broadcast status `sent`.
- Mutation: kill switch applied to automated sends only (`automated &&
  isKillSwitchOff(...)`): exit 1, "1 failed | 36 passed (37)", exactly this
  test: "expected [ { to: '+15550100001', ...(1) } ] to have a length of +0 but
  got 1". (Its passing on unmutated code also proves the seam threads the env.)

### C5 - phone#-keyed dashboard-share test (:458) + D4 title (:382)
- The phone# recipient's conversation is pre-created and `setMode(...,
  'manual')`; new assertions: exactly one `message_sent` audit on that
  conversation with payload `{ automated: false }`. Title now "... still sends
  - as a person, into a switched-off (manual) conversation".
- The phone# test's title did not say "never breaker-metered"; the D4 test's
  did (:382, formerly :345). Reworded per the adjudication to "... - sent and
  audited as a person (automated: false)". The wrapper side of "a person's send
  is never counted" is already pinned at sendMessage.test.ts:794-800
  (counterValue 0) - no new wrapper test added.
- Mutation: fan-out `automated: !staffShare || contactKey.startsWith('phone#')`:
  exit 1, "1 failed | 36 passed (37)", exactly this test: "expected [] to
  deeply equal [ '+15550100009' ]" (refused manual_mode). The old switched-on
  version would have passed this mutation (the conformance reviewer's finding
  5(i)).

### A6 - finalize-log test (:329)
- The seeded broadcast now carries STALE persisted skip counters
  (skipped_opted_out 5, skipped_no_consent 4, skipped_other 2) via the
  `seedBroadcast` `stats` override. Persisted assertions updated to
  stale-plus-bump: skipped_other 3, skipped_opted_out 5, skipped_no_consent 4
  (still proves the manual_mode refusal bumps skipped_other only). The log
  assertion is now a full `toMatchObject` of the DERIVED snapshot: status
  'sent', sent 0, sending 1, delivered 0, failed 0, skipped_opted_out 0,
  skipped_no_consent 0, skipped_other 1.
- Revert check (the required one): broadcastFanOut.ts finalize
  `const derived = deriveBroadcastStats(finalItem)` -> `const derived =
  finalItem.stats`. Result: exit 1, "1 failed | 36 passed (37)", exactly this
  test; the log carried the persisted values: sending 0, sent 1,
  skipped_no_consent 4, skipped_opted_out 5, skipped_other 3. So the log reads
  DERIVED on HEAD (no stop trigger).

### A8c - broadcastApi.test.ts S4 test (:386-397)
- The bucket sum now includes `(stats.sending ?? 0)` and `(stats.skipped_other
  ?? 0)` - the same sum as broadcastFanOut.test.ts bucketsSumToAudience.
- Mutation: deriveBroadcastStats also counts a `delivered` slot as `sending`.
  Run with `-t "S4: a delivered callback decrements persisted sent"`: exit 1,
  "1 failed | 66 skipped (67)", at :397 "expected 2 to be 1". The old sum
  (no `sending`) would have read 1 and passed.

### Comments (ASCII)
- C7/A7 dashboard/src/api/types.ts `BroadcastRecipient.errorCode` (:2954):
  failure class (or an internal code, e.g. no_contact) on a FAILED slot; the
  skip reason on a SKIPPED slot (opted_out, unreachable, contact_deleted,
  no_consent, or a send-wrapper refusal code); mirrors the app twin.
- App twin app/src/repos/broadcastsRepo.ts `BroadcastRecipient.errorCode`
  (was undocumented, :139): FAILED (Twilio class or no_contact /
  transient_cap / enqueue_failed), SKIPPED (fence codes or
  SendRefusedError.code), a pre-2026-09-25 first-fence skip carries none,
  QUEUED (the transient code a deferred slot awaits a retry for). Checked
  against main: before this branch only the first-fence skip was code-less;
  no_consent and wrapper refusals already carried codes - the doc says so.
- A7 app/src/services/sendMessage.ts I8 `recipient` doc: + "So the deleted
  and consent gates judge the caller's already-resolved snapshot (redundant
  with the fan-out's own fence); opt-out stays fresh."

## VERIFY (verbatim exit codes)

- Pre-mutation first runs (one file per run): sendMessage SM_EXIT=0 (36
  passed), broadcastFanOut FO_EXIT=0 (37 passed), broadcastApi API_EXIT=0 (67
  passed).
- Final: `cd /w/tmp/share-skip-fix/app && npx vitest run
  test/sendMessage.test.ts test/broadcastFanOut.test.ts
  test/broadcastApi.test.ts` -> VITEST3_EXIT=0, "Test Files 3 passed (3)",
  "Tests 140 passed (140)" (36 + 37 + 67). Test counts before -> after:
  sendMessage 34 -> 36, broadcastFanOut 36 -> 37, broadcastApi 67 -> 67.
- Seam smoke: `npx vitest run test/twilioStatusWebhook.test.ts` ->
  TSW_EXIT=0, 52 passed (52).
- No `[dynamoAdmin]` line in any run output.
- `npm run typecheck` -> TYPECHECK_EXIT=0.
- `npm run smoke` -> SMOKE_EXIT=0, "smoke-dist: OK - 1413 import specifier(s)
  across 248 emitted file(s) resolve under plain Node."
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts'
  '*.tsx' '*.js' '*.mjs' '*.cjs')` (50 files; all 6 touched files are in the
  list) -> ESLINT_EXIT=1 pre-commit, ESLINT_POST_EXIT=1 re-run on d23a2d23,
  both "14 problems (14 errors, 0 warnings)", exactly the declared
  pre-existing set:
  - app/src/lib/seed/cast.ts 79:7, 109:7, 110:7, 434:7 (no-unused-vars)
  - app/src/lib/seed/matrix.ts 134:7 (no-unused-vars)
  - app/test/importApply.integration.test.ts 745:59, 824:59 (no-explicit-any)
  - dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx 11:24, 11:69,
    37:10 (no-unused-vars)
  - dashboard/src/routes/broadcasts/BroadcastComposer.tsx 167:7, 192:5, 211:5,
    226:5 (react-hooks/set-state-in-effect)
  None on a file this wave touched. `npx eslint` on the 6 touched files alone
  -> ESLINT_TOUCHED_EXIT=0.
- ASCII, `git diff -U0 7f80905b..HEAD -- <file> | grep '^+' | grep -v '^+++'
  | tr -d '\11\12\15\40-\176' | wc -c`: sendMessage.test.ts 0,
  broadcastFanOut.test.ts 0, broadcastApi.test.ts 0, sendMessage.ts 0,
  broadcastsRepo.ts 0, types.ts 0. Commit message: 0 non-ASCII bytes.
- Commit discipline: bare `git status` read before staging; MERGE_HEAD absent
  (`git rev-parse --git-path MERGE_HEAD` -> .git/worktrees/share-skip-fix/
  MERGE_HEAD, not present); `git add --` six explicit paths; nothing under
  `.superpowers/` committed; nothing created under `docs/superpowers/`.
- NOT run (per brief): full `npm test`, `npm run e2e`, `npm run e2e:session`.

## Deviations

- C5: the "never breaker-metered" reword landed on the D4 test title (:382),
  where the phrase actually was, not on the phone# test (whose title never
  said it); the adjudication's C5 item asks for that title adjustment.
- A6: stale values seeded on all three persisted skip counters (not only
  skipped_opted_out) and the log asserted as a full derived snapshot
  (including sent 0 / sending 1), so a revert of ANY field of the log line to
  `finalItem.stats.*` fails. The test's persisted assertions moved to
  stale-plus-bump values (3 / 5 / 4) accordingly.
- C4: the test additionally asserts no outbound message was persisted and
  persisted sent 0 / skipped_opted_out 0; no token-bucket spy (not asked).
- C3: the title was reworded to state the full fence order.
- The broadcastsRepo.ts doc also names the QUEUED case (a deferred slot keeps
  its transient code, broadcastFanOut.ts recordRecipient status 'queued').

## Noticed, not changed

- `main` has advanced to cd8e8ddd (merge base is still bbaad87d). The one
  pre-handback main sync is the orchestrator's; not done here.
- A1 (property "Sent to N tenants" counts skipped slots) and A2/A3/A4/A5 remain
  exactly as adjudicated (filed / relayed / working as specified).
