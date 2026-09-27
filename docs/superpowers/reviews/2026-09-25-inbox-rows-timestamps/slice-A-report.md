# Slice A report - inbox rows + timestamps (plan Tasks 1 and 2)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). Scope held to the five named files; nothing else
staged.

## Commits

- `232e2658` feat(inbox): four-tier last-activity time formatter (Task 1)
- `2259c018` feat(inbox): last-activity time on every row; actions become an
  overlay (Task 2)

## Tests and gates

All run bare from the worktree; output captured under the ignored
`.superpowers/sdd/sliceA-*.log`.

- Task 1 red: the file failed on `Failed to resolve import "./inboxTime.js"`,
  as the plan predicts. Green: `inboxTime.test.ts` 12 passed, 0 skipped (the
  runner zone is America/New_York, so the local-vs-UTC case at
  `inboxTime.test.ts:45` ran).
- Task 2 red: 3 failed / 18 passed of 21. The first new test failed with
  `expected null not to be null` as predicted; the other two failures were
  the same missing `<time>`. Green: `InboxRow.test.tsx` 21 passed (16
  existing + 5 new).
- `npm run test -w @housingchoice/dashboard`: exit 0 before each commit -
  192 files / 3171 tests (Task 1), 192 files / 3176 tests (Task 2).
- `npm run typecheck`: exit 0 before each commit.
- Extra, not a slice gate: `npx eslint` on the four touched TS/TSX files,
  exit 0, no findings.
- ASCII: both new files and the replaced CSS carry 0 non-ASCII bytes; the
  lines added to `InboxRow.tsx` and `InboxRow.test.tsx` carry 0. The 13
  pre-existing non-ASCII bytes in `InboxRow.tsx` (lines 1, 2, 7, 98) are
  untouched.

## Divergences from the plan

- Content: none. Checked programmatically: `inboxTime.ts` is byte-identical
  to plan lines 257-318, `inboxTime.test.ts` to plan 169-239, and
  `InboxRow.module.css` to plan 488-725. The new describe block (plan
  359-420) and the `cleanupAndRender` helper (plan 428-431) appear verbatim
  at `InboxRow.test.tsx:206-267` and `:35`. The `InboxRow.tsx` diff is
  exactly the plan's three insertions (`:13`, `:62-66`, `:125-129`) with zero
  removed lines. Latitude taken: the helper sits directly after `renderRow`,
  and a blank line separates the new describe from the test before it.
- Process: one write went around the Edit/Write tools. The Write tool
  decoded the plan's two regex unicode escapes at `inboxTime.ts:13` into the
  literal U+202F and U+00A0 characters (runtime-identical, but 5 non-ASCII
  bytes). An Edit with doubled backslashes kept both backslashes, a class
  that would match the digits 2 and 0 and the letters u, f, a and so corrupt
  every label. A Git Bash `sed` then dropped the `u` (the shell layer
  collapsed the doubled backslash, and GNU sed reads backslash-u in a
  replacement as its uppercase operator). The final fix was a
  backslash-free `node` string replacement of that one ASCII line - not a
  PowerShell pipeline, and the file was pure ASCII. The result was then
  byte-compared to the plan, and the regex was shown ad hoc to map U+202F
  and U+00A0 to a plain space. Nothing broken was committed. The plan holds
  no other unicode escape (plan line 269 is the only one), and a regex digit
  class survived the Edit tool intact (`InboxRow.test.tsx:215`).

## Worth an eye (not blocking)

1. No unit test exercises the NBSP normalization on this host. Node 24.14.1
   with ICU 78.2 already emits a plain space before AM/PM, so a broken
   `NBSP_LIKE` (`inboxTime.ts:13`) passes the whole suite here - the exact
   state the file was briefly in. A test that stubs the `toLocale*String`
   methods to return U+202F would pin it.
2. The Review Focus 1 test (`inboxTime.test.ts:45-52`) covers a differing
   UTC date only in zones WEST of UTC. East of UTC, 23:30 local falls on the
   same UTC date, so the test passes without exercising the case (its guard
   skips only offset 0). This runner does exercise it (23:30 EDT is 03:30Z
   the next day).
3. The dashboard vitest runs with `css: false` (`dashboard/vite.config.ts:122`),
   so this slice verifies none of the spec 5.4 layout rules: the `.head` cap
   (`InboxRow.module.css:68`), the `.time` column (`:150`), the `.actions`
   overlay (`:166`) or the narrow grid (`:206`). That proof falls to Task 9
   and self-QA.
4. Two of the five new row tests, the no-`<time>` guard
   (`InboxRow.test.tsx:258`) and the action-names guard (`:263`), pass
   before the implementation. They are regression guards, consistent with
   the plan's red prediction.
