---
id: extraction-manual-flag-survives-reschedule
title: The manualRequested flag survives an ordinary re-schedule, so an inbound-driven run can waive both gates and be logged manual
type: decision
severity: low
status: wontfix
area: app/extraction
created: 2026-08-16
refs: app/src/repos/extractionRepo.ts:241, app/src/repos/extractionRepo.ts:408, app/src/jobs/extraction.ts:382, app/src/jobs/extraction.ts:470, app/src/jobs/extraction.ts:491, docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md
---

**A deliberate, specified design, not a bug.** Design section 4.1 argues for it
at length under "Why a sticky flag rather than a per-request argument", and
section 5 states the consequence directly. Filed here because two independent
reviewers rediscovered the behaviour from the code and read it as a defect, and
because it is the reason `trigger: manual` in the AI run log does not mean "an
operator pressed at this moment".

**Behaviour.** `manualRequested` (and `requestId`) live on the due row.
`claim` REMOVEs both, so a run that is claimed clears the waiver. But
`scheduleExtraction` is an unconditional sliding upsert
(`app/src/repos/extractionRepo.ts:241`) that writes `dueAt` / `_duePartition` /
`channel` only - it cannot clear the flag. Two windows follow:

1. **Between press and claim.** An inbound message slides `dueAt`; the flag
   survives; the run that eventually fires reads
   `row.manualRequested === true` (`app/src/jobs/extraction.ts:382`), waives the
   30-day age floor (`:470`) and the "nothing new since the cursor" gate
   (`:491`), and is recorded `trigger: 'manual'`. This one is unambiguously
   right: there IS a press behind that run, the operator's.
2. **Across a failed manual run's backoff.** `fail`'s re-arm branch re-SETs the
   flag whenever the run was manual (`app/src/repos/extractionRepo.ts:408`), so
   every backoff retry up to the five-attempt park also waives both gates and is
   also logged `manual`. The `requestId` is deliberately NOT restored, so no
   operator indicator is watching those runs, and an inbound landing inside that
   window slides `dueAt` without clearing the flag either.

**Why it is accepted.** Design 4.1 weighs the alternative (a per-request
argument) and rejects it: the row is the only place a waiver can survive a
sliding upsert, and losing the waiver would silently downgrade the operator's
press into an ordinary run. It also names the cost - "a real duplicate cost on a
rare path ... it is why section 6's per-press cost is a floor rather than a
fixed price."

**Operational consequence, already in the runbook.** A `manual` row in the AI
run log on a conversation nobody just pressed is expected, and one press can
bill more than once on a thread whose runs keep failing. See the "How long the
waiver lives" paragraph under "Run AI extraction (the operator's button)" in
`RUNBOOK.md`.

**If it is ever reopened.** The narrow half worth revisiting is (2), not (1):
clearing the flag on the LAST backoff retry, or on park, would bound the
duplicate cost without touching the press-to-claim window that the design
actually argues for. Park already REMOVEs the flag.
