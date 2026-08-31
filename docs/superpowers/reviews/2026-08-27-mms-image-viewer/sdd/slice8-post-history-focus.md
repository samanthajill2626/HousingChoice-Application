# Slice 8 post-history focus correction

## Commit and scope

- Commit: `de6a6535685119b761f76491298cd6d27bb4c817` (`fix: defer image viewer focus after history close`).
- Owned files only: `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx` and `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`.
- The intentional uncommitted `e2e/tests/dashboard-next/outbound-mms.spec.ts` edit remained unstaged and byte-preserved throughout this slice.

## Race diagnosis and correction

The first correction at `4178276e` made portal and inert release happen before the synchronous trigger focus call. Real Chromium still failed both Desktop Escape and mobile `page.goBack()` focus assertions after the viewer had closed. That narrows the remaining boundary to focus timing inside the same React history-close commit: the provider was attempting focus while the disappearing dialog/portal subtree and browser inert/focus teardown were still settling, and Chromium subsequently left focus on `body`. jsdom's focus model does not reproduce that browser ordering.

Verified dismissal still releases the portal and restores exact scroll synchronously. Trigger focus is now a guarded post-commit operation. A microtask waits until the current React commit is complete, then focuses only if the provider is mounted, the exact return location key remains current, no viewer marker has become active, and the exact trigger is still connected. A following animation-frame check covers the real-browser case where focus is dropped during the first paint after dialog removal; it repeats the focus write only when the trigger no longer owns focus.

The pending restore is canceled synchronously when `openImage` starts a new viewer, when a later location commit has an active marker or a different location key, and when the provider unmounts. A queued callback also checks object identity plus the current key/marker/mount/connection state, so a canceled microtask or animation-frame callback cannot refocus an old route or stale thumbnail.

Scroll restoration, Forward snapshot refresh, unknown-marker normalization, the single-dismiss guard, disconnected-trigger handling, independent-route behavior, and exact inert restoration are unchanged.

## Strict TDD evidence

- RED before the production correction: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx` -> exit 1; 4 new temporal/cancellation tests failed and 9 existing tests passed. Each failure showed the pre-fix synchronous `focus({ preventScroll: true })` call occurring before the held post-commit queue.
- GREEN on the committed implementation: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts src/routes/contact/Modal.test.tsx` -> exit 0; 4 files passed, 53 tests passed.
- GREEN compatibility probe on the committed scheduling path: `npm test -w @housingchoice/dashboard -- src/routes/contact/ContactCommsPane.test.tsx -t "keeps its selected Timeline filter while an image uses the shared viewer"` -> exit 0; 1 passed, 17 skipped.
- GREEN: `npm run typecheck -w @housingchoice/dashboard` -> exit 0.
- GREEN: `npx eslint dashboard/src/ui/imageViewer/ImageViewerProvider.tsx dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx` -> exit 0.

## Browser evidence and residual risk

- Supplied pre-fix browser RED: focused Outbound MMS Playwright exited 1 with 6 passed and 2 failed; only Desktop Escape and mobile Back exact focus restoration timed out after 15 seconds, while the dialog close, route, trigger visibility, geometry, zoom, pan, bounds, and scroll assertions had passed.
- This worker did not start a competing E2E stack. jsdom proves the temporal and cancellation ownership but cannot prove Chromium's inert/portal focus timing. The Slice 8 owner must rerun `npm run e2e -w @housingchoice/e2e -- --grep "Outbound MMS"`; that is the decisive browser result.

## Final tree state

`git status --short` after commit reports only ` M e2e/tests/dashboard-next/outbound-mms.spec.ts`, the other worker's intentional uncommitted file. `git show --name-only HEAD` contains only the two provider paths above.
