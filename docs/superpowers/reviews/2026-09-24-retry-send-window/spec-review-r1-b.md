# Spec review r1-b - retry send window (adversarial)

Reviewer: adversarial spec reviewer B, round 1, 2026-09-24.

Spec under review: `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`
on `feat/retry-send-window` @`a6c4c01b` (cut from `main` @`685f2ede`).

Method. Every claim about existing behavior was checked in the code at that
commit; each citation is a `file:line` read during this review. Two concurrent
specs were read in their own worktrees at the commits named:
`feat/share-skip-fix` @`7ac57f31` (it moved from v3 @`fc89dd0a` to v4 while this
review was running; citations are to v4) and `feat/send-outcome-reconcile`
@`513e0717`. Read-only: no tests, servers or state-changing git commands were run.

| # | sev | finding |
| --- | --- | --- |
| F1 | HIGH | Manual-mode one-to-one threads: the design promises, and blocks the staff Retry on, a retry the send wrapper always refuses |
| F2 | HIGH | Section 5 misstates the share-skip-fix coupling; the two specs set contradictory 30003 copy for the same surface and edit the same call sites |
| F3 | MEDIUM | The headline invariant says 15 minutes; the mechanism permits 16 minutes plus an unbounded throttle wait |
| F4 | MEDIUM | The relay job-time decline default contradicts the anchor ruling, and the ruling is not in this branch |
| F5 | MEDIUM | D10's "can never" reverse-race guarantee rests on an unspecified write order and failure policy |
| F6 | LOW | Section 5 omits the reconcile branch's one-to-one re-drive, a later automatic retry D7's promise does not describe |
| F7 | LOW | D11 defers an unverifiable question the repo already answers, and leaves the contradicting comments in place |
| F8 | LOW | D12's list of comments that will lie is incomplete |
| F9 | LOW | Section 4's surface sweep misses several sites the decisions land on |
| F10 | LOW | Test intention 8 does not fit the lane as specified |
| F11 | LOW | The promise clause omits the ticker's clock-skew (futurity) bound |
| F12 | LOW | The claim-time window check cannot recognize an already-claimed rung |
| F13 | LOW | The spec's second anchor (brainstorm answers, D10's attribution) is not recorded |

---

## F1 [HIGH] Manual-mode one-to-one threads: the design promises, and blocks the staff Retry on, a retry the send wrapper always refuses

**What is wrong.**

- Today every automatic one-to-one retry in a conversation whose `ai_mode` is
  `manual` is refused at send time and the chain ends. The job sends
  `automated: true` (`app/src/jobs/retrySend.ts:205`); `sendMessage` throws
  `ManualModeError` for any automated send in manual mode
  (`app/src/services/sendMessage.ts:348-349`); the job catches it as a
  `SendRefusedError`, WARNs and stops (`retrySend.ts:209-216`). A human send is
  allowed in manual mode (`sendMessage.ts:346-347`; the retry route sends
  `automated: false`, `app/src/routes/api.ts:1647`).
- That population is not an edge case. The Quo import writes
  `ai_mode = if_not_exists(ai_mode, 'manual')` on every imported one-to-one row
  (`app/src/lib/import/apply.ts:1087`, `:1093`, `:1107`), and nothing ever writes
  `auto` afterwards: the only `setMode` caller is the breaker, and it writes
  `manual` (`sendMessage.ts:352`). The share-skip-fix spec records this as
  verified by two reviewers and confirmed in production, and names "the 30003
  automatic retry" among the texts it silently stops (share-skip-fix spec
  @`7ac57f31`, lines 35, 48-55).
