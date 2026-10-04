# Slice report - S10 (docs, issue registry, RUNBOOK, spec text corrections)

- Date: 2026-10-04. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD a6b8098a (S9 report commit).
- Scope: plan S10 (Tasks 10.1-10.3) plus the spec TEXT corrections of rulings
  F1 and F5 (ruling D-n), one commit each, then this report. No file under
  `app/`, `dashboard/`, `e2e/` or `scripts/` was touched; no test, gate or e2e
  command was run (docs only - the orchestrator runs the gates).
- Sources followed: AGENTS.md ("Editing and commit discipline", "Issue, TODO,
  and known-problem tracking"); plan sections 0-1 and S10; spec sections 2,
  5.3, 6.6, 12, 13 and 15; the binding corrections 8-13 and section 3 items
  a-d of `research/drift-s9-s10-e2e-docs.md`; rulings F1, F2, F5, D-m and D-n
  in `research/worklist.md` (with their sources, drift-s1-s2 items 13-17);
  `slices/s5-report.md` (the poll and the tick as shipped) and
  `slices/s9-report.md` section 6; `docs/issues/README.md`, `_TEMPLATE.md`
  and the model resolution `docs/issues/past-tab-timeless-toured-tours.md`;
  RUNBOOK.md and documentation/GLOSSARY.md around the insertion points.
- Every file:line written into a doc was re-derived from the live tree at
  a6b8098a (section 3). No STOP condition was hit: every fact the docs state
  was found in the code, except the Past tab's production date (section 6,
  item 2), which is the spec's own statement.

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| 5760b162 | 10.1 | docs(glossary): tour auto-close, "No outcome recorded" and Reopen |
| a81bbcca | 10.2 | docs(issues): tour auto-close - no-show exit resolved, relay-open race filed |
| 14f179c3 | 10.3 | docs(runbook): tour auto-close - nothing owed; preview, first run, review |
| 4398e43a | D-n | docs(spec): tour auto-close - text corrections F1 and F5 (no decision changed) |
| (this) | records | docs(records): tour auto-close S10 slice report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD checked
absent (`git rev-parse --git-path MERGE_HEAD` - `.git` is a file in a
worktree), explicit paths staged, ASCII message, `Co-Authored-By: Claude Opus
5.5` trailer, committed through Bash with a heredoc. The new issue file was
marked intent-to-add (`git add -N`, its own path only) before its commit so
the added-lines ASCII check could see it.

Files: `documentation/GLOSSARY.md`, `documentation/tours-sequence-writeup.md`,
`docs/issues/past-tab-no-show-rows-need-an-exit.md`,
`docs/issues/tours-patch-status-precondition.md`, new
`docs/issues/tour-relay-open-vs-auto-close-race.md`,
`docs/issues/tours-scheduled-range-query-unpaginated.md`, `RUNBOOK.md`,
`docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`, and this
report.

