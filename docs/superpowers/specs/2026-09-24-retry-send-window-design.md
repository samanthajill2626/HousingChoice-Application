# Retry send window - design

Date: 2026-09-24. Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`,
cut from `main` @`685f2ede`. Status: DRAFT 3 - after adversarial review rounds 1
and 2 (`docs/superpowers/reviews/2026-09-24-retry-send-window/`).

| sev | issue | this branch |
| --- | --- | --- |
| low | `group-text-30003-leg-retry-promise-unverified` | **closes** |
| - | (unfiled) a late 30003 re-sends hours- or days-old content | **closes** - the ruling itself |
| - | (unfiled) on manual-mode threads the screen promises a retry that is always refused | **closes** |
| - | (unfiled) a manual Retry during an automatic retry's wait texts the member twice | **narrows**; the rest is filed as `manual-retry-double-send-residual-windows` (new, low) |
| low | `relay-retry-send-throttle-past-window` | **new** - a residual of this branch |
| low | `quiet-hours-ungated-automated-paths`, item 3 | annotate: automatic retries now end 15 minutes after the send |
| low | `relay-retry-stranded-claim-window` | unaffected |

This document states DECISIONS and INVARIANTS. Mechanics - control flow, where a
line goes, test code - belong to the plan. Records for this mission, including the
research that shaped it, are in `docs/superpowers/reviews/2026-09-24-retry-send-window/`.

## 0. The rulings this implements

Recorded in `docs/superpowers/reviews/2026-09-24-retry-send-window/rulings.md`.
Cameron's ruling on relay-30003 open question Q4, as recorded on `main`
@`cd8e8ddd`: "nothing re-sends a text more than 15 minutes after the original
went out ... A declined retry shows as a plain failed attempt. Alarm thresholds
unchanged." His brainstorm answers of the same day: the window measures when a
retry GOES OUT, not when the failure arrives; the number was left to the planner
(15 chosen); the manual Retry button is hidden while an automatic retry is
scheduled and the server refuses a manual retry during that wait; native group
text is in scope.

## 1. The invariant

**No automatic retry of a carrier-30003 failure is handed to the send path more
than 15 minutes after the original message went out. The screen promises a retry
only after one has actually been scheduled, and stops promising it within
`RETRY_PROMISE_GRACE_MS` plus one ticker interval after it was due, on a browser
clock within D8's skew bound.**

"Automatic retry" means the two machine-initiated resend paths: the relay (masked
group) retry ladder and the one-to-one `messaging.retrySend` chain. A staff member
pressing Retry is a new human send; the window never limits it, and it starts a
window of its own. The one allowance: after its last gate, a relay send can wait
on the send path's own throttle (section 9).

## 2. What exists today

- **Relay ladder.** A 30003 status callback on a relay leg claims a retry in the
  webhook (`app/src/routes/webhooks/twilio.ts:2678-2907`) and schedules
  `relay.retryLeg` 60, 120 or 240 seconds later (`app/src/lib/relayRetryClaim.ts:13-18`,
  `app/src/jobs/relayRetryLeg.ts:214-234`), at most three rungs. Neither the claim
  nor the job looks at how old the message is.
- **One-to-one chain.** The webhook's 30003 arm (`twilio.ts:3350-3369`) enqueues
  `messaging.retrySend` on the same backoff, capped at three
  (`app/src/jobs/retrySend.ts:36-42`). No age check either.
- **Why age matters.** Carriers hold a text for a powered-off phone for 24-72 hours
  (Verizon: up to 5 days) and may then give up. A late 30003 today re-sends
  hours- or days-old content, out of context in the thread.
- **Manual-mode threads.** Every automated send is refused when a conversation is
  in manual mode (`app/src/services/sendMessage.ts:348-349`), including the
  automatic retry; the job logs WARN and stops (`retrySend.ts:209-216`). The Quo
  import writes `ai_mode = manual` on every conversation it creates
  (`app/src/lib/import/apply.ts:1093`, `:1107`), and the breaker also switches a
  conversation to manual (`sendMessage.ts:352`). On those threads the arm still
  enqueues a retry that is certain to be refused.
- **The promise.** The one-to-one reason reads "Phone unreachable - will retry
  (error 30003)" for EVERY 30003, keyed by the code alone
  (`dashboard/src/routes/contact/deliveryStatus.ts:778`, with the template's tail):
  false after the third retry fails, false on manual-mode threads, and false for
  native group texts, where no retry exists. On the broadcast result badge
  (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`) it reflects that a
  broadcast recipient's 30003 IS retried, but the badge never learns the outcome.
