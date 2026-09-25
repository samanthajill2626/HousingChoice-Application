# Spec review r2 - retry send window, DRAFT 2 (reviewer B, continued)

Reviewer: adversarial spec reviewer B, round 2, 2026-09-24/25.

Spec under review: `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`
at `feat/retry-send-window` @`d4446de0` (DRAFT 2), diffed against `a6c4c01b`.
Also read: `spec-review-r1-adjudications.md`, `spec-review-r1-a.md`,
`rulings.md`, and the two concurrent specs at their CURRENT heads -
`feat/share-skip-fix` @`3a6a1a06` (v5) and `feat/send-outcome-reconcile`
@`5d4ee649` (revision 3; the spec still cites revision 2 @`513e0717`).

Method. Every claim about existing code cites a `file:line` read during this
round. Read-only; nothing was run except read-only git commands.

Order of this report, as asked: what round 1 missed and what the rewrite broke
first (Part 1), then contests of the adjudications (Part 2), then the status
of my round-1 findings (Part 3).

| # | sev | finding |
| --- | --- | --- |
| R2-1 | MEDIUM | D8's job-time relay copy puts a carrier "(error 30003)" tail into `INTERNAL_CODE_REASONS`, whose documented rule and pinned test forbid one; section 4's "the copy test gains the new code" cannot pass |
| R2-2 | MEDIUM | Section 5 is stale against send-outcome-reconcile revision 3: an `unknown` one-to-one retry stays unresolved for about 4 minutes, past the promise and the guard, which opens a double send nobody names |
| R2-3 | LOW | D3a's new reads fail CLOSED and permanently by default (catch-all plus the `transitioned` gate); a transient read error now drops a retry that today is enqueued |
| R2-4 | LOW | With the reverse guard gone, a lost `retry_due_at` stamp leaves the whole 60-240 s wait unguarded; D7 still calls it "honest" and section 9 omits it |
| R2-5 | LOW | The futurity bound D8 reuses is 15 minutes wide and built for "late, never missed" - the harmful direction for a promise |
| R2-6 | LOW | Section 1's "never more than `RETRY_PROMISE_GRACE_MS` past its due time" is contradicted by residual 4 and by R2-5 |
| R2-7 | LOW | D13's lane-window floor ignores the grace now spent at scheduling; and the lane's one-to-one backoff value is not on section 4's list |
| R2-8 | LOW | Relay and one-to-one order the same checks differently, so one dead end logs at two severities |
| R2-9 | LOW | D8's "for every surface" rule literally forbids the relay `Retrying` state |
| R2-10 | LOW | The share results row cannot "follow the rule" on this branch: it reads only the broadcast slot, which has no `retry_due_at` |
| R2-11 | LOW | The `already_claimed` probe reads the pointer eventually consistently, so the false ERROR it exists to prevent survives |
| R2-12 | LOW | With base 30003 copy equal to the relay override, the relay map goes redundant and the pinned order test goes vacuous; the promise variant's precedence is unstated |
| R2-13 | LOW | Two share-skip-fix v5 couplings are still missing from section 5 (a manual-mode lean tenant; the import writes `auto`) |
| R2-14 | LOW | The residual double-send paths and the throttle overrun have no `docs/issues/` entry, and the spec will be frozen after merge |

---

# Part 1 - new findings

## R2-1 [MEDIUM] D8's job-time relay copy collides with the internal-code "no (error N) tail" rule and its pinned test

**What is wrong.** D8: a job-time decline closes the rung with
`retry_window_closed`, "whose copy in `INTERNAL_CODE_REASONS` ... is 'Phone
unreachable (error 30003)'". Section 4 adds that the close-code copy test
"(`deliveryStatus.test.ts:1648-1668`) gains the new code".

- `INTERNAL_CODE_REASONS` has a documented rule: codes this app invents "get
  plain operator copy and, deliberately, NO '(error <code>)' tail"
  (`dashboard/src/routes/contact/deliveryStatus.ts:878-882`, the A16 defect).
