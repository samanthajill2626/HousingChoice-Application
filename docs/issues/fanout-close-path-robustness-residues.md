---
id: fanout-close-path-robustness-residues
title: Four residues in the fan-out close paths - a throwing close strands recipients, and an ambiguous enqueue failure over-closes
type: bug
severity: med
status: open
area: jobs
created: 2026-09-01
refs: app/src/jobs/broadcastFanOut.ts:265, app/src/jobs/broadcastFanOut.ts:614, app/src/jobs/relayFanOut.ts:844, app/src/jobs/relayFanOut.ts:1090, app/src/routes/broadcasts.ts:768
---

Four findings from the planner's plan-blind adversarial review of
`feat/retry-counter-durable` at handback. **None is a regression** - each is
either a shape inherited from `main` or a new-but-strictly-better path - so they
were filed rather than fixed at verdict time. Grouped because they all live in
the same two close helpers.

## 1. A throwing close strands the recipients it was closing (med)

`closeBroadcast` (`broadcastFanOut.ts:265`) and `closeRelay`
(`relayFanOut.ts:844`) loop over recipients issuing writes, with no wrapper. A
throw partway through - a DynamoDB write failure, a throttle - leaves the
remaining recipients `queued`, skips the operator ERROR line, and (broadcast)
skips `finalize`. The job then throws, and its redelivery is suppressed by the
job-execution marker, so nothing repairs it.

This is **the branch's own invariant turned on the close itself**: if the
mechanism that reaches a terminal state fails, does this path still reach one?
Here the answer is no.

Not a regression - `main`'s cap branch has the identical unwrapped loop - but
the branch put more traffic through that shape (three closes rather than one),
so it is worth closing properly.

Careful with the obvious fix: wrapping the loop in a try/catch that swallows
would hide real write failures and report a clean close that did not happen. A
partial close needs to be *reported as partial*, not silently completed.

## 2. Close C treats any `enqueue` throw as "the queue refused" (med)

`broadcastFanOut.ts:614` / `relayFanOut.ts:1090` close the entity
`enqueue_failed` on ANY exception from `enqueue`. An SDK timeout that fires
AFTER SQS accepted the message is indistinguishable at that point, so the
continuation really is scheduled, the recipients are marked failed anyway, and
the continuation later arrives to find nothing to do.

Strictly better than `main` (which left the row `sending` forever), and the
recipients do reach a terminal state, so this is a refinement rather than a
defect: the cost is a recipient marked failed that a landed continuation might
have delivered.

## 3. `closeRelay`'s terminality guard is dead at both call sites, and unsound
for a third (med)

The guard skips slots already in a terminal state. Both current callers pass
sets that cannot contain one, so it never fires today. The concern is the
future caller: on that path `queued` means a SUCCESSFUL send awaiting a receipt,
and `undelivered` is a real carrier 30003 - neither is safe to treat as
"already terminal, skip". A third caller added without re-deriving the set's
meaning would silently skip recipients it should close.

Either delete the dead guard or document what a caller's set must guarantee.

## 4. `enqueue_failed` collides with an unrelated HTTP error string (low)

`routes/broadcasts.ts:768` already returns `res.status(500).json({ error:
'enqueue_failed' })` for a failed broadcast enqueue at the API layer. The new
per-recipient `errorCode` uses the same token in a different namespace. No
functional collision - nothing branches on either - but a grep for
`enqueue_failed` now spans two unrelated concepts, and an operator seeing it in
a delivery chip could reasonably search and land on the HTTP path.

## Related

The close paths themselves are correct on the axes that mattered most - the
claim is atomic, no double-send is reachable, the ladder length and delays are
unchanged from `main`, and all three closes leave no recipient `queued` on the
happy path. Those were verified independently at handback and are recorded in
`docs/superpowers/reviews/2026-08-31-retry-counter-durable/code-review/`.
