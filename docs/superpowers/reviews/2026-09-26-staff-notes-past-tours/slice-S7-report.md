# Slice S7 report - e2e Part 2: the Past tab end to end (plan Task 9)

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `1019f2cd` (the perf-pages-tours-past-surface issue commit, right
after the S6 report `57cac656`)
Implementer: S7 child, Claude Opus 5.5 (1M context)
Status: DONE - one test commit. The spec was green on its first run (run 1)
and on the committed bytes (run 4); the Part 1 pair plus this spec were green
together (run 5, "3 passed"); two temporary control runs showed the no-send,
anchoring, back-pointer and overflow assertions can fail when they should; root
typecheck exit 0 after the commit; the session this child started is stopped
and its four lane ports are proven free. There was no red run, and neither the
dashboard nor the app misbehaved.

Byte-exact quotations behind every quoted line below (run logs, ping, lane
record, request trail, arm/sweep log lines, stop output, commit and typecheck
output, and the diff between the run-1 bytes and the final bytes) are in the
ignored run state `.superpowers/sdd/slice-S7-reference.md`. The raw logs are in
`.superpowers/sdd/logs/s7-*.log` and the screenshots named below in
`.superpowers/sdd/s7-shots/`.

## Commits

- `46305bf8` test(e2e): Past tab - past tours listed with states, bulk Mark
  toured, Record outcome deep link, no send, back arrow, 360px (spec 5). This
  is the plan's Task 9 message with the real model in the trailer. One new
  file, 197 lines.
- This report is its own docs commit.

Before the commit, a bare `git status --porcelain` listed only
`?? e2e/tests/dashboard-next/tours-past.spec.ts`. The MERGE_HEAD probe printed
nothing, nothing was pre-staged, and the branch was
`feat/staff-notes-past-tours` at `1019f2cd`. The committed blob (`f60c0b1b`,
from `git show HEAD:<path> | git hash-object --stdin`) is the exact bytes runs 4
and 5 executed. The commit came after the last run and after the stop, per
E-2 (commit last, never `e2e:restart`).

## What shipped (`e2e/tests/dashboard-next/tours-past.spec.ts`)

This is the plan's Task 9 spec with the binding worklist corrections and one
addition (divergence 5):

- Header comment (`:1-18`): the plan's text, extended to name the per-party
  no-send check, the region-level overflow check and the pre-batch
  measurement.
- Imports (`:19-27`): `expectNoHorizontalOverflowIn` joins the multi-line
  viewport import (`:21-26`, E-5); `getOutboundTo` is imported beside
  `listThreads` (`:27`, OD-4).
- Constants (`:29-34`):
  - the house-style `E2E_DASHBOARD_URL ?? :5174` line (`:29`, OD-5);
  - the tenant id and the two unit ids (`:30-32`);
  - `TENANT_PHONE` `+15550100001` (Tasha) and `LANDLORD_PHONE` `+15550100002`
    (Marcus Bell, landlord of both `unit-0001` and `unit-0002` in the lean seed,
    `app/src/lib/seed/lean.ts:136-143,207,234`) (`:33-34`).
- Helpers (`:36-67`): `pastAt`, `outboundCount`, `devLogin`, `createTour` and
  `patchStatus`, as the plan wrote them. The `outboundCount` field names match
  `e2e/fixtures/fakeTwilio.ts:167-188`.
- A `beforeAll` reseed (`:69-72`). One describe, "Tours page - Past tab"
  (`:74`), holds one test (`:75`), and `test.slow();` is the first line of the
  test body (`:76`, E-3).
- The flow, as the plan wrote it:
  - three past-dated tours are created and two are PATCHed (`:79-86`);
  - Active shows none of the three, checked only after both Active regions
    have rendered (`:88-97`);
  - the Past tab: URL, heading, `aria-current` and intro (`:99-105`);
  - region, row helper, three rows and most-recent-first order (`:107-116`);
  - the row states and actions (`:118-124`);
  - the bulk block (`:136-147`): the anchored locators `/^Mark toured \(0\)$/`
    and `/^Mark toured \(1\)$/` (`:140`, `:143`, `:147`), and `since` captured
    immediately before the bulk click (`:142`, OD-4);
  - after the 2 s settle (`:150`): the global thread-store delta (`:151`) and
    the two per-party checks, which assert empty arrays (`:154-155`, OD-4);
  - the wire check: toured, no outcome (`:156-161`);
  - the Record outcome deep link (`:163-168`): the stripped URL via
    auto-retrying `toHaveURL`, then the dialog's Cancel scoped to the dialog;
  - the back arrow to Past (`:169-172`), the stripped URL opening no dialog
    (`:174-177`), and the plain row link's pointer (`:179-184`);
  - the post-batch 360px block with the page-level check and the region check
    (`:186-195`, E-5 at `:194`).
