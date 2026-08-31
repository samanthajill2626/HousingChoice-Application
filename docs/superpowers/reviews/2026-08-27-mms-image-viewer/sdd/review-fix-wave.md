# Review fix wave

Commit: `775f4ed5be5799b4176a6adb88279f2dc6abfce5`

## Fixes

- Moved `ImageViewerProvider` from `main.tsx` into the authenticated side of
  `AuthGate`, preserving `BrowserRouter` access and all authenticated routes.
- Added an auth-level BrowserRouter regression proving signout unmounts the
  descriptor registry and Forward cannot render the old portal or title over
  Login.
- Added a positive backdrop-only dismissal regression with two nonzero nested
  scroll owners, exact x/y restoration, and exact connected-trigger focus
  restoration.
- Added a same-act duplicate-open regression and a synchronous in-flight-open
  latch that permits only the first navigation before Router commits.

## TDD proof

Red command:

`npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/App.test.tsx`

Exit 1. The new auth regression failed with
`useImageViewer must be used within ImageViewerProvider`, and the duplicate-open
regression rendered `Kitchen.jpg` instead of the first `Front porch.jpg` entry.
Vitest reported `2 failed | 19 passed (21)`. The backdrop-only test passed on
the baseline, consistent with SC-1 being a missing positive regression rather
than a confirmed production wiring defect.

Green command:

`npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/App.test.tsx`

Exit 0:

```text
Test Files  2 passed (2)
Tests  21 passed (21)
```

Dashboard typecheck:

`npm run typecheck -w @housingchoice/dashboard`

Exit 0:

```text
> tsc -p tsconfig.json --noEmit
```

`git diff --cached --check` also exited 0 before commit.

## Changed files

- `dashboard/src/main.tsx`
- `dashboard/src/App.tsx`
- `dashboard/src/App.test.tsx`
- `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx`
- `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`

The orchestrator-owned untracked
`docs/issues/authenticated-mms-media-browser-cache.md` was preserved and was not
staged or committed. AD-1 and AD-3 were not changed.
