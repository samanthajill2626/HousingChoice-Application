# Spec R6 - targeted check: claim/marker ordering, immediate close, tests, filed issue

Scope: Sec 3.4, new Sec 3.4a, tests 3/5/7a/7b, Sec 9 obligation 0, and
`docs/issues/throw-for-redelivery-defeated-by-job-marker.md`. Unchanged sections not
re-reviewed.
Repo: `W:\tmp\retry-counter-durable`, read-only. No suites, no Playwright.

**The changed material is sound.** The reordering is correct and correctly justified,
the immediate close is the right reversal, the jobId-stability reasoning is accurate at
every cited line, and test 7a is the discriminating regression the design needed.
Nothing below is blocking.

Five corrections, three of which are about *reasons and wording* rather than mechanism -
but two of them sit in artifacts (a registry issue and a test) that outlive this branch,
so they are worth fixing before handback.

---

## R6-1. [MEDIUM] Test 7b asserts the marker, not the terminal-status skip it names

**What is wrong.** Test 7b: "**A duplicate delivery still cannot double-send** - the
per-recipient terminal-status skip, not the counter, is what guarantees this. Assert no
second provider send for an already-`sent` recipient."

Under the new ordering a duplicate never reaches the send loop, so the skip is not
exercised. The test passes either way and proves nothing about the thing it names.

**Evidence.** New order is claim -> marker -> loop. A duplicate carries the same `jobId`
(`jobs.ts:188`, `:262`, `:286`), so `putJobExecutionMarker` returns `false`
(`messagesRepo.ts:2641-2646`) and the handler returns at
`broadcastFanOut.ts:226-228` / `relayFanOut.ts:346-349` - above the loop at `:263` /
`:443`. The `isTerminal` skip (`broadcastFanOut.ts:265`, `relayFanOut.ts:446`) is never
evaluated.

**Implies.** To test what 7b says, the second delivery must carry a **different**
`jobId` - i.e. a continuation whose `recipientKeys` still name an already-`sent`
recipient - because that is the only delivery that reaches the loop. As written it is a
second, weaker copy of the marker test. Reword to: "a CONTINUATION (fresh `jobId`)
carrying an already-`sent` recipient performs no second provider send."

---

## R6-2. [MEDIUM] The filed issue's DLQ mechanism is wrong - the message is deleted at receive 2 and never dead-letters

**What is wrong.** The issue says the deliberate throw "burns one `maxReceiveCount` rung
per delivery until the envelope lands in the DLQ", and its suggested-fix bullet 2 leans
on the same premise ("the DLQ is reserved for genuine poison-envelope cases"). The
envelope never gets there.

**Evidence - the full trace.**

- Delivery 1: handler throws at `broadcastFanOut.ts:459`. The consumer catches, logs
  WARN, and does **not** delete - `app/src/adapters/sqsJobConsumer.ts:175-183`
  ("NO delete: visibility timeout redelivers").
- Delivery 2 (same `jobId`): `putJobExecutionMarker` returns `false`, the handler logs
  "duplicate delivery suppressed" and **returns normally**
  (`broadcastFanOut.ts:226-228`). The consumer's `await runWithContext(... dispatch ...)`
  resolves, so control falls through to `await this.deleteMessage(message, 'done')` -
  `app/src/adapters/sqsJobConsumer.ts:186`.
- Receive count: **2**. `maxReceiveCount = 5`
  (`infra/modules/jobs/main.tf:41`). The message is deleted, not dead-lettered.

**Implies - and this strengthens the `high`, it does not weaken it.** There is no DLQ
entry, therefore **no DLQ-depth alarm fires** (`infra/modules/jobs/main.tf:8-10` names
that alarm as the backstop for failed handlers). The only trace of the whole event is
one ERROR line from the first throw. The bug is quieter than the issue claims, which is
worse. Correct the sentence to "the redelivery is suppressed, the handler returns
successfully, and the consumer DELETES the message - so the envelope never dead-letters
and the DLQ alarm never fires", and drop the DLQ clause from suggested-fix bullet 2.

---

## R6-3. [MEDIUM] `transient_cap` on the enqueue-failure path is a diagnostic lie, and it does reach an operator

**Answering Q2 directly: nothing branches on it, but it is rendered verbatim to staff.**

**Evidence.**

- Zero code readers: `transient_cap` appears only at its two write sites,
  `broadcastFanOut.ts:482` and `relayFanOut.ts:575`. Nothing in `app/src`,
  `dashboard/src` or `e2e` reads it.
- But it is not filtered out of the presenters, and it has no mapped copy.
  `INTERNAL_CODE_REASONS` holds only `contact_opted_out`
  (`dashboard/src/routes/contact/deliveryStatus.ts:609-611`); `ERROR_CODE_REASONS`
  (`:543-550`) has no such key. So `deliveryReason('transient_cap')` takes the unmapped
  fallback at `:638-640` and returns **`"Delivery failed (error transient_cap)"`**.
- `presentRelayDelivery` excludes only `contact_opted_out` from its failure set
  (`:400`, `:403-405`), so the leg counts as failed and that string is joined into the
  rollup chip's reason (`:412-419`); `presentLegDelivery` behaves the same way (`:520`).

**Implies.** On the Sec 3.4a path an operator reads "error transient_cap" - i.e. "we
retried to the cap and gave up" - when the queue was down and **zero** retries were
attempted. That is an actively misleading diagnosis in a branch whose entire premise is
that misdiagnosable stuck states are expensive; it also erases the one signal that would
tell an operator the queue, not the carrier, is the problem. The fix is free because
nothing branches on it: write a distinct code (`enqueue_failed`) on the Sec 3.4a path
and keep `transient_cap` for genuine cap exhaustion. If you keep one code, say in Sec
3.4a that it is deliberately overloaded and why.

