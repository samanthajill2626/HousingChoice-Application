# Slice S3 report - e2e side of staff notes (plan Task 5)

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `8f3bc9c5` (the S2 report commit)
Implementer: S3 child, Claude Opus 5.5 (1M context)
Status: DONE - both specs green against a hermetic session this child started
and stopped (run 1 green, run 2 a deliberate two-sided negative control, run 3
green on the committed bytes); root typecheck exit 0 after the commit; the
session is stopped with its four lane ports proven free.

Byte-exact quotations behind every quoted line below (run logs, the ping, the
lane record, the stop output, the typecheck output) are in the ignored run state
`.superpowers/sdd/slice-S3-reference.md`; the raw logs are in
`.superpowers/sdd/logs/s3-*.log`.

## What shipped

### `e2e/tests/dashboard-next/contact-detail.spec.ts` (plan Task 5 Step 1)

- Header comment: the plan's one sentence, wrapped over two lines at the file's
  comment width (`contact-detail.spec.ts:10-11`).
- Test "editing a contact PATCHes and persists across a reload" (`:51`): the
  Edit-dialog locator is now a `const dialog` (`:60`), the existing visibility
  assertion reads it (`:61`), and the Notes field is `dialog.getByLabel('Notes')`
  (`:62`). The cleanup's Notes field is scoped inline to the same dialog (`:76`),
  as the plan writes it. No assertion added, removed or changed.
- Diff: +6 / -3 in this file. Nothing else in the file was touched (the other
  seven tests were not run in this slice; see "Not run" below).

### `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts` (new, plan Task 5 Step 2)

The plan's spec, with the one binding worklist addition (D1-R1). One describe,
"Tenant file - Staff notes card" (`:35`), one test (`:36`):

- Reseed in `beforeAll` (`:30-33`), per-spec `devLogin` (`:24-28`), open
  `contact-tenant-0001` and wait for the Details heading (`:37-39`).
- Card locators: the Card root `<section>` that has a heading matching
  `/Staff notes/` or `/Preferences & notes/` (`:41-42`); the Preferences card's
  `innerText` is captured once (`:45`).
- Seed state: "No staff notes yet." and no "Last edited" line (`:48-49`).
- Add: the exact "Add staff notes" button (`:52`), the textarea by the exact
  label "Staff notes" is visible and focused (`:53-55`), no staff-notes button
  exists while editing (`:57`), fill the marker and Save (`:58-59`).
- Live result: the marker, the anchored `Last edited <Mon> <D>, <YYYY>` line,
  no textarea, and the Preferences card's `innerText` unchanged (`:62-66`).
- Reload: marker and "Last edited" still shown, Preferences unchanged (`:69-73`).
- 360px (`:79-91`): `NARROW_360`, press the "View" group's "Profile" button,
  open the editor with the exact "Edit staff notes" button, then the page-level
  `expectNoHorizontalOverflow` (`:84`) AND the card-level
  `expectNoHorizontalOverflowIn(staffCard, ...)` (`:89`, D1-R1, with a four-line
  why-comment at `:85-88`), Cancel (`:90`), `WIDE_RESTORE` (`:91`).
- Cleanup: Edit, fill `''`, Save -> "No staff notes yet.", no marker, no "Last
  edited" line (`:96-101`). Tasha ends with `staff_notes: ''` (hidden stamp kept).
- Imports: `expectTodayReady` (`:13`) and the four viewport names as a
  multi-line import (`:14-19`). `NEXT` keeps the house-style `:5174` fallback
  (`:21`, OD-5).

## Commits

- `c8d48fd5` test(e2e): tenant file staff notes round-trip, reload, prefs card
  untouched, 360px; scope contact-detail Notes locators to the dialog (spec 5) -
  the two spec files, explicit paths. The committed blobs are sha1-identical to
  the bytes runs 1 and 3 executed (checked with `git show HEAD:<path>`).
- This report, as its own docs commit: `docs(staff-notes-past-tours): slice S3 report`.

Before the commit: bare `git status --porcelain` listed only the two spec paths
(` M contact-detail.spec.ts`, `?? tenant-staff-notes.spec.ts`), the MERGE_HEAD
probe printed nothing, nothing was pre-staged, and the branch was
`feat/staff-notes-past-tours` at `8f3bc9c5`.

