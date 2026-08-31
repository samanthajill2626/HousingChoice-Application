# Slice 3 report - Task 4 (both dashboard galleries)

Branch `feat/media-content-type-fidelity`, worktree `W:\tmp\media-content-type-fidelity`.
Base for this slice: `8427542a` (end of slice 2). Working tree clean at handback.

**This slice closes the mergeability gap slices 1 and 2 opened.** The serve route
now returns `image/heic` (and `video/mp4`, `text/csv`, ...) truthfully; until this
commit both galleries branched on `contentType.startsWith('image/')` and would
have rendered a HEIC as a broken `<img>`.

## Commit

| Hash | Message |
|---|---|
| `22ae6981` | `fix(dashboard): branch both galleries on renderable types, not image/*` |

6 files changed, 228 insertions(+), 13 deletions(-). Staged by explicit path (no
`git add -A`), bare `git status` read before the commit, `MERGE_HEAD` confirmed
absent in the worktree's REAL git dir
(`W:\AI Projects\Housing Choice\HC Application\.git\worktrees\media-content-type-fidelity\`
- the `.git` in the worktree root is a FILE). Carries the
`Co-Authored-By: Claude Opus 5 (1M context)` trailer.

## Per-file counts

| File | Diff | Tests after | Delta |
|---|---|---|---|
| `dashboard/src/routes/contact/media.ts` | +69 | - | the three mirrored helpers, appended |
| `dashboard/src/routes/contact/Timeline.tsx` | +19 / -9 | - | import, `attachmentLabel`, predicate, 2 call sites |
| `dashboard/src/routes/contact/MediaGallery.tsx` | +2 / -2 | - | mixed import + predicate |
| `dashboard/src/routes/contact/media.test.ts` | +63 / -1 | 13 | +8 (was 5) |
| `dashboard/src/routes/contact/Timeline.test.tsx` | +41 | 116 | +3 (was 113) |
| `dashboard/src/routes/contact/MediaGallery.test.tsx` | +35 (new file) | 2 | +2 (created) |

13 new tests in total.

## TDD sequence actually followed

| Step | Command (from `dashboard/`) | Result |
|---|---|---|
| 1-2 (red) | `npx vitest run src/routes/contact/media.test.ts src/routes/contact/Timeline.test.tsx` | `10 failed \| 119 passed (129)`, exit **1** |
| 5 (green) | `npx vitest run src/routes/contact/` | `54 passed (54)` / `933 passed (933)`, exit **0** |

**The red run failed 10 of the 11 new tests, not 11 - and the one that passed red
is the point.** `leaves an opaque attachment labelled bare` asserts
`application/octet-stream` still renders as a plain `Attachment 1`, which is
exactly today's behaviour. It is a REGRESSION PIN against applying the kind rule
too widely, so passing red is the correct signal. The other 10 were the 8
`is not a function` helper failures plus the two real behavioural ones: HEIC
rendered as an `<img>`, and `video/mp4` had no kind word.

## Verification (every gate command run BARE)

| Command (from) | Result |
|---|---|
| `npx vitest run src/routes/contact/` (from `dashboard/`) | `54 passed (54)` / `933 passed (933)`, exit **0** |
| `npm run typecheck` (worktree root) | all six workspaces clean, exit **0** |
| `npx eslint <the six touched files>` (worktree root) | 1 error, **pre-existing** - see below |
| ASCII scan (Node, over the diff's `+` lines + the whole new file) | 229 lines scanned, **0** non-ASCII |

Not run, by instruction: full `npm test`, `npm run smoke`, `npm run e2e`.

### The one lint error is pre-existing, attributed by BASELINE not by line number

`Timeline.tsx:1229 react-hooks/set-state-in-effect` (the staleness ticker's
`setNow(fresh)`). Linting `HEAD:dashboard/src/routes/contact/Timeline.tsx`
(the pre-slice file, via `--stdin-filename`) reports the SAME single error at
`:1221` - the 8-line shift is exactly this slice's growth of `attachmentLabel`.
Pre-existing, untouched, NOT blocking. The other five files lint clean.

## The five (six) pinned assertions - ALL HOLD, none moved

Verified by `sed` after the green run: every one is byte-identical and still at
its original line number, and every file containing one is green.

| # | Pin | Status |
|---|---|---|
| 1 | `Timeline.test.tsx:552` `getByRole('img', { name: /Attachment 1/i })` | unmoved, green (116/116) |
| 2 | `Timeline.test.tsx:555` `getByRole('link', { name: /PDF attachment 2/i })` | unmoved, green |
| 3 | `Timeline.email.test.tsx:87` `getByText(/lease agreement\.pdf/)` | file UNMODIFIED, green (6/6) |
| 4 | `Timeline.email.test.tsx:88` `getByText(/Attachment 2/)` | file UNMODIFIED, green |
| 5 | `Timeline.email.test.tsx:107` `getByText(/Attachment 1/)` | file UNMODIFIED, green |
| 6 | `files.test.tsx:328` `getByRole('img', { name: /Attachment/i })` | file UNMODIFIED, green (35/35); `MediaGallery.tsx:44` `alt="Attachment"` untouched |

Both email fixtures behind pins 4 and 5 are `application/octet-stream` with no
filename (`:81`, `:104`) - the opaque tier, where `mediaKindWord` returns
`undefined`, so they stay bare.

**Worth knowing for review: pins 4 and 5 could not have caught over-application
on their own.** `getByText(/Attachment 2/)` is UNANCHORED, so it would still
match `Document - Attachment 2`. The assertion that actually holds the opaque
tier honest is this slice's new `leaves an opaque attachment labelled bare`,
which uses the anchored `/^\W*Attachment 1$/i` from the plan (the `\W*` absorbs
the paperclip glyph and its space).

`MediaGallery.tsx:56`'s literal emoji were left exactly as found (pre-existing
non-ASCII; only ADDED lines must be ASCII). No new glyph was needed anywhere.

## Deviations from the plan

**One forced, one additive. Nothing in the plan's shipped code blocks changed.**

### 1. `mmsWith` must be an ARROW, not a `function` declaration (forced by tsc)

The plan says to build `mmsWith` by parameterizing the existing MMS test's object
literal. Written as the obvious `function mmsWith(...): TimelineItem { return
{ ...MESSAGE_OUT, ... }; }` it typechecks RED:

```
Timeline.test.tsx(569,7): error TS2322: Type '{...} | {...} | {...} | {...}' is not
assignable to type 'TimelineItem'.
  Object literal may only specify known properties, and 'tsMsgId' does not exist in
  type 'TimelineCall'.
```

`MESSAGE_OUT` is declared as the `TimelineItem` UNION. At the existing test's call
site TS has narrowed that const to its `kind: 'message'` constituent by assignment,
so the spread is of ONE type. A hoisted `function` DECLARATION discards that
narrowing (the compiler cannot know when it is called), the spread distributes over
all four union members, and the `TimelineCall` branch trips excess-property checking
on `tsMsgId`. A function EXPRESSION created after the declaration keeps the
narrowing, so `const mmsWith = (...) => {...}` compiles clean with no cast.

I diagnosed this by experiment, not assumption: I first tested the plausible
hypothesis that the parameterized `media_attachments` variable was the trigger
(replacing it with an inline array literal) and it failed IDENTICALLY, which ruled
that out and pointed at the declaration form.

The fix is a real fix rather than a silencer - the literal is still fully checked
against `TimelineMessage`, so a bad field would still error. A cast (`as
Extract<TimelineItem, { kind: 'message' }>`) would also have compiled but would
have weakened checking, and this file already carries a comment at `:1387` about
exactly that hazard. The arrow's docblock records why the form is load-bearing so
nobody "tidies" it back into a `function`.

**This is the second time on this branch that a defect was invisible to vitest and
caught only by `npm run typecheck`** - vitest strips types via esbuild and ran the
`function`-declaration version 933/933 GREEN.

### 2. `MediaGallery.test.tsx` - a `MemoryRouter` harness and one extra assertion

The plan's Step 4b block calls `render(<MediaGallery ... />)` bare and says to
follow the neighbouring files' render helper. I wrapped it in `MemoryRouter` via a
local `renderGallery`, copying `files.test.tsx:1-18`. `MediaGallery` needs no
router today (its `EmptyRow` renders a bare `<p>`), so this is style-matching
insurance, not a requirement.

I also added ONE assertion to the HEIC test:
`expect(screen.getByRole('link', { name: 'image/heic' })).toBeInTheDocument()`.
The plan's version only asserts the absence of an `<img>`, which an empty render
would also satisfy; the test's name claims a FILE TILE, and the tile's accessible
name comes from its `title={m.contentType}`. This additionally pins that the true
type reaches the UI.

## Surprises

**One, and it is deviation 1 above** - `mmsWith`'s declaration form. Everything
else landed where the plan said it would, including which test would pass red.

Two notes for the record, neither of which changed the work:

- `dashboard/src/routes/contact/MediaGallery.test.tsx` did NOT exist, exactly as
  the brief and worklist stated. Created.
- There is no Prettier config in this repo and no `max-len` in `eslint.config.mjs`;
  `Timeline.tsx` already carries 23 lines over 100 columns, so the widened
  file-link call site was left on one line to match the file rather than
  introducing a `{' '}` idiom the file has never used (0 occurrences).

## What the next slice (S4 / Task 5) needs to know

- **The branch is MERGEABLE as of this commit** on the dashboard axis: no surface
  branches on `startsWith('image/')` for a comms attachment any more. The two
  composer-side branches read a local `File.type` (`Timeline.tsx:2189`, `:1615`,
  `EmailComposer.tsx:415`, `:212`) and are out of scope per worklist, unaffected.
- The tier vocabulary now exists on BOTH sides of the repo and must not drift:
  `app/src/lib/mediaTypes.ts` is the source of truth, and
  `dashboard/src/routes/contact/media.ts` carries the mirror with a header comment
  naming it. Any type added to the app-side declarable tier needs a `KIND_WORDS`
  entry here or the dashboard silently falls back to a bare positional label.
- `isDeclarableMediaType` is exported and unit-tested but has NO production call
  site yet - it is the third mirrored item spec 6.4 requires, kept so a caller
  asking "is this a known typed attachment" need not infer it from a truthy label.
  A reviewer flagging it as dead code should be pointed at spec 6.4.
- Optimistic timeline rows hardcode `application/octet-stream`
  (`useContactTimeline.ts:306`, `useRelayThread.ts:253`), so they land on the
  opaque tier and read `Attachment N` exactly as before. No work owed there.
