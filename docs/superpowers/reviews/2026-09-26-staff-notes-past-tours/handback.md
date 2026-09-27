# Handback - feat/staff-notes-past-tours (Staff notes on the tenant file, #22; Past tab on the Tours page, #18/#20)

Date: 2026-09-27
Orchestrator: Fable 5.1 (build orchestrator), resumed 05:29Z after the first
orchestrator died on the planner's API limit at 03:36Z (infra tier; nothing
committed was redone; zero budget-consuming recoveries; zero cold misfires
across 12 fresh foreground dispatches).
Branch `feat/staff-notes-past-tours` at `W:\tmp\staff-notes-past-tours`,
cut from main @0dafe3c1. Records: this directory. Run state (ledger,
heartbeat, gate logs): `.superpowers/sdd/` (ignored).

## 1. The mission, restated in plain text

Two independent things on one branch, both staff-only, no tenant- or
landlord-facing change, no message-catalog copy, no infrastructure:

Part 1. A tenant's contact file gets a second notes card, "Staff notes",
directly above the existing "Preferences & notes" card. It is one free-text
box staff type into by hand and edit in place (a textarea with Save and
Cancel); it shows "Last edited <date>" while it holds text. The AI never
writes into it and never reads it; the existing card and its "+ Add" are
untouched; landlord, partner, unknown and team-member files get no card.
Server side: a `staff_notes` string on the contact record, accepted on the
existing PATCH route, with a server-stamped `staff_notes_updated_at`.

Part 2. The Tours page gets a third tab, Past, at `/tours/past`, between
Active and Closed. It lists, from the last 90 days through the end of today,
the tours that still need a human decision: "Not marked" (time passed, still
scheduled), "Needs outcome" (toured, no outcome), "Needs placement" (toured,
move-forward decided, no placement), and "No show" - most recent first. A row's
"Mark toured" marks that tour toured; a row's "Record outcome" opens the tour
page's existing outcome dialog through a `?outcome=1` deep link; the row links
to the tour page, whose back arrow returns to Past. Staff can tick several
"Not marked" rows and mark them toured in one go: one PATCH per tour,
sequential, each tour re-read just before its PATCH so a tour a colleague has
since canceled, marked no-show or rebooked is skipped and says so. Nothing
closes on its own, nothing sends a text or a reminder, and no status changes
except through these clicks or the existing tour-page flows.

## 2. Every question I would have stopped for, with the answer I assumed

The spec's section 9 (Q1-Q14) lists the planner's own calls; these are the
orchestrator's, taken under the overnight rule and recorded as they were made
(`research-worklist.md`, `review-r1-adjudications.md`, `review-r2-adjudications.md`):