- The spec's inventory of where "will retry" is false (section 2, "The promise")
  omits this population. Section 5 then attributes the refusal to the other
  branch ("its automation switch refuses the one-to-one automatic retry at send
  time (`sendMessage.ts:349`)"); that refusal is `main`'s behavior today.
- Against that behavior the mechanism does the wrong thing on every 30003 in such
  a thread. The arm reads no `ai_mode` (`app/src/routes/webhooks/twilio.ts:3350-3369`),
  so it enqueues and D7 stamps `retry_due_at`; D8 renders "Phone unreachable -
  will retry"; D10 hides the Retry button and the route answers 409
  `retry_pending` ("A retry is already scheduled for this message.") until
  `retry_due_at + 2 min` - about three minutes for rung 1 - for a retry that is
  certain to be refused 60 seconds later.

**Evidence.** As cited; plus section 1's invariant ("the screen promises a retry
only while one is actually scheduled") and section 9 residual 4, which lists
"manual mode" as a residual without saying it is the common case.

**What it implies.**

- Today staff in these threads see a false "will retry" but can press Retry at
  once, and it works (no double send, because the automatic retry is refused).
  After this branch they see the same false promise for about three minutes,
  cannot press Retry, and a stale view gets a new false server message. That is a
  regression on the one retry path that actually works, in the population where
  the automatic one never runs - and the share results page sends staff to this
  exact button for a failed share row (share-skip-fix spec lines 75-77).
- The repo already has the predicate. `evaluateScheduledSendSuppression` and
  `isManualMode` (`app/src/services/scheduledSendSuppression.ts:36-38`, `:52-68`)
  preview the kill-switch, opt-out and manual-mode refusals of an automated send.
  Decide it in the spec: do not stamp `retry_due_at` (and arguably do not
  enqueue) when the automated send will be refused, or exempt that case from
  D10's screen rule and server guard. Only the automated-only refusals (manual
  mode, the breaker) matter for D10; opt-out, deleted contact and the kill switch
  refuse the manual send too, so blocking it there changes nothing.
- Correct section 2's inventory and section 5's attribution.

---

## F2 [HIGH] Section 5 misstates the share-skip-fix coupling; the two specs set contradictory 30003 copy for the same surface and edit the same call sites

**What is wrong.** Section 5 says share-skip-fix's only interaction is the
manual-mode refusal (see F1) and that "Its edits to `twilio.ts`,
`deliveryStatus.ts` and `contactTimeline.ts` are in other regions." The
share-skip-fix spec (v4 @`7ac57f31`) says otherwise:

