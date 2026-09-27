# Research findings - E2E slice (plan Tasks 5 and 9, e2e parts of Task 10), live-tree drift check

Date: 2026-09-27

Scope: plan Task 5 (`tenant-staff-notes.spec.ts` and the `contact-detail.spec.ts`
locator scoping), Task 9 (`tours-past.spec.ts`) and the e2e parts of Task 10 (gate 4,
the orphan recipe, the lane note), against the live tree of `feat/staff-notes-past-tours`
(`W:\tmp\staff-notes-past-tours`, head `123e50fb`, code identical to main @0dafe3c1).
Also adjudicates the two sibling items that touch this slice (dashboard-part1 R-1,
dashboard-part2 R-1). The first reader of this slice died after writing its reference
file; this file replaces the findings it never wrote.

Method: read-only (Read/Grep/Glob, read-only git). Three evidence runs outside the tree,
none a test run and none a server: two static headless-Chromium layout probes (the
installed Playwright 1.61.0 bundled Chromium 149.0.7827.55, `page.setContent`, no port,
scripts in the session scratchpad) and one import of `e2e/support/lane.mjs` calling only
its pure `hashToLane` / `portsForLane` (no lease reserved). Byte-exact quotations:
`.superpowers/sdd/research-e2e-reference.md` - sections A-M from the first reader (every
anchor used below was re-read in the live tree, see "Reference file audit"), section N
added by this reader.

Verdict: the Task 5 and Task 9 specs are sound against the tree and against the planned
DOM of Tasks 3, 7 and 8. Every import, exported name, seed id, API shape, route,
aria-label and dialog name they use exists, or is created by an earlier task exactly as
the specs expect. The only existing locators the new DOM breaks are the two
`contact-detail.spec.ts` sites Task 5 already scopes, and no spec that runs after either
new file can inherit misleading state. No new BLOCKING item. Three SHOULD-FIX items, all
about how the orchestrator will RUN the e2e rather than the spec logic: the Task 10
orphan recipe misses the Playwright runner that survives `timeout` on this host (E-1),
Task 9 Step 2's `e2e:restart` fallback always fails the preflight (E-2), and the single
Past-tab test is a ten-stage flow on the default 60s cap on a night of concurrent e2e
(E-3). Sibling items: dashboard-part1 R-1 is CONFIRMED by a layout probe;
dashboard-part2 R-1 is CONFIRMED and its option (a) is COMPLETE.

