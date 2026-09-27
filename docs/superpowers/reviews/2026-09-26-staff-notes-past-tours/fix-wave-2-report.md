# Fix wave 2 report - feat/staff-notes-past-tours

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Wave base: `6a82427e` (the R2 records commit). Wave head: `c21f0f07`, plus this
report's own commit.
Implementer: fix-wave-2 child, Claude Opus 5.5 (1M context).
Work order: `review-r2-adjudications.md`, "Fix-wave-2 list" F2-1..F2-3.

Status: DONE. All three items landed. Both pins the list specifies were shown
RED before GREEN:

- the F2-2 unit pin, on the unchanged runner;
- the F2-1 e2e pin, in the real browser with the new CSS block removed from
  the working tree (uncommitted).

F2-3 changes comments and one test title only.

Byte-exact output behind every quote below is in the ignored run state
`.superpowers/sdd/fix-wave-2-reference.md`: failure blocks, the DOM dump, the
probe rows, stop output, blob hashes and ASCII counts. Raw logs are
`.superpowers/sdd/logs/fw2-*.log`; screenshots are
`.superpowers/sdd/fw2-shots/`. File:line citations are at `c21f0f07`.

## Commits

| hash | one-liner |
|---|---|
| `3883d084` | fix(dashboard/tours): a malformed re-read reads Could not check the tour, and the Past batch flag always clears (F2-2; R2-4) |
| `57bdfe66` | fix(dashboard/tours): a Past card stacks its identity over its meta in panes up to 800px, so mid-width panes keep the tenant name whole (F2-1; R2-1) |
| `c21f0f07` | docs(dashboard/contact): the Staff notes card's key is defensive - ContactDetail unmounts the file pane on a contact switch today (F2-3; R2-3) |

The wave touches exactly the six files in scope (143 insertions, 37
deletions): `ToursPage.tsx`, `ToursPage.module.css`, `ToursPage.test.tsx`,
`TenantFile.tsx`, `TenantFile.test.tsx` and `tours-past.spec.ts`.

Before every commit:

- a bare `git status --porcelain` listed only that commit's paths;
- the MERGE_HEAD probe printed nothing;
- the added-lines ASCII command printed 0 for every staged file. It was
  re-computed afterwards per commit from `git show`: 0 for all six files.

Paths were staged explicitly. Every commit carries the
`Co-Authored-By: Claude Opus 5.5 (1M context)` trailer.

## Per finding

### F2-1 (R2-1) - a Past card stacks in panes up to 800px

What changed in `dashboard/src/routes/tours/ToursPage.module.css`:

- `:380-399` is a Past-only `@container (max-width: 800px)` block. It repeats,
  rule for rule, the four stacking declarations of the page-level 560px block
  (`:200-220`, unchanged). They are scoped to `.pastRow > .row` and to its
  `.main`, `.property` and `.meta` descendants.
- The comment above it (`:370-379`) says why:
  - the two fixed slots make a Past card about 170px narrower than the pane;
  - the 560px rule was sized for an Active row's full-width card;
  - 800px rather than 760px, because 761-800px still cut the name.
- The lead and action slots are untouched. Only the Past 560px block
  (`:401-416`, unchanged) wraps the row.

E2E pin, `e2e/tests/dashboard-next/tours-past.spec.ts:134-154`. It sits after
the row checks and before the pre-batch 360px block (now `:156-176`):

- the viewport is `MID_960`, 960x800, declared with its pane arithmetic at
  `:38-42`;
- the three rows are listed, and the three card links are counted first, so
  the check can never pass on zero matches;
- `evaluateAll` over every card link collects each descendant with
  `scrollWidth > clientWidth`, as `tag.class: text`;
- the array must be empty; the message names the viewport and the measured
  pane width;
- then `WIDE_RESTORE`.

The spec header gained one clause (`:18-21`).

RED - e2e run 1, exit 1:

- Setup: the 800px block removed from the working tree (uncommitted), the
  spec at its committed bytes, `--grep "Past tab"`.
- "Error: clipped text inside a Past row card at a 960px viewport (a 672px
  pane)", at `tours-past.spec.ts:153`, "1 failed".
- Six offenders, the tenant and the property of all three cards:
  - "span._tenant_dbgh7_157: Tasha Nguyen", three times;
  - "span._property_dbgh7_167: 1450 Joseph E. Boone Blvd NW, Atlanta, GA
    30314", twice;
  - "span._property_dbgh7_167: 88 Sycamore St, Decatur, GA 30030".
- The measured pane was 672px, as the adjudication predicted.
- The failure screenshot (`fw2-shots/1-red-960-block-removed.png`) shows R2-1
  as reported: every row reads "Tasha ..." and every address is cut.

