# Fix wave 3 - feat/tour-list (code review r3, micro)

Implementer: Claude Opus 5.5, 2026-10-06. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD e456585f (the r3 records), ended at
a760b678 (plus this report's commit). Scope: `r3-adjudications.md` - R3-1
(code, both halves), R3-2 and R3-3 (tests only).

Each item ran TDD: R3-1 RED for the finding's reason, then the fix, GREEN;
R3-2 and R3-3 (the code was already right) GREEN on the real code, then RED
under one hand mutant, restored with the Edit tool. DynamoDB Local (shared
container) was up throughout and never restarted; the 11 captured run logs
(`.superpowers/sdd/fixwave3-*.log`, gitignored) hold 0 `[dynamoAdmin]` lines.

## Commits

| item | commit | message |
|---|---|---|
| R3-1 | c1b925dd | fix(app,dashboard): a date bound beyond year 9999 is refused, and the dashboard never sends one |
| R3-2 | 488a3d7c | test(app): pin the seven bound field checks |
| R3-3 | a760b678 | test(app): a lone low surrogate in a cursor key is refused |

## Per item

### R3-1 - no extended-year bound (c1b925dd)

- Before the fix (the real module, via tsx): `to=9999-12-31T23:59:59-04:00`
  -> ok, `+010000-01-01T03:59:59.000Z`; `to=0000-01-01T00:00:00+01:00` -> ok,
  `-000001-12-31T23:00:00.000Z`; `to=9999-12-31T23:59:59.999Z` -> itself.
- Server (`app/src/lib/tourListQuery.ts`, `boundInstant`): the built
  instant's `toISOString()` must match `^\d{4}-`, else undefined, so the
  route answers the existing "from and to must be valid ISO 8601 datetimes".
  The doc comment says why ('+' sorts below every digit, so the range would
  invert).
- Dashboard (`dashboard/src/routes/tours/tourListSelection.ts`,
  `localDayEndIso`): an end whose ISO starts with `+` is clamped to
  `9999-12-31T23:59:59.999Z`; the doc comment says why. `localDayStartIso`
  untouched.
- RED:
  - parse case 9: `from 9999-12-31T23:59:59-04:00: expected { ok: true,
    value: { ...(2) } } to deeply equal { ok: false, ...(1) }`
  - route case 1: `when=range&to=9999-12-31T23:59:59-04:00: expected 200 to
    be 400`
  - dashboard local days: `expected '+010000-01-01T04:59:59.999Z' to be
    '9999-12-31T23:59:59.999Z'` (America/New_York)
- GREEN: app `tourListQuery.test.ts` + `toursApi.test.ts` 255/255;
  dashboard `tourListSelection.test.ts` + `AllToursView.test.tsx` 97/97.
  `tourListSelection.test.ts` 31/31 again under TZ = UTC, Asia/Tokyo,
  Pacific/Kiritimati (east), Pacific/Pago_Pago, America/Los_Angeles (west),
  set via PowerShell (each zone's offset at 10000-01-01 was confirmed first).
- Tests: parse case 9 refuses `9999-12-31T23:59:59-04:00` and
  `0000-01-01T00:00:00+01:00` as from and as to, and still accepts
  `9999-12-31T23:59:59.999Z` unchanged; route case 1 adds the -04:00 row; a
  new local-days case expects the literal `9999-12-31T23:59:59.999Z` at or
  west of UTC (`getTimezoneOffset() >= 0` at local 10000-01-01) and the
  day's own end east of it, asserts the result never starts with `+` in any
  zone, and pins `localDayStartIso('9999-12-31')` to its plain local
  midnight.

### R3-2 - the seven field checks pinned (488a3d7c)

- Tests only: parse case 9 adds `2026-02-29T00:00:00Z` (leap rule),
  `2026-00-10T00:00:00Z`, `2026-10-00T00:00:00Z`, `2026-10-06T12:60:00Z`,
  `2026-10-06T12:00:60Z`, `2026-10-06T00:00:00+24:00`,
  `2026-10-06T00:00:00+00:60`, each expected to be the ISO error as from and
  as to. `2028-02-29` (leap, ok) was already pinned.
- GREEN on the real code: 255/255.
- Mutant M3 (the reviewer's shape, ONE edit set): every February 29 days;
  `month < 1` and `day < 1` removed; the time line reduced to `hour > 23`.
  Result `1 failed | 254 passed`, case 9 only, 14 red assertions - from and
  to for each of the seven rows, each `expected { ok: true, value: { ...(2)
  } } to deeply equal { ok: false, ...(1) }`. No other test noticed.
- Restored with Edit: `git diff -- app/src/lib/tourListQuery.ts` 0 bytes,
  blob ae4f49ac equal to HEAD's; rerun 255/255.

### R3-3 - a lone low surrogate refused (a760b678)

- Tests only: 3b adds `a lone low surrogate in a d tourId`, built with
  `String.fromCharCode(0xdc00)` (no `\u` escape through Edit); its comment
  now says a lone surrogate "high or low" survives the wire form. The
  valid-pair row was already present.
- GREEN on the real code: 255/255.
- Mutant M4 (the reviewer's high-only class, built in code from
  `String.fromCharCode(0xd800)` / `(0xdbff)` with the `u` flag; first shown
  in node to agree with `/[\uD800-\uDBFF]/u` on lone high, lone low, pair,
  reversed pair and plain probes): `1 failed | 254 passed`, 3b only, `a lone
  low surrogate in a d tourId: expected { v: 1, f: '0123456789abcdef',
  ...(3) } to be undefined`.
- Restored with Edit: 0-byte diff, blob ae4f49ac; rerun 255/255.

## Gates (after the last code commit, a760b678)

- `npm run typecheck` (root, bare): exit 0 - app (three tsconfigs, tests
  included), dashboard, e2e, fake-twilio, fake-twilio-web.
- `npx eslint` on the five touched files (`tourListQuery.ts`,
  `tourListQuery.test.ts`, `toursApi.test.ts`, `tourListSelection.ts`,
  `tourListSelection.test.ts`): exit 0, no output - nothing to attribute.
- Not run (per the dispatch): `npm test`, e2e, smoke, Playwright.

## Divergences and notes

1. R3-2 uses `expect.soft` for the seven rows, new to this repo (Vitest
   3.2 built-in). A plain `expect` loop stops at its first failure, so ONE
   mutant could show only one row red; soft assertions report all 14.
2. R3-1 adds one row the dispatch did not list, `0000-01-01T00:00:00+01:00`:
   the dispatched rule refuses both extended signs, and without it a
   `+`-only check would pass every test.
3. `localDayEndIso` is now an early return plus the clamp (four body lines,
   not one); the arithmetic is unchanged.
4. Left open (not in the adjudicated list): the reviewer's optional century
   rows (`2100-02-29` refused, `2000-02-29` ok). By reading, a mutant that
   drops only the `% 100` / `% 400` clauses of the leap rule stays green.
5. Git Bash does not hand an IANA `TZ` (e.g. Asia/Tokyo) to a native Node
   (only `UTC` got through), so the cross-zone runs used PowerShell
   `$env:TZ`.
