# Plan review r2: share-skip-fix Branch A implementation plan v2 (adversarial)

Date: 2026-09-25. Reviewer: round-2 adversarial plan reviewer (reviewer B of round 1).

Inputs:
- Plan v2: `docs/superpowers/plans/2026-09-25-share-skip-fix.md` (3521 lines, commit a5b95400).
- Spec v9: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (v8 -> v9 diff read: section 5 now says the full profile composes lean; section 6 item 3 names `shareRecipientReason` as the results-row reason gate).
- Round-1 records: `plan-review-r1-a.md`, `plan-review-r1-b.md`, `plan-review-r1-adjudications.md`.
- Repository read at `W:\tmp\share-skip-fix` (read-only; only read-only `git` inspection was run).

Every claim about existing behavior cites a file:line that was read. UNVERIFIED marks what could not be settled by reading.

Summary: v2 closes the round-1 blockers. The `--lane` selector really does reach a lane's database; the no-consent e2e path works end to end; the census fixture's expected counts are right; the `recipient` item removes the second read. One of the three new e2e tests, however, is a timing race whose losing side is not a flake but the code's actual rule. The RUNBOOK now points Cameron's production runs at a worktree another agent is still editing. The rest are LOW.

| # | Sev | Title |
|---|-----|-------|
| 1 | HIGH | Task 14 test 3 races the fan-out's `finalize`; when the async 30007 lands first the one-recipient share is `failed` and is excluded from "Already sent", so the pinned "interim rule" holds only by timing |
| 2 | MEDIUM | The RUNBOOK sends Cameron's dev/prod runs through the build worktree while Tasks 6-15 are still editing it; the scripts' import closure includes `sendMessage.ts` |
| 3 | LOW | Task 10 pre-imports Task 11's `presentShareLabel`; Task 10's own typecheck step then fails (dashboard typecheck covers tests) |
| 4 | LOW | Two "red" claims are still false: Task 7's I1 test is green once Task 6 lands; Task 6 Step 3's bumpStats case cannot change outcome through Task 6 |
| 5 | LOW | The census header calls the released-rung count "exact"; it is an upper bound, and the replayed `resolveUsableGroup` writes the job's "falling back" WARN into a read-only census |
| 6 | LOW | The lost-audit remediation is "append the event by hand" with no command, for a key shape that lives only in `auditRepo.ts` |
| 7 | LOW | `laneAccessKeyId` is "pinned by test" only against itself, not against `e2e/support/lane.mjs` |
| 8 | LOW | Small inconsistencies: a DeliveryBadge test title Task 10 makes false; Global Constraints vs Task 5 on when Task 6 starts |

---

## 1. HIGH - Task 14 test 3 races `finalize`; the pinned "interim rule" holds only by timing

**What is wrong.** Test 3 (plan lines 3435-3460) arms the fake with `setDeliveryOutcome(... { kind: 'fail', failState: 'failed', errorCode: '30007' })`, sends a ONE-recipient share, and asserts the next share's review row reads "Already sent".

- The fake's `fail` profile fails ASYNCHRONOUSLY. The send returns success, and the planned states are `['queued', 'sent', failState]` (`fake-twilio/src/engine/delivery.ts:18-19`). Each state becomes a status callback at `150 ms * index` (`delivery.ts` `stepDelayMs`; `fake-twilio/src/engine/engine.ts:462-520`), so the `failed` + ErrorCode callback fires about 300 ms after the send.
- The status webhook's broadcast rollup turns that callback into slot `failed` and bumps the PERSISTED `failed` counter (`app/src/routes/webhooks/twilio.ts:3576-3581, 3653-3679`).
- After the send, the fan-out still does its slot write, stats bump, token acquire, activity event and listing-send write (`app/src/jobs/broadcastFanOut.ts:430-489`). Only then does `finalize` read the row and call `markFailed` when `fresh.stats.failed >= total` (`:690-693`).
- `priorRecipientContactIds` counts only `sent` / `sending` shares (`app/src/repos/broadcastsRepo.ts:537`), so a `failed` share contributes nothing.

