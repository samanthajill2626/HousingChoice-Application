# S7 e2e report - WP1 B1 Ranking inputs (S7.1, S7.2, S7.3 + WL-41)

Status: DONE. Scope was plan section 11 tasks S7.1-S7.3 and WORKLIST WL-35 to
WL-41. S7.4-S7.6 (main sync, the five gates, self-QA, the gate-run sheet) are
the orchestrator's and were not touched. No app or dashboard source bug was
found, so no source fix was made.

## Session and run sequence ([PR43] [PR40], WL-39)

- One `npm run e2e:session`, started with the shell tool's BACKGROUND mode at
  branch HEAD cf43789e (S6's last commit, tree clean), output redirected to
  `.superpowers/sdd/s7-session.log` (gitignored). Lane 3: app :9301, web
  :9311, fake-twilio :9321, public base :9331 (`e2e/.artifacts/lane.json`).
- The launcher's ready line (`ready - app :9301 (http://127.0.0.1:9301), web
  :9311 ...`, printed with an em dash) was already in the log at the first
  read, which came before any spec run, so no until-loop wait was needed; the
  WL-39 condition (no run during boot) held.
- Every spec run printed `[playwright] reusing the live e2e:session on lane 3`
  - none booted its own stack. No commit and no source edit while the session
  ran; only the three spec files were written during it.
- Stopped with `npm run e2e:stop` (exit 0): launcher 66820 and children
  stopped, orphans on :9301 / :9311 killed, lane 3 tables dropped, lease
  released. Afterwards: no listener on 9301 / 9311 / 9321 / 9331
  (Get-NetTCPConnection), no `e2e/.artifacts/session.pid`, no node process of
  this worktree's stack. The background shell task then ended with exit 1 -
  expected, it is the killed launcher.
- Commits made only after the stop, one task at a time, then WL-41, then this
  report.

## Spec runs (one spec file per run, `npm run e2e -w @housingchoice/e2e -- tests/<path>.spec.ts`)

| Run | Spec | Result |
|---|---|---|
| 1 | dashboard-next/tenant-matching-inputs.spec.ts | exit 0 - 1 passed (3.3s; the test 1.7s) |
| 2 | flows/conversation-fact-extraction.spec.ts | exit 0 - 16 passed (17.0s): the 12 existing tests and the 4 new ones |
| 3 | dashboard-next/property-priority.spec.ts | exit 0 - 1 passed (2.6s; the test 1.8s) |
| 4 | dashboard-next/tenant-matching-inputs.spec.ts (re-run after S7.3) | exit 0 - 1 passed (2.1s) |
| 5 | flows/conversation-fact-extraction.spec.ts (re-run after S7.3) | exit 0 - 16 passed (16.7s) |

No flake, no retry: every test passed first time on both runs. Raw output is
in `.superpowers/sdd/s7-run-*.log` (gitignored scratch, regenerable).

PR14 proof, partial: two of S4.7's four migrated `noteLines` payloads live in
conversation-fact-extraction.spec.ts (the partner and property-manager
triage tests) and passed twice here. The other two (caseworkers.spec.ts:517,
ai-run-log.spec.ts:177) were NOT run by this slice; S7.4's full `npm run e2e`
proves them.

## Checks before the commits

- `npm run typecheck` (bare, root, all workspaces): exit 0.
- `npx eslint` on the three spec files: exit 0, no output.
- `npx tsc -p tsconfig.json` in e2e/ (run while the session was live, before
  stopping it, so a lint or type fix could still be re-run): exit 0.
- ASCII (WL-37): the three `tr -d '\11\12\15\40-\176' < FILE | wc -c` checks
  on tenant-matching-inputs.spec.ts, property-priority.spec.ts and
  conversation-fact-extraction.spec.ts each print 0; `grep -nF '\u'` on the
  three finds nothing; selectors.md's added lines print 0 (the file keeps its
  pre-existing em dashes).

## Commits

- 7b3fdcaa test(e2e): tenant matching inputs - edit, trim, portion format, clear (B1 S7.1)
- 930a7e49 test(e2e): extraction fields, the confidence floor and a feedback line end to end (B1 S7.2)
- 8a540c5d test(e2e): property Priority on/off round trip and display (B1 S7.3)
- d8b7e7ce docs(e2e): selectors for the tenant matching input rows and chips, the Notes lines block and the Priority switch (B1 S7, WL-41)
- this report

## WORKLIST items applied

- WL-35 (S7.2 test 2): run 1 sends the area_preference `write` plus the
  voucherSize `suggest` sentinel; server truth first (`GET
  /api/contacts/:id/suggestions` targets contain `voucherSize`, not
  `area_preference`; the contact still holds `Marietta`); on the page the
  sentinel chip `AI suggestion for voucher size` is awaited BEFORE the area
  row (`Area preferenceMarietta`, exact) and the area chip's count 0; run 2's
  `suggest` then shows `AI heard "Decatur"`.
- WL-36 (S7.3): street line `${stamp} Pswitch Ave`; published through `PATCH
  /api/units/:id/listing-status` while Priority is ON; `GET
  /public/units/:id/flyer` is 200 and its keys lack `priority`; `/p/:id`
  asserts the h1 equals the street line BEFORE `getByText('Priority')` count
  0; the header pill is an exact match scoped to the page `<header>` that
  holds the street-line h1.
- WL-37 (S7.1): `const BLANK = String.fromCharCode(0x2014);`, rows read
  through the label span's parent; the three `tr` checks above.
- WL-38: helpers file-local. S7.2 adds exactly `import { createUnitViaApi,
  daysAgo, plantListedSend } from '../../support/followUpFixtures.js';` and
  keeps its own `createTenant`; S7.1 imports `createTenant` from
  followUpFixtures and declares its own `NEXT` / `devLogin`; S7.3 copies
  `createLandlord`, `getUnit`, `publish`, `addPropertyFromLandlordPage` (plus
  `uniquePhone` and the `Landlord` type they need).
- WL-39: above.
- WL-40: `test.slow();` at the top of S7.3's test and S7.2 test 4.
- WL-41: selectors.md (one commit, after the three spec commits): the
  review-chip row lists the four new chip labels (exact, and the portion
  chip's `$1,200 / month` form); a new row for the `Notes lines` region and
  its items; a new row for the Priority checkbox (both forms), the Property
  details row and the header pill, with the flyer rule. Plus one more row,
  see divergence 7.

## Divergences from the plan text (all test-side, each deliberate)

1. S7.1 signs in with `POST /auth/dev-login` as `va@example.com` (the
   dashboard-next dialect of property-requirements.spec.ts) and creates the
   tenant with followUpFixtures `createTenant` (WL-38; it also records
   consent and voucher size 2 - harmless).
2. S7.1 asserts more than the plan lists: the rows persist across a reload;
   the GET checks all four stored values; step 4 proves the browser itself
   accepts `12.5` (`validity.valid` is true), so the refusal can only be the
   form's own copy, then Cancels and re-reads the row; step 5 checks the
   other three values stand after the clear. It carries `test.slow()` (three
   Edit round trips and a reload).
3. S7.2 test 1 reads the Auto badge INSIDE the area row (not just the card)
   and checks the server's `area_preference_source` is `{ source: 'ai' }`.
4. S7.2 test 2 also checks the row still reads `Marietta` after run 2's chip
   appears (nothing written before staff accept).
5. S7.2 test 3 matches the prefix as
   `/\[Auto - [A-Z][a-z]{2} \d{1,2}\] Works nights downtown/` (apply.ts
   `autoPrefix` stamps the run's UTC month and day) on the card and in the
   server's `notes`; the absence is read on the same load, after the
   positive, and on the server.
6. S7.2 test 4 also reads `1 appended` in the Notes lines region and checks
   the server's `notes` hold the feedback line. S7.2 adds two file-local
   LOCATOR helpers (`notesCard`, `intakeRow`) and `type Locator` to the
   playwright import; the plan's "add none" predates WL-38's file-local rule
   and these build no data.
7. selectors.md gains one row WL-41 does not list: how to read the four
   Eligibility intake rows (label span's parent, BLANK via
   `String.fromCharCode(0x2014)`, the exact form labels, the portion's
   `role="alert"` copy). It is the selector S7.1 and S7.2 rely on most and
   the trap D7-S7-3 found.
8. S7.3's copied `addPropertyFromLandlordPage` drops the unused
   `prefilledFrom` option; the landlord's last name is `Prilandlord`. The
   test also checks Priority starts unchecked and is described `Staff only`
   on both forms, and re-reads the row and the pill after a reload. The
   flyer page is opened on the staff page (as property-requirements.spec.ts
   does), not a separate visitor context; the route is public and renders
   the same.

## Selectors relied on

- Contact page: `page.getByRole('button', { name: 'Edit contact details' })`
  -> `getByRole('dialog', { name: 'Edit contact' })`; controls
  `getByLabel('<label>', { exact: true })` for the four labels; `Save` /
  `Cancel` buttons scoped to the dialog (Modal.tsx puts the footer inside
  it); the refusal `dialog.getByRole('alert').filter({ hasText })`.
- Eligibility intake rows: `section` filtered by heading `Eligibility intake`,
  `.getByText('<label>', { exact: true }).locator('..')` (Card.tsx KV is
  `<div><span>label</span><span>value</span></div>`); the Auto badge
  `getByRole('img', { name: 'Auto' })` inside that row.
- Chips: `getByRole('group', { name: 'AI suggestion for area preference',
  exact: true })` and the sentinel `AI suggestion for voucher size`; text
  `AI heard "Decatur"`.
- Notes card: `section` filtered by heading `/^Preferences & notes/` (the
  heading's name also carries `Add a note`).
- AI run log: `getByRole('heading', { name: 'AI run log' })`,
  `getByRole('list', { name: 'AI runs' }).getByRole('button')` (count 1),
  `getByRole('region', { name: 'AI run detail' })` ->
  `getByRole('region', { name: 'Notes lines' })` -> exact texts
  `1 appended`, `Feedback lines: 1`, `Unlabeled address lines: 0`.
- Property: the New form `getByRole('checkbox', { name: 'Priority', exact:
  true })` with `toHaveAccessibleDescription(/Staff only/)`;
  `getByRole('button', { name: 'Edit property details', exact: true })` ->
  `getByRole('dialog', { name: 'Edit property' })`; the Property details row
  (label span's parent) `PriorityYes` / `PriorityNo`; the pill
  `page.locator('header').filter({ has: getByRole('heading', { level: 1,
  name: line1 }) }).getByText('Priority', { exact: true })`; the flyer
  `getByRole('heading', { level: 1 })` then `getByText('Priority')`.

## Watch items this slice touched

- WI11 (e2e half): every new label and chip lookup passes `exact: true`; none
  of the four labels contains an existing intake label (`Pets`, `Evictions`,
  ...) as a substring. Green.
- WI12: proven end to end by S7.3 on an AVAILABLE property while Priority is
  ON - the flyer JSON has no `priority` key and the flyer page shows no
  `Priority` text after its h1 positive.
- WI16: the specs use the hermetic lane only (fake extraction driver, fake
  Twilio); nothing reads `ANTHROPIC_API_KEY` or reaches the network.

## Risks and notes for the orchestrator

- A run-log row count of exactly 1 holds because each test's contact is fresh
  and gets one EXTRACT inbound and one tick; a future change that schedules a
  second run per inbound would break S7.2 test 4 on `toHaveCount(1)`, not on
  its substance.
- `tick.processed >= 1` alone never proves a run applied (a malformed marker
  is still a processed run); every new S7.2 test pairs it with a positive the
  run itself produced (the written value, the sentinel chip, the appended
  line, the feedback count).

## Next step

S7.4 (orchestrator): sync main once, then the five gates from the worktree,
including the full `npm run e2e` that proves caseworkers.spec.ts and
ai-run-log.spec.ts's S4.7 payloads and runs these three specs inside the
whole suite.