- **Copy conflict on the share results surface.** Its D5(d) and its D7 table keep
  "Phone unreachable - will retry (existing)" for "30003 with retries remaining"
  and add "Phone unreachable - retries exhausted" (lines 242-249, 311-312). This
  spec's D8 removes the promise from the broadcast result badge
  (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`) "everywhere".
  Whichever lands second silently overrides the other's approved copy.
- **Its rule is keyed on the retry COUNT** ("retries remaining ... derivable from
  the failed message"), which after this branch no longer means a retry is
  scheduled (a window-declined 30003, and F1's manual-mode case). Built as
  written, it re-introduces on share rows the false promise this spec removes.
- **Same call sites.** share-skip-fix makes "the automatic 30003 retry and the
  staff Retry of a share message ... carry the share" (lines 403-406; its
  Appendix A, lines 502-504, names `app/src/jobs/retrySend.ts` and the retry
  route in `app/src/routes/api.ts`). Those are exactly the lines D6 changes (the
  `sendMessage` input at `retrySend.ts:200-229`) and D10 changes
  (`api.ts:1592-1652`).
- **A premise and an out-of-scope item it removes.** Section 2 calls the badge's
  promise false because "a retry drops the broadcast id", and section 8 puts
  "Showing a one-to-one retry's outcome in broadcast results" out of scope;
  share-skip-fix builds exactly that.
- **A seam this spec needs.** share-skip-fix adds "Dev seam (new): the one-to-one
  retry backoff (60/120/240 s) must be injectable for the hermetic harness"
  (lines 419-421) - what D13 and test intention 8 need (F10). It also leaves the
  manual double-text out of scope (lines 479-481), which D10 closes.

**What it implies.** The coupling record that "whichever branch lands second"
relies on is wrong, so the second lander will not know it owes a
reconciliation. The two specs need ONE rule for 30003 copy on share rows - this
spec's `retry_due_at` ("a retry is actually scheduled") is the natural shared
signal - and section 5 must name `retrySend.ts`, the retry route, the copy
conflict and the backoff seam.

---

## F3 [MEDIUM] The headline invariant says 15 minutes; the mechanism permits 16 minutes plus an unbounded throttle wait

**What is wrong.** Section 1: "No automatic retry ... is sent more than 15
minutes after the original message went out." D3 schedules a rung whenever
`now + backoff <= origin + 15 min`, so a rung may be due exactly at the edge; D4
lets the job send while `now <= origin + 15 min + 60 s`; residual 1 adds the
unbounded `tokenBucket.acquire(1)` after the relay job's last gate
(`app/src/jobs/relayFanOut.ts:1360`). The SQS delay is also ceil'd to whole
seconds (`app/src/jobs/jobs.ts:112-113`). D1 half-concedes this ("plus D4's job
grace"); section 1, the section-1 table and the quiet-hours annotation
("automatic retries now end 15 minutes after the send") do not. The founder's
ruling (on `main`, see F4) is literal: "nothing re-sends a text more than 15
minutes after the original went out."

**What it implies.** A test written from section 1 fails against the mechanism,
or a builder "fixes" one to match the other. Either restate the invariant with
the real bound (15 minutes plus the 60-second grace plus throttle), or make 15
minutes true: schedule only when `now + backoff <= origin + WINDOW - GRACE` and
let the job check `now <= origin + WINDOW`.

---

## F4 [MEDIUM] The relay job-time decline default contradicts the anchor ruling, and the ruling is not in this branch

**What is wrong.**

- The spec's anchor is Cameron's Q4 ruling in
  `docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/founder-rulings-2026-09-24.md`.
  On `main` (@`cd8e8ddd`) that row reads, in part: "A declined retry shows as a
  plain failed attempt." This branch was cut from `685f2ede`; `cd8e8ddd` is not
  an ancestor (merge-base `685f2ede`), and in the branch the same row still reads
  "Open. Cameron asked when a powered-off phone actually produces a 30003 before
  deciding. | Pending." A builder following the anchor from this worktree finds
  no ruling.
- D8 and section 7 default the relay job-time decline to "Retry skipped - message
  too old" - not a plain failed attempt - and present the ruling-conforming
  outcome as the costly "alternative" of writing 30003 onto the rung. That is a
  false choice: keep `retry_window_closed` as the stored close code (the per-gate
  rule the relay design uses) and give it copy in `INTERNAL_CODE_REASONS` that
  reads as the plain failure, for example the same "Phone unreachable (error
  30003)" the claim-time decline already shows.
- If distinct copy is kept anyway, "Retry skipped - ..." breaks the pattern of
  its four siblings, all "Not retried - ..."
  (`dashboard/src/routes/contact/deliveryStatus.ts:931-934`).
- Section 7's "one visible difference" undercounts: a one-to-one job-time decline
  renders plain "Phone unreachable" (D8) while a relay one does not.

**What it implies.** Bring the ruling text into the branch (quote it or sync
it), make the default conform to it, and offer the distinct copy to Cameron only
as an opt-in.

---

## F5 [MEDIUM] D10's "can never" reverse-race guarantee rests on an unspecified write order and failure policy

**What is wrong.** D10: "when the route sends, it stamps the original with
`manual_retry_at`, and the automatic job skips ... A manual Retry that beat the
`retry_due_at` stamp can never be followed by an automatic one." The spec does
not say whether the stamp is written before or after `sendMessage`
(`api.ts:1642-1652`), or what happens when either write fails.

- Stamp after the send: if the stamp write throws, the route 500s after the text
  went out (staff read "Couldn't send" and likely press again), and the automatic
  job 60 seconds later sees no stamp and sends too - the double (or triple) send
  the guarantee rules out.
- Stamp before the send: if the send then throws or is refused, the automatic
  retry is suppressed although nothing was sent; and if the arm's
  `retry_due_at` lands after the route's check, the next manual attempt gets 409
  `retry_pending` - no retry at all, under copy saying one is scheduled.
- Concurrency the guarantee does not cover: once the promise has expired because
  the job is late (queue backlog), a press that lands while the job is between
  its read of the original (`retrySend.ts:112`) and `sendMessage` (`:200`) sends
  twice.

**What it implies.** Choose the order and the failure handling in the spec (for
example: stamp after the send, best-effort, ERROR on failure, the route still
answers 201), scope "can never" to what that choice delivers, and add the
failure case to test intention 6.

---

## F6 [LOW] Section 5 omits the reconcile branch's one-to-one re-drive, a later automatic retry D7's promise does not describe

The send-outcome-reconcile spec (@`513e0717`, D16 table, line 356) re-enqueues
"the same rung once (a `deferred` flag in the payload)" of `retrySend` on
`never_sent` or `retryable`. That is an automatic one-to-one retry that runs
after `retry_due_at + grace`: the promise lapses and the Retry button returns
while an automatic send is still pending. D4's job check bounds it, and D10's
`manual_retry_at` skip prevents a double send only if the skip also applies to a
deferred run. Section 5 names only the relay re-drive and the one-to-one adopt;
name this path and state that both guards cover it (or that the re-drive
refreshes `retry_due_at`).

---

## F7 [LOW] D11 defers an unverifiable question the repo already answers, and leaves the contradicting comments in place

"UNVERIFIED - the build confirms it" cannot be settled in a build: it is live
Twilio behavior. The repo points both ways. Native group-text rows are keyed by
the Conversations IMxx SID (`app/src/services/groupSend.ts:651-654`) and classic
callbacks do not fire for Conversations sends (`groupReceipts.ts:3-10`), so the
classic arm should not resolve a group row. Yet `twilio.ts:323-332`,
`:3422-3429` and `:3477-3479` and `deliveryStatus.ts:831-848` assert that it
does, and `app/test/twilioStatusWebhook.test.ts:1420-1463` seeds a synthetic
SMxx group row and drives the arm. Rule the `group_text` guard in
unconditionally (its sibling arms have one; it needs a conversation read the arm
does not do today), and put those comments on D12's list.

---

## F8 [LOW] D12's list of comments that will lie is incomplete

After D6 and D8 these also become false and are not named:
`deliveryStatus.ts:831-858` (including "The 1:1 entry above stays byte-for-byte as
it is, em dash and all: a 1:1 30003 retry genuinely does send", which D8
contradicts); `twilio.ts:316-341` (the 30003 carve-out rationale, "the 1:1 path
they still govern is the one path where the promise holds"; see F1);
`app/src/repos/messagesRepo.ts:725-731` and `:2262-2264` ("The 30003 auto-retry
job sets retry_of via annotateMessage instead"); `sendMessage.ts:234-239` ("The
30003 auto-retry annotates retry_of itself; it doesn't use this");
`retrySend.ts:9-10` and `:221-225`.

---

## F9 [LOW] Section 4's surface sweep misses several sites the decisions land on

Not listed: the server close-code union `RelayRetryCloseCode`
(`relayRetryLeg.ts:91-97`) and its gate-case table
(`app/test/relayRetryLeg.test.ts:307` onward) - only the dashboard copy test is
named; the `sendMessage` input and append (`sendMessage.ts:193-241`,
`:398-428`), which is the path D6 actually uses; the job's read of the original
(`retrySend.ts:112-120`) and the route's checks (`api.ts:1571-1595`), where D4,
D10's server check and the `manual_retry_at` skip land. There is no seeds and
dev-seams line: the research found none (research-server-findings.md section 9);
say so, so the next reader does not re-derive it.

---

## F10 [LOW] Test intention 8 does not fit the lane as specified

The one-to-one backoff is a fixed 60 seconds with no lane seam
(`retrySend.ts:40-42`, `:73-77`), and the lane's default per-test budget is 60
seconds (`e2e/playwright.config.ts:115`, `:121`). A spec that must watch the
retry's bubble replace the failed one needs either a one-to-one backoff seam
(share-skip-fix proposes one, F2) or an explicit per-test timeout well above 60
seconds. D13's floor for `E2E_RETRY_SEND_WINDOW_MS` names only the relay spec;
it must also exceed the one-to-one backoff, or the arm declines every one-to-one
retry in the lane (research-dashboard-findings.md section 6 recorded this; the
spec dropped it).

---

## F11 [LOW] The promise clause omits the ticker's clock-skew (futurity) bound

D8 arms the ticker "while the promise is live", read against the browser's clock
(`bubbleClocks`, `Timeline.tsx:758-766`), and D10 hides Retry on the same
predicate. A browser clock running slow by S keeps "will retry" on screen, the
Retry button hidden and the interval running for S longer - hours on a badly
skewed machine - while the server, on its own clock, would already accept the
retry. The Timeline documents exactly this non-termination class and bounds it
(`Timeline.tsx:791-797`, `canEverGoStale`'s futurity bound; the retry clause's
twin at `:814-818`); the research recommended reusing it; the spec does not
mention it.

---

## F12 [LOW] The claim-time window check cannot recognize an already-claimed rung

D3 decides `window_closed` before the append (between `twilio.ts:2763` and
`:2781`), but `already_claimed` is only knowable at the append's `sid#` create
(`:2831-2835`). A duplicate or redelivered 30003 for a rung claimed just inside
the window can compute `now + backoff` past the edge and log a dead-end ERROR
(ERROR because `window_closed` is outside `isTerminalRelayLegFailure`'s WARN set,
`:433-445`) while the ladder is running. Rare, but it is a false alarm line; the
rung's deterministic provider SID (`relayRetryProviderSid`,
`app/src/lib/relayRetryClaim.ts:33-35`) allows a probe before declaring.