When the post-send DynamoDB work takes longer than the roughly 300 ms callback plus the webhook's own reads and writes, the share finalizes `failed`, the tenant is NOT flagged, and line 3458 fails. The other interleavings end `sent` and pass. One of them is the callback arriving before the slot exists: the rollup then waits `statusRetryDelayMs` and re-reads (`twilio.ts:3594-3611`). With `workers: 1` (`e2e/playwright.config.ts:140-141`) the bucket rarely waits, so the race is DynamoDB latency under suite load. AGENTS.md documents exactly that load (a 34.7 min vs 17.9 min run, lock-wait faults). The probability is not measured here (UNVERIFIED), but the mechanism is.

**Why the losing side is not a flake.** The `failed` outcome IS the code's rule for one-recipient shares: a share whose every recipient failed before finalize is marked `failed` and excluded as a whole. That covers the synchronous carrier branches (`broadcastFanOut.ts:506-545`), `no_contact` (`:367-376`), and the `transient_cap` / `enqueue_failed` closes (`:274-311`). Spec section 8 (lines 401-405) says the three app-internal failures "stay Already sent". That holds for multi-recipient shares and is false for the one-to-one shares at the heart of Sam's report, where it matches spec problem item 7 ("A share whose lifecycle status is `failed` is excluded"). Test 3, as written, pins a claim the code does not guarantee.

**Implies.** Gate 4 gets an intermittent red in a new spec, and in this repo a named-spec failure is a regression to diagnose (AGENTS.md). Make the pin deterministic:
- (a) share with TWO recipients, one normal and one armed to fail, so the share can never be all-failed and always finalizes `sent`; or
- (b) arm `stall`, wait until the share has finalized `sent`, then deliver the failure with `postStatusCallback` (`e2e/fixtures/fakeTwilio.ts:107-145`) using the SID from `listThreads`.

Separately, have spec section 8 say that the interim rule applies within `sent` / `sending` shares, and that an all-failed share (the usual one-to-one case) is excluded whole.

## 2. MEDIUM - Cameron's production runs go through the worktree the orchestrator is still editing

**What is wrong.** The v2 RUNBOOK heading (plan line 1589) says the runs are owed "as soon as slice 1 ... is reviewed - BEFORE its merge and deploy ... run from that branch's checkout". Task 5 Step 3 (line 1675) and Global Constraints (line 28) start Task 6 right after the hand-off. The branch's only checkout is the build worktree, which Tasks 6-15 keep editing, merging (`git merge main`, Task 15) and re-installing. The scripts are not self-contained:
- the census value-imports the reminder job (plan line 573-578), and `tourReminders.ts:65-68` value-imports `SendRefusedError` from `sendMessage.ts`, which Task 7 rewrites;
- the fix script imports the census module (plan line 1190), so it inherits the same closure.