- The test section 4 names enforces it: `it.each(RETRY_CODES)('renders %s as
  prose with no (error N) tail', ...)` asserts
  `expect(deliveryReason(code, { relay: true })).not.toContain('(error ')`
  (`dashboard/src/routes/contact/deliveryStatus.test.ts:1656-1659`, the negative
  at `:1658`).

Adding `['retry_window_closed', 'Phone unreachable (error 30003)']` to that table
fails on its first run. The builder has to break the documented rule or leave
the code out of the test section 4 names.

**What it implies.** The ruling ("a declined retry shows as a plain failed
attempt") does not need an internal-copy exception. The join already has the
right branch: step 4 keeps the ORIGINAL's carrier code when the last rung has
none ("otherwise the original's carrier code stands", `relayRetryJoin.ts:405-415`).
If the join treats `retry_window_closed` as carrying no display code, the leg
reads "Undelivered - Phone unreachable (error 30003)" through the relay map - byte
for byte the claim-time decline - while the rung keeps `retry_window_closed` for
data and logs. Otherwise the spec must say, explicitly, that it amends the A16
rule for this one code, and pin that with a separate test.

## R2-2 [MEDIUM] Section 5 is stale against send-outcome-reconcile revision 3, which opens a double send the spec never names

**What is wrong.** Section 5 describes the reconcile branch as "revision 2
@`513e0717`" and its one-to-one coupling as a re-enqueue with "a `deferred`
flag". The branch HEAD is revision 3 @`5d4ee649`, and its one-to-one mechanics
changed:

- The deferral is no longer a payload flag. "The 1:1 owner (`retrySend`) has no
  slot: its durable record is the ORIGINAL message row, and its check number,
  deferral and verdict are conditional attributes on that row" (reconcile spec
  lines 325-327; D16 table, line 430). That is the same row D7 stamps and D10
  reads.
- A prepare-phase failure (the original read, the presign) now takes the same
  deferral as `never_sent` (line 432).
- `unknown` goes to reconcile (line 432). Its checks run "about 5 seconds, 30
  seconds and 4 minutes after the attempt" (D13a, lines 356-358). For those
  minutes the automatic text may already be out. Meanwhile this spec's promise
  and D10's guard expire at `retry_due_at + 2 min`, so the Retry button returns
  and the route accepts a manual retry. A manual press then texts the member
  twice when the verdict comes back `found` (reconcile D15 then adopts the row).
  Neither section 5 nor section 9 names this path. Section 9's "after an expired
  promise while the automatic job is running late" does not cover it: the job
  ran on time, and it is the outcome that is pending.
- Revision 3 files "an `unresolved` 1:1 retry leaves the original's 'will retry'
  copy standing" as its own issue (line 641). This branch's D8 changes that
  copy, so the issue either closes or changes.
- Revision 3 D3 retypes `sendMessage`'s errors (line 153 onward), on the same
  input and append path D6 edits.

**What it implies.** Re-read the branch at `5d4ee649` and rewrite coupling 3.
When `retrySend` hands a retry to reconcile, keep the promise and D10's guard up
until the verdict: refresh `retry_due_at` to cover the check schedule, or have
the route also refuse while the reconcile's pending-check attribute is set on
the original. Whichever branch lands second owns it, but only if it is written
down.

## R2-3 [LOW] D3a's new reads fail closed, and permanently

