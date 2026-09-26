# Fix wave 3 report - inbox rows + timestamps

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`, from a128baf3.
Implementer: Claude Opus 5.5 (1M context). Charter:
`code-review-r3-adjudications.md` (R3-1, R2-6, R3-2, R3-4, "Pins for wave
3"). Logs: ignored `.superpowers/sdd/fw3-*`.

## Commit

e7fbcff9 `fix(inbox): one chip rule - short state chips stay rigid, the
placement tag and Needs triage yield before the name with a 4em floor (R3-1,
R2-6, R3-4)`. Six explicit paths, 124+/27-. Tree clean after it.

## Per-item status

| Item | Status | Where |
|---|---|---|
| R3-1 rigid markers | DONE | `InboxRow.module.css:110-118` (`.tag`) and `:155-164` (`.deletedTag`): the wave-2 yielding declarations removed; both rule bodies are byte-identical to `main`@cd8e8ddd (checked by diff). `.channel` untouched (`:105-109`). |
| R3-1 placement tag | DONE | `.placementTag` at `InboxRow.module.css:122-134` = main's `.tag` body plus exactly `min-width: 4em; overflow: hidden; text-overflow: ellipsis; flex-shrink: 100`. `InboxRow.tsx:119-126`: class `placementTag`, `title` = the label (`:123`). |
| R2-6 triage | DONE | `.triage` gains the same four declarations (`InboxRow.module.css:147-150`), comment `:135-137`. |
| Comments | DONE | The one rule and why the floor exists: `InboxRow.module.css:92-104`; `.deletedTag` comment `:153-154`. |
| R3-4 | DONE | `Inbox.tsx:379` renders the `<ul>` on `listShown`; comment `:158-159` reworded. Behavior identical. |
| R3-2 spec | DONE | (a)+(b) `spec:458-468`; (c) `spec:3`; (d) `spec:1086-1088`. |
| Pins | DONE | New `InboxRow.styles.test.ts` (9 cases: `:22` head, `:28` time, `:32` media query, `:39` two yielding chips, `:48` three rigid chips, `:54` actions). `InboxRow.test.tsx:206-209` (placement tag `title`). |

## Mutant / kill pairs

Byte copies taken first; each restore by `cp` from the copy, verified by
`cmp` and sha256; `git diff --stat` identical before and after. No
`git checkout` / `git restore` used.

1. `.tag` re-given `flex-shrink: 100; min-width: 0` -> styles test exit 1,
   1 failed / 8 passed, the failing case exactly
   ".tag is a rigid state marker" (`fw3-mutant1-tag-shrink.log`).
2. `title` dropped from the placement tag -> row test exit 1, 1 failed / 23
   passed, the failing case exactly the new title case
   (`fw3-mutant2-no-title.log`).

## Gates (bare, from the worktree, output to `.superpowers/sdd/`)

| Gate | Exit | Counts |
|---|---|---|
| vitest: InboxRow.test.tsx, InboxRow.styles.test.ts, Inbox.test.tsx | 0 | 3 files, 92/92 (24 + 9 + 59) |
| `npm run test -w @housingchoice/dashboard` | 0 | 199 files, 3287/3287 |
| `npm run typecheck` | 0 | 5 workspaces, 0 `error TS` |
| `npx eslint` on the 4 touched .ts/.tsx | 0 | no output (the new file resolves 63 rules via `--print-config`) |

ASCII: 0 non-ASCII bytes in the new test file and in the 67 added tracked
lines; `InboxRow.tsx`'s 13 pre-existing non-ASCII bytes are on untouched
lines. All files stay LF.

## Divergences from the charter

- Spec (b): the old sentence's tail ("the time is never clipped by
  `.row { overflow: hidden }`") is kept, joined to the chartered clause with
  ", and" (`spec:467-468`).
- Spec (a) is verbatim, so 5.4 no longer lists `overflow: hidden;
  text-overflow: ellipsis; flex-shrink: 100`; the CSS and the styles pin
  carry them.
- Spec (d) says "The test also mints" (e2e test 4), not "the spec", so it
  cannot be misread as this design spec.
- The styles pin also asserts `overflow: hidden`, `text-overflow: ellipsis`
  and no `min-width: 0` on the two yielding chips (`InboxRow.styles.test.ts:39-46`).
- A 3-line JSX comment sits above the placement tag (`InboxRow.tsx:119-121`).

## Worth an eye

- No geometry was measured in this wave (no browser or lane, per the brief).
  The 4em floor, the whole Closed/Deleted chips and the triage yield are
  proven only by the full-profile self-QA at 360 / 768 / 1280.
- R2-6: the triage chip now yields, which deviates from the row CSS Sam
  approved; the handback must flag it with the r3 numbers. The revert is
  `.triage { flex-shrink: 0; min-width: auto }` PLUS moving `.triage` from
  the yielding list to the rigid list in `InboxRow.styles.test.ts:39/:48`.
- Suite count: 199 files / 3287 tests vs the wave-2 addendum's 198 / "3272+";
  this wave adds 1 file and 10 tests.
- Left as is: `Inbox.tsx:404-405` (historical "`rows.length > 0` block
  above", still true through `listShown`) and `spec:1077` (Needs triage as
  "the widest chip a lean-world row can carry", true at natural width).
