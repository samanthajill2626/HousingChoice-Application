# Handback - feat/last-heard-from (Sam #3 last heard from + #27 follow-up status + C6)

Build orchestrator, MANUAL mode (top-level session), 2026-10-13.
Worktree `W:\tmp\last-heard-from`, branch `feat/last-heard-from`.
Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
(APPROVED rev 6 + section 14.7, added on-branch by the build review - see
"Decisions for Cameron"). Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` v3.

**VERDICT: MERGE-READY on feat/last-heard-from (W:\tmp\last-heard-from) at the
commit that adds this handback - all five gates ran on b8dc2181 and every later
commit is records only - 0 behind main @16ca96cc, UNMERGED (human gate).**

## Gates on the final commit (bare, from the worktree root)

Gate commit: `b8dc2181` (code identical to d902b515; the commits after it add
only records: the I1 audit, an issue file, this handback). `git merge --no-edit
main` -> "Already up to date."

| gate | command | exit | counts |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | - |
| 2 | `npm test` (no AWS_* exported) | 0 | app 475 files / 9978 passed + 1 skipped; dashboard 248 / 4697; e2e workspace 22 / 508; 34 / 275; 13 / 111; zero `[dynamoAdmin]` lines |
| 3 | `npm run smoke` | 0 | "smoke-dist: OK - 1695 import specifier(s) across 294 emitted file(s) resolve under plain Node." |
| 4 | `timeout 2400 npm run e2e` | run 1: 1; run 2: 0 | run 1: 358 passed, 1 failed (23.3m); run 2 (same commit, after an isolated re-run): 359 passed (22.4m) - see below |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (120 files) | 1 | ONE error, PRE-EXISTING: `dashboard/src/routes/contacts/ContactsList.tsx:208` react-hooks/set-state-in-effect - the identical error is at `:184` on main (baseline: `git show main:<file> \| npx eslint --stdin --stdin-filename <file>` -> the same 1 error). No new lint errors. |

Gate 4, both runs reported. Run 1 failed ONE test: `tours.spec.ts:217`
(self-guided scenario, test 349 of 359) timed out at "Team offers tour
windows" - `page.goto('/contacts/<id>')` returned and the page stayed BLANK for
100s. Diagnosed, not excused: the app server logged ZERO requests after that
navigation (no `/me`, no `/config.json`, no contact reads - every full
navigation in the run calls `/me` first, including one two seconds earlier in
the same test), so the dashboard bundle never ran and no feature code executed;
the 10 tests after it on the same stack passed; no Vite reload was logged. The
file re-run in isolation: 9/9 passed (the scenario in 7.0s). The full suite
re-run on the SAME commit: EXIT 0, 359 passed (22.4m), the same test green.
Artifacts of run 1 are preserved at
`W:\tmp\last-heard-from\.superpowers\sdd\e2e-runs\final-20261013-190830\`;
filed as `docs/issues/e2e-page-blank-spa-never-boots.md` (the environmental
signature, and what would decide a recurrence: a trace). The spec passed in
every other full run of this branch.

Earlier full run (Phase 3, on 1f298e64, before review): e2e EXIT 0, 359 passed
(20.9m) - also the C6 re-proof (`c6-full-run-reproof.md`).

I1 re-audit on the final tree: `i1-audit-final.md` - holds (the one writer
`touchLastHeardFrom` + the spec-named seed derivation; every later mention is a
read or the client-refusal list).

## Work map - shipped / deviated / skipped

| slice | status | notes |
|---|---|---|
| S1 attribute + 8 live touches + seams + importer + seed (1.1-1.14) | SHIPPED | `touchLastHeardFrom` (attribute_exists guard, normalized, pointer ids skipped, never throws); `attributeInbound` / `repoLookup`; paths 1-8 touch on fresh + deduped branches (echo check only on 1:1 / native group); both dev seams; importer stamp (`ApplyReport.lastHeardFromStamps`); seed derivation (lean: tenant-0001 = 2026-06-01T14:02:10.000Z, landlord-0001 = 13:45:00.000Z); `last_heard_from_at` refused from POST/PATCH. Divergence: masked voice paths log the touch error NAME only (an existing privacy test forbids lookup error text). |
| S2 backfill + RUNBOOK (2.1-2.2) | SHIPPED | `app/scripts/backfill-last-heard-from.ts`; lane-10 rehearsal planned 2, apply written 0 / skipped 2 (`backfill-rehearsal.md`); RUNBOOK section. |
| S3 outcome core (3.1-3.8) | SHIPPED, then amended by review | `listingSendOutcome.ts`, `deriveTourActivityAt`, `declined` + setDeclined / clearDeclined (counted rows only), requireComplete projection, `recordListingOutcomeEvent`, both GET projections (503 on a failed join), the outcome route, dashboard mirror + `setListingSendOutcome` (`{ row }`). Review changed the route's write order and supersession - spec 14.7. |
| S4 Tenants tab + header + perf (4.1-4.6) | SHIPPED | status facet (default all but inactive/placed, `_empty`), sort (heard / name), hidden-match hint, row line, header span (made non-clipping in review A-1), perf rebind + "No tenants match" terminal. |
| S5 roster cards (5.1-5.5) | SHIPPED | `SendRosterRow` / `SendRosterList`, four groups on the property card, URL-driven Schedule-a-tour (`?tour=new[&tenantId=]`, form keyed by tenant), contact cards (error row, client interestedMode, partner "Request a tour" link), Activity labels. Divergence (accepted): a DELETED contact's rows keep their actions (spec 14.3 B10 consistency). |
| S6 Matching review step (6.1-6.5) | SHIPPED | status / last heard projected; decline labels + degraded flag; C6 applied VERBATIM (3509ad35, tree-hash-equal to the patch); `annotate`; columns / order / declined rows / ASCII names. |
| S7 Follow up + endpoint + seam + pill (7.1-7.4) + 7.5 | SHIPPED | follow-ups builder (reads the recipient projection after review ADV-2), dev seam, Follow up tab, Properties pill. Added 7.5 (perf contracts for the new GET). Divergence: the builder uses the existing `contactDisplayName` (no new `contactDisplay.ts`). |
| S8 e2e (8.1-8.6) | SHIPPED | six spec files (four new + facets extension + listing-activity knowing rewrite); C6 full-run re-proof. |
| S9 docs (9.1-9.2) | SHIPPED | glossary (3 terms, refined for 14.7); C6 issue resolved; denormalize note; `tour-create-no-dedupe` stays open. |
| S10 | DONE | main sync (no-op), five gates, live self-QA + re-QA, I1 audit, this handback. |

Per-slice decision records: `slices/D1-report.md` .. `D12-report.md`; build
research + adjudications: `build-research/`.

## Review (two independent reviewers, continued across rounds - manual mode)

Reviewer A = spec conformance; Reviewer B = adversarial, PLAN-BLIND (no spec,
plan or worklist). Records in `code-review/`.

| round | A | B | resolution |
|---|---|---|---|
| 1 (whole branch) | 0/0/1/2 | 0/0/2/5 | fix wave 1: A-1 header clip, A-3 `saved` only after a write, ADV-2 follow-ups read the projection, ADV-3 create-before-clear, ORCH-1 heading name, comments; ADV-4..7 recorded (4 filed) |
| 2 (fix wave 1) | 0/0/1/3 | 0/0/2/3 | fix wave 2: DURABLE supersession (A R2-1), compare-and-clear on Interested (B R2-1), clear any read decline + 503 saved after a write (B R2-2, A R2-2), Undo-nothing not a write (B R2-3), Follow up resolves the returned row (B R2-4), 409 tour_type_required -> form (B R2-5) |
| 3 (fix wave 2) | 0/0/0/2 | 0/0/1/1 | fix wave 3: Undo compare-and-clear (B R3-1); limits documented (A R3-1, B R3-2); glossary (A R3-2); stale-card race filed |
| 4 (closure) | - | R3-1 closed, nothing blocks | - |

Adjudications: `code-review/adjudications-round1.md`, `-round2.md`, `-round3.md`.
No BLOCKER or MAJOR in any round. No open MINOR.

## Self-QA (live, hermetic lane 10, Playwright MCP)

`self-qa/self-qa.md` + 14 screenshots. PASS on: Tenants tab (default hides
placed, sort, hint, URL state); contact header at 360px (measured: the
"Last heard from" span stays whole); property Sent-to card (groups, Interested
route + form mode, Not interested / Undo); Tours > Needs booking; Follow up tab
(counts, longest-waiting first, Text, a reply removes the row, 360px wrap);
Properties pill; Review recipients (columns, order, declined unchecked,
annotate, 420px stack, C6 opens above at a short viewport); Activity +
timelines. Re-QA on the final code: Undo, durable supersession through the
Tours-page path, stale route mode falling through to the form, Follow up
returned-row state.

## Decisions for Cameron (orchestrator rulings, reversible)

1. **Durable tour supersession (spec 14.7).** Review round 2 showed that after
   "decline -> a later tour -> that tour canceled" the pair read Not interested
   when the tour came from the Tours page / Schedule form, but No reply yet when
   it came from the Interested button (which deletes the decline). Ruling, per
   D11's intent ("a tour created by a person after a decline means the tenant
   changed their mind, from any tour-creating path"): a tour CREATED after a
   decline keeps it superseded even after that tour is canceled / no-show /
   not-a-fit; a cancel MARK never supersedes on its own (staff canceling the tour
   BECAUSE of the decline keeps the decline). Consequence Sam may notice:
   canceling such a tour puts the tenant back on Waiting / the Follow up list,
   not under Not interested. Known limits (14.7): a reschedule/reopen after a
   decline is durable only while the tour qualifies; a tenant converted to a
   caseworker reads no tours. Reverting = `deriveTourActivityAt` + its tests.
2. **Interested write order (spec 14.7).** The route creates the tour BEFORE it
   clears the decline (spec 5.4 steps 3/4 reversed), clears with a
   compare-and-clear on the decline it read, and answers 503 `saved: true` for
   any failure after a write. Undo is the same compare-and-clear.
3. **Deleted contacts keep their card actions** (S5; spec 14.3 B10 consistency).

## Issues filed / resolved

Resolved: `contact-search-popover-below-viewport` (C6, 3509ad35).
Noted: `denormalize-contact-last-activity-for-ordered-paging` (stays open).
Filed (all low): `e2e-page-blank-spa-never-boots` (the gate-run sighting above),
`address-formatter-app-vs-dashboard-split`,
`share-retry-supersedes-decline`, `perf-world-lacks-last-heard-from`,
`mount-time-clocks-on-long-lived-surfaces`, `contact-card-undo-names-identical`,
`outcome-actions-act-on-server-read-decline`. Still open by design:
`tour-create-no-dedupe` (I3 - the Interested path dedupes its own creates).

## Not blocking - for your eye

- The placed tenant in a filter audience is still proposed (checked) on Review
  recipients - spec non-goal (#6's audience rules); the new Status column makes
  it visible.
- A fixture tenant created with `housingAuthority` in the POST body read back
  without it during self-QA (pre-existing create-route behavior, not this
  feature).
- Reviewer A briefly used the shared MCP browser during self-QA round 1; the
  affected checks were re-run on the final code.

## Post-merge - OWED (Cameron)

**Run the backfill on dev, then prod, after this deploys** (RUNBOOK section
"Last heard from: the backfill"): `npx tsx app/scripts/backfill-last-heard-from.ts --env dev`
(dry run), then `--apply`; then the same with `--env prod`. Until it runs,
every existing contact reads "Last heard from Never" and sorts last until its
next inbound text, call or email; Replied / Waiting are under-reported for
older sends. Idempotent and forward-only (a second apply writes 0).
No terraform / SSM / secrets / table or GSI change. No new dependency.

## Size

97 build commits on top of the docs-only branch head 25adc1ef (111 ahead of
main in all). Code + tests (app, dashboard, e2e): 130 files, +12136 / -542.
Docs + records + RUNBOOK: 75 files, +21266 / -1.