- **The double send.** The manual Retry button shows on any failed one-to-one
  bubble (`dashboard/src/routes/contact/Timeline.tsx:1341`), including during an
  automatic retry's wait, and the retry route checks only that the message failed
  (`app/src/routes/api.ts:1592`). Pressing it mid-wait texts the member twice.
- **Lineage after the send.** The one-to-one retry job annotates `retry_of` and
  `retry_attempt` AFTER the send (`retrySend.ts:221-229`), an accepted race: a
  fast 30003 on the retry can read no `retry_attempt` and reset the cap.

## 3. Decisions

**D1. The window.** `RETRY_SEND_WINDOW_MS` = 15 minutes (Cameron left the number
to the planner; 15 is the same span as the dashboard's existing "not confirmed"
clock, `STALE_SENT_AFTER_MS`). A normal ladder - first failure within a minute,
then waits of 1, 2 and 4 minutes - finishes by about minute 8, so the window cuts
off only failures that arrive late.

**D2. The origin - what "the original went out" means.**
- One-to-one: the original message's provider timestamp (`provider_ts`: Twilio's
  dateCreated for the send, also the prefix of its `tsMsgId`,
  `app/src/adapters/messaging.ts:745`). `retry_of` points only at the previous
  attempt, so every automatic retry row records `retry_window_start` = the chain's
  origin, and attempts 2 and 3 still measure from the first send.
- Relay: the member's ORIGINAL leg send time - the member slot's `sentAt` (Twilio's
  dateCreated, `app/src/jobs/relayFanOut.ts:1457`). NOT the root row's timestamp:
  that is receipt or compose time, and for a message held while a group connects
  it can precede the real send by a long time (`app/src/routes/api.ts:1710`).
  Carried forward on every retry row as `relay_retry_window_start`. A retry row
  WITHOUT it (claimed before this deploy) is never re-derived from its own slot -
  that would restart the window; D5 applies instead.
- A manual Retry never copies `retry_window_start`: a human chose to send now.