**Implies.** A dev or prod run started hours or days after the hand-off executes whatever state the worktree is in: a mid-edit `sendMessage.ts`, conflict markers during the main sync, or a half-finished `npm install`. The likeliest outcome is a confusing import-time crash before any write. But a production write procedure with an unstated dependency on another agent's live working tree is not what spec section 6's "each on his go" hand-off intends. Hand Cameron a pinned, clean checkout of the reviewed slice-1 commit (for example, a separate worktree at the slice-1 report's SHA) and name that SHA in the RUNBOOK step.

## 3. LOW - Task 10 pre-imports Task 11's `presentShareLabel`; Task 10's typecheck step fails

**What is wrong.** Task 10 Step 1 (plan line 2649) tells the builder to add `shareRecipientReason` AND `presentShareLabel` ("- Task 11 -") to `broadcastFormat.test.ts`'s import, plus `import type { BroadcastStats }` "for Task 11". `presentShareLabel` does not exist until Task 11 Step 3. The dashboard typecheck includes test files (`dashboard/tsconfig.json` `"include": ["src", ...]`), so Task 10 Step 6's `npm run typecheck` fails with "module has no exported member". The unused type import is also a `no-unused-vars` error at Task 10's commit (`eslint.config.mjs` rule, all `**/*.ts`).

**Implies.** A literal builder cannot pass Task 10's own gate. Move those two imports into Task 11 Step 1, where the plan's text already assumes they exist (line 2817).

## 4. LOW - Two "red" claims are still false

**What is wrong.** Adjudication 13 says every step now says when a test is a pin. Two do not:
- **Task 7 Step 2 / Step 4** (plan lines 2044, 2172) say the `c-del` / `c-both` assertions are red before Task 7. Once Task 6 has landed they are green:
  - `c-del` passes the fan-out's fences (the `seedTenant` default consent) and reaches the wrapper, whose deleted gate refuses it as `contact_deleted` (`app/src/services/sendMessage.ts:324-327`; the harness `findByPhone` returns soft-deleted contacts, `app/test/helpers/twilioWebhookHarness.ts:1884-1893`);
  - Task 6's refusal branch then files it as `{ skipped, contact_deleted }` under `skipped_other`;
  - `c-both` hits Task 6's opt-out-first fence.
  The whole I1 test is a regression pin.
- **Task 6 Step 3** (plan lines 1809-1835, "Expected: FAIL" at 1853). Task 6 never changes `bumpStats` or `markSending` (`broadcastsRepo.ts:552-578, 691-732`), so this case's outcome is identical before and after Task 6. If DynamoDB's `ADD stats.skipped_other` creates a missing nested key under an existing map, it is green from the start. If it does not, it stays red and the plan has no fix; production shares mid-send at deploy would then hit a ValidationException on the fan-out's generic throw path (`broadcastFanOut.ts:553-564`). No code in the repo does a nested `ADD` onto a missing key (every `ADD` target in `app/src/repos` is top-level), so which case holds is UNVERIFIED.

**Implies.** A builder who follows the plan's own "never report a red you did not see" note will be confused at both steps. Label both as pins, and give Step 3 a contingency: if it is red, `bumpStats` must `SET stats.#k = if_not_exists(stats.#k, :zero) + :v`.

## 5. LOW - The census calls its released count "exact"; it is an upper bound

**What is wrong.** The census header (plan lines 555-558) says the quiet-hours deferral is the only unreplayed gate, "so the released count is exact for today's pending rows". The job has other gates that retire or hold a one-to-one rung and that the census does not replay:
- the conversion-claim deferral and stall retire (`app/src/jobs/tourReminders.ts:1163-1182`);
- the pending open-group wait (`:1307-1319`);
- the tenant-roster gate, which retires `tenant_not_on_roster` (`:1321-1331`);
- the wrapper's opt-out and deleted refusals after the claim.
The census already holds the contact (plan line 789), so the opt-out and deleted cases would be cheap to exclude.

Separately, the replayed `resolveUsableGroup` logs the job's own WARN, "group thread unusable ... falling back to tenant 1:1" (`tourReminders.ts:1512-1515`), once per unusable group. That lands in the output of a read-only operator census, where it reads as though the job had just acted. Pass a silent logger.

**Implies.** Cameron approves D2 against a number labeled exact that overstates the release. Label it an upper bound, or replay the cheap gates.

## 6. LOW - The lost-audit remediation has no command

**What is wrong.** Adjudication 5 turned a lost audit write into a named, counted exit 1. RUNBOOK step 3 (plan line 1597) then says: "append the event by hand for each named id". The audit item's shape (`entityKey`, a `ts` sort key of `<ISO>#<8-char suffix>`, `event_type`, `payload`) is defined only in `app/src/repos/auditRepo.ts:60-83`. The RUNBOOK gives no put-item command, and the script has no audit-only mode.

**Implies.** The only remedy for an I6 gap leaves the operator hand-crafting a DynamoDB item. The adjudication rejected `TransactWriteItems` to avoid duplicating the key format outside `auditRepo`; the manual remedy duplicates it in Cameron's head instead. Either give the exact PowerShell `put-item` line in the RUNBOOK, or add a `--audit-only --conversation <id>` path that calls `auditRepo.append`.

## 7. LOW - `laneAccessKeyId` is pinned only against itself

**What is wrong.** `app/scripts/lib/stageClient.ts` re-implements the lane key format (plan lines 274-278), and the test asserts its own output (`hclane3`, plan lines 129-136). Adjudication 1 calls it "pinned by test". Nothing ties it to the harness's real format (`e2e/support/lane.mjs:166-168`). `app/tsconfig.test.json` already includes `../e2e/support` with `allowJs`, and `app/test/lane.test.ts` imports `lane.mjs`, so a parity assertion is one import away.

**Implies.** If the harness key format ever changes, the census and fix script silently read an empty database (ResourceNotFoundException). The RUNBOOK's advice for that error ("the lane number is wrong") would then send the operator in the wrong direction.

## 8. LOW - Small inconsistencies

- `dashboard/src/routes/broadcasts/StatChips.test.tsx:154-158` "shows just the Failed label when no error code is supplied" stays green after Task 10 (Testing Library matches own text nodes, and "Delivery failed" contains no "error"). But the badge then reads "Failed - Delivery failed", so the title states the opposite of the behavior. The plan neither renames nor replaces it.
- Global Constraints (line 28) says the planner hands the commands to Cameron "BEFORE Task 6 starts". Task 5 Step 3 (line 1675) says "Task 6 starts right after that report", meaning the orchestrator's report to the planner, not the planner's hand-off. Pick one trigger.

---

## Round-1 adjudications contested

- **3 (e2e coverage, "all six items")**: item (c)'s "failed stays flagged" half is not reliably covered (finding 1).
- **5 (audit-failure path)**: the failure is named and counted, but the remedy has no procedure (finding 6).
- **7 (census overstatement)**: the census now splits breaker-held and superseded rungs, then over-claims "exact" (finding 5).
- **13 and 19 (red states; the bumpStats case)**: two steps still claim red for tests that are green, or cannot flip (finding 4).
- **16 (RUNBOOK)**: the new "run from that branch's checkout" wording introduces finding 2.
- **1 (lane selector)**: correct in substance, verified (next section); the parity pin is weaker than stated (finding 7).

## v2 material verified correct (no finding)

- **Lane selector.** `hclane<L>` + `us-east-1` + `http://localhost:8000` matches the lane's database identity: `scripts/e2e-session.mjs:113, 125-127`, `scripts/db.mjs:42`, `e2e/support/lane.mjs:166-168, 306-308`. `parseLane` refuses 0, and dev/prod refuse `--lane` before any AWS call.
- **Census fixture counts** (plan lines 490-518). All are right, verified against:
  - `isSupersededRung`'s four cells (`app/src/lib/ladderPointer.ts:16-47`);
  - `resolveUsableGroup`'s closed-group fallback (`tourReminders.ts:1496-1530`);
  - the job's 1:1 lookup (`:1091-1093`);
  - `retiredByTourStart`;
  - `listDue` excluding skipped rows.
  `RunDueTourRemindersDeps` is exported (`:663`), and `resolveUsableGroup` reads only `conversationsRepo.getById`.
- **Fix script.** The audit-failure test, the `UsageError` path and the single-mode id log line match the quoted implementation; the seven tests and their counts are consistent.
- **`recipient?: ContactItem` wrapper test.** It needs no fixture change: the fake adapter returns `SMfake-1`, and the error classes are already imported (`app/test/sendMessage.test.ts:17-25, 403`).
- **Task 14 test 2 (no-consent path)** works end to end:
  - the send route has no consent fence (`routes/broadcasts.ts:657-663`);
  - the fan-out skips the tenant as `no_consent` and the share finalizes `sent`;
  - Tasks 11, 10 and 8 make "Not sent", the reason, and "not flagged after consent" go red to green.
- **The `?cta=text` anchors reach a steady state.** The value comes from `flyerUrl` (`app/src/lib/mergeFields.ts:28-30`), and after the first draft the composer re-seeds and recreates once with the same link.
- **`BroadcastComposer.prefill.test.tsx`** pins only edit preservation, so Task 12 leaves it green. **MessageEditor** props accept the new placeholder test.
- **Seed fixtures.** `performanceSeed.test.ts:803-813` uses `toMatchObject`, so the added `created_via` breaks nothing.
- **Automated-share dependencies.** No app or e2e test depends on shares being automated; the only `automated: true` pins are the 30003 retry (`twilioStatusWebhook.test.ts:853-905`). Other automated callers (the missed-call text, the welcome, retries) are event-driven or short-lived, so D2's release scope is tour rungs, as spec D1 says.