**What is wrong.** Today the one-to-one arm does no reads before it enqueues
(`app/src/routes/webhooks/twilio.ts:3353-3368`). D3a adds a conversation read and
a contact read (the preview's opt-out input), both inside the arm's catch-all.
That catch logs ERROR and acks 200 (`:3524-3528`), and the arm runs only on
`transitioned` (`:3343`), so a redelivery cannot re-run it. A single transient
read failure now drops a retry that today would have been enqueued. The spec
states fail-open only for a MISSING origin (D5). An unparseable origin is the
other quiet trap: a NaN compares false, so a naive `now <= origin + window`
declines and logs a dead-end ERROR.

**What it implies.** State that a preview read error, and a missing or
unparseable origin, fail OPEN (WARN, schedule as today). That is safe in every
case, because the job's `sendMessage` re-applies the kill switch, opt-out,
manual mode and the `group_text` refusal at send time
(`app/src/services/sendMessage.ts:286-300`, `:307-318`, `:348-349`).

## R2-4 [LOW] With the reverse guard removed, a lost stamp leaves the whole wait unguarded

D7 keeps "A lost stamp leaves no promise for a retry that happens anyway
(honest)". That reasoning was written while the `manual_retry_at` reverse guard
backstopped a lost stamp. Draft 2 removed that guard (adjudication A5/B-F5). Now
an `annotateMessage` failure after a successful enqueue (caught and logged at
`twilio.ts:3524-3528`) leaves no promise, a live Retry button and no 409 for the
full 60-240 seconds, while the automatic retry is still coming: a double send.
Section 9's list ("the second or so before the promise reaches the screen ...
after an expired promise while the automatic job is running late") omits it. Add
it to section 9 and to the section 1 table's "narrows".

## R2-5 [LOW] The futurity bound D8 reuses is the wrong width and faces the wrong way for a promise

D8: the promise's live test "reuses the Timeline's clock-skew bound
(`Timeline.tsx:791-797`), so a slow browser clock cannot hold the promise open."
That bound is `canEverGoStale`'s, and its own doc sets both its width and its
direction:

- Width: one staleness budget, `STALE_SENT_AFTER_MS` = 15 minutes
  (`deliveryStatus.ts:336-341`, `:363`).
- Direction: "A clock at most one staleness budget ahead of ours is ordinary
  skew. It stays eligible ... the escalation is merely LATE" and "NO MISSED
  ESCALATION" (`:306-314`).

For a promise, late expiry is the harmful direction: a false "will retry" and a
hidden Retry button while the server, on its own clock, would already accept the
retry. Reused as is, a browser up to 15 minutes slow holds both for up to 15
extra minutes. The promise horizon itself is only 3-6 minutes (backoff plus
grace). My round-1 remedy ("reuse the bound") was too loose. The promise needs
its own bound, for example the longest backoff plus the grace, and "clock beyond
the bound = not live". Test intention 7 ("a skewed clock cannot hold it open")
has to name a skew size to be writable.

## R2-6 [LOW] Section 1's new promise clause restates a bound the mechanism does not meet

Section 1: the screen promises a retry "never more than `RETRY_PROMISE_GRACE_MS`
past its due time." Residual 4: "The promise can linger up to 60 seconds past
`retry_due_at + grace` (ticker granularity)." R2-5 adds up to the futurity budget
on a slow clock. This is round 1's slogan-vs-mechanism defect (then about the 15
minutes), re-introduced in the rewrite's new clause. Write the real bound - grace
plus one tick, plus the skew bound R2-5 settles.

## R2-7 [LOW] D13's lane-window floor ignores the grace now spent at scheduling

D3 now schedules a rung only if `now + backoff + RETRY_JOB_GRACE_MS <= origin +
window`, with the grace fixed at 60 seconds. D13's floor for
`E2E_RETRY_SEND_WINDOW_MS` is "must exceed BOTH lanes' ladders (the relay spec's
10-second rungs and the one-to-one lane backoff)". A lane window that clears that
floor but sits under about backoff + 60 s (30 s, say) declines every rung in both
lanes, and the relay 30003 e2e spec fails. The floor is backoff plus grace, or
the grace needs the same lane override. Separately, section 4 lists only the
relay lane value (`scripts/e2e-session.mjs:254-272`). Test intention 8 needs
`E2E_SEND_RETRY_BACKOFF_MS` added to the same `childEnv`.

## R2-8 [LOW] The two paths order the same checks differently, so one dead end logs at two severities

- One-to-one (D3a): the refusal preview runs BEFORE the window. A late 30003 on
  an opted-out or manual-mode thread logs WARN.
- Relay (D3): the window is checked at the CLAIM, before the job's human-action
  gates (`relayRetryLeg.ts:491-555`) ever run. A late 30003 for a member of a
  closed group, a removed member, a changed number or an opted-out member now
  logs ERROR (`window_closed`). Today the claim succeeds and the job's gate logs
  WARN - Cameron's Q1 ruling on those four refusals.

