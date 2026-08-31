# Slice 1 report - Tasks 1 + 2 (lib resolver + filename builder)

Branch `feat/media-content-type-fidelity`, worktree `W:\tmp\media-content-type-fidelity`.
Base for this slice: 9df132c5. Working tree clean at handback.

## Commits

| Hash | Message | Paths |
|---|---|---|
| `c8821708` | `feat(media): add the declarable tier and one resolveMediaTier` | `app/src/lib/mediaTypes.ts`, `app/test/mediaTypes.test.ts`, `app/test/mediaMirror.test.ts`, `app/test/inboundEmail.test.ts` |
| `17ab93cd` | `feat(media): pure download-filename builder with an owned extension` | `app/src/lib/mediaFilename.ts`, `app/test/mediaFilename.test.ts` |

Both staged by explicit path (no `git add -A`), bare `git status` read before each,
`MERGE_HEAD` confirmed absent in the worktree's real git dir
(`.git/worktrees/media-content-type-fidelity/`, not the `.git` FILE in the worktree
root - `test -f .git/MERGE_HEAD` there is a "Not a directory" error, not an answer).
Both carry the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

## TDD sequence actually followed

- Task 1 Step 2 (red): `12 failed | 8 passed (20)` on `test/mediaTypes.test.ts`,
  first failure `resolveMediaTier is not a function`.
- Task 1 Step 4 (green): `20 passed (20)`.
- Task 1 Step 5 gate: `Test Files 4 passed (4) | Tests 109 passed (109)`
  (`mediaTypes` 20, `mediaMirror` 11, `inboundEmail` 66, `mmsMedia` 12).
- Task 2 Step 2 (red): `1 failed (1)`, `Failed to load url ../src/lib/mediaFilename.js`.
- Task 2 Step 4 (green): `25 passed (25)`, first implementation, no debugging.
  `../../etc/passwd` -> `etcpasswd.mp4` passed as written; the sanitize-before-split
  order in the plan is correct.

## Final verification (every command run BARE, redirected to a file, never piped)

| Command (from) | Result |
|---|---|
| `npx vitest run test/mediaTypes.test.ts test/mediaFilename.test.ts test/mediaMirror.test.ts test/inboundEmail.test.ts test/mmsMedia.test.ts` (from `app/`) | `Test Files 5 passed (5)`, `Tests 134 passed (134)`, exit **0** |
| `npm run typecheck` (from worktree root) | all six workspaces clean, exit **0** |
| `npx eslint` on the 6 touched/created files (worktree root) | zero output, exit **0** |

Per-file counts in the final run: `mediaTypes` 20, `mediaFilename` 25,
`mediaMirror` 11, `inboundEmail` 66, `mmsMedia` 12.

Not run, by instruction (later phases own them): `npm test` (full), `npm run smoke`,
`npm run e2e`.

## Pre-existing assertions updated

**NONE.** This is worth stating because the plan's Step 5 explicitly anticipated
having to update one. It did not come up: a repo-wide sweep of every
`octet-stream` assertion in `app/test/` found that every existing collapse case
uses a type that is STILL opaque by design -

- `mediaTypes.test.ts:39-44` - `text/html`, `image/svg+xml`,
  `application/xhtml+xml`, `undefined`.
- `inboundEmail.test.ts:988` - `application/x-weird` (opaque, as the brief said).
- `mmsMedia.test.ts:159-168` - `text/html` at store time.
- `twilioSmsWebhook.test.ts:1051` - the params set `MediaUrl{0,1}` with NO
  `MediaContentType{i}`, so the target's contentType is `undefined` -> opaque.
- `contactMedia.test.ts:237` and `mediaAttachments.test.ts:22-25` - the legacy
  `media_s3_keys` fold in `mediaAttachmentsOf`, which never calls
  `normalizeStoredMediaType`. Untouched by this slice.

So nothing was weakened and nothing was rewritten to stay green.

## Deviations from the plan

