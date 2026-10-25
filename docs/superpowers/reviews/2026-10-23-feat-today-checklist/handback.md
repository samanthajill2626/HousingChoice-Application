# Handback - today-checklist (tracker #31, "Today as the daily checklist")

MERGE-READY - gated at f082374f on feat/today-checklist
(W:\tmp\today-checklist); every later commit is docs/records only (S8
reports, this handback). 0 behind main (main @970a29b9, already contained -
no merge commit). UNMERGED (human gate). NO infra, no Terraform / GSI / table
change, no new dependency. Post-merge operator work is owed (section 8).

Built by the AUTO build orchestrator 2026-10-24 19:35Z - 2026-10-25 16:15Z
(paused ~03:11Z-14:00Z by the account's weekly usage limit). Records:
docs/superpowers/reviews/2026-10-23-feat-today-checklist/ (build-research/,
slices/, code-review/, this file).

## 1. Work map

| Item | Result |
|---|---|
| S1 the signal: last_reached_out_at, touchLastReachedOut, getRecipientDisplaysByIds consistentRead, recordStaffOutreach, getByIdConsistent, fakes | SHIPPED (299060f8..c831f78d) |
| S2 system_copy marker; W1 1:1, W2 Retry, W3 email, W6 outbound dial (post-response), W8 dev seams; no-stamp tests; inbound post-touch contact.updated; tour.updated on both create paths | SHIPPED (3ffa9abd..db412659) |
| S3 W4 team-post legs, W5 group text, W7 staff-edited intro; after-loop fresh-read conversation.updated; no-stamp tests | SHIPPED (59b58a6f..5e8d6504) |
| S4 Today server: Follow up core split (tab byte-identical), quiet shares, identify, tours_to_book, tours_today at/unitLabel, Unreplied removed, failure isolation | SHIPPED (5026891d..a2a49b64); review fixes FW1-2, FW2-1 |
| S5 dashboard Today: sections (5 rows, Show all), option C quiet shares, At a glance, help lines, All caught up, fallback, past tours oldest first | SHIPPED (621038fc..97f849f1); review / self-QA fixes FW1-1, FW2-2, FW2-3, FW3-1..3, FW4-1, FW5-1 |
| S6 backfill script app/scripts/backfill-last-reached-out.ts + tests + RUNBOOK entry | SHIPPED (6ca988a2..04307931); rehearsed on a hermetic lane (S7.15) |
| S7 e2e (new today-checklist spec, every spec pinning the old page, perf terminals), lane rehearsal, docs, live self-QA | SHIPPED (S7a 050878ac..1ea8c74f, S7b 1d9598d2..c7705789; self-QA f082374f) |
| S8 one main sync, five bare gates, gate report with the PR85 lines | SHIPPED (6f48a6eb: slices/S8-gates.md, slices/S8-report.md) |

Deviations, all recorded: the binding build WORKLIST (WL-1..WL-22,
build-research/WORKLIST.md) amended plan slice text after a 9-reader delta
research (3 BLOCKER, 2 MAJOR, 35 MINOR); S7 ran as two children (S7a/S7b);
S7.16 self-QA ran by the orchestrator; the review loop added FW1-FW5 (below).
No spec point was changed.

## 2. Gates on f082374f (S8, bare, real exit codes)

- 1 typecheck: exit 0.
- 2 `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test`: exit 0 -
  app "Test Files 533 passed (533)", "Tests 11406 passed | 1 skipped (11407)";
  dashboard 270 / 5573; e2e workspace 22 / 509; fake-twilio 34 / 275;
  fake-twilio-web 13 / 111. No [dynamoAdmin] line.
- 3 smoke: exit 0 - "smoke-dist: OK - 1747 import specifier(s) across 303
  emitted file(s) resolve under plain Node."
- 4 `timeout 2700 npm run e2e`: exit 0 - "377 passed (40.9m)"; no failed,
  flaky or skipped. Note: 40.9 min vs 17.8 min for the same suite at
  c7705789 - a slower host, within ~4 min of the 2700 s cap.
- 5 eslint on the branch's 116 .ts/.tsx/.mjs files: exit 1 with exactly ONE
  error, pre-existing - dashboard/src/routes/tours/useTours.ts:128:5
  react-hooks/set-state-in-effect, identical at the merge base 970a29b9
  (baseline-attributed). 0 errors from this branch. app/scripts/seed-smoke.mjs
  is checked by no rule (the config lints .ts/.tsx only).
- Earlier battery run1 at c7705789 (pre-review): all four 0, e2e 376 passed.

## 3. Size

118 commits since 970a29b9 (incl. the planner's spec/plan/records commits).
Code (app, dashboard, e2e, scripts): 118 files, +11409 / -1140. New modules:
app/src/services/staffOutreach.ts, app/src/services/quietShares.ts,
app/scripts/backfill-last-reached-out.ts, dashboard/src/routes/today/
TodaySection.tsx and QuietShares.tsx, e2e/tests/dashboard-next/
today-checklist.spec.ts, e2e/support/followUpFixtures.ts.

## 4. Review findings and resolutions

- R1 (spec-conformance: 174 CONFORMS / 6 PARTIAL / 0 MISSING; plan-blind
  adversarial: LOW 4, INFO 2; no HIGH/MEDIUM) -> FW1: a failed live refetch
  no longer wipes the page (refresh note), one Identify / relay opt-out row
  per person, four no-stamp pins, three drop-off pins, docs. Ruled no-change
  with rationale: R1A-3 (past tours label every row - spec 5.3), R1A-4
  (outbound attribution - spec 7.3 W1), R1A-6 (PR108), R1SC-4 (PR58 counts).
- R2 (fresh: LOW 2, INFO 1) -> FW2: Identify de-dupe MERGES instead of
  skipping (FW1 had kept the worse row), per-viewer state survives
  unavailable / fallback refetches, one fallback Identify row per contact.
- R3 (fresh: LOW 1, INFO 2) -> FW3: "All caught up" withheld on a failed
  past-tours reload, the AI line reopens at 5 rows, the fallback collapse
  keeps a label. Loop rule set: REGRESSION fixed, NOT A REGRESSION filed.
- R4 (fresh, closing; LOW 1 REGRESSION, INFO 1) -> FW4: unique React keys in
  every Today list (FW3 had left two fallback rows under one key = ghost
  rows); R4-2 FILED (below).
- R5 (fresh, focused on FW4): no findings - loop closed.
- Self-QA (section 5) -> FW5: long names wrap at a narrow pane (e2e geometry
  pin).
- Every fix wave was re-reviewed by a FRESH reviewer; every reviewer reproduced
  its findings with throwaway tests (deleted) and quoted the failing output.
  Nothing found loses, duplicates, strands or misdirects a send.

## 5. Live self-QA (S7-report.md "Live self-QA (S7.16)")

Two passes on hermetic lane 12 (prefix hc-local-12-, key hclane12, ping
dev:true, appCommit == HEAD). Desktop 1280: section order, bare headings,
subtitle and three help lines exact; Show all 6 / Show fewer; option C open
and fold; Tours today compact rows; full width (maxWidth none); no
horizontal scroll at 380 / 600 / 1024 / 1280 / 1440. Live: a staff text
dropped a quiet share in 459 ms with no reload and the viewer's open/fold
choices followed the property when it re-ordered; with /api/today refetches
aborted at the network boundary the refresh note appeared and every section
stayed, then cleared on the next good event. Pass 1 found long names clipped
at <=560 px (FW5); pass 2 re-measured clean. Screenshots: the worktree's
.playwright-mcp/ (gitignored).

## 6. Issues

- Filed: docs/issues/today-quiet-shares-read-cost.md (Today's per-load reads:
  the Follow up core, the uncapped requested-tours read, past-tours labeling;
  the GSI / non-consistent-read residue), docs/issues/
  today-past-tours-labeling-settle-window.md (R4-2: "All caught up" for one
  labeling round trip after a recovered past-tours reload; pre-existing shape).
- Resolved: fact-extraction-spec-vacuous-today-absence-checks.md (the AI
  absence checks now read server truth). Updated:
  imported-unknown-threads-surface-as-unknown-on-today.md (retitled - Today no
  longer shows those rows), public-signup-abuse-hardening.md.

## 7. For Cameron (not blocking - built per spec)

- Q-1: W3 stamps only the email's To contact ("the addressed contact"); a
  contact on CC is not stamped, so a CC'd caseworker can stay in Quiet shares
  after staff emailed them. Small follow-up if CC should count.
- On a shared or moved phone number, a staff text / call stamps the number's
  current holder (spec 7.3 W1 "judged recipient") while replies and the
  backfill use the thread's roster contact - the two halves of the quiet clock
  can name different contacts (rare; listed in the RUNBOOK entry).
- Residues recorded in the slice reports: pre-2026-09-24 automated rows lack
  `automated`, so a staff Retry of one stamps (R-1); W6 stamps findByPhone's
  first match on a duplicated number (R-2); ineligibility writes (staff DNC,
  phone edits, carrier flags) emit no event Today hears - same class as
  Not interested (R-3); Tours to book and the Quiet shares tour joins read
  GSIs, so spec 8's "appears live" can lag one refetch in prod (DynamoDB
  Local is synchronous, so e2e cannot show it).

## 8. Post-merge obligations (LOUD)

- POST-MERGE OBLIGATION: run the last_reached_out_at backfill AFTER the
  deploy - Cameron, dev then prod, dry run first (RUNBOOK.md "Last reached
  out: the backfill"). Until it runs, people staff followed up with in the 14
  days before the deploy can show in Quiet shares early (their clock starts
  at the share, not at the follow-up). Nothing is broken; Today degrades only
  to "a little early".
- After the deploy, reload every open dashboard tab (Sam, the VA): a tab
  loaded before the deploy runs the old Today page, which drops the new
  Identify these contacts and Tours to book rows (RUNBOOK step 2).
- Tracker #31: the planner records the Oct 23 decisions and Sam's option C
  pick.

## 9. Run health

29 child dispatches (9 research readers, 8 slice implementers, 7 reviewers,
5 fix waves), 0 cold-dispatch misfires, 0 budget-consuming recoveries, 1
infra recovery (the weekly usage limit stopped the orchestrator and the first
R4 dispatch ~03:11Z; resumed 14:00Z on the planner's nudge; R4 re-dispatched
fresh - it had written nothing). No named-flake re-runs.
