# Plan draft B2 - findings (Tasks 10-13)

Drafter: slice B2 of the retry-send-window plan, 2026-09-25, read-only against
the worktree at HEAD `fd38ba73`. Tasks are in `.superpowers/plan-drafts/slice-B2.md`.
Code is cited by `file:line` at HEAD; nothing here is pasted code.

No CONTRACT CHANGE was needed: every Task 10 name and type is used exactly as
the skeleton states. Two job-internal additions are flagged below (F10) because
they are not in the skeleton.

## Coupling with other slices

- **F1 (medium) - Task 9 breaks the only `enqueueSendRetry` call site until
  Task 10 lands.** The contract changes the signature to
  `enqueueSendRetry(payload, runAt)`; the one caller is
  `app/src/routes/webhooks/twilio.ts:3364-3368`, which passes one argument.
  Unless Task 9 updates that call (an interim `runAt`) or makes `runAt`
  optional, `npm run typecheck` is red at Task 9's commit. Task 10 replaces the
  call whatever its arguments, and drops `resolveSendRetryBackoffMs` from the
  `twilio.ts:119-122` import if Task 9 added it there.
- **F2 (info) - shared files.** `app/test/twilioStatusWebhook.test.ts` is edited
  by Tasks 10 and 11 (and probably Task 9, near the backoff test at `:847-851`);
  `twilio.ts` by Tasks 4-6 above `:2907` and Task 10 at `:119-122`, `:315-341`
  and `:3251-3479`; `retrySend.ts` by Task 9 (`:36-77`) before Task 11. Line
  numbers shift; both B2 tasks anchor every edit on quoted text or test names.
  If Task 4 already imports from `lib/retrySendWindow.js` in `twilio.ts`, Task
  10 folds `RETRY_PROMISE_WITHDRAWN_AT` into that import.
- **F3 (info) - `MAX_SEND_RETRY_ATTEMPTS` becomes unused in `twilio.ts`** once
  the decision owns the cap (`twilio.ts:121`, used only at `:3354`). Task 10
  removes it from the import; left in, gate 5 (lint) would flag it.

## Behavior the contract changes (confirm or accept)

- **F4 (medium) - `conversation_missing` is a NEW alarm-feeding ERROR.** The
  contract declines it at ERROR. Today such a message enqueued a retry whose job
  logged the refusal at WARN (`app/src/jobs/retrySend.ts:209-216`, via
  `ConversationNotFoundError`, `app/src/services/sendMessage.ts:291`). Spec D9
  lists no such case. It is a real data anomaly (a message row with no
  conversation), so ERROR is defensible, but it is an alarm-set change the spec
  did not name.
- **F5 (low) - a refusal now outranks the cap.** Per D3a's order, an opted-out,
  kill-switched or (automated) manual-mode thread whose retries are exhausted
  logs the refusal at WARN instead of today's exhausted-retries ERROR
  (`twilio.ts:3354-3361`). Fewer ERRORs in that corner.
- **F6 (low) - a non-failure callback carrying 30003 no longer enqueues.** Today
  the arm enqueues on ANY transitioned callback with ErrorCode 30003
  (`twilio.ts:3343-3369`), even a non-failure status. The contract decides only
  for failed/undelivered, which matches the relay claim's own trigger
  (`twilio.ts:2685-2686`). The arm now breaks without a line in that case.

## Contract nuances (no change made)

- **F7 (low) - `failOpen` holds one value.** When a read throws AND the origin is
  missing, Task 10 reports `read_failed`; the no-origin gap goes unlogged in that
  rare double case. The precedence is pinned by a unit test.
