---
id: abandoned-journal-pii-until-next-contact-read
title: An abandoned resolution journal keeps its PII snapshot until that contact's suggestions are read again
type: decision
severity: low
status: resolved
area: app/suggestion-resolution
created: 2026-08-09
resolved: 2026-08-25
refs: app/src/services/suggestionResolution.ts:469, app/src/routes/suggestions.ts:101, app/src/lib/tables.ts:522
---

**Problem.** An ACTIVE `resolve#<contactId>#<target>` journal holds the whole
`SuggestionItem` snapshot (the suggested phone number, address or free-text
value) plus the replay plan's patch and audit payload. Completion scrubs all of
it - `makeCompletedResolution` keeps only ids, action and a completion time - but
only completion scrubs it.

Recovery is deliberately LAZY. The only driver is a read of that same contact's
suggestions (`routes/suggestions.ts:101` -> `recoverAbandoned`) or a later
resolution request for the same target. So a journal abandoned by a crash on a
contact nobody opens again - a soft-deleted contact, an inactive tenant, a
duplicate created by import - retains its snapshot indefinitely. The
`ai_extraction` table declares no `ttlAttribute` (`lib/tables.ts:522-560`), by
design.

**Decision (accepted residual).** This is accepted, not overlooked. The worklist
constraints for this branch forbid a TTL on `ai_extraction` and forbid new
infrastructure (no sweeper job, no scheduled scan, no new table or index), and
the operator-visible half of the problem - a crashed action that no card can
resume - is fully fixed by the lazy hook. The remaining exposure is a small
number of rows in an internal table that no API, GSI or pending list can return
(`resolve#` rows carry neither `ownerContactId` nor `_pendingPartition`).

**Revisit if** a periodic sweep is ever sanctioned: the worker already has a poll
loop and could complete expired journals for every contact, or a TTL could be
added to `ai_extraction` if the table's other row kinds (`sugg#`, `dism#`,
`due#`) can tolerate one - the permanent dismissal tombstones in particular must
NOT expire, so a table-wide TTL is not a drop-in.

**Resolution (2026-08-25).** The revisit condition above is exactly what
happened. The operator SANCTIONED the periodic sweep on 2026-08-24, on the
existing worker poll loop - no new tables, no new indexes, and still no TTL on
`ai_extraction` (the dismissal-tombstone objection stands). Built on
`feat/log-hygiene` as `app/src/jobs/journalSweep.ts`, a duty registered with
`startPoll('journal sweep', ...)` and cadenced ONCE PER DAY through the same
settings-record conditional claim the group-guardrail duties use; the record-id
union widens by one id (a code edit, not a schema change), the runner takes a
`force` bypass, and a triple-gated `POST /__dev/journal-sweep/tick` exists
because without it the duty is untestable from e2e - worker logs never reach the
app logtail.

WHAT IS BEING APPROVED, stated rather than buried: this is not only a PII scrub.
`recoverAbandoned` drives abandoned journals through `applyJournal`, which
COMMITS the abandoned human decision - contact/phone writes, PERMANENT `dism#`
dismissal tombstones, activity rows, audit rows backdated to the journal's
`claimedAt`, and ai_runs verdict stamps - and only then scrubs. These are the
identical semantics a READ of that contact's suggestions triggers today; the
sweep makes them time-driven. Three consequences follow:

- The 24h gate bounds which CONTACTS are visited, not which journals complete.
  Recovery filters on lease expiry alone, so a journal abandoned 31 seconds ago
  IS committed if its contact also carries a 25-hour-old one. "Nothing under 24h
  is auto-committed" would be FALSE.
- The phone-conflict ending is `release()`: the journal is deleted and the
  pending suggestion snapshot is RE-PUT, so a suggestion chip an operator already
  resolved can REAPPEAR on a live dashboard - with the SSE emit, in real time,
  possibly at 3am. Rare, bounded, and the machinery's own existing behavior, but
  user-visible.
- The backlog drains at the caps' rate. Every daily run enumerates all qualifying
  journals the same way (no first-run special case), so a backlog of N contacts
  commits over ceil(N/25) days.

ENUMERATION - a bounded daily Scan, deliberately NOT an index. This decision
REVERSED TWICE and the history is kept because of it: the first draft proposed
the Scan; adversarial round 2 refuted its "no alternative" justification with a
sparse `byDueAt` index idiom and the spec ADOPTED that; a round-3 deep
verification of the byDueAt lifecycle then refuted the adoption on stronger
grounds, and the spec returned to the Scan. Why the index loses:

