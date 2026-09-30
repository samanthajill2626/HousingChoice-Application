# Round-3 re-review of feat/today-past-tours @47e7d1fe - findings and rulings

Two sections, kept apart: the reviewer's findings as returned, then the
planner's rulings.

## Findings (same reviewer, continued; read-only, ran nothing)

Totals: blocking 0, high 0, medium 0, low 2 new (confirmed), 1 plausible nit.
Concedes N3 (event filter) and P-b; contests N1 with an alternative.

**R3-1 (low) - the name-cache test can pass without the cache.**
`useTodayPastTours.test.tsx:197-212` waits for 2 rows after the reload, which
the stale rows already satisfy; nothing waits for the relabel pass, so the
call-count assertions can run before its lookups. Suggested: serve a third
tour on reload, wait for it to show, then count (only its lookups are new).

**R3-2 (low) - a cached contact outlives a soft-delete, so Today's two
sections disagree.** The cross-reload cache (`useTodayPastTours.ts:64-89`)
answers from the pre-delete contact, so `isDeletedContact` never sees
`deleted_at`; a delete in another tab drops the tenant from the queue
(useToday refetches on the `conversation.updated` the delete emits,
`contacts.ts:2258`) while the past section keeps the rows until remount. The
comment's "same horizon as the Past tab" does not hold: there deletion only
affects a label, on Today it decides visibility. Suggested: at least correct
the comment; better, cache units only and re-read the listed tenants.

**N1 contested.** The skeleton was rightly dismissed, but the only content
below the insertion point is "AI suggestions to review": hold that group until
the section settles (`past.status !== 'idle'`) - nothing above moves, nothing
flashes, no row count needed; the shift disappears instead of shrinking.

**P3-1 (nit) - the new collect.ts comment overstates its premise.** Browser
write-blocking does not stop worker-side emits (`rosterActions.ts:159-162`);
if one fires during a Today sample the reload's GETs are TODAY_GETS shapes and
only lengthen the sample. Suggested: "rarely fires while sampling".

Reviewed as correct: the LabelCache/cachedLookup failure and abort semantics,
the unit prefetch, reloadFailed and its note, the nag Open state, the perf
declaration removal and the refreshed citations, the e2e createTour
registration and the pane assertion.

## Rulings

| # | Ruling | Why |
|---|---|---|
| R3-1 | ACCEPT | The test now serves a third tour on reload and waits for it before counting (3 unit reads: only the new one; 5 tenant reads: every pass re-reads). Mutation-checked: with the cache write removed the test fails. |
| R3-2 | ACCEPT (the better fix) | Only property lookups persist across reloads; tenants are re-read every pass (de-duplicated within it), so a delete made elsewhere takes effect on the next reload. New test: a tenant deleted between reloads leaves the section. Properties carry no visibility rule. |
| N1 | ACCEPT the reviewer's alternative | Every group placed below the section (by GROUP_META index, today only AI suggestions) is held until the section settles - ready, empty or failed. Tests for held and released. |
| P3-1 | ACCEPT | Comment reworded. |