| id | the question | the answer assumed |
|---|---|---|
| OD-1 | Adding `/tours/past` breaks gate 2: `e2e/performance/routes.test.ts` pins every App route as a profiler surface (31 exactly) or an explicit exclusion. Register a 32nd surface (changes Cameron's `perf:pages` contract and its human-run self-QA) or exclude? | EXCLUDE with a stated reason (commit `0ad6200a`) and file `perf-pages-tours-past-surface` (improvement, low) so it can be registered by day. |
| OD-2 | Should an untouched Save that differs only by leading/trailing whitespace send a PATCH (the server trims, so it would re-stamp "Last edited" for no text change)? | No: the no-op compare trims both sides; the request still sends the raw draft. |
| OD-3 (superseded) | Where does the bulk batch's busy flag live so EVERY mark control stays disabled across a tab switch? | First page-owned (fix wave 1 then found a route-change gap, A-1); FINAL: a module-scoped store in `ToursPage.tsx` - one batch per browser tab, across tab switches AND route changes; a full page reload ends it. Test-only reset `resetBulkBatchStoreForTests`. |
| OD-4 | Is the spec's global "thread-store outbound count unchanged" proof enough, given the fake's store persists across reseeds? | Keep it AND add the suite's per-party idiom (`getOutboundTo` for the tenant and the landlord with a `since`). |
| OD-5 | Should the two new specs keep the house-style `process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174'` fallback (57 specs have it; unreachable under `npm run e2e`)? | Yes, house style; the repo-wide fail-loud change is its own work (C-8 in the handback eyes). |
| OD-6 | `toLocaleTimeString` emits U+202F before AM/PM on ICU 72+ hosts; normalize? | Yes: `whenLabel` maps U+202F/U+00A0 to a space (repo convention `inboxTime.ts`), page and tests. |
| OD-7 | Past rows had ragged right edges (a card with a checkbox+button, one with a link, one with nothing); the spec does not require alignment. Fix? | Yes (product eye): every row carries a fixed lead slot and a fixed 8.5rem action slot so cards align; the resulting mid-width name truncation (R2-1) is closed by a Past-only stacking rule at panes up to 840px. |
| X-1 / F-9 | Key the card by `contactId` so editor state can never outlive its contact? | Yes, as a DEFENSIVE key: R2 showed ContactDetail already unmounts the file pane on a contact switch, so today it changes nothing (comments say so). |
| F-8 (A-3) | May the build fix merged code outside the spec's file list - `useContact.setContact` committing a stale contact after the page switched contacts (a permanent spinner on the next contact; the card is the most exposed caller)? | Yes: a one-line guard (`prev.forId === contactId`), red-first proven, protecting every caller - the class of surgical fix Cameron delegates. |
| F-10 (A-4) | An untouched Save after a background refetch moved the prop would silently revert a colleague's note. Add conflict detection? | No optimistic concurrency (spec Q12); the no-op compare uses the baseline captured at edit start, so an untouched Save never sends; an edited Save is last-write-wins as specified. |
| A-2 | The re-read-then-PATCH window is real (canceled -> toured and no_show -> toured are 200 with a "Tour took place" milestone; a rebooked ladder is swept). Add a server precondition? | No (spec Q14); FILED `tours-patch-status-precondition` (improvement, low) with the ConditionExpression design. |
| 840px | Fix wave 2 measured the name still cut by 1-8px in 801-835px panes at its 800px threshold. | Widened to 840px (commit `9382e0c7`). |

Everything else was decided by the spec; no infra, dependency, deploy or
production write was needed, so no STATUS: QUESTION was raised.

## 3. Per work-map / spec item

| item | status | where |
|---|---|---|
| S1 spec 3.1-3.4 app: `staff_notes` + `staff_notes_updated_at` on `ContactItem`, PATCH allowlist block after `notes`, 400 `staff_notes must be a string`, server stamp before the write, no provenance; create paths, `toProfile`, `applyExtraction`, prompt untouched; 8 tests | shipped | `8c428d79` (`app/src/repos/contactsRepo.ts`, `app/src/routes/contacts.ts`, `app/test/contactStaffNotes.test.ts`) |
| S2 spec 3.5-3.7 dashboard: additive types; `StaffNotesCard` (+css +11 tests); TenantFile renders it directly above Preferences & notes, tenants only; ContactDetail passes `setContact` | shipped, deviated OD-2 (trimmed no-op) | `07a53864`, `283d4d1f`, `c4dd9c95`; fix waves `547b9299`, `c21f0f07` (baseline compare F-10; defensive key F-9) |
| S3 spec 5 Playwright Part 1: `tenant-staff-notes.spec.ts`; `contact-detail.spec.ts` Notes locators scoped to the dialog | shipped, plus a card-level 360px overflow check (D1-R1) | `c8d48fd5` |
| S4 spec 4.2-4.3 data: `pastToursDateRange`, `selectPastTours`, `pastState`, `usePastTours` with `reload` / `reloadFailed`; 16 tests | shipped | `2bac788c` |
| S5 spec 4.1, 4.3-4.5 page: `view` prop, three tabs, Past rows with date-time labels, actions, sequential re-read-then-PATCH bulk runner in a Past-only child, vanished-result blocks, refresh alert, App routes (no keys) | shipped, deviated OD-3/OD-6/OD-7 and the gate-2 exclusion OD-1 | `c39989fe`, `0ad6200a`; fix waves `5598be78`, `f3d8ca0b`, `7f7d39c3`, `3883d084`, `57bdfe66`, `9382e0c7` |
| S6 spec 4.6 tour page: `?outcome=1` opens the dialog once from the state initializer, strip carries `location.state`; back arrow honors `state.back` in {`/tours`, `/tours/past`, `/tours/closed`} | shipped | `c4de3fe4` |
| S7 spec 5 Playwright Part 2: `tours-past.spec.ts` | shipped, plus `test.slow()`, per-party no-send checks, region-level and mid-width pins | `46305bf8`; pins `f3d8ca0b`, `57bdfe66` |
| spec 3.8 glossary, spec 8 six issues | already on the branch from the design phase | `2e6a873a`..`a0fa0160` |
| spec 4.7 invariants (no write on load/select/view change; PATCH only when current status is `scheduled` and the time unchanged; no send; nothing closes) | shipped and proven live (section 7) | - |
| spec 4.8 narrow width | shipped; 360px measured live at every layer | - |
| spec 6 non-goals | honored: no calendar, no bulk close/outcome, no no-show exit, no timeless rows, no card on other kinds, no prompt/catalog/import/seed/public change, no server precondition | - |
| skipped | nothing | - |

## 4. Gates on the FINAL commit (bare, from the worktree, after the ONE main sync)

Main sync: `git merge main --no-edit` -> `Already up to date.` (main is still
`0dafe3c1`; the branch is 44 commits ahead; drift 0 at handback).

Final gate run on `03768233` (the code head `9382e0c7` plus the self-QA
record; every later commit is records only), script
`.superpowers/sdd/gates-p6.sh`, logs `.superpowers/sdd/logs/p6-*.log`:

1. `npm run typecheck` -> EXIT 0 (10:34:08Z-10:35:16Z; every workspace).
2. `npm test` -> EXIT 0 (10:35:16Z-10:39:21Z), per workspace: app
   `Test Files 376 passed (376)` / `Tests 7207 passed | 1 skipped (7208)`;
   dashboard `206 passed (206)` / `3425 passed (3425)`; e2e (vitest)
   `21 passed (21)` / `499 passed (499)`; fake-twilio `34 passed (34)` /
   `245 passed (245)`; fake-twilio-web `13 passed (13)` / `111 passed (111)`.
   Zero `[dynamoAdmin]` lines.
3. `npm run smoke` -> EXIT 0: `smoke-dist: OK - 1430 import specifier(s)
   across 252 emitted file(s) resolve under plain Node.`
4. `timeout 2700 npm run e2e`, run 1 -> EXIT 1: `1 failed` / `286 passed
   (25.9m)`. The one failure is
   `tests\dashboard-next\group-text-per-recipient-delivery.spec.ts:63:1 > a
   stalled leg is named on the bubble: the rows say WHICH member never
   confirmed` - `Error: the per-recipient rollup never settled at 2/3 LIVE
   (no reload) - either the stall was not armed or the SSE push is missing`
   after its 60 s poll. Diagnosis, per the red-baseline protocol: the spec
   and its whole chain (group texts, delivery receipts, SSE) are untouched by
   this branch; it passed in the P3 full run on the same paths; the isolated
   re-run of the FILE passed - `1 passed (27.1s)`, the test 5.7 s; the
   signature is the OPEN issue `group-reply-live-rollup-full-suite-flake`
   (reopened 2026-09-26 by another non-messaging branch under the same
   conditions); another mission's full e2e was live on lane 15 for the whole
   run. NEW evidence for that issue, appended to it in this commit: the
   captured app log shows two `delivered` receipts for the same provider SID
   both "lost a race (regressed)" and a `sent` receipt "skipped (would
   regress)", so the stored per-recipient state never reached 2/3 - a
   transition-race lead, not an SSE one.
   Run 2, same commit `03768233`, `timeout 2700 npm run e2e` (11:10:08Z-11:36:47Z,
   the other mission's e2e still live) -> EXIT 0: `287 passed (26.6m)`, zero
   failures, zero `[dynamoAdmin]` lines. So every one of the five gates is
   green on ONE commit; run 1 is reported beside it, not excused.
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
   -> EXIT 1 with `3 problems (3 errors, 0 warnings)`, ALL pre-existing by
   baseline comparison (the same 16 pre-existing touched files checked out at
   the merge base `0dafe3c1` and linted with the same command: `3 problems (3
   errors, 0 warnings)`, the same three rules in the same files):
   `dashboard/src/routes/contact/TenantFile.tsx` `@typescript-eslint/no-unused-vars`
   (`FieldSource`, line 14 at base -> 15); `dashboard/src/routes/tours/TourDetail.tsx`
   `react-hooks/purity` (`Date.now`, 269 -> 304); `dashboard/src/routes/tours/useTours.ts`
   `react-hooks/set-state-in-effect` (`useClosedTours`, 116 -> 125). No new
   lint error in any touched file; every NEW file is clean.

Pre-review run (P3, on `c45e7159`, for the record): typecheck 0, test 0,
smoke 0, e2e 0 `287 passed (22.9m)`, lint the same 3 baseline errors.

Known flakes: the named-flake list is empty; the one red spec above is the
open issue's signature, isolated green, both runs reported. No
`[dynamoAdmin]` line in any run.

## 5. Review rounds, findings, adjudications

- Research (4 readers, `research-*-findings.md`, merged in
  `research-worklist.md`): 1 BLOCKING outside the plan's file list (the gate-2
  route pin, OD-1), 5 SHOULD-FIX (a vacuous 360px check, a typecheck error in
  a planned test, the orphan recipe, the `e2e:restart` fallback, `test.slow`),
  the rest notes - all adopted.
