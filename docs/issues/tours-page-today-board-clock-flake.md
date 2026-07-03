---
id: tours-page-today-board-clock-flake
title: tours-page e2e "schedule WITH a time" flakes near local midnight (clock-dependent tour time) + strict-mode "Today" locator
type: bug
severity: med
status: resolved
area: e2e
created: 2026-07-02
resolved: 2026-07-02
refs: e2e/tests/dashboard-next/tours-page.spec.ts, dashboard/src/routes/today/useToday.ts:42, dashboard/src/routes/today/Today.tsx:56, dashboard/src/routes/today/Today.tsx:80, app/src/routes/today.ts:246
---

**Problem.** The dashboard-next spec `tours-page.spec.ts › schedule WITH a time`
was time-of-day fragile and failed in the evening (reproduced at 23:21 EDT,
failing at the "Tours today" list assertion; a ~22:55 run instead failed on the
"Today" heading).

Two independent defects, both rooted in a wrong mental model of how the Today
board scopes "today":

1. **Clock-dependent tour time.** The test scheduled the tour at
   `Date.now() + 1h` and asserted it appears under the home "Today" board's
   "Tours today" section. But the board derives its day from the **browser's**
   clock — [useToday.ts:42](../../dashboard/src/routes/today/useToday.ts#L42)
   computes `localDayWindow(new Date())` and sends *that* window to
   `/api/today`; the `?day=/toursFrom=/toursTo=` query params the test put on the
   URL are **never read** by the SPA (only `endpoints.ts` builds them, from the
   hook's computed window). So after ~23:00 local, `now + 1h` rolled the tour
   into **tomorrow**, dropping it out of the board's local-today window →
   "Tours today" never rendered. The dialog also rejects a past datetime
   ([ScheduleTourForm.tsx:219](../../dashboard/src/routes/tours/ScheduleTourForm.tsx#L219)),
   so simply hard-coding "noon today" would fail whenever the run is after noon —
   near true midnight there is *no* future-and-still-today time at all.

2. **Strict-mode "Today" locator.** `getByRole('heading', { name: 'Today' })`
   is a case-insensitive **substring** match, so it matched BOTH
   `<h1>Today</h1>` ([Today.tsx:56](../../dashboard/src/routes/today/Today.tsx#L56))
   and `<h2>Tours today</h2>` ([Today.tsx:80](../../dashboard/src/routes/today/Today.tsx#L80))
   whenever the "Tours today" section rendered → Playwright strict-mode failure.
   This was latent (the section only renders when an in-window tour exists) and
   affected all three `Today`-heading assertions (devLogin + both schedule tests).

**Resolution (2026-07-02).** Test-only fix in `tours-page.spec.ts`:

- Pin the browser wall-clock with `page.clock.setFixedTime(today 09:00 local)`
  and schedule the tour for **noon today** — unambiguously *future* (vs the pinned
  09:00) AND *today*, at any real wall-clock hour. `setFixedTime` pins
  `Date.now()`/`new Date()` but keeps timers running, so SSE/debounce are
  unaffected (verified: auth + full flow run green under the pin).
- Dropped the ignored `?day/toursFrom/toursTo` URL params (the board reads the
  browser clock, not the query) and navigate to `/`, with a comment so no one
  reintroduces the local-date-vs-UTC-`Z` window mismatch.
- Made all three `Today` heading locators `{ name: 'Today', exact: true }`.

Verified: baseline failed at 23:21 EDT; the fixed spec passed at 23:24 EDT (same
near-midnight window), and the full `tours-page.spec.ts` (3 tests) is green.
Because the pin makes the browser clock a constant independent of real time,
daytime and near-midnight runs are identical by construction.
