# Code review round 3 - focused re-review of FW4

Reviewer: a FRESH read-only re-reviewer (Claude Opus 5.5), dispatched
2026-09-27 15:49 EDT over FW4 (c8193fc2..4eef5efa) with `r2-conformance.md`,
`r2-adversarial.md`, `r2-adjudications.md`, `fw4-report.md`, the FW4 diff
package and repository access. HEAD 80fe74c1 (code = 4eef5efa). Charge, in
order: (1) what round 2 missed across the state FW4 changed, (2) the FW4 diff
cold, (3) adjudication challenges, (4) FW4 verdicts.

Record note: the reviewer returned this report as TEXT (the harness refuses
report files from subagents); the orchestrator landed it here verbatim apart
from the heading. The orchestrator's rulings are in `r3-adjudications.md`.

---

ROUND-3 RE-REVIEW - feat/send-outcome-reconcile, HEAD 80fe74c1 (code = 4eef5efa). Read-only. Two throwaway tests were written, run one at a time and deleted. `git status --short` is empty and HEAD is unchanged. I did not run npm test, e2e, smoke or any build.

Bottom line: FW4-1's logic is sound against every adoption guard. It has one hole, and FW4-1 itself made that hole reachable (NEW-1). FW4-2 moves no write, carry, flag or counter, but its new log line is false in one sub-case (D-2). Both findings are LOW and CONFIRMED in the harness. Nothing is BLOCKING, HIGH or MEDIUM.

## (1) New findings

NEW-1. LOW, CONFIRMED (zz-r3-1). At the last check, a list error on page 2 or later throws away an orphan already read on page 1. The verdict is unresolved provider_unreachable instead of found.
- User-visible: a text that did go out, and that the provider listed, closes "Not confirmed". The share can read Failed with the unconfirmed prose, which invites a manual resend.
- Where: sendReconcile.ts:830-833 returns straight from the list catch, before the judge loop at :852-874. This is the same "return before judging" that FW4-1 rule (b) removed for the page bound (:846-849) but kept for a mid-walk list error.
- Why it is new: FW4-1 (a) gates the early stop `!last` (:844). The last check now reads up to 4 more pages for any recipient with more than one page from the sender, and each extra call is a new way to discard what was already read. At af848977 this list shape stopped after page 1 at the last check and adopted (the removed line, diff package :333).
- Sequence:
  1. The send site hands an unknown outcome to reconcile (broadcastFanOut.ts:807-808).
  2. Check 0 (+5 s) and check 1 (+30 s): the list call fails in the same provider incident (:830-833). Each check continues with provider_error.
  3. Check 2 (+240 s): page 1 returns [the orphan inside the window, older history] with a next page. The orphan enters bySid (:837-840). The early stop is skipped because this is the last check (:844).
  4. The page-2 call throws (:824-833) and the check returns unresolved provider_unreachable.
  5. closeUnresolved (:467, :985-1006) closes the record done/unresolved, logs the ERROR, sets the slot to failed/send_unconfirmed and finalizes.
- Preconditions: more than 1000 messages from that sender to that recipient, and the orphan not adopted at checks 0-1 (list errors or list lag). A realistic population is members of active relay groups. Correlated provider trouble or a 429 during an incident makes the page-2 failure more likely.
- Evidence (zz-r3-1):
  - Control, page 2 answers: calls [u,u,u,'1'], record done/adopted SMorphan.
  - Probe, page 2 throws: calls [u,u,u,'1'], record done/unresolved/provider_unreachable, slot {failed, send_unconfirmed}, one ERROR at checkNo 2.
  - Failing assertion zz-r3-1.test.ts:186 `expect(r.record).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan' })`, "expected { ...(13) } to match object { state: 'done', ...(2) }".
- Fix, small and adding no machinery: on a list error after at least one page, break into the judge with a flag. If nothing is adopted, return exactly today's error verdicts (continue provider_error before the last check, unresolved provider_unreachable at it). Such a walk never reaches never_sent.

Walked and sound (every other lookup verdict path and consumer):
- found: runCheck :428-446 and afterClose :949-975.
- sid_held_elsewhere: :864-871, which precedes the cut rule.
- continue: page_bound or nothing_adoptable at :879, handled by enqueueOrClose :1017-1051.
- The unresolved causes: page_bound :880, unidentified_candidate :881, same_fingerprint_sibling :885; also no_sender and digest_mismatch :766-770.
- never_sent: redrive :1152-1177, with its refusal, the markRedriven fence and second_unknown.
- The superseded re-apply :415-419.
- External consumers: only e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:412 (never_sent) and :559 (provider_unreachable), both single-page lists that FW4 does not change, plus the send_unconfirmed slot code in the dashboard. No infra filter keys on a verdict, cause or reason, and no product surface reads the record's cause.

## (2) Defects in the FW4 diff

FW4-1, reviewed cold:
- Guards: the window filter (:839) runs before bySid. The sibling-SID skip (:855), heldBy (:856-857) and the claim-decided adoption (:862) are all per candidate and do not depend on whether the walk is complete.
- So a cut walk sees a subset of a complete walk's candidates and can adopt only what a complete walk could. It cannot adopt a sibling's message, a message outside the window, or a message another attempt already holds.
- The one difference is the oldest-first choice among the visible candidates:
  - With createdAt paging, a 150 s window cannot straddle 5000 messages to one recipient.
  - With another sort key, it can only swap which same-fingerprint message is credited to which sibling. The losing sibling then falls to same_fingerprint_sibling (:885), because the adopter is done/adopted, never to never_sent.