Restore: `git checkout --` of the CSS file. `git diff --quiet` was clean and
the worktree blob equals HEAD's (`8576b736`).

GREEN - runs 2 and 4 (committed bytes, clean tree, trio grep), exit 0: "3
passed (13.5s)" and "3 passed (13.1s)".

Layout evidence - run 3:

- A TEMPORARY geometry probe was added to the spec and removed afterwards;
  the spec blob is back to `5648e2f2`, which is HEAD's.
- Measured on the real app, pre-batch. Row 1 is Not marked (checkbox and
  Mark toured), row 2 is Needs outcome (Record outcome), row 3 is No show.
- Tenant cells are visible/needed px for rows 1 / 2 / 3.

| viewport | pane | card | tenant | row 1 checkbox | row 1-2 actions |
|---|---|---|---|---|---|
| 849 | 561 | stacked, h104 | 95/95 each | inside its card's span, left of it | beside the card, inside its span |
| 960 | 672 | stacked, h104 | 95/95 each | same | same |
| 1024 | 736 | stacked, h104 | 95/95 each | same | same |
| 1088 | 800 | stacked, h104 | 95/95 each | same | same |
| 1089 | 801 | side by side, h49 | 87/95, 111/111, 91/95 | same | same |
| 1100 | 812 | side by side, h49 | 89/95, 116/116, 94/95 | same | same |
| 1124 | 836 | side by side, h49 | 95/95, 128/128, 104/104 | same | same |
| 1150 | 862 | side by side, h49 | 108/108, 141/141, 117/117 | same | same |

- `<main>` overflow was 0 at every width.
- The property never clipped while stacked (288/288 and 201/201).
- Screenshots:
  - `fw2-shots/probe-960.png`, stacked: the full name, then the full address,
    then the date and chip on a third line; the checkbox is centered beside
    its card, and both actions sit beside theirs;
  - `fw2-shots/probe-1089.png`, an 801px pane: "Tasha Ngu..." and "Tasha
    Nguy..." on the two long-address rows.