Counts: BLOCKING 0 new (dashboard-part2 R-1 remains the slice's one BLOCKING);
SHOULD-FIX 3 new (plus dashboard-part1 R-1 confirmed); NOTE 5.

## Sibling items adjudicated

### dashboard-part1 R-1 (Task 5 360px check) - CONFIRMED, SHOULD-FIX stands

- Tree: the file cards render inside `.right` (`dashboard/src/routes/contact/ContactDetail.tsx:983-986`,
  composed at `ContactDetail.module.css:186-187`), which is `overflow: auto`
  (`dashboard/src/ui/twoPaneShell.module.css:66-69`) - a scroll container nested inside
  the routed `<main class=content>` (`dashboard/src/app/AppFrame.tsx:194`,
  `AppFrame.module.css:383-387`). `expectNoHorizontalOverflow` measures only the
  document and the first `<main>` (`e2e/support/viewport.ts:73-86`).
- Evidence (probe, reference N.13): the same nesting at 360px with a 500px-wide
  textarea inside a card gives document overflow 0, `<main>` overflow 0, `.right`
  overflow 183, card overflow 208. The plan's page-level call (plan line 1244) passes on
  a broken editor, so spec 4.8's check is vacuous for the card it names.
- Locator for `expectNoHorizontalOverflowIn`: `staffCard` itself, the Card root
  `<section>` (`dashboard/src/routes/contact/Card.tsx:20`). Its `.card` rule
  (`Card.module.css:4-9`) sets no overflow, so its scrollWidth includes every
  descendant's overflow (`e2e/support/viewport.ts:93-97`). It is sufficient because
  `.rightInner` is a flex column (`twoPaneShell.module.css:80-83`) that stretches the
  card to the pane width: the editor can only widen the pane by overflowing the card.
  `.right` itself has no accessible handle (CSS-module class), so it is not a good
  locator. Call it after the textarea is visible at 360px and before Cancel; keep the
  page-level call; add `expectNoHorizontalOverflowIn` to the viewport import.

### dashboard-part2 R-1 (`routes.test.ts` vs `tours/past`) - CONFIRMED; option (a) is COMPLETE

- Mechanics confirmed: `e2e/performance/routes.test.ts:347-388` reads
  `dashboard/src/App.tsx` (`:348`), collects every `<Route ... path="...">` (`:361`),
  prefixes `/`, drops its local `excluded` set (`:375-382`) and requires equality with
  `EXPECTED_KEYS` (`:29-38`, which has `/tours` and `/tours/closed` only) minus the
  inbox keys plus `/inbox` (`:383-384`). The planned `<Route path="tours/past" .../>`
  (plan Task 7 step 8) adds an unmatched `/tours/past`. The suite runs in gate 2
  (`package.json:39`, `e2e/package.json:9`, `e2e/vitest.config.ts:8`).
- Option (a), adding `'/tours/past'` to `excluded`, is complete. Every suite under
  `e2e/performance/` and `e2e/support/` that reads files was checked:
  - `routes.test.ts` is the ONLY reader of `App.tsx` (plus `app/nav.ts` at `:349`, whose
    targets must sit in `IMPLEMENTED`; the plan touches neither). Its other tests pin
    the profiler's `ROUTES`, not App.tsx, and the citation check (`:420`) is format-only.
  - `mutationCatalog.test.ts` scans ONLY non-test `.ts`/`.tsx` under `dashboard/src`
    (`:19-21`; `sourceFilesUnder` `:29-42` skips `__tests__` and `*.test|spec.*`;
    `scanDashboard` `:310-312`), and inside those only direct calls to `request` /
    `requestWithStatus` imported from `dashboard/src/api/client.ts` (`:68-84`), bare
    `fetch`, and `XMLHttpRequest#open` (`:277-289`). The new specs live outside
    `dashboard/src`, and `page.request.post/patch` is a property call the visitor never
    matches. The branch's dashboard code adds no transport call (StaffNotesCard uses
    `updateContact`; the Past view uses `getTour`, `patchTour`, `getTours`), so the 108
    pin (`:373`) and the fingerprint equality (`:376`) hold.
  - `support/viewport.guard.test.ts` scans every `.ts/.tsx/.mjs` under `e2e/`
    (`:42-53`) for the literal `documentElement.scrollWidth` (`:62`); the new specs only
    call the helpers.
  - `performance/config.test.ts` reads only the README's "Profiler CLI reference"
    section (`:349-352`). No suite inventories `e2e/tests/`.
  - No dashboard test pins App routes: `tours/closed` occurs only in App.tsx,
    ToursPage.tsx/.module.css/.test.tsx, `e2e/performance/routes.ts`/`.test.ts` and
    `tours-page.spec.ts`.

## Findings

### E-1 [SHOULD-FIX] Task 10 orphan recipe: after `timeout` exits 124, this worktree's Playwright runner keeps running

- Where: plan Task 10 Step 2, the recipe under "If `timeout` fires (exit 124)" (plan
  lines 3101-3117).
- Tree facts:
  - Git Bash resolves `npm` to the shim `C:\Program Files\nodejs\npm`, whose last line
    starts node WITHOUT `exec` (reference N.18); the root `e2e` script is a second npm
    hop (`package.json:41`) that runs `playwright test` (`e2e/package.json:7`) through
    cmd. GNU `timeout` (`/usr/bin/timeout`, coreutils 8.32) signals its own MSYS child
    and process group; the native grandchildren (inner npm, the Playwright runner, its
    test worker and Chromium, the webServer launcher) are outside it. This host showed
    exactly that on 2026-09-26 (a stopped gate script left an orphaned Playwright tree
    driving a full lane, retry-send-window planner review).
  - The launcher's parent-death watch (`scripts/e2e-session.mjs:766-770`) cannot fire
    while the runner lives (the runner spawns it, `e2e/playwright.config.ts:189`).
  - `npm run e2e:stop` kills the launcher tree and reaps the four lane ports
    (`scripts/e2e-stop.mjs:60-82`); nothing in it, and nothing in the recipe's port
    check (step 3), touches the runner, which holds no lane port.
- Failure scenario: after exit 124 the suite keeps running in the background and keeps
  appending to the gate-4 log, so the "partial report" the recipe reads is still
  growing. Step 2 kills the stack under it; the runner then fast-fails its remaining
  specs and rewrites `e2e/.artifacts/results.json` and the HTML report. If step 4's
  isolate run starts before the runner exits, it lands on the SAME lane (the
  hash-preferred lane 13, whose lease `e2e-stop.mjs:132-140` just released), and the
  orphan's remaining specs (same URLs in its env, `playwright.config.ts:86-91`) drive the
  new stack: reseeds, contact mutations and fake traffic land inside the isolate run,
  which then fails, or passes, for the wrong reason.