- **F8 (low) - the fail-open WARN cannot carry the error.** The decision swallows
  the thrown read (the contract's retry variant has no error field), so the
  arm's WARN names the gap but not the DynamoDB fault. A later
  `readError?: unknown` on the retry variant would fix it; not done.
- **F9 (low) - the webhook's recipient fallback is silent.** A recorded
  recipient id that resolves to nothing falls back to the phone-matched contact
  inside the decision with no log (the contract gives it no logger). D14's WARN
  is emitted by the job at send time (Task 11) and by the manual route (Task
  12).

## Additions outside the skeleton contract

- **F10 (info) - `RetrySendJobDeps` gains `contactsRepo?` and `now?`**
  (`app/src/jobs/retrySend.ts:79-90`). The first reads the recorded recipient
  (built lazily, and only when a row records one, so rows without a recipient
  never construct a DynamoDB client); the second is the D4 clock (spec D13:
  unit tests inject the clock). Both are optional, so
  `app/src/jobs/registerHandlers.ts:47` needs no change.

## Test seams and fixtures

- **F11 (low) - the webhook has no clock seam.** The decision takes `nowMs` and
  its unit tests pin it, but `createTwilioWebhookRouter` passes `Date.now()`, so
  the harness tests move `seedOutbound`'s fixed `provider_ts`
  (`app/test/twilioStatusWebhook.test.ts:59`) to 30 seconds before the wall
  clock and assert `retry_due_at` within a before/after bound. Faking `Date`
  in that suite would desync the enqueue delay: `app/src/jobs/jobs.ts:60`
  captures `Date.now` by reference and `_resetForTests` (`:351`) re-captures
  it; a later test that fakes `Date` should use `configureJobsClock` (`:87`).
  A `now` dep on `TwilioWebhookDeps` plus a harness option would allow exact
  equality if wanted.
- **F12 (info) - the webhook tests rely on Task 2's harness twins.** The stamp,
  withdrawal and "nothing annotated" assertions hold only if the fake
  `updateDeliveryStatus` (`app/test/helpers/twilioWebhookHarness.ts:1213-1219`)
  sets `retry_due_at` on a transition only, the fake `annotateMessage` (`:1338`)
  honors `retryDueAt`, and the fake `append` (`:1081-1193`) carries the five new
  fields - otherwise the D6/D14 row assertions pass vacuously or fail for the
  wrong reason.

## Spec gaps and residuals

- **F13 (low) - a crash between the status write and the enqueue.** Section 9's
  "promise with nothing behind it" lists the breaker, a fail-open refusal, a
  job-time decline and a failed enqueue whose correction also failed. A process
  crash after the stamped write (`twilio.ts:3251`) but before the enqueue in the
  arm is the same shape: Twilio's redelivery finds nothing to transition, so the
  promise stands, with no job, until it expires (at most the backoff plus
  `RETRY_PROMISE_GRACE_MS`). Today the same crash loses the retry silently.
  Worth one line in section 9 or the residual-windows issue.
- **F14 (low) - two ERROR lines for one enqueue incident.** When the enqueue
  fails AND the withdrawal write fails, Task 10 logs the withdrawal's own ERROR
  and the arm's existing catch ERROR (`twilio.ts:3524-3528`). Both are
  actionable; D9's "keeps today's ERROR" holds.
- **F15 (info) - a redelivered failure still pays the decision's reads.** Test
  intention 4 says a redelivered callback "writes, logs and enqueues nothing
  more", which holds; the conversation and contact READS still run, because the
  decision precedes the conditional write. A pre-check of the read row against
  `allowedPriorStatuses` (`app/src/repos/messagesRepo.ts:144`) could skip them;
  not done (Twilio redelivers only on a non-2xx).
- **F16 (info) - D10 and eventual consistency are safe.** The manual route reads
  the original through `getByProviderSid`; because the failure and the stamp
  land in one conditional write (D7), a stale read sees neither and answers 409
  `not_failed`, never a failure without its promise.
- **F17 (low, pre-existing) - duplicate contacts on one phone.** With no recorded
  recipient, the decision's `findByPhone` and the send's `findByPhone` each take
  the GSI's arbitrary first match (`app/src/repos/contactsRepo.ts:1011-1016`),
  so the preview and the send can judge different contacts. D14's recorded
  recipient removes this for property sends only.

## ASCII and pre-existing text

- **F18 (info) - kept lines with non-ASCII bytes.** D9 keeps the exhausted-retries
  ERROR text, whose message carries a pre-existing non-ASCII dash
  (`twilio.ts:3360`, comment arrow `:3355`). Task 10 leaves those lines
  byte-for-byte rather than retyping them (retyping would either break the
  ASCII-on-touched-lines rule or change the log text). Likewise the job's
  refusal WARN (`retrySend.ts:210-216`) and the non-ASCII comment lines around
  Task 11's anchors (`retrySend.ts:118`, `:122`). The tasks name those ranges by
  line and ASCII anchor instead of quoting them, and each task checks only its
  ADDED lines for non-ASCII.
- **F19 (info, stale citations fixed).** `twilio.ts:328` cites
  `sendMessage.ts:298-300` for the group-text refusal (now `:310-312`); Task 10's
  rewrite of `:315-341` removes it. `twilio.ts:345-350` (the
  `isTerminalDeliveryFailure` doc, "a transient code we auto-retry") and the
  title of `app/test/deliveryFailureSeverity.test.ts:23` are still true of the
  marker and are not in D12's list; left alone.

## Dashboard notes for slice C

- **F20 (info) - two client paths never carry `retry_due_at`.** The contact
  timeline's 404 fallback in `dashboard/src/routes/contact/useContactTimeline.ts`
  (from `:175`) maps legacy `Message` rows (`dashboard/src/api/types.ts:2277`,
  which declares no retry fields), and `useRelayThread`'s fixed field spread
  (`dashboard/src/routes/conversation/useRelayThread.ts:101-151`) drops unknown
  fields. Neither carries a one-to-one promise today (relay and group rows are
  never stamped, D11; the fallback runs only when `/timeline` 404s), so both can
  only under-promise. Task 13 adds the field to the server projection and the
  dashboard `TimelineMessage` only.
- **F21 (info) - the 409 code Task 17 maps.** Task 12 answers
  `409 { error: 'retry_pending' }`, the same body shape as the route's other
  refusals (`app/src/routes/api.ts:1586`, `:1593`).
