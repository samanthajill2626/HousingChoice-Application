# Spec review r1-a - retry send window (DRAFT 1)

Adversarial review of
`docs/superpowers/specs/2026-09-24-retry-send-window-design.md`, 2026-09-24.
Read-only. Every claim about existing behavior cites a file:line read in the
worktree `W:\tmp\retry-send-window` at `a6c4c01b` (branch cut from `685f2ede`).
The two concurrent branches were read at their HEADs at review time:
`feat/share-skip-fix` @`7ac57f31` (design v4) and `feat/send-outcome-reconcile`
@`513e0717` (revision 2). Both specs are being revised live; line numbers below
are at those commits.

Summary: no BLOCKING finding. One HIGH (the concurrent-work section misstates a
branch that now edits the same retry call, the same route and the same copy).
Four MEDIUM: the headline invariant is contradicted by the spec's own grace and
residuals; the anchor ruling is not on this branch and, as recorded on main,
contradicts D8; the promise and the Retry lockout land hardest on exactly the
threads where the retry can never run; and D10's "can never" is not delivered
by the mechanism. Six LOW.

---

## 1. [HIGH] Section 5 misstates `feat/share-skip-fix`; the two specs now make contradictory decisions on the same code and copy

**What is wrong.** Section 5 says share-skip-fix's only coupling is that "its
automation switch refuses the one-to-one automatic retry at send time
(`sendMessage.ts:349`)" and that "its edits to `twilio.ts`, `deliveryStatus.ts`
and `contactTimeline.ts` are in other regions". The share-skip-fix spec at
`7ac57f31` says otherwise:

