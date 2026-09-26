# Plan review r1-b: share-skip-fix Branch A implementation plan (adversarial)

Date: 2026-09-25. Reviewer: independent adversarial plan reviewer (round 1, reviewer B).

Inputs:
- Plan under review: `docs/superpowers/plans/2026-09-25-share-skip-fix.md` (3220 lines, commit a0e594b5).
- Spec delivered: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (Branch A only).
- Repository read at `W:\tmp\share-skip-fix` (read-only). Every claim about existing behavior below cites a file:line that was read. Nothing was run except read-only `git` inspection.

The question asked: if a builder with no context executes this plan literally, do they produce the spec? Answer: not as written. Two steps cannot pass (the slice-1 CLI rehearsal and the second e2e test), the e2e does not deliver three of the spec's section-7 acceptance items, the final main sync targets a stale ref, and the D8 e2e assertions race the composer.

## Summary

| # | Sev | Title |
|---|-----|-------|
| 1 | BLOCKING | Stage resolver hard-codes access key `local`: `--prefix` cannot reach an e2e lane, and the docs steer agents at the human's live local database |
| 2 | BLOCKING | Task 14 test 2 cannot pass: STOP sets the contact flag and the send route 400s `empty_audience` |
| 3 | HIGH | e2e omits spec section 7 acceptance items (skipped tenant NOT "Already sent"; failed pinned as flagged); reasons and "Not sent" live only in the broken test |
| 4 | HIGH | D8 e2e assertions anchored at `/p/<unitId>$` match only a transient value; the composer switches to the server's `?cta=text` link |
| 5 | HIGH | Final sync merges `origin/main`, which is 11 commits behind local `main` today (including a code commit) |
| 6 | MEDIUM | Census does not replay the reminder job's group-usability fallback; undercounts what D2 releases, on a false "cannot cheaply prove" rationale |
| 7 | MEDIUM | I6 "audits every change" is not guaranteed: switch write and audit Put are separate, and a lost audit is unrecoverable |
| 8 | MEDIUM | RUNBOOK says the scripts are owed "after the deploy", contradicting spec section 6 (Cameron applies D2 before merge) |
| 9 | MEDIUM | Task 7's I8 wrapper test cannot be written against `sendMessage.test.ts` `makeFakes` (one contact only) |
| 10 | MEDIUM | Self-review coverage map mislabels I3, I5, I6, I7 (and T7's phone# case) |
| 11 | LOW | Quoted test code does not match the suites (Task 8 `repo` + AudienceFilter literals fail typecheck; Task 6 misses an exact `toEqual`) |
| 12 | LOW | RUNBOOK Logs Insights query cannot match the logged line; the audit `aws` command uses bash quoting in a PowerShell RUNBOOK |
| 13 | LOW | Task 7 Step 5 instruction contradicts itself (replace through the JIT gate, then keep it) |
| 14 | LOW | New fan-out deleted fence inverts the wrapper's documented opt-out > deleted precedence |
| 15 | LOW | Wrapper re-reads the recipient by id: a new send-path read that feeds the fan-out's strand-the-broadcast throw path |
| 16 | LOW | Skip-reason copy lands in a new map in broadcastFormat.ts, not "with the existing reason wording"; an unlisted merge point for SOR/RSW |
| 17 | LOW | Spec section 5 names seed fixtures as a writer of the person's-share record; the plan neither handles nor dismisses it |
| 18 | LOW | Handback omits spec section 7's required D1 numbers and D2 outcome |
| 19 | LOW | Lean fixture lacks the "RSW / automated e2e must not use it" guard; stale single-tenant and "body names ONE tenant" comments left behind |
| 20 | LOW | Resolved-mode placeholder change untested; several TDD "red" steps are already green |
| 21 | LOW | Contradictory slice-1 stop rule and several inaccurate factual claims in plan prose |

---

## 1. BLOCKING - Stage resolver hard-codes access key `local`: `--prefix` cannot reach an e2e lane, and the docs steer agents at the human's live local database

**What is wrong.** Task 1's `resolveStageClient('local', ...)` builds its client with `credentials: { accessKeyId: 'local', secretAccessKey: 'local' }` (plan lines 245-255) and treats `--prefix hc-local-<L>-` as the way to target a hermetic lane (plan lines 223-231, 1473-1485). But DynamoDB Local runs WITHOUT `-sharedDb`, so the ACCESS KEY selects the database, not the table prefix:
- `e2e/support/lane.mjs:150-168`: "Without -sharedDb, DynamoDB Local keeps a SEPARATE database ... per (accessKeyId, region) pair"; a lane's key is `hclane<L>` (`laneAccessKeyId`, lane.mjs:166-168; returned at lane.mjs:306-308).
- `scripts/e2e-session.mjs:125`: the lane's app is started with `AWS_ACCESS_KEY_ID: accessKeyId` ("FORCED, no ?? fallback"); `:687` even logs it.
- `e2e/support/lane.mjs:157-158`: "Lane 0 (npm run dev -- --local) ... rides the 'local' credential fallback in app/src/lib/dynamo.ts" - i.e. key `local` IS the human's live local stack (`app/src/lib/dynamo.ts:69`).

So Task 5 Step 2's rehearsal (`--env local --prefix hc-local-<L>-`) queries `hc-local-<L>-conversations` in the `local` database, where it does not exist: ResourceNotFoundException, census "FAILED", no counts for the slice-1 report. The stage resolver has no way to select a lane's database (no lane option, and it ignores `AWS_ACCESS_KEY_ID`).

**Why it is worse than a failing step.** The path of least resistance for a builder is to drop `--prefix`. That targets bare `hc-local-` on key `local` - Cameron's live local data - and the rehearsal includes two `--apply` runs. The plan's own text points the same way: Global Constraints line 16 ("An agent runs the census and the fix script ONLY against DynamoDB Local (`--env local`)") and the RUNBOOK section (plan line 1430: "An agent may run them only against a hermetic local lane (`--env local`)"). `--env local` without a working lane selector is not hermetic; it is the stack AGENTS.md forbids agents to touch. The unit tests cannot catch this: `stageClient.test.ts` never talks to DynamoDB (plan lines 105-125).

**Implies.** Task 5 cannot be completed as written, and the slice-1 hand-off to Cameron (spec section 6) has no rehearsal evidence. The resolver needs a lane selector that sets BOTH the prefix and the key (for example `--lane <L>` -> `hc-local-<L>-` + `laneAccessKeyId(L)`), a test that proves the key follows the lane, and RUNBOOK/Global-Constraints text that stops equating `--env local` with "hermetic".

## 2. BLOCKING - Task 14 test 2 cannot pass: STOP sets the contact flag and the send route 400s `empty_audience`

**What is wrong.** Test 2 (plan lines 3119-3160) creates a tenant, posts an inbound `STOP`, then creates a seeded draft and `POST /api/broadcasts/:id/send` with `recipientContactIds: [stopped.contactId]`, expecting `send.ok()`.
- The inbound keyword path applies suppression inline and awaited (`app/src/routes/webhooks/twilio.ts:1141-1162`), and `applyNumberSuppression` sets the CONTACT-level `sms_opt_out` when the keyword arrives on the contact's primary number (`app/src/services/numberSuppression.ts:158-162`). The tenant was created with that phone as primary.
- The send route's explicit-selection fence drops `contact.sms_opt_out === true` and returns `400 { error: 'empty_audience' }` when nothing survives (`app/src/routes/broadcasts.ts:654-673`). The seeds-only path fences identically (`:688-698`, via `resolveSeeds` `:341-350`).

So `expect(send.ok()).toBeTruthy()` fails deterministically. The plan's fallback note (plan line 3164: "if the STOP does not flag the CONTACT ... the fan-out's second fence refuses with `contact_opted_out`") rests on a false premise, and its claim that "the seeded path sends to the explicit id, which is exactly the production shape of Sam's #5" is also wrong: Sam's #5 was a `manual_mode` refusal, not an opt-out, and the route fences opt-outs before any share exists.

**Implies.** Gate 4 (`npm run e2e`) fails on literal execution; the D6 ("Not sent") and D7 (skipped reason) e2e proofs do not exist until the test is redesigned. A route that does reach the fan-out: the send route has NO consent fence (`broadcasts.ts:657-663`), so a no-consent tenant sent by explicit id is skipped `no_consent` by the fan-out fence (`app/src/jobs/broadcastFanOut.ts:397-407`) - the path `e2e/tests/dashboard-next/a2p-compliance.spec.ts:433-483` already drives. That yields an all-skipped share ("Not sent") with a reason row ("No texting consent recorded").

## 3. HIGH - e2e omits spec section 7 acceptance items; reasons and "Not sent" live only in the broken test

**What is wrong.** Spec section 7 (lines 379-385) requires, end to end: (a) a staff one-to-one share to a switched-off conversation is delivered; (b) "a tenant whose earlier share was skipped is NOT 'Already sent' on the next share of the property"; (c) "while one whose text went out (or failed - the interim rule, pinned as such) is"; (d) skipped rows show their reasons; (e) an all-skipped share reads "Not sent"; (f) the one-to-one default text.

Task 14 delivers (a), the "went out" half of (c), and (f). It has NO test for (b) - the core of Sam's #5 - and no e2e pin for the "failed stays flagged" half of (c). (d) and (e) exist only in test 2, which cannot pass (finding 2). Also, test 1's D5 claim ("keeps him CHECKED", plan lines 3102-3112) proves nothing new: `initialRows` already pre-checks seeded already-sent rows today (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:76-79`), so that assertion is green before Task 9; only the note text is new.

**Implies.** The spec's acceptance bar is not met, and the plan's own self-review (line 3217) reports the e2e as covering section 5/7. Feasible designs exist: the no-consent path in finding 2 produces a skipped slot; recording consent afterwards and previewing the next share of the same unit proves (b); a `postStatusCallback(... 'failed', '30007')` (`e2e/fixtures/fakeTwilio.ts:107-145`) on a sent slot pins the failed half of (c).

## 4. HIGH - D8 e2e assertions anchored at `/p/<unitId>$` match only a transient value

**What is wrong.** Task 12 Step 3 rewrites a robust existing assertion (`matching-entry-points.spec.ts:131-136` uses an unanchored `/p/${unitId}`) into `^<address> \S+/p/${unitId}$` (plan lines 2787-2791), and Task 14 uses the same `$` anchor twice (plan lines 3079-3082 and 3105). The value those anchors describe is transient:
- The composer seeds the body with `draft.flyerUrl ?? flyerLinkFor(unitId)` (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:186-196`); the fallback `flyerLinkFor` has no query string (`:55-57`).
- The first draft is created after a 600 ms debounce (`useComposerDraft.ts:28`) and its response sets `flyerUrl` (`useComposerDraft.ts:179`) from the draft route's `flyerUrl(config.publicBaseUrl, unit.unitId)` (`app/src/routes/broadcasts.ts:406`, `:474`), which is `${base}/p/${unitId}?cta=text` (`app/src/lib/mergeFields.ts:28-30`). The effect then re-seeds the body, and the steady-state value (the text that is SENT) ends in `?cta=text`.

A retrying `toHaveValue` passes only if one poll lands inside the roughly 0.6-1.5 s fallback window; on a loaded box (AGENTS.md cites 17.9-34.7 min suite runs) it can miss, then time out. When it passes, it has checked a value that is never sent. The dashboard unit test cannot see this: the composer test's `createBroadcast` mock returns no `flyerUrl` (`BroadcastComposer.test.tsx:85`).

**Implies.** An intermittent failure in an existing, stable spec used by every branch, which AGENTS.md says must be treated as a regression, plus a D8 proof that does not prove the sent text. Assert the steady state (for example `^<address> \S+/p/<unitId>\?cta=text$`, or wait for Preview to enable, then assert).

## 5. HIGH - Final sync merges `origin/main`, which is 11 commits behind local `main` today

**What is wrong.** Task 15 Step 1 (plan lines 3189-3193) runs `git fetch origin main` then `git merge origin/main`. In this repo `main` is the local shared branch. Read-only inspection now: `main` = cd8e8ddd, `origin/main` = 185545f0, `git rev-list --left-right --count main...origin/main` = `11 0`. The unpushed commits include a CODE change, `685f2ede fix(relay): log the four retry gate refusals at WARN, not ERROR`. The branch's merge base (bbaad87d) is already ahead of `origin/main`, so the plan's merge would report "Already up to date" and the branch would still lack three `main` commits. Earlier plans in this repo sync with `git merge main` (for example `docs/superpowers/plans/2026-07-02-dynamodb-lane-keys.md:593`, `2026-07-03-approval-and-move-in.md:521`).

**Implies.** The AGENTS.md completion gate ("sync the latest `main` into the branch") is silently not met; the gates run against a stale base; conflicts with RSW or SOR work merged locally but not pushed surface only at Cameron's merge, after the handback claims "synced". Use `git merge main` (with the ask-first rule if the sync could conflict with active work).

## 6. MEDIUM - Census does not replay the reminder job's group-usability fallback

**What is wrong.** Spec D1 (lines 138-142) says the census "replays the reminder job's own target resolution: ... not a group-routed tour". The job routes a non-self_guided tour to its group ONLY if the group is usable, and otherwise falls back to the tenant 1:1 (`app/src/jobs/tourReminders.ts:1060-1069`). The census instead files EVERY non-self_guided rung with a `groupThreadId` under `groupPointer` without checking usability (plan lines 648-655). Its rationale ("the census cannot cheaply prove usability") is false: `resolveUsableGroup` is exported and costs one `conversationsRepo.getById` (`tourReminders.ts:1496-1530`); usable = relay_group, not closed, with a pool number and members.

**Implies.** Rungs whose group is closed or unusable and whose tenant 1:1 is switched off WILL start sending once D2 runs, but are missing from `oneToOneSwitchedOff` - the exact figure spec section 8 (lines 392-393) says Cameron reviews before applying ("D1 counts them before Cameron applies"). The undercount is in the unsafe direction. Replay `resolveUsableGroup` (it needs only `conversationsRepo.getById`) and count fallbacks in the 1:1 buckets.

## 7. MEDIUM - I6 "audits every change" is not guaranteed

**What is wrong.** Spec I6 (lines 317-318): "D2 only ever turns switches on, only on one-to-one conversations, and audits every change." The fix script does the conditional `UpdateCommand` first and then a separate `audit.append` (plan lines 1113-1150). If the Put throws (throttle, transient), the switch is already `auto`, `result.enabled` is not incremented, the error aborts the run with a PARTIAL report that does not name the conversation, and any re-run classifies the row as `alreadyOn` (plan lines 1070, 1172-1174) and never audits it.

**Implies.** A production switch change can be left permanently without its `mode_changed` event, silently violating I6. Make the pair atomic (a `TransactWriteItems` with the Update plus the audit Put, both under the same condition), or at minimum log the conversationId at ERROR as "switched on, audit NOT written" and count it separately so Cameron can backfill.

## 8. MEDIUM - RUNBOOK timing contradicts spec section 6

**What is wrong.** Spec section 6 (lines 350-356): slice 1 is handed to Cameron "before the rest is done"; he runs D1, the D2 dry run and the D2 apply before the merge, and the import-window rule runs "between D2 apply and the merge". The RUNBOOK section opens with "**Owed after the share-skip-fix deploy**" (plan line 1409), while its own step 5 (plan line 1419) assumes the apply happens BEFORE "the deploy of this branch". The import is a local CLI run from a checkout, so the boundary that matters is the MERGE (after it, `main` carries D3), not the deploy.

**Implies.** An operator following the header waits for the deploy, which prolongs the harm the early slice exists to stop (reminders, missed-call texts, welcomes and retries silently blocked for imported contacts). Align the header with spec section 6 and state the import-window boundary as the merge.

## 9. MEDIUM - Task 7's I8 wrapper test cannot be written against `makeFakes`

**What is wrong.** Plan lines 1921-1938 push two contacts onto `f.contacts` and expect `findByPhone` to return the no-consent one while `getById('c-real')` returns the other. `app/test/sendMessage.test.ts` `makeFakes` models exactly ONE contact: `contact` is a single optional item (`:75-86`), `findByPhone: async () => contact` and `getById: (id) => contact?.contactId === id ? contact : undefined` (`:199-201`). There is no `f.contacts`. The step's escape hatch ("Adapt the fixture calls to the suite's own makeFakes shape", plan line 1941) cannot work, because that shape cannot represent two contacts on one phone.

**Implies.** The builder must extend `makeFakes` (for example a `contacts` list or a distinct `recipient` override) without guidance, or skip the only unit-level proof of I8's wrapper change. Name the fixture extension in the plan.

## 10. MEDIUM - Self-review coverage map mislabels I3, I5, I6, I7

**What is wrong.** Plan line 3217 maps: "I3 T3 (`if_not_exists` unchanged, re-run test); I5 (blasts unchanged) T12 test; I6 (no new slot status) Global Constraints + T6; I7 T2 (conditional writes, dry run default)". Spec v8's invariants (lines 308-324) are: I3 = a skipped recipient is never "Already sent" and an all-skipped share never reads "Sent" (T8 + T11, not T3); I5 = nothing in this branch turns a switch OFF; I6 = D2 only turns switches on, only on one-to-one conversations, and audits every change; I7 = production is written only by the Cameron-run D2 script, with no infrastructure, index or dependency changes. The labels match none of these. Plan line 3219 also says "T7 Step 2 adds no new case" for the phone#-keyed recipient, while Task 7 Step 2 adds exactly that test (plan lines 1899-1914).

**Implies.** The coverage self-check was not re-run against v8. A downstream reviewer anchored on this map will believe I5 and I6 are covered by unrelated tests; I6 in fact has a gap (finding 7). Rebuild the map against spec v8.

## 11. LOW - Quoted test code does not match the suites

**What is wrong.**
- Task 8 Step 1 (plan lines 2101-2142) calls `repo.create` / `repo.markSending` / `repo.setRecipient`; the suite binds the repo as `broadcasts` (`app/test/broadcastsRepo.integration.test.ts:61`). Its `audience_filter: { contact_type: 'tenant' }` literals, and the `BroadcastItem` literal in Task 8 Step 2 (plan lines 2157-2171), omit the REQUIRED `excludeOptedOut` / `excludeUnreachable` (`app/src/repos/broadcastsRepo.ts:76-82`; every existing call passes them, for example `broadcastsRepo.integration.test.ts:87`). `npm run typecheck` includes `tsc -p tsconfig.test.json` (`app/package.json:13`; `app/tsconfig.test.json` includes `test`), so Task 8 Step 6's "Expected: exit 0" fails.
- Task 6 Step 6 (plan line 1772) names only `broadcastApi.test.ts:1220-1229` as the exact `toEqual` needing `skipped_other: 0`, but the suite Task 6 itself edits pins derived stats exactly too: `app/test/deriveBroadcastStats.test.ts:43-52` fails once `deriveBroadcastStats` returns `skipped_other: 0`.

**Implies.** Friction and guesswork at commit steps, not wrong behavior; the gates catch it.

## 12. LOW - RUNBOOK Logs Insights query cannot match; bash quoting in a PowerShell RUNBOOK

**What is wrong.** The RUNBOOK query filters `msg = '... exceeded - conversation flipped to manual'` with an ASCII hyphen (plan line 1423); the logged message contains an em dash (`app/src/services/sendMessage.ts:363`), so the primary query never matches (the plan admits it and offers a prose fallback). The audit-partition command (plan line 1426) passes JSON with bash-style `\"` escaping; this RUNBOOK's convention for JSON arguments is PowerShell (`$v = @{...} | ConvertTo-Json -Compress`, `RUNBOOK.md:1797`), and PowerShell 5.1 mangles `\"`-escaped JSON handed to native executables. It also omits `--no-cli-pager`.

**Implies.** The operator's first two "how to see why" tools do not work as pasted. Use `filter msg like /circuit breaker TRIPPED/` as the query and the PowerShell ConvertTo-Json idiom for the Query.

## 13. LOW - Task 7 Step 5 instruction contradicts itself

**What is wrong.** Plan line 1994: "replace the block from `const contact = await contacts.findByPhone(participantPhone);` through the JIT consent gate with:" followed by code that contains ONLY the lookup and the opt-out gate; plan line 2019 then says "Keep the deleted gate and the JIT consent gate exactly as they are". Read literally, the first sentence deletes both I1 gates (`sendMessage.ts:320-344`).

**Implies.** Existing wrapper tests would probably catch the deletion, but the plan should say "replace the lookup and the opt-out gate only".

## 14. LOW - New fan-out deleted fence inverts the wrapper's precedence

**What is wrong.** The wrapper orders its gates opt-out, then deleted, then consent, and documents why ("softer than opt-out (TCPA wins)", `app/src/services/sendMessage.ts:320-323`). Task 7 places the new fan-out deleted fence BEFORE the opt-out first fence (plan line 2021). A deleted and opted-out recipient then reads "Contact was deleted" and counts under `skipped_other` instead of "Opted out of texts" / `skipped_opted_out`.

**Implies.** A minor reason and count skew against the codebase's stated precedence; place the deleted fence after the opt-out fence.

## 15. LOW - Wrapper re-reads the recipient by id

**What is wrong.** The I8 change adds `await contacts.getById(recipientContactId)` inside `sendMessage` (plan lines 1997-2002) for a contact the fan-out resolved moments earlier (`broadcastFanOut.ts:366`). Any error from that read is not a `SendRefusedError`, so it reaches the fan-out's generic `throw err` (`broadcastFanOut.ts:553-564`), which by that file's own TODO leaves the recipient queued, skips every later recipient and never finalizes the share.

**Implies.** A second read on the send path doubles exposure to an existing strand-the-broadcast failure mode. Passing the resolved contact's relevant flags, or the item, avoids it; if the id design stays, say why.

## 16. LOW - Skip-reason copy lands in a new map in broadcastFormat.ts

**What is wrong.** Spec D7 (lines 242-246): wording "lives with the dashboard's existing staff-facing reason wording"; Appendix A (lines 430-431) names that home: `dashboard/src/routes/contact/deliveryStatus.ts`. The plan's Global Constraints (line 21) cite D7 for placing it in `broadcastFormat.ts` (a new `SKIP_REASONS` map, plan lines 2515-2527). Spec section 6 item 3 lists the merge points SOR/RSW must know - "the dashboard internal-code reason map and `deliveryReason`'s options" and "the results-row reason gate" - and a second map in another file is not among them.

**Implies.** A new, unlisted merge point; SOR's results-row reason work could land in `deliveryStatus.ts` and never reach share rows. Either co-locate the map or add it explicitly to the handback's merge-point relay.

## 17. LOW - Seed-fixture writer of the person's-share record neither handled nor dismissed

**What is wrong.** Spec section 5 (lines 336-338) lists "seed fixtures (seeded shares a test sends as staff must carry it)" as a writer of the `created_via` record. The plan touches seed broadcasts only for `skipped_other` stats (Task 6). The full profile seeds a DRAFT created by the VA user (`app/src/lib/seed/matrix.ts:1232-1248`, `broadcast-mx-draft-01`), and the performance seed cycles drafts (`app/src/lib/seed/performance.ts:1018-1019`). No test sends them today (grep), so no change may be needed - but the plan never says so.

**Implies.** A spec-named surface is silently dropped, and a plan-anchored reviewer cannot tell omission from decision. One sentence closes it.

## 18. LOW - Handback omits spec section 7's required contents

**What is wrong.** Spec section 7 (lines 387-388): "Handback reports: the D1 numbers, the diagnosed cause (done), what D2 changed or would change, and every issue filed or amended." Task 15 Step 3 (plan line 3211) lists commits, exit codes, slice reports, a decision map, deferrals and sibling relays, but not the D1 numbers or the D2 outcome (from Cameron's runs if he has made them, otherwise stated as pending).

## 19. LOW - Lean fixture lacks the spec's guard; stale comments left behind

**What is wrong.**
- Spec section 5 (lines 330-332): "RSW's one-to-one e2e must not use it." The Task 13 fixture comment (plan lines 2909-2915, 2936-2939) does not say this, and it is the only place a future spec author will look. Any automated send to Dario is refused `manual_mode`.
- Now-false comments stay unedited: `contacts-list-facets.spec.ts:11-12, 23-24` ("the lean seed world holds exactly ONE tenant"); `RecipientPreview.tsx:59-63, 119-121` and `BroadcastComposer.tsx:260-267` (the resolved body "names ONE tenant" / would "send Hi Tasha"); `dashboard/src/api/types.ts:2889-2891` (the bucket-balance rule, which Task 6 extends with `skipped_other`).

## 20. LOW - Placeholder change untested; several TDD "red" steps are already green

**What is wrong.**
- Spec section 5 (lines 345-346) names "the message editor's placeholder in that mode" as a surface; Task 12 changes `MessageEditor.tsx:84` but adds no test (no existing test pins the placeholder: grep of `dashboard/src/routes/broadcasts/*.test.tsx`).
- Task 7 Step 4 says all new tests fail first, but the I8 fan-out test (plan lines 1864-1878) and the phone#-keyed test (lines 1899-1914) pass before Task 7: the fan-out still sends `automated: true`, and the JIT gate runs only when `automated === false` (`sendMessage.ts:338`). Task 14's "keeps him CHECKED" is green before Task 9 (finding 3).

**Implies.** The tests are still useful as regression guards, but the stated red/green evidence is not real; a builder reporting "watched it fail" would be misreporting.

## 21. LOW - Contradictory slice-1 stop rule and inaccurate plan claims

**What is wrong.**
- Global Constraints (plan line 26): slice 1 is "reviewed and handed to Cameron BEFORE Tasks 6+ start being built", then "the orchestrator ... continues"; Task 5 Step 3 (line 1489) says "STOP for review" and then "Building continues with Task 6 without waiting". The orchestrator's stop condition is ambiguous.
- Plan line 1731: "the persisted counters never carried `skipped_no_consent`" - false; the fan-out bumps it (`broadcastFanOut.ts:402`).
- Task 10 (plan line 2427): `broadcastFormat.test.ts` "create if absent" - it exists with its own imports (`dashboard/src/routes/broadcasts/broadcastFormat.test.ts:1-13`); Task 11 then appends a second import from the same module mid-file.
- Review Focus 1 (plan line 32): an absent `ai_mode` can be "a row the import touched before this branch" - false; the import always writes `ai_mode = if_not_exists(...)` (`app/src/lib/import/apply.ts:1093`).
- Task 15's Files line names a gitignored `.superpowers/sdd/handback.md` while Step 3 commits the handback under `docs/superpowers/reviews/` (the AGENTS.md rule); keep only the latter.

**Implies.** Individually minor; together they show the plan's prose was not re-verified against the code it describes.

---

## Verified as correct (no finding)

Checked and found consistent with the repo, so later reviewers need not re-derive them:
- `hcAws.mjs` exports and `.d.mts` types match the stage resolver (`scripts/lib/hcAws.mjs`, `scripts/lib/hcAws.d.mts`); the relative import depth `../../../scripts/lib/hcAws.mjs` is right from `app/scripts/lib/`.
- Table base names, `ensureTable`/`deleteTableIfExists` signatures, `queryAll`, `retiredByTourStart(row, scheduledAt, now)`, `DISCONTINUED_REMINDER_KINDS` (`confirmation`), the `tourReminders`/`placementNudges` `create`/`listDue`/`claimSend` signatures, `ReminderSkipReason 'tenant_not_on_roster'`, and `AuditEvent.ts` all match the census test's expectations; its expected counts are internally consistent.
- The census's 1:1 lookup mirrors the job exactly (`tourReminders.ts:1092-1093`).
- Pointer partitions are only `phone#` / `email#` / `token#` (`conversationsRepo.ts:510-528`).
- Task 3's `input.isGroup ? 'manual' : 'auto'` binding and both import tests fit `apply.ts:1082-1113` and `importGroupGuards.test.ts:21-77`.
- Fan-out helpers (`seedBroadcast` third arg and return value, `wireHandler`, `capturingLogger`, `LogCapture.atLevel`) and harness fakes (`findByPhone` insertion order, `getById` returning soft-deleted contacts, `createOrGetByParticipantPhone` finding open rows, `setMode`, `bumpStats` defaulting missing keys to 0) match Tasks 6 and 7.
- Refusal codes in `SKIP_REASONS` match `SendRefusedError` codes (`sendMessage.ts:52-76`) plus the fan-out's own codes; `deliveryReason` returns the wording Task 10's tests expect (`deliveryStatus.ts:913-977`).
- `ADD stats.#k` on an absent nested counter is safe because the `stats` map always exists (`broadcastsRepo.ts:691-732`); SSE, results and list all carry DERIVED stats (`broadcastFanOut.ts:154-160`, `routes/broadcasts.ts:293, 311`), so the D6 label reads derived buckets everywhere.
- `broadcasts.create(` has exactly one app call site (`routes/broadcasts.ts:448`); `priorRecipientContactIds` has exactly one reader (`routes/broadcasts.ts:516-519, 542-544, 564`).
- Dario (1-BR, `+15550100004`) collides with no seed or e2e number, joins no existing e2e audience (the resolver matches voucherSize exactly, `audienceResolution.ts:153-154`; every scenario unit is 2-BR), and satisfies the lean seed tests' field rules.
