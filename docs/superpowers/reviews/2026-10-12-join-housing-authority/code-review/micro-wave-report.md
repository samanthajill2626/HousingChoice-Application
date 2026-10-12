# Micro wave report - code review R2 (R2-F1, R2-N5)

Branch feat/join-housing-authority, worktree W:/tmp/join-housing-authority.
Base 071f420b; tip after this wave e05dab52. Two commits, one per item.

## Item 1 - R2-F1: report names escape every Cc, Cf, Zl and Zp character

Commit: c8ec57c2 `fix(backfill): escape every Cc, Cf, Zl and Zp character in report names`

Change:
- `app/scripts/backfill-join-housing-authority.ts:230-232` - new module constants: the
  category test `UNSAFE_IN_REPORT` (`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`, anchored, `u` flag, tested
  per code point) and `BACKSLASH` built from `String.fromCharCode(92)`.
- `:234-247` - doc comment rewritten to the new rule (categories, the three escape forms,
  what still prints as it is).
- `:248-254` - `visibleName` iterates code points, tests each against the category regex and
  escapes with `c.codePointAt(0)` (the old `charCodeAt(0)` saw only the high surrogate of an
  astral character).
- `:256-261` - new `escapedCodePoint`: up to 0xFF keeps backslash, x, two lowercase hex digits
  (the fix-wave-1 test still pins it); up to 0xFFFF backslash, u, four hex digits; above
  0xFFFF backslash, u, hex in braces. The backslash-u prefix is built in code
  (`${BACKSLASH}u`), never typed.

Test: new case beside the fix-wave-1 one,
`app/test/backfillJoinHousingAuthority.test.ts:375-417` ("a name never reorders or breaks a
report line: every Cc, Cf, Zl and Zp character ..."). Names built with
`String.fromCodePoint`: U+200B, U+202E, U+2066, U+2069 (target c-bidi); U+2028, U+2029,
U+00AD, U+E0001, U+FEFF at the very end of the name (target c-sep); CJK U+4E2D U+6587, a
quote, emoji U+1F600 and U+00E9 that must stay raw (left-out c-keep). Exact-line assertion
plus a per-line check that no line contains any Cc/Cf/Zl/Zp character.

RED (before implementing, real script): exit 1, `Tests 1 failed | 75 passed (76)`; the new
case failed `expected [ ...(6) ] to deeply equal [ ...(6) ]` with the received lines carrying
the raw format characters. The RED also showed the trailing U+FEFF missing from the
received c-sep line: `.trim()` removed it raw (JS trim treats U+FEFF as whitespace), so the
operator could not have seen it at all - the escape-before-trim order now keeps it visible.
This RED run is the proof the change is load-bearing (no in-place mutation was made).

GREEN: `cd W:/tmp/join-housing-authority/app && npx vitest run test/backfillJoinHousingAuthority.test.ts`
exit 0, `Test Files 1 passed (1)`, `Tests 76 passed (76)`, none skipped, on the shared
DynamoDB Local.

Backslash-u / ASCII checks (both files, after the edit; baseline at 071f420b also clean):
- brief grep `grep -n 'u{\|\\\\u' <script> <test>`: no output, exit 1.
- `grep -nF '\u' <script> <test>` (a single literal backslash then u): no output, exit 1.
- `grep -nF 'u{' <script> <test>`: no output, exit 1.
- `tr -d '\11\12\15\40-\176' < FILE | wc -c`: 0 for both files.

## Item 2 - R2-N5: RUNBOOK wording

Commit: e05dab52 `docs(runbook): a later-stated authority is suggested by prompt rule, not a code guarantee`

`RUNBOOK.md:454` (section "/join leads: the housing authority backfill") - "an authority it
states later (...) arrives as an AI suggestion for staff to accept, never an overwrite" now
reads "the AI extraction is instructed to raise an authority it states later (...) as a
suggestion for staff to accept rather than overwrite the held value". The rest of the
sentence ("- the same as a `/join` lead who leaves the select on its default (spec section
4).") and the rest of RUNBOOK.md are untouched (diff: 1 line changed). Checked against
`app/src/services/extraction/prompt.ts:35-39` (the op rules) and
`app/src/services/extraction/apply.ts:298-305` (write on op "write", no held-value check).
Added line: 0 non-ASCII bytes. RED/GREEN: not applicable (wording only).

## Final checks (tip e05dab52)

- `npm run typecheck` (bare, worktree root): exit 0 (covers app tsconfig.json,
  tsconfig.scripts.json and tsconfig.test.json).
- `npx eslint app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`: exit 0, no output.
- No full suites, no e2e, the backfill script was never run against any environment.

## Divergences and remarks

- Divergence (small): the test is a new case beside the fix-wave-1 one rather than an
  extension of it, so the R1-ADV-4 case keeps its own exact expectations; its
  `isControl` sweep (0-31, 127-159) is now a subset of the new case's category sweep.
- Remark: the spec still makes the "never an overwrite" claim (spec lines 76-78, 288-290 per
  R2-N5); only the RUNBOOK was in scope, the spec was not touched.
- Remark: lone surrogates (category Cs), private use (Co) and unassigned (Cn) code points are
  outside the adjudicated categories and still print as they are. DynamoDB strings are UTF-8,
  so a lone surrogate cannot be stored; Co/Cn do not move the cursor or reorder text.
- Remark: the fix-wave-1 visual ambiguity (a name typed with the literal text backslash, x,
  0a prints like an escaped newline) now extends to typed backslash-u text; visual only, as
  R2 noted.

Next step: orchestrator commits this report and decides whether the two code/doc commits
need any gate re-run under its closing rule.
