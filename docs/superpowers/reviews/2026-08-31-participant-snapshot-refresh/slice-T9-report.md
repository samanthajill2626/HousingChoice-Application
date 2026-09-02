# T9 slice report - e2e: a rename shows on Today, the group header, the contact card

Commit: `780f5119` - `test(e2e): a rename shows on Today, the group header and the contact card`

Files: `e2e/scenarios/steps.ts` (two public additions), `e2e/tests/scenarios/participant-names.spec.ts` (new).

## Lane

Lane 12, cold-booted by the spec run itself (`hc-local-12-` tables, bucket
`hc-local-media-12`, key `hclane12`, ports 10201/10211/10221/10231). No session
existed for this worktree before the first run (`e2e/.artifacts` absent) and no
listener held any lane port. After the final run: no listener on 10201/10211/
10221/10231 and launcher pid 75360 not running - the stack tore down.

Command (the root `npm run e2e -- --grep` form does NOT forward the flag):
`npm run e2e -w @housingchoice/e2e -- --grep "renaming a contact"`

## Runs

| # | Result line | Exit | Cause |
|---|---|---|---|
| 1 | `1 failed` (test 25.4s) | 1 | `getByRole('heading', { name: 'Today', exact: true })` not found. The plan navigated to `/today`; Today is the dashboard ROOT route. |
| 2 | `1 failed` | 1 | `getByText('PNTenant847353X Renamed')` not found on Today. The tenant had no unread 1:1 - see the mark-read finding below. |
| 3 | `1 passed (24.1s)` (test 9.7s) | 0 | Green. |
| 4 | `1 passed (25.8s)` (test 10.0s) | 0 | Green, with three temporary `console.log` evidence lines (reverted; NOT committed). |
| 5 | `1 passed (23.2s)` (test 9.0s) | 0 | Green on the committed file state. |

Supporting gates: `npm run typecheck` exit 0 (before the spec run and again
after the final edits). `npx eslint e2e/scenarios/steps.ts
e2e/tests/scenarios/participant-names.spec.ts` exit 0, no output.

## What the three assertions matched

Captured from run 4 (`textContent()` of each matched node; the app's light
logger redacts names, so the logs cannot supply this). Tenant of that run:
created `PNTenant247353 Tester`, renamed to `PNTenant247353X Renamed`.

1. Today (`/`), `getByText(renamed.name).first()` -> `"PNTenant247353X Renamed"`
2. Owner's contact file, Relay groups card row (`expectGroupOnContactFile`,
   `getByRole('link', { name: /^With .*<new first name>/ })` plus an
   `href="/conversations/<groupThreadId>"` assertion) ->
   `"With PNTenant247353X Renamed2 members"` (accessible name is
   `With <other> - <n> members`; `textContent` drops the separator)
3. Group thread header facts line, fresh load of `/conversations/<groupThreadId>`,
   `getByText(/^With .*<new first name>/)` ->
   `"With PNTenant247353X Renamed & PNOwner239951 Tester"`

All three carry the NEW name. None ever rendered the stored snapshot
(`PNTenant247353 Tester`) - no surface produced stale-name evidence.

## Divergences from the plan

1. **`/today` -> `/`.** The plan's `page.goto(`${NEXT}/today`)` hits the
   catch-all `Not found` placeholder (`App.tsx:264`); Today is the root route
   and the nav's "Today" link points at `/`. Nothing else in `e2e/` used
   `/today`. Run 1's failure snapshot showed the nav rendered with no Today
   heading.
2. **Leave the tenant's contact page before the tenant texts.** The plan sent
   the inbound while the browser still sat on the contact page left open by the
   rename. Run 2's server log shows, back to back:
   `POST /webhooks/twilio/sms` -> `"twilio inbound message processed"` then
   immediately `POST /api/inbox/<contactId>/read` -> `"conversation unread
   reset"`. The open contact timeline marked the brand-new inbound read on
   arrival, so the 1:1 was never unread and never entered Today's unread pass.
   The spec now navigates to `/` before `tenantTexts`. This is dashboard
   behaviour, not a name-resolution defect.
3. **Reload-poll on the Today assertion.** Today fetches `/api/today` once on
   mount and does not poll, and `tenantTexts` returns before the fake-Twilio
   webhook has necessarily been ingested. The plan's single `goto` + 15s
   `toBeVisible` could only ever wait on a payload already fetched. Replaced
   with `expect(async () => { goto; expectTodayReady; toBeVisible(5s) })
   .toPass({ timeout: 20_000 })`. It still fails loudly on a STALE name (the
   old name never satisfies the matcher), so no regression is masked. The
   20s ceiling sits well inside the 100s scenario budget; the test runs 9-10s.

Everything else is the plan verbatim, including both steps.ts additions and the
plan's hand-built `renamed.name` (correct - `freshContact().name` is not
`firstName + ' ' + lastName`).

## Open worries

- The header assertion's regex is unanchored on the right (`^With .*<first>`),
  so it would also pass if the LAST name were stale. `renamed.firstName` is the
  run-unique token, so it is the discriminating half, and the evidence above
  shows the full new name rendering - but the assertion itself proves the first
  name only. Left as the plan wrote it.
- The scenario leaves an unread 1:1 and an open relay group in the lane. Both
  are per-run unique (timestamped phones/names), consistent with the suite's
  self-clean isolation convention, but this spec does add one more permanently
  unread thread to Today for the rest of a full-suite run.
- Assertion 2 goes through `expectGroupOnContactFile`, which reads the OTHER
  party's name off the Relay groups card. It was already asserting a name
  before this branch; T9 only changes which name it expects. It is therefore a
  regression guard for T4, not an independent probe of it.