- Correction: insert between recipe steps 1 and 2: list this worktree's processes
  (PowerShell `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*staff-notes-past-tours*' }`);
  `taskkill /PID <pid> /T /F` from the TOP of each surviving tree - the Playwright
  runner (`...\node_modules\@playwright\test\cli.js test` or `...\node_modules\playwright\cli.js`)
  and, if it survives separately, the `scripts/e2e-session.mjs` launcher; re-list until
  empty; only then `npm run e2e:stop` and the port check. (`e2e:stop` may then report
  "no running session found" and skip its table drop, `e2e-stop.mjs:36-51`; harmless -
  the next session's clean-slate reseed and the pid-liveness lease reclaim cover it.)
  Two precisions for step 3's rule "kill ONLY a PID whose command line names this
  worktree":
  - The app, worker and fake-twilio are spawned with RELATIVE entry paths
    (`e2e-session.mjs:407`, `:410`, `:471`, e.g. `node --import tsx app\src\index.ts`,
    cwd = the worktree), so their command lines never name the worktree and are
    identical to voicemail-greeting's. Never hand-kill one. Only Vite (absolute
    `viteBin`, `:37`, `:448`) and the runner are attributable by command line.
  - The port that matters is the DASHBOARD port: `reuseExistingServer` adopts whatever
    answers there (`playwright.config.ts:202-203`), and then no launcher runs to reap
    anything. With Vite gone, a surviving app or fake listener on this lane is reaped by
    the next launcher that holds lane 13's lease (`e2e-session.mjs:425-434`, `:684`) -
    provided the next run lands on lane 13, i.e. never run `lane.mjs` or set `E2E_LANE`
    by hand (the plan's step-1 warning holds, see "Checked and holding").

### E-2 [SHOULD-FIX] Task 9 Step 2's `e2e:restart` fallback always fails the preflight

- Where: plan Task 9 Step 2 (plan lines 3046-3048), "if a session from Task 5 is still
  up, run `npm run e2e:restart` after the Part 2 dashboard changes instead".
- Tree facts: the launcher computes the commit ONCE at start
  (`scripts/e2e-session.mjs:102-104`) and stamps it into the shared child env (`:109`,
  `:243-244`, `E2E_APP_COMMIT` and `VITE_E2E_COMMIT`); `restartBackend` re-spawns app,
  worker and fake-twilio with that same env and leaves Vite untouched (`:599-615`). Every
  Playwright run's globalSetup compares both stamps with `git rev-parse --short HEAD` and
  THROWS on a present-but-different stamp (`e2e/support/preflight.ts:96-129`).
- Failure scenario: a Task 5 session booted at Task 4's commit; Tasks 5, 6, 7 and 8 each
  commit, so by Task 9 HEAD differs from both stamps and
  `npm run e2e -w @housingchoice/e2e -- --grep "Past tab"` dies in globalSetup ("a STALE
  server is being reused") before any test runs. A restart cannot refresh either stamp.
- Correction: replace the fallback with "`npm run e2e:stop`, then a fresh
  `npm run e2e:session`". Same rule for any re-run after a fix COMMIT during Task 5 or 9:
  uncommitted edits keep the stamps valid, a commit invalidates them.

### E-3 [SHOULD-FIX] The Past-tab test is one ten-stage flow on the default 60s cap

- Where: plan Task 9 Step 1, the single `test(...)` (plan lines 2930-3031).
- Tree facts: the per-test cap is 60s (`e2e/playwright.config.ts:115`, `:121`), sized on
  tests whose p95 was 14.0s and worst 20.2s at idle, and stated to hold through 3x for
  THOSE tests (`:104-114`). Longer flows in this suite opt out: `test.slow()` triples
  the budget (`e2e/tests/dashboard-next/contacts-list-facets.spec.ts:41`,
  `deleted-contact-resurfacing.spec.ts:71` "eight stages ... triple the budget") or
  `test.setTimeout` (`contact-create-relay-group.spec.ts:368`). This test does
  dev-login, 3 POSTs and 2 PATCHes, four full page loads (`/tours`, the tour page twice,
  `/tours/past`), four client navigations, a re-read + PATCH + reload batch, a fixed 2s
  settle, a GET and a viewport change.
- Failure scenario: at the ~2x load the config documents for this box, with another
  mission's e2e on the machine tonight, the test nears or passes 60s and fails on the cap
  mid-flow in gate 4 - a 45-minute gate re-run and a timing misdiagnosis of a correct
  feature.
- Correction: make `test.slow();` the first line of the test body (repo idiom).
  `tenant-staff-notes.spec.ts` (one page, one reload) does not need it.

### E-4 [NOTE] No-send proof: the global delta is valid; narrowing it is cheap insurance

- Where: plan Task 9 `outboundCount` and its two calls (plan lines 2899-2903, 2983,
  2991-2994); spec 4.7.
- Tree facts: the fake's thread store survives reseeds
  (`e2e/tests/dashboard-next/outbound-mms.spec.ts:1178-1181`) and may not be reset
  mid-suite (`e2e/fixtures/fakeTwilio.ts:381-386`: "Scope assertions with
  getOutboundTo's `since` instead"). The plan takes a DELTA, never an absolute count -
  correct. Its scope is every party, so a late send from an earlier spec's async
  backlog (the class `thread-history-paging.spec.ts:170-173` guards against) landing
  inside the ~3s window would fail this spec. The suite's no-send idiom is a per-party
  delta (`e2e/tests/tour-no-show-checkin.spec.ts:106`). The sources of such late sends
  just before tours-past are small (see "Order and leakage"), hence NOTE.
- Correction (optional): capture `const since = new Date().toISOString();` immediately
  before the bulk click and, after the settle, assert that
  `getOutboundTo(page.request, { to: '+15550100001', since })` (Tasha,
  `app/src/lib/seed/lean.ts:102`) and `{ to: '+15550100002', since }` (Marcus Bell, the
  landlord of both units, `lean.ts:139`) are both empty (`fakeTwilio.ts:201-211`). Keep
  the 2s settle. As written, `outboundCount` compiles: `messages[].direction` exists
  (`fakeTwilio.ts:167-169`, `:185-188`).

### E-5 [NOTE] Tours 360px: the page-level check is real there; an element check is optional

- Where: plan Task 9, last block (plan lines 3025-3030); spec 4.8.
- Tree facts: nothing between the rows and `<main>` is a scroll container: `.page` sets
  only `container-type: inline-size` (`dashboard/src/routes/tours/ToursPage.module.css:4-11`),
  `.section` only a margin (`:69-71`), `.rows` / `.rowItem` only list resets and a margin
  (`:98-106`), and the planned `.pastRow`, `.rowActions`, `.toolbar` set no overflow
  (plan lines 2062-2071, 2081-2086, 2143-2150). The one open question - whether the
  layout containment implied by `container-type` keeps overflow from reaching `<main>` -
  is settled by the probe (reference N.13): with and without `container-type:
  inline-size` on the wrapper, a 600px row at 360px gives `<main>` overflow 264 in
  Chromium 149. So `expectNoHorizontalOverflow(page, ...)` CAN fail on the Tours page,
  unlike on the contact page.
- Correction (optional, for a sharper failure message): also call
  `expectNoHorizontalOverflowIn(region, 'Past tours region at 360px')`. `region` is the
  `<section aria-label="Past tours">` (plan line 2487), overflow-visible via `.section`,
  and it holds both the toolbar and the list; the list named "Past tours list" (plan line
  2543) would miss the toolbar.

### E-6 [NOTE] Concurrent e2e with `W:\tmp\voicemail-greeting` tonight

- Lanes are arbitrated machine-wide by lease files in `%TEMP%\hc-e2e-lanes`
  (`e2e/support/laneLease.mjs:39`); the resolver walks from the hash-preferred lane and
  skips any lane with a live owner (`e2e/support/lane.mjs:384-392`). Preferred lanes from
  the pure `hashToLane`: this worktree 13 (ports 10301/10311/10321/10331),
  voicemail-greeting 15 (10501/10511/10521/10531). No collision; do not set `E2E_LANE`.
  The lease files present now (lanes 3, 6, 7, 16; relay-gate-refusal-warn,
  retry-send-window twice, inbox-rows-timestamps) touch neither lane.
- Shared single-instance containers: DynamoDB Local :8000 and MinIO :9000
  (`e2e/README.md:499-506`). If either may be cold, warm both first (`npm run db:start`,
  `npm run s3:start`, idempotent) to avoid the simultaneous cold `docker run` race; never
  `db:stop` / `s3:stop` or restart Docker while the other run is live.
- DynamoDB Local gives each lane its own database via its access key
  (`e2e/README.md:471-477`), so there is no cross-lane write lock; the cost is CPU (the
  ~2x of E-3). This worktree's `e2e:stop` drops only its own lane's tables
  (`e2e-stop.mjs:101-126`) and releases only its own lease, by token (`:132-140`).
  Gate 2 (`npm test`) running beside the other e2e is AGENTS.md's environmental
  contention case: re-run-and-compare by FILE; any `[dynamoAdmin]` line is a real
  sighting.
- Run gate 4 from the Bash tool. `timeout` there is GNU coreutils; in PowerShell it is
  Windows `timeout.exe` (a pause command), so the plan's line would cap nothing.
- The 2700s cap covers ~2x (17.9m idle x 1.96 = ~35m, `playwright.config.ts:104-106`);
  the recipe's single 3600s re-run covers a slower night.

### E-7 [NOTE] The `--grep` path: the plan's forms are right; the README line is the trap

- Tree: the root `e2e` script is `npm run e2e -w @housingchoice/e2e` (`package.json:41`)
  and the workspace script is `playwright test` (`e2e/package.json:7`). Root
  `npm run e2e -- --grep X` appends `--grep X` to the INNER npm command, which parses it
  as an npm config and drops it, so the FULL suite runs. That is the form
  `e2e/README.md:55` documents ("run a subset against the live session"). Positional file
  filters do survive the double hop (npm hands positional args to the script;
  `e2e/README.md:68` uses one).
- Working forms. From `W:\tmp\staff-notes-past-tours`:
  `npm run e2e -w @housingchoice/e2e -- --grep "<regex>"` (plan Task 5 Step 3, Task 9
  Step 2, Task 10 step 4 - correct) or, for one FILE,
  `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/tours-past.spec.ts`. From
  `W:\tmp\staff-notes-past-tours\e2e`: `npm run e2e -- --grep "<regex>"` or
  `npm run e2e -- tests/dashboard-next/<file>.spec.ts`.
- Playwright compiles the grep with flags `gi`
  (`node_modules/playwright/lib/util.js:177-182`), matches it against the describe path
  plus the title (`node_modules/playwright/lib/common/index.js:2845-2849`) and resets
  `lastIndex` per test (`util.js:156-166`). "Staff notes card", "Past tab" and "editing
  a contact PATCHes" each select exactly one test after the branch (today only
  `contact-detail.spec.ts:49` matches any of them). The `|` in Task 5's grep survives
  npm's cmd escaping (caret-escaped, doubled for a `.cmd` shim, reference N.19) - read
  from npm's source, not executed.
- Correction: none to the plan. Do not follow README:55 from the root (pre-existing doc
  bug, out of this branch's scope).

### E-8 [NOTE] Cosmetic drift and one house-style point in the plan's e2e text

- Plan lines 3036-3037 point at `e2e/fixtures/fakeTwilio.ts` "around line 340-375" and
  "line 207-209": the types are at `:167-188`, `getOutboundTo` at `:201-211` (filter
  `:208-210`), `listThreads` at `:375-379`. Field names match; no code change.
- Plan line 3098 cites `playwright.config.ts:105-109`; the passage is `:104-114`.
- Both new specs copy `process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174'`
  (plan lines 1181, 2886), the human's live dashboard port. Unreachable under
  `npm run e2e` (the config sets the variable at load in every worker,
  `playwright.config.ts:88`) and identical to 57 existing spec files, so house style, not
  a defect; a fail-loud read (`e2e/tests/tour-no-show-checkin.spec.ts:51-55`) would make
  a stray invocation fail instead of reseeding the live stack. Optional.

## Collision sweep (existing locators vs the new DOM)

Name matching is a case-insensitive substring unless `exact: true` or an anchored regex.

Staff notes DOM (tenant file: heading "Staff notes" with the CardAction aria-label "Add
staff notes" / "Edit staff notes" inside the `<h3>`; in edit mode a textarea labeled
"Staff notes", Save, Cancel):

- `contact-detail.spec.ts:59` `page.getByLabel('Notes')` with the Edit dialog open -
  BREAKS: `getByLabel` also matches an `aria-label` by substring (corroborated by
  `e2e/support/selectors.md:24`), and the Modal leaves the page's controls exposed
  (dashboard-part2 "Checked and holding", Task 8), so it resolves to the dialog's Notes
  field AND the "Add staff notes" button - a strict-mode violation on `.fill`. Needs
  scoping: Task 5 Step 1 does it.
- `contact-detail.spec.ts:73` - same, BREAKS; scoped by Task 5 Step 1.
- `contact-detail.spec.ts:58` (dialog assertion) - safe; Task 5 reuses it as the scope.
- `contact-detail.spec.ts:25, :52, :141, :182, :204` heading 'Details'; `:57, :72, :90,
  :105` button 'Edit contact details'; `:61, :74, :96, :111` button 'Save' exact; `:40`
  button /Call/i; `:170` button 'Add email' - safe (no new name contains these; the
  editor is closed in these tests).
- `contact-detail.spec.ts:123-124` heading 'Notes' / 'Preferences & notes' - LANDLORD
  page; the card is tenant-only - safe.
- `e2e/scenarios/steps.ts:1097-1099`, `:1453` `dialog.getByLabel('Notes')` - dialog-scoped - safe.
- `steps.ts:1117-1119` section filtered by heading 'Preferences & notes' - safe.
- `listing-activity.spec.ts:272`, `:279`; `listing-photos.spec.ts:87`, `:293` - property
  page - safe.
- `matching-entry-points.spec.ts:185` heading /Properties sent/ - safe.
- No spec uses a page-wide non-exact button 'Add' / 'Edit', `getByText('+ Add' | 'Edit')`,
  a heading count, or a section count on a tenant page.

Past tab DOM (`/tours/past`; tabs Active | Past | Closed; row checkbox, "Tour for ... on
...", "Mark toured: ...", "Record outcome: ..."; toolbar "Mark toured (N)", "Select all not
marked"):

- `steps.ts:2275` button 'Mark toured' (unanchored), `:2314` (exact), `:2528` 'Record
  outcome'; `relay-number-lifecycle.spec.ts:288` 'Record outcome' - all on the TOUR page
  after a plain navigation (`steps.ts:2274`, `:2305`, `:2527`; the relay spec after
  `teamMarksToured`) - safe: the new controls exist only on `/tours/past`, and Task 8
  adds none to the tour page (it acts only on `?outcome=1`).
- `tours-page.spec.ts:172-174, :250-252, :288-290` regex 'Tour for Tasha Nguyen at
  .*Joseph E\. Boone' - scoped to the Active regions - safe (it would also match a Past
  label, but Past rows never render on `/tours`).
- `tours-page.spec.ts:427-431, :438, :450` tabs by NAME ('Active', 'Closed') inside the
  'Tours view' nav - safe ("Past" contains neither). No spec locates or counts the tabs
  by position.
- `tours-page.spec.ts:167, :246, :423` heading 'Tours' on `/tours` - safe (the Active h1
  stays "Tours"; "Past tours" never co-renders). `:432, :441, :452` region 'Closed tours'
  and `:440` heading 'Closed tours' - safe.
- `roster-paging.spec.ts:153-154` `/tours` + button /New tour/i - safe ("+ New tour"
  stays Active-only).
- No other spec visits `/tours` or `/tours/past`, or reads 'Back to tours'.

## Order and leakage

- Rule: Playwright 1.61 collects files depth-first with each directory's entries sorted
  by `name.localeCompare` (`node_modules/playwright/lib/runner/index.js:2213`) and never
  re-sorts; with `fullyParallel: false` and `workers: 1`
  (`e2e/playwright.config.ts:140-141`) files run in that order, tests in declaration
  order.
- Simulated order with the two new files (86 spec files, reference N.1): 8
  contact-detail ... 54 share-skip-fix, 55 **tenant-staff-notes**, 56
  thread-history-paging, 57 tour-comms-pane, 58 tours-page, 59 **tours-past**, 60
  unknown-caller-triage, 61 upcoming-in-stream ...
- tenant-staff-notes reseeds in `beforeAll` (one test, so the same as `beforeEach`). It
  leaves Tasha with `staff_notes: ''` and a kept `staff_notes_updated_at` (by design),
  which the card hides. On a mid-test failure it leaves the marker text and the "Edit
  staff notes" aside. The next two files do not reseed (thread-history-paging builds its
  own rows, `:20-23`; tour-comms-pane mints its own tour, `:32`) and neither reads the
  tenant file with a notes-sensitive locator; tours-page reseeds in `beforeAll`
  (`tours-page.spec.ts:53-56`). contact-detail (8) runs long before, so the one
  notes-sensitive spec never sees this state in the same run.
- tours-past reseeds in `beforeAll` (wiping tours-page's tours). It leaves three
  past-dated tours on Tasha (two toured without outcome, one no-show), their milestones
  ("Tour scheduled", "Tour took place", "Tour no-show") and the arm's skipped reminder
  rows. unknown-caller-triage reseeds in `beforeEach` (`:34-36`) before its first test,
  so no later spec sees any of it.
- Nothing sends: POST awaits the arm inline (`app/src/routes/tours.ts:346-351`), which
  for a past date writes one visible skipped `booked_too_late` row and drops the past
  rungs (`app/src/jobs/tourReminders.ts:571-590`); a PATCH to toured / no_show is
  terminal for the ladder (`tours.ts:1354-1357`) and the handler has no send or enqueue
  (its only relay action arms a close-nag on cancel / not-a-fit, `tours.ts:1453-1458`).
- Where the milestone or the skipped row could show: tours-past never visits Today or
  Tasha's file after creating tours; on the tour page it reads only the dialog 'Record
  outcome', its Cancel, any dialog, the link 'Back to tours' and the button 'Record
  outcome'. The Reminders and Activity cards render text only, and "Record outcome"
  occurs in `dashboard/src` only at `TourDetail.tsx:556` and as the modal title
  (`TourModals.tsx:311`). Safe.

## Reference file audit

- Every A-M quotation this report relies on was re-read in the live tree and matches:
  contact-detail, today, viewport, urls, fakeTwilio, playwright.config, the package
  scripts, preflight, laneLease, the lean seed, the tours route and reminder arm, reseed
  and dev routes, Login, ToursPage (.tsx and .css), ContactDetail, twoPaneShell, Card,
  TenantFile, TourDetail, TourModals, App routes, routes.test / routes.ts, tsconfig and
  eslint.
- One disagreement: section L's closing count ("The `?? 'http://127.0.0.1:5174'`
  fallback appears in 58 spec files") - the exact line appears in 57 files under
  `e2e/tests`; 59 files mention `127.0.0.1:5174` at all.
- Section K's `mutationCatalog.test.ts:281` note is right but incomplete: the scan root
  is `dashboard/src` only (N.4); it never reads `e2e/`.

## Checked and holding (no action)

- Task 5 Step 1: `contact-detail.spec.ts:58` (dialog assertion), `:59` and `:73` (the two
  page-wide `getByLabel('Notes')`), `:72` (the Edit click); the replacement declares one
  `const dialog` in a test scope that has none. Per-spec `devLogin` shape `:14-18`;
  dev-login button "Continue as dev user (seeded VA)" (`dashboard/src/routes/Login.tsx:89`).
- Helpers: `expectTodayReady` (`e2e/support/today.ts:43-47`); `NARROW_360`
  (`viewport.ts:23`), `WIDE_RESTORE` (`:33`), `expectNoHorizontalOverflow` (`:73-86`),
  `expectNoHorizontalOverflowIn` (`:107-113`); `urls.ts:20`, `:23-24`. The
  `fixtures/reseed.ts:3-6` relative URL (against `baseURL` = the dashboard,
  `playwright.config.ts:153`) and the specs' `${NEXT}/__dev/reseed` both reach the app
  through Vite's `/__dev` proxy (`dashboard/vite.config.ts:97`).
- Fake Twilio: `listThreads` (`fakeTwilio.ts:375-379`) accepts `page.request`
  (precedents `settings.spec.ts:122`, `thread-history-paging.spec.ts:183`); there is no
  `resetFake` (`:381-386`).
- Lean seed: `contact-tenant-0001` (`lean.ts:40`) Tasha Nguyen `+15550100001` (`:102`,
  `:115-116`) with no `notes` (only `preferences_notes`, `:121`), so the Preferences card
  renders its static PendingPanel (`TenantFile.tsx:259-262`) and its innerText is stable
  across the save and the reload; landlord Marcus Bell `+15550100002` (`:139`,
  `:143-144`); `unit-0001` / `unit-0002` (`:44`) addresses (`:223`, `:246`); no tours.
  The specs assert ids and anchored regexes only, never these names or addresses.
- Tours API: POST allowlist (`tours.ts:142`); a past `scheduledAt` is accepted (validity
  only, `:318-322`) and canonicalized (`:340`); no tenant/unit existence or duplicate
  check; `201 { tour }` (`:386`). PATCH allowlist (`:145`); guards (`:1076`, `:1082`,
  `:1089-1094`, `:1112`) allow scheduled -> toured and scheduled -> no_show; `outcome` is
  written only when sent (`:1172`), so the wire tour has no `outcome` key and
  `toBeUndefined()` holds; `GET /:tourId` returns `{ tour }` (`:432-439`). `page.request`
  carries the dev-login cookie (`tours-page.spec.ts:308-309`, `:392`); `res.text()` then
  `res.json()` on one response has precedent (`:400-401`).
- Active tab: both regions render unconditionally, with empty states, once loaded
  (`ToursPage.tsx:284-336`), so waiting for 'Upcoming tours' and 'Needs booking' before
  the negative `a[href]` counts is sound in the tour-free lean world; h1 'Tours'
  (`:250`), 'Tours view' nav (`:263`).
- Planned DOM the Task 9 spec locates (plan Tasks 6-8): h1 'Past tours' and an intro
  starting 'Last 90 days:' (plan lines 2213, 2219); tabs with `aria-current` (2605-2615);
  region 'Past tours' (2487); rows are `<li>` with no nested list (2274-2339), so the
  count of 3 is exact; the checkbox, link, button and link names end with the date-time
  (2283, 2290, 2310, 2320); one `role="status"` per row, only after a batch (2330); bulk
  button text 'Mark toured (N)' with no aria-label (2533-2541); the Past hook stays
  'idle' (spinner) until its first result (plan Task 6), so no empty-state flash; the
  plain link's `href` is exactly `/tours/<id>` (the Record-outcome link carries
  `?outcome=1`), so the `a[href=...]` filter picks one link per row. Tour page: back
  link 'Back to tours' (`TourDetail.tsx:595`, kept by Task 8), CTA 'Record outcome' on a
  toured tour without outcome (`:553-558`), dialog 'Record outcome'
  (`TourModals.tsx:311`) whose Cancel (`:315-317`) is the page's only Cancel.
- Tenant-file DOM: the Card root is a `<section>` with the aside INSIDE the `<h3>`
  (`Card.tsx:18-28`); `CardAction` spreads `label` into `aria-label` (`Card.tsx:47`); no
  other `<section>` wraps the file pane (`<section>` occurs only at `Card.tsx:20` and
  `Timeline.tsx:2567`, `:2659` in the contact tree, none in `dashboard/src/app`); the
  'View' group and its 'Profile' button (`ContactDetail.tsx:945-962`; precedent
  `composer-mobile.spec.ts:54-56`); the profile pane is `display: none` below 860px
  (`twoPaneShell.module.css:128`, `:168-169`). Playwright's accessible name reads DOM
  text, not `text-transform` (text nodes contribute `textContent`, reference N.20), so
  the case-sensitive `/Staff notes/` and `/Preferences & notes/` regexes match the
  uppercase-styled Card headings. Planned card copy: 'Add staff notes' / 'Edit staff
  notes' (plan line 887), sibling `<label>` 'Staff notes' (913-915), 'Save' / 'Cancel'
  (932-937), 'No staff notes yet.' (942), 'Last edited <Mon D, YYYY>' (en-US
  `toLocaleDateString`, 831, 944), which the spec's regex matches.
- Types and lint: `e2e/tsconfig.json:8` includes `tests/**/*.ts` (gate 1, `strict`,
  `noUncheckedIndexedAccess`); every import in both specs resolves to an existing
  export; no unused binding; the lint config has no Playwright plugin
  (`eslint.config.mjs:15-16`), so `waitForTimeout` is not flagged; the new files are in
  gate 5's `main...HEAD` list.
- Task 10 lane note: running `node e2e/support/lane.mjs` reserves a lease
  (`lane.mjs:386-388`) honored for 240s (`laneLease.mjs:51`), so the warning holds.
  Recipe step 1 before step 2 is right: `e2e:stop` deletes `lane.json` on both paths
  (`e2e-stop.mjs:48`, `:147`) and reaps ports only when the launcher is alive or the app
  confirms ownership (`:36-51`, `scripts/lib/sessionState.mjs:46-54`).
- ASCII: the plan's spec code is ASCII; `contact-detail.spec.ts` already carries
  non-ASCII (its header comment and describe title among others), so Task 5 Step 4's
  added-lines check is the right one.

## Unverified

- E-1's mechanism is inferred from the npm shim, GNU `timeout`'s process-group
  signalling and the 2026-09-26 observation on this host; not reproduced (no runs).
- E-3's duration is an estimate from the stage count, not a measurement.
- E-7's `|` survival through npm's cmd escaping is read from source, not executed.
