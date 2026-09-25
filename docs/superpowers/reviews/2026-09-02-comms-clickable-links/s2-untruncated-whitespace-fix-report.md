# S2 untruncated email whitespace fix report

Date: 2026-09-02

## Scope

Corrected `EmailCard` so its collapsed snippet retains source trailing whitespace
when the email body is at most 140 characters. Truncated snippets continue to trim
trailing whitespace before adding the ellipsis.

## TDD proof

1. Added `preserves trailing source whitespace in an untruncated collapsed email
   snippet` to `Timeline.linkified.test.tsx` with a 39-character body ending in
   two spaces, a tab, and a space.
2. RED: focused test failed before the production change: expected the full source
   body; received the same body with its trailing whitespace removed.
3. GREEN: `snippetEnd` now selects the trimmed 140-character boundary only when
   `truncated`; otherwise it uses `bodyText.length`.

## Verification

- `npx vitest run src/routes/contact/Timeline.linkified.test.tsx` - exit 0,
  1 file / 9 tests passed.
- `npx vitest run src/ui/LinkifiedText.test.tsx` - exit 0, 1 file / 20 tests
  passed.
- `npm run typecheck` (dashboard) - exit 0.
- `npm run build` (dashboard) - exit 0. Vite emitted its existing large-chunk
  advisory only.

## Guarded behavior

The existing 141-space body assertion still passes and renders `...`; the full
source URL/href clipping assertions and both `LinkifiedText` calls are unchanged.