## Session lifecycle (this child started it and stopped it)

- Pre-start: `ls /w/tmp/staff-notes-past-tours/e2e/.artifacts/` failed with "No
  such file or directory" - the directory did not exist, so there was neither a
  `session.pid` nor a `lane.json`. Lane 13 and lane 15 ports were all free;
  DynamoDB Local :8000 and MinIO :9000 were already listening.
- Start: `npm run e2e:session` from the worktree root as a background Bash task,
  output redirected to `.superpowers/sdd/logs/s3-session.log`. No `E2E_LANE`, no
  `lane.mjs`. The launcher picked lane 13 (the hash-preferred lane), created the
  22 `hc-local-13-*` tables fresh, and logged ready about 30 s after start.
- Lane and URLs (from `e2e/.artifacts/lane.json`, read before the stop):
  lane 13, launcherPid 69796, app `http://127.0.0.1:10301`, dashboard
  `http://127.0.0.1:10311`, fake `http://127.0.0.1:10321`, publicBase
  `http://127.0.0.1:10331`, tablePrefix `hc-local-13-`, accessKeyId `hclane13`.
  Lane 15 was never touched; `:5174` / `:8080` were never used.
- Ping: `GET http://127.0.0.1:10311/__dev/ping` answered `"dev":true` with
  `"lane":13`, `"tablePrefix":"hc-local-13-"` and `"appCommit":"8f3bc9c5"`.
- Every Playwright run printed "reusing the live e2e:session on lane 13".

### Spec runs (all: `timeout 900 npm run e2e -w @housingchoice/e2e -- --grep "Staff notes card|editing a contact PATCHes"` from the worktree root, redirected to a log, never piped)

| run | log | bytes under test | exit | result line |
|---|---|---|---|---|
| 1 | `s3-e2e-run1.log` | final (uncommitted) | 0 | "2 passed (12.0s)" |
| 2 | `s3-e2e-run2-negative-controls.log` | two temporary mutations | 1 | "2 failed" |
| 3 | `s3-e2e-run3.log` | final, sha1-identical to run 1 and the commit | 0 | "2 passed (7.8s)" |

Run 1 was green first time; there was no red run to diagnose. Run 2 is an
addition to the plan: a deliberate negative control, so that neither green
assertion is taken on faith. Two uncommitted edits, both reverted before run 3
(sha1 of both files re-checked equal to run 1's):

- `contact-detail.spec.ts:62` put back to the page-wide `page.getByLabel('Notes')`.
  Result: "strict mode violation: getByLabel('Notes') resolved to 2 elements" -
  the StaffNotesCard's aside button (`aria-label="Add staff notes"`, text
  "+ Add") and the dialog's Notes textbox. This executes what the research
  collision sweep had established by reading: without the scoping the existing
  test breaks on the new card.
