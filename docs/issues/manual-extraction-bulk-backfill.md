---
id: manual-extraction-bulk-backfill
title: Bulk extraction backfill over the imported population needs its own windowing design
type: improvement
severity: med
status: deferred
area: app/extraction
created: 2026-08-16
refs: app/src/jobs/extraction.ts:53, app/src/jobs/extraction.ts:69, app/src/jobs/extraction.ts:444, docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md
---

**Pre-existing scope boundary, not a defect introduced here.** The
manual-extraction-trigger feature ships a per-contact button only. The bulk
backfill was DEFERRED by the human, deliberately: run the action on a handful of
imported conversations and judge the output before firing hundreds of real,
billed model calls. Design section 9 records the deferral; this file is the
registry entry it asks for.

**Problem.** The imported population (the Quo/Airtable cutover) arrives with long
message histories that no extraction run has ever read. The manual trigger makes
each one individually reachable, but there is no way to sweep them.

**The constraint that makes this more than a loop over the new button.** Design
section 8 is explicit, and the code confirms it:

- `MAX_TRANSCRIPT_MESSAGES = 50` (`app/src/jobs/extraction.ts:53`) - each run
  pulls only the newest 50 messages (`:444`,
  `listByConversation(conversationId, { limit: MAX_TRANSCRIPT_MESSAGES })`).
- `WINDOW_CHAR_BUDGET = 60_000` (`:69`) - a whole-window char budget, filled
  newest-first, so the OLDEST messages drop out first.
- There is no backward pagination of the transcript window. Design section 9
  lists it as out of scope in its own right.

So a contact with hundreds of imported messages has its oldest history read by NO
run, and pressing the button again does not reach further back - it re-reads the
same newest page. Quoting design section 8: "This is a real limit of the feature,
not a bug in it, and it is the strongest argument for treating a real backfill
(section 9) as its own design rather than a loop over this button."

A backfill built as a loop over `POST /api/contacts/:contactId/extraction-run`
would therefore spend real money to extract, per contact, exactly the window a
single press already covers, and would report success while the imported history
it was built to read stayed unread.

**Suggested fix (sketch only - this needs its own design).** At minimum a
backfill needs backward pagination or an explicit windowing pass over a long
history, a cost model and a rate/spend bound over the whole population,
idempotency so a re-run does not re-bill completed conversations, and progress
plus per-conversation outcome reporting. It also needs a decision on the
interaction with the 30-day age floor, which a manual run currently waives.

Related: the demotion behaviour flagged in design section 8 - one unknown-speaker
utterance demotes EVERY write in a run to a suggestion - means a large backfill
over aged multi-speaker calls could generate a review queue far larger than
anyone expects. Size that before running it, not after.