- The F-1 pin (the checkbox within its card's span at 360px) passed in runs
  2, 3 and 4.

### F2-2 (R2-4) - the guard phase is one try, and the flag always clears

What changed, all in `markToured` (`dashboard/src/routes/tours/ToursPage.tsx:424`):

- (a) The guard phase is one try (`:440-447`):
  - it holds the re-read and the status/time comparison;
  - the comparison is computed there into the boolean `unchanged` (`:439`,
    `:442-443`);
  - so any throw in the guard phase records the row as "Could not check the
    tour" (`:445`) and the loop continues. That covers a rejected GET, and an
    answer whose fields cannot be read.
  - The "Changed since the list loaded" branch now tests the boolean
    (`:448-451`).
  - A four-line comment says why (`:435-438`).
- (b) A try/finally now spans `:429-468`:
  - the try runs from `setBatchRunning(true)` (`:430`, its first statement)
    through the mounted-view reload (`:465`);
  - the results publish (`:459-464`) and the reload stay inside the try;
  - the finally clears the flag (`:467`).
- The closing comment gained three lines (`:469-471`). They say that the
  finally is the flag's one release point, reached on every path, and that
  "A hung request still holds the flag until it settles." The rest of the
  comment is unchanged (`:472-480`).

Unit pin, `ToursPage.test.tsx:1108-1133`:

- Setup: two Not-marked rows; `getTour` resolves to undefined (`:1115`); a
  click on p1's "Mark toured: ..." button.
- The p1 row's alert reads "Could not mark toured: Could not check the tour"
  (`:1120`).
- `patchTour` is not called, and `reloadPast` is called once.
- Both row buttons, the select-all box and every checkbox are enabled again.
- "Mark toured (0)" is disabled, and ticking p1 makes "Mark toured (1)"
  enabled. So (0) was disabled only because nothing was selected.

RED, on the unchanged runner - `npx vitest run
src/routes/tours/ToursPage.test.tsx -t "MALFORMED re-read"`, exit 1:

- "Tests  1 failed | 39 skipped (40)".
- "TestingLibraryElementError: Unable to find role="alert"", at
  `ToursPage.test.tsx:1120:31`.
- The DOM dump shows the p1 row's checkbox and its "Mark toured" button still
  `disabled=""` when the wait expired: the flag wedged.
- Also:
  - "Vitest caught 1 unhandled error during the test run.";
  - an "Unhandled Rejection": "TypeError: Cannot read properties of undefined
    (reading 'status')";
  - at `markToured src/routes/tours/ToursPage.tsx:441:19`, the old comparison
    line.

GREEN, same command - exit 0, "Tests  1 passed | 39 skipped (40)".

The whole file - exit 0, "Tests  40 passed (40)", with no unhandled error and
no act line.

### F2-3 (R2-3) - the key is described as defensive

What changed: comments and one test title. The key (`TenantFile.tsx:264`) and
every assertion are unchanged.

- `dashboard/src/routes/contact/TenantFile.tsx:253-261` - the comment above
  the keyed card now says:
  - a contact-to-contact navigation UNMOUNTS the pane and the card;
  - ContactDetail renders its spinner, not the file, while useContact derives
    "loading" for the new id;
  - so the key changes nothing today. It matters only if a future caller
    swaps the contact in place.
- `TenantFile.test.tsx:25-29` - the `fileFor` doc comment now says:
  - a rerender swaps the contact in place under a still-mounted TenantFile;
  - ContactDetail never does that today;
  - the key defends against a future caller that does.
- `:79` - the title now opens "defensive key: if the contact is swapped IN
  PLACE (ContactDetail unmounts the pane on a switch today), ...". The rest of
  the old title is kept.
- `:93-94` - the inline comment that also said "re-rendered, not remounted"
  now names the in-place swap as the case the key defends. This is R2-3's
  third site (`:90` at `359e82c8`).

Before rewording, the mechanism was re-read at HEAD:

- `useContact.ts:74-76` derives loading while `forId` differs;
- `ContactDetail.tsx:530-536` returns the spinner;
- `ContactDetail.tsx:1058` is TenantFile's only render site.

The code comment names the component and the hook, not line numbers, which
rot; this record carries the citations.

`TenantFile.test.tsx` alone: exit 0, "Tests  3 passed (3)".

## Verification summary (final bytes = `c21f0f07`)

Commands, run bare:

- `npx vitest run src/routes/tours src/routes/contact` (dashboard):
  - exit 0, "Test Files  81 passed (81)", "Tests  1652 passed (1652)";
  - run after F2-2 and again on the final bytes, with the same totals;
  - FW1 ended at 81/1651; the +1 is the F2-2 pin.
- act warnings:
  - the final run has 258 lines: ContactDetail 244, RemindersPanel 12,
    ContactCommsTab 2. That is identical to FW1's baseline and end.
  - The after-F2-2 run showed 259 (ContactDetail 245). That is run-to-run
    variance in `ContactDetail.test.tsx`, a file this wave does not touch.
  - `ToursPage` and `PastToursView` emit none in either run.
- `npm run typecheck` in dashboard: exit 0, after F2-2 and final.
- Root `npm run typecheck` (all workspaces, e2e included): exit 0, after F2-1
  and final.
- `cd e2e; npx vitest run support/viewport.guard.test.ts`: exit 0, "Tests  1
  passed (1)". The new per-element check does not trip the
  documentElement-idiom guard; the spec never names documentElement.
- Not run, per the work order: the full `npm test`, the full `npm run e2e`,
  smoke and lint.

E2E runs:

- Each was `timeout 900 npm run e2e -w @housingchoice/e2e -- --grep ...`,
  from the worktree root.
- Logs are `.superpowers/sdd/logs/fw2-e2e-run<N>*.log`.

| run | bytes | grep | exit | result line |
|---|---|---|---|---|
| 1 | 800px block removed (control), spec committed | Past tab | 1 | "1 failed" (the F2-1 pin, quoted above) |
| 2 | committed (HEAD `c21f0f07`), tree clean | trio | 0 | "3 passed (13.5s)" |
| 3 | plus a temporary geometry probe | Past tab | 0 | "1 passed (8.8s)" |
| 4 | committed, tree clean | trio | 0 | "3 passed (13.1s)" |

The trio grep is "Past tab|Staff notes card|editing a contact PATCHes". Runs 2
and 4 list `contact-detail.spec.ts:51`, `tenant-staff-notes.spec.ts:36` and
`tours-past.spec.ts:83` as ok.

Session lifecycle:

- Pre-start:
  - `npm run e2e:stop` exited 0, "[e2e-stop] no running session found;
    retained state is stale or absent - nothing to stop";
  - lane ports 10301/10311/10321/10331 had no listener before the start.
- `npm run e2e:session` ran as a background Bash command, on lane 13:
  - the ping answered `"dev":true`, `"lane":13` and `"appCommit":"c21f0f07"`,
    which is HEAD;
  - every run printed "reusing the live e2e:session on lane 13".
- No commit was made between the session start and the last run. The two
  temporary edits (runs 1 and 3) were restored with `git checkout --`. Each
  was proven blob-equal to HEAD before the next run.
- Process note - my readiness poller timed out: exit 1, "TIMEOUT waiting for
  the e2e session".
  - It handed Node the Git Bash path `/w/tmp/...`. Node on Windows resolves
    that to `W:\w\tmp\...` (ENOENT), so the poller never read `lane.json`.
  - The session itself was healthy: it printed ready and answered the direct
    ping above. This was not a harness fault.
- Stop:
  - `lane.json` was read first: launcherPid 66060, lane 13.
  - `npm run e2e:stop` exited 0 with "stopped session launcher 66060 (+
    children)", "dropped lane 13 tables (hc-local-13-*)", "released lane 13
    lease" and "stale owned session state cleanup complete".
  - The background session task then reported exit 1, because the stop
    tree-killed its launcher. That is expected; FW1 recorded the same.
