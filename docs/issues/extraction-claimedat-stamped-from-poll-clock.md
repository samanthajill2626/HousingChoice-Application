---
id: extraction-claimedat-stamped-from-poll-clock
title: claim() stamps claimedAt from the poll-wide clock, and nothing reads it
type: debt
severity: low
status: open
area: app/extraction
created: 2026-08-16
refs: app/src/repos/extractionRepo.ts:337, app/src/repos/extractionRepo.ts:360, app/src/jobs/extraction.ts:657
---

**Pre-existing.** This is NOT created by the manual-extraction-trigger feature.
Found while specifying the withdrawn in-process runner (design section 9, item 2)
and filed rather than fixed.

**Problem.** `claim` stamps `claimedAt` from the `nowIso` it is handed, not from
the moment of claiming:

```
app/src/repos/extractionRepo.ts:337
':claimedAt': nowIso,
```

That `nowIso` is the poll-wide timestamp. `runDueExtractions(nowIso, deps)`
(`app/src/jobs/extraction.ts:657`) takes it once as a parameter for the whole
pass, uses it for `listDue(nowIso)` (`:665`) and then passes the SAME value to
`repo.claim(conversationId, nowIso, listedDueAt)` (`:400`) for every row in the
batch. A pass over many rows, each awaiting an unbounded model call
(see [`extraction-driver-call-unbounded`](./extraction-driver-call-unbounded.md)),
can run for a long time, so a later row records a claim time already minutes -
potentially far more - in the past.

**Nothing reads it.** Verified by grep over the tree: on the extraction due row,
`claimedAt`, `lastRanAt` and `lastError` have ZERO readers anywhere. They are
written by the repo (`claim` sets `claimedAt` at `:337`; `complete` sets
`lastRanAt` and clears both at `:360`; `fail` sets `lastError` at `:396`, `:426`,
`:453`), declared on the item type (`:72`, `:75`, `:76`), and asserted in the
repo's own unit tests (`app/test/extractionRepo.test.ts:454`, `:469`, `:488-502`).
No service, job, route, dashboard component or e2e spec branches on any of them.
They are write-only fields.

That is exactly why the stale stamp is harmless TODAY and exactly why it would
bite whoever first uses it. The obvious first consumer is a staleness reaper for
[`extraction-stranded-claim-no-reaper`](./extraction-stranded-claim-no-reaper.md):
such a reaper would compute `now - claimedAt` and, on a late row in a long pass,
conclude a fresh claim is already stale and re-arm a run that is still executing.

**Suggested fix.** Stamp `claimedAt` inside `claim` from the repo's own clock
rather than from the caller's pass-wide value, keeping the pass-wide `nowIso` for
the `dueAt <= :now` predicate where a stable batch cutoff is the correct
semantics. Do this BEFORE building anything that reads `claimedAt`.
