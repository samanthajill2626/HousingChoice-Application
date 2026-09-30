# Round-4 (final, the cap) re-review of feat/today-past-tours @f2334402 - findings and rulings

Two sections, kept apart: the reviewer's findings as returned, then the
planner's rulings.

## Findings (same reviewer, continued; read-only, ran nothing)

Totals: blocking 0, high 0, medium 0, low 2 (confirmed), 1 latent nit, 1
plausible, 1 informational - all in the round-3 "hold the groups below the
section" logic.

**F1 (low) - a queue of ONLY AI suggestions goes blank while the section
loads.** `settling` (`Today.tsx:271`) needs `items.length === 0`, while `held`
(`Today.tsx:314`) hides ai_suggestions when the section is idle: no spinner,
nothing rendered - the L5 blank page again. No test covers it.

**F2 (low, rare) - after a failed first load, a later successful reload hides
AI suggestions again.** `useTodayPastTours.ts:182-183`: 'error' until a reload
succeeds, then 'idle' (labeled still null), so the hold re-applies and the
group vanishes for a round trip and returns below a new section.

**F3 (nit, latent) - a -1 index holds every group.** `PAST_TOURS_AFTER_INDEX`
(`Today.tsx:46`) is a findIndex; drop follow_ups from GROUP_META and every
group is held while the section never renders.

**P4-1 (low, plausible) - the hold has no time limit.** A stalled contact/unit
read now hides core queue content, not just the best-effort section - a new
coupling, distinct from the app-wide no-timeout point. Suggested: release
held groups after a budget.

**I4-1 (informational) - a pre-existing vacuous check gets a wider window.**
`conversation-fact-extraction.spec.ts:350-356,395-401` assert an AI-suggestion
row is absent right after `expectTodayReady` (h1 only); the hold widens the
window in which they pass vacuously.

Reviewed as correct: the units-only cache and per-pass tenant map, the
rewritten (deterministic, cache-sensitive) test, the delete test, the
failed-address test, the perf comment, and all four refreshed citations.

## Rulings

The four hold findings (F1, F2, F3, P4-1) share one cause, and fixing them
means a time budget plus a settled-once flag on top of the hold - more state
to buy back what the hold took away. REVERT THE HOLD instead: N1 returns to
its round-2 ruling (skeleton rejected, one-round-trip latency cut kept),
which rounds 3 and 4 both reviewed. What that leaves: the section can land a
moment after the queue and push "AI suggestions to review" down - the
low-severity layout shift N1 named, now shorter; it is named in the handback
for Cameron.

| # | Ruling | Why |
|---|---|---|
| F1 | RESOLVED BY REVERT | No hold, so an AI-suggestions-only queue renders at once. A test pins it (and that no spinner shows). |
| F2 | RESOLVED BY REVERT | Nothing is hidden on a reload. |
| F3 | RESOLVED BY REVERT | The index is gone. The section is still attached to the follow_ups group; removing that group from GROUP_META fails the existing "sits after Follow-ups due" test. |
| P4-1 | RESOLVED BY REVERT | Core queue content no longer waits on best-effort lookups - the coupling that made the hold the wrong trade. |
| I4-1 | DEFER | Pre-existing (the window is back to what it was before this branch). Filed `fact-extraction-spec-vacuous-today-absence-checks`. |

The review stops here (the cap). The final code is the round-3-reviewed state
plus the round-4-reviewed-correct fixes, minus the reverted hold - no code the
reviewer has not read.