**D3. Relay: check when claiming, with the grace.** Before claiming rung N,
compute when it would send (now plus rung N's resolved backoff). If
`send time + RETRY_JOB_GRACE_MS > origin + RETRY_SEND_WINDOW_MS` (grace = 60
seconds, absorbing queue delay), the rung is not claimed. That decision sits after
the cap check and before the claim's append (`twilio.ts`, between 2763 and 2781),
and resolves in this order:
1. **Already claimed?** A strongly consistent read of the rung's deterministic
   `sid#` pointer (`relayRetryProviderSid`, `relayRetryClaim.ts:33-35`; the
   repository exposes its consistent pointer read, `messagesRepo.ts:1960-1974`).
   If the rung exists, the outcome is `already_claimed` (WARN): a duplicate
   callback near the edge must not log a false dead end.
2. **A human-action gate the claim can already see?** The claim reads the roster
   (`twilio.ts:2780`). If the group is closed or the member is no longer on it,
   log WARN with that reason - Cameron's Q1 ruling for those refusals - and claim
   nothing.
3. **Otherwise** the new outcome `window_closed`, ERROR (D9).
Every branch leaves the member's slot exactly as `cap_exhausted` does: terminal on
30003, no new retry row, no enqueue, no claim SSE.

**D3a. One-to-one: the arm schedules only a retry that can run.** In order:
1. A `group_text` conversation never schedules (D11); WARN.
2. If an automated send to this conversation would be refused right now - the
   kill switch, an opt-out, or manual mode, previewed with the existing
   `evaluateScheduledSendSuppression` (`app/src/services/scheduledSendSuppression.ts:52-68`)
   - schedule nothing, stamp nothing, and log WARN (the job's refusal level today).
   The bubble shows the plain failure with a live Retry button: on manual-mode
   threads this keeps today's only working retry path.
3. The existing cap: exhausted retries log ERROR, as today.
4. The window: schedule only if `now + backoff + RETRY_JOB_GRACE_MS <=
   origin + RETRY_SEND_WINDOW_MS`; otherwise log ERROR (D9) and schedule nothing.
5. Otherwise enqueue, then stamp and emit (D7).
**Failure semantics:** these reads are new - today the arm reads nothing before
enqueueing (`twilio.ts:3353-3368`), runs only on the status transition (`:3343`),
and swallows errors (`:3524-3528`). So a failed conversation or contact read, or a
missing or unparseable origin, FAILS OPEN: log WARN and schedule as today. That is
safe because the job's `sendMessage` re-applies the kill switch, opt-out, manual
mode and the `group_text` refusal at send time (`sendMessage.ts:286-300`,
`:307-318`, `:348-349`). The breaker and a soft-deleted contact are not previewable
(the preview omits them by design); a retry refused for those at send time is a
section 9 residual.

**D4. Check again right before sending.** The job checks
`now <= origin + RETRY_SEND_WINDOW_MS`, strictly (the grace was spent at
scheduling).
- Relay job: the check is the LAST gate before the send (after the opt-out gate)
  and closes the rung with a new close code, `retry_window_closed`, through the
  pre-send refusal path (`refuseGate`). The transient re-enqueue
  (`relayRetryLeg.ts:643-646`) re-checks and closes instead of re-enqueueing once
  past the window.
- One-to-one job: checks before `sendMessage` and ends the chain without sending.

**D5. A missing or unparseable origin fails open.** A relay slot with no
`sentAt`, a retry row without `relay_retry_window_start` (claimed before this
deploy), or an origin that does not parse skips the window check and logs a WARN
naming the gap. The new relay field is OPTIONAL in the job's lineage check: that
check throws after the execution marker is set, so a required field would silently
drop every rung claimed before the deploy. A one-to-one row with no
`retry_window_start` uses its own `provider_ts`.

**D6. Lineage is written with the row.** The one-to-one retry job passes
`retry_of`, `retry_attempt` and `retry_window_start` into the send, so they are
written when the row is appended (the `sendMessage` input and append path,
`app/src/services/sendMessage.ts:193-241`, `:398-428` ->
`app/src/repos/messagesRepo.ts:2265`), not annotated afterwards. This closes the
race in section 2, which now matters more: a lost origin would restart the window.

**D7. "A retry is scheduled" is recorded and pushed.** When the one-to-one arm
enqueues a retry successfully, it stamps the FAILED message with `retry_due_at` =
the retry's run time, by extending `annotateMessage`'s `MessageAnnotations`
(`messagesRepo.ts:1173-1177`), and then emits `message.persisted` for that message.
The transition's own emit (`twilio.ts:3291-3301`) fires before the arm runs, so
without a second emit an open screen would learn of the stamp only by luck. Order:
enqueue, stamp, emit - a stamp followed by a failed enqueue would promise a retry
that never comes, and `annotateMessage` cannot remove a stamp. The cost of that
order is the lost-stamp case: if the stamp write fails, the retry still runs with
no promise and no guard (section 9). The stamp reaches the dashboard through the
contact-timeline projection (`app/src/routes/contactTimeline.ts:406-463`) and the
dashboard type (`dashboard/src/api/types.ts:2479`).

**D8. What the screen says.**
- **The rule, for the one-to-one bubble and the share results row:** a 30003
  promises a retry ONLY while the failed message carries a live `retry_due_at`,
  never from the retry count. After this branch a 30003 declined by the window or
  by D3a still has "retries remaining" by count while no retry is scheduled. The
  relay promise is not covered by this rule: it stays governed by its live rung
  (`dashboard/src/routes/contact/relayRetryJoin.ts:370-377`).
- **The reason API:** `deliveryReason` gains a `retryScheduled` option. With it and
  code 30003, the reason is "Phone unreachable - will retry", checked AHEAD of the
  media, relay and base maps, so an MMS one-to-one bubble with a live stamp still
  promises. Without it, the base 30003 reason is "Phone unreachable". The
  template's `(error 30003)` tail is appended as today in both cases.
- **The relay map's 30003 entry** becomes identical to the base and is removed as
  redundant; its order test (`deliveryStatus.test.ts:761-767`) is rewritten to pin
  "no promise without `retryScheduled`".
- The base wording is what shows on native group-text legs, rollups and message
  rows, and on a one-to-one bubble whose retries ran out, was declined, or sits on
  a manual-mode thread.
- **A one-to-one bubble's promise is live** only while both hold: the bubble clock
  is before `retry_due_at + RETRY_PROMISE_GRACE_MS` (2 minutes), AND `retry_due_at`
  is no further ahead of the bubble clock than the longest backoff plus the grace
  (240 + 120 seconds). A due time further ahead than any real schedule means the
  browser clock is behind, and the promise is treated as not live - plain failure,
  Retry button shown (the server's 409 still guards).
- The promise expires on screen without a reload: a one-to-one bubble with a live
  promise joins the Timeline's existing ticker (today one-to-one bubbles never
  tick, `Timeline.tsx:859-899`, pinned by `Timeline.ticker.test.tsx:412-418`).
  Expiry lands within the ticker's 60 seconds.
- **The share results row** (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`)
  reads only the broadcast slot, which has no `retry_due_at`. On this branch alone,
  the base wording therefore removes that row's promise even while a retry IS
  scheduled - under-promising, never false. Reading `retry_due_at` from the failed
  message belongs to `feat/share-skip-fix`'s results path, which already reads that
  message (section 5). The row's copy table is that branch's.
- New and touched copy is ASCII (the current string's em dash becomes a hyphen).
- **Relay, per the ruling - every declined retry shows as a plain failed attempt.**
  At rung 1 a claim-time decline leaves no rung, and the leg reads "Phone
  unreachable (error 30003)". At rungs 2 and 3 the leg goes terminal through the
  join, as at `cap_exhausted`. A job-time decline closes the rung with
  `retry_window_closed` (kept for data and logs), and the join's terminal step
  treats that code as carrying NO display code, so the original's 30003 stands
  (`relayRetryJoin.ts:405-415`). The leg reads "Phone unreachable (error 30003)",
  the same words as a claim-time decline. There is no `INTERNAL_CODE_REASONS` entry
  for it: that map's no-tail rule (`deliveryStatus.ts:878-882`) stands.

**D9. Logging.** A window decline where no human-action gate applies is a dead
end - the member never got the text - so it logs one ERROR, like `cap_exhausted`
and the exhausted-retries line today:
- relay claim: the `window_closed` outcome, ERROR through
  `isTerminalRelayLegFailure` (not in its WARN set);
- relay job: the `retry_window_closed` close, ERROR;
- one-to-one arm and job: one ERROR line each, naming `window_closed`.
WARN, not ERROR: a D3a skip, a relay claim that finds a closed group or a removed
member (D3), `already_claimed`, and a missing or unparseable origin or failed read
(D3a, D5). The per-callback `delivery_failed` marker and every alarm threshold are
unchanged.

**D10. The manual Retry guard** (Cameron's option 1, `rulings.md`).
- Screen: the Retry button is hidden while the one-to-one promise is live (D8).
- Server: the retry route refuses with 409 `retry_pending` while
  `retry_due_at + RETRY_PROMISE_GRACE_MS` is in the future on the server's clock
  (after its not-failed check, `api.ts:1592-1595`). The dashboard maps
  `retry_pending` to "A retry is already scheduled for this message." (every
  unmapped 409 reads the generic "Couldn't send" today, `Timeline.tsx:86-131`).
- `RETRY_PROMISE_GRACE_MS` is one value, mirrored in the dashboard and pinned by a
  test (the media-type mirror precedent,
  `dashboard/src/routes/contact/mediaTypeMirror.test.ts`).
- Nothing else. The guard is time-based; section 9 and
  `manual-retry-double-send-residual-windows` name what it leaves.

**D11. Native group text.** No retry exists for a native group text. The one-to-one
arm refuses to schedule one UNCONDITIONALLY for a `group_text` conversation (the
conversation is read anyway for D3a), logging WARN. Whether a classic callback
can reach that arm for a group text is live Twilio behavior no build can settle:
the repo asserts both sides (`app/src/services/groupReceipts.ts:3-10` against
`twilio.ts:3422-3429`, `:3477-3479`), and a synthetic test drives the arm with a
group row (`app/test/twilioStatusWebhook.test.ts:1420-1463`). The false promise on
screen is copy: D8's base wording removes it from the leg, the rollup and the
message row. The tests that pin the carve-out (`deliveryStatus.test.ts:419` and
`:738`, `Timeline.delivery.test.tsx:516` and `:577`) are INVERTED, not deleted.

**D12. Comments that now lie are corrected.**
- `deliveryStatus.ts:824-858`: the "NO RELAY RETRY EXISTS" rationale, written
  before the relay ladder, and "the 1:1 entry above stays byte-for-byte ... a 1:1
  30003 retry genuinely does send" (the relay map entry itself goes, D8).
- `twilio.ts:316-341` (the 30003 carve-out rationale, "the one path where the
  promise holds"), and `:3422-3429` and `:3477-3479` (native group texts "ARE
  REACHABLE HERE"), reworded to D11's position.
- `Timeline.tsx:973-979` and `:1272-1275` (the group-text "retry is real" notes).
- D6 makes these false: `sendMessage.ts:234-240`, `messagesRepo.ts:725-731` and
  `:2262-2265`, `retrySend.ts:9-10` and `:221-225`.
- Test and doc comments: `deliveryStatus.test.ts:721-737`,
  `Timeline.delivery.test.tsx:460-465`, `:509-515`, `:570-576`,
  `StatChips.test.tsx:120-127`, `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-22`,
  `e2e/support/selectors.md:49`.

**D13. Test seams and fixtures.**
- Unit tests inject the clock.
- A one-to-one retry backoff lane seam, `E2E_SEND_RETRY_BACKOFF_MS`, honored only
  when `JOBS_QUEUE_URL` is unset (the relay's `E2E_RELAY_RETRY_BACKOFF_MS` guard,
  `relayRetryLeg.ts:190-196`), set in the lane's `childEnv`
  (`scripts/e2e-session.mjs:254-272`). `feat/share-skip-fix` plans the same seam;
  whichever lands first builds it and the other reuses it.
- If an e2e needs a short window, `E2E_RETRY_SEND_WINDOW_MS` has the same guard,
  and its lane value must exceed the longest lane rung backoff plus
  `RETRY_JOB_GRACE_MS`, with margin, in BOTH lanes - otherwise it declines every
  rung.
- Fixtures: one-to-one fixtures with fixed past `provider_ts`
  (`app/test/twilioStatusWebhook.test.ts:59`) move to realistic times. Relay
  fixtures without a slot `sentAt` (`app/test/relayRetryClaim.webhook.test.ts:157-161`,
  `:174-178`) pass through D5 unchanged; the relay window tests need NEW fixtures
  with a slot `sentAt`.

## 4. Every surface the plan must cover

The plan enumerates each as a task or a watch item (research sweep plus review
rounds 1 and 2):

- **Writers of automatic retries:** relay claim and enqueue (`twilio.ts:2781`,
  `:2842`); relay send and transient re-enqueue (`relayRetryLeg.ts:575`,
  `:643-646`); one-to-one enqueue (`twilio.ts:3364`); one-to-one send and lineage
  (`retrySend.ts:200-229`), through the `sendMessage` input and append path
  (`sendMessage.ts:193-241`, `:398-428`); handler registration
  (`app/src/jobs/registerHandlers.ts:47`, `:60`); the lane backoff overrides
  (`scripts/e2e-session.mjs:254-272`, the relay one and the new one-to-one one).
  Manual: the route's checks and append (`api.ts:1571-1595`, `:1651`).
- **Where the new checks land:** the relay claim (`twilio.ts:2763-2781`), the relay
  job's gates (`relayRetryLeg.ts:491-555`), the one-to-one arm (`twilio.ts:3350-3369`),
  the one-to-one job's read of the original (`retrySend.ts:112-120`).
- **Readers of retry lineage:** server `twilio.ts:2757`, `:2761`, `:2776`, `:2825`,
  `:3129`, `:3353`; `relayRetryLeg.ts:268-292`, `:372`; `messagesRepo.ts:2265-2284`,
  `:2335`, `:2912-2918`; `contactTimeline.ts:442`. Dashboard `types.ts:2308-2315`,
  `:2494`, `:2509-2515`; `useRelayThread.ts:101-142`; `relayRetryJoin.ts:135-164`,
  `:405-415` (the terminal step, which learns `retry_window_closed`), `:453`;
  `Timeline.tsx:885`, `:1077`, `:1975-1984`, `:2004-2019`.
- **Readers of the 30003 copy:** `deliveryStatus.ts:778` and `:859-861` (the relay
  map entry, removed) via the Timeline chip, reason, rollup, row and spoken
  summary; EmailCard; `DeliveryBadge.tsx:31`; StatChips. Tests: those in D11, plus
  `deliveryStatus.test.ts:761-767`, `StatChips.test.tsx:129`,
  `Timeline.email.test.tsx:114`, `Timeline.delivery.test.tsx:528-536` and `:593`.
- **Vocabulary:** the `RelayRetryCloseCode` union (`relayRetryLeg.ts:91-97`) and its
  gate-case table (`app/test/relayRetryLeg.test.ts:307` onward) gain
  `retry_window_closed`; the `RelayRetryClaimOutcome` union's exhaustive test
  (`app/test/relayRetryClaim.test.ts:51-88`) moves from thirteen values to
  fourteen; the internal-code copy test (`deliveryStatus.test.ts:1648-1668`) does
  NOT gain it (D8); `e2e/support/selectors.md:49` documents the prose family.
- **Test doubles:** the harness copy of `annotateMessage`
  (`app/test/helpers/twilioWebhookHarness.ts:1338`) and the harness fake `append`,
  an explicit field allowlist (`:1081-1152`) that would silently drop the new
  append-time fields and let a "carried origin" test pass vacuously through D5.
- **Seeds and dev seams:** none write retry fields today (research sweep); the
  plan confirms none are added.

## 5. Concurrent work

Both branches below are at the spec stage in other sessions and keep moving; the
plan re-reads them before it is written. The couplings are stated as requirements
on ANY path, so they hold whatever those branches' mechanics become. Whichever
branch lands second carries each one.

- **`feat/share-skip-fix`** (v5 @`3a6a1a06`, at its human gate):
  - It edits the same one-to-one retry send call (`retrySend.ts:200-207`) and the
    same retry route (`api.ts:1564-1661`): both retries will carry the share, so
    `retrySend.ts` and `api.ts` merge textually with D6 and D10.
  - Copy on the share results row: its table keeps "Phone unreachable - will
    retry" for "30003 with retries remaining" and adds "Phone unreachable -
    retries exhausted". "Retries remaining" by count no longer means a retry is
    scheduled (D3a, the window), so its derivation follows D8's rule instead: the
    failed message's live `retry_due_at`, which its results path already reads the
    message to find. The row's wording stays that branch's.
  - It plans the same one-to-one backoff seam as D13.
  - Its lean seed gains a switched-off (manual-mode) tenant conversation for its
    e2e checks; this branch's one-to-one e2e (test intention 8) must not use it,
    because D3a skips the retry there by design.
  - Its import change creates one-to-one rows in `auto`; section 2's manual-mode
    statement then describes pre-existing rows only. D3a reads the live switch,
    so both orders hold.
  - It accepts the manual double send as today's behavior; D10 narrows it.
- **`feat/send-outcome-reconcile`** (revision 4 @`bf2c5bf2`) plans edits to
  `relayRetryLeg.ts`, `retrySend.ts`, `messagesRepo.ts`, `sendMessage.ts` and
  `deliveryStatus.ts`, and retypes `sendMessage`'s errors on the input and append
  path D6 edits. Requirements on any path it adds:
  1. A relay rung it re-drives later passes through D4's job-time check, so the
     window bounds it.
  2. Any path that appends a one-to-one retry row (its "adopt") carries
     `retry_of`, `retry_attempt` and `retry_window_start` at append (D2, D6).
  3. Any path that DEFERS a one-to-one retry, or leaves its outcome pending past
     `retry_due_at` (a deferral, or an `unknown` send outcome awaiting reconcile
     checks at about 5 seconds, 30 seconds and 4 minutes), applies D3a's window
     check to any re-schedule and keeps the promise and D10's guard up until the
     retry resolves, by refreshing `retry_due_at` to cover the pending schedule.
     Otherwise the Retry button returns while an automatic text may already be out.
  4. Its filed issue that an unresolved one-to-one retry "leaves the original's
     'will retry' copy standing" changes with D8: the copy now follows
     `retry_due_at`, so requirement 3 is what keeps it truthful.

## 6. Test intentions

1. The window helper: scheduling allowed only with the grace to spare; the job's
   strict boundary at exactly 15 minutes; an unparseable origin fails open.
2. Relay claim: a 30003 whose rung send plus grace lands after `sentAt + 15 min`
   declines with `window_closed` - ERROR, no retry row, no enqueue, slot
   unchanged; the same situation with the rung already claimed (read
   consistently) yields `already_claimed` (WARN); with the group closed or the
   member removed it logs WARN with that reason; inside the window it claims as
   today; rung 2's claim measures from the carried origin (with the harness append
   preserving the new field).
3. Relay job: past the window it closes with `retry_window_closed` - ERROR, one
   SSE for the root, no send; the join renders that leg as "Phone unreachable
   (error 30003)"; a transient pass past the window closes instead of
   re-enqueueing; a pre-deploy rung without the field still runs (WARN).
4. One-to-one arm: `group_text` schedules nothing (WARN); a manual-mode, opted-out
   or kill-switched conversation schedules nothing and stamps nothing (WARN); a
   failed conversation or contact read schedules as today (WARN); exhausted
   retries log ERROR as today; past the window it declines (ERROR, no enqueue, no
   stamp); inside it enqueues, stamps `retry_due_at` and emits; a failed enqueue
   leaves no stamp.
5. One-to-one job: past the window it ends without sending; the new retry row
   carries `retry_of`, `retry_attempt` and `retry_window_start` at append, with
   nothing annotated afterwards.
6. Manual route: 409 `retry_pending` before `retry_due_at + grace` (server clock),
   allowed after; a manual retry row has no `retry_window_start`.
7. Dashboard:
   - `deliveryReason` with `retryScheduled` and code 30003 promises, ahead of the
     media map (an MMS one-to-one 30003 still promises); without it no surface
     promises; the relay map's 30003 entry is gone and its order test pins "no
     promise without `retryScheduled`".
   - A one-to-one bubble with a live `retry_due_at` shows "Phone unreachable -
     will retry (error 30003)" and no Retry button; one without (manual mode,
     declined, exhausted) shows the plain failure and the Retry button.
   - The ticker arms while the promise is live, and the promise disappears after
     `retry_due_at + grace` without a reload.
   - Skew: a browser clock 1 minute slow still shows the promise and expires it;
     a browser clock 10 minutes slow shows no promise at all.
   - `retry_pending` maps to its message; the native group-text tests are
     inverted; the mirrored grace constant is pinned.
8. E2E, using the one-to-one backoff seam and a tenant whose conversation is not
   in manual mode: a 30003 on a one-to-one text shows "Phone unreachable - will
   retry (error 30003)" with no Retry button, then the retry's own bubble replaces
   it (no one-to-one retry spec exists today). The relay 30003 spec still passes.

## 7. For Cameron at review

- **Copy to approve:** "Phone unreachable (error 30003)" (the base 30003 wording
  everywhere, no promise), "Phone unreachable - will retry (error 30003)" (a
  one-to-one bubble while a retry is scheduled), and "A retry is already scheduled
  for this message." (a stale tab's manual Retry).
- **One rule across specs:** the share results row's "will retry" follows D8 (a
  scheduled retry), not share-skip-fix's retry count; until share-skip-fix reads
  `retry_due_at`, that row shows no promise (section 5, D8).
- **Sequencing** with `feat/share-skip-fix` and `feat/send-outcome-reconcile`
  (section 5): which lands first.

## 8. Out of scope

- A real retry for native group texts.
- Alarm thresholds (Q4's original question) and a manual retry for relay legs.
- Polling for sent-but-unconfirmed legs.
- The share results row's copy table (share-skip-fix's surface; D8 sets only the
  rule it follows).
- A conditional-claim fix for the remaining manual double-send windows
  (`manual-retry-double-send-residual-windows`).
- The relay stranded-claim window (`relay-retry-stranded-claim-window`, low).

## 9. Residuals

Each is filed, so it outlives this spec's freeze.

- **Throttle overrun** (`relay-retry-send-throttle-past-window`): the relay send
  waits on an unbounded token bucket after the job's last gate
  (`relayFanOut.ts:1360`); a long throttle could push a send past the window.
- **Late relay decline at ERROR** (same issue): a late 30003 for an opted-out
  member or one whose number changed logs `window_closed` at ERROR, because those
  gates are not visible at the claim.
- **Manual double send** (`manual-retry-double-send-residual-windows`): the guard is
  time-based. A Retry can still double-send in the second or so before the promise
  reaches the screen; for the whole wait if the `retry_due_at` stamp write fails
  (D7); after an expired promise while the automatic job is running late; from a
  stale tab on an original an automatic retry already replaced; and while a retry's
  outcome is pending, unless the path that left it pending honors section 5's
  requirement 3.
- **Refused at send time:** a retry refused for a reason D3a cannot preview (the
  breaker, a soft-deleted contact) keeps its promise until it expires.
