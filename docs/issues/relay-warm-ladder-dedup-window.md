---
id: relay-warm-ladder-dedup-window
title: Hardening - the geographic hint ladder widens warmOneNumber's un-deduped window past the SQS visibility timeout
type: debt
severity: low
status: open
area: app/relay
created: 2026-08-03
refs: app/src/services/poolNumbers.ts:690-720, app/src/services/poolNumbers.ts:738-766, app/src/services/poolNumbers.ts:773-802, infra/modules/jobs/main.tf:30-43, app/src/adapters/sqsJobConsumer.ts:12-18
---

**Problem.** Raised as MUST-FIX M1 by the planner's adversarial review of
`feat/relay-area-code-preference` (`.superpowers/review/planner-adversarial.md`,
2026-08-03), adjudicated DOWN to an issue because the consequence is bounded and
self-healing.

`warmOneNumber` is the only place in the app that BUYS a number, and its only
guard against buying twice for one connecting group is a check-then-act READ:
`findByPendingConversationId(conversationId)` (`poolNumbers.ts:690-720`) with
nothing durable until `createWarming` (`:782`). The geographic hint ladder
(`:738-766`) stretches the critical section between that read and that write from
ONE availability search to `1 (ZIP) + relayPreferredAreaCodes.length + 1 (bare)`
SEQUENTIAL Twilio round trips - 7 for a tour/placement buy and 6 for a buffer
refill under the shipped default `404,470,678,770,943`.

`twilio@6`'s per-request timeout is 30s, so the worst case is ~210s of
successful-but-slow calls against a 120s SQS visibility timeout, whose own
comment states the invariant this can breach: "Visibility timeout 120s must stay
>= the longest job the worker runs (a handler that overruns it gets a duplicate
delivery)" (`infra/modules/jobs/main.tf:30-43`). Average search latency only has
to reach ~17s to cross it. A redelivered `relay.warmNumber` then re-runs the same
read (still empty, nothing written yet) and can buy a SECOND number earmarked to
the same conversation; the consumer processes messages in parallel on purpose
(`sqsJobConsumer.ts`), so the two runs genuinely overlap. This is not confined to
tour/placement groups - the ZIP-less refill path carries 6 rungs.

**Why an issue and not a fix.** The blast radius is bounded and self-healing, unlike
the stranded-number scenario the dedup comment at `poolNumbers.ts:679-689` was
written for: `clearConnectingEarmarks` (`:834`) clears the earmark on group open,
so a duplicate earmarked number becomes a countable FRESH SPARE the next group
consumes rather than a permanently stranded one; and a duplicate refill spare just
overshoots the spare buffer by one until it is consumed. Cost is one extra number
held briefly, not a leaked A2P sender-pool slot. It also requires sustained
multi-second Twilio latency across most rungs, which is not the observed steady
state.

**Suggested fix.** Candidate remedies, recorded as raised:

- an overall ladder time budget,
- a shorter availability-search timeout, or
- a pre-`createWarming` dedup re-check.

(The review's own preference order was: bound the ladder and/or shorten the client
timeout; make the earmark a durable CLAIM taken BEFORE the ladder, in the shape
`tours.ts:846-855`'s `claimGroupThread` sentinel already uses; or raise
`visibility_timeout_seconds`, weakest since it slows every other job's retry.)

**Related design note (same review, S1).** A transient - i.e. NON
`NumberUnavailableError` - SEARCH failure aborts the WHOLE ladder rather than
advancing to the next rung (`poolNumbers.ts:754-763`). That is safe: the ladder
advances only on the one error class that provably means "search came back empty",
so a post-purchase failure can never be walked past into a second buy, the abort
happens strictly PRE-purchase, and the job queue retries the whole job. But it does
mean a single 429/5xx on the ZIP rung fails a buy that a later rung would have
satisfied, and the ladder itself raises `AvailablePhoneNumbers` call volume up to
7x per buy. Advancing past a dedicated search-failure class (e.g. a distinct
`SearchFailedError`) is a deliberate refinement candidate, not a defect today.