- The pre-batch 360px block (`:126-134`) is the one addition; see divergence 5.

## Session lifecycle (this child started it and stopped it)

- Pre-start: `ls /w/tmp/staff-notes-past-tours/e2e/.artifacts/` listed
  `.restart`, `html-report/`, `results.json` and `test-results/`, with no
  `session.pid` and no `lane.json` (S3's stop was clean). All lane 13 and lane
  15 ports were free, and DynamoDB Local :8000 and MinIO :9000 were already
  listening.
- Start: `npm run e2e:session` from the worktree root ran as a background Bash
  task, with output redirected to `.superpowers/sdd/logs/s7-session.log`. No
  `E2E_LANE` and no `lane.mjs`. The launcher picked lane 13, the hash-preferred
  lane.
- Lane and URLs, from `e2e/.artifacts/lane.json` (read at start and again,
  unchanged, just before the stop):
  - lane 13, launcherPid 13088;
  - app `http://127.0.0.1:10301`, dashboard `http://127.0.0.1:10311`, fake
    `http://127.0.0.1:10321`, publicBase `http://127.0.0.1:10331`;
  - tablePrefix `hc-local-13-`, accessKeyId `hclane13`.

  Lane 15 was never touched, and `:5174` / `:8080` were never used.
- Ping: `GET http://127.0.0.1:10311/__dev/ping` answered on the first attempt
  with `"dev":true`, `"lane":13`, `"tablePrefix":"hc-local-13-"` and
  `"appCommit":"1019f2cd"` (HEAD at launch).
- Every Playwright run printed "reusing the live e2e:session on lane 13".
- Stop: `lane.json` was read first, then `npm run e2e:stop` exited 0 with
  "stopped session launcher 13088 (+ children)", "dropped lane 13 tables
  (hc-local-13-*)" and "released lane 13 lease".
- Stop proof:
  - `Get-NetTCPConnection -LocalPort <port> -State Listen -ErrorAction
    SilentlyContinue` printed nothing for 10301, 10311, 10321 and 10331;
  - `e2e/.artifacts/session.pid` and `lane.json` are gone, and launcher 13088
    is not alive;
  - no hand-kill was needed;
  - the background session task reported exit 1 when the stop tree-killed its
    launcher, which is expected (S3 recorded the same).

  The only processes still naming this worktree are the planner's
  transcript-tail mirror and a ledger watchdog loop over
  `.superpowers/sdd/progress.md`. Neither is this child's, and both were left
  untouched. The shared containers were never stopped.

## Runs

All runs were `timeout 900 npm run e2e -w @housingchoice/e2e -- --grep "<regex>"`
from the worktree root (the E-7 form), with output redirected to a log and
never piped. The files under test were uncommitted in every run.

| run | log | bytes under test | exit | result line |
|---|---|---|---|---|
| 1 | `s7-e2e-run1.log` | blob `ee16512a` - the plan text + E-3/OD-4/E-5 | 0 | "1 passed (9.5s)" |
| 2 | `s7-e2e-run2-controls.log` | a TEMPORARY control file (below) | 0 | "1 passed (8.5s)" |
| 3 | `s7-e2e-run3-controls2.log` | the control file + one observation stop | 0 | "1 passed (8.9s)" |
| 4 | `s7-e2e-run4.log` | blob `f60c0b1b` - the final bytes = the commit | 0 | "1 passed (8.9s)" |
| 5 | `s7-e2e-run5-trio.log` | blob `f60c0b1b` | 0 | "3 passed (14.1s)" |

- Runs 1 and 4 used `--grep "Past tab"`, which selected exactly the one new
  test.
- Run 5 used `--grep "Past tab|Staff notes card|editing a contact PATCHes"` and
  selected exactly three tests:
  - `contact-detail.spec.ts:51` (2.4s);
  - `tenant-staff-notes.spec.ts:36` (3.0s);
  - `tours-past.spec.ts:75` (5.1s).

  The Part 1 specs did not regress on this stack.

### Controls (runs 2 and 3; temporary edits, never committed)

Before the controls, the run-1 bytes were saved to the session scratchpad.
After the controls they were copied back: `git hash-object` returned the same
blob `ee16512a`, and the file contained zero control markers. Only then were
the final edits made. What each control showed:

- NC-A (anchoring): clicking a bare `{ name: 'Mark toured' }` while a row is
  ticked fails with "strict mode violation ... resolved to 2 elements": the
  bulk "Mark toured (1)" and the row's "Mark toured: Tasha Nguyen at ...". This
  executes the reason for the anchored-regex constraint.
- NC-B (the no-send proof is live): the real assertions ran first and passed
  (global 0 -> 0; tenant and landlord `[]`). Then a real human send to Tasha
  inside the same window (`POST /api/conversations/conv-0001/messages`, 201)
  was seen by all three reads: global 1 (before 0), tenant 1, landlord 0. So
  the global delta, the `since` window and the party numbers can each fail.
- NC-C (the overflow checks are live at 360px): with one row forced to a 500px
  min-width, the page check read 164 ("the routed <main> scrolls sideways")
  and the region check read 188 ("this surface scrolls sideways"). On the
  shipped layout both read at most 1 (region 312/312, main 360/360).
- NC-D (the back-arrow fallback, in the real BrowserRouter): after a fresh
  navigation to `/tours/<id>`, which has no router state, the back arrow's
  href is `/tours`.
- NC-E (pre-batch 360px): with the Not marked row still carrying its checkbox
  and Mark toured button, the page and region checks both passed in both
  control runs. This is the evidence behind divergence 5.

### Backend evidence (lane app log, whole session)

- Requests:
  - 15 `PATCH /api/tours/<id>`, all 200 (three per run: two setup PATCHes and
    one batch PATCH);
  - 15 `POST /api/tours`, all 201;
  - 12 `POST /__dev/reseed`, all 200;
  - 2 manual sends, both 201 (the NC-B controls only);
  - 4 contact PATCHes, all 200 (run 5's Part 1 pair).
- The only 4xx were 14 `GET /auth/me` 401, the logged-out probes after
  reseeds. There were no 5xx.
- No ERROR-level line. The WARN lines were the boot-time local notices
  (JOBS_QUEUE_URL, SCHEDULER) and the lean world's group-heartbeat line.
- No `[dynamoAdmin]` line in the session log or any run log.
- Wire order for one bulk mark (run-1 trail): `GET /api/tours/<id>` 200, then
  `PATCH /api/tours/<id>` 200, then one `GET /api/tours` list refetch. This is
  exactly what the S5 report describes.

## Gates run in this slice

- `npm run typecheck` (root, all five workspaces) after the commit: exit 0.
- The e2e workspace typecheck also passed (exit 0) before run 1, before each
  control run, and on the final bytes.
- ASCII: `tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/tours-past.spec.ts | wc -c`
  printed 0. The file has 0 CR bytes and 0 tabs.
- Not run, per the mission: `npm test`, `npm run smoke`, the full
  `npm run e2e`, lint.

## Divergences from the plan (and why)

1. E-3 (binding): `test.slow();` is the first line of the body, with a
   one-line reason (`:76`).
2. OD-4 (binding): `getOutboundTo` import (`:27`), `since` immediately before
   the bulk click (`:142`), and the two per-party empty-array assertions after
   the settle (`:154-155`). The two phone numbers sit in named constants beside
   the other seed constants (`:33-34`) rather than inline. The values are the
   worklist's literals.
3. E-5 (binding): `expectNoHorizontalOverflowIn(region, 'Past tours region at
   360px')` beside the page-level call (`:194`).
4. OD-5 (binding): the `:5174` fallback line is kept as written (`:29`).
5. Addition, taken alone: a pre-batch 360px block (`:126-134`). It measures
   page and region while the Not marked row still carries its checkbox and
   Mark toured button.
   - Why: the plan's only 360px block runs after the batch. By then no row has a
     checkbox or a Mark toured button, because the batch turns the single Not
     marked row into Needs outcome. So the plan's own comment there ("rows with
     a checkbox and actions must not push the page sideways") could not be
     true, and spec 4.8 names the checkbox and the wrapped action as what the
     narrow layout must hold.
   - The block was shown green (NC-E, twice) before it was committed.
   - The plan's end block is kept, with its comment rewritten to what it now
     measures (`:186-187`) and the header's last clause extended (`:16-18`).
   - Cost: about 0.3 s. Reviewers may fold it back into one block before the
     batch if they prefer a single narrow check.
6. The plan's Step 2 aside ("if a session from Task 5 is still up, run
   e2e:restart") did not apply. S3 stopped its session, and E-2 forbids a
   restart, so a fresh session was started.
7. Runs 2-3 (temporary control files) are not in the plan. They are evidence
   only; nothing from them was committed.
8. The commit trailer names the real authoring model.

Recorded, no change:

- The plan's "A reload of the stripped URL" step (`:174-177`) is a fresh
  `page.goto`, not a reload. It has no router state, so the back arrow on that
  page reads `/tours` (NC-D). A true reload that keeps `state.back` was not
  exercised here; the S6 report covers it from react-router's source. Browser
  Back/Forward were exercised in the controls (O-4).
- `since` comes from the test runner's clock and is compared with the fake's
  `createdAt`. Both run on the same host.

## Observations about the feature (for the spec reviewers and the live self-QA)

- O-1 - 360px, the per-row checkbox is orphaned. On the Not marked row the
  checkbox sits alone on its own line ABOVE its card, directly under the
  toolbar's "Select all not marked" checkbox.
  - Geometry at 360px (x, y, w, h): checkbox 24,286 18x18; card 24,311
    312x124; the "Mark toured" button right-aligned on a third line at
    237,443; the row is 185px tall.
  - Screenshot: `s7-shots/2-past-360-before-batch.png`.
  - Nothing overflows (both checks pass). Spec 4.8's "the checkbox stays
    leading" is met literally, since the checkbox comes first. Visually,
    though, the per-row box and the select-all box stack in one column and
    read as a pair.
  - Likely cause (from reading the CSS): under the 560px container query
    `.pastRow` wraps (`dashboard/src/routes/tours/ToursPage.module.css:355-358`)
    and the link's flex basis is its content width (`:261-262`,
    `flex: 1 1 auto`), so the link cannot share the first line with the 18px
    checkbox.
  - Any fix is a dashboard change, which this slice does not make.
- O-2 - Desktop row edges are ragged. The three row cards differ in width:
  - the Not marked card starts 26px right of the others (the checkbox) and
    ends before its 99px "Mark toured" button;
  - the Needs outcome card ends before its 97px "Record outcome" link;
  - the No show card spans the full 992px.

  As a result the date-time and state chips end at three different x
  positions: the card right edges are 1149, 1151 and 1256. Screenshots
  `1-past-desktop-before.png` and `3-past-desktop-after-batch.png`. This is a
  design call; it is not asserted.
- O-3 - Timing (warm lane 13, this host, both control runs):
  - Past tab click to three rows: 61 ms;
  - bulk click to "Marked toured" plus "Needs outcome": 87 / 96 ms;
  - Record outcome click to the stripped URL with the dialog open: 223 /
    115 ms.

  Test durations were 5.1-6.1 s; `test.slow()` leaves a 180 s cap. The Past
  list fetch waits for the lookups, as D2-R4 recorded. On run 1's cold
  `/tours/past` load, the last contacts/units lookup completed at +121.255 s.
  The one `GET /api/tours` that answered 200 (the Past range read; the page's
  unconditional Active reads answered 304) was received at +121.263 s.
- O-4 - The dialog is open on arrival with nothing to click. Cancel, scoped to
  the dialog, closes it, and the header CTA "Record outcome" remains
  (screenshot `4-tour-dialog-open.png`).
  - Browser Back from the stripped tour page returns to `/tours/past`.
  - Browser Forward returns to `/tours/<id>` with no query and no dialog, and
    the back arrow still points at `/tours/past` (the history state survives
    the pop).
- O-5 - Back arrow:
  - `/tours/past` right after the strip, with the dialog still open;
  - `/tours/past` via the plain row link (also on a still-scheduled tour's
    page);
  - `/tours` on a direct load (NC-D).
- O-6 - Reminders panel on a past-dated tour:
  - While the tour is still scheduled (a Not marked row's tour page), the
    Reminders card shows one rung: "Day before", "Skipped - booked too late
    for this reminder". Its body preview reads "Hey Tasha, confirming your tour
    tomorrow at 10:00 AM. Does that still work for you?". The preview says
    "tomorrow" for a tour dated yesterday (screenshot
    `7-scheduled-tour-reminders-card.png`).
  - That is pre-existing preview behavior. It is reachable only for a tour
    BOOKED in the past, which is how this spec builds its world; a real past
    tour booked ahead of time would show its sent rungs instead.
  - After Mark toured (the batch's PATCH), the card reads "No reminders armed."
    (`dashboard/src/routes/tours/RemindersPanel.tsx:403`). The terminal
    transition's sweep deleted the skipped row. The app log says "superseded
    tour reminders deleted" with deleted 1 (`app/src/routes/tours.ts:1344`
    calling `app/src/repos/tourRemindersRepo.ts:504-510,577`). The sweep
    removes a superseded ladder's never-sent rows, skipped and canceled
    included; sent rows are kept.
  - The tour page's own Mark toured sends the same PATCH, so this is not
    introduced by the Past tab. The binding constraint's "visible
    booked_too_late skipped row" is visible only until the tour is marked
    toured.
- O-7 - On the tour page, the tenant's person tab interleaves milestones from
  ALL her tours (three "Tour scheduled", a "Tour took place" and a "Tour
  no-show" in `8-scheduled-tour-page.png`). This is pre-existing
  contact-scoped timeline behavior. It is noted only because the Past flow
  builds several tours for one tenant.
- State left behind by the spec (per run): three tours for Tasha (two toured,
  one no_show), their milestones and audit rows, and no reminder rows. The next
  spec in run order reseeds, per the worklist's run-order note. `e2e:stop`
  dropped the lane 13 tables anyway.