- R1 spec-conformance (`review-r1-spec-conformance.md`): CONFORMS, 0
  BLOCKING, 2 SHOULD-FIX (C-1 360px checkbox stranded; C-2 two tests weaker
  than spec 5), 7 NOTE. R1 adversarial, plan-blind (`review-r1-adversarial.md`):
  0 BLOCKING, 3 SHOULD-FIX each probe-reproduced (A-1 batch state lost on a
  route change; A-3 stale `setContact` pins the next contact; A-4 untouched
  Save reverts a colleague's note), 3 NOTE (A-2 the re-read window, A-5 the
  unpaged range query, A-6 the 100 KB body bound). Adjudications and the
  fix list F-1..F-11: `review-r1-adjudications.md`. Fix wave 1
  (`fix-wave-1-report.md`): every item red-first where a pin was specified;
  F-8/F-9/F-10 shown red with the fix reverted; 1651/1651 in the two
  dashboard directories; the F-1 e2e pin shown red with the CSS reverted.
- R2 fresh re-review with the re-review charge (`review-r2-rereview.md`): 0
  BLOCKING, 1 SHOULD-FIX (R2-1: OD-7's slots cut tenant names in 561-760px
  panes - a regression of my own decision, measured), 4 NOTE; fix wave 9
  correct / 2 plausible-but / 0 wrong; four adjudications contested and all
  four accepted (`review-r2-adjudications.md`). Fix wave 2
  (`fix-wave-2-report.md`): the stacking rule + a 960px no-clip e2e pin (red
  without the rule), the runner's try/finally + a malformed-re-read pin (red
  on the old runner: the flag wedged), the comment correction. The
  orchestrator cold-read the delta and widened the threshold to 840px.