---

## R6-4. [LOW] Sec 3.4's justification names the wrong mechanism, and leaves the actual cost unstated

**Answering Q1 directly: the conclusion is right, the stated reason is not, and the real
cost is a different one.**

Sec 3.4: "a duplicate cannot double-send anyway (the per-recipient terminal-status skip
is what prevents that, not the counter)."

What actually prevents it is **the marker**, which still sits above the loop - a
duplicate returns there and never reaches a recipient (R6-1). The terminal-status skip
is the second layer, and its job is to stop a *continuation* (fresh `jobId`, not
suppressed) re-sending an already-`sent` recipient. Both layers exist; the sentence
credits the wrong one.

**The cost the reordering actually incurs is retry budget, not duplication.** A true
duplicate now claims a rung and then returns having done nothing, so a broadcast that
suffers one duplicate delivery gets 2 send passes instead of 3 before its deferred
recipients are marked `failed`. That is a real behavior change - small, rare, and in my
view clearly the right trade against a frozen counter - but Sec 3.4 does not state it,
and it is the thing a reader would want weighed. Replace the parenthetical with: "the
marker still prevents the double-send; what a duplicate costs is one retry rung, which
is cheap against a counter that never advances at all."

---

## R6-5. [LOW] The terminal-status skip does not cover the send-to-slot-write window - and the issue explicitly asks for this to be confirmed

The filed issue closes with: "The per-recipient terminal-status skip already provides it
independently, **which is worth confirming before relying on it.**" Confirming it:
it does not, in one window.

**Evidence.** The skip sets are `sent | delivered | failed | skipped`
(`broadcastFanOut.ts:122-127`) and `sent | delivered | failed`
(`relayFanOut.ts:157-160`). A recipient sits at `queued` between the provider send and
the slot write - `relayFanOut.ts:504` (adapter send) to `:544` (`markRecipient`), and
`broadcastFanOut.ts:320` (`sendMessage`) to `:333` (`recordRecipient`). A pass that
re-enters over that window re-sends. Note also that relay's set omits `undelivered` and
`queued_pending`, so those are re-sendable too.

In production this is unreachable while the marker guards the loop, and the window is a
pre-existing crash-orphan case this branch does not touch. It becomes reachable only
when `jobId` is absent from context, where both handlers log
"no jobId in context - duplicate-delivery guard skipped" and **fall through**
(`broadcastFanOut.ts:229-234`, `relayFanOut.ts:350-355`) - i.e. outside `dispatchJob`.
Worth one line in the issue so whoever picks it up does not rely on the skip alone, since
the issue asked the question.

---

# Direct answers

**Q1 - is there a path where a pass is consumed but no work is attempted, and does it
matter?** Yes: a true duplicate claims and then returns at the marker. It does not
matter for double-sends (the marker prevents those), but it does cost a retry rung -
which is the trade to state. Your justification's conclusion holds; see R6-4 for the
attribution and R6-5 for the one gap in the skip itself. Your premise does **not**
collapse.

**Q2 - is `transient_cap` a lie, and does anything read it?** A lie on the Sec 3.4a
path; nothing branches on it; it is nonetheless rendered to staff verbatim as
"Delivery failed (error transient_cap)". See R6-3.

**Q3 - are tests 3/5/7a/7b observable and discriminating?**

| test | observable? | fails on `main`? | fails against throw-and-redeliver? |
|---|---|---|---|
| 3 (dead queue terminal in one pass) | yes - asserted on the broadcast row | yes | **yes** - that design never reaches finalize |
| 5 (claim walks 1,2,3 across continuations) | yes | yes (no attribute on `main`) | **no** - both designs pass it |
| 7a (same-`jobId` redelivery still advances) | yes | yes | **yes** - this is the discriminator for the ordering |
| 7b (duplicate cannot double-send) | yes, but not of what it names | no | no |

Test 3's inline warning ("It must NOT be written as throw, then redeliver, then reach
the cap - such a test would pass vacuously") is exactly the right guard rail, and 7a is
the test that makes the ordering non-tidyable. Test 5 is a fine positive test; it simply
is not a regression test for this change, which is fine as long as 7a carries that
weight. Only 7b needs rewording (R6-1). I also confirmed the previous round's 7a
("an UNKNOWN send error also reaches the cap") is correctly **gone** - under the
immediate-close design that path no longer reaches the cap, which is the filed issue, so
no test is owed and none dangles.

**Q4 - is the issue's diagnosis correct and its severity right?**

Diagnosis: correct at every cited line. I independently re-verified `jobs.ts:188`
(mint at enqueue), `:262` (complete envelope used verbatim), `:286` ("the stable
jobId"), `messagesRepo.ts:2630-2649` (conditional PUT, no TTL), and
`retrySend.ts:122-128` as the correct counter-statement.

Severity `high`: right, and if anything under-argued - see R6-2, the failure produces no
DLQ entry and therefore no alarm, so it is silent rather than merely unrepaired.

Is "hangs on Sending permanently" overstated? **No - it is if anything understated.**
`finalize()` is called only from inside the handler (`broadcastFanOut.ts:493` and
`:513`), the throw at `:459` is mid-loop, and nothing else finalizes a broadcast. So the
row stays as `markSending` left it, permanently. Worth adding: because the throw exits
the `for` loop at `:263`, **every recipient after the failing one is never attempted at
all** - so the blast radius is the remainder of the audience, not one recipient. One
unrecognised error on recipient 3 of 800 strands 798 of them.

The one thing to fix in the issue is the DLQ mechanism (R6-2), because it is the
sentence that tells the next person where to look for evidence, and it points at a queue
that will be empty.