- The mechanics hold:
  - `cut` is set only right before its break (:846-849).
  - The `!last` gate is at :844.
  - The mapping at :879-888 matches rules (a)-(d). The order is page_bound, then unidentified_candidate, then same_fingerprint_sibling, then never_sent.
- The only defect is NEW-1.

D-2. LOW, CONFIRMED (zz-r3-2). In the broadcast known arms, FW4-2's gate uses `slotWritten`, which covers the slot write AND the stats bump in one guardWrite (broadcastFanOut.ts:696-703).
- User-visible: nothing on screen changes (the row reads Failed 30007). The operator log now says a slot write failed and the recipient is carried, for a recipient that failed with 30007 and will never be retried, and the carrier-filtering ERROR is gone.
- Mechanism:
  1. setRecipient writes failed/30007, then bumpStats throws.
  2. The 30007 ERROR (:704-707) is suppressed.
  3. The new WARN (:753-761) says "its slot write failed; the recipient is carried with the attempt still open".
  4. The continuation skips the terminal slot, the record stays `attempting` (R2C-5), and the share finalizes failed.
- Evidence (zz-r3-2):
  - Slot after pass 1: {failed, 30007}.
  - The WARN-and-up lines are exactly [the carry WARN, guardWrite's "failure-arm write failed" ERROR].
  - After the continuation: record `attempting`, finalStatus failed.
  - Failing assertion zz-r3-2.test.ts:143 `expect(msgs.some((m) => m.includes('carrier filtering (30007)'))).toBe(true)`, "expected false to be true".
- Fix, text only and within FW4-2's scope: reword the line to "its slot or stats write failed", or gate the outcome line on the slot write alone.

FW4-2 otherwise:
- No write, carry, flag or counter moved:
  - The guardWrite bodies (:696-703, :736-745) are unchanged.
  - The flag write (:722-726) stays unconditional.
  - The carry (:760) and failedCount (:768) are unchanged.
- Log consumers: only send-outcome-reconcile.spec.ts:475 matches the substring 'send rejected by the provider'. The success line still carries it and the carry line does not.
- infra: the metric filters (infra/modules/observability/main.tf:40, :56, :79, :95, :111) key on correlationId, `level >= 50` and three event names, never on message text. The 30007 throw path now adds 1 ERROR to the metric instead of 2, which is negligible against the 5-per-300 s burst threshold.
- relayRetryLeg.ts:927-952 and deliveryStatus.ts:625-630 are text and comments only, and accurate. The three docblocks match gateFor (sendAttemptGate.ts:30-39).

## (3) Adjudication challenges

- A-FW4-1 cost claim (r2-adjudications.md:41-43, "without adding a failure point ... at most four more list calls").
  - False: each added call is a failure point that turns a found verdict into unresolved (NEW-1).
  - Either apply rule (b) to a mid-walk list error too, or take R2C-1's lighter alternative: keep the last-check stop and rule unresolved when it fires. That alternative makes zero extra calls.
- Rule (c)'s verdict cost (r2-adjudications.md:58-59, fw4-report.md:244-247 residue 2).
  - It was priced in list calls only. For recipients with more than 5 pages from the sender, a genuinely lost send now closes page_bound and is never re-sent.
  - The standing ruling (r2-adjudications.md:12-14: a double text is annoying, not critical) points the other way for that population. The handback should state this as a behavior change for the human to confirm, not as a cost of list calls.
- FW4-2 acceptance (fw4-report.md:268-270).
  - Gating on the combined guardWrite goes beyond the ruling's text (r2-adjudications.md:86-89, "when the slot write threw"). See D-2.
  - R2C-5 as RESIDUE (:137-141): I agree. zz-r3-2 shows it is harmless to the user today.
- No other disagreement. N-1, A-1, F-3, R2C-6 and R2C-7 stay RESIDUE, and R2C-2 stays a NOTE.

## (4) Verdicts

- FW4-1: REAL as ruled, with one hole in scope.
  - Code: sendReconcile.ts:844, :846-849, :879-888.
  - Pins in app/test/sendReconcile.test.ts: :884 (A) and :912 (B); :940 (C) and :961 (D); :987 (E, including the sibling-order pin from 4eef5efa); restated :778 and :1817, plus :671.
  - The hole: its own principle ("judge what was read") covers only the bound (NEW-1).
- FW4-2: REAL for the slot-throw case, PARTIAL overall because of D-2.
  - Code: broadcastFanOut.ts:704-707, :727-729, :746-761.
  - Pins: broadcastFanOut.test.ts:2255, :2278, :2298, and the success-path pins at :1787-1791; relayRetryLeg.test.ts:1559.
  - The docblocks and comments were verified by reading.

## (5) Not verified; throwaway tests

- Real Twilio list behaviour: the sort key, whether queued messages are listed, and the page size.
- The af848977 half of NEW-1 was walked from the diff, not executed, because no checkout was allowed.
- The 17/17 mutant table was not re-run, since that needs edits to tracked source. Each rule's pin was checked by reading it against its mutant.
- Relay owners were not exercised. The walk is owner-agnostic, and the adoptRelay guards were read only.
- Throwaway tests, both deleted:
  - zz-r3-1: the control passed and the probe failed at :186, as expected.
  - zz-r3-2: failed at :143, as expected.
- Timing: both runs came after the gate chain had moved to Playwright (CLI PID 69044, started 15:54:44). Their vitest globalSetup and teardown touch only the worktree's hctest DynamoDB Local database, not lane 8's hclane8, so I expect no interference with the running gates.