**None substantive.** Every source and test block was taken verbatim from the plan.
Two additions the plan asked for in prose rather than in a code block:

1. Task 1 Step 5's second inbound-email case ("Also assert that an inbound
   `text/html` part is STILL stored as `application/octet-stream`") had no code
   block; written as
   `it('still stores an inbound text/html attachment as octet-stream')` using the
   same `makeWorld` / `mime({attachments:[...]})` / `notice()` harness as its
   siblings.
2. The `normalizeStoredMediaType` docblock was rewritten (the plan said "update
   its docblock to say it now keeps declarable types too"). The replacement is
   ASCII-only; the ORIGINAL contained em-dashes and an ellipsis, which is why it
   had to be retyped rather than partially edited. `mediaTypes.ts` remains a
   pre-existing non-ASCII file (the header comment at :1-14 and the email-section
   comment still carry em-dashes) - untouched, per the added-lines-only rule.

ASCII was verified mechanically, not by eye: a Node scan over the diff's `+`
lines for Task 1 and over both new files for Task 2 reported zero non-ASCII added
lines. (`grep -P` is unusable in this Git Bash - "supports only unibyte and UTF-8
locales".) The `mediaFilename` fixtures are built with `String.fromCharCode`
(`0xe9`, `0x4f60 0x597d`, `0xd800`) exactly as the plan specifies.

## Surprises

None that changed the work. Two observations for the record:

- The `mmsMedia.test.ts` run prints two `level:50` `UnrecognizedClientException`
  ("security token is invalid") lines from `relay.fanOut` / `contactsRepo.getById`.
  The file passes 12/12; this is pre-existing captured-log noise from a
  deliberately-failing job path, unrelated to this slice (nothing here touches
  `contactsRepo`). Mentioned only so the next reader does not attribute it.
- `docs/issues/media-serve-stored-xss.md:30-32` now contradicts the shipped code
  (it records that "`...; charset=...` parameter forms cannot bypass it" as part
  of the fix; essence matching newly admits the parameterized forms of
  ALLOWLISTED types). Spec 5.1 requires that issue be amended. **That belongs to
  Task 8 (S7)** and was deliberately NOT touched here - flagging it so it is not
  lost.

## What the next slice needs to know

- **The branch is not mergeable until Task 4 lands.** Task 1 has now widened what
  the mirror stores, so a newly received HEIC is stored as `image/heic`, and both
  dashboard galleries still branch on `contentType.startsWith('image/')` - they
  would render it as a broken `<img>`. Plan "Slice integrity" says so; it is now
  live rather than hypothetical.
- Exports available to Task 3 from `app/src/lib/mediaTypes.js`: `resolveMediaTier`,
  `isAcceptedExtension`, `DECLARABLE_MEDIA_TYPES`, `type MediaTier`,
  `interface ResolvedMediaType`. `MEDIA_TYPE_EXTENSIONS` and `ACCEPTED_EXTENSIONS`
  are module-private by design - reach them through the two functions.
- From `app/src/lib/mediaFilename.js`: `buildMediaFilenameParts`,
  `buildMediaFilename`, `contentDispositionHeader`, `interface MediaFilename`.
  `contentDispositionHeader` takes `MediaFilename`, not a bare string, so the
  serve route should call `buildMediaFilenameParts` (not `buildMediaFilename`) to
  keep the `filename*` form.
- `index` is ZERO-based in, ONE-based out. The serve route passes the URL's index
  straight through.
- `isInlineMediaType` and its exact-match semantics are UNCHANGED and pinned by a
  new test naming `routes/mmsMedia.ts:78`. Task 3 replaces the serve route's use
  of it with `resolveMediaTier`; it must not touch the function itself.
- `normalizeStoredMediaType` is imported but UNUSED at `app/src/routes/api.ts:23`
  (worklist confirms). Task 3's import edit at that line should account for it.
- Worklist correction C2 (real serve-route coordinates, `api.ts:2251-2309`, header
  block `:2291-2296`) still stands and was not consumed by this slice.
