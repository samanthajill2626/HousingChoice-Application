# Code review r3 - fresh review of fix wave 2 (feat/tour-list @ 567d2c30)

Reviewer: fresh round-3 reviewer (Claude Opus 5.5), 2026-10-06. Worktree
`W:\tmp\tour-list`, merge base main @d839494a. Subject: fix wave 2
(721d7d49, 771a7fb0, 0da4d704, 7c1f15b0, fb81a7a7). Inputs read in order: the
fix-wave-2 diff, `r2-adjudications.md`, `r2-re-review.md` (R2-1..R2-3 and
section 2), `fix-wave-2.md` (its five divergences), the live files, spec 4.3 /
5.1 / 5.5 where a rule was in question. No round-1 or round-2 participation.

**Summary: new findings 0 HIGH, 0 MEDIUM, 3 LOW (R3-1..R3-3). Fix wave 2: 5
commits (6 items) reviewed, all 6 REAL; the five implementer divergences all
verified correct. R3-1 is pre-existing (wave 1's SC-2 canonical form, emitted
unchanged by the wave-2 builder); R3-2 and R3-3 are regression-guard gaps in
the wave-2 tests (the code is right).**

Paths: `tLQ` = `app/src/lib/tourListQuery.ts`, `ATV` =
`dashboard/src/routes/tours/AllToursView.tsx`, `ATT` = its `.test.tsx`, `tLS`
= `dashboard/src/routes/tours/tourListSelection.ts`, `spec` =
`docs/superpowers/specs/2026-10-06-tour-list-design.md`.

## 1. New findings

### R3-1 [LOW] A year-9999 bound with a negative offset canonicalizes to `+010000-...`, which inverts the range under string comparison; the dashboard's own To = 9999-12-31 is a 400

- Claim: `boundInstant` (`tLQ:105-109`) returns `toISOString()` of the built
  instant, and spec 5.1 (`spec:507-511`) uses that canonical string for the
  key condition and the `from <= to` comparison. For an instant past
  9999-12-31T23:59:59.999Z, `toISOString()` emits the expanded form
  `+010000-...`; `+` (0x2B) sorts BEFORE every digit, so the bound compares
  below every real `scheduledAt`. `to=9999-12-31T23:59:59-04:00` (a legal
  instant before year 10000 local) therefore reads as NOTHING, the same value
  as `from` reads as EVERYTHING, and a valid from-before-to pair is refused
  with the wrong reason (`tLQ:158`). Separately, spec 4.3 sends the To bound
  as `toISOString()` of the end of the local day (`tLS:95-100`); `ymdParts`
  accepts year 9999 (`tLS:74-83`, its only floor is year 100), so To =
  9999-12-31 in any UTC-minus zone (Atlanta) builds `+010000-01-01T04:59:59.999Z`,
  which the SC-2 regex (`tLQ:74`, `^(\d{4})-`) refuses: a first-page 400.
- Evidence: throwaway `app/test/zz-review-r3-bounds.test.ts` (case A, run
  green on the real code, deleted), through the route on the in-memory
  harness with two tours near NOW: `when=range&to=9999-12-31T23:59:59Z` ->
  both tours (control); `to=9999-12-31T23:59:59-04:00` -> `filters.to`
  `+010000-01-01T03:59:59.000Z`, plan `{ op: 'lte' }` on it, 200 with `[]`;
  `from=9999-12-31T23:59:59-04:00` -> 200 with both tours;
  `from=2026-10-01T00:00:00Z&to=9999-12-31T23:59:59-04:00` -> 400 "from must
  be on or before to"; `to=+010000-01-01T04:59:59.999Z` -> 400 "from and to
  must be valid ISO 8601 datetimes". `TZ=America/New_York node`: the
  `localDayEndIso('9999-12-31')` arithmetic -> `+010000-01-01T04:59:59.999Z`.
  The `-000001-...` forms (year 0000 with a positive offset) stay consistent
  (`-` sorts below digits and only one negative year is reachable), so only
  the `+` side inverts.
