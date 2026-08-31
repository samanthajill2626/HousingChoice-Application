# Slice 2 report - Task 3 (the media serve route)

Branch `feat/media-content-type-fidelity`, worktree `W:\tmp\media-content-type-fidelity`.
Base for this slice: `17ab93cd` (end of slice 1). Working tree clean at handback.

## Commit

| Hash | Message | Paths |
|---|---|---|
| `8427542a` | `fix(media): serve inbound media with its true type and a real filename` | `app/src/routes/api.ts`, `app/test/apiRoutes.test.ts`, `app/test/mmsMedia.test.ts` |

3 files changed, 130 insertions(+), 19 deletions(-). Staged by explicit path (no
`git add -A`), bare `git status` read before the commit, `MERGE_HEAD` confirmed
absent in the worktree's REAL git dir
(`W:\AI Projects\Housing Choice\HC Application\.git\worktrees\media-content-type-fidelity\`
- the `.git` in the worktree root is a FILE). Carries the
`Co-Authored-By: Claude Opus 5 (1M context)` trailer.

## TDD sequence actually followed

| Step | Command | Result |
|---|---|---|
| 1 (red) | `npx vitest run test/apiRoutes.test.ts` | `7 failed \| 28 passed (35)`, exit 1. First failure is the plan's predicted one: the declarable case got `application/octet-stream` for `video/mp4`. |
| 3-4 (green) | `npx vitest run test/apiRoutes.test.ts` | `2 failed \| 33 passed (35)`, exit 1 - ALL EIGHT new cases green on the first implementation, no debugging; the only two failures are the pre-existing `toBeUndefined` inline assertions Step 5 exists to move. |
| 5 (final) | `npx vitest run test/apiRoutes.test.ts test/mmsMedia.test.ts` | `Test Files 2 passed (2)`, `Tests 47 passed (47)`, exit **0**. |

Note on the red run: 7 of 8 new cases failed, not 8. `refuses to render a
script-capable type stored on the OBJECT` passed BEFORE the change - by design.
It asserts `toMatch(/^attachment/)` on a `text/html` object, and the old code
already forced that to an octet-stream attachment. It is a REGRESSION PIN for the
stored-XSS gate, not a new behaviour, so passing red is the correct signal.

## Per-file test counts (final run)

| File | Tests | Delta |
|---|---|---|
| `app/test/apiRoutes.test.ts` | 35 | +8 (was 27) |
| `app/test/mmsMedia.test.ts` | 12 | unchanged |

## Verification (every command run BARE, redirected to a file, never piped)

| Command (from) | Result |
|---|---|
| `npx vitest run test/apiRoutes.test.ts test/mmsMedia.test.ts` (from `app/`) | `2 passed (2)` / `47 passed (47)`, exit **0** |
| `npm run typecheck` (worktree root) | all six workspaces clean, exit **0** |
| `npx eslint app/src/routes/api.ts app/test/apiRoutes.test.ts app/test/mmsMedia.test.ts` (worktree root) | zero output, exit **0** |
| ASCII scan (Node, over the diff's `+` lines for all three files) | 130 added lines, **0** non-ASCII |

Not run, by instruction (later phases own them): full `npm test`, `npm run smoke`,
`npm run e2e`.

## Exact final header block as shipped (`app/src/routes/api.ts:2284-2304`)

```ts
    // The stored Content-Type is the MMS sender's, so it is untrusted content
    // on an authenticated transport. resolveMediaTier is the ONE place that
    // decides what we do with it:
    //   inline      - allowlisted raster images + PDF, rendered same-origin
    //   declarable  - not script-capable, so served TRUTHFULLY, but always as
    //                 a download (attachment) - never rendered
    //   opaque      - anything else, including every script-capable type and
    //                 anything unrecognised: octet-stream + .bin
    // It runs on the OBJECT's own type, not the message record's: objects
    // mirrored before the 2026-06-18 normalize fix can still carry text/html
    // at rest, and that population is why this gate exists at all.
    // Belt-and-braces regardless of tier: nosniff + a restrictive CSP.
    const resolved = resolveMediaTier(object.contentType);
    const filename = buildMediaFilenameParts(attachments[idx]?.filename, idx, resolved);
    res.setHeader('Content-Type', resolved.canonical);
    res.setHeader(
      'Content-Disposition',
      contentDispositionHeader(resolved.tier === 'inline' ? 'inline' : 'attachment', filename),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
```

Byte-identical to the plan's Step 3 block. Preserved untouched immediately below
it, exactly as worklist C2 requires: the `Content-Length` passthrough
(now `:2305-2307`) and the `Cache-Control` line (`:2309`).

Log line (`:2310`), `inline` swapped for `tier`, filename NOT logged:

```ts
    log.info({ providerSid, mediaIndex: idx, tier: resolved.tier }, 'streaming inbound MMS media to the dashboard');
```

Imports (`api.ts:23-24`), replacing the single old line:

```ts
import { isTwilioDeliverableType, resolveMediaTier } from '../lib/mediaTypes.js';
import { buildMediaFilenameParts, contentDispositionHeader } from '../lib/mediaFilename.js';
```

`isInlineMediaType` was dropped after a grep of the whole file confirmed its ONLY
use was the `:2292` line this task replaced. `normalizeStoredMediaType` was
already imported-and-unused (a pre-existing defect the plan called out) and is
dropped too. `isTwilioDeliverableType` survives; its one call site is `:530`
(shifted +1 by the added import line).

## Deviations from the plan

**One, and it is the plan's own intent rather than a departure.** The plan's file
header says "REPLACE the header block at `:2283-2298`" while worklist C2 narrows
the replacement to `:2291-2296`. In the live tree those two readings differ by the
EIGHT-line `// XSS HARDENING ...` comment at `:2283-2290`, and the plan's
replacement text opens with its own superseding comment. I removed the old
comment.

Reason: it had become factually WRONG. It stated that "anything else (text/html,
image/svg+xml, application/*, absent) is forced to an octet-stream ATTACHMENT",
which the declarable tier now contradicts - `video/mp4` is served as `video/mp4`.
Keeping it would have left two adjacent comments describing the same six lines,
one of them lying about the security posture. That is the exact hazard the
comment exists to prevent. Nothing executable was touched by this beyond the
lines C2 names.

It also happens to reconcile the two coordinate systems: the old comment is 8
lines and the old code 8 lines, so plan-`:2283-2298` and live-(comment + C2's
`:2291-2296` + the re-stated nosniff/CSP at `:2297-2298`) describe the same
16-line span.

No other deviation. Both test blocks and the implementation block are verbatim
from the plan; the non-ASCII fixture is built with `String.fromCharCode(0xe9)` as
specified.

## Pre-existing assertions updated - exactly three, found by the SCOPED grep

`grep -n "content-disposition'\]).toBeUndefined" test/mmsMedia.test.ts test/apiRoutes.test.ts`
run from `app/`, those two files only, returned exactly the three the plan
predicted. Each is now `toMatch(/^inline; filename="/)`:

- `app/test/apiRoutes.test.ts:648` - the image-inline case (now sends
  `inline; filename="attachment-1.png"`).
- `app/test/apiRoutes.test.ts:661` - the PDF-inline case (now
  `inline; filename="attachment-1.pdf"`).
- `app/test/mmsMedia.test.ts:229` - the webhook-driven `image/jpeg` case.

**`app/test/unitMediaServe.test.ts:77` was NOT touched** - a repo-wide grep hits
it, but it covers a DIFFERENT serve route (`routes/unitMediaServe.ts`) that spec
section 12 defers. It still asserts an absent disposition and still passes,
because that route is unchanged.

The contrast assertion at `apiRoutes.test.ts:672`
(`toMatch(/^attachment/)` for a non-allowlisted stored type) was left alone and
stayed green: `application/octet-stream` is still opaque, so it still downloads.

Nothing was weakened. The two moved inline assertions gained information rather
than losing it - `inline` is the browser default when no disposition is sent, so
rendering did not move; the assertions now also pin that a name is emitted.

## Surprises

**None.** Every failure and every pass landed where the plan said it would. Two
observations for the record, neither of which changed the work:

- The `mmsMedia.test.ts` run still prints the two `level:50`
  `UnrecognizedClientException` lines slice 1 noted (from `relay.fanOut` /
  `contactsRepo.getById`). Pre-existing captured-log noise from a
  deliberately-failing job path; the file passes 12/12.
- The comment above `mmsMedia.test.ts:229` ("Allowlisted image -> INLINE (no
  attachment disposition) so the `<img>` renders") was left as-is. It remains
  true - the disposition is not `attachment` - and the line carries a
  pre-existing non-ASCII arrow, so rewriting it would have meant retyping a line
  this task has no reason to own.

## What the next slice (S3 / Task 4) needs to know

- **The branch is still not mergeable until Task 4 lands**, for the reason slice
  1 recorded and this slice makes visible: the serve route now returns
  `image/heic` (and `video/mp4`, `text/csv`, ...) with its true type, and both
  dashboard galleries still branch on `contentType.startsWith('image/')` - a HEIC
  would render as a broken `<img>`.
- The API contract Task 4's UI must assume is now settled and pinned by tests:
  inline tier -> `Content-Type: <true type>` + `inline; filename="..."`;
  declarable -> `<true type>` + `attachment; filename="..."`; opaque ->
  `application/octet-stream` + `attachment; filename="....bin"`.
  `X-Content-Type-Options: nosniff` and `default-src 'none'; sandbox` are on
  EVERY response regardless of tier.
- Task 8's amendment list grows by one: `docs/issues/media-serve-stored-xss.md`
  body cites `api.ts:813-820` for this block; it is now `api.ts:2284-2304`, and
  the eight-line `// XSS HARDENING` comment that issue describes no longer exists
  under that name. Worklist C6 already tracks the anchor refresh - this is the
  concrete new value.
- `resolveMediaTier` is called ONCE per served object, on `object.contentType`.
  The message record's `contentType` is deliberately NOT consulted for the tier;
  only `attachments[idx]?.filename` is read from the record.
