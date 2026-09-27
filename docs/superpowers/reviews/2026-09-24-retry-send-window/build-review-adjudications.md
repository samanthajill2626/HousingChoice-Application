# Retry send window build - review adjudications (build orchestrator)

Branch `feat/retry-send-window` @ `c2322857`, merge base `da04d0cb` (= `main`, not
moved). Inputs: `build-review-conformance.md` (spec-conformance reviewer: CONFORMS
WITH GAPS, 0 blocker, 0 major, 1 minor, 4 nit) and `build-review-adversarial.md`
(plan-blind adversarial reviewer: 0 blocker, 0 major, 2 minor, 8 nit, 5 open
questions). Adjudicated 2026-09-26 by the build orchestrator.

Gates at `c2322857`, before any fix (logs under the worktree's gitignored
`.superpowers/gates/`): typecheck EXIT=0; smoke EXIT=0; npm test EXIT=0; full
e2e 279 passed EXIT=0; gate 5 one error, pre-existing (baseline below).

Every item below is FIX (in the one fix wave), FILE (an issue record, no code),
NOTE (handback only) or REJECT (with the reason).

## Conformance reviewer

| # | Finding | Verdict | Reason / instruction |
| --- | --- | --- | --- |
| C1 | MINOR: the one-to-one retry JOB's window test pins no exact boundary (spec D13) | FIX | Spec D13 requires it; the reviewer's probe shows the behavior is right. Add the two-row boundary case (origin exactly `RETRY_SEND_WINDOW_MS` before the job clock: one send; one millisecond earlier: no send) beside the existing job window tests in `app/test/twilioStatusWebhook.test.ts`. |
| C2 | NIT: `docs/issues/relay-hub-message-delivery-status-never-terminal.md` still reasons from "whose 30003 retry is real" and "retry promise included" | FIX | A dated note under that reasoning: after retry-send-window the base 30003 copy promises nothing, no native group text retries (D11), and the message-level chip omits `relay` because `relay` would switch the one-to-one promise off (D8). Body text above stays as the historical reasoning. |
| C3 | NIT: `RUNBOOK.md:341` lists "the 30003 retry" among texts the wrapper refuses on a `manual` row | FIX | Since D14 only the retry of an AUTOMATED text is refused there; a person's text is retried as a person's send. Word it that way. |
| C4 | NIT: intention 2's "root slot unchanged" not asserted in the versioned window case | FIX | Assert the versioned root slot equals its pre-claim value in that case (`relayRetryClaim.webhook.test.ts`, the window-decline case). |
| C5 | NIT: `Timeline.tsx` summary comment "Failures expose a reason ... + Retry" is no longer unconditional | FIX | Comment-only: Retry is not rendered while an automatic retry is still promised (D10). ASCII added line; the file carries pre-existing non-ASCII - select, never retype. |

## Adversarial reviewer

