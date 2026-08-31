# Slice 4 - direct-manipulation image inspection

## Result

- Shipped commit `d648d941327819918d82fee8c4fbad95710d9303` (`feat: add direct-manipulation image inspection`).
- Added exact dashboard runtime dependency `react-zoom-pan-pinch` `4.0.4`; root and app manifests were unchanged, and the root lockfile contains the single package entry.
- Completed the probe-driven loading, bitmap-fitted transform, keyboard announcement, diagnostics, failure, gesture-containment, and mobile safe-area viewer shell.
- Preserved `ImageViewerProps`, the media `Modal` integration, the provider dismissal boundary, and the visible Close/Download-only action contract.

## TDD evidence

- RED: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewer.test.tsx src/ui/imageViewer/fitImage.test.ts`
  - Exit 1.
  - `ImageViewer.test.tsx`: 8/8 new behavioral tests failed against the Slice 3 shell because loading/probe/transform/keyboard/error behavior was absent.
  - `fitImage.test.ts`: failed to collect because `fitImage.ts` did not exist.
  - Full output is preserved in `.superpowers/sdd/slice4-red.log`.
- First geometry GREEN: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/fitImage.test.ts`
  - Exit 0; 1 file and 7 tests passed.
- Owned viewer GREEN: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewer.test.tsx src/ui/imageViewer/fitImage.test.ts`
  - Exit 0; 2 files and 15 tests passed with no stderr warning.
- Cross-slice RED: the first full focused battery exited 1 with 38/39 tests passing because `ImageViewerProvider.test.tsx:169` still synchronously queried the meaningful image before the approved hidden probe load.
  - The orchestrator authorized a targeted scope expansion for that test only.
  - The provider production component was not changed.
  - The test now installs the Slice 4 observer and calls `loadViewerImage(dialog, IMAGE.alt)` before retaining the same dialog-scoped image assertions.

## Final focused verification

- `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewer.test.tsx src/ui/imageViewer/fitImage.test.ts src/ui/imageViewer/ImageViewerProvider.test.tsx src/routes/contact/Modal.test.tsx`
  - Exit 0; 4 files and 39 tests passed: 8 viewer, 7 fit helper, 8 provider, and 16 Modal.
- `npm run typecheck -w @housingchoice/dashboard`
  - Exit 0.
- `npx eslint dashboard/src/ui/imageViewer/ImageViewer.tsx dashboard/src/ui/imageViewer/ImageViewer.test.tsx dashboard/src/ui/imageViewer/ImageViewer.testUtils.ts dashboard/src/ui/imageViewer/fitImage.ts dashboard/src/ui/imageViewer/fitImage.test.ts dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`
  - Exit 0 with no output.
- `npm ls react-zoom-pan-pinch -w @housingchoice/dashboard`
  - Exit 0 and resolved exactly `react-zoom-pan-pinch@4.0.4` below `@housingchoice/dashboard@0.1.0`.
- Dependency scope probe found manifest references only in `dashboard/package.json` and the root lockfile; `git diff --exit-code HEAD^ -- app/package.json` exited 0.
- `git diff --cached --check` exited 0 before commit.
- Full `npm test`, smoke, and e2e were intentionally not run for this slice.

## Shipped interfaces and geometry

- `fitImage.ts` exports:
  - `Size { width: number; height: number }`
  - `fitImageToCanvas(natural: Size, canvas: Size): Size`
- `fitImageToCanvas` uses the smaller natural-to-canvas axis ratio, returns the exact fitted bitmap box, and returns `{ width: 0, height: 0 }` for any non-positive input dimension.
- `ImageViewer.testUtils.ts` exports exactly:
  - `installImageViewerResizeObserver(size: Size): () => void`
  - `loadViewerImage(dialog: HTMLElement, alt: string, natural?: Size): Promise<HTMLImageElement>`
- The observer helper installs a synchronous positive canvas observer and restores the prior global. The load helper finds only the supplied dialog's `data-image-viewer-probe="true"`, defines its natural size, fires load, and returns the meaningful image through `within(dialog).findByRole`.
- The viewer mounts `TransformWrapper` only after both natural and canvas sizes are positive, and keys it by token plus fitted width/height. `TransformComponent` and the image share the fitted bitmap box, while the wrapper fills the canvas.
- Top-level package props are fixed at `initialScale={1}`, `minScale={1}`, `maxScale={8}`, `smooth={false}`, `disablePadding`, `centerOnInit`, `centerZoomedOut`, and `limitToBounds`, with wheel step 0.2, pinch step 5/allowPanning, left pan, and disabled double-click.

## Downstream renderer contract

- Timeline, MediaGallery, and host tests must install `installImageViewerResizeObserver({ width: 1000, height: 600 })` before rendering an image-bearing provider tree and restore the returned cleanup afterward.
- After a renderer trigger opens the dialog, tests must call `await loadViewerImage(dialog, expectedAlt)` before asserting on the meaningful image.
- Meaningful image queries remain scoped to the supplied dialog so they cannot collide with mounted Timeline or MediaGallery thumbnails.
- Renderers continue to call only `useImageViewer().openImage`; they do not own loading, transform, keyboard, or failure state.

## Files committed

- `dashboard/package.json`
- `package-lock.json`
- `dashboard/src/ui/imageViewer/ImageViewer.tsx`
- `dashboard/src/ui/imageViewer/ImageViewer.module.css`
- `dashboard/src/ui/imageViewer/ImageViewer.test.tsx`
- `dashboard/src/ui/imageViewer/ImageViewer.testUtils.ts`
- `dashboard/src/ui/imageViewer/fitImage.ts`
- `dashboard/src/ui/imageViewer/fitImage.test.ts`
- `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx` (orchestrator-authorized stale assertion correction)
