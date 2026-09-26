# Planner independent review - adjudications

Branch `feat/retry-send-window` @`56085389` (the build's handback; code at
`168585b2`), reviewed by the planner after the build orchestrator stopped:

- Planner gates at `56085389` (bare, logs under the gitignored
  `.superpowers/planner-gates/`): typecheck EXIT=0; smoke EXIT=0; e2e EXIT=0
  "279 passed (21.2m)", 0 `[dynamoAdmin]`; gate 5 EXIT=1 with ONE error, the
  pre-existing `Timeline.tsx` `react-hooks/set-state-in-effect` on `setNow(fresh);`
  (baseline at the merge base: the same statement); `npm test` EXIT=1 on ONE file,
  `app/test/tourRemindersApi.test.ts`, the earlier[] tie-break case - a fixture
  race (two `Date.now()` reads meant to be identical), untouched by this branch;
  the file passed alone twice (69/69, EXIT=0) and in the build's own final run;
  filed as `tour-reminders-earlier-tie-break-test-ms-race` (low).
- Reviews: `planner-review-conformance.md` (CONFORMS; 3 low notes) and
  `planner-review-adversarial.md` (plan-blind; 1 medium, 5 low).
- The planner read the riskiest diffs itself: the relay claim's one-write
  decline, the one-to-one decision and stamped status write, the 30003 arm and
  its withdrawal, the retry job, the manual Retry route, the dashboard clock,
  promise, Retry gate and ticker. No finding beyond the reviewers'.

Every item: FIX (done by the planner in this wave, red-first), NOTE (verdict /
handback only), or FILED.

| # | Finding | Verdict | What was done |
| --- | --- | --- | --- |
| ADV-1 | MEDIUM: every retry path judges the RECORDED recipient even after it no longer holds the thread's number - the JIT consent (and deleted) gate is judged on the wrong contact; the manual Retry, unbounded in time, newly passes it | FIX | `sendMessage` counts a named recipient only while `contactHoldsPhone(recipient, participant_phone)` (primary or secondary, new pure helper beside `contactPhones` in `app/src/repos/contactsRepo.ts`); otherwise it ignores it for every gate, judges the phone-matched contact, records no `recipient_contact_id`, and WARNs. `previewSendRefusal` mirrors it (new `participantPhone` input) and the 30003 decision passes the thread's number. One shared-table group (three moved-off rows, one secondary-phone row) drives the preview, the wrapper parity and the decision; a focused wrapper test pins the WARN and the unrecorded recipient. Red first: 10 failures across the three suites; green after. A no-op for property sends (the fan-out resolves the thread by the recipient's own number). Spec D14 updated (draft 7.4). |
| ADV-2 | LOW: "will retry" and the hidden Retry outlast the server's `retry_pending` guard by up to one 60 s ticker period; comments said "exactly as long" | FIX (comments) | Within spec section 1's stated bound ("plus one ticker interval"). The three comments now say so (`retryPromise.ts`, `api.ts`, `Timeline.delivery.test.tsx`). |
| ADV-3 | LOW: the property-send results row reads a flat failure for a 30003 even while a retry is scheduled or after it delivered (the retry row carries no `broadcast_id`) | NOTE | Spec D8 / section 5: share-skip-fix Branch B reads `retry_due_at` there; the slot-update gap is Branch A's relayed item 4 (SOR files it; Branch B fixes it). Under-promising only. |
| ADV-4 | LOW: the relay claim's gate-preview reads fail closed (`claim_failed`), the opposite of the one-to-one fail-open | NOTE | Spec D3 decision (the claim's existing recovery by Twilio redelivery) and section 9 "A relay claim fault". |
| ADV-5 | LOW: late 30003s now log one ERROR each; the alarm effect is unmeasured | NOTE | Cameron's anchor ruling kept alarm thresholds; surfaced as an operational watch item. |
| ADV-6 | LOW: the relay map's 30003 entry duplicates the base copy and can drift silently | FIX (test) | Kept per spec D8; a new `deliveryStatus.test.ts` case pins `deliveryReason('30003', { relay: true })` to the base copy. |
| CONF-1 | LOW: the during-backoff refusal class keeps "will retry" about 3 minutes and is not ruled | NOTE | Filed (`one-to-one-retry-promise-outlives-job-decline`, group b); open question for Cameron. |
| CONF-2 | LOW: the 404 timeline fallback never carries `retry_due_at` | NOTE | The server's 409 guard holds; build review A3. |
| CONF-3 | LOW: a rung whose gate passes in the window's last millisecond closes instead of sending | NOTE | Errs toward not sending late. |

## Re-review of the planner's fix (the adversarial reviewer, continued)

The same plan-blind reviewer re-reviewed commit `cec46afd` with the re-review
charge (its section "Re-review of cec46afd" in `planner-review-adversarial.md`):
two findings, both handled in a second planner wave, red first.

| # | Finding | Verdict | What was done |
| --- | --- | --- | --- |
| RR-1 | LOW: the `recipient` contract comments still said the recorded recipient is always judged | FIX (comments) | `sendMessage.ts` (the `recipient` doc), `api.ts`, `retrySend.ts`, `oneToOneRetryDecision.ts` and `docs/issues/ai-mode-switch-gates-all-automation.md` now name the held-number rule. |
| RR-2 | LOW (ADV-4 contested, and the reviewer is right): Twilio's default webhook retry policy is `ct` - connection failures only - so a 5xx status callback is never redelivered, and `claim_failed` is terminal; the claim's new gate-preview reads added fault points that lose a relay retry ladder | FIX + FILE | Verified against Twilio's connection-override docs ("Default: ct"); the repo sets no `#rp=` override. The claim's gate preview now FAILS OPEN: a thrown read claims the rung open with a WARN (the job re-runs every gate) - the rewritten test failed first against the old code (a 500 and `claim_failed`), then passed. The pre-existing reliance on redelivery (the claim's consistent re-read, roster read and append) is filed as `relay-retry-claim-assumes-5xx-redelivery` (med). Spec draft 7.5 corrects D3, section 1 and section 9. ADV-4's NOTE is withdrawn. |
