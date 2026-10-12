# Code review R3 (terminal) - micro wave after R2 (R2-F1, R2-N5)

Branch feat/join-housing-authority, worktree W:/tmp/join-housing-authority.
Scope: c8ec57c2 (visibleName escapes every Cc/Cf/Zl/Zp code point in report names, new test)
and e05dab52 (one RUNBOOK sentence), diff 071f420b..e05dab52 (3 files, +68/-8). Reviewed cold,
fresh reviewer. In this file "BS" means one backslash character (no backslash is typed here).

## Verdict

NO MEDIUM+ DEFECT introduced by the micro wave - nothing reopens. R2-F1 is fixed: every
explicit bidi control, line/paragraph separator, C0/C1 control (ESC and CSI included) and
format character is escaped to printable ASCII, the new test is load-bearing (RED on the
pre-fix script, GREEN now), and ordinary names print unchanged. R2-N5 is fixed: the RUNBOOK
sentence is accurate. Five INFO notes below, none requiring a change on this branch.

| Id | Sev | Status | One line |
|---|---|---|---|
| R3-1 | INFO | CONFIRMED | "emoji prints as it is" is not true of ZWJ emoji sequences or tag-sequence flags; ZWJ/ZWNJ in Persian/Indic names now print escaped (safe side, wording only) |
| R3-2 | INFO | CONFIRMED | "never visually reorder one" holds for explicit bidi controls; natural RTL letters (Lo) still print raw and can reorder runs in an auto-direction bidi viewer - the contactId itself can not be reversed or forged by them |
| R3-3 | INFO | CONFIRMED, pre-existing | plain typed text can still imitate report fields on the same line, and a typed "BS u 202e" prints identically to an escape (the backslash itself is not escaped) |
| R3-4 | INFO | CONFIRMED | default-ignorable but inert code points (Mn variation selectors, Hangul fillers, reserved Cn) stay raw - invisible, but they cannot break, reorder or move anything |
| R3-5 | INFO | CONFIRMED | RUNBOOK sentence accurate; for an authority NOT on the list the outcome is in fact a code guarantee (stronger than "instructed") |

## 1. Is the escaping complete and correct for its stated goal?

Method: a scratch probe (outside the worktree, since deleted) holding the script's lines
230-261 verbatim (UNSAFE_IN_REPORT, BACKSLASH, visibleName, escapedCodePoint), run with tsx
under Node v24.21.0 (ICU 78.3, Unicode 17.0), sweeping every code point 0..0x10FFFF except
surrogates:

```
matched code points: 237  non-ASCII/blank escapes: 0  visibleName mismatches: 0
Bidi_Control NOT escaped: 0
White_Space NOT escaped: 20 a0 1680 2000-200a 202f 205f 3000 cats: Zs
Default_Ignorable NOT escaped [Mn] (263): 34f 17b4-17b5 180b-180d 180f fe00-fe0f e0100-e01ef
Default_Ignorable NOT escaped [Lo] (4): 115f-1160 3164 ffa0
Default_Ignorable NOT escaped [Cn] (3769): 2065 fff0-fff8 e0000 e0002-e001f e0080-e00ff e01f0-e0fff
```

- 237 = Cc 65 + Cf 170 + Zl 1 + Zp 1. Every one escapes to printable ASCII, and
  visibleName("A" + c + "B") equals "A" + escape + "B" for all of them.
- Line breaks: every mandatory-break character (LF, VT, FF, CR, NEL U+0085, U+2028, U+2029)
  is Cc/Zl/Zp and escaped; the only unescaped White_Space is Zs (plain spaces). Probe: NEL
  prints as ASCII "A BS x85 B".
- Reordering: all 12 Bidi_Control code points (ALM, LRM, RLM, LRE..RLO, LRI..PDI) are Cf and
  escaped (0 unescaped). Natural RTL letters are a different matter - R3-2.
- Cursor: ESC (0x1b) and CSI (0x9b) are escaped; probe "ESC [2J CSI 2K" prints all-ASCII.
  No non-Cc code point has terminal control semantics.
