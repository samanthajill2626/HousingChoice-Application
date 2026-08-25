---
id: journal-sweep-truth-check-lease-collision-false-positive
title: The journal sweep's persistent-failure ERROR can false-fire on a journal a concurrent actor is legitimately holding
type: bug
severity: low
status: open
area: app/suggestion-resolution
created: 2026-08-25
refs: app/src/jobs/journalSweep.ts, app/src/services/suggestionResolution.ts, app/src/repos/suggestionResolutionRepo.ts
---

**Problem.** The daily journal sweep's post-loop truth check counts a contact's
remaining journals with `state === 'active' && pastTheAgeGate(claimedAt)` and
DELIBERATELY omits the lease clause - recoverAbandoned's takeover bumps
`leaseExpiresAt` on every attempt, so a lease-aware predicate made the
poison-journal ERROR structurally unreachable (the phase-6 fix that introduced
the age-only form). The cost of that fix is two narrow false-positive windows:

1. CONCURRENT HOLDER: a suggestions READ (`routes/suggestions.ts` ->
   `recoverAbandoned`) or another process takes over a >24h-old journal within
   ~30s (DEFAULT_LEASE_MS) of the sweep's truth-check re-read. The journal is
   active, live-leased (so the sweep itself skipped or lost it), and past the
   age gate - counted and ERROR'd as a "persistent failure" while it is being
   handled correctly.
2. MID-APPLY RACE: the sweep's own recovery completed the takeover but the
   apply is still mid-flight at re-read time (noted at handback as
   self-clearing).

Both windows are seconds wide, at most 25 contacts are visited per day, and the
false ERROR self-clears on the next run - but the line feeds
`hc-<env>-error-logs`, and this mission's charter is exactly "no alarms nobody
can act on".

**Suggested fix (when it ever fires in practice).** Make the truth check
re-read once more after DEFAULT_LEASE_MS + a margin before ERRORing, or carry
the sweep's own attempted-journal set and only ERROR on journals IT attempted
that remain active past a fresh lease expiry. Do not reintroduce a bare lease
clause - that is the unreachable-alarm defect the age-only form fixed.
