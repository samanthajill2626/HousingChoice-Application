---
id: extraction-note-line-break-unprefixed-continuation
title: A model Notes line holding a line break is written as one Auto line plus unprefixed lines that read as staff text
type: bug
severity: low
status: open
area: app/extraction
created: 2026-10-27
refs: app/src/services/extraction/apply.ts:943, app/src/services/extraction/schema.ts:276, app/src/lib/caseworkers.ts:75
---

**Problem.** Extraction keeps a model noteLine's text as given (the parser
does not touch it; `filterNoteLines` trims the ends only) and appends it as
`[Auto - <date>] <line>`. When the text holds a line break, the
`[Auto - <date>]` prefix lands on its first physical line only, and every
following line of it carries no prefix. Every per-line reader then takes
those continuation lines for staff-typed text: `hasAiCaseworkerNote`
(lib/caseworkers.ts) skips them, and WP1 B2's tenant card, which attaches
feedback lines to properties line by line, would read the continuation of a
feedback line ("412 Oak Ave, Decatur: on the fence" / "worried about the
commute") as a separate staff line naming no home. Rare: the prompt asks for
a short phrase. Main wrote the same shape before WP1 B1; found by the B1
code review (R3-5, 2026-10-27).

**Suggested fix.** In `filterNoteLines` (the one place for Notes line value
rules), collapse CR/LF runs in a model line to " / " before the retry guard
and the write, as prompt.ts `toSingleLine` does for transcript text; the
guard's multi-line handling then reduces to plain line equality. Best done
with B2, which is the first per-line reader that cares.