- Recorded, not fixed (named for Cameron's eye): C-5 per-block result roles
  (plan-prescribed, AT-equivalent); C-7(ii) a batch that straddles a view or
  route change never shows its results (spec 4.5 wording); C-8 the `:5174`
  fallback reaches a reseed on a stray non-`npm run e2e` invocation
  (repo-wide, 59 files); A-6 a body over 100 KB renders the generic "Try
  again" alert forever (spec Q1: no cap); R2-4 residue: a request that never
  settles holds the batch flag until it settles (hosted envs bound it at
  CloudFront's 30 s); R2-5 a background refetch that started before a save
  can land after it and briefly show the old note (pre-existing class,
  every in-place `setContact` caller); two perf-ledger citations
  (`routes.ts` App.tsx / TenantFile.tsx) were already stale on main.

## 6. Main drift, issues, files, commits, delta

- Main drift: 0 behind at handback (`git rev-list --count HEAD..main` = 0).
- Issues on the branch (8): the six from the design phase -
  `extraction-prompt-read-staff-notes`, `staff-notes-on-landlord-partner-files`
  (+ the retype note), `tours-scheduled-range-query-unpaginated`,
  `past-tab-timeless-toured-tours`, `past-tab-no-show-rows-need-an-exit`,
  `tour-conversion-pending-placeholder-view-link` - plus two from the build:
  `perf-pages-tours-past-surface` (OD-1), `tours-patch-status-precondition` (A-2).
- Code files (25): app 3, dashboard 17, e2e 5 - `git diff --shortstat main...HEAD -- app dashboard e2e`
  = 25 files changed, 3049 insertions(+), 75 deletions(-). Whole branch incl.
  docs: 70 files, +14770 / -77. No off-limits file touched;
  `dashboard/src/api/types.ts` +10/-0; `client.ts` / `endpoints.ts` untouched.
- Code commits (in order): `8c428d79` S1; `07a53864` `283d4d1f` `c4dd9c95` S2;
  `c8d48fd5` S3; `2bac788c` S4; `c39989fe` `0ad6200a` S5; `c4de3fe4` S6;
  `46305bf8` S7; `5598be78` `f3d8ca0b` `7f7d39c3` `2560dbaf` `547b9299`
  `dd06c7f1` fix wave 1; `3883d084` `57bdfe66` `c21f0f07` fix wave 2;
  `9382e0c7` 840px. Records commits: `722deae7` research, slice reports
  `1367af79` `8f3bc9c5` `d2ea1f60` `5561400d` `d0878018` `57cac656` `08d741c0`,
  issues `1019f2cd` `c45e7159`, reviews `94f89929` `359e82c8` `6a82427e`
  `a5b32c6a`, self-QA `03768233`, this handback (last).
- Every commit carries a `Co-Authored-By` trailer (Opus children name Opus;
  the orchestrator's name Fable 5.1); every added line is ASCII (the `tr`
  check prints 0 over the whole code diff).

## 7. Live self-QA (orchestrator-driven; `self-qa.md` has every number)

Hermetic `e2e:session` on lane 13 (`appCommit` 9382e0c7), driven with the
plugin Playwright MCP (the project MCP's Chromium build is not installed;
installing one is a download). Eleven screenshots under
`W:\AI Projects\Housing Choice\HC Application\.playwright-mcp\staff-notes-past-tours-01..11-*.png`.
Proven at the boundary: the Save sends EXACTLY `{"staff_notes": ...}` and the
response carries the server stamp; the clear sends `{"staff_notes":""}`; the
Past load is ONE range read with the spec's window
(`from=2026-06-29T04:00:00.000Z&to=2026-09-28T03:59:59.999Z`) and no write;
the bulk mark is `GET /api/tours/:id` -> `PATCH {"status":"toured"}` -> the
reload read, no other write, 0 outbound in the fake's thread store after a
settle; the deep link opens the dialog with the URL stripped and
`history.state.usr.back === "/tours/past"` kept; the back arrow lands on a
fresh Past view; a plain load opens no dialog. Measured layouts: 360px
tenant editor with zero overflow at document / main / pane / card; Past rows
at 1280 (aligned 290-1112), 960 (stacked, whole names, pane 672) and 360
(checkbox inside its card's span, action wrapped under, no blank action
line). Console: 0 errors, 0 warnings. Session stopped, tables dropped, lease
released, ports proven free.

## 8. Things for Cameron's eye (not blocking)

- The Past view also issues the Active window's two reads (page-level
  `useTours`, as the Closed tab always has); the profiler's `/tours` and
  `/tours/closed` contracts are unchanged.
- A no-show row has no way off the list until it ages out (spec Q11, issue
  filed); a not_a_fit recorded without close is invisible (spec Q3, existing
  issue); a `toured` tour with no date never appears (spec Q10, issue filed).
- On a past-dated still-scheduled tour the RemindersPanel shows a skipped
  "Day before" rung whose preview says "tomorrow" (pre-existing copy).
- Tenant-based custom kinds (a "Case worker" on the tenant base) get the card
  under the literal `type === 'tenant'` gate (research D1-R4).
- A tenant retyped to another kind keeps its stored staff notes unrendered
  (issue note added).
- The spec's 2.1 prose has two wrong facts that change nothing here: `notes`
  is not a provenance field, and the seeds write `preferences_notes`, not
  `notes` (research N1, N2).

## 9. Verdict

MERGE-READY on `feat/staff-notes-past-tours` (`W:\tmp\staff-notes-past-tours`):
the gated tree is `03768233` (code head `9382e0c7` + the self-QA record); the
branch tip is the records commit that follows it (this handback + the flake
issue's recurrence note; its hash is quoted in the handback message), which
touches no code. 0 behind `main` (`0dafe3c1`), UNMERGED (human gate). NO
infra, dependency, deploy, seed-world or catalog change; NO post-merge
operation owed; nothing is broken until anything is applied. Cleanup
(worktree/branch, doc stamping) only on an explicit go. Merge command
(PowerShell, from the main checkout): `git merge --no-ff feat/staff-notes-past-tours`.
