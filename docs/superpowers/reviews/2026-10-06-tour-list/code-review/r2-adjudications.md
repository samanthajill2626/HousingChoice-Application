# Code review r2 - orchestrator adjudications (feat/tour-list @ b459de9f)

Report: `r2-re-review.md` (fresh reviewer on the fix-wave-1 diff: 0 HIGH, 0
MEDIUM, 4 LOW; 8 of 9 round-1 fixes confirmed real by the reviewer's own
mutants; gap 4 judged not a real guard; 3 adjudications contested, the AD-3
REJECT and the AD-2 / AD-5 FILEs upheld). Gates after fix wave 1: typecheck 0
(fix-wave child), npm test exit 0 (app 8370 passed / 1 skipped, dashboard
3896, e2e 503, fake-twilio 275, fake-twilio-web 111; 0 `[dynamoAdmin]`).

## New findings

- R2-1 [LOW] the SC-2 bound regex rejects legal fractions longer than three
  digits and still admits impossible calendar dates (`2026-02-30` rolls into
  March) - FIX: the shape regex accepts any fraction length; the components
  are then checked (month 1-12, the day within that month, hour 0-23, minute
  and second 0-59, offset hours 0-23 and minutes 0-59) and the instant is
  built from them, so nothing rolls over; parse cases for `.123456Z`,
  `.123456+00:00`, `2026-02-30T00:00:00Z` and `2026-04-31T00:00:00-04:00`.
- R2-2 [LOW] the From-after-To message is not announced and not tied to the
  inputs - FIX: `aria-invalid="true"` on the From and To inputs while the
  range is invalid, `aria-describedby` pointing at the under-inputs copy,
  and `role="alert"` on the list-area copy only (it is inserted with its
  text; the count region stays an empty status region). One view test.
- R2-3 [LOW] gap 4's `toBeInViewport()` cannot fail in its fixture - FIX
  (tests only): test 3 sets a short viewport (1280 x 360) before the back
  arrow so the list starts below the fold, and the fix-wave proves it with
  the mutant the reviewer names (drop `scrollIntoView` -> red, restore ->
  green) on a lane run; if the mutant cannot be made red, keep the plain
  assertion and say so.
- R2-4 [LOW] spec 5.5 and the section-9 bullet still state the per-request
  400 rule - FIX (orchestrator, in this commit): both amended in place to
  the AD-1 rule.

## Fix-diff notes taken

- The WARN on the cursor-refusal path logs `{ err: <the refusal>, phase }`
  (the house `err` idiom; the serializer allowlists `instanceof Error`, and
  DynamoDB's refusal text names no key value) - FIX, one line.
- The `/// <reference lib="es2024.string" />` directive is sound but is the
  repo's first and widens every app program's lib; the reviewer offers
  `!/\p{Surrogate}/u.test(value)` (ES2018, lib-free) as equivalent - FIX:
  take it and drop the directive; the AD-4 tests cover both halves.

## Adjudication challenges

- SC-1's severity was MEDIUM; the reviewer shows gate 1 already catches a
  dropped stamp on the performance world (`buildTour` is `satisfies TourItem`
  and `_schedPartition` is required). ACCEPTED: LOW in the handback; the
  runtime pin stays (the cast, matrix and lean rows are untyped puts).
- Gap 4's scope was too narrow - ACCEPTED (R2-3 above).
- AD-1's scope missed the spec amendment - ACCEPTED (R2-4 above).
- The AD-2 issue says the unbounded walk is pre-existing; only the from > to
  500 is - ACCEPTED: the issue text is corrected in fix wave 2.
- AD-3 REJECT, AD-2 and AD-5 FILE - upheld by the reviewer; stand.

## Fix wave 2 scope (one fresh implementer, small)

Code: R2-1, R2-2, the WARN idiom, the surrogate regex. Tests: R2-3. Docs: the
AD-2 issue correction. Then a short fresh review (r3) of that diff, the main
sync and the full battery.
