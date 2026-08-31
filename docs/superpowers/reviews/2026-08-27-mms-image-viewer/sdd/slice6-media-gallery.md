# Slice 6 - shared MediaGallery image viewer

## Result

- Shipped commit `a1062c3673b63e119629d2d37234bf44ad8360c2` (`feat: open file gallery images in the shared viewer`).
- Only `isInlineRenderable(item.contentType)` tiles are now semantic buttons that call `useImageViewer().openImage`.
- The trigger contract is exactly `View image attachment` with `aria-haspopup="dialog"`; the viewer descriptor uses exact alt/title `Image attachment`.
- PDF, HEIC, and every other non-renderable tile remain same-URL anchors with their existing `target="_blank"`, `rel`, title, glyph, and source URL behavior.
- The mapped `key={item.key}`, input ordering, grid geometry, focus ring, and paging markup/behavior remain shared and unchanged. No gallery-selected state or viewer implementation was added.

## Live-tree adjudication

- The plan said to create `MediaGallery.test.tsx`, but the human-authorized media-classification prerequisite had already added it. The file was extended in place rather than replaced; its focused HEIC/JPEG tier tests remain present and now assert the new trigger boundary.

## Strict TDD evidence

- RED: `npm test -w @housingchoice/dashboard -- src/routes/contact/MediaGallery.test.tsx src/routes/contact/UnknownFile.test.tsx src/routes/contact/files.test.tsx`
  - Exit `1` before production edits.
  - 3 files failed; 3 expected viewer assertions failed and 43 tests passed.
  - Each failure found the old eligible-image `_blank` anchor and could not find the required `View image attachment` button.
- GREEN after the minimal renderer/CSS change: the same command exited `0`; 3 files and 46 tests passed.
- GREEN after retaining the prerequisite tier tests: the same command exited `0`; 3 files and 48 tests passed.

## Final focused verification

- `npm test -w @housingchoice/dashboard -- src/routes/contact/MediaGallery.test.tsx src/routes/contact/UnknownFile.test.tsx src/routes/contact/files.test.tsx src/routes/contact/media.test.ts`
  - Exit `0`; 4 files and 61 tests passed.
- `npm run typecheck -w @housingchoice/dashboard`
  - Exit `0`.
- `npx eslint dashboard/src/routes/contact/MediaGallery.tsx dashboard/src/routes/contact/MediaGallery.module.css dashboard/src/routes/contact/MediaGallery.test.tsx dashboard/src/routes/contact/UnknownFile.test.tsx dashboard/src/routes/contact/files.test.tsx`
  - Exit `0`; no errors. ESLint emitted the expected one warning that CSS has no matching configuration.
- `git diff --check`
  - Exit `0` before staging.
- Post-commit `git status --short` was empty.

## Shared-gallery and host proof

- `MediaGallery.test.tsx` uses ordered new-image, old-image, PDF, and HEIC fixtures. It proves image-button order, unchanged file-link order/targets, exact accessible names, dialog-scoped probe loading, one image at a time, no Previous/Next controls, close-before-second behavior, focus restoration, and paging action/disabled state.
- `UnknownFile.test.tsx` is the representative real file-pane host proof.
- `files.test.tsx` updates the existing TenantFile image-bearing harness to `MemoryRouter -> ImageViewerProvider` and proves the authenticated media URL reaches the loaded meaningful viewer image.
- Every image-bearing test installs and restores `installImageViewerResizeObserver({ width: 1000, height: 600 })`, obtains the labelled dialog, calls `await loadViewerImage(dialog, 'Image attachment')`, and scopes meaningful image assertions to that dialog.

## File-pane callsite inventory

Read-only `rg -n "<MediaGallery"` found exactly one shared callsite in each reader and no host-local viewer branch:

- `dashboard/src/routes/contact/TenantFile.tsx:362`
- `dashboard/src/routes/contact/LandlordFile.tsx:266`
- `dashboard/src/routes/contact/PartnerFile.tsx:118`
- `dashboard/src/routes/contact/UnknownFile.tsx:211`

Production remains app-owned: all four readers reach the one `MediaGallery`, whose eligible child owns the hook, while the existing app-level provider owns selection, history, portal, loading, transform, and dismissal behavior.

## Files committed

- `dashboard/src/routes/contact/MediaGallery.tsx`
- `dashboard/src/routes/contact/MediaGallery.module.css`
- `dashboard/src/routes/contact/MediaGallery.test.tsx`
- `dashboard/src/routes/contact/UnknownFile.test.tsx`
- `dashboard/src/routes/contact/files.test.tsx`
