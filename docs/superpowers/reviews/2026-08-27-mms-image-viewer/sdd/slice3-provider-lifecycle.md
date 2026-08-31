# Slice 3 - app-level image viewer lifecycle

## Result

- Shipped commit `313017a8` (`feat: add app-level image viewer lifecycle`).
- Changed only:
  - `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx`
  - `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`
  - `dashboard/src/ui/imageViewer/ImageViewer.tsx`
  - `dashboard/src/ui/imageViewer/ImageViewer.module.css`
  - `dashboard/src/main.tsx`
- No unexpected importer, runtime cycle, or contract mismatch was found.

## TDD evidence

- RED: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx`
  - Exit 1.
  - 1 suite failed before collection because `./ImageViewerProvider.js` did not exist.
  - This was the expected missing-module failure for the absent provider and viewer shell.
- First behavioral GREEN: the same focused provider command exited 0 with 1 file and 8 tests passed.
- Final focused battery:
  - `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts src/routes/contact/Modal.test.tsx`
  - Exit 0; 4 files and 48 tests passed (8 provider, 20 history, 4 scroll, 16 Modal).
- `npm run typecheck -w @housingchoice/dashboard` exited 0.
- Targeted ESLint across the four owned TS/TSX files and `dashboard/src/main.tsx` exited 0 with no output.
- `git diff --check` exited 0.
- Full `npm test`, smoke, and e2e were intentionally not run for this slice.

## Shipped interface and lifecycle contract

- Exports `ViewerImage`, `ImageViewerContextValue`, `ImageViewerProvider`, and `useImageViewer` from `ImageViewerProvider.tsx`; exports `ImageViewerProps` from `ImageViewer.tsx`.
- `main.tsx` mounts one provider inside `BrowserRouter` and above `App`.
- `openImage` captures connected scroll owners synchronously, stores the descriptor only in a provider registry, and performs one same-URL router push carrying only the opaque marker. It ignores calls while a marker is already active.
- The registry retains at most 20 descriptors and evicts the oldest non-active token.
- Active viewer state is derived only from `useLocation()` marker state plus the in-memory registry. No selected-image boolean or raw History API write exists in production code.
- Close, Escape, and backdrop share one synchronous token guard and issue at most one `navigate(-1)` for the visible marker. Marker loss never navigates.
- Same-session Forward reopens retained descriptors and refreshes connected scroll snapshots. Exact-return dismissal restores surviving nested scroll owners, then focuses the connected trigger with `{ preventScroll: true }`; independent navigation and disconnected sources receive neither stale scroll nor focus writes.
- Structurally valid unknown markers are normalized once per `location.key:token` with router replacement and exact prior-state restoration. They never call Back or serialize descriptors.
- One stable provider-owned direct-body portal snapshots every other direct body HTMLElement's boolean `inert` value, makes those siblings inert, restores exact values, and only then removes the portal.
- The basic Slice 3 viewer uses the shipped media `Modal` variant with trapped focus, Close initial focus, delegated focus restoration, the exact same-context Download anchor, and a non-focusable fitted image shell.

## Focused coverage

- Real `BrowserRouter` plus React `StrictMode` covers one same-URL entry, already-marked open suppression, opaque router state, record-state preservation, Close, Back, Forward, Escape containment, backdrop sharing the dismissal guard, and duplicate synchronous dismissal.
- Coverage includes stable portal reuse, app-root and sibling-portal inert restoration, media layer marker, initial Close focus, exact Download behavior, nested x/y scroll restoration, Forward snapshot refresh, independent navigation, disconnected source/scroll owners, prior non-record normalization, clean Back/Forward after reload-like normalization, and normal forward-branch truncation on a new open.

## Downstream notes for Slice 4

- Keep `ImageViewerProps` and the provider dismissal/history boundary unchanged. Slice 4 owns transform/load/error/keyboard behavior inside `ImageViewer.tsx` and its CSS only.
- Preserve `Modal` integration exactly: `variant="media"`, `trapFocus`, `initialFocus="close"`, `restoreFocus={false}`, Download in `headerActions`, and no competing document Escape listener.
- The current shell intentionally has no gesture package, loading/error state, transform diagnostics, keyboard zoom, or hidden live announcement. Those are Task 4 responsibilities and were not approximated in this slice.
- Renderer, host, package/lockfile, and e2e files remain untouched for their assigned later slices.
