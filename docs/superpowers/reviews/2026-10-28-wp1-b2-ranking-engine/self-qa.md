# B2a self-QA - live, on a hermetic lane (orchestrator-driven)

- When: 2026-10-29, 23:09Z-23:13Z, at 11fd9407 (code = 7fb7b723, after fix
  wave 4).
- Lane: `npm run e2e:session` with `E2E_CHILD_LOG_DIR`, lane 7 (dashboard
  :9711, app :9701, fake-twilio :9721), lean world; RANKING_DRIVER=fake,
  RANKING_WORKER_POLL=off, RATE_LIMIT_RANK_PER_MIN=100000 from the session
  env. Jobs ran only through `POST /__dev/ranking/tick`. Never the live
  :5174 / :8080. Stopped with `npm run e2e:stop` (no listener left on the
  lane's ports).
- Driver: the project Playwright MCP (`browser_run_code_unsafe`), API
  fixtures through the lane's dashboard origin exactly as
  `e2e/fixtures/ranking.ts` builds them. Screenshots (gitignored):
  `W:/tmp/wp1-b2-ranking-engine/.playwright-mcp/qa-01..07-*.png`.
- Fixtures: a run-unique housing authority "QA Authority 393989"; one
  available 2-bedroom property with a worst-case address ("393989 Martin
  Luther King Jr Drive Southwest Apartment 1204B, Atlanta"), area "West
  End", No pets; three searching tenants holding the authority - a
  worst-case long name with area preference "West End", a plain one, and
  one with pets text; later a fourth carrying `[fake:fail-batch]` in Notes.

## Scenarios and results (all PASS)

1. Property anchor, admin, from the Rankings tab: picking the property
   reads the pool at once - three rows "not ranked yet". Rank -> "Waiting
   for a free slot". Tick (claimed 1) -> without a reload (a window marker
   survived) the status read "Done: 1 batch" and the table re-read: Strong
   80 (area match), Good 70, then the pets tenant Weak 45 "Capped:
   requirement not met" LAST (score 45 is Possible by score; the cap reads
   Weak). Reasons and missing columns filled. (qa-01)
2. Out of date after a card edit: PATCH of the property's notes -> on the
   next read every row read "Out of date: a card changed" and the anchor
   block said "This record changed since it was last ranked." A second Rank
   + tick cleared it. (qa-02)
3. Runs and cost: "Show runs for this anchor" listed both runs (fake, 3
   candidates, $0.0000, latency, scored), newest first, filtered to the
   anchor; "Cost by week" showed "Environment: local", "The last 12 weeks."
   The older run's detail showed its OWN results (rubric r1, examples e1,
   the prompt fingerprint, "3 matches written", raw output and input
   collapsed) with "Since re-scored" on every pair; pressing it opened the
   newer run (URL `run=` changed), whose pairs read "This run" (FW1-8).
   (qa-03)
4. Failed batch: with the `[fake:fail-batch]` tenant in the pool, Rank +
   tick -> "Done: 1 batch. 4 tenants could not be scored. Press Rank
   again." (the loss stated once, FW1-10); the new tenant read "not scored -
   retry", the three earlier matches stayed shown with "Out of date: the
   last ranking failed for it"; the job read carried one failedBatches entry
   (failure `driver`, all four candidate ids) and the message. (qa-04)
5. Tenant anchor: picking the long-named tenant (the window checkbox is
   gone for a tenant anchor) showed the property row from the shared pair
   row already; Rank + tick re-scored it; "Missing on this record: Maximum
   tenant portion". (qa-05)
6. VA: no Rankings tab; `/settings/rankings` redirects to
   `/settings/templates`; the API answers rank 202, read 200 (4 rows), job
   200; `/api/admin/rankings/runs`, `/cost` and `/runs/:id` answer 403
   (WI17).
7. The edit form's Notes conflict, two pages: page B saved "QA theirs";
   page A's Save was refused with the D14.3 copy ("Nothing was saved. These
   notes were changed since you opened this form. ...") and the current
   notes; the panel sits ABOVE the Notes box (panel 528-632 px, textarea
   top 666 px) and is the textarea's `aria-describedby`; the dialog has no
   sideways overflow (478 / 478). Cancel -> the page showed "QA theirs"
   with no reload (FW2-4's hand-up); reopening Edit showed it in the box,
   and a Notes save then went through and stamped `notes_updated_at`. The
   only console error was the expected 409 resource line. (qa-06)
8. The event stream down (`**/api/events**` aborted): Rank + tick -> the
   page reached "Done" 4970 ms after the tick through the 5 s job poll
   alone, table re-read, no reload (spec D12: the event is a hint).
9. Layout, measured (not eyeballed) at 1440, 1280, 1024, 768 and 390 px
   with the run detail open: the page never scrolls sideways
   (documentElement scrollWidth == clientWidth at every width), no element
   ends past the viewport outside a scroll container, the 64-hex prompt
   fingerprint wraps inside its column at every width (scrollWidth ==
   clientWidth). Tables scroll inside their own wrapper where narrower than
   their content (the ranking table at 390 and 768, the run detail's pairs
   table at 1280 and below; the raw-output `pre` always). Full width at
   1024-1440 (qa-07-width-*.png).

## Notes (no code change)

- QA-1: the cost totals and the runs list load when shown and on Refresh;
  a job that ends while the page is open does not refresh them (the
  Refresh button does - verified, 1 -> 2 runs). The ranking table itself
  follows the job live.
- QA-2: a pair's `missing` order follows whichever anchor ranked it last
  (anchor flags first, spec D3), so the same pair lists its gaps in a
  different order after a tenant-anchor ranking. Cosmetic.
- The lane's worker logged nothing for ranking (its poll is off by design);
  every job ran in the app process through the dev tick.