- Lone surrogates (Cs): not matched (probe: `UNSAFE_IN_REPORT.test(lone) false, Cs: true`),
  so they stay raw in the JS string, but console.log UTF-8-encodes each to EF BF BD (U+FFFD,
  probe utf8 output) - inert. Escaping can not manufacture a pair: for "A D83D 200B DE00"
  for...of yields 4 items and the ASCII escape lands between the halves (utf8 shows two
  separate EF BF BD); escaping only inserts ASCII and trim() only removes edge Zs. (A stored
  name would normally reach the script through DynamoDB's UTF-8 anyway.)
- Astral code points: for...of yields the whole pair, the u-flag class under ^...$ matches it
  as ONE code point, codePointAt(0) gives the full value, the braced form is used. Pinned by
  the test (U+E0001). The old charCodeAt saw only the high surrogate - correctly replaced.
- Private use (Co) and unassigned (Cn): raw; no control semantics. Unassigned code points in
  RTL blocks default to strong R/AL, i.e. they behave like natural RTL letters (R3-2).
- Combining marks (Mn/Me): raw. A mark attaches to the PRECEDING base only, so it can not
  alter the date, status or contactId that FOLLOW the name; a long stack may overdraw the
  name's own row in some GUI viewers - display only, copy/paste unaffected.
- trim() after escaping: correct order. An edge U+FEFF is now kept as a visible escape
  (pinned by the test; before, trim ate it raw); edge Zs (U+00A0, U+3000) is trimmed - inert.
- Unambiguity: the forms are JavaScript string-escape syntax (BS x + exactly 2 hex digits,
  BS u + exactly 4, BS u + braces), lowercase, fixed width, so an escaped name decodes
  unambiguously - except against TYPED backslash text (R3-3).
- Regression: none for ordinary names. ASCII, accented letters, NBSP, quotes, CJK and
  single-code-point emoji print exactly as before (the R1-ADV-4 test's exact lines, whose C0/
  DEL/C1 escapes keep the same BS x form, pass on both the pre-fix and the fixed script; the
  new test pins CJK, a quote, U+1F600 and U+00E9 raw). Output changes only for names holding
  Cf/Zl/Zp: soft hyphen, ZWSP, ZWJ, ZWNJ, LRM/RLM, BOM, separators, tags - see R3-1.

## 2. Can the doc comment or the test mislead?

Test RED on the pre-fix code, no existing file edited:
- Throwaway copy of `git show 071f420b:app/scripts/backfill-join-housing-authority.ts` in the
  scratch dir, its relative and @aws-sdk imports rewritten to absolute worktree paths; a
  scratch vitest config spreading app/vitest.config.ts with a resolve.alias of the test's
  specifier `../scripts/backfill-join-housing-authority.js` to the copy; `--root` app.
- CONTROL (same harness, copy of the CURRENT script): exit 0, `Tests 76 passed (76)`.
- PRE-FIX: exit 1, `Tests 1 failed | 75 passed (76)`. The only failure is the new case,
  `AssertionError: expected [ ...(6) ] to deeply equal [ ...(6) ]`, the received lines carrying
  the raw U+200B/202E/2066/2069/2028/2029/00AD/E0001 and the trailing U+FEFF ABSENT (trim ate
  it). The alias demonstrably took effect (control green, pre-fix red on that case alone).
- Real file, unaliased: `npx vitest run test/backfillJoinHousingAuthority.test.ts` exit 0,
  76 passed, no `[dynamoAdmin]` line.
- By reading, the exact-line expectation also kills a charCodeAt mutant (U+E0001 would print
  BS u db40, not the braced form), a trim-before-escape mutant (the trailing U+FEFF escape
  vanishes) and a missing-u-flag mutant (the class stops meaning categories). The closing
  per-line category sweep is a true second check, not tautological.

Doc comment vs code: categories, the three escape forms, lowercase hex and the U+202E / newline
examples all match `escapedCodePoint` (`backfill-join-housing-authority.ts:256-261`) and the
regex (`:231`). Two wording nuances, R3-1 and R3-2; neither is a claim about safety that the
code fails to keep for its stated threat (a name forging or reversing a contactId, or moving
the cursor).

## 3. RUNBOOK sentence (R2-N5) - accurate

RUNBOOK.md:454 now says the extraction "is instructed to raise an authority it states later
... as a suggestion for staff to accept rather than overwrite the held value". Checked:
- `app/src/services/extraction/prompt.ts:33-40`: op "write" only when the field is empty or
  the SAME fact in a better form; op "suggest" when it genuinely CONFLICTS. That is the
  instruction the sentence names.
- `app/src/services/extraction/apply.ts:299-316`: an op "write" is written with no held-value
  check, so for an authority ON the list (DeKalb is: `app/src/lib/orgStartingList.ts:34`) the
  outcome rests on the model following the prompt - "instructed" is the right word.
- R3-5: for an authority NOT on the list, `apply.ts:290` sets notOnList and `:299`
  (`!notOnList`) demotes the write to a suggestion in code - so there the outcome is
  guaranteed, despite the prompt's own hard rule (`prompt.ts:65-66`, "record what they said
  (op write)"). An agency name is dropped (`apply.ts:270-279`) and a dismissed value is not
  re-suggested; neither contradicts the sentence. The old "never an overwrite" phrase is gone
  from RUNBOOK.md (grep). The spec still carries it (implementer remark; out of scope).

## 4. Backslash-u decoding accident / ASCII

Both changed files (`app/scripts/backfill-join-housing-authority.ts`,
`app/test/backfillJoinHousingAuthority.test.ts`): `grep -nF` for a literal backslash followed by
u - no match (exit 1); `grep -nF 'u{'` - no match; `LC_ALL=C grep -nP` for any byte outside
TAB/LF/CR/0x20-0x7E - no match. RUNBOOK added line: 0 non-ASCII bytes; no added diff line holds
a backslash-u. The escape prefix is built in code (`BACKSLASH` + "u"); the test builds every
special character with String.fromCodePoint. Also: `npx tsc -p tsconfig.scripts.json` exit 0,
`npx tsc -p tsconfig.test.json` exit 0, `npx eslint` on both files exit 0.

## INFO notes (noted, not fixed)

### R3-1 - INFO - CONFIRMED - "emoji ... prints as it is" is only true of single-code-point emoji
Doc comment (`:244-246`) and test title. A ZWJ sequence (woman + U+200D + laptop) prints as
`woman BS u 200d laptop`; the England-flag tag sequence prints its tags braced. ZWNJ in a
Persian name ("Mi" U+200C "ra" printed as "Mi BS u 200c ra") and ZWJ/ZWNJ in Indic/Sinhala
conjuncts are escaped too. Safe-side and still recognizable; adjudicated scope (all Cf). If
touched again: say "single emoji" or name ZWJ/ZWNJ in the list of escaped characters.

### R3-2 - INFO - CONFIRMED - natural RTL letters can still reorder a line's runs
Hebrew/Arabic letters (Lo) print raw (probe: U+05E9.. raw). In a viewer that picks paragraph
direction from the first strong character, a name starting with RTL letters lays the line out
right-to-left (name at the right). It can NOT reverse or forge the contactId: fixed strong-LTR
text ("signed up", "status", "contactId") always sits between the name and the contactId, so
the tail stays one LTR run. The doc's "never ... visually reorder one" is broader than what is
kept; its consequence clause ("forging or reversing a contactId") holds. Most terminals do not
apply bidi at all.

### R3-3 - INFO - CONFIRMED - pre-existing: typed text can imitate report text
A name may hold 100 characters each (`app/src/routes/public.ts:89`), enough to type
"contactId contact-<uuid>" so a fake contactId appears mid-line (the real one is still at the
line's end), and a typed "BS u 202e" is indistinguishable from an escaped RLO because the
backslash itself is not escaped (implementer remark; R2 noted the BS x case). Not introduced
by this wave; the report is a recognition aid and `--skip` ids that name no candidate are
reported and ignored. A future hardening could escape the backslash as BS BS.

### R3-4 - INFO - CONFIRMED - invisible but inert code points stay raw
See the sweep: CGJ U+034F, Khmer U+17B4-17B5, Mongolian FVS, variation selectors, Hangul
fillers U+115F-1160/U+3164/U+FFA0 and reserved default-ignorables (U+2065, U+FFF0-FFF8,
U+E0000, U+E0002-E001F, U+E0080-E0FFF). None breaks, reorders or moves anything; a name made
only of them prints visually blank rather than "(no name)". Outside the stated goal.

### R3-5 - INFO - CONFIRMED - RUNBOOK understates the not-on-the-list case
Section 3. No change needed: the sentence is true for every case, merely conservative.

## Housekeeping

- Throwaways (pre-fix and current script copies, two alias vitest configs, probe, logs) lived
  only in this session's scratch dir outside the worktree and are deleted.
- No test suite, e2e, e2e session or backfill run; no git, docker or live-port action; only
  single-file vitest runs (three) and the two no-emit tsc projects plus eslint.
- `git status --short` in the worktree shows only this report.
