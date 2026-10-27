---
id: notes-guard-stale-reread-vs-flip-back
title: The Notes retry guard cannot tell a stale re-read of an older property view from a real change of mind, and nothing counts its drops
type: decision
severity: low
status: open
area: app/extraction
created: 2026-10-27
refs: app/src/services/extraction/apply.ts:299, app/src/jobs/extraction.ts:80
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
docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/code-review/). B1
ships a same-day retry guard for model lines: it trusts the model's reconcile
judgment and never drops a flip back, at the cost of writing a stale re-read
(and other later-day verbatim repeats). Neither failure's frequency is known:
no run record counts a guard drop.

**Suggested fix.** For B2, before the card reads "the latest line for a
home": (1) count guard drops on the AI run record (a `notesDuplicate` count
beside notedLines / notesBelowFloor) so the trade-off can be judged from
production; (2) consider comparing a label-naming candidate with the LATEST
existing line for that label (identical = a repeat of the current view,
dropped; different = written), which catches the commonest slip - a re-read
of the CURRENT view - but needs the block's labels inside filterNoteLines;
(3) or capture feedback against the send itself, as the WP3 redesign plans
(docs/issues/wp3-property-feedback-redesign.md).
