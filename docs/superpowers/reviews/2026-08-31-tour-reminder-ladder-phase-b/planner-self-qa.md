# Planner's live QA - Phase B (2026-09-01, hermetic lane 7 @5f1efd43)

Independent of the orchestrator's `self-qa.md`: own lane boot (`npm run
e2e:session`), own fixture (the `full` demo profile via `POST /__dev/reseed?profile=full`
plus ONE pause-era `confirmation` row written directly into the lane table), own
Playwright MCP session. Never the live :5174/:8080 stack. Lane released with
`npm run e2e:stop` (tables dropped, ports verified free). Screenshots
(gitignored, main checkout `.playwright-mcp/`): `planner-qa-01-tour-live-upcoming.png`,
`planner-qa-02-discontinued-row.png`.

## 1. Seeded landlord-led tour, before the extra row (`/tours/tour-live-upcoming`, Thu Sep 3 10:00 ET)

Reminders panel: THREE rungs - Day before (`Next`, sends in 34h, Send now +
Cancel), 4 hours before (44h), En route (47h). No `confirmation` row (T9), no
`Paused` chip anywhere (T7 - the unpause), bodies carry the tenant's and
landlord's first names (Phase A resolution).

Wire (`GET /api/tours/tour-live-upcoming/reminders`): dueAts
`2026-09-02T23:30Z` / `2026-09-03T10:00Z` / `2026-09-03T13:00Z` = 7:30 PM the
evening before / 6:00 AM / 9:00 AM Eastern - the retimed ladder; no
`suppression` on any rung; `next.kind === 'day_before'`; no `overdue` key on
future rungs (conditional-spread omission, spec 8.1).

Observed and explained, not a defect: the tour page's Upcoming timeline lists a
ladder timed for the Sep 2 tour. The `live` seed points BOTH live tours at
`conv-live-relay-group` (`app/src/lib/seed/live.ts:379,392`), so the group
scheduled view correctly shows what is on that conversation. Seed shortcut,
pre-existing.

## 2. Relay intro preview, group-less landlord-led tour (`GET /api/tours/tour-mx-scheduled-02/roster/preview-open`)

Body: `Hey Terrence! Putting you in a group text with Marcus to tour 800 Glynn
St N, Fayetteville, GA 30214 on Sun, Sep 6 at 10:18 AM. Looking forward to you
seeing the property and meeting Marcus! Please let us know when you're on the
way.` - the DATED tour variant, byte-exact against spec 9.1's fenced block,
resolved first names. `{where}` is the full legacy string because the matrix
seed stores plain-string addresses (`seed-addresses-unstructured`, out of scope
per spec 9.3). Preview parity path exercised (spec 9.0).

## 3. Pause-era pending `confirmation` (dueAt `2026-08-25T14:00Z`) on the Sep 3 tour

Panel: `Confirmation` row chips **`No longer sent`**, note `No longer sent -
turned off` (the PR2-3 copy ruling, no stutter), **Cancel only - no Send now**,
no `Next`; `Day before` remains `Next`. The other three rows unchanged.

Wire: the row is `state: 'upcoming'`, `overdue: true`, `suppression:
{ reason: 'discontinued' }`; `next` is still `day_before` (the discontinued row
is never `next`). Both flags on one row, chip precedence discontinued > overdue
holding in the real panel.

## Verdict from QA

Every surface I touched matches the spec as finally revised. Nothing found that
the orchestrator's self-QA or the two independent reviewers had not already
covered; the seed-sharing observation is recorded so the next reader does not
re-diagnose it.
