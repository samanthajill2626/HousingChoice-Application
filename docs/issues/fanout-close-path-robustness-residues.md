---
id: fanout-close-path-robustness-residues
title: Residues in the fan-out close paths - a throwing close or finalize strands recipients, and an ambiguous enqueue failure over-closes
type: bug
severity: med
status: open
area: jobs
created: 2026-09-01
updated: 2026-09-27
refs: app/src/jobs/broadcastFanOut.ts:443, app/src/jobs/broadcastFanOut.ts:1104, app/src/jobs/broadcastFanOut.ts:1452, app/src/jobs/relayFanOut.ts:1244, app/src/jobs/relayFanOut.ts:1507, app/src/lib/guardWrite.ts:16, app/src/routes/broadcasts.ts:773
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

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

The send-outcome design leaves both close loops' shape to this issue (spec
Sec 2) and adds its failure-arm writes to item 1's class "one step earlier"
(spec D7a). What the build left, at the branch's HEAD (`b7b3f24b`); the refs
above are re-anchored there.

**Item 1 - narrowed.** Each close now passes every recipient through the
send-attempt record gate inside its OWN try/catch (`closeBroadcast`,
`app/src/jobs/broadcastFanOut.ts:443-499`, the catch at `:474-476`;
`closeRelay`, `app/src/jobs/relayFanOut.ts:1244-1293`, the catch at
`:1275-1277`), so one throwing recipient no longer skips the rest, the
operator line or (broadcast) `finalize`. The failed recipient is logged at
ERROR with `label: 'capClose'` and left as it was - reported, not silently
completed, as the caution above asks. What can still throw is broadcast
`finalize` itself (`broadcastFanOut.ts:1452-1513`: its consistent read at
`:1459`, its conditional flip at `:1476`), called from the close (`:498`) and
at the end of every pass (`:1118`). A throw there fails the job under its
marker and leaves the broadcast `sending` with every slot terminal (or owned
by a live attempt) until some other writer's `finalize` runs - a later
reconcile verdict or continuation for the same broadcast; with none pending it
stays `sending` (build S2a residue).

**The D7a failure-arm writes.** Every write a send site makes from a failure
arm now goes through `guardWrite` (`app/src/lib/guardWrite.ts:16-29`), which
logs one ERROR (the owner ids, the redacted recipient key, a `label`) and never
throws, so no arm can throw out of the recipient loop. The arms: broadcast
`handOff` (`broadcastFanOut.ts:572-597`), `handToReconcile` (`:608-624`),
`deferClaimed` (`:630-637`), `declineAtFence` (`:645-678`), `onRejected`
(`:681-748`), `onUnknown` (`:756-779`), the refusal arm (`:936-959`), the
pre-claim deferral (`:917`) and the cap-close's `closeRedriven`
(`:466-473`); relay `handOff` (`relayFanOut.ts:1196-1226`), the cap-close's
`closeRedriven` (`:1267-1274`), `closeRedriveRefused` (`:1683-1722`) and the
leg unit's catch (`:2063-2238`); the rung's `handOff` and `closeUnlessOwned`
(`app/src/jobs/relayRetryLeg.ts:641-669`, `:691-729`). Each arm writes the
slot first and the attempt record second, as two separate guarded writes, so
a write that fails leaves only its own half as it was. When the record half is
the one lost, the record stays open (`attempting`, or `reconciling` after a
hand-off's enqueue-failure close) and the recipient is
[send-attempt-sweeper](./send-attempt-sweeper.md)'s, as spec Sec 1 records.
A lost hand-off - the `handToReconcile` write itself failing - is STRANDED
instead of thrown (`broadcastFanOut.ts:608-624`; `relayFanOut.ts:2098-2112`):
the record stays `attempting` and the recipient is carried with no slot write;
on broadcast a continuation's claim or the cap-close takes the stale record
over into reconcile, on relay it outlasts the ladder and is the sweeper's.

**Plan deviation 3 (declared).** A send site's OWN post-claim slot write keeps
only the slot's existing guards and is not fenced on the attempt record:
broadcast `recordRecipientOutcome` from `['queued']` and
`closeRecipientIfQueued`; relay `persistRelayRecipientResult`
(`relayFanOut.ts:2375-2395`), forward-only on a versioned row and the
whole-slot `markRecipient` on a legacy one (`:2398-2410`). The slot is written
BEFORE the fenced `finishAttempt`; a fence lost after the slot write (the
record was taken over during a long call) is a WARN and the slot is not rolled
back (`broadcastFanOut.ts:890-905`; `relayFanOut.ts:2028-2061`) - the
takeover's reconcile finds the SID through the `sid#` row or the `relaysid#`
pointer and repairs.

**Item 2 - unchanged, and the branch adds members.** Close C still closes on
ANY enqueue throw (`broadcastFanOut.ts:1091-1111`; `relayFanOut.ts:1490-1509`),
now through the record gate. Every enqueue this branch adds does the same: the
reconcile hand-off closes the recipient `send_unconfirmed` with its record
`done`/`unresolved` (`broadcastFanOut.ts:572-597`, `relayFanOut.ts:1196-1226`,
`relayRetryLeg.ts:641-669`), and the reconcile job's own check and re-drive
enqueues close it too (`app/src/jobs/sendReconcile.ts:904-936`). None of them
can double-send when the enqueue did land: a landed check finds the record
`done` and exits superseded (`sendReconcile.ts:385-395`), and a landed
re-drive either finds the record already claimed (the close is fenced on
`redriven` and writes nothing, `:920-927`) or finds the slot terminal and
skips it. The cost is item 2's: a recipient closed that the landed job might
have resolved.

**Item 3 - narrowed.** The snapshot terminality guard stays
(`broadcastFanOut.ts:451`, `relayFanOut.ts:1250`), but the slot write behind it
is now itself conditional - `closeRecipientIfQueued` (a broadcast slot must
still be `queued`) and `closeRelayRecipientIfUnsent` (a relay slot must be
absent, or `queued` with no `sid`; `app/src/repos/messagesRepo.ts:3949`) - so
a future caller passing an unsafe set can no longer overwrite a send that
landed (spec D8).

**Item 4 - unchanged.** The branch's new closes reuse `enqueue_failed` as a
slot code (`app/src/lib/sendOutcome.ts:19`).

**New item 5 - the close's operator line overstates what it closed (low).**
Both closes still log `fan-out closed - remaining recipients marked failed`
with `deferred` counting every key passed in (`broadcastFanOut.ts:487-497`,
`relayFanOut.ts:1281-1292`), although a recipient the record gate leaves to
its own live attempt is not marked (an INFO names each one, `:461` and
`:1260`). Left unchanged on the branch because the close tests match the line
(build S2a concern 3).
