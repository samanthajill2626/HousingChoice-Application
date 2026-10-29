---
id: extraction-note-line-break-unprefixed-continuation
title: A model Notes line holding a line break is written as one Auto line plus unprefixed lines that read as staff text
type: bug
severity: low
status: resolved
area: app/extraction
created: 2026-10-27
updated: 2026-10-29
resolved: 2026-10-29
refs: app/src/services/extraction/apply.ts:943, app/src/services/extraction/schema.ts:276, app/src/lib/caseworkers.ts:75, app/src/lib/singleLine.ts
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

**Resolution (2026-10-29).** WP1 B2a (spec D14.1): `filterNoteLines`
(`app/src/services/extraction/apply.ts`) collapses every run of CR, LF,
U+2028 and U+2029 in a model or system line to " / " through the shared
helper `toOneLine` (`app/src/lib/singleLine.ts`) BEFORE the clamp and the
retry guard, so a Notes line is always one physical line carrying its
`[Auto - <date>]` prefix, and the guard compares single lines. The
extraction transcript uses the same helper (it replaced prompt.ts's private
`toSingleLine`), so it now also folds U+2028 and U+2029; the prompt text is
unchanged. Accepted side effect: a multi-line model line appended BEFORE
this change stays as separate physical lines, so a retried window that
re-emits it as "a / b" appends it once more. Pinned by
`app/test/singleLine.test.ts` (the helper, and both callers importing it),
`app/test/extractionNoteLines.test.ts` (the "line breaks collapse to ' / '"
cases, the collapse before the clamp, and the accepted side effect) and
`app/test/extractionSchema.test.ts` (the transcript folding cases).
