# S3 unmatched-email implementer report

## Scope

- Changed `dashboard/src/routes/email/UnmatchedRow.tsx` and added
  `dashboard/src/routes/email/UnmatchedRow.test.tsx` only.
- The opened, loaded `detail.text` now uses the shared `LinkifiedText` UI-barrel
  import. The list preview remains the existing raw `{row.snippet}` child inside
  the header button; no link can be nested there.

## TDD evidence

- RED: `npm run test -w @housingchoice/dashboard -- src/routes/email/UnmatchedRow.test.tsx`
  failed as intended: it could not find the accessible `example.com/full/path`
  link while the loaded detail still rendered raw text.
- GREEN: the same focused test passed after the minimal integration.

## Verification

- Focused dashboard tests: 4 files, 38 tests passed:
  `UnmatchedRow.test.tsx`, `useUnmatchedEmail.test.tsx`, `EmailHtmlFrame.test.tsx`,
  and `LinkifiedText.test.tsx`.
- Dashboard typecheck: exit 0.
- Dashboard build: exit 0. Vite reported the pre-existing chunk-size advisory.

## E1 boundary

- E1 is outside S3 ownership. This slice makes no production-seam, API, seed, or
  Playwright change, so it did not run E1. The focused component test covers the
  unmatched-email reader boundary: raw collapsed preview, safe opened-detail
  anchor with trailing punctuation outside, one mark-read callback, original HTML
  disclosure, and attachments.