| # | Finding | Verdict | Reason / instruction |
| --- | --- | --- | --- |
| A1 | MINOR: the retry job ignores a WITHDRAWN promise; an enqueue that throws after the queue actually accepted the job withdraws the promise, a staff Retry then sends, and the queued job sends too | FILE, no code | The proposed fix (the job ends the chain on the withdrawal sentinel) is a reverse double-send guard: in the ambiguous case it would drop a real retry whenever nobody presses Retry. Cameron's spec-gate ruling 4 (rulings.md): "The dropped guard is fine, I would rather err on the side of a double-text than a message not delivered at all." Spec D7 withdraws the PROMISE, not the retry. The path is real and was not on the filed list: add it as gap 5 to `docs/issues/manual-retry-double-send-residual-windows.md`, stating that it is kept deliberately under that ruling and what would close it (the claim-based fix the issue already suggests). Handback surfaces it. |
| A2 | MINOR: when the job gives up at send time (a refusal after a STOP during the backoff, the kill switch, the breaker on an automated original, the window closed because the job ran late, the original gone) the promise is not withdrawn; "will retry", no Retry and 409 `retry_pending` last until `retry_due_at` + 2 min (+1 tick) | FILE, no code | Spec section 9 ("A promise with nothing behind it") accepts exactly this class for this branch: "each keep 'will retry', and hide the Retry button, until the promise expires". Changing it is a spec deviation (new writes and emits from the worker after the execution marker) with a bounded benefit (at most about 3 minutes, rare exits only). File a low improvement issue `one-to-one-retry-promise-outlives-job-decline` with the reviewer's evidence and the suggested fix (best-effort withdrawal + emit on every no-send exit after the marker, never rethrown), noting that the relay job already announces every close at once. Handback surfaces it for Cameron's eye. |
| A3 | NIT: the client-side timeline fallback (`buildTimelineFallback.ts`) drops `retry_due_at` | NOTE | Pre-existing drift: the fallback already omits `error_code` and `retry_of`, so on that path a failed bubble shows no reason at all; adding `retry_due_at` alone would hide Retry with no explanation. Reachable only on a contact 404; the server's 409 guard holds and maps to "A retry is already scheduled for this message." The "kept in step" comment is scoped to the import-provenance field it sits on. No change. |
| A4 | NIT: a service imports the job module for two constants; the one-to-one origin rule `retry_window_start ?? provider_ts` is written twice | FIX (origin rule only) | The origin rule is D2's heart and two unpinned copies can drift: one pure helper in `app/src/lib/retrySendWindow.ts` (structural parameter type, keeps the module import-free for the dashboard mirror test), used by `oneToOneRetryDecision.ts` and `retrySend.ts`, with unit rows. The constants' location stays: the webhook already imports job modules the same way for the relay ladder (`resolveRelayRetryBackoff`, `enqueueRelayRetryLeg`) and there is no cycle. |
| A5 | NIT: the annotate-after lineage API (`MessageAnnotations.retryOf` / `retryAttempt`) is dead but open | FIX | This branch made it dead (D6: lineage at append), and leaving it open is a door back to the race D6 closed. Remove both fields, their SET branches and log fields in `annotateMessage`, the harness twin's two lines, and the lineage half of the integration test (keep its media-annotation and conditional-failure coverage). Grep + typecheck prove no caller. |
| A6 | NIT: `retry_window_closed` exists as four unpinned string copies across app and dashboard | FIX | One exported constant in `app/src/lib/retrySendWindow.ts`; the job's `RelayRetryCloseCode` and the claim's decline unions derive from it (so an app-side rename breaks the build at every literal); the dashboard's `WINDOW_CLOSED_CODE` is exported and pinned by a mirror test (precedent `retryPromiseMirror.test.ts`) together with the fallback copy `deliveryReason` returns for it. |
| A7 | NIT: the relay claim reads the same conversation twice on a member's rung 1 | NOTE | One extra read per relay 30003 claim; correct either way. Not worth threading through `composeRelayLegCopy` in this wave. |
| A8 | NIT: a redelivered callback for a claim-time DECLINED relay rung logs `already_claimed` | FIX (comment) | The dedupe is the decision and is right; the union's doc should say `already_claimed` also answers a duplicate for a rung appended CLOSED at claim time, so it does not imply a ladder ran. |
| A9 | NIT: the server-clock estimate keeps the last sample, not the least-lagged | NOTE | Spec D8 specifies the latest fresh response; every error is in the safe direction (the promise shows longer, Retry never returns early); recorded with the D7 accepted residual. |
| A10 | NIT (plausible): mixed versions at deploy time | NOTE | Handback deploy note: a tab loaded before the deploy maps 409 `retry_pending` to the generic copy until reload; retries scheduled by the old webhook in the minutes before the deploy carry no `retry_due_at`. No code. |
| Q1 | Open: ErrorLogs burst alarm (5 in 5 min) vs clustered late 30003s, each now an ERROR `window_closed` | NOTE | Spec D9 and Cameron's anchor ruling ("Alarm thresholds unchanged") decide the level. Surfaced in the handback for Cameron's eye as an operational watch item. |
| Q2 | Open: the property-send results row never learns the retry outcome | NOTE | Spec D8 / section 5: share-skip-fix Branch B reads `retry_due_at` there. Under-promising only. |
| Q3 | Open: `claim_failed` recovery relies on Twilio redelivering a 5xx status callback; the preview adds reads | NOTE | Pre-existing mechanism (spec section 9, "A relay claim fault"); the added reads widen it slightly. Handback. |
| Q4 | Open: should the job refuse once the promise has EXPIRED | REJECT | Same reverse-guard ruling as A1. |
| Q5 | Open: the one-to-one origin is Twilio's `dateCreated` | NOTE | By design (spec D2). |

## Gate 5 baseline (for the record)

`npx eslint` over the branch's 52 touched script files reports ONE error:
`dashboard/src/routes/contact/Timeline.tsx:1575:7 react-hooks/set-state-in-effect`
on `setNow(fresh);`. The same file at the merge base, linted in place through
`--stdin --stdin-filename`, reports the same rule on the same statement at `:1495`.
Pre-existing; moved +80 lines by Task 17. Not this branch's.

## The fix wave

One wave, one fresh implementer: C1-C5, A2 (issue only), A1 (issue gap only), A4
(origin helper), A5, A6, A8. Then one fresh re-reviewer, charged in order with:
what the first pass missed, the fix diff reviewed cold, challenges to these
adjudications, and only then whether the fixes are real.