- Proof:
  - `Get-NetTCPConnection -State Listen` found nothing on 10301, 10311, 10321
    or 10331; netstat confirmed it again while this record was written.
  - Launcher 66060, Vite 58768 and its esbuild 72504 are not running.
  - `session.pid` and `lane.json` are gone.
- Two process groups still name this worktree: the planner's transcript
  mirror and a watchdog loop. Neither is mine, and both were left untouched.
  No shared container was touched.
- The session and run logs have 0 `[dynamoAdmin]` lines, 0 error-level app
  lines and 0 5xx responses.

## Deviations from the list (and why)

1. F2-2 pin, two Not-marked rows rather than one:
   - "Every mark control enabled again" then also covers another row's button
     and checkbox. The flag is tab-wide, not the clicked row's.
   - The pin also ticks the row and asserts that "Mark toured (1)" is enabled.
     That proves "Mark toured (0)" was disabled only because nothing was
     selected.
   - Otherwise the pin is as specified.
2. F2-2 placement:
   - `setBatchRunning(true)` is the try's first statement; I read "everything
     from setBatchRunning(true)" inclusively.
   - So even a throw raised while notifying the store's listeners would still
     reach the release: the flag is set before they are notified.
3. F2-1 pin additions:
   - the three card links are counted before `evaluateAll`, because a
     zero-match `evaluateAll` returns an empty array and would pass vacuously;
   - the class is read with `getAttribute('class')` rather than `className`,
     which is SVG-safe;
   - the message names the viewport and the measured pane width;
   - the viewport is a named constant, `MID_960`, with its arithmetic;
   - the spec header gained one clause.
4. F2-1 RED ran only the "Past tab" grep (the one spec the CSS change
   reaches), not the trio.
5. F2-3 also rewords the inline test comment at `TenantFile.test.tsx:93-94`:
   - it made the same claim, and R2-3 named it (`:90` then);
   - the list's F2-3 line names only the header comment and the title.
6. Extra evidence, never committed: run 3's geometry probe. It was restored
   and verified blob-equal to HEAD (`5648e2f2`).

## For the next reader - least sure

- The 800px threshold leaves a narrow band just above it where the
  side-by-side name is still cut:
  - at an 801px pane, the two long-address rows show 87 and 91 of 95px;
  - at 812px they show 89 and 94;
  - from 836px the name is whole;
  - that is viewports of about 1089-1123px with the expanded sidebar
    (`fw2-shots/probe-1089.png`).
- This is the adjudicated trade: a threshold bounds the band but cannot
  remove it, and an Active row just above 560px truncates the same way.
  - For this seed, about 840px would close it.
  - Any fixed threshold still leaves a band for a longer name or address.
  - Not changed: the value is the orchestrator's.
- The pin's check is strict: `scrollWidth > clientWidth`, with no 1px
  sub-pixel tolerance (unlike `support/viewport.ts`).
  - Every stacked measurement read exactly equal (95/95, 288/288, 201/201) in
    runs 2-4 and in the probe, so it did not flake here.
  - If it ever flakes on another host or font, the fix is a 1px tolerance,
    not a threshold change.
- The pin measures one width (960px) and this seed's one tenant name. It
  guards the middle of the band, not its edges.
- F2-2 releases the flag on every path, with two limits:
  - A throw in the TAIL would still reject the voided promise as an unhandled
    rejection, after the finally ran. That is not reachable today: the tail
    is React setters and the reload slot.
  - A hung request still holds the flag until it settles. The client sets no
    timeout; in hosted envs CloudFront's 30s origin timeout bounds it. The
    code comment says so.
- The ContactDetail act-warning count moved by one between two runs of
  unchanged code (244 and 245). The count is not a stable baseline to diff
  line by line.
