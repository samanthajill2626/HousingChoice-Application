---
id: one-to-one-delivery-chip-escalates-nondeterministically
title: The 1:1 message chip escalates to "Sent - not confirmed" or not, depending on whether some UNRELATED bubble in the thread armed the ticker
type: bug
severity: med
status: open
area: dashboard/contact-timeline
created: 2026-08-24
refs: dashboard/src/routes/contact/Timeline.tsx:822, dashboard/src/routes/contact/Timeline.tsx:760, dashboard/src/routes/contact/Timeline.tsx:1351, dashboard/src/routes/contact/deliveryStatus.ts:103, dashboard/src/routes/contact/deliveryStatus.ts:112, dashboard/src/routes/broadcasts/broadcastFormat.ts:108
---

**Problem.** A 1:1 outbound bubble computes its delivery chip with

```
presentDeliveryStatus(msg.delivery_status, msg.imported === true ? undefined : Date.parse(msg.at))
```

(`dashboard/src/routes/contact/Timeline.tsx:822-824`), passing NO third argument -
so it reads that function's implicit `Date.now()` default. Everything
`feat/per-recipient-delivery` (2026-08-24) added reads `tickNow` instead, the
thread-level clock the staleness ticker bumps. The ticker's run condition
(`hasTickableLeg`, `Timeline.tsx:760-772`) only ever inspects
`delivery_recipients`, and a 1:1 message has no such map, so a 1:1 bubble buys no
interval of its own.

The chip therefore escalates only if SOMETHING ELSE in the same thread happens to
be re-rendering the timeline. Adversarial review B proved both halves by probe on
`48954405`:

```
PROBE B : a lone 1:1 outbound `sent` message, thread open for an hour of
          simulated time
          -> setInterval never called; the chip still reads "Sent".
PROBE B2: the SAME 1:1 message with any multi-party bubble also in the stream
          -> after 16 minutes it reads "Sent - not confirmed".
```

So two identical messages on two threads escalate differently, and an operator
cannot learn the rule from watching the product: what decides it is whether an
unrelated group send in the same thread is still tickable.

**NOT A REGRESSION.** Before this branch NOTHING in the timeline ticked at all -
`presentDeliveryStatus` was evaluated once per render against `Date.now()` and
there was no interval anywhere - so the 1:1 chip never escalated live on ANY
thread. What the branch changed is that a re-render now sometimes happens, which
makes the pre-existing lazy clock VISIBLE and inconsistent rather than uniformly
inert. The escalation itself, when it does occur, is correct: the leg really has
been quiet past `STALE_SENT_AFTER_MS`.

**The blocker - why it was not simply threaded through.**
`presentDeliveryStatus`'s signature and CALL SHAPE are deliberately frozen on
this branch, and its own doc says so (`deliveryStatus.ts:103-110`, the
"CONVENTION DIVERGENCE" note). Two out-of-scope consumers depend on both:

- the EmailCard chip (`Timeline.tsx:1351`, which calls it with the status ALONE,
  so email never goes stale at all), and
- the broadcasts recipient badge (`dashboard/src/routes/broadcasts/broadcastFormat.ts:108`,
  in a directory the per-recipient branch is required to leave with a ZERO-LINE
  diff).

It also carries the module's opposite opt-out convention - it disables staleness
by WITHHOLDING THE TIMESTAMP, because its `nowMs` is a DEFAULTED parameter where
the newer per-leg functions take `nowMs: number | undefined` and disable by
withholding the CLOCK. Passing `tickNow` in as a third argument is therefore not
a local edit: it changes which clock three call sites read, and it interacts with
the frozen `sent`-only rule. That is a separate, reviewable change with its own
blast radius, not a fix-wave one-liner.

**Suggested fix.** Two candidate shapes, to be weighed together rather than by
size:

1. **Thread the clock and widen the run condition.** Pass the bubble's own
   `bubbleNowMs` into the 1:1 call, and add a clause to `hasTickableLeg` for a
   MAP-LESS outbound `sent` message that can still cross the boundary. That
   clause must be built with the same care as the existing five: it needs its own
   termination argument (a `sent` message with an unparseable `at`, and an
   imported row, must both stay ineligible), or it re-opens the
   non-termination class the ticker doc enumerates.
2. **Decide that the 1:1 chip is deliberately first-render-only** and say so in
   `presentDeliveryStatus`'s doc, accepting that it escalates on the next render
   from any cause. Cheaper, but it leaves the observed behaviour
   thread-dependent, which is the part an operator cannot learn.

Either way the two clocks now living in one component should be documented at the
component level, not only inside the presenter.

**Widened 2026-08-24, planner review.** The set of causes that re-render the
chip grew when the ticker's frozen-clock defect was fixed (`Timeline.tsx`, the
`useEffect` on `visible`). The refresh trigger is "the RENDERED set changed",
which is deliberately broader than "an item arrived" - it must also cover a
paged prepend and a thread switch, both of which are only a `visible` identity
change. A consequence is that toggling a DISPLAY FILTER (`commsOnly`) now
refreshes the clock too, so a staff action unrelated to delivery can change what
this chip says.

That direction is benign - the chip can only become MORE current, never less -
but it is one more thread-dependent input to the behaviour this issue is about,
and option 2 above ("deliberately first-render-only") is harder to state
honestly now that a filter toggle is also a render cause. Pinned by
`Timeline.ticker.test.tsx`'s display-filter case so the breadth is not narrowed
back by someone who reads the trigger as "an item arrived".

Related, same branch and same surface:
[`message-bubble-reveal-not-keyboard-reachable`](./message-bubble-reveal-not-keyboard-reachable.md)
(the reveal that hides the per-recipient rows this chip summarises) and
[`inbound-multi-party-bubbles-have-no-per-recipient-delivery`](./inbound-multi-party-bubbles-have-no-per-recipient-delivery.md)
(the other bubble shape the per-recipient work deliberately did not cover).