- Both retries will CARRY THE SHARE: "the automatic 30003 retry and the staff
  Retry of a share message, which carry the share so their sent attempt is
  recorded (D5, I9)" (share-skip-fix spec, lines 404-405; I9 at line 383). That
  is an edit to the `sendMessage` call in `app/src/jobs/retrySend.ts:200-207`
  (the call this spec's D6 rewrites) and to the manual route
  `app/src/routes/api.ts:1564-1661` (the route this spec's D10 rewrites).
- It KEEPS and EXTENDS the 30003 promise on the share results row: "A 30003
  failure with retries remaining keeps the existing 'will retry' wording ...
  one whose retries are exhausted (derivable from the failed message) says so
  instead" (lines 242-245), with a reason table "30003 with retries remaining |
  Phone unreachable - will retry (existing)" and "30003 with retries exhausted |
  Phone unreachable - retries exhausted" (lines 311-312). This spec's D8 removes
  the promise from `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`, which
  is the badge `BroadcastResults.tsx:58` renders on that very row. Worse, the
  two derivations disagree on meaning: after this branch a 30003 declined by
  the window has "retries remaining" by count (`retry_attempt` < 3) while no
  retry is scheduled, so share-skip-fix's derivation would re-create the false
  promise this spec exists to remove. `retry_due_at` (D7) is the signal it
  would need, and neither spec says so.
- It adds a dev seam: "the one-to-one retry backoff (60/120/240 s) must be
  injectable for the hermetic harness" (lines 419-421). This spec's D3
  one-to-one "resolved backoff" and D13's window seam ("must stay above what
  the lane's relay retry spec needs") both ignore a one-to-one lane backoff.
  Conversely, test intention 8 (one-to-one e2e) has no backoff seam on this
  branch alone: `retryBackoffMs` is fixed at 60 s (`retrySend.ts:40-42`,
  `:73-77`), so the e2e waits 60+ seconds unless this branch builds the same
  seam.
- The premise this spec uses to call the broadcast-badge promise false - "a
  retry drops the broadcast id" (section 2, section 8) - is the thing
  share-skip-fix removes. It also overstates today: the one-to-one 30003 arm
  enqueues a retry for a broadcast recipient's message like any other
  (`app/src/routes/webhooks/twilio.ts:3350-3369` has no broadcast guard), and
  the existing test records the opposite reasoning ("a broadcast recipient's
  30003 IS retried, so the promise is true here",
  `dashboard/src/routes/broadcasts/StatChips.test.tsx:120-125`). The badge never
  learns the retry's outcome; that is not the same as "no retry".

(Timing note, for fairness: share-skip-fix v3 with these items landed at 23:24,
six minutes after this spec's commit at 23:18. The spec still has to reflect
them before a plan is written.)

**Implies.** Whichever branch lands second silently overrides an approved copy
decision of the other on the same surface, and the merge conflicts in
`retrySend.ts` and `api.ts` are not anticipated anywhere. Section 5 must drop
"other regions", name the shared call sites, and settle: who owns the 30003
wording on the share results row, whether a retry carries `broadcastId`, how
"retries remaining" is derived once a window can decline, and who owns the
one-to-one backoff seam. Extend "whichever branch lands second carries the
coupling" to share-skip-fix.

---

## 2. [MEDIUM] The invariant says 15 minutes and "only while scheduled"; the mechanism delivers neither

**What is wrong.** Section 1: "No automatic retry of a carrier-30003 failure is
sent more than 15 minutes after the original message went out, and the screen
promises a retry only while one is actually scheduled."

- First half. D1 already hedges "(plus D4's job grace)"; D4 lets the job send
  while `now <= origin + 15 min + 60 s`; section 9 adds an unbounded
  token-bucket wait after the last gate (`app/src/jobs/relayFanOut.ts:1360`).
  So the designed bound is 16 minutes plus throttle, on purpose. The ruling
  this spec implements, as recorded on main (`cd8e8ddd`,
  `founder-rulings-2026-09-24.md`, Q4 row), says "nothing re-sends a text more
  than 15 minutes after the original went out". Section 7 does not surface the
  deviation.
- Second half. D8 keeps the promise until `retry_due_at + 2 min` whether or
  not the job has already run and declined, been refused, or skipped on
  `manual_retry_at`; section 9 concedes it ("keeps its promise until it
  expires").

**Evidence.** Spec section 1, D1, D4, D8, section 9.

**Implies.** A test written to the invariant at the boundary cannot pass, and
the grace sits on the wrong side of the bound. To keep 15 minutes, apply the
grace at scheduling (schedule only if `now + backoff + grace <= origin + 15`)
and check `origin + 15` at the job - or restate the invariant as "about 16
minutes" and put the change in front of Cameron. The promise half needs the
same honesty ("while one is scheduled, and for at most 2 minutes after it was
due").

---

## 3. [MEDIUM] The anchor ruling is not on this branch, and as recorded it contradicts D8's job-time copy

**What is wrong.** The spec anchors on "Cameron's ruling on relay-30003 open
question Q4". On this branch that row reads "Open. Cameron asked when a
powered-off phone actually produces a 30003 before deciding." with
follow-through "Pending."
(`docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/founder-rulings-2026-09-24.md:13`).
The ruling was recorded later, on main only (`cd8e8ddd`), and reads: "nothing
re-sends a text more than 15 minutes after the original went out ... A
declined retry shows as a plain failed attempt."

- D8 gives a job-time relay decline its own close code with the copy "Retry
  skipped - message too old", and section 7 presents "write the original 30003
  onto the rung so both read the same" as the ALTERNATIVE. The recorded ruling
  already chose that alternative.
- D1 says "Cameron left the number open"; the recorded ruling names 15 minutes.
- Smaller: the new copy breaks its sibling family. The four existing relay
  retry closes all read "Not retried - ..."
  (`dashboard/src/routes/contact/deliveryStatus.ts:931-934`).

**Implies.** A builder who opens the anchor in this worktree finds no ruling at
all, so the spec does not stand on its own. Either bring the ruling onto the
branch or quote it in the spec. Then make the job-time decline follow it by
default, or record that Cameron explicitly overrides his own rule.

---

## 4. [MEDIUM] D7/D10 promise a retry and lock staff out of Retry on the threads where the retry is certain to be refused (today: every imported one-to-one thread)

**What is wrong.** D7 stamps `retry_due_at` on every successful enqueue without
looking at the conversation. D10 then hides Retry and answers 409
`retry_pending` until `retry_due_at + 2 min`: 60 s backoff plus 120 s grace for
attempt 1, so about 3 minutes. But the retry is refused at send time, with
certainty, on any conversation in manual mode:

- `retrySend` sends `automated: true` (`app/src/jobs/retrySend.ts:200-207`).
  `sendMessage` refuses every automated send when `ai_mode` is manual
  (`app/src/services/sendMessage.ts:348-349`).
- The Quo import writes `ai_mode = if_not_exists(ai_mode, :aiMode)` with
  `:aiMode = 'manual'` on every conversation row it upserts
  (`app/src/lib/import/apply.ts:1093`, `:1107`). A breaker trip also flips a
  conversation to manual (`sendMessage.ts:352`).

Section 5 treats this as share-skip-fix's concern ("its automation switch
refuses ..."), but it is main's behavior today. share-skip-fix's D2 is the
operator run that would turn those switches ON, on Cameron's go after its own
deploy. Section 9's "A retry refused at send time ... keeps its promise until
it expires" reads like an edge case. On current data it is the common case for
imported contacts. Today those staff can press Retry at once.

**Implies.** If this ships unfixed, the first thing staff see on imported
tenants is a false "will retry" and a Retry button that disappears and then
409s for about 3 minutes, for a retry that never runs. The spec has to decide
this explicitly. One option: the arm stamps nothing (and D10 refuses nothing)
when the refusal is already knowable at enqueue time (manual mode; possibly
opt-out). The other: section 9 names this population, Cameron accepts it, and
the spec sequences it against share-skip-fix's D2.

---

## 5. [MEDIUM] D10's "can never be followed by an automatic one" is not delivered by the mechanism

**What is wrong.** D10 guarantees: "A manual Retry that beat the `retry_due_at`
stamp can never be followed by an automatic one." The mechanism: the route
stamps `manual_retry_at` "when the route sends", and the job skips when its
original carries the stamp. Three problems:

- Both sides read the original through `getByProviderSid`, an eventually
  consistent `GetCommand` (`app/src/repos/messagesRepo.ts:1977-1987`). The
  route reads at `api.ts:1571`, the job at `retrySend.ts:112`.
- The spec does not say whether the stamp comes before or after the provider
  send.
- Stamp AFTER the send: a stamp write that fails after `sendMessage` returned,
  or a job read that lands between the send and the stamp (or hits a stale
  replica), texts the member twice.
- Stamp BEFORE the send: the stamp suppresses the automatic retry even when the
  manual send is then refused, and a human send can be refused where the
  automated one would not be. The JIT consent gate applies to human sends only
  (`sendMessage.ts:338-344`). The Retry path also shows no text for that
  refusal: `sendFailureMessage` returns '' for `contact_no_consent`
  (`dashboard/src/routes/contact/Timeline.tsx:89-93`), and `onRetry` has no
  consent intercept (`dashboard/src/routes/contact/ContactCommsPane.tsx:304-308`).
  The staff member sees nothing, and the automatic retry is gone.

**Implies.** Neither ordering makes "never" true without a conditional write
that both sides contend on (for example, route and job each claim the original
conditionally) plus consistent reads. Either specify that, or weaken the
guarantee to what the timing actually gives ("the job runs at least 60 s after
the stamp"). Then list the lost-stamp double send as a residual and pick the
ordering.

---

## 6. [LOW] D7's stamp lands after the callback's only SSE, so "must reach an open screen without a reload" is a race

**What is wrong.** The one-to-one branch emits `message.persisted` on the
transition (`app/src/routes/webhooks/twilio.ts:3291-3301`) BEFORE the 30003 arm
runs (`:3343-3369`). The contact timeline refetches 300 ms after an SSE
(`dashboard/src/routes/contact/useContactTimeline.ts:109`, `:515-521`). D7 says
the stamp "must reach an open screen without a reload" but requires no emit
after the stamp.

**Implies.** Whether the promise shows depends on the enqueue and annotate
finishing inside the debounce. When DynamoDB or SQS is slow, the screen shows
no promise and a live Retry button, which then 409s. Test intention 8's e2e
assertion ("shows ... will retry with no Retry button") becomes timing-bound.
Require an emit after the stamp.

---

## 7. [LOW] send-outcome-reconcile revision 2 adds a second one-to-one retry scheduling site the spec does not cover

**What is wrong.** Section 5 describes the reconcile branch as of its first
draft (`66f2a363`), where a one-to-one `never_sent` meant "ERROR and end the
chain". Its current spec re-enqueues the same `retrySend` rung once on
`never_sent` or `retryable` ("a `deferred` flag in the payload",
`send-outcome-reconcile-design.md:356` at `513e0717`). That is a second place a
one-to-one automatic retry gets scheduled, and D3's schedule-time check and
D7's `retry_due_at` are not applied there. D4's job gate still bounds the send,
so the invariant survives. The promise, though, expires while the deferred rung
is still pending, and the Retry button comes back.

**Implies.** Add it to section 5's couplings. Whichever branch lands second
applies D3 at the deferral and restamps or clears `retry_due_at`.

---

## 8. [LOW] Unenumerated test-double and vocabulary surfaces

- The harness fake `append` is an explicit field allowlist
  (`app/test/helpers/twilioWebhookHarness.ts:1081-1152`). The new append-time
  inputs from D2/D6 (`retry_attempt` at append, `retry_window_start`,
  `relay_retry_window_start`) are silently dropped there unless mirrored. A
  harness-based rung-2 claim then falls into D5's fail-open, and a "measures
  from the carried origin" test (intention 2) can pass vacuously. Section 4
  lists only the harness `annotateMessage` (`:1338`).
- `RelayRetryCloseCode` (`app/src/jobs/relayRetryLeg.ts:91-97`) is the typed set
  `refuseGate` accepts. It needs `retry_window_closed`; section 4 names only the
  claim-outcome union and the copy test.
- `e2e/support/selectors.md:49` documents the close-code prose family and
  "Native Group MMS keeps its existing `will retry` promise, unchanged". Both
  change.

**Implies.** Add these to section 4.

---

## 9. [LOW] D12's list of comments that become false is incomplete, and two omitted ones contradict D11's premise

- `app/src/routes/webhooks/twilio.ts:323-341` points readers at
  `group-text-30003-leg-retry-promise-unverified`, which this branch closes, and
  says the one-to-one path "is the one path where the promise holds". With a
  window that is no longer unconditional.
- `twilio.ts:3422-3429` and `:3477-3479` say "NATIVE GROUP TEXTS ARE REACHABLE
  HERE. A classic status callback for a group leg in the pre-marker window
  resolves to the GROUP thread." D11 calls the arm "not believed reachable",
  citing `groupReceipts.ts:3-10` (classic callbacks do not fire for
  Conversations sends; the marker was dropped), and never mentions that the
  code asserts the opposite in two places. The issue being closed also says the
  30003 arm "DOES reach the enqueue"
  (`docs/issues/group-text-30003-leg-retry-promise-unverified.md`). One side is
  stale. The spec should say which and correct it, not leave "the build
  confirms it" to someone who cannot observe production. And if the arm IS
  reachable, D11's "must not enqueue there" is a dead end that D9 does not log
  at ERROR.
- Made false by D6: `app/src/services/sendMessage.ts:234-240` ("The 30003
  auto-retry annotates retry_of itself"), `app/src/repos/messagesRepo.ts:726-731`
  and `:2262-2265`, and `app/src/jobs/retrySend.ts:9-10` and `:221-225`.
- `dashboard/src/routes/contact/deliveryStatus.ts:831-857`, the rest of the
  block D12 cites only lines 824-829 of ("a 1:1 30003 retry genuinely does
  send").
- `dashboard/src/routes/broadcasts/StatChips.test.tsx:120-125`, and
  `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-22` ("`will retry`
  was, and remains, a native group-text string").

---

## 10. [LOW] One promise horizon, two clocks, no skew bound

**What is wrong.** The screen shows the promise and hides Retry by the
browser's `tickNow` (`dashboard/src/routes/contact/Timeline.tsx:1805`,
`:2095-2127`), while D10's server refuses by its own clock. This same file
treats viewer-clock skew as reachable ("the ageing clocks are the PROVIDER's
and `nowMs` is the OPERATOR'S BROWSER clock", `Timeline.tsx:791-797`; also
`relayRetryJoin.ts:319-329`) and bounds it. If the browser runs behind the
server, the false promise stays and Retry stays hidden past the real expiry,
with the ticker armed for the whole skew. If it runs ahead, the screen offers a
Retry the server refuses.

**Implies.** Name it in section 9, or define the promise's live test so it
cannot outlast `retry_due_at + grace` by more than a stated bound.

---

## 11. [LOW] Three precision defects

- D2 says `relay_retry_window_start` is carried "the way
  `relay_retry_origin_direction` already is (`twilio.ts:2824-2825`)". That
  pattern is `src.field ?? derive-from-src`. On a pre-deploy retry row it would
  derive from that row's own slot `sentAt` and quietly restart the window,
  while D5 says such a row fails open. Say which.
- D8: "a claim-time decline changes nothing on screen (no rung exists ...)" is
  true only at rung 1. At rungs 2 and 3 a rung exists, and the leg moves from
  `Retrying` to terminal through the join's step 4
  (`dashboard/src/routes/contact/relayRetryJoin.ts:405-415`), exactly as at
  `cap_exhausted`. The copy conclusion holds; the stated reason does not.
- D13 moves `relayRetryClaim.webhook.test.ts:66` and `:174` (`ROOT_PROVIDER_TS`)
  to "realistic times". D2 says the relay origin is the slot `sentAt` and never
  the root timestamp, and those fixtures carry no slot `sentAt`
  (`:157-161`, `:174-178`), so they go through D5 either way. Moving them
  buys nothing. The relay window needs NEW fixtures with a slot `sentAt`.