---

## F13 [LOW] The spec's second anchor (brainstorm answers, D10's attribution) is not recorded

"His brainstorm answers of 2026-09-24" and D10's "(Cameron, 2026-09-24)" have no
record in the branch: commit `a6c4c01b` adds only the spec and three research
reports. AGENTS.md requires mission reasoning to be version-controlled; without
it a builder cannot tell which decisions (the 15-minute number, the manual
guard) were rulings and which were proposals.

---

## Verification notes

- UNVERIFIED: whether Twilio ever posts a classic status callback for a
  Conversations-originated group leg. F7 relies on the live result recorded at
  `groupReceipts.ts:3-10`.
- UNVERIFIED against production data: the size of the manual-mode one-to-one
  population (F1). The code path is verified here; the production confirmation
  is share-skip-fix's diagnosis as its spec records it.
- The concurrent specs are moving. share-skip-fix changed from v3 to v4 during
  this review; F2 cites v4. Both versions keep the "will retry" copy on share
  rows and make the retries carry the share.

Verified as the spec states them (no finding): section 2's relay-ladder,
one-to-one chain, promise-string, Retry-button, not-failed-check and
annotate-after claims; D2's origin sources (`app/src/adapters/messaging.ts:745`,
`relayFanOut.ts:1457`, with the status callback's child-field write preserving
`sentAt`, `messagesRepo.ts:3616-3633`, and `sentAt` present on relay slots since
relay launch); the root-timestamp hazard (`api.ts:1710`); D5's
lineage-throws-after-marker reasoning (`relayRetryLeg.ts:268-292`, `:350-359`);
the thirteen-value outcome union (`relayRetryClaim.ts:47-90`);
`isTerminalRelayLegFailure` routing a new outcome to ERROR (`twilio.ts:433-445`);
`MessageAnnotations` and `annotateMessage` having no REMOVE
(`messagesRepo.ts:1173-1177`, `:2905-2929`); the unmapped-409 copy
(`Timeline.tsx:86-131`); the contact-timeline allowlist
(`contactTimeline.ts:406-463`); the one-to-one ticker exclusion
(`Timeline.tsx:859-899`).
