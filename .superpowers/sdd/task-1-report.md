# Task 1 Report — Shared dashboard phone lib + formatter consolidation + pinned tests

**Date:** 2026-07-02  **Branch:** feat/flexible-phone-entry  **Status:** DONE

## What was built

### `dashboard/src/lib/phone.ts` (new)
- `normalizeToE164` — verbatim line-for-line port from `app/src/lib/phone.ts`; all code comments preserved.
- `isE164` — verbatim port.
- `formatPhoneDisplay` — mirrors `formatPhoneForDisplay` semantics (`+1XXXXXXXXXX` → `(AAA) BBB-CCCC`; non-NANP returned unchanged); returns `string` (not `string | undefined`) for undefined/empty input so it's safe in JSX without null-coalesce. Contract difference documented in the JSDoc.
- Header cross-link: "keep in sync with app/src/lib/phone.ts (+ its test)".

### `app/src/lib/phone.ts` (comment-only edit)
- Added mirror cross-link at top: "keep in sync with dashboard/src/lib/phone.ts (+ its test)".
- Zero behavior change.

### `dashboard/src/lib/phone.test.ts` (new)
- Pins the SAME input→expected table as `app/test/phone.test.ts` — every case mirrored exactly (9 `it` blocks covering all paths: E.164 passthrough, 10-digit NANP stripping, 11-digit leading-1, explicit-`+` international, 9-case reject table, `isE164` accepts/rejects, `formatPhoneDisplay` NANP/non-NANP/falsy).
- One documented contract difference in `formatPhoneDisplay`: returns `''` (not `undefined`) for falsy input, matching the dashboard's JSX-safe contract.

### `dashboard/src/routes/contact/format.ts` (consolidation)
- Added import `formatPhoneDisplay` from `../../lib/phone.js`.
- Replaced `formatPhone`'s inline regex body with a one-line delegation: `return formatPhoneDisplay(e164)`.
- All 12+ import sites unchanged — the function signature and return type are identical.
- ONE formatter implementation now; the old duplicated regex is gone.

## Verification results

| Check | Result |
|---|---|
| `npm run typecheck` | EXIT:0 |
| `npm test -w @housingchoice/dashboard` | EXIT:0 — 96 files / 730 tests passed (includes `src/lib/phone.test.ts` 9 tests + `src/routes/contact/format.test.ts` 11 tests) |
| `npm test -w @housingchoice/app -- test/phone.test.ts` | EXIT:0 — 1 file / 9 tests passed |

## Self-review notes

- **Verbatim fidelity:** `normalizeToE164` and `isE164` are byte-for-byte identical to the app originals; the only diff is the file-level cross-link header comment.
- **`formatPhoneDisplay` vs `formatPhoneForDisplay`:** The dashboard function uses `!e164` (falsy guard) and returns `''` instead of `undefined` for the missing-input case — this matches `formatPhone`'s existing contract and avoids a breaking change for all 12+ importers. The JSDoc documents this deliberately.
- **Consolidation:** `formatPhone` is now a pure wrapper — ONE regex definition lives in `dashboard/src/lib/phone.ts`. The `format.test.ts` `formatPhone` cases still pass, confirming the wrapper is transparent.
- **No YAGNI creep:** `usePhoneField` was not built (deferred to Task 3 per brief).
- **No app behavior change:** the only app file touched got a one-line comment prepended; tests still pass unchanged.
- **Drift alarm:** any divergence in either `normalizeToE164` implementation without a matching test update will fail `phone.test.ts` on one or both sides.