- In the new spec, the textarea was forced to 500px wide just before the
  page-level check. Result: the page-level `expectNoHorizontalOverflow` PASSED
  (execution reached the next check) and the card-level check FAILED with
  "Staff notes card in edit mode at 360px: this surface scrolls sideways",
  "Expected: <= 1", "Received: 202". So in the real app, on the real DOM, the
  page-level check is blind to this card (D1-R1's premise) and the D1-R1 check
  is live. In runs 1 and 3 both checks read <= 1 on the shipped card.

Backend evidence from the lane app's log (all three runs): nine
`PATCH /api/contacts/contact-tenant-0001`, every one 200 (4 in run 1, 1 in run 2
before its failure, 4 in run 3; the 360px Edit -> Cancel sends none), and seven
`POST /__dev/reseed`, every one 200 (session start, then the preflight plus the
spec's `beforeAll` per run). No `[dynamoAdmin]` line in any session or run log;
no ERROR-level line in the session log (the WARN lines are the boot-time local
notices and the lean world's group-heartbeat line).

### Stop

- `lane.json` read first (values above), then `npm run e2e:stop` -> exit 0:
  "stopped session launcher 69796 (+ children)", "dropped lane 13 tables
  (hc-local-13-*)", "released lane 13 lease".
- Proof: `Get-NetTCPConnection -LocalPort <port> -State Listen -ErrorAction
  SilentlyContinue` printed nothing for 10301, 10311, 10321 and 10331;
  `e2e/.artifacts/session.pid` and `lane.json` are gone; the launcher, app,
  worker, Vite, fake-twilio, the four esbuild services and this child's
  background bash are all gone by PID. No hand-kill was needed.
- Still running and NOT this child's: the planner's transcript-tail mirror and
  its ledger watchdog (their command lines also name this worktree's path).
  Untouched. The shared containers (:8000, :9000) are still up; never stopped.
- No background command of this child is left running.

## Gates run in this slice

- `npm run typecheck` (root, all five workspaces) after the commit: exit 0.
  The e2e workspace alone was also typechecked before run 1: exit 0.
- ASCII: `tenant-staff-notes.spec.ts` whole-file check prints 0;
  `contact-detail.spec.ts` added-lines check prints 0. Both files are LF-only,
  no tabs.
- Not run, per the mission: `npm test`, `npm run smoke`, the full `npm run e2e`,
  lint. The other seven tests in `contact-detail.spec.ts` were not run here; the
  research collision sweep clears them and gate 4 runs them.

## Divergences from the plan

1. D1-R1 (binding, worklist S3): `expectNoHorizontalOverflowIn(staffCard, ...)`
   added after the textarea is visible and before Cancel (`:89`), the page-level
   call kept (`:84`), plus a four-line comment saying why (`:85-88`). The import
   gained the name and became multi-line (`:14-19`), as `property-roster.spec.ts`
   and `tour-roster.spec.ts` write theirs.
2. The contact-detail header sentence is wrapped over two physical lines
   (`contact-detail.spec.ts:10-11`) instead of one ~140-column line, matching the
   file's comment width. Same words as the plan.
3. Run 2 (the negative controls) is not in the plan. Evidence only; nothing from
   it was committed.
4. The commit trailer names the real authoring model in place of the plan's
   placeholder.

Everything else - both locator rewrites, the whole test body, the describe and
test titles, the commit message subject - is the plan's text. E-2 (commit last,
never `e2e:restart`), E-7 (the `-w @housingchoice/e2e -- --grep` form) and OD-5
were followed as written.

## For S7 (same session lifecycle)

- The grep form works: the `|` alternation survived npm's cmd escaping (npm's own
  error line in run 2 shows the caret-escaped command) and selected exactly two
  tests. E-7 is now confirmed by execution, not only by reading npm's source.
- Playwright clears `e2e/.artifacts/test-results` at the start of every run, so a
  failing run's screenshot, video and error-context vanish at the next run. Copy
  them out before re-running if you need them.
- From Git Bash, `node -e` cannot open a `/w/...` path (Windows Node sees no such
  drive path). This child's first ping waiter read `lane.json` that way, got an
  empty URL, and polled nothing until stopped and re-armed with the literal lane
  URL. Pass `W:/tmp/...` to Node, or read the URL with shell tools.
- The background `npm run e2e:session` task reports exit 1 once `e2e:stop`
  tree-kills the launcher. Expected; not a failure.
- `e2e:stop` drops the lane's tables, so the next `e2e:session` recreates them
  (about 30 s to ready on this host tonight, lane 13, with the containers warm).
- Do not kill processes by a path match on this worktree: the planner's mirror
  and watchdog match too. Kill only by recorded PID, as the mission says.
- State left behind for later specs: Tasha (`contact-tenant-0001`) ends with
  `staff_notes: ''` plus a kept `staff_notes_updated_at`; the card renders it as
  never set. `tours-past.spec.ts` reseeds anyway.
- Resolved open questions from the S2 report, now by execution in the real
  browser: the `/Staff notes/` and `/Preferences & notes/` heading regexes
  resolve despite the Card heading's CSS uppercase and the aside button inside
  the `<h3>`; the en-US "Last edited" date renders "Sep" (not "Sept") and matches
  the anchored regex; `toBeFocused()` on the textarea passes without an
  `autoFocus` fallback.
