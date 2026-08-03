---
id: placement-detail-test-wallclock-voucher
title: PlacementDetail header test hardcodes a voucher date and goes red once it passes
type: bug
severity: med
status: resolved
area: dashboard
created: 2026-08-03
resolved: 2026-08-03
refs: dashboard/src/routes/placements/PlacementDetail.test.tsx:94, dashboard/src/routes/placements/PlacementDetail.test.tsx:211
---

**Problem.** `PlacementDetail - header > renders the title, stage pill, and
date-vocabulary facts line` fails on any machine whose clock is past 2026-08-02.
The fixture pins `voucher_expiration_date: '2026-08-02'` (line 94) while the
assertion expects the future-tense vocabulary `/voucher expires Aug 2/` (line
211). Once that date passes, the component correctly renders the PAST-tense
string instead:

```
expected: voucher expires Aug 2
actual:   voucher expired Aug 2 (35h ago)
```

First observed 2026-08-03. It is not flaky — it is now permanently red, so
`npm test` fails for every branch until the fixture is fixed. That matters
beyond this one test: a red `npm test` is a required merge gate, so every future
branch inherits a failure it did not cause and has to re-diagnose it.

Nothing about the component is wrong — the date vocabulary is behaving exactly
as designed. Only the test's assumption ("this date is in the future") expired.

**Suggested fix.** Two reasonable options; pick one deliberately rather than
bumping the constant (bumping just re-arms the same bomb for a later date):

1. Make the fixture relative to now — derive the voucher date as "today + N
   days" and assert the future-tense vocabulary. Keeps the test meaningful
   forever, at the cost of a slightly less literal fixture.
2. Pin the clock — `vi.setSystemTime()` to a fixed instant before rendering, and
   keep the literal `2026-08-02` fixture and its expected copy. Matches what
   `tours-page.spec.ts` does with a pinned browser clock for the same class of
   problem.

Worth a sweep for sibling cases while fixing: other specs that hardcode dates
near the seeded "now" will expire the same way.

**Resolution (2026-08-03).** Fixed the CLASS, not the one test: the dashboard
vitest setup (dashboard/src/test/setup.ts) now pins the clock to a fixed instant
(2026-07-01T12:00:00Z) via a BARE `vi.setSystemTime` - vitest's standalone
date-mocking mode, which fakes ONLY Date; timers stay real so waitFor/userEvent
are unaffected. Pinned at module level (so module-scope now-relative fixtures
like ToursPage.test's todayAt() read the same frozen clock as components) and
re-pinned in a global beforeEach. Under the pin the original fixture (voucher
2026-08-02) is future again, so the failing test and its assertion are unchanged.
Fixture dates in component tests structurally cannot expire anymore; the
year-2999 defusals in sibling suites (DeadlinesNudgesCard, PlacementNowCard)
keep working as-is.

Collateral the pin required/exposed:

- Suites installing FULL fake timers (useEventStream, useBroadcastResults,
  RemindersPanel) now call `vi.useRealTimers()` first to release the Date pin -
  vitest THROWS a self-explanatory error if a future suite forgets (it refuses
  `useFakeTimers` while a bare `setSystemTime` mock is active), so the
  convention is self-enforcing. Their fake clocks anchor to the real now,
  exactly as before the pin.
- The pin EXPOSED a latent reverse-direction sibling: TourDetail's no-show
  check-in tests relied on the makeTour default scheduledAt (2026-07-10) being
  "already in the past" on the real clock - true only after 2026-07-10. They
  now pass an explicitly past start relative to the pinned instant.

The sweep found no other armed dates: app/ tests have none, and the Playwright
e2e layer was already immune (Date.now()-relative steps, now-relative seed,
tours-page's own pinned browser clock).