A late 30003 after a group closes can come in a burst (a carrier giving up on a
dead handset's held texts). Say which severity is intended. If it is WARN,
consult the group status (the claim reads the roster anyway for rung 1,
`twilio.ts:2780`) before declaring `window_closed`.

## R2-9 [LOW] D8's "for every surface" rule literally forbids the relay `Retrying` state

D8: "a 30003 promises a retry ONLY while the failed message carries a live
`retry_due_at`". The relay `Retrying` label is a promise by the code's own
account ("the promise here is ours, and the label is what makes it",
`deliveryStatus.ts:729-731`). Its failed root never carries `retry_due_at`, since
nothing on the relay path stamps one. Read literally, a builder must suppress
`Retrying`. Scope the rule to the one-to-one bubble and the share row, and say
that the relay promise is governed by the live rung (`relayRetryJoin.ts:370-377`).

## R2-10 [LOW] The share results row cannot follow the rule on this branch

D8: the share results row "follows the same rule" and "this branch owns only the
rule". The row renders `DeliveryBadge` from the broadcast SLOT only - `status`,
`conversationId`, `tsMsgId`, `carrierSentAt`, `errorCode`
(`dashboard/src/api/types.ts:2941-2958`; `DeliveryBadge.tsx:29-31`) - which has no
`retry_due_at`. On this branch alone, the base-copy change simply removes the
row's promise, including while a retry IS scheduled. Say so. Then assign the read
of `retry_due_at` from the failed message to share-skip-fix's results path, which
already plans to read that message for "retries exhausted" (share-skip-fix v5,
lines 248-252).

## R2-11 [LOW] The `already_claimed` probe is only as good as an eventually consistent read

D3's probe looks up the rung's deterministic SID. The public lookup,
`getByProviderSid`, reads the `sid#` pointer eventually consistently
(`app/src/repos/messagesRepo.ts:1977-1987`). Only the private `getSidPointer`
accepts `ConsistentRead` (`:1960-1974`, used by the append's dedupe branch). A
duplicate that arrives within replication lag of the winning claim misses the
pointer and logs exactly the false dead-end ERROR the probe was added to
prevent. Specify a strongly consistent probe (the repo would expose one).

## R2-12 [LOW] Base copy now equals the relay override: the relay map goes redundant and the order test goes vacuous

After D8, `ERROR_CODE_REASONS['30003']` and `RELAY_ERROR_CODE_REASONS['30003']`
are the same string "Phone unreachable" (`deliveryStatus.ts:778`, `:859-861`). The
pinned order test "falls through the media map to the relay override for a 30003
attachment leg" (`deliveryStatus.test.ts:761-767`) still passes but no longer
proves the relay override was consulted - its stated purpose was "never on the
base 'will retry'". D12 rewrites the map's comment but does not say whether the
map stays. The new "will retry" variant's place in the order is also unstated.
For example: an MMS one-to-one 30003 with a live stamp, where the media map has
no 30003, so the promise must still apply. Decide both.

## R2-13 [LOW] Two share-skip-fix v5 couplings are still missing from section 5

- Its lean seed gains "one switched-off tenant conversation for the e2e checks"
  (v5 line 406). Test intention 8's one-to-one e2e must not use it: D3a would skip
  the retry, and the spec would show no promise.
- Its D3 makes the import create one-to-one rows `auto` (v5 line 171). After it
  lands, section 2's "The Quo import writes `ai_mode = manual` on every
  conversation it creates" describes only pre-branch rows. Harmless, since D3a
  reads the live switch, but the record should say so.

## R2-14 [LOW] The residuals have no issue files

The section 1 table marks the manual double send "narrows" and section 9 keeps
paths open: the pre-stamp second, the late job, the stale tab, plus R2-2 and R2-4
above. It also keeps the throttle overrun (section 9 bullet 1). None has a
`docs/issues/` entry. No existing issue covers a manual-retry double send; the
closest are `send-idempotency-key` and `accepted-send-lost-when-append-fails`.
After merge the spec is frozen as historical and these are tracked nowhere.
AGENTS.md: "Bugs, gaps, debt, and deferrals go in `docs/issues/`." File them in
the same change.

---

# Part 2 - contesting the adjudications

The adjudication accepted all 24 round-1 findings, so there is no rejection to
contest. Where the chosen remedy differs from mine, or where it has a hole:

- **A5 / B-F5 (reverse guard removed).** Conceded: removing the guard is
  faithful to Cameron's option 1 (`rulings.md`, brainstorm answer 3), and I
  cannot defend "can never" at acceptable cost. I do contest the claim that what
  remains is a "narrowed remaining race" fully named in section 9. The lost-stamp
  case (R2-4) and the reconcile `unknown` case (R2-2) are each wider than the two
  windows section 9 names.
- **A10 / B-F11 (skew).** My round-1 remedy was imprecise, and the adjudication
  inherited it. The adjudication's wording ("cannot hold the promise
  indefinitely") is accurate; the spec's ("cannot hold the promise open") is not.
  R2-5 gives the fix.
- **A1 / B-F2 ("the share row stays share-skip-fix's surface").** This branch
  still changes that row, because the row renders the base string D8 rewrites
  (R2-10).
- **A3 / B-F4 (ruling copy).** The chosen mechanism collides with a pinned
  invariant (R2-1). The ruling is satisfiable without that collision.
- **A2 / B-F3 (grace moved to scheduling).** The right remedy. It moved D13's
  floor (R2-7), and the new promise clause repeats the absolute-bound mistake
  (R2-6).
- **A4 / B-F1 (D3a).** The right remedy. It needs its failure semantics (R2-3).
- **B-F12 (probe).** The right remedy. It needs a consistent read (R2-11).

---

# Part 3 - status of my round-1 findings against DRAFT 2

All thirteen are addressed in draft 2. Caveats point at Part 1.

| round 1 | status in draft 2 |
| --- | --- |
| F1 manual-mode promise and lockout | closed by D3a (verified: `scheduledSendSuppression.ts:36-38`, `:52-68`; harness boots the console driver, so `smsSendingEnabled` defaults on, `config.ts:787`); caveat R2-3 |
| F2 share-skip-fix coupling | closed against v5 (`3a6a1a06` is its HEAD); caveats R2-10, R2-13 |
| F3 invariant vs grace | closed for the send half; the promise half re-opens it (R2-6); D13 side effect R2-7 |
| F4 ruling copy | closed in intent; the mechanism collides with A16 (R2-1). Verified the claim-time vs job-time wording now matches: the join's terminal step keeps the root slot's status and swaps only the code (`relayRetryJoin.ts:405-415`) |
| F5 "can never" | resolved by removal; residual list incomplete (R2-4, R2-2) |
| F6 reconcile deferral | addressed against revision 2; stale against revision 3 (R2-2) |
| F7 D11 conditional | closed (unconditional guard) |
| F8 D12 comments | closed |
| F9 section 4 sweep | closed; one lane line missing (R2-7) |
| F10 one-to-one e2e seam | closed (D13); floor defect R2-7; seed coupling R2-13 |
| F11 skew | partially: bounded, but by the wrong budget and direction (R2-5) |
| F12 duplicate near the edge | closed in design; read consistency R2-11 |
| F13 anchors unrecorded | closed (`rulings.md`) |

## Verification notes

- `failed -> undelivered` is not a legal transition (`messagesRepo.ts:133-141`).
  So a message a human already retried cannot later reach the 30003 arm, and the
  removed reverse guard had no case there.
- The only server-side listener for `message.persisted` is the SSE stream
  (`app/src/routes/api.ts:2562`). D7's second emit is a dashboard refetch and
  nothing else.
- UNVERIFIED: whether a stale tab refetches on SSE reconnect or on focus. It
  affects how often the section 9 stale-tab residual bites, not whether it
  exists.
- The concurrent specs keep moving. Line numbers cite `3a6a1a06` and `5d4ee649`.
