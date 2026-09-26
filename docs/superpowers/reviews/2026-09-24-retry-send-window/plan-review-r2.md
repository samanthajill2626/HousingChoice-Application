# Plan review round 2 - reviewer B (re-review charge)

Scope: plan v2 (`docs/superpowers/plans/2026-09-25-retry-send-window.md`) and spec
draft 7.2 (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md`) as
committed at `63cd04cd`, read against the code at the worktree HEAD (source
identical to `main` @`da04d0cb`, which the plan cites as `f49a2fe9`). Diff read:
`git diff d35f3e91 63cd04cd` (both documents) plus `git diff 1c0c7ab3 63cd04cd`
(spec). Order of work followed the charge: a fresh sweep first, then the
changed text (rewritten Tasks 3 and 4, Task 10 Step 8b, Task 8's `automated`
doc, every spec 7.2 edit), then the adjudications, then whether each fix is
correct.

Method and limits: read-only. Nothing was run - no tests, no typecheck, no
servers; every "fails/passes" statement below is traced by reading the code
and the plan's test code, and says so. Plan citations are plan-file line
numbers at `63cd04cd`; code citations are `file:line` at HEAD.

Result: no BLOCKING, HIGH or MEDIUM finding. The one decision change (the
closed append) is correct and complete. Three LOW findings, one of them a
fix that is plausible rather than correct.

## Findings

### 1. [LOW] Task 8's rewritten `automated` doc (the B11 fix) calls a person's send "always allowed" and omits the consent gate that `false` alone switches on

Plan lines 4409-4418 (Task 8 Step 3a) replace `app/src/services/sendMessage.ts:207-212`
with a doc whose thesis is "the flag says how a send is gated, not who
initiated it", but which names only two gates - "the circuit breaker meters it
and manual mode refuses it" - and then says "A person's send is false: always
allowed, never counted."

That is not how the wrapper gates. The JIT consent gate fires ONLY for a
person's send: `if (automated === false && contact && !hasSmsConsent(contact))`
(`sendMessage.ts:362`, block `:353-368`), and the class doc says the same
(`sendMessage.ts:124-129`, "NOT thrown for automated system sends"). A person's
send is therefore NOT always allowed: it is the one send the consent gate can
refuse, and an automated one skips it. The phrase "always allowed" survives
from the old doc, where it sat in the breaker context (the breaker block's own
comment, `sendMessage.ts:370-371`, "manual human sends are always allowed (even
in manual mode) and never counted"); promoted to the flag's definition it
becomes wrong.

The spec states the correct set twice: D14 "the consent gate does - exactly as
for the original" (spec lines 469-471) and the new 7.2 bullet "The flag now
says how a send is GATED (breaker, manual mode, consent)" (spec line 484). D3a
step 2 declines a person's original for missing consent (spec lines 216-217),
and test intention 4 pins that decline. So after this branch, the doc on the
very flag D14 re-defines tells a reader that a person's automatic retry cannot
be refused, while the decision refuses it on consent.

Consequence if shipped: a comment D12's own rule ("Comments that now lie are
corrected") was meant to fix now misstates the flag in the opposite
direction. No runtime effect.

Fix: in the 3a replacement, e.g. "A person's send is false: the breaker never
counts it and manual mode never refuses it, but it must pass the JIT consent
gate, which automated sends skip." and name consent in the "how a send is
gated" sentence, matching spec line 484.

### 2. [LOW] Spec section 5 (and section 7's sequencing record) still sequences the `retrySend` adoption "together with" Branch B and cites SOR revision 5; Cameron's 2026-09-25 ruling made the adoption SOR's own Stage 1b, with Branch B after it

Spec lines 566-568: "share-skip-fix Branch A (merged) -> THIS branch ->
send-outcome-reconcile Stage 1 -> reconcile's `retrySend` adoption together
with share-skip-fix Branch B." Spec line 592 cites SOR as "(revision 5,
@`616d120d`, its review closed)", and section 7 (spec lines 757-760) repeats
"then its `retrySend` adoption and share-skip-fix's Branch B" and adds "The
condition: reconcile's spec does not mention this branch at all".

On `feat/send-outcome-reconcile` (unmerged, 11 ahead of `main`):
- `ea6c560e` "revision 6 - cross-branch sequencing (Sec 2a)": SOR's spec now
  carries RSW #1, #5, #6 and #7 by number (SOR spec "## 2a. Sequencing with the two sibling branches (ruled 2026-09-25)", item 2).
- `b93ab376` (2026-09-25 22:08, "Cameron's ruling, 2026-09-25"): "Stage 1b -
  THIS mission's, in its own worktree after Stage 1 lands ... the `retrySend`
  adoption", carrying RSW #1, #6, #2, #3, #4 and the joint gap; and "After
  Stage 1b: share-skip-fix's Branch B ... waits for it and consumes the
  finished record; it owns no part of the adoption."

Spec 7.2 was committed after that ruling (`1c0c7ab3` 22:18, `63cd04cd` 22:21)
and neither it nor `rulings.md` records it (`grep "Stage 1b"` finds nothing in
this branch's spec, plan or records). The requirement ROUTING is still right -
section 5 assigns 2, 3 and 4 to "the `retrySend` adoption", never to Branch B,
and plan Task 21's facts send only the `retry_due_at` read to Branch B (plan
lines 10400-10401) - so the drift is in the sequencing sentences only.

Consequence if shipped: a later planner reading this spec (Branch B's above
all) sees the adoption and Branch B as one step, which Cameron's ruling
explicitly split. Documentary.

Fix: spec lines 566-568 and 757-760: "... -> send-outcome-reconcile Stage 1 ->
its Stage 1b (the `retrySend` adoption, SOR's own worktree) -> share-skip-fix
Branch B, which owns no part of the adoption (Cameron, 2026-09-25, SOR
@`b93ab376`)"; line 592: cite revision 6. Section 7's "reconcile's spec does
not mention this branch at all" can stay as the gate-time record but should
say it is superseded by revision 6.

### 3. [LOW] Task 21's handback template reports "Filed new: none" although this branch files `vitest-config-globalsetup-fail-soft-comment`

Plan line 10410 ("## Issues" in the handback template): "- Filed new: none."
The branch adds `docs/issues/vitest-config-globalsetup-fail-soft-comment.md`
(`git log --diff-filter=A` -> `1c0c7ab3`), the adjudicated DEFER of round-1
B2's second half (`plan-review-r1-adjudications.md`, the "B2 (second half)"
row). It merges with the branch, so the handback's issue delta is wrong as
written. (The "five `docs/issues/*.md`" count under "Files changed" happens to
be right only because it includes this file; Task 20 modifies four.)

Consequence if shipped: the human merging reads that the branch files no new
issue. Minor.

Fix: "- Filed new: `vitest-config-globalsetup-fail-soft-comment` (low; filed
by the planner at plan review round 1, B2's deferred half)."

## Adjudications - contested or conceded

- A6 / B5 / B6, ACCEPT IN PART (the job's two-line input mapping is not
  table-driven): conceded - the decision now runs the shared table (plan Task
  10 Step 8b) and the job's `automated ?? true` / recipient-by-id mapping is
  pinned on each side by Tasks 10 and 11, which is proportionate.
- No other adjudication is contested. Each accepted edit was checked for
  landing: A2 (spec section 1 exception, section 9 entries), A3 (section 9
  "A human action reversed"), A4 / B2 (Task 1 Step 0, plan lines 119-122), A5 /
  B4 (decision header WARN, plan line 5290; taxonomy comment, plan lines
  5954-5961; (B2)/(B3), plan lines 5974-5998), A7 (Task 3 Step 2), A8 / B3 (plan
  slice section), A9 / B7 (watch items, plan lines 88-94), A10 (spec D3a), B8
  (spec D13), B9 (spec section 1), B10 (spec D3a, section 9), B12 (plan line
  10250-10252). B11 landed but is finding 1 above.

## The changed text - verified sound (not findings)

The closed append (A1 / B1, Tasks 3 and 4):
- Same data as a job-time refusal. The refusal's writers touch only the member
  slot: `applyRecipientSendResult` SETs/REMOVEs under `#dr.#mk` only
  (`messagesRepo.ts:3374-3514`); `setRecipientTransportAggregationState`
  (`:3233-3302`) and `setRecipientDelivery` (`:3562-3583`) likewise; the
  harness twins mutate the slot alone (`twilioWebhookHarness.ts:1433-1451`,
  `:1473-1532`, `:1553-1556`). The job's only other write before its gates is
  the execution marker, a separate item (`relayRetryLeg.ts:346-359`), not a
  rung-row field. Final slots: legacy `markRecipient` whole-slot write =
  `{status:'failed', errorCode}`; versioned `planned -> excluded` then
  `queued -> failed` plus `errorCode` = the plan's versioned literal. `append`
  writes `delivery_recipients` verbatim with no status-dependent side write
  (`messagesRepo.ts:2229-2253`) and its shape check covers transport fields
  only (`:917-968`). So Task 4's same-data test (plan lines 2199-2249) compares
  equal fields, and its field exclusions are exactly the per-member ones.
- Red for the right reason (traced, not run): every new claim case fails
  today on the open `queued` slot, the missing `relay_retry_window_start`, the
  missing gap WARN, two scheduled rungs (same-data case) or a 200
  (preview-read case); only the open-rung duplicate case passes, as plan line
  2374 says. The one-write spies are real: the webhook calls repo methods on
  the injected object at call time (`twilio.ts:529`), so `vi.spyOn` sees any
  second write; the SSE-order case uses the crash-recovery shape, in which the
  tail's own emit cannot fire (`twilio.ts:3092-3100`), so `rootEmits() === 1`
  isolates the claim's emit.
- Task 3's pool-number pins: `dispatchJob` synthesizes an envelope for a
  bare `{ jobName, payload }` (`app/src/jobs/jobs.ts:249-279`: `isCompleteEnvelope`, `:222`,
  false -> synthesized), so `rejects.toThrow(/has no pool number/)` is the
  handler's own error; `BOB_NEW` already exists (`relayRetryLeg.test.ts:87`);
  `seedRelay` spreads overrides (`:105-124`), so `pool_number: undefined`
  lands; `runHandler` goes through the adapter (`:252-256`), matching the
  stated red state; the 79-line insertion count is right (80-line block, one
  of them the anchor).
- Nothing downstream still assumes the two-write close: Task 5's header
  (plan lines 3218-3222) and same-slot test (plan line 3084), Task 16's
  Consumes (plan line 8122), Task 20 Step 4 (no-change check), Task 21's
  facts (plan lines 10325-10330, 10389-10393) and spec D3, section 4, section 5
  requirement 6, section 9 and the header table all describe the closed
  append; `git grep closeClaimedRetryLeg` outside the records finds nothing.
  The stranded-claim issue remains accurate for open rungs.

Task 10 Step 8b parity loop: `SendRefusalCase.automated` is a required
boolean (plan Task 7 interface), so the decision's `automated ?? true` never
flips a row; `failed`, `thread`, `decide`, `retryAt`, `declined` and the
`Reads` fields it uses all exist in Task 10 Step 1. (B2) and (B3) match the
code they replace (`twilio.ts:345-355`, `:3272-3278`).

Spec 7.2 edits: section 1's new relay exception is accurate - the claim reads
the post-write slot (`twilio.ts:2688-2695`) and no emit precedes the claim in
the relay status branch (the claim's `:2900`, the tail's `:3095`); section 9's
"request threw" twin names the real transport write (`:3251-3259`); D3a's
description of `evaluateScheduledSendSuppression` matches
`scheduledSendSuppression.ts:52-68`; D14's audit bullet is exact - the audit
row carries `providerSid`, `automated`, `author` only (`sendMessage.ts:457-461`)
and the manual Retry passes `retryOf` but never `retryAttempt`
(`api.ts:1642-1652`); the relay budget citation (`relayRetryJoin.ts:224-235`)
is `isRetryRungLive`'s quiet check. The header's "Status: DRAFT 7" with 7.1
and 7.2 as sub-drafts is not stale.

## Fresh sweep - checked and clean

- Concurrent branches (live `git worktree list`): `feat/inbox-rows-timestamps`
  (unmerged, 50 ahead) touches only inbox files and `e2e/README.md` - no
  overlap with this plan; `fix/relay-gate-refusal-warn` and
  `feat/share-skip-fix` are ancestors of `main`; SOR revision 6's RSW #6 text
  names no claim-time close, so the v2 change leaves it nothing stale.
- `retry_due_at` has one path to the screen: every one-to-one Timeline is fed
  by `useContactTimeline` (`ConversationDetail` redirects a 1:1 to the contact
  page; placement and tour 1:1 tabs use `ContactCommsTab`); the projection is
  a whitelist (`contactTimeline.ts:406-460`), so `automated` and
  `recipient_contact_id` do not leak to the API.
- The `Date` header is readable: the client is same-origin
  (`client.ts:2-6`, `:106-109`) and `dashboard/public/sw.js` has no fetch
  handler.
- No send test asserts an appended row by exact equality, so Task 8's
  always-written `automated` breaks no existing case; nothing in `app/src` or
  `dashboard/src` reads a message-level `automated` today.
- No pre-existing claim fixture carries a slot `sentAt`
  (`relayRetryClaim.webhook.test.ts:154-193`,
  `twilioStatusWebhook.test.ts:1183-1236`), so every existing claim passes
  through D5 open; slot `sentAt` is ISO in production
  (`messaging.ts:745`, `relayFanOut.ts:1457`).
- The claim's window uses the enqueue's own backoff chain
  (`relayRetryLeg.ts:214-234`), in both topologies.
- No CloudWatch filter keys on `gate_refused` or `relay_retry_leg`
  (`infra/modules/observability/main.tf:34-111`), so moving the relay gate
  refusal to claim time changes no metric.