- Not a wave-2 regression: my 234,080-input corpus shows the builder's output
  identical to the wave-1 Date.parse path on every input both accept. It does
  contradict r2-re-review.md section 5 ("Dashboard range bounds always pass
  the new regex"), which is true only for local dates up to 9999-12-30.
- Blast radius: a hand-made API request gets an inverted window (staff-only
  read, no write, no exposure); in the dashboard, an absurd To date shows
  "We couldn't load tours. Please try again." and Retry repeats the 400.
- Smallest fix: in `boundInstant`, refuse a built instant whose canonical
  string is not a 4-digit year (one line, e.g. `/^\d{4}-/` on the result),
  plus one parse row; the dashboard side may stay a 400 or `ymdParts` may cap
  the year at 9998 beside its existing floor. Filing it is also defensible.

### R3-2 [LOW] The R2-1 rewrite made seven field checks load-bearing, and no test pins them

- Claim: before wave 2, Date.parse refused month 00/13, day 00, minute 60,
  second 60, an offset hour over 23 and an offset minute over 59 (the corpus
  shows NO input of those kinds newly refused); the builder no longer calls
  Date.parse, so those rejections now live only in `tLQ:100-101`, and the
  leap rule (`tLQ:79`) is new protection Date.parse never gave (it rolled
  2026-02-29 into March 1). Parse case 9 pins only Feb 30, Apr 31, T24:00, the
  fraction length, a positive leap day and year 0050.
- Evidence: mutant M3 - `daysInMonth` returns 29 for every February and
  `month < 1`, `day < 1`, `minute > 59`, `second > 59`, `offsetHours > 23`,
  `offsetMinutes > 59` deleted - leaves `tourListQuery.test.ts` and the
  `GET /api/tours/list` route cases all green (26 passed, filtered run), while
  my throwaway case B goes red on its first row: `2026-02-29T00:00:00Z:
  expected { ok: true ... } to deeply equal { ok: false ... }` (the mutant
  rolls it to 2026-03-01 - exactly R2-1's class). Restored; `git diff` empty.
- Blast radius: none today (every check is correct by reading and by my
  throwaway rows); a later edit to those two lines would silently bring back
  the rollover R2-1 removed.
- Smallest fix: parse case 9's bad list gains `2026-02-29T00:00:00Z`,
  `2100-02-29T00:00:00Z`, `2026-00-10T00:00:00Z`, `2026-10-00T00:00:00Z`,
  `2026-10-06T12:60:00Z`, `2026-10-06T12:00:60Z`, `...T00:00:00+24:00` and
  `...T00:00:00+00:60`; the ok rows gain `2000-02-29T00:00:00Z`.

### R3-3 [LOW] Cursor case 3b pins a lone HIGH surrogate and a valid pair, never a lone LOW surrogate

- Claim: the surrogate check (`tLQ:285`, `tLQ:291`) is correct, but its tests
  (`app/test/tourListQuery.test.ts:377,383-384` lone high; `:391-394` the new
  pair row) do not distinguish it from a high-only class.
- Evidence: mutant M4 `LONE_SURROGATE = /[\uD800-\uDBFF]/u` keeps 3b and route
  case 13 green; my throwaway case C goes red on `"a\udc00b": expected { v: 1,
  ... } to be undefined`. A lone low surrogate survives the cursor wire form
  (JSON.stringify escapes it, JSON.parse restores it) and is as ill-formed for
  AWS as a lone high one. Restored; `git diff` empty.
- Blast radius: none today; a future "simplification" of the regex could drop
  half of AD-4's well-formedness guard with every test green.
- Smallest fix: one 3b row, a lone low surrogate (`0xdc00`) in a d tourId.

## 2. Per-fix verdicts

| item | verdict | evidence |
|---|---|---|
| R2-1 bounds, 721d7d49 | REAL | my M1 (bound back to Date.parse behind the new regex): parse 9 red "from 2026-02-30T00:00:00Z", route 1 red "expected 200 to be 400"; my M2 (`Date.UTC` instead of `setUTCFullYear`, divergence 2): parse 9 red "expected '1950-06-15T00:00:00.000Z' to be '0050-06-15T00:00:00.000Z'". Corpus: newly refused = only T24:00 forms (8,358) and impossible days (6,440); newly accepted = only 4+ digit fractions (11,144); 0 output differences where both accept; every accepted output equals Date.parse of the ms-truncated input. Gaps: R3-1 (pre-existing), R3-2 |
| surrogate regex + lib directive removed, 771a7fb0 | REAL | exhaustive: 22,620 strings of 1-4 code units (lone high, lone low, pairs, reversed pairs, BMP edges) - `/\p{Surrogate}/u` agrees with `!isWellFormed()` on every one (Node 24.21); my M5 (check removed): 3b red "a lone surrogate in a d tourId"; no `isWellFormed` / lib reference left in app code; the fix wave's root typecheck log has no error. Gap: R3-3 |
| refusal WARN `{ err, phase }`, 771a7fb0 | REAL | my M6 (back to `{ name }`): route 9 red. Divergence 1 is right: `logSerializers.ts:43-57` emits `type` (the declared name), `message`, `stack`, never `name`; `type: 'ValidationException'` on the plain test Error proves the house serializer ran (pino's default would say `Error`). No id: both refusal lines are checked for `tl9-`; DynamoDB's starting-key messages carry no key value |
| R2-2 aria, 0da4d704 | REAL | my D1 (`role="alert"` removed): the new case red "Unable to find an accessible element with the role "alert""; my D2 (`role="status"` on the under-inputs copy): the Date range and SC-4 cases red "expected one count line, found 2" - so "never a second status region" is pinned by those neighbors (via `countLine()`, `ATT:258-262`), not by the new case; exactly one alert is pinned by `getByRole('alert')` (throws on two); both `aria-invalid` / `aria-describedby` halves by the new case's valid and fixed states (by reading). Divergence 5 matches the house idiom (`dashboard/src/routes/public/IntakeForm.tsx:156-157`) |
| R2-3 viewport, 7c1f15b0 | REAL (lane logs; Playwright out of my scope) | `.superpowers/sdd/fixwave2-tours-all-mutant-240.log:18,22` "toBeInViewport() failed" / "viewport ratio 0"; the 360 mutant log "5 passed"; green "5 passed" twice. Not flaky by reading: after the resize test 3 performs no action - URL, param, focus, attribute, value assertions and `toBeInViewport` only (`e2e/tests/dashboard-next/tours-all.spec.ts:307-323`); the afterEach `closeOut` is `page.request` only (`:86-102`); the `page` fixture is per test and the project default is Desktop Chrome 1280x720 (`e2e/playwright.config.ts:180`), so nothing later inherits 240 |
| AD-2 issue text, fb81a7a7 | ACCURATE | `git log d839494a..HEAD -- app/src/repos/toursRepo.ts` lists 17f07803, whose diff turns the one-Query `listByScheduledRange` into `queryAll`; main's `listByStatus` is an uncapped do-while (main `toursRepo.ts:418-430`); `today.ts:300-301` refuses from >= to; every `refs` line (`toursRepo.ts:417`, `dynamoPaging.ts:20`, `tours.ts:428`, `today.ts:287`, `today.ts:550`) resolves at HEAD |

## 3. Checked and found sound

- `boundInstant` by reading and corpus: the leap rule is proleptic Gregorian
  (year 0 leap, 1900 / 2100 not, 2000 / 2400 yes); `daysInMonth` runs only
  after the month range check (short-circuit, `tLQ:100`); second 60 and
  offsets past 23:59 are refused, as Date.parse already refused them; the
  fraction truncates (`.5` -> 500 ms, `.05` -> 50 ms, `.9999999` -> 999); the
  regex is linear (no nested quantifier) with ASCII `\d`.
- The canonical form is unchanged for every previously accepted request, so
  fingerprints and key conditions are too; equivalent spellings
  (`.123456Z`, `.123Z`, `+00:00`) share one fingerprint, so a cursor carries
  across them. Every `toISOString()` the dashboard builds for local years
  0100-9999 is accepted except the R3-1 edge.
- T24:00 is the one input legal under some standard that is newly refused
  (ISO 8601:2004 and the ECMAScript date-time format allow it, RFC 3339 does
  not); deliberate per the adjudication's "hour 0-23", and no client emits
  it. The comment at `tLQ:86-87` calls it a rollover, though Date.parse's
  reading (the next midnight) was its defined meaning - wording only.
- Callers: `parseTourListQuery` and `decodeTourListCursor` are called only at
  `app/src/routes/tours.ts:455,468`; `canonicalInstant` still guards the
  cursor's `n` (`tLQ:319`). `LONE_SURROGATE` has no `g` / `y` flag, so
  `.test()` keeps no `lastIndex` state across calls.
- The view: the four alerts are mutually exclusive by hook status - the range
  copy needs `idle` (`ATV:593-596`), the first-page failure `error`
  (`ATV:601-608`), Start over / Retry `ready` (`ATV:656-670`); the count
  region stays mounted and empty while idle (`ATV:579-587`) and announces the
  count once the fixed range loads. `tours-all-range-error` occurs nowhere
  else in `dashboard/src`. A describedby present only while its target
  renders is the house pattern and never dangles (both render on the same
  `rangeError !== null`, and the inputs exist only for `when=range`, which
  `tourListRangeError` requires, `tLS:159-162`).
- Viewport: nothing in the tours view depends on viewport height (no
  IntersectionObserver / innerHeight / matchMedia in the view or hook); the
  anchor's `scrollIntoView({ block: 'nearest' })` (`ATV:433`) is what the
  240px run exercises.
- Housekeeping: throwaway `app/test/zz-review-r3-bounds.test.ts` created, run
  (green on the real code), deleted by exact name. Mutants M1-M5 in
  `tourListQuery.ts`, M6 in `tours.ts`, D1-D2 in `AllToursView.tsx`, each
  restored with Edit and `git diff` re-checked (0 bytes); final `git status`
  clean at 567d2c30. Corpus and surrogate scripts ran from the session
  scratchpad, outside the repo. No npm test, e2e, Playwright or commit.
