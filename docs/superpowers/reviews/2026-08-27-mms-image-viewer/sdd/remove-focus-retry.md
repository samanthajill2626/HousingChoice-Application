# Remove unproven viewer focus retry

## Scope

- Modified only `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx` and `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`.
- Retained commit `4178276e`'s idempotent portal/inert release before scroll and focus restoration.
- Removed only commit `de6a6535`'s deferred focus retry machinery and its four deferral/cancellation tests.

## Rationale

The corrected focused real-browser diagnostic proved the original clicked Timeline button remains connected and outside any inert tree, receives the final `focusin`, and is `document.activeElement` after both Escape and Back. The earlier E2E failure came from a dynamic `.last()` locator resolving a different duplicate thumbnail after Timeline updates. Keeping microtask/animation-frame retry behavior would attribute production complexity to a refuted defect.

## Removal proof

- `git diff 4178276e -- dashboard/src/ui/imageViewer/ImageViewerProvider.tsx dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`: no diff.
- `rg` found none of `PendingFocusRestore`, pending-focus refs, mounted/location/token refs, `queueMicrotask`, `requestAnimationFrame`, `cancelAnimationFrame`, controlled-microtask helpers, or the four deferral/cancellation test names in the two files.
- No replacement behavior was added.

## Verification

- `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts src/routes/contact/Modal.test.tsx`: EXIT 0; 4 files passed, 49 tests passed.
- `npm run typecheck -w @housingchoice/dashboard`: EXIT 0.
- `npx eslint dashboard/src/ui/imageViewer/ImageViewerProvider.tsx dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`: EXIT 0.
- E2E was deliberately not run in this cleanup slice; the orchestrator owns the exact browser rerun.

## Commit

- `48d21f60d0a8b4b997d3299371534fc708943142` - `refactor: remove unproven viewer focus retry`
- Exact source files committed: `ImageViewerProvider.tsx` and `ImageViewerProvider.test.tsx` only.
- Post-commit `git status --short`: clean.
