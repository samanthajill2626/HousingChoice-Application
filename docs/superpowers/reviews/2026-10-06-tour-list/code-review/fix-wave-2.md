# Fix wave 2 - feat/tour-list (code review r2)

Implementer: Claude Opus 5.5, 2026-10-06. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD 55a754aa, ended at fb81a7a7 (plus this
report's commit). Scope: `r2-adjudications.md` - R2-1, R2-2, the WARN idiom
note, the surrogate-regex note (code); R2-3 (tests only); the AD-2 issue
correction (docs). R2-4 was the orchestrator's (already in 55a754aa).

Every code item ran TDD: the test first, RED for the finding's reason, then
the fix, GREEN, one commit. Mutants were applied and restored with the Edit
tool. DynamoDB Local (shared container) was up throughout and never
restarted; every captured run was swept for `[dynamoAdmin]`: 0 hits. Run logs
are under the worktree's gitignored `.superpowers/sdd/fixwave2-*.log`.

## Commits

| item | commit | message |
|---|---|---|
| R2-1 | 721d7d49 | fix(app): tour list bounds - any fraction length, no calendar rollover |
| notes | 771a7fb0 | fix(app): cursor keys well-formed without a lib reference; the refusal WARN carries err |
| R2-2 | 0da4d704 | fix(dashboard): the invalid date range is announced |
| R2-3 | 7c1f15b0 | test(e2e): the restored row is in view from below the fold |
| AD-2 fix | fb81a7a7 | docs(issues): the unbounded range walk is new on this branch |

## Per item

### R2-1 - any fraction length, no calendar rollover (721d7d49)

- Code: `app/src/lib/tourListQuery.ts` - the shape regex captures its fields
  and takes `(?:\.(\d+))?`; `boundInstant` checks month 1-12, day 1..days in
  that month of that year (`daysInMonth`, proleptic Gregorian), hour 0-23,
  minute and second 0-59, offset hours 0-23 and minutes 0-59, and BUILDS the
  instant from them (fraction truncated to ms, minus the offset). Error text
  unchanged. `canonicalInstant` stays for the cursor's `n`.
- RED: parse case 9 `expected ok, got error: from and to must be valid ISO
  8601 datetimes` (the `.123456Z` row); route case 1
  `when=range&from=2026-02-30T00:00:00Z: expected 200 to be 400`.
- GREEN: tourListQuery.test.ts + toursApi.test.ts 255/255; tourListPage,
  tourListIndexFakeMirror (DynamoDB Local) and toursRepo integration 101/101.
- Tests: case 9 adds `.123456Z` and `.123456+00:00` (both
  `2026-10-06T00:00:00.123Z`), `2026-02-30T00:00:00Z`,
  `2026-04-31T00:00:00-04:00`, `2026-10-06T24:00:00Z` (each a 400 as from and
  as to), plus `2028-02-29` (ok) and `0050-06-15` (stays year 0050) - see
  divergence 2. Route case 1 adds the Feb 30 row.

### Notes - surrogate regex and the refusal WARN (771a7fb0)

- Code: `isKeyValue` uses `!LONE_SURROGATE.test(value)` with
  `LONE_SURROGATE = /\p{Surrogate}/u`; the `/// <reference lib="es2024.string" />`
  directive and its comment are deleted. `tours.ts` logs
  `log.warn({ err: err.refusal, phase: err.phaseKind }, ...)`.
- RED (route case 9, the assertion that changed): `expected { Object (level,
  time, ...) } to match object { err: { ...(2) }, phase: 'd' }` - the old line
  had no `err`.
- GREEN: tourListQuery.test.ts + toursApi.test.ts 255/255; app typecheck
  (all three tsconfigs) exit 0 with the directive gone.
- Mutants on the regex (each restored with Edit before the commit, the diff
  re-read): `u` flag dropped -> 3b red `a lone surrogate in a d
  tourId: expected { ... } to be undefined` and route 13 red `tourId of length
  6: expected 200 to be 400`; a per-UTF-16-unit surrogate check -> 3b red on
  the new surrogate-pair row (`expected undefined to strictly equal`).
- Tests: 3b keeps its rows and adds a surrogate PAIR (astral, built with
  `String.fromCharCode(0xd83d, 0xde00)`) that must still decode. Route case 9
  asserts `err: { type: 'ValidationException', message }` on both refusal
  lines, no top-level `name`, and no fixture id on either line (divergence 1).

### R2-2 - the invalid range is announced (0da4d704)

- Code: `AllToursView.tsx` - `RANGE_ERROR_ID = 'tours-all-range-error'` on the
  under-inputs copy; From and To carry `aria-invalid={rangeError !== null}`
  and `aria-describedby` = that id only while the error shows; the list-area
  box is `role="alert"`; the under-inputs copy has no role.
- RED: `Unable to find an accessible element with the role "alert"`.
- GREEN: AllToursView.test.tsx 66/66 (65 + the new case); the tours directory
  19 files, 540/540; eslint on both files exit 0.
- Test: valid range -> neither input invalid nor described, no alert; From
  after To -> exactly one alert holding the sentence once, both inputs
  `aria-invalid="true"` with the accessible description = the sentence, the
  described element outside the alert; fixed -> both clear, no alert.

### R2-3 - the restored row in view from below the fold (7c1f15b0)

- Test 3 calls `page.setViewportSize({ width: 1280, height: 240 })` after the
  tour page's back link is visible and before its click; `toBeInViewport()`
  stays after `toBeFocused()`. No restore: the page fixture is per test.
- Lane 7 (ports 9701/9711/9721/9731), session started after 0da4d704 with
  only the spec and the mutant uncommitted; Vite served the mutant (the served
  module had no `scrollIntoView`).
  - Mutant (`link?.scrollIntoView(...)` commented out), height 360:
    `5 passed (6.6s)` - NOT red (`fixwave2-tours-all-mutant.log`).
  - Mutant, height 240: test 3 RED, `Error: expect(locator).toBeInViewport()
    failed` / `Received: viewport ratio 0` at
    `> 318 |     await expect(all.link(noShowId)).toBeInViewport();`, after
    `toBeFocused()` passed (`fixwave2-tours-all-mutant-240.log`).
  - Restored with Edit; `git diff -- dashboard/src/routes/tours/AllToursView.tsx`
    empty (0 bytes); Vite served `scrollIntoView` again.
  - Green, height 240: `5 passed (5.6s)` (`fixwave2-tours-all-green.log`), and
    again `5 passed (5.6s)` (`fixwave2-tours-all-green2.log`).
- Lane stopped: `npm run e2e:stop` -> `stopped session launcher 51228 (+
  children)`, `dropped lane 7 tables (hc-local-7-*)`, `released lane 7 lease`;
  `e2e/.artifacts/session.pid` and `lane.json` absent; no listener on
  9701/9711/9721/9731; PIDs 51228, 22488, 48680 gone. No full suite run.

### AD-2 correction (fb81a7a7)

`docs/issues/tours-date-range-reads-unbounded-span.md` now says the unbounded
walk is NEW on feat/tour-list (spec section 7 turned the one-page read into
`queryAll`, commit 17f07803; the old single page capped a request at about
1 MB by accident) and that ONLY the from > to 500 on `GET /api/tours`
predates the branch; `r2-re-review.md` joins `refs`. `npm run issues`: 372
open, 196 closed, 568 total, no warnings; INDEX.md stays gitignored.

## Gates (after the last code commit)

- `npm run typecheck` (root): exit 0 - app, dashboard, e2e, fake-twilio,
  fake-twilio-web. This is the proof the dropped lib directive is safe.
- `npx eslint` on the 7 touched code files (tourListQuery.ts, tours.ts, the
  two app tests, AllToursView.tsx and its test, tours-all.spec.ts): exit 0, no
  output - nothing to attribute.
- Final reruns at fb81a7a7: app 255/255, AllToursView.test.tsx 66/66.
- Not run (out of scope): full `npm test`, full `npm run e2e`, `npm run smoke`.

## Divergences from the adjudication / dispatch

1. Route case 9 asserts `err.type`, not `err.name`. The adjudicated code
   (`{ err: <the refusal>, phase }`) was taken as written, but the house
   serializer (`app/src/lib/logSerializers.ts`) emits an `instanceof Error`
   as `{ type, message, stack, ... }` and never `name`, and the harness logger
   runs it - so `err.name` cannot appear on the line. `err.type` is also the
   CloudWatch field the house queries. The `{ err: { name } }` summary shape
   would match the literal assertion but drop the message the adjudication
   chose to keep. Added: the "never an id" check on the second (model)
   refusal line, since the message is now logged.
2. R2-1 builds the instant with `setUTCFullYear` + `setUTCHours`, not
   `Date.UTC(...)`: Date.UTC reads a year 0-99 as 1900-1999
   (`Date.UTC(50, 5, 15)` is 1950), which would have been a NEW silent
   shift. Two extra parse rows pin it (`0050-06-15`) and the per-year day
   check (`2028-02-29`).
3. 3b gained one surrogate-pair row (the regex must not over-match pairs);
   both halves of the new check were mutant-proven.
4. R2-3 uses height 240, not 360: at 360 the mutant stayed green, so 360 did
   not discriminate (the dispatch's fallback).
5. R2-2: `aria-describedby` is present only while the error shows (the
   IntakeForm.tsx idiom) and `aria-invalid` renders `false` otherwise - the
   dispatch allowed false or absent.