ASCII: after every edit the added lines of `git diff -U0 -- <file>` were
scanned (`LC_ALL=C grep -P '[^\x09\x0A\x0D\x20-\x7E]'`, the pattern first
proven to catch an em dash) - none in any file. The new issue file and the
spec are fully ASCII (`tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0) and
carry no CR. The pre-existing non-ASCII in GLOSSARY, RUNBOOK and the
tours-sequence writeup was left alone.

## 2. Per task: what changed

### Task 10.1 - GLOSSARY and the tours writeup (5760b162)

- `documentation/GLOSSARY.md`, `## Feature & label notes`: one entry appended
  after the last one (accepted authorities), before the `---` (correction 12):
  `- **Tour auto-close / "No outcome recorded" / Reopen** (tour auto-close,
  2026-10-01, Sam's item 18) - ...`. It carries the plan's definition: the
  clock start (the LATEST of the tour's time, its creation and its mark -
  `lastMarkedAt`, or `updatedAt` for a tour nobody has marked), what closes
  (scheduled with the date passed, toured without an outcome, no-show) and
  what never does (requested, canceled, "Needs placement", converted), the
  system-only `no_outcome`, the staff labels "No outcome recorded", "Closed
  automatically on <date>" (in place of "Moving forward") and "Reopen tour",
  the reopen target (`autoClosedFrom`, or toured for a decided tour), and the
  code/data names `autoClosedAt`, `autoClosedFrom`, `lastMarkedAt`,
  `jobs/tourAutoClose.ts`, `POST /api/tours/:tourId/reopen`.
- `documentation/tours-sequence-writeup.md` section 5 (the exit gate, drift
  3b): a third bullet beside "Yes" and "No" - "No decision - it closes on its
  own": a tour with no outcome two weeks after its date or its last mark
  closes as "No outcome recorded", nothing is sent, and it can be reopened
  from its tour page.

### Task 10.2 - the issue registry (a81bbcca)

- (a) `past-tab-no-show-rows-need-an-exit.md`: `status: resolved` with
  `resolved: 2026-10-04` right under it, and a closing
  `**Resolution (2026-10-04, feat/tour-auto-close).**` paragraph (correction
  8, D-m), modeled on `past-tab-timeless-toured-tours.md`: closed BY DECISION
  (Sam, Sep 30: the two-week auto-close covers it; spec D13; none of the
  issue's options was built); what shipped - a no-show closes on its own 14
  days after its last mark (or its date, if later), "No outcome recorded",
  nothing sent, so it leaves the Past tab and Today for the Closed tab and can
  be reopened back to No show; Today lists no-shows meanwhile (spec 9.4); the
  spec path.
- (b) `tours-patch-status-precondition.md`: a
  `**Update (2026-10-04, feat/tour-auto-close).**` block: the server-side
  window is closed (consistent read, status precondition, 409 `tour_changed`
  with its detail text, before any side effect); the client's stale-list
  window remains - the precondition is the status the SERVER read, it ignores
  `scheduledAt`, and `canceled -> toured` / `no_show -> toured` stay legal -
  guarded by the bulk runner's re-read (`markToured`); the issue's suggested
  fix is what would close it. Status stays open.
- (c) NEW `tour-relay-open-vs-auto-close-race.md` from `_TEMPLATE.md` (the
  template's comment block and its non-ASCII dropped, correction 9): `type:
  debt`, `severity: low`, `status: open`, `area: app/tours`, `created:
  2026-10-04`, refs verified live. Body: the open checks status on a READ
  (`tourOpenGuard`) and `claimGroupThread`'s condition has no status term
  (spec 6.6); all three open paths (ruling F1): `POST /api/tours/:tourId/relay`,
  apply-now, and the worker's roster-action poll with its dev roster tick;
  the consequence (a group provisioned onto a closed tour, and no close-nag
  armed for it); suggested fix - a status condition on the claim - plus the
  claim-to-pointer window that fix alone leaves. Then the F2 paragraph:
  reopen racing a conversion on a closed, unconverted, `convertible: true`
  tour with an outcome (API-only state); `claimConversion` has no status or
  `convertible` term, so a reopen between the conversion's read and its claim
  is silently overridden; end state coherent; suggested fix `AND #cv = :true`
  on `claimConversion`.
- (d) `tours-scheduled-range-query-unpaginated.md`: `**Update 2026-10-04.**`
  (the file's own update style, correction 8): the sweep is not a third caller
  - it reads by status (`listByStatus` for the three candidate statuses, each
  paged to exhaustion), never by range, so a truncated page cannot hide a tour
  from it and it reaches the undated tours too; the body's line numbers are
  main's (@ae04122d) and the note gives this branch's.
- `npm run issues`: section 4.

### Task 10.3 - RUNBOOK (14f179c3)

- New `### Tour auto-close (2026-10-01): NOTHING is owed - no migration, no
  env var, no Terraform, no operator step` under `## Daily operations`,
  immediately BEFORE `### Tour reminder supersession (2026-09-01): ...`
  (correction 10, D-m), in that entry's shape - a bold lead sentence, then
  bullets:
  - "Nothing to apply": optional attributes, no backfill / migration / GSI /
    Terraform / secret; the cadence is a code constant.
  - BEFORE the deploy: the spec section 13 preview recipe (Past tab rows dated
    more than 14 days ago, minus "Needs placement", minus rows a person changed
    in the last 14 days; plus "Undated" rows last changed more than 14 days ago
    - no screen shows that date, so that part errs safe) and the 90-day /
    one-page blind spot.
  - WHAT HAPPENS about 15 minutes after the new worker starts: every tour two
    weeks past its clock start with no outcome closes silently (with the
    first-deploy fallback spelled out: no `lastMarkedAt` yet, so any write in
    the last 14 days keeps a tour open); per close, the "Tour closed
    automatically: no outcome recorded after two weeks" pins on the tenant AND
    landlord timelines plus the property and tour activity, never-sent reminder
    rows deleted, relay close-nags armed (Today about four weeks later), the
    "Toured" chip kept only where the tour was marked toured; the two INFO log
    lines; and that on dev a live-mode `npm run dev` can run the first sweep
    before the deploy (section 6, item 1).
  - AFTER: the Closed tab (newest activity first), the "No outcome recorded"
    badge, "Closed automatically on <date>", Reopen from the tour page.
- Worker sections kept true (drift 3a): `### Worker poll cadence` gains a
  paragraph - the tour auto-close poll runs on its own 15-minute constant
  (`TOUR_AUTO_CLOSE_INTERVAL_MS`), not `WORKER_POLL_INTERVAL_MS`;
  `#### Worker clock polls (durable-row ladders)` gains a "Tour auto-close"
  bullet: poll name `tour auto-close`, cadence and first tick, what it reads
  and writes, the seam `POST /__dev/tour-auto-close/tick { now?, tourIds? }`,
  and the failure lines `tour auto-close poll error` (from `jobs/pollLoop.ts`)
  and `tour auto-close write failed`.
- F5: the RUNBOOK never repeats the old no-shows-only seed claim; the entry
  does not describe the demo world at all.

### Spec text corrections (4398e43a, ruling D-n)

Only the spec file; the Status line and every decision untouched.

- F1, section 5.3: "background jobs only read tours" replaced. The
  `updatedAt` writers are person-triggered or at create time, apart from the
  sweep's own close; the one that runs in the background is the worker's
  roster-action poll (and its dev tick), applying a group open a person
  confirmed during quiet hours - `groupThreadId`, the `roster` plan,
  `updatedAt`, once per confirmed action, never status / outcome / date. The
  conclusion (postpone-only) stands. A marker names the correction.
- F1, section 12 writer list: adds the conversion claim and release
  (`placements.ts:716`, `:750`, `:778`; `convertedPlacementId` and
  `conversionClaimedAt` only) and the roster-action poll with its dev tick
  (status untouched).
- F5, section 12 seed bullet: the seven full-profile tours that auto-close if
  a worker runs and nobody marks them - the matrix's `no_show` pair (about 9 /
  11 days after a reseed), its `scheduled` pair (about 17 / 19 days), and
  `live.ts`'s three scheduled tours (about 14 / 15 / 16 days; two carry the
  live relay group, so the first close arms its nag); the cast's two tours are
  non-candidates.

## 3. Facts verified in the live code (HEAD a6b8098a)

| fact (where it is written) | live code |
|---|---|
| open guard is a read (issue c) | `app/src/services/rosterProvision.ts:150-164` `tourOpenGuard` (canceled / closed -> 409 `tour_not_active`; pointer -> `relay_already_provisioned`); `openTourGroup` :294 re-applies it to the handed object :303, claims :335 |
| the claim has no status term (issue c) | `app/src/repos/toursRepo.ts:488-502`, condition `attribute_exists(tourId) AND attribute_not_exists(#gt)` at :496; it also stamps `updatedAt` |
| the open's other tour writes (spec F1) | `rosterProvision.ts:364` / `:401` release, `:398` pointer `patch`, `:424` `clearRoster` |
| path 1, immediate open (issue c) | `app/src/routes/tours.ts:1544` `router.post('/:tourId/relay')`, `tours.get` :1550 (eventually consistent - `toursRepo.ts:371-383` sends `ConsistentRead` only when asked), guard :1559, `openTourGroup` :1644. Drift 9's `:1594` was that call at ae04122d (route :1494 then); S3-S6 moved the file by +50. |
| path 2, apply-now (issue c) | `routes/tours.ts:883`, `applyTourRosterAction` call :894 |
| path 3, poll and dev tick (issue c, spec F1) | `app/src/jobs/rosterActions.ts` `loadTourOwner` :144, read :148, `openTourGroup` :156, closed check :171 (drift 9 said :170), `applyTourRosterAction` :589, `runDuePendingRosterActions` :616; `app/src/worker.ts:436` `startPoll('roster action', ...)`; `app/src/routes/dev.ts:545` `POST /__dev/roster-actions/tick` |
| the close ignores `groupThreadId`; no nag for a sentinel (issue c) | `toursRepo.ts:679-746` `autoCloseIf` conditions; `app/src/services/relayCloseNag.ts:42` `armRelayCloseNagIfOpen` returns on a missing conversation (`getById` of `provisioning:<tourId>` finds none) |
| F2 race (issue c) | `app/src/routes/placements.ts:644` route, read :656, `convertible` gate :661, claim :716, releases :750 / :778, finalize `patch` :771-775 with no `expectedStatus`; `toursRepo.ts:540` claim condition `attribute_exists(tourId) AND attribute_not_exists(#cp)`; `reopenIf` :748 requires `attribute_not_exists(#cp)` and REMOVEs outcome / moveForward / convertible / autoClosedAt / autoClosedFrom; `app/src/lib/toursModel.ts:253-259` `reopenTargetFor`; PATCH sets `convertible` from `moveForward` (`routes/tours.ts:1151-1155`) |
| PATCH precondition (issue b) | `routes/tours.ts:1034` consistent read, :1232 `patch(..., { expectedStatus: currentStatus })`, :1233-1247 re-read and 409 `tour_changed` + detail; `toursRepo.ts:463-468` the condition; `lastMarkedAt` stamp :1161-1166 |
| client window (issue b) | `dashboard/src/routes/tours/ToursPage.tsx:429` `markToured`, re-read :446 |
| range vs status reads (issue d) | `toursRepo.ts:393-410` one page, `:412-432` paged; callers `app/src/routes/today.ts:550`, `routes/tours.ts:387`; at ae04122d (and main 71e532fb) the issue's own :347 / :366 / :413 hold |
| sweep candidates (issue d, RUNBOOK) | `app/src/jobs/tourAutoClose.ts:64-71` `loadCandidates` (`listByStatus` per `AUTO_CLOSE_STATUSES`; `tourIds` reads consistent) |
| poll name, cadence, first tick (RUNBOOK) | `worker.ts:565-569` `startPollLoop('tour auto-close', ..., { intervalMs: TOUR_AUTO_CLOSE_INTERVAL_MS })`; the shared wrapper :292-298 binds `config.workerPollIntervalMs`; `tourAutoClose.ts:32` = 15 min; `app/src/jobs/pollLoop.ts:64-76` setInterval only, so the first tick is one interval after boot |
| failure and info lines (RUNBOOK) | `pollLoop.ts:73` `${pollName} poll error` with `{ err, poll }`; `tourAutoClose.ts:93` `tour auto-close write failed`, :101 `tour closed automatically (no outcome after two weeks)` `{ tourId, from }`, :105 `tour auto-close run` only when closed or failed > 0 |
| dev seam (RUNBOOK) | `dev.ts:457-484`: body `{ now?, tourIds? }`, 1..50 ids, the two 400 texts |
| per-close effects (RUNBOOK) | `tourAutoClose.ts:110-126` `afterClose`: `deleteSupersededForTour`, `recordTourEvent` (label :35), `armRelayCloseNagIfOpen`, two emits |
| the chip (RUNBOOK) | `app/src/lib/listingSendTour.ts:56-66` `qualifyingState` (closed + `autoClosedFrom === 'toured'` -> toured; from scheduled / no_show -> none) |
| Closed tab order (RUNBOOK) | `dashboard/src/routes/tours/useTours.ts:137-141` (`updatedAt` desc) |
| staff labels (GLOSSARY, RUNBOOK) | `dashboard/src/api/types.ts:909` "No outcome recorded"; `routes/tours/TourDetail.tsx:643` "Reopen tour", :851 "Closed automatically on {shortDate(tour.autoClosedAt)}"; `TourModals.tsx:469` title, :477 "Yes, reopen"; Past intro `ToursPage.tsx:603` |
| clock rule (GLOSSARY) | `toursModel.ts:201-225` `autoCloseDueAtMs` |
| live-mode dev runs the worker on hc-dev (RUNBOOK) | `scripts/dev.mjs:3-9`, :21, :541 (`tsx watch ... app/src/worker.ts`); RUNBOOK "Dev modes" table (`npm run dev` and `--mock` = real hc-dev); every clock-poll block in `worker.ts` is unconditional |
| seeds (spec F5) | `app/src/lib/seed/matrix.ts`: upcoming days :907-910 and branch :953-956, past days :911-916 and branch :957-963, `updatedAt: createdAt` :995, no-show mark :1071, toured / closed outcomes :1072-1079; `live.ts:357-396` three scheduled tours (times :108-120, `createdAt = updatedAt = now`, two carry `groupThreadId` :379 / :392); the live relay group `:295-316` (open `relay_group`, owner the tomorrow tour :311, no `close_nag_next_at`); `cast.ts:548-561` requested, `:799-817` toured + `move_forward` + `convertible: true`; `app/scripts/db-seed.ts:24` defaults to lean |

## 4. `npm run issues`

Run from the worktree root after the four issue edits (and once more after a
wording fix), exit 0, no warning lines - the validator printed no
`warning(s):` block. Output (the script's U+2192 arrow and U+00B7 separators
are quoted here as `->` and `,`):

```text
[issues] 362 open, 193 closed, 555 total -> docs/issues/INDEX.md
[issues] open by severity: 7 high, 146 med, 209 low
```

Baseline before any edit: `362 open, 192 closed, 554 total`, `147 med`, `208
low`, no warnings - the deltas are exactly one med issue resolved and one low
issue added. `docs/issues/INDEX.md` was regenerated and is not committed
(gitignored, `.gitignore:62`).

## 5. Divergences from the plan, and why

Binding corrections applied: 8 (`resolved:` under `status:`, the
`**Resolution (<date>, feat/tour-auto-close).**` title, `**Update 2026-10-04.**`
in the range issue's own style, `**Update (<date>, feat/tour-auto-close).**`
in the precondition issue), 9 (template comment block deleted, enums valid,
id == filename, refs live), 10 (RUNBOOK placement and shape), 12 (GLOSSARY
shape, spot and parenthetical order); drift 3a (worker docs), 3b (writeup
line), 3c (F5 wording), 3d (ASCII). Corrections 11 and 13 belonged to S8 / S5
(done there).

Against the plan's literal text:

1. Dates: every `resolved:` / `created:` / Update / Resolution stamp is the
   run day, 2026-10-04 (the plan says 2026-10-01, the worklist 2026-10-02);
   feature dates in headings stay 2026-10-01, as the brief allows.
2. Task 10.2: the plan's "RESOLVED (2026-10-01) block" is the repo's
   `**Resolution (...)**` paragraph (correction 8). The new issue is wider
   than the plan's one sentence: the three open paths (ruling F1) and the F2
   paragraph (ruling F2), as the worklist directs.
3. Task 10.3: the plan's "deploy notes section" does not exist; the heading
   is the brief's `### Tour auto-close (2026-10-01): NOTHING is owed - ...`
   (correction 10), not "Tour auto-close (first production run)".
4. Task 10.1: the parenthetical is "(tour auto-close, 2026-10-01, Sam's item
   18)" (correction 12), not the plan's "(Sam's item 18, 2026-10-01)".

Additions within the brief's latitude (each verified in section 3):

5. RUNBOOK: a "Nothing to apply" bullet that makes the heading concrete; the
   first-deploy fallback (no `lastMarkedAt` yet, so any recent write keeps a
   tour open); the two INFO log lines; the dev note that a live-mode
   `npm run dev` can run the first sweep against dev before the deploy; the
   chip bullet also says a tour closed from scheduled loses its "Scheduled"
   chip.
6. The new issue: the "no close-nag armed" consequence and the
   claim-to-pointer window the suggested claim condition alone would leave
   (both from reading `autoCloseIf`, `armRelayCloseNagIfOpen` and
   `openTourGroup`; not exercised by a test).
7. The range issue's update gives this branch's line numbers rather than
   rewriting the body's or the frontmatter's (they are main's and still true
   there).
8. Spec F1 (5.3) says "apart from this sweep's own close", so the corrected
   sentence is true of every writer; both spec corrections carry a short
   "(Text corrected 2026-10-04, ruling F1 / F5 ...)" marker. The F5 bullet
   cites the cast's requested tour (`cast.ts:548-561`) beside the convertible
   one, and calls the matrix's no-shows "the `no_show` pair" so the old
   no-shows-only wording is not repeated.

## 6. Observations for the orchestrator (no action taken)

1. Live-mode local dev runs the sweep against the shared dev tables. `npm run
   dev` (and `--mock`) starts a worker on the machine against the real
   `hc-dev-` tables, and the auto-close block in `worker.ts` is unconditional,
   so the first such session that lasts 15 minutes on ANY checkout with this
   feature - this worktree included, today - closes every overdue dev tour
   silently, possibly before the dev deploy and before Cameron has previewed
   anything. The RUNBOOK entry now says so; worth one handback line. Hermetic
   lanes are unaffected (lean seeds no tours; first tick at 15 minutes).
2. The RUNBOOK's "Past tab has been live in production since 2026-09-28" is
   spec 13's statement, not a code fact; it is consistent with the
   2026-09-28 production deploy recorded for the share-skip fix. If the Past
   tab is not in production, the BEFORE recipe cannot be run there.
3. Pre-existing RUNBOOK staleness left alone (drift 13, out of scope): "One
   interval drives five due-row polls" omits the journal sweep
   (`worker.ts:523`, so six shared-cadence polls), and the "Worker clock
   polls" intro still says "60-second" polls (30 s since 2026-08-16).
4. `tours-patch-status-precondition`'s title ("has no expected-status
   precondition") now reads half-stale - the server has one; the client still
   cannot pass the status it saw. Left as is (status stays open; the update
   block explains).
5. The suggested fix filed for the relay-open race (a status condition on the
   claim) closes the read-to-claim window only; the issue names the remaining
   claim-to-pointer window and how the sweep could skip a `provisioning:`
   sentinel. A design choice for whoever takes the issue.
6. Gate 5 has nothing to lint for S10 (no `.ts` / `.tsx` / `.js` / `.mjs` /
   `.cjs` file touched).

Nothing in S10 is left undone. S11 (main sync, the five gates, self-QA,
handback) is the orchestrator's.
