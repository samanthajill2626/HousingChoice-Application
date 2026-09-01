# Slice T6 - describeRoster precedence (+ two rosterEdits.ts comments)

Commit: `56141b4b` - feat(roster): describeRoster prefers the contact name over the stored snapshot

## Files changed

- `app/src/lib/rosterResolution.ts` - comment `:557-562` rewritten, `const name =`
  expression `:563-564` flipped. `removed` guard `:541` and `let sharesPhoneWithName`
  `:565` untouched. No new reads (the contact is already read at `:530`).
- `app/src/services/rosterEdits.ts` - COMMENTS ONLY (proof below).
- `app/test/rosterResolution.test.ts` - new `describe('describeRoster - name
  precedence (M1)')` block inserted after the last `resolveRoster` block
  (before the `isOnRoster / rosterEquals` separator).

## Red evidence

`cd app; npx vitest run test/rosterResolution.test.ts -t "name precedence"` - exit 1:

```
 FAIL  test/rosterResolution.test.ts > describeRoster - name precedence (M1) > FACT mode: the contact name beats a stale stored roster name; a removed contact keeps the row name
AssertionError: expected [ 'Old Tina', 'Gone Person' ] to deeply equal [ 'Tina Person', 'Gone Person' ]

 Test Files  1 failed (1)
      Tests  1 failed | 28 skipped (29)
```

Exactly the plan's predicted red value.

## Green evidence

`cd app; npx vitest run test/rosterResolution.test.ts test/rosterEdits.test.ts
test/relayGroupPreview.test.ts test/toursApi.test.ts test/placementsApi.test.ts
test/rosterActionsPoll.test.ts` - EXITCODE=0:

```
 + test/rosterResolution.test.ts (29 tests) 19ms
 + test/rosterEdits.test.ts (22 tests) 34ms
 + test/rosterActionsPoll.test.ts (29 tests) 222ms
 + test/placementsApi.test.ts (56 tests) 665ms
 + test/toursApi.test.ts (187 tests) 1863ms
 + test/relayGroupPreview.test.ts (13 tests) 176ms

 Test Files  6 passed (6)
      Tests  336 passed (336)
```

`npm run typecheck` (bare, worktree root) - EXITCODE=0, all five workspaces clean.

## Re-baselined expectations

NONE. Zero preview expectations moved; no test file outside
`rosterResolution.test.ts` was edited. This matches the research sweep (worklist
T6): every swept fixture's stored roster name already equals its contact's
display name, or the member is bare-phone. No `body` string moved either -
`buildOpenPreviewFromParts` composes bodies from `resolveRoster`'s stored names
and only `recipients` comes from `describeRoster`.

## rosterEdits.ts comments-only proof

`git diff app/src/services/rosterEdits.ts` before staging showed two hunks,
`-4/+5` lines, every one inside a `/** ... */` block:

- `@@ -437,8 +437,9 @@` - the `PreviewRecipientRow` docblock (2 lines out,
  3 in). The line after the block, `export interface PreviewRecipientRow {`,
  is unchanged context.
- `@@ -452,8 +453,8 @@` - the `OpenPreviewParts` docblock; the "backfilled
  names" phrase, which the worklist flagged as SPLIT across `:454/:455`, was
  rewrapped by hand across both lines (a literal find/replace of the plan's
  quoted phrase would not have matched).

No code token in that file changed.

## Divergences from the plan

- The plan's Step 4 command was run with `test/rosterActionsPoll.test.ts`
  appended, per worklist T6 (B-F8).
- The plan quotes the rosterEdits.ts second edit as `:454-456`; the actual
  docblock is `:453-456` and the phrase spans two lines, so it was rewrapped
  rather than substituted. Result matches the plan's intended wording.
- The new test block was given its own `// ---` separator header, matching the
  file's existing section style. No behavior difference.

## Open worries

- The stored-name rung is now only reachable when the contact is unreadable,
  deleted, or has no first/last name. Any future surface that WANTS the
  creation-time snapshot must call `resolveRoster`, not `describeRoster`.
- `sharesPhoneWithName` (`:565-573`) now seeds `firstOnPhone` with the
  contact-derived name, so the card's "shares a number with <name>" copy
  follows the same flip. Intended, and no test pinned the old string.
