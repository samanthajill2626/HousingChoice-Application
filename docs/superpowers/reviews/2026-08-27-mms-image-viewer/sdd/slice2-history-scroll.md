# Slice 2 - history and scroll primitives

## Result

- Commit: `b0290ed06514bdfba30959c8bbff05d6273d3d98` (`feat: add image viewer history and scroll primitives`)
- Scope: four new files under `dashboard/src/ui/imageViewer/`; no other source or test file changed.
- Worktree was clean after the commit.

## TDD evidence

- RED: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts`
  - Exit: 1
  - Result: 2 failed suites, 0 collected tests.
  - Expected cause: Vite could not resolve absent `./history.js` and `./scroll.js` production modules.
- GREEN: same focused command after implementation.
  - Exit: 0
  - Result: 2 test files passed; 24 tests passed (20 history, 4 scroll).
- Dashboard typecheck: `npm run typecheck -w @housingchoice/dashboard`
  - Exit: 0
- Targeted lint: `npx eslint dashboard/src/ui/imageViewer/history.ts dashboard/src/ui/imageViewer/history.test.ts dashboard/src/ui/imageViewer/scroll.ts dashboard/src/ui/imageViewer/scroll.test.ts`
  - Exit: 0
- Whitespace check: `git diff --check`
  - Exit: 0

## Shipped APIs and behavior

- `ImageViewerMarker { token: string; returnLocationKey: string }`
- `readImageViewerMarker(state: unknown): ImageViewerMarker | undefined`
- `addImageViewerMarker(state: unknown, marker: ImageViewerMarker): Record<string, unknown>`
- `removeImageViewerMarker(state: unknown): unknown`
- `ScrollSnapshot { element: HTMLElement; top: number; left: number }`
- `captureScrollOwners(trigger: HTMLElement): ScrollSnapshot[]`
- `restoreScrollOwners(snapshots: readonly ScrollSnapshot[]): void`

History uses a structurally validated version-1 owned marker. It preserves plain-record fields and both reserved-key collisions, and wraps non-record state instead of spreading it. Tests cover null, undefined, primitives, arrays, Date, Map, Set, class instances, malformed marker shapes, nonempty public fields, ordinary record restoration, and both reserved namespaces.

Scroll capture walks connected ancestors nearest-first, includes independently scrollable x or y owners, always includes an HTML `document.scrollingElement`, and deduplicates it when ancestor discovery already found it. Restoration writes the exact saved x/y values only to owners that remain connected. Tests cover nested AppFrame-like and Timeline-like owners, document dedupe, disconnected capture lookalikes, exact restoration, and post-capture disconnection.

## Downstream contract for Slice 3

- Import the primitives from `./history.js` and `./scroll.js`.
- Router state is opaque `unknown`; do not inspect or reconstruct the private marker metadata outside `history.ts`.
- `readImageViewerMarker` intentionally exposes only the public token and return-location key.
- Call `captureScrollOwners` synchronously from `openImage` while the trigger and its route ancestors are still connected.
- On verified return to the marker's exact location key, call `restoreScrollOwners` before `trigger.focus({ preventScroll: true })`; independent navigation must perform neither write.
- Retain the returned snapshot array as provider-owned state. Disconnected owners and triggers are valid and must be skipped rather than treated as errors.
