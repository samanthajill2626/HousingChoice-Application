# Slice report - S9 (e2e: the Today spec rewrite and the auto-close spec)

- Date: 2026-10-04. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD 1f047d83 (S8b report commit).
- Scope: plan S9 only - Task 9.1 (rewrite
  `e2e/tests/dashboard-next/today-past-tours.spec.ts`) and Task 9.2 (new
  `e2e/tests/dashboard-next/tour-auto-close.spec.ts`). One commit per task,
  then this report. No app, dashboard, harness or docs file was touched.
- Sources followed: AGENTS.md ("UI testing and verification", "Editing and
  commit discipline"); plan sections 0, 1, S9 (Tasks 9.1-9.2) and 12; spec
  9.2, 9.3, 9.4 and 11; the binding corrections 1-7 and sections 2 and 4 of
  `research/drift-s9-s10-e2e-docs.md`; ruling D-l and flags F6 / F9 in
  `research/worklist.md`; the shipped names in `slices/s8b-report.md` section
  6, the reopen route in `slices/s6-s7-report.md` section 6, the dev tick in
  `slices/s5-report.md` section 6; `e2e/README.md`, `e2e/support/selectors.md`
  (the tick row, :109); the precedents `tours-past.spec.ts`,
  `tours-page.spec.ts` and `e2e/fixtures/fakeTwilio.ts`; the reference quotes
  in `.superpowers/sdd/research/ref-s9-s10-e2e-docs.md` sections 1-8. Every
  name and text the specs assert was then re-read in the live code (section 5).
- No STOP condition was hit: every dashboard name and text matched the S8b
  report and the spec; the reopen route and the tick behaved exactly as their
  reports say (server-log evidence in section 2); all three spec runs were
  green on the first attempt, so no failure needed diagnosing.

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| e971fb84 | 9.1 | test(e2e): Today lists no-shows - today-past-tours counts three, then seven |
| f128f37e | 9.2 | test(e2e): tour auto-close and reopen - the sweep, the Closed tab, Reopen |
| (this) | records | docs(records): tour auto-close S9 slice report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD checked
absent (`git rev-parse --git-path MERGE_HEAD` - `.git` is a file in a
worktree), the one explicit path staged, ASCII message, `Co-Authored-By:
Claude Opus 5.5` trailer, committed through Bash with a heredoc.

## 2. Per task: what changed, and the evidence

Run form (ruling D-l / drift 7), from the worktree root, in the foreground,
never piped, output redirected to a log and the exit code echoed as the next
statement:

```text
cd "W:/tmp/tour-auto-close"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/<file>.spec.ts > <log> 2>&1; echo "exit=$?"
```

Playwright's result lines are quoted below with `>` where the reporter prints
a U+203A separator, to keep this file ASCII; the summary lines (`N passed
(Xs)`) are verbatim.

No `e2e:session` was live in this worktree, so each run cold-booted lane 7
(app :9701, dashboard :9711, fake-twilio :9721) and tore it down. After each
run the launcher pid in `e2e/.artifacts/session.pid` was gone (`tasklist`)
and nothing listened on 97xx (`netstat`: TIME_WAIT only) before the next run
started. The webServer boot stayed inside its 180 s budget every time.

### Task 9.1 - `today-past-tours.spec.ts` (e971fb84)

Drift corrections 1-2 applied line for line, nothing else changed:

- header (:1-22): Today lists the Past rows, no-shows included (a no-show
  closes on its own two weeks after its last mark, spec 9.4); with every Past
  row shown the link reads "Open the Past tab"; seven qualify at the cap;
- title: "lists past tours with no-shows, ..."; the setup comment: the
  three-days-ago tour is `no_show = "No show"`;
- first visit: `toHaveCount(3)`; hrefs `[notMarked, needsOutcome?outcome=1,
  noShow]` (the no-show has no `?outcome=1`); the "nowhere on Today"
  `a[href^=...noShowId]` count-0 assertion DELETED and replaced by the row
  link `/^Tour for Tasha Nguyen at .* on .*, No show$/` visible; the link
  `'See all 3 on the Past tab'` -> `'Open the Past tab'` (href `/tours/past`);
- 360px, 880px (`cards`, a link count) and back-from-the-tour-page counts
  2 -> 3; the comment "Two cards" -> "Three cards";
- live drop 1 -> 2 (Not marked + No show remain);
- the cap: "make seven that qualify"; expected order
  `[notMarked, noShow, ...older.slice(0, 3)]`; "Seven qualify for Today and
  the Past tab alike; Today shows five."
- unchanged, as the drift said: the heading and "all caught up" count 0, the
  deep link / dialog / back arrow, the live-drop trigger, `'See all 7 on the
  Past tab'` and the seven Past rows, the closing decide-all + Past empty
  state.

Evidence:

- Run 1 (alone, before the commit): `1 passed (22.7s)`, `exit=0`; `ok 1
  [chromium] > tests\dashboard-next\today-past-tours.spec.ts:97:3 > Today -
  past tours needing an outcome > lists past tours with no-shows, ... (3.5s)`.
  Log: `W:\tmp\tour-auto-close\.superpowers\sdd\s9-run-1-today.log`.
- Run 3 (alone again, on the finished tree with Task 9.2's spec present,
  before 9.2's commit): `1 passed (12.5s)`, `exit=0`; `ok 1 ... :97:3 ...
  (3.6s)`. Log: `W:\tmp\tour-auto-close\.superpowers\sdd\s9-run-3-today-again.log`.

### Task 9.2 - `tour-auto-close.spec.ts` (f128f37e)

One `test.describe('Tour auto-close and reopen')`, a file-level `beforeAll`
reseed, an `afterEach` that decides every created tour, every tick scoped by
`tourIds`. Helpers copied from today-past-tours (`NEXT`, `pastAt`,
`devLogin`, the `created` registry, `createTour`, `patchTour`, the quiet
cleanup) plus `tick` (the plan's helper, typed with the full summary),
`daysFromNow`, `getTour`, `phoneOf`, `landlordPhoneOf`, `tourHeader`,
`outcomeCard`.

1. `a tour with no outcome closes on its own two weeks on, and nothing is
   sent` (:172): a tour dated `pastAt(20, 10)`; `tick([id])` ->
   `{ scanned: 1, due: 0, closed: 0 }`; `tick([id], daysFromNow(15))` ->
   `{ scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 }`; GET -> closed,
   `no_outcome`, `autoClosedFrom: 'scheduled'`, `autoClosedAt` a string; the
   Closed tab row (region "Closed tours", `a[href="/tours/<id>"]`) shows
   "Closed" and "No outcome recorded" (exact); the tour page: header badge
   "Closed", the Outcome card's "No outcome recorded" (exact), its `<p>`
   `toHaveText('Closed automatically on <date>')` with `<date>` formatted IN
   THE BROWSER from the API's `autoClosedAt` exactly as `shortDate` does, no
   "Moving forward" in the card, button "Reopen tour" visible; a 2 s settle,
   then `getOutboundTo` since the test start is `[]` for the tenant's and the
   unit landlord's phones.
2. `reopen returns it to Not marked and gives it a fresh two weeks` (:229):
   create + close as in 1 (one tick at +15 days); tour page -> "Reopen tour"
   -> `dialog` "Reopen tour" shows the scheduled copy (exact) -> its "Yes,
   reopen"; no dialog left; badge "Scheduled", CTA "Mark toured"; on the wire
   status scheduled, `outcome` / `autoClosedAt` / `autoClosedFrom` gone,
   `lastMarkedAt >= autoClosedAt`; a 2 s settle, nothing sent to either
   party since the confirm; the Past tab row (region "Past tours", listitem
   filtered by the href) reads "Not marked" (exact); `tick(+1 day)` ->
   `{ scanned: 1, due: 0, closed: 0 }`; `tick(+15 days)` ->
   `{ scanned: 1, due: 1, closed: 1 }`; GET -> closed / `no_outcome` /
   `scheduled` again.
3. `a not-a-fit tour reopens straight into Record outcome` (:287):
   `pastAt(3, 10)` on unit-0002, PATCH toured, PATCH `{ outcome: 'not_a_fit',
   moveForward: false, status: 'closed' }`; tour page badge "Closed" ->
   "Reopen tour" -> the dialog's toured copy (exact) -> "Yes, reopen"; the
   `dialog` "Record outcome" is visible and the Reopen dialog is gone (the
   guarded close); its Cancel -> no dialog; badge "Toured", button "Record
   outcome"; GET -> toured, no outcome.

Cleanup: `decide()` reads the tour and RETURNS for a closed one (drift 4);
otherwise PATCH toured (when not toured) and `{ outcome: 'not_a_fit',
moveForward: false }`. Tests 1 and 2 end closed (skipped); test 3 ends toured
with no outcome and is decided.

Evidence:

- Run 2 (alone): `3 passed (18.4s)`, `exit=0`; `ok 1 ... tour-auto-close.spec.ts:172:3
  ... (3.3s)`, `ok 2 ... :229:3 ... (3.4s)`, `ok 3 ... :287:3 ... (1.2s)`.
  Log: `W:\tmp\tour-auto-close\.superpowers\sdd\s9-run-2-autoclose.log`.
- The same log's app lines show every step landing for the reason the test
  claims (wall clock 2026-10-04T17:32Z): test 1 `dev tour auto-close tick
  ran` now 2026-10-04T17:32:20.714Z scanned 1 due 0 closed 0, then now
  2026-10-19T17:32:20.725Z with `tour closed automatically (no outcome after
  two weeks)` `from: scheduled` and the run summary closed 1; test 2 the
  close at +15 days, `tour reopened via api` `to: scheduled`, a tick at
  2026-10-05T17:32:26.707Z due 0, one at 2026-10-19T17:32:26.712Z closed 1;
  test 3 `tour reopened via api` `to: toured`.
- In all three logs: no `"level":50` line, no `[dynamoAdmin]` line. The only
  WARN lines are the boot notices (in-memory scheduler, in-process jobs) and,
  in run 2, two pre-test "session user no longer exists - session revoked"
  lines from a foreign browser (section 6, item 1).

## 3. Gates run

- `npx eslint e2e/tests/dashboard-next/today-past-tours.spec.ts` after the
  9.1 edits: exit 0 (the drift's base-line lint was exit 0 too).
- `npm run typecheck -w @housingchoice/e2e` before run 2: exit 0
  (`W:\tmp\tour-auto-close\.superpowers\sdd\s9-typecheck-e2e-pre.log`).
- After both tasks, on the finished tree: `npm run typecheck` exit 0 - all
  five workspaces, the e2e one includes `tests/**/*.ts`
  (`W:\tmp\tour-auto-close\.superpowers\sdd\s9-typecheck.log`); `npx eslint
  e2e/tests/dashboard-next/today-past-tours.spec.ts
  e2e/tests/dashboard-next/tour-auto-close.spec.ts` exit 0 with no output
  (`W:\tmp\tour-auto-close\.superpowers\sdd\s9-eslint.log`). No pre-existing
  lint error exists in either file, so there is nothing to attribute.
- ASCII: after each edit the added lines of `git diff -U0 -- <file>` were
  scanned for any byte outside 0x09/0x0A/0x0D/0x20-0x7E - none; both spec
  files are fully ASCII (`tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0)
  and carry no CR.
- NOT run (the orchestrator's later gates): `npm test`, `npm run smoke`, a bare
  `npm run e2e`.

## 4. Divergences from the plan, and why

Binding corrections applied: drift 1 and 2 (the exact 9.1 edit map, including
the deleted negative no-show assertion), 3 (tenant phone from GET
/api/contacts; the landlord's from GET /api/units -> `unit.landlordId` -> GET
/api/contacts), 4 (the copied `decide()` returns early on a closed tour), 5
(outcome text read inside the Outcome card - `section` filtered by the heading
"Outcome" with `exact: true` added to the steps.ts pattern - the header band,
the "Closed tours" region and the "Past tours" region, always with exact text;
the literal `'Closed automatically on'` scoped to the card, never a
`/Closed automatically/` regex), 6 (a 2 s settle before every nothing-sent
read, and test 1's reads come after both page navigations), 7 / D-l (the
single-hop run form only).

Within the plan's latitude - every one additive; no plan assertion dropped:

1. Ticks assert `scanned: 1` beside `due` / `closed`, so a tick that found no
   tour cannot pass a "closed 0" check vacuously; the closing tick also
   asserts `lost: 0, failed: 0`.
2. `phoneOf` asserts an E.164 phone (and `landlordPhoneOf` a non-empty
   `landlordId`): `getOutboundTo` returns `[]` for an unknown number, so an
   undefined phone would have made the nothing-sent reads pass vacuously.
3. Test 1 asserts the WHOLE "Closed automatically on <date>" text, the date
   formatted in the page from the API's `autoClosedAt`, rather than the
   prefix or the S8b report's shape regex; it also checks the row's "Closed"
   badge and the absence of "Moving forward" inside the card (spec 9.2: the
   date line replaces it).
4. Test 2 does only the closing tick before the reopen (test 1 already pins
   the real-time tick). It adds: the "Mark toured" CTA after the reopen; a
   wire check that the close's facts are gone and `lastMarkedAt >=
   autoClosedAt` (server clock against server clock) - the ticks alone cannot
   tell "two weeks from the reopen" from "two weeks from the creation", since
   no client can backdate `createdAt` and both are today; a nothing-sent read
   for the reopen itself (the dialog promises "Nothing is sent"); a final GET
   after the re-close.
5. Test 3 asserts the toured dialog copy, that the Reopen dialog is gone once
   Record outcome is up (the guarded hand-off), and a wire check (toured, no
   outcome). It uses unit-0002 (the plan names unit-0001 as the convention;
   unit-0002 is a listed lean id and gives the spec a second property).
6. `test.slow()` on tests 1 and 2 (two to three ticks, two pages, a 2 s
   settle, possibly the first page loads of a cold lane), each with its
   reason; test 3 runs on the default 60 s.
7. Test titles are the plan's, verbatim.

## 5. Names in the code versus the reports

Every name and text the two specs assert was re-read in the live code; none
differs from the S8b report section 6, the S6-S7 / S5 contracts or the spec:

- `dashboard/src/routes/tours/TourDetail.tsx`: CTAs "Mark toured" :628,
  "Record outcome" :634, "Reopen tour" :641-645 (primary only when nothing is
  above it; kebab item only when `convertible === true`, :713); the header
  `<header>` :681 with "Tour - {address}" :687 and the StatusBadge :688; the
  Outcome card `<Card title="Outcome">` :839, KV Outcome :844, the ONE `<p>`
  "Closed automatically on {shortDate(autoClosedAt)}" :850-852 in place of
  "Moving forward" :855; ReopenTourModal with the guarded close :899-903.
- `dashboard/src/routes/tours/TourModals.tsx`: ReopenTourModal :439-490 -
  title "Reopen tour" :469, "Cancel" :474, "Yes, reopen" / "Reopening..."
  :477, body `REOPEN_BODY[target]` :482; RecordOutcomeModal title "Record
  outcome" :331 with "Cancel" :336. `tourReopen.ts` REOPEN_BODY :23-28 is the
  spec's copy byte for byte. `routes/contact/Modal.tsx` names the dialog by
  its `<h2>` title (:170-184) and renders the "Close" X (:188-196) in place -
  no portal, no inert page behind it.
- `routes/contact/Card.tsx` :18-27: a Card is `<section><h3>{title}</h3>` -
  the Outcome card scoping works because no ancestor `<section>` holds it.
- `dashboard/src/routes/tours/ToursPage.tsx`: row link `aria-label` "Tour for
  <tenant> at <property>" :145, status badge :156, the outcome badge only on
  `closed` with an outcome :160-162; regions "Past tours" :498 and "Closed
  tours" :791; PAGE_INTRO :601-606 as the S8b report quotes.
- `dashboard/src/routes/today/Today.tsx`: row href rule :205, row
  `aria-label` "Tour for <who>, <state>" :208, list `aria-label` :248, link
  text :259; `useTours.ts` pastState "No show" :268.
- `app/src/routes/dev.ts` :457-484: body `{ now?, tourIds? }`, response `{ ok,
  now, scanned, due, closed, lost, failed }` :483 - as S5 section 6.
- `app/src/routes/tours.ts` :1480-1517: POST /:tourId/reopen, 200 `{ tour }`,
  the `tour reopened via api` info line - as S6-S7 section 6.

Only line references moved, no names: the drift file cites the Activity card
row at TourDetail.tsx:877 and the transcript milestones at :243 (pre-S8);
they are now :946 (`describeTourActivity(row)` inside `TourActivityCard`,
rendered at :869) and :254. The plan's `tick` helper types its result as
`{ closed; due }`; the spec types the full five-counter summary the route
returns.

## 6. Observations for the orchestrator (no action taken)

1. Foreign traffic on lane 7. In runs 2 and 3 a browser with a different
   user agent (`Chrome/155.0.0.0`; Playwright's Chromium is 149) made six
   requests to the lane's dashboard port at boot - GET /auth/me x2,
   /__dev/ping x2, /app-identity/config.json and icon-192.png - all BEFORE
   "Running N tests". In run 2 its stale user-0002 cookie produced the two
   WARN "session user no longer exists - session revoked" lines. Most likely
   a tab left open on 127.0.0.1:9711 from an earlier session (cookies are not
   port-scoped on 127.0.0.1, and a Vite client reloads its page when the port
   comes back). Read-only and pre-test, so harmless here; a spec that asserts
   "no WARN" on a lane could trip over it. Not chased.
2. The e2e cannot discriminate the reopen's fresh two weeks by ticks alone
   (item 4 above); the discriminating proofs remain the S1 clock table and
   the S6 route's `lastMarkedAt` cases, plus test 2's wire check.
3. The real worker's auto-close poll never ran during these runs (each app
   process lived about 6-11 s by its own log; the first poll fires 15 minutes
   after boot) - as planned (F12). The full gate-4 run is the first time the
   suite meets that poll; per drift section 2 nothing created during a run is
   due then.
4. What this spec leaves behind in a full run: two closed `no_outcome` tours
   (tests 1-2) and one toured + not-a-fit tour (test 3) - none on Past or
   Today. Next in path order: tour-comms-pane (no reseed; mints its own
   entities), then tours-page (reseeds).
5. today-past-tours' own `decide()` still lacks the closed early-return - not
   needed (none of its tours closes), left as is to keep the 9.1 diff to the
   edit map.
6. Lane 7's `hc-local-7-*` tables stay in the shared DynamoDB Local container
   as every lane's do (created by run 1, reseeded by runs 2-3). The containers
   were never restarted, stopped or touched.
7. Sub-threshold, considered and judged safe: `pastAt()` is local-calendar
   based (as in the precedents) while `daysFromNow()` is millisecond based
   like the sweep's `AUTO_CLOSE_AFTER_MS`, so a DST change inside the 15-day
   window cannot flip a tick (one day of margin each side); the "Closed
   automatically on" date is formatted by the browser from the same instant
   the page uses, so midnight or the machine's time zone cannot split them.

Nothing in S9 is left undone. S10 (docs) and S11 (main sync, the five gates,
self-QA, handback) are the orchestrator's.
