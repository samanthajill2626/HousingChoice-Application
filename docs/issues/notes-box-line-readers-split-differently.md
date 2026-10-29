---
id: notes-box-line-readers-split-differently
title: The Notes box's line readers split stored text three different ways; only the writer folds every break
type: bug
severity: low
status: open
area: app/notes
created: 2026-10-29
refs: app/src/lib/singleLine.ts:20, app/src/services/extraction/apply.ts:342, app/src/lib/caseworkers.ts:77, app/src/services/ranking/seenFeedback.ts:26
---

**Problem.** WP1 B2a (spec D14.1) gave the WRITE side one rule for a line:
`toOneLine` (lib/singleLine.ts:20) folds every run of CR, LF, U+2028 and
U+2029 into " / " before extraction appends a Notes line, and the file says
its two callers "can never disagree". The READERS of the same stored box
still split it three different ways:

- the extraction retry guard (services/extraction/apply.ts:342,
  `filterNoteLines`): splits on LF only, then trims each line;
- the AI caseworker signal (lib/caseworkers.ts:77, `hasAiCaseworkerNote`):
  splits on LF only, with no trim before its anchored prefix match;
- the ranking card's attach step (services/ranking/seenFeedback.ts:26-41,
  `noteLines`): splits on CR LF, CR, LF, U+2028 and U+2029, a hand-copied
  fourth definition.

So a stored box whose lines are separated by CR alone or by U+2028 (pasted
text, an imported workbook cell) is several lines to the ranking card but
ONE line to the retry guard and to the caseworker signal: a line the model
re-emits is not seen as present (appended again, and counted as new rather
than in `notesDuplicate`), and an AI caseworker line after such a separator
is not seen. Separately, the fence omits the other Unicode mandatory breaks
(VT U+000B, FF U+000C, NEL U+0085), which a UCS-2 SMS or an email body can
carry; whether the model or the Notes card renders them as breaks was not
checked. Found by the plan-blind code review round 1 (reviewer A2, finding
A2-6, plausible: reasoned from the code, not reproduced).

**Suggested fix.** Export one `splitLines` beside `toOneLine` (the same
character class, CR LF as one break) and use it in `filterNoteLines`,
`hasAiCaseworkerNote` and `seenFeedback.noteLines`; decide whether VT, FF and
NEL join the class (a change to the transcript fence too, so a ruling on
spec D14.1). Test: `filterNoteLines` with existing notes "keep<U+2028>works
nights" and a model line "works nights" gives duplicate 1 and appends
nothing.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R1-adversarial-A2.md (A2-6) and R1-adjudications.md.
