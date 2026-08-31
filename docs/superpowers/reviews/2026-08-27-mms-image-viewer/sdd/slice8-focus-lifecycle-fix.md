# Slice 8 focus lifecycle correction

## Scope

- Owned production/test files: `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx` and `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`.
- Preserved the other worker's uncommitted `e2e/tests/dashboard-next/outbound-mms.spec.ts` change byte-for-byte and did not stage it.

## Root cause and correction

The verified dismissal effect restored scroll and called `trigger.focus({ preventScroll: true })` independently from the later portal/inert layout-effect cleanup. The real Chromium run observed the restoration effect while `#root` was still inert, so Chromium rejected the focus request. Test cleanup ordering in jsdom does not reproduce that ordering, and jsdom does not natively enforce inert focus exclusion.

The provider now keeps the active portal cleanup as an idempotent release function. A verified return to `returnLocationKey` invokes that release before restoring scroll and focus. The ordinary layout-effect cleanup invokes the same function for Back, independent navigation, token changes, StrictMode replay, and provider unmount. Whichever React lifecycle path reaches it first restores every exact inert snapshot and removes the portal; the second call is a no-op. Unknown markers, disconnected triggers, non-return navigation, retained Forward descriptors, and the single-dismiss guard are unchanged.

The added regression installs inert-aware focus behavior in jsdom: a focus request is rejected when the target is under an inert ancestor or while the active viewer portal still covers the background. It asserts the root is released and the exact trigger owns focus after Close. This is the strongest unit-level model of the Chromium boundary; the already-recorded focused Playwright run is the failing pre-fix browser proof.

## Red / green evidence

- Browser RED supplied by the Slice 8 owner before this correction: focused Outbound MMS Playwright reached zoom, geometry, and history assertions but failed desktop Escape and mobile `page.goBack()` focus restoration after 15 seconds; the viewer closed and the original connected trigger remained unfocused.
- Unit regression probe against the pre-fix provider: jsdom passed because its layout-effect cleanup order released the portal before the restoration effect and it has no native inert focus enforcement. No false claim is made that jsdom reproduced Chromium's scheduler ordering.
- GREEN: `npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts src/routes/contact/Modal.test.tsx` -> exit 0; 4 files passed, 49 tests passed.
- GREEN: `npm run typecheck -w @housingchoice/dashboard` -> exit 0.
- GREEN: `npx eslint dashboard/src/ui/imageViewer/ImageViewerProvider.tsx dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx` -> exit 0.

## Residual risk

The narrow unit test models inert focus rejection but cannot reproduce the real browser's React/inert timing. Per slice ownership, this worker did not start or compete with the active Playwright lane; the Slice 8 owner must rerun its focused Outbound MMS spec to provide the decisive browser green.
