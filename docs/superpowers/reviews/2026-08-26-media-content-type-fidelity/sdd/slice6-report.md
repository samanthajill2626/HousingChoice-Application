# Slice 6 (plan Task 7): fake-twilio fixture + e2e spec

Branch: `feat/media-content-type-fidelity`
Commit: `dc3ed0e5` - `test(e2e): inbound declarable media is typed, named and file-linked`
Parent: `9102f63c` (slice 5)

## What shipped

Five explicit paths, exactly the planned surface:

- `fake-twilio/web/public/canned/contact-card.vcf` (new, 78 bytes, ASCII, LF) -
  the plan's exact content. Under `public/`, not `src/assets`: Vite inlines
  anything below `assetsInlineLimit` (4 KB) as a `data:` URI, which the
  engine's http(s)-only media guard rejects.
- `fake-twilio/src/engine/signer.ts` - `inferMediaContentType` gains
  `if (path.endsWith('.vcf')) return 'text/vcard';` before the final return,
  with a comment noting the fake's own express static serve says the legacy
  `text/x-vcard` for the same file and that the app reads the PARAM, not that
  header.
- `fake-twilio/web/src/assets/canned/index.ts` - `{ id: 'contact-card', url:
  cannedUrl('contact-card.vcf'), label: 'Contact card' }` APPENDED to
  `cannedAssets`; the file-header comment updated from "RASTER images (PNG) and
  a PDF" to include the vCard. `isImageAsset` unchanged (its raster regex
  already returns false for `.vcf`).
- `fake-twilio/web/src/assets/canned/index.test.ts` - `EXT` map gains
  `'contact-card': 'vcf'` (without it the URL-pathname pin compares against
  `/canned/contact-card.undefined`), and the `isImageAsset` case now asserts
  the vCard is a document. Test renamed "…except the document fixtures".
- `e2e/tests/dashboard-next/inbound-media-type.spec.ts` (new) - one test,
  1:1 thread, both halves asserted.

## Consumer tests: checked, none needed updating

`Composer.test.tsx`, `GroupPanel.test.tsx` and `MessageBubble.test.tsx` all
address the picker through `cannedAssets[0]` only. None pins an asset COUNT and
none enumerates the button list exhaustively. Appending (rather than inserting)
keeps `cannedAssets[0] === room`, so all three stayed green untouched. This is
why the registry carries an inline "Appended, never inserted" comment.

## Verification

`fake-twilio/web` (`npx vitest run` from `fake-twilio/web`):

```
 Test Files  13 passed (13)
      Tests  111 passed (111)
```

`fake-twilio` (`npx vitest run` from `fake-twilio`):

```
 Test Files  34 passed (34)
      Tests  240 passed (240)
```

`npm run typecheck` from the worktree root: green across all five workspaces
(app, dashboard, e2e, fake-twilio, fake-twilio-web).

`npx eslint` on the four touched `.ts` files: clean, exit 0, no output.

E2E, `cd e2e && npx playwright test tests/dashboard-next/inbound-media-type.spec.ts`,
own hermetic stack on lane 2 (no adoption - it created tables, built the fake UI
and started every child itself):

```
  ok 1 [chromium] > tests\dashboard-next\inbound-media-type.spec.ts:44:3 > Inbound declarable media > a vCard MMS is named on the timeline and served typed, as a download (2.1s)

  1 passed (23.8s)
```

The app log on the serve leg confirms the tier the feature exists for:

```
"providerSid":"MMfake19456426","mediaIndex":0,"tier":"declarable","msg":"streaming inbound MMS media to the dashboard"
...
"method":"GET","path":"/messages/MMfake19456426/media/0","statusCode":200,"durationMs":31
```

The lane's build step proves the new asset reaches the served `dist/`:

```
[e2e-session] fake-phones UI built in 5.8s -> W:\tmp\media-content-type-fidelity\fake-twilio\web\dist
```

Post-run: no node process and no listener remains for this worktree's lane
(9201/9211/9221/9231 all free). Playwright tore down the stack it started.

## Deviations

1. **Planned and already adjudicated:** the spec names a "few-KB .mp4"; this
   uses a `.vcf`. A vCard is plain ASCII, so the fixture is reviewable as
   source rather than as an opaque binary blob committed to the repo, and it
   exercises the identical declarable tier. A video would be a second asset,
   not a different design. Flagging only - not re-litigated.

2. **Minor, mine:** the plan's Step 5 stages `fake-twilio/` wholesale. Staged
   the five explicit paths instead, per the repo's commit discipline.

3. **Minor, mine:** the plan's example locator is a bare
   `timeline.getByRole('link', ...)`. The shipped spec appends `.first()`. A
   re-run against a warm lane (no reseed between runs) leaves an earlier,
   equally correct vCard bubble on Tasha's thread, and two matches would fail
   Playwright strict mode on a CORRECT render. Either match satisfies both
   halves of the assertion, so `.first()` costs nothing.

## Notes for the reviewer

- The chain the spec proves, end to end:
  `inferMediaContentType('.vcf') -> MediaContentType0 = text/vcard` ->
  `/webhooks/twilio/sms` -> `mirrorMediaSet` ->
  `normalizeStoredMediaType` keeps `text/vcard` (declarable) ->
  S3 object metadata -> `resolveMediaTier` at serve time ->
  `Content-Type: text/vcard` + `Content-Disposition: attachment; filename="attachment-1.vcf"`.
- The inbound mirror persists NO `filename` for MMS (only the email path does),
  so the timeline label is the positional fallback - which is exactly the label
  rule Task 4 added, and therefore what this spec is asserting.
- Nothing pins that the canned registry and `signer.ts`'s
  `inferMediaContentType` agree on a type. That gap is unchanged by this slice
  and is noted in the plan; the e2e is the only thing that would catch a drift.
