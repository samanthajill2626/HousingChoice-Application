---
id: ai-run-log-refused-accept-replay-200
title: Identity-matched replay of a refused accept answers 200 as if applied
type: bug
severity: low
status: open
area: app
created: 2026-08-09
refs: app/src/services/suggestionResolution.ts, app/src/repos/suggestionResolutionRepo.ts
---

**Problem.** A first accept refused as `superseded_by_human_edit` now answers
`409 suggestion_field_edited` (follow-up wave fix for
`ai-run-log-final-review-followups` item 1). But an identity-matched REPLAY of
that same accept - a second tab, a second navigator, or a crash-then-retry -
reaches the completed-row identity-match branch in `resolve()`, which can
distinguish only `disposition === 'released_unsafe'`. A journal that completed
NORMALLY while carrying `outcome: 'superseded_by_human_edit'` is
indistinguishable there from a real applied accept, so the replay answers
`200 { contact, suggestions }` - "applied" - for an accept that was refused.

**Root cause.** `makeCompletedResolution` (`suggestionResolutionRepo.ts`,
completed-row constructor) drops `outcome` when writing the terminal row, so
the completed journal can express the unsafe-release refusal but not the
human-edit refusal.

**Bounded how.** The requesting dashboard refetches on the 409 (the chip
disappears), so a replay requires a second actor/tab or a crash; and the 200
body carries the TRUE contact - the human's value - so the screen shows
reality even though the status code overstates what happened.

**Why the wave did not fix it.** The full fix extends the completed-row
terminal shape (persist the outcome or a refused disposition) -
resolution-protocol surgery of exactly the class three consecutive waves
regressed on, and the wave's scope discipline required reporting it instead of
building it. Deferral is safe because the RECORD is already honest: the
journaled run's verdict is stamped `superseded_by_human_edit` at the verdict
phase regardless of who asks afterward; only the replay's HTTP status
overstates.

**Fix direction.** Two sub-cases. The crash-then-retry variant (journal still
ACTIVE when the retry arrives) is fixable WITHOUT shape surgery: the active
journal already carries `outcome: 'superseded_by_human_edit'`, and the
own-claim takeover path can read it (the wave's adversarial reviewer sketched
this). The second-tab variant (journal already terminal) needs the completed
row to persist the refusal (outcome or a dedicated disposition). Both then
answer the replay with the same `409 suggestion_field_edited` the driving
request gets.

**Evidence.** Both wave reviewers probed it empirically (first accept 409,
replay 200 with `pets: "one dog"` after accepting "two cats"):
`.superpowers/review/conformance-followup.md` (P2-1),
`.superpowers/review/adversarial-followup.md` (P1).

**Trigger.** The next resolution-protocol wave, or the first operator report
of a retried accept looking applied.