- PII INVERSION. Every `ai_extraction` GSI projects ALL (hardcoded in the
  terraform module). Indexing `resolve#` rows would copy each active journal's
  FULL PII snapshot and replay plan into the index - destroying the very
  accepted-residual safety property this file records above, that no API, GSI or
  pending list can return these rows. A PII-hygiene mission must not be the
  change that puts journal PII into a GSI.
- LIFECYCLE FRAGILITY. Legacy rows never enter a sparse index without a backfill
  writer; `takeover()` would need both key attributes; `complete()` is a
  whole-item Put, not a REMOVE edit; and the backfill's gating signal
  (cadence-record absence) is destroyed by claim-first ordering, by `force`, and
  by devReset - four independent ways to orphan PII permanently.
- Write amplification on every claim/takeover/complete, for a once-a-day
  consumer.

The Scan, with its costs stated: one paginated Scan per day with
`FilterExpression: begins_with(#id, :p) AND #state = :active` (`state` is a
reserved word and is aliased). THE AGE GATE IS APPLIED IN THE APPLICATION, not in
the FilterExpression - a server-side filter never returns the excluded row, so no
fail-toward-scrub rule could run there, and a non-ISO value would be decided by
ASCII ordering. A returned row qualifies when
`Date.parse(claimedAt) <= nowMs - 24h`, and an UNPARSEABLE `claimedAt`
QUALIFIES (fail-toward-scrub). This is the system's first recurring production
Scan and is recorded as such; `dynamodb:Scan` was already granted.

Adopted during the build as a required strengthening: `listActiveResolutionRows`
sets a `ProjectionExpression` of `contactId, target, leaseExpiresAt, claimedAt`
(both `target` and `state` are DynamoDB reserved words, so both are aliased), so
the Scan never reads a journal's snapshot or replay plan into memory at all. An
integration test asserts the returned row keys are exactly those four and that a
seeded suggestion value never appears in the serialized page.

CURSOR, without which the page cap would ORPHAN rows permanently (a Scan restarts
from the table's internal ordering every run while tombstones occupy the same
prefix): each run persists its final `LastEvaluatedKey` in a dedicated
`journal-sweep-cursor` settings row, the next run resumes from it, and a run that
exhausts the table clears it and wraps to the start. With the cursor the caps are
genuine RATE limits - every row is eventually examined, work is deferred, never
stranded.

CONSTANTS, as built: `JOURNAL_SWEEP_MIN_AGE_MS` = 24h, `MAX_CONTACTS_PER_RUN` =
25, `MAX_RECOVERY_CALLS_PER_RUN` = 100 (the bound that actually governs write
volume), `MAX_SCAN_PAGES` = 20, `SCAN_PAGE_LIMIT` = 200. `recoverAbandoned` gains
an OPTIONAL `maxAttempts`, default 2 so the read path's existing budget is
preserved exactly, and the sweep passes 12 - the size of the closed
`DECISION_TARGETS` key set - so a poison pair of persistently-failing journals
cannot starve the other ten. In normal operation NONE of the caps binds; during a
backlog drain `MAX_CONTACTS_PER_RUN` is the one designed to bind first, and it is
the 25-contacts-per-day drain rate promised above. Contact ids are DEDUPLICATED
across the run before dispatch, because one contact can own up to 12 journals and
without dedup the 25-contact cap would behave as a two-contact cap.

CLAIM-FIRST HONESTY: the cadence stamp lands BEFORE the work and has no release
path, so a mid-run failure burns the day. That is accepted on the condition that
the failure is loud, with the level matched to its meaning - alarm-feeding ERROR
when the body throws or when the post-loop truth check finds persistent actives
(poison journals, genuine operator attention), but INFO when a cap or the page
bound merely defers work, because the cursor carries the progress and a bound-hit
must not become a standing alarm in a mission about alarm noise. The post-loop
truth check re-reads the contact's journals through the existing `listJournals`
and WARNs with COUNTS AND IDS ONLY, never values, and only when a row is still
active, lease-expired and past the age gate. The run emits `suggestion.updated`
once per contact when any call in its loop reported `stateChanged` (the
terminating call always reports false), and the event bridge forwards that to app
SSE in every deployed and lane environment.

RESIDUAL CARRIED FORWARD, unverified: the production `ai_extraction` ItemCount.
One run examines at most `MAX_SCAN_PAGES * SCAN_PAGE_LIMIT` = 4,000 rows, so a
full cursor cycle takes ceil(tableRows / 4000) daily runs, and the
never-permanently-orphaned property holds only while the table grows slower than
4,000 rows per day. If that table ever reaches 100k+ rows the caps need raising.
Stated in the module header as well as here.
