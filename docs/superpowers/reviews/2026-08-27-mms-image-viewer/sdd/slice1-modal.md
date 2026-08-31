# Slice 1 - shared Modal media lifecycle

## Result

- Shipped commit `94cd86d3a4fda68d9da9e644e2f72f419187700a` (`feat: extend modal lifecycle for media viewer`).
- Changed only:
  - `dashboard/src/routes/contact/Modal.tsx`
  - `dashboard/src/routes/contact/Modal.module.css`
  - `dashboard/src/routes/contact/Modal.test.tsx`
- No contract deviation and no unexpected importer, cycle, or ownership mismatch.

## TDD evidence

- RED: `npm test -w @housingchoice/dashboard -- src/routes/contact/Modal.test.tsx`
  - Exit 1.
  - 1 file failed; 6 tests failed and 10 passed.
  - Failures were the expected missing media marker/actions/focus trap/key forwarding/focus-restoration option and document-Escape containment behaviors.
- GREEN before commit: same focused command exited 0 with 1 file and 16 tests passed.
- GREEN after commit: same focused command exited 0 with 1 file and 16 tests passed.
- `npm run typecheck -w @housingchoice/dashboard` exited 0 before and after commit.
- `npx eslint W:\tmp\mms-image-viewer\dashboard\src\routes\contact\Modal.tsx W:\tmp\mms-image-viewer\dashboard\src\routes\contact\Modal.test.tsx` exited 0 with no output.
- `git diff --check` exited 0 before commit.
- Full `npm test` and `npm run e2e` were intentionally not run for this slice.

## Shipped contract for downstream slices

- `ModalProps` now accepts optional `variant`, `headerActions`, `trapFocus`, `initialFocus`, `restoreFocus`, and `onDialogKeyDown` with defaults that retain existing Modal behavior.
- Media dialogs expose `data-modal-variant="media"`, render header actions before visible-text `Close`, can focus Close initially, trap Tab only while topmost, and can delegate exact trigger restoration by setting `restoreFocus={false}`.
- A topmost media Escape is contained before background document listeners. Descendant `preventDefault()` still suppresses closing, while the Escape remains contained. Default Modal Escape and stack behavior remain unchanged.
- The media CSS chain is `mediaDialog -> mediaBody -> mediaBodyInner`, with layer 200, bounded desktop geometry, long-title ellipsis, and full `100vw` by `100dvh` mobile geometry below 600px.
- Downstream viewer code should use `variant="media"`, `trapFocus`, `initialFocus="close"`, `restoreFocus={false}`, pass Download through `headerActions`, and send keyboard zoom handling through `onDialogKeyDown`.
