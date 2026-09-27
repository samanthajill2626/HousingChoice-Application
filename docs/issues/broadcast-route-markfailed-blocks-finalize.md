---
id: broadcast-route-markfailed-blocks-finalize
title: The broadcast send route marks a share failed on ANY enqueue throw, and the now-conditional finalize cannot undo it when the fan-out ran anyway
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-27
refs: app/src/routes/broadcasts.ts:761, app/src/repos/broadcastsRepo.ts:619, app/src/repos/broadcastsRepo.ts:937, app/src/jobs/broadcastFanOut.ts:370, app/src/jobs/broadcastFanOut.ts:1514
---

**Problem.** The staff send route marks the share `sending`
(`markSending`, conditional on `draft`,
`app/src/routes/broadcasts.ts:745-759`) and then enqueues the fan-out
(`:762`). When that enqueue throws, it logs ERROR, calls
`markFailed(broadcastId, 'enqueue failed')` (`:768-772`) and answers 500
`enqueue_failed` (`:773`). `markFailed` is `flipStatus`
(`app/src/repos/broadcastsRepo.ts:619-645`, `:989-991`), which is
UNCONDITIONAL apart from `attribute_exists(broadcastId)` (`:637`).

An enqueue failure can be ambiguous: an SDK timeout or a lost response after
SQS accepted the message. The job then runs anyway - the fan-out reads its
snapshot (`app/src/jobs/broadcastFanOut.ts:370-374`) and never looks at the
share's status - so every recipient is texted and every slot moves as usual.
But `feat/send-outcome-reconcile` made finalize CONDITIONAL:
`finalizeStatus` flips only a share that is still `sending`
(`broadcastsRepo.ts:937-983`, the condition at `:961`), and `finalize`
(`broadcastFanOut.ts:1514-1575`) treats `won: false` as "already done"
(`:1538-1542`). A share the route already flipped to `failed` therefore
stays `failed` with `last_error` "enqueue failed", and the `broadcast_sent`
unit audit row and the terminal SSE emit are skipped (`:1543-1555`). Main's
unconditional `markSent` used to flip it back.

**User-visible.** A share whose texts all went out shows Failed ("enqueue
failed") in its header, while its recipient rows show the sends; the
property's Activity card misses the `broadcast_sent` row. No double send:
a second click on Send is refused 409 because the share is no longer a draft
(the route's draft guard, `broadcasts.ts:599-602`).

**Trigger.** An SQS enqueue from the route that fails ambiguously - the
message landed although the call threw. Rare.

**Already fixed on the branch: the other half of the finding.** Round 1's
ADV-8 also named a `finalizeStatus` false negative on the SDK's own replay
(a flip that committed, retried, and failed its own condition - no audit row,
no terminal emit). FW1-5 closed that with the `finalize_op` token: a
read-back carrying this call's token is a win (`broadcastsRepo.ts:937-983`,
the token at `:943-944`, the read-back at `:972-977`). Only the route's
unconditional mark remains.

**Suggested fix.** None was recorded by the review. Options, for whoever
picks it up: let `finalizeStatus` also flip a share the route marked (status
`failed` with `last_error` "enqueue failed") when the fan-out finalizes it; or
have the route leave the ambiguous case to a later decision instead of a
terminal mark. Either must keep the route's honest outcome for an enqueue
that really failed (no job will ever run).

**Why it was not fixed on the branch.** Ruled RESIDUE in code review round 1
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/r1-adjudications.md`,
sections 1 and 4; the finding is `r1-adversarial.md` ADV-8): it needs an
ambiguous queue failure, it mislabels and never sends twice, and the route
was outside the branch's scope.

**Related.** [fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md)
(item 2: the fan-outs' own "any enqueue throw means refused" reading; item 4:
this route's `enqueue_failed` error string).
