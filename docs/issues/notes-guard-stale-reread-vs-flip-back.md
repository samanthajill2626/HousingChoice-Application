---
id: notes-guard-stale-reread-vs-flip-back
title: The Notes retry guard cannot tell a stale re-read of an older property view from a real change of mind, and nothing counts its drops
type: decision
severity: low
status: open
area: app/extraction
created: 2026-10-27
refs: app/src/services/extraction/apply.ts:292, app/src/jobs/extraction.ts:80
---

**Problem.** WP1 B1 extraction appends feedback lines that name a sent
property ("412 Oak Ave, Decatur: on the fence"), and WP1 B2's tenant card
will read the LATEST such line as the tenant's current view of that home.
Every extraction run re-sends the whole recent window (up to 50 messages / 30
days; a manual press up to 200), and the transcript does not mark which
messages were already extracted. So when the model writes a line whose words
equal an earlier line for the same home, text alone cannot tell:

- a STALE RE-READ (the model re-emits an older view after the tenant changed
  their mind - writing it makes a stale view the newest line), from
- a FLIP BACK (the tenant really returned to the earlier view - dropping it
  keeps a stale view as the newest line).

B1's code review went both ways on this (R2-1, R3-3, R4 section 3; records in
docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/code-review/). The
build first shipped a same-day guard for model lines. Cameron ruled at the
handback (2026-10-27) for the ANY-DATE guard over whole lines, because every
run re-reads old messages and a model that misses the reconcile rule would
otherwise re-append old facts: "we are feeding old messages into the agent so
what happens if the extraction agent pulls out the old information since the
retry guard is gone?" So B1 ships the any-date guard: it never writes a stale
re-read worded as before, at the cost of dropping a flip back worded exactly
as an earlier line (the prompt asks for a change back worded differently,
e.g. "likes it again"). Neither failure's frequency is known: no run record
counts a guard drop.

**Suggested fix.** For B2, before the card reads "the latest line for a
home": (1) count guard drops on the AI run record (a `notesDuplicate` count
beside notedLines / notesBelowFloor) so the trade-off can be judged from
production; (2) consider comparing a label-naming candidate with the LATEST
existing line for that label (identical = a repeat of the current view,
dropped; different = written), which catches the commonest slip - a re-read
of the CURRENT view - but needs the block's labels inside filterNoteLines;
(3) or capture feedback against the send itself, as the WP3 redesign plans
(docs/issues/wp3-property-feedback-redesign.md).
