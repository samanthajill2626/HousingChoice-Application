# Live self-QA - Phase B (orchestrator, 2026-09-01, hermetic lane 7 @b9247388)

Driven by the orchestrator through `npm run e2e:session` (lane 7: app :9701, dashboard
:9711, fake-twilio :9721, tables `hc-local-7-*`, key `hclane7`) and the Playwright MCP.
Never the live :5174/:8080 stack. Screenshots (gitignored, main checkout
`.playwright-mcp/`): `selfqa-01-reminders-panel-discontinued.png`,
`selfqa-02-reminders-panel-after-sweep.png`. Lane released with `npm run e2e:stop`
afterwards; ports verified free.

## Fixture (all through the real API via dev-login `va@example.com`)

Tenant Alicia SelfQA, landlord Marcus SelfQA, unit `412 Oak St SelfQA` (Atlanta, published
available), landlord_led tour at +48h (`2026-09-03T05:36:53Z`). Then ONE pause-era
pending `confirmation` row written directly into the lane's `tourReminders` table
(`dueAt 2026-08-25T14:00Z`) with a gitignored helper - the exact shape the 2026-08-20..31
binary armed and the only way to produce one after T9.

## What was measured (DOM read via `page.evaluate`, not eyeballed)

### 1. GET /api/tours/:id/reminders (wire)
- `next.kind === 'day_before'` - the discontinued row is NOT `next` (review B-MF2).
- `confirmation`: `state upcoming`, `suppression {reason:'discontinued'}`, `overdue: true`.
- `day_before` / `morning_of` / `en_route`: `upcoming`, NO suppression - nothing reads
  `paused` anywhere (the unpause, spec 3.1).

### 2. Reminders panel, before the sweep
| row | chip(s) | `aria-current` | buttons |
|---|---|---|---|
| Confirmation | `No longer sent`; note `No longer sent - turned off` | none | **Cancel only** (no Send now - review B-S1) |
| Day before | `Next`, `sends in 42h` | `step` | Send now, Cancel |
| 4 hours before | `sends in 44h` | none | Send now, Cancel |
| En route | `sends in 47h` | none | Send now, Cancel |
- The discontinued row is `overdue:true` on the wire but chips `No longer sent`, not
  `Overdue` - the ruled chip order (R15) holds in the real panel.
- Body copy is Sam's Phase A wording with the tenant's and landlord's first names.

### 3. The retirement sweep, end to end on the hermetic lane (spec 4.4 allows a local lane)
```
--dry-run : scanned 4, tourAlreadyPassed 0, kindRetired 1, skipped 3, failed 0  (EXIT 0)
ladder re-read after dry run: UNCHANGED (confirmation still upcoming/discontinued)
apply     : scanned 4, tourAlreadyPassed 0, kindRetired 1, skipped 3, failed 0  (EXIT 0)
ladder    : confirmation -> state skipped, skipReason kind_retired; next still day_before
re-run    : kindRetired 0, skipped 4, failed 0                                   (EXIT 0)
```
Logs carried counts + ids only (no names/phones/bodies) - checked in the raw output.

### 4. Reminders panel, after the sweep
| row | chip | buttons |
|---|---|---|
| Confirmation | `Skipped - this reminder is no longer sent` | none |
| Day before | `Next`, `sends in 42h` | Send now, Cancel |
(the other two unchanged)
- This is the RUNBOOK's promised between-states degradation resolving itself: the row
  moves from the terminal-looking suppression chip to a genuinely terminal skipped chip.

### 5. Relay intro preview (`GET /api/tours/:id/roster/preview-open`)
`Hey Alicia! Putting you in a group text with Marcus to tour 412 Oak St SelfQA on Thu,
Sep 3 at 1:36 AM. Looking forward to you seeing the property and meeting Marcus! Please
let us know when you're on the way.` - the dated tour variant ("on {when}"), resolved
first names, street only. Byte-exact against spec 9.1's dated fenced block.

## Not covered live (and why)
- The `Overdue` chip on a LIVE rung: with the ladder unpaused, a past-due pending rung is
  exactly what the lane's 30s worker sends, so it cannot be held still long enough to
  photograph; pinned at route + component level instead (T12 tests) and asserted in the
  wire read above (`overdue: true` on the discontinued row).
- Relay legs on fake-twilio: covered by `relay-intro-variants.spec.ts` (262/262 e2e).
- Console: the only browser errors were the two pre-login `/auth/me` 401s on the
  landing page - expected.
