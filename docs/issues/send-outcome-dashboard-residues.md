---
id: send-outcome-dashboard-residues
title: Four small dashboard residues of the send-outcome presentation work - a latent delivered and not-confirmed double count, a stale reason doc, one token with two sentences, redrive_refused prose wrong for most causes
type: debt
severity: low
status: open
area: dashboard
created: 2026-09-27
updated: 2026-09-27
refs: dashboard/src/routes/contact/deliveryStatus.ts:30, dashboard/src/routes/contact/deliveryStatus.ts:550, dashboard/src/routes/contact/deliveryStatus.ts:585, dashboard/src/routes/contact/deliveryStatus.ts:1049, dashboard/src/routes/contact/deliveryStatus.ts:1099, dashboard/src/routes/contact/relayRetryJoin.ts:260, app/src/repos/messagesRepo.ts:133
---

**Problem.** Residues the build recorded while making the dashboard present
`send_unconfirmed` as "Not confirmed" (`feat/send-outcome-reconcile`, spec
D20-D23; build S4 residues 1, 3 and 5; line numbers at the branch's HEAD).
None is visible today.

1. **A latent double count in the relay rollup.** The rollup's delivered count
   (`dashboard/src/routes/contact/deliveryStatus.ts:550`) does not look at the
   code, while J ("not confirmed") takes any leg carrying `send_unconfirmed` by
   its code alone (`:582-591`), so a `delivered` slot carrying that code would
   count as both delivered and not confirmed. Unreachable today: the
   forward-only table never moves `failed` to `delivered`
   (`app/src/repos/messagesRepo.ts:133-142`), and the retry join clears the
   original's code when the retry delivered
   (`dashboard/src/routes/contact/relayRetryJoin.ts:260-295`). It sits outside
   the K/R/J rule the branch was asked to change, so it was left alone.
2. **A stale doc on `DeliveryPresentation.reason`.** It says a reason is
   present only on a failure that carried a code (`deliveryStatus.ts:30-36`).
   `Retrying`, the internal-code prose and now `NOT_CONFIRMED_PRESENTATION` (a
   reason on a non-failure, `:122-127`) all contradict it. The drift predates
   the branch, which widened it; the doc was not on the build's list of lines
   to amend.
3. **One token, two sentences.** `sms_sending_disabled` reads "SMS sending is
   switched off, so nothing was sent" on a FAILED slot (the internal-code map,
   `:1049` - the wording spec D23 chose, as at
   `dashboard/src/api/types.ts:1414`) but "Texting is turned off" on a SKIPPED
   share row (`SHARE_SKIP_REASONS`, `:1099`, which the share row reads first,
   `:1104-1108`).

**Suggested fix.** Optional: exclude the code from the delivered count, or pin
its unreachability in a test (1); correct the doc (2); decide whether one
sentence should serve both positions - a product call (3).

## Addendum 2026-09-27 - planner post-build review

Found by the planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding L-3
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577`. Severity stays `low`.

4. **The `redrive_refused` prose is wrong for most of the causes that write
   it.** The row reads "Wasn't resent: the group closed or the member left"
   (`INTERNAL_CODE_REASONS`, `dashboard/src/routes/contact/deliveryStatus.ts:1056`).
   Two of the causes that write the code fit: `group_not_open` and
   `member_removed`. The rest do not: the relay fan-out's
   `conversation_not_found`, `no_pool_number` and `source_not_found`
   (`app/src/jobs/relayFanOut.ts:846`, `:866`, `:882`), `nothing_to_relay`
   (`:1124`) and `source_vanished` (`:1494`); and the reconcile's own
   pre-check refusals `no_continuation` and `retry_row_not_found`
   (`app/src/jobs/sendReconcile.ts:1125`, `:1128`). The slot carries only the
   code, not the cause, so the dashboard cannot choose per cause. **Fix:** a
   generic sentence that is true for all of them - for example "Wasn't
   resent" plus a neutral clause, a product-copy call - and update the mirror
   test (`dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts`) if it
   pins the prose. Wording only: no send, no status, no count changes.
