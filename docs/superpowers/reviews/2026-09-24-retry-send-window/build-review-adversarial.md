# Build review - adversarial (feat/retry-send-window @ c2322857)

Reviewer: independent adversarial code review, run WITHOUT the design documents
(nothing under `docs/superpowers/` or `.superpowers/` was read except the code
diff package `.superpowers/review/diff-package-code.md`). Merge base da04d0cb.
Two throwaway probe tests were written under `app/test/zz-review-adv-*.test.ts`,
run one file at a time against DynamoDB Local, and deleted; their failing output
is quoted below. No tracked file was modified.

## 1. What this change does (derived from the code and tests)

Automatic retries of a carrier-30003 ("handset unreachable") failure now stop 15
minutes after the original text went out, and the staff screen only promises a
retry when one is actually scheduled.

One-to-one texts. When a `failed`/`undelivered` status callback carries 30003,
the status webhook (`app/src/routes/webhooks/twilio.ts:3432-3447`) decides BEFORE
it writes the failure whether a retry will be attempted
(`app/src/services/oneToOneRetryDecision.ts`): channel checks (missing
conversation, native group text, relay or phone-less thread), then a pure preview
of the send wrapper's refusals (`sendRefusalPreview.ts`, pinned to
`sendMessage.ts` by a shared parity table), judged for the ORIGINAL send's
`automated` flag and recorded recipient; then the 3-retry cap; then the window
(`now + backoff + 60 s <= origin + 15 min`, origin = `retry_window_start ??
provider_ts`). Reads that throw fail open. A retry verdict rides the SAME
conditional status write as `retry_due_at` (the job's run time); the 30003 arm then
enqueues `messaging.retrySend` at exactly that instant, only on the transition. An
enqueue failure rewrites `retry_due_at` to the epoch sentinel and re-emits (the
"withdrawal"). The job (`app/src/jobs/retrySend.ts`) reads the recorded recipient
before its execution marker, re-checks the window strictly after it, and sends
with the original's `automated` flag and recipient, stamping `retry_of`,
`retry_attempt` and `retry_window_start` at append (no more annotate-after).
`sendMessage` now persists `automated` (false included) and `recipient_contact_id`
on every row.

Relay legs. The status webhook's rung claim now previews the relay job's four
gates through one shared evaluator (`app/src/lib/relayRetryGates.ts`) and the
window (origin = the root member slot's `sentAt` for rung 1, the carried
`relay_retry_window_start` for rungs 2-3); a rung either fails is appended ALREADY
CLOSED with the gate's code or `retry_window_closed` and never enqueued. The job
re-runs the gates, adds a strict window gate, bounds its A2P token-bucket wait by
the window end (`deadline_exceeded` outcome from `sendOneRelayLeg`), and closes a
transient re-run that would land past the window. Severity: gate declines WARN,
window declines ERROR.

Dashboard. The base 30003 copy no longer promises anything; only a one-to-one
bubble whose failed message carries a live `retry_due_at` (judged on an estimate
of the SERVER clock taken from every API response's `Date` header) reads
"Phone unreachable - will retry", hides its Retry button, and arms the staleness
ticker until the promise expires. The manual Retry route refuses 409
`retry_pending` while `retry_due_at + 2 min` is ahead on the server clock, and
passes the recorded recipient. A window-declined relay rung carries no display
code, so the leg reads the plain 30003. The e2e lane shortens the one-to-one
backoff to 10 s (`E2E_SEND_RETRY_BACKOFF_MS`, topology-guarded like the relay
twin).

## 2. Findings (most severe first)

No BLOCKER or MAJOR found. The core invariants I attacked hold: the failure and
its promise land in one conditional write (no reader can see one without the
other); a redelivered or concurrent callback cannot stamp, log or enqueue twice;
duplicate relay callbacks cannot open a rung another closed or vice versa (the
append's SID dedupe is the decision); the preview/send-path parity is pinned; the
harness fakes are pinned against the real repo shape; the dashboard clock errs
only in the conservative direction.

### F1. MINOR - CONFIRMED - the retry job ignores a WITHDRAWN promise, so an ambiguous enqueue failure re-opens the double text D10 exists to stop

Where: `app/src/routes/webhooks/twilio.ts:3612-3637` (withdrawal on ANY enqueue
throw) vs `app/src/jobs/retrySend.ts:161-345` (no read of `retry_due_at`, no check
for a superseding row anywhere in the handler).

Interleaving (one-to-one text R0):
1. T+5s: 30003 arrives; decision = retry; the failure write stamps
   `retry_due_at = T+65s` (twilio.ts:3442-3447).
2. `enqueueSendRetry` -> `SqsOutboundQueueAdapter` `SendMessageCommand`
   (`app/src/adapters/scheduler.ts:357`). SQS accepts the message (DelaySeconds
   60) but the response is lost and the SDK's retries also time out, so the call
   rejects. SendMessage on a standard queue is not idempotent; "threw" does not
   mean "not enqueued".
3. twilio.ts:3619-3627 rewrites `retry_due_at` to `1970-01-01T00:00:00.000Z` and
   re-emits. The bubble drops "will retry" and shows Retry at once
   (`dashboard/src/routes/contact/Timeline.tsx:791-795`, `:1421`); the route's
   guard admits a press (`app/src/routes/api.ts:1605`).
4. T+20s: staff presses Retry -> manual send R' (`retry_of` = R0).
5. T+65s: the queued job runs, finds R0 failed, window open, and sends R1.
   The member gets the text twice; two bubbles supersede R0.

Evidence (probe `zz-review-adv-withdrawn-promise.test.ts`: an outbound-queue
adapter that records the job and then throws; real webhook, real job, real send
service over the harness fakes). The pre-assertions passed - `retry_due_at` ===
the sentinel, `isRetryPromiseLive(...) === false`, one job queued - and the final
one failed:

```
x zz-review-adv: a withdrawn promise with a job behind it > the job honors the withdrawal
  -> expected [ { to: '+15550100001', ...(1) } ] to have a length of +0 but got 1
```

This path is NOT among the four gaps filed in
`docs/issues/manual-retry-double-send-residual-windows.md` (late job, stale tab,
pending outcome, reconcile `unresolved`), and it is wider than gap 1: the Retry
button appears immediately rather than two minutes after the due time.

Consequence: a rare (lost SQS response) but real double text to a tenant, exactly
the harm the 409 guard was built to prevent. Before this branch the same press was
always a double text, so it is a residual, not a regression.

Fix direction (smallest): in the job, before the send (either side of the
marker), end the chain with a WARN when `original.retry_due_at ===
RETRY_PROMISE_WITHDRAWN_AT` - the screen has told staff no retry is coming, so
the job must agree. Stronger option (a product call, see Q4): require
`isRetryPromiseLive(original.retry_due_at, now())` whenever the field is present,
which also closes filed gap 1 (a job running past the grace, after Retry has
reappeared). At minimum, add this path to the residual-windows issue.

### F2. MINOR - CONFIRMED - a job-time no-send leaves the promise live: "will retry", no Retry button and 409 `retry_pending` for up to two minutes after the system has already given up

Where: `app/src/jobs/retrySend.ts:238-249` (window closed at job time) and
`:323-332` (`SendRefusedError`: opt-out, deleted, consent, manual mode, breaker,
kill switch, group text), plus the not-found/not-outbound exits at `:170-178`.
None of them touches `retry_due_at` or emits `message.persisted`.

Interleaving:
1. T+5s: 30003, decision = retry, `retry_due_at = T+65s`.
2. T+20s: the tenant texts STOP (or the thread's kill switch flips, or the
   worker is backlogged past the window, or the breaker trips on an automated
   original).
3. T+65s: the job refuses (WARN) or closes on the window (ERROR) and returns.
   Nothing is written, nothing is emitted.
4. The bubble keeps "Phone unreachable - will retry" with no Retry until the
   server clock passes T+185s (due + `RETRY_PROMISE_GRACE_MS`), and the ticker
   re-renders at most `STALE_TICK_MS` = 60 s later (`Timeline.tsx:749`) - up to
   about T+245s. The route answers 409 `retry_pending` until T+185s.

Evidence (probe `zz-review-adv-refused-promise.test.ts`, both cases failed after
the `world.sent` length-0 pre-assertion passed):

```
x ... withdraws the promise when the job does not send (opted_out)
x ... withdraws the promise when the job does not send (window_closed)
- "liveAfterGivingUp": false,  "refreshed": true
+ "liveAfterGivingUp": true,   "refreshed": false
```

Consequence: a false promise for 2-3 minutes on exactly the surface this feature
exists to make truthful, and a staff member cannot retry by hand during it. The
same branch already applies the opposite principle twice: the webhook withdraws a
promise "with no retry behind it ... AT ONCE" on an enqueue failure (D7,
twilio.ts:3613-3617), and the relay job announces every close immediately
(`relayRetryLeg.ts:474-515`) - the relay claim even moved gate refusals earlier to
avoid "Retrying for 1 to 4 minutes". `sendRefusalPreview.ts:18-20` documents this
as accepted for the breaker only; it applies equally to every no-send exit.

Fix direction: on each no-send exit after a stamped promise, annotate
`retry_due_at = RETRY_PROMISE_WITHDRAWN_AT` for the original and emit
`message.persisted` (the worker's event bridge forwards it). The primitive
already exists (`annotateMessage` `retryDueAt`, messagesRepo.ts:3021-3024).

### F3. NIT - CONFIRMED - the client-side timeline fallback drops `retry_due_at` while claiming parity with the server projection

Where: `dashboard/src/routes/contact/buildTimelineFallback.ts:64-103` - a fixed
field list with no `retry_due_at` (and, pre-existing, no `retry_of`), while its
comment at `:98-101` says it is "Kept in step with routes/contactTimeline.ts so
the fallback renders identically"; the server projects the field at
`app/src/routes/contactTimeline.ts:452`.

Scenario: the fallback runs only when `GET /contacts/:id/timeline` 404s
(`contact_not_found`, contactTimeline.ts:1205). On that page a live promise
renders as the plain 30003 with a Retry button, and a press answers 409 with "A
retry is already scheduled for this message." No double send (the server guard
holds). Low reachability; it is a second projection that has already drifted.

Fix direction: project `retry_due_at` (and `retry_of`) in the fallback, or
correct the parity comment.

### F4. NIT - CONFIRMED - layering: a service imports a job module for two constants, and the one-to-one origin rule is duplicated

Where: `app/src/services/oneToOneRetryDecision.ts:42` imports
`MAX_SEND_RETRY_ATTEMPTS` and `resolveSendRetryBackoffMs` from
`app/src/jobs/retrySend.ts`, whose module graph pulls in the job registry
(`jobs.js`), `services/sendMessage.ts`, two repos and the media-store adapter
(`retrySend.ts:15-35`). The relay twin deliberately keeps its constants in the
dependency-free `app/src/lib/relayRetryClaim.ts` (header, lines 3-9) so the
webhook never depends on the job. Separately, the window-origin rule
`retry_window_start ?? provider_ts` is written twice, unpinned
(`oneToOneRetryDecision.ts:125`, `retrySend.ts:231`).

Consequence: maintainability only today (no cycle yet); the first time the job
wants the decision (e.g. to share the origin rule) it becomes a cycle, and the two
origin copies can drift silently.

Fix direction: move the cap, the backoff and its lane resolution, and a
`oneToOneRetryOrigin(message)` helper into `app/src/lib/retrySendWindow.ts` (or a
new lib module) and import it from both sides.

### F5. NIT - CONFIRMED - the annotate-after API for retry lineage is now dead but still open

Where: `app/src/repos/messagesRepo.ts:1230-1231` (`MessageAnnotations.retryOf`,
`retryAttempt`) and the two SET branches in `annotateMessage` at `:3011-3018`.
After this branch no production code calls them (the job stamps lineage at
append; only `app/test/messaging.integration.test.ts:196-210` exercises them).

Consequence: an open door back to the exact annotate-after race this change
removed (a fast 30003 reading a retry row before its `retry_attempt` lands).

Fix direction: delete both fields and branches (and the test lines), leaving
`retryDueAt` for the withdrawal.

### F6. NIT - CONFIRMED - `retry_window_closed` lives in four unpinned copies, and the claim's union is not derived from the job's

Where: the claim's own literal union `RelayRetryGateCode | 'retry_window_closed'`
(`twilio.ts:415`, `:2859`); the job's `RelayRetryCloseCode`
(`app/src/jobs/relayRetryLeg.ts:106-110`); the dashboard's `WINDOW_CLOSED_CODE`
(`dashboard/src/routes/contact/relayRetryJoin.ts:103`); and
`INTERNAL_CODE_REASONS` (`dashboard/src/routes/contact/deliveryStatus.ts:956`).

Consequence: renaming the job's member compiles while the claim keeps writing the
old string, and a dashboard drift would render "Not retried - message too old"
where the ruling wants the plain 30003 - with no test able to see it. The branch
pins the grace constant across the same boundary
(`retryPromiseMirror.test.ts`) but not this code.

Fix direction: type the claim's decline as an `Extract<RelayRetryCloseCode, ...>`
(or export one const from lib) and add a dashboard mirror test like
`retryPromiseMirror.test.ts`.

### F7. NIT - CONFIRMED - the relay claim reads the same conversation twice on a member-originated rung 1

Where: `composeRelayLegCopy` reads the roster (`twilio.ts:2821` -> `:634`) and step
7a reads the conversation again (`twilio.ts:2839`), a few milliseconds apart.

Consequence: one extra DynamoDB read on every relay 30003 claim of a member's
message, one more way to reach `claim_failed` (ERROR + 5xx), and the leg copy's
sender name and the gate's roster can come from different snapshots. Harmless
today.

Fix direction: read the conversation once in the claim and hand it to both.

### F8. NIT - CONFIRMED - a redelivered callback for a window-declined relay leg logs `retryClaim: 'already_claimed'`

Where: `twilio.ts:2964-2972` answers every SID dedupe `already_claimed`, whether
the existing rung is open or was appended CLOSED; the union documents that value
as "a ladder is (or already was) running" (`app/src/lib/relayRetryClaim.ts:44`).

Consequence: an operator correlating a Twilio redelivery of a leg whose rung was
declined at claim time sees a WARN saying a ladder is running when none ever ran
(the first callback's ERROR `window_closed` line was correct). Diagnostics only.

Fix direction: document the ambiguity in the union, or have the dedupe branch
read the existing rung's slot (consistent read) and report its close code.

### F9. NIT - CONFIRMED - the server-clock estimate keeps the LAST sample, not the least-lagged one

Where: `dashboard/src/api/serverClock.ts:37-42` overwrites the offset on every
response (`dashboard/src/api/client.ts:125`).

Scenario: a response whose fetch resolves long after the server stamped it (a
laptop that slept with a request in flight, a stalled proxy) sets an offset lagged
by that delay. The error is in the safe direction (the promise shows longer,
Retry stays hidden longer) and the next API response heals it - but the contact
page makes no periodic request while a promise is live (the ticker "fetches
NOTHING", `Timeline.tsx:2212-2217`), so one bad sample can stand for the life of
the promise.

Fix direction: keep the maximum of recent `serverMs - receivedAtMs` samples (every
sample lags, so the max is the best estimate), or reject a sample that moves the
offset backward by more than a few seconds.

### F10. NIT - PLAUSIBLE - deploy-time mixed versions

Reasoned, not reproduced:
- A dashboard tab loaded before the deploy keeps the OLD copy ("will retry" on
  every 30003) and the Retry button; a press during a live promise gets 409
  `retry_pending`, which the old `sendFailureMessage` renders as the generic
  "Couldn't send - please try again." (the new case is `Timeline.tsx:134-135`) -
  inviting repeated presses until the tab reloads. No double send.
- Retries scheduled by the OLD webhook in the minutes before the deploy carry no
  `retry_due_at`, so the NEW screen offers Retry during their backoff and a
  press double-sends - the pre-branch behavior, for at most one backoff after the
  deploy.

Fix direction: a line in the deploy notes; optionally a version-mismatch reload
prompt.

## 3. Swept and clean

Each touched field/route/job/type/copy, every other writer and reader I found
(grep over app/, dashboard/, e2e/, scripts/, fake-twilio/, infra/), and why it
still holds.

State written by this branch
- `retry_due_at`. Writers: `updateDeliveryStatus` options (messagesRepo.ts:2643-
  2660), only caller twilio.ts:3442-3447; withdrawal annotate twilio.ts:3619.
  Every other `updateDeliveryStatus` caller passes no options, so never stamps:
  groupReceipts.ts:354, emailEvents.ts:177/182, relayQueuedMessages.ts:89,
  sendEmailMessage.ts:477/510. The conditional write's allowed priors
  (messagesRepo.ts:133-142: `failed`/`undelivered` only from `queued`/`sent`)
  make the stamp once-only. Readers: api.ts:1605 guard; contactTimeline.ts:452
  projection; Timeline.tsx:791-795 (chip, button, ticker); raw rows via GET
  /conversations/:id/messages (e2e spec reads them); dropped by the fixed lists in
  useRelayThread.ts:69-140 (relay and group views - correct, they never promise)
  and buildTimelineFallback (F3).
- `retry_window_start`. Writer: append (messagesRepo.ts:2341) via sendMessage.ts:
  492, fed only by retrySend.ts:321; the manual route never passes it
  (api.ts:1672-1684, pinned by apiRoutes.test.ts). Readers: decision :125, job
  :231.
- `retry_attempt`. Writer: append :2340 via retrySend.ts:320 (dead annotate path,
  F5). Readers: decision :119, the cap log at twilio.ts:3554. The cap bounds every
  chain at 3; a manual Retry starts a fresh chain by design.
- `retry_of`. Writers: sendMessage for the manual route (api.ts:1681) and the job
  (retrySend.ts:319) - both at append now. Readers: contactTimeline.ts:449;
  Timeline.tsx:2061-2070 supersede set (incoming items win the merge,
  dashboard/src/routes/shared/threadPaging.ts:54-62, so a refetch replaces a stale
  copy); useRelayThread.ts:101/124.
- `automated`. Writer: sendMessage.ts:496 on every row. All ten call sites pass
  an explicit flag: api.ts:1437 and :1677 (false), broadcastFanOut.ts:468
  (`!staffShare`), placementNudges.ts:676/860, tourReminders.ts:1440/2004,
  missedCallAutoText.ts:242, public.ts:300, retrySend.ts:316. Readers: decision
  :113 and job :316 (absent = automated, matching pre-deploy rows). No GSI, no
  other reader; groupSend.ts:706 is an audit payload, not the row.
- `recipient_contact_id`. Writer: sendMessage.ts:497, fed by broadcastFanOut.ts:
  471, retrySend.ts:318, api.ts:1683. Readers: decision :98-101, job :185-196
  (read BEFORE the marker, so a throw redelivers - pinned), api.ts:1615-1625.
  `contacts.getById` returns soft-deleted rows (contactsRepo.ts:777-784), so the
  deleted gate still fires; only a missing row falls back to the phone lookup,
  identically in all three readers.
- `relay_retry_window_start`. Writer: the claim append (twilio.ts:2957-2959).
  Readers: the claim for rungs 2-3 (:2857) and the job (relayRetryLeg.ts:322,
  :583). Not projected by the dashboard (fixed list); a rung claimed before the
  deploy has none and runs unwindowed with a WARN (pinned).
- A claim-time CLOSED rung: same slot shape the job's `refuseGate` leaves
  (versioned: `excluded` + failed + code; legacy: whole-slot failed + code),
  verified against `applyRecipientSendResult` (messagesRepo.ts:3480-3620) and
  `markRecipient`; `append`'s shape check accepts it (messagesRepo.ts:954-1005);
  row-level `delivery_status: queued` is the same shape job-refused rungs already
  had; D20 hides the row and the join reads it as terminal (relayRetryJoin.ts:
  90-94, :421-428).

Routes
- POST /api/conversations/:id/messages/:sid/retry: still behind requireAuth and
  `manualSendLimiter`; guard order not_found -> not_outbound -> email -> not_failed
  -> retry_pending (api.ts:1572-1608); no new user input reaches a query.
- GET /api/contacts/:id/timeline: one extra projected field; 1:1 threads only.
- POST /webhooks/twilio/status: the decision runs only for failed/undelivered +
  30003 (a 30003 on any other status now decides nothing - previously the arm
  enqueued on ANY transitioned 30003); every side effect stays gated on the
  transition; the 30005/30006/21610 arms changed comments only.
- ConversationDetail redirects a plain 1:1 to the contact page, and only
  ContactCommsPane passes `onRetry` (ContactCommsPane.tsx:304-308, :338), so the
  contact timeline is the one Retry surface.

Jobs and other senders
- relay.fanOut: the only other `sendOneRelayLeg` caller (relayFanOut.ts:1140-1160)
  passes no `sendDeadlineMs` and reacts only to `transient`/`sent`, so
  `deadline_exceeded` is unreachable there; its unbounded acquire is unchanged
  (relayFanOut.ts:1387-1390, pinned by relayFanOut.test.ts).
- Other resend or scheduled-send paths - broadcast fan-out, missed-call text,
  tour reminders, placement nudges, the public welcome text, the relay
  queued-message flush, relay announcements - carry no retry lineage and are not
  retries of a failed delivery; untouched.
- Token bucket `timeoutMs: 0` (deadline already passed) throws Busy before any
  draw (tokenBucket.ts acquire), which the unit maps to `deadline_exceeded`
  before presign, the `attempted` write or the provider call.
- The relay transient close after a transient pass: slot `queued`+20429 ->
  `failed`+`retry_window_closed` advances under both write modes; `refuseGate` on a
  pass-2 `attempted` slot takes the documented conflict-acceptable path.

Union types
- `RelayLegSendOutcome.kind` (+`deadline_exceeded`): consumers relayFanOut.ts:1159-
  1160 and relayRetryLeg.ts:654-800 only.
- `RelayRetryClaimOutcome` (+`window_closed`, `gate_refused` now claim-side):
  consumers `isTerminalRelayLegFailure` (twilio.ts:466-479), the anomaly message
  map (:395-402), the marker (:3249). Infra metric filters key on `level` or
  `event`, never on `retryClaim` (infra/modules/observability/main.tf:56, :95), so
  no filter moves.
- `RelayRetryCloseCode` (+`retry_window_closed`): dashboard handles it (F6 on the
  pin).
- `SendMessageInput` / `NewMessage` / `MessageItem` additions: optional; all
  implementers of `MessagesRepo.updateDeliveryStatus` stay type-compatible; the
  harness fake mirrors the real one and is pinned
  (twilioWebhookHarnessRetryFields.test.ts).

Dashboard
- Every `deliveryReason` caller: only the one-to-one chip passes `retryScheduled`
  (Timeline.tsx:1054); legs/rollups (Timeline.tsx:622, :1363; deliveryStatus.ts:
  469, :732, :762), the email card (Timeline.tsx:1725) and the property-send row
  (broadcastFormat.ts:158) read the plain copy; `relay` wins over
  `retryScheduled` (deliveryStatus.ts:1032-1038).
- `requestWithStatus` change (client.ts:125): runs on every response before the
  body parse; `Date` is readable on these same-origin fetches; /api/* is
  CachingDisabled at CloudFront (infra/modules/cloudfront/main.tf:166); the only
  `max-age` routes are recordings and media (api.ts:2339, :2435;
  unitMediaServe.ts:31), which are element sources; `public/sw.js` has no fetch
  listener. Estimate error is lag-only (F9 on robustness).
- Ticker clause 7: terminates because the snapshot advances with real time and a
  promise past its grace is never live again; the snapshot is shared by the
  chip, the button and the arming memo (Timeline.tsx:2198-2206).
- The native group-text carve-out: group rows reach the Timeline only through
  useRelayThread's fixed list, which drops `retry_due_at`, so a fail-open stamp on
  a group row can never promise.

Logs, alarms, PII
- New ERROR lines (one-to-one window close at webhook and job; relay claim window
  marker; relay job window, deadline and transient-reschedule closes; "promise NOT
  withdrawn") all feed ErrorLogs; one ERROR per incident, no double-count found.
  The one-to-one `delivery_failed` marker stays WARN for every 30003, so the
  DeliveryFailures count is unchanged for 1:1.
- New log fields are IDs, codes, attempts, ISO times; relay member keys go through
  `logSafeStoredRelayMemberKey`/`logSafeMemberKey`; no body or phone in any new
  line. `readError` goes out under `err` (the safe serializer).
- ASCII: every added line in app/, dashboard/, e2e/, scripts/, docs/issues/ is
  ASCII (scripted scan of the diff).

E2E lane
- `E2E_SEND_RETRY_BACKOFF_MS=10000` (scripts/e2e-session.mjs:282) affects only
  one-to-one 30003 retries, ignored when `JOBS_QUEUE_URL` is set (retrySend.ts:
  106-113, pinned). Only one-to-one-30003-retry.spec.ts arms a one-to-one 30003;
  fake-twilio has no default failure profile (arming only, engine.ts), so no
  other spec's timeline changes. relay-30003-retry.spec.ts changed comments only.

## 4. Open questions I could not settle

- Q1. ErrorLogs burst alarm (5 errors in 5 minutes,
  infra/modules/observability/main.tf:150-158) vs late carrier 30003s: a batch of
  handsets that were off (the carrier reports 30003 when its own validity period
  ends, possibly hours later) now produces one ERROR `window_closed` line per
  message instead of a WARN plus a late re-send. A broadcast to a few such numbers
  can page. Intended by the severity ruling, but the threshold was not revisited.
- Q2. The property-send results row for a 30003 recipient never learns the
  outcome of the automatic retry (the retry row carries no `broadcast_id`, and
  `rollIntoBroadcast` matches on the original's tsMsgId). Pre-existing, but with
  "will retry" removed a retry that DELIVERED now reads as a bare "Failed - Phone
  unreachable (error 30003)". The test comment defers this to share-skip-fix
  Branch B; worth confirming that is tracked.
- Q3. The relay `claim_failed` recovery relies on Twilio redelivering a 5xx'd
  status callback. The claim now performs three more reads before its append
  (conversation, contact, participant-phone GSI), each a new way to reach
  `claim_failed`. I could not verify Twilio's redelivery default for Messaging
  status callbacks from the repo.
- Q4. Should the one-to-one job refuse to send once the promise it was scheduled
  under has EXPIRED (not only when withdrawn, F1)? That closes filed gap 1 at the
  cost of dropping a retry that runs more than two minutes late - which the screen
  has already stopped promising. A product call against "attempt rather than risk
  a text never delivered".
- Q5. The one-to-one origin is Twilio's `dateCreated` (the moment Twilio accepted
  the send). A text that sat in the Messaging Service queue and then failed is
  measured from acceptance, not from when it left Twilio. Probably right for
  paced app traffic; not verifiable without spec access.
