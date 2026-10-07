# Handback - feat/clean-org-names (branch A of tracker #2; #19 caseworkers is branch B)

- Orchestrator: build-orchestrator on Opus 5.5, AUTO mode, 2026-10-06 21:07 ->
  2026-10-07. Every child was dispatched with an explicit model (opus; no
  Fable anywhere, per the launch-gate ruling).
- Worktree `W:\tmp\clean-org-names`, branch `feat/clean-org-names`, cut from
  main @d839494a, synced ONCE with main @a5eabcb3 (merge 4b777d26, clean, no
  conflicts; main brought only `Timeline.tsx` / two CSS modules, one e2e spec
  and one issue doc - no overlap with this branch). Main drift since the sync:
  0 commits. `feat/tour-list` has NOT merged, so none of plan Task 17.1's
  overlap handling was needed.
- Records: `docs/superpowers/reviews/2026-10-06-clean-org-names/`
  (`build-research/` worklist + 8 research reports, `build/` 16 slice and
  fix-wave reports, `code-review/` 4 review rounds + 4 adjudication files,
  `self-qa.md`, this file).

## Verdict

**MERGE-READY @4b777d26 (last source commit; every later commit is a
records-only file under `docs/superpowers/reviews/`) on `feat/clean-org-names`
(`W:\tmp\clean-org-names`), 0 behind main, UNMERGED (human gate).**

Post-merge ops are owed (Cameron's, never an agent's) - see the last section.
Until the cleanup APPLY runs after a deploy, a blast filtered on a list name
misses tenants still holding an old spelling.

## Gates on the final commit 4b777d26 (bare, from the worktree, real exit codes)

| gate | exit | result |
|---|---|---|
| 1 `npm run typecheck` | 0 | all 5 workspaces clean |
| 2 `npm test` | 0 | app 424 files / 8686 passed / 1 skipped; dashboard 222 / 3972; e2e 22 / 503; fake-twilio 34 / 275; fake-twilio-web 13 / 111; zero `[dynamoAdmin]` lines |
| 3 `npm run smoke` | 0 | "smoke-dist: OK - 1608 import specifier(s) across 279 emitted file(s) resolve under plain Node." |
| 4 `timeout 2700 npm run e2e` (Git Bash) | 0 | **324 passed (17.7m)** - no flake, no retry |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 1 | 153 files; 25 errors, **0 NEW** (baseline comparison at the merge base a5eabcb3, multiset by file/rule/message); the 50 new files lint clean |

Gate 5's 25 errors are all pre-existing at the merge base (name them, do not
re-diagnose): `app/src/jobs/extraction.ts` no-unused-vars `defaultLogger`;
`app/src/lib/seed/cast.ts` no-unused-vars `CP`, `poolNum`, `listingSendId`,
`UNIT_SEARCHING_A`; `app/src/lib/seed/live.ts` `overdueAt`, `followUpAt`;
`app/src/lib/seed/matrix.ts` `DEADLINE_TYPES`; `app/test/extractionApply.test.ts`
`beforeEach`; `app/test/extractionJob.test.ts` `WINDOW_CHAR_BUDGET`;
`app/test/importApply.integration.test.ts` no-explicit-any x2;
`app/test/seedProfile.integration.test.ts` `getTableSpec`;
`dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx` `ContactsPage`,
`UnitsPage`, `DEFAULT_SEND_TEMPLATE`; `BroadcastComposer.tsx`
react-hooks/set-state-in-effect x4; `useComposerDraft.ts` react-hooks/refs;
`dashboard/src/routes/contact/ContactDetail.test.tsx` `PlacementsPage`,
`UnitsPage`; `dashboard/src/routes/settings/TemplatesSection.tsx`
react-hooks/refs; `e2e/tests/dashboard-next/broadcasts.spec.ts` unused
`request`. (One warning is new: an unused eslint-disable directive in
`useOrgAdmin.ts`, from the plan's code; warnings do not fail the gate.)

Earlier runs, for the record: checkpoint 1 (after S10) and checkpoint 2
(after S13) typecheck + npm test green; the pre-review gate pass @81de4477
green on all five (e2e 320 passed, 17.1m).

## Work map (plan section 2) - all shipped

| slice | status | notes |
|---|---|---|
| S1 rules | shipped | + build ruling B-1 (spelling compound test sees the entry's own spellings) |
| S2 store | shipped | |
| S3 services | shipped | + B-2 (Run again refuses a definition whose from-text became a listed name), A1, A6, A11 (review fixes, below) |
| S4 org.rewrite job | shipped | + A6 claim / stale-lock re-validation, A11 lease |
| S5 router + wiring | shipped | |
| S6 D5 on writers | shipped | |
| S7 AI | shipped | + RG-2 / B-3 (pre-deploy dismissals keyed on an old spelling still suppress) |
| S8 importer | shipped | |
| S9 intake rule D15 | shipped | |
| S10 retire the hand-kept lists | shipped | |
| S11 dashboard | shipped | + review fixes B1-B27 (typed-text handling, composer guard, Settings polling) |
| S12 seeds | shipped | |
| S13 dev seam | shipped | |
| S14 e2e | shipped | + 3 cases for the typed-text / composer fixes (B19) |
| S15 cleanup script + RUNBOOK | shipped | + RG-5 / A5 / A3 counters, RG-6 + clock sentences |
| S16 GLOSSARY + issues | shipped | + RF-5 update, resolved issues below |
| S17 sync, gates, self-QA, handback | done | this file |

Size: 186 branch commits before this file's records commit (+1 merge of
main); vs current main (a5eabcb3), excluding mission records: 182 files,
+24,661 / -904 (app/src 39 files +4,263/-300; app/scripts 2 files +1,011;
app/test 50 files +7,588/-119; dashboard/src 52 files +9,907/-361; e2e 17
files +1,220/-74; docs/issues, documentation, RUNBOOK +672/-49).

## Deviations and rulings beyond the plan (each recorded in the records dir)

1. **RG-1 ACCEPTED residual:** an abandoned suggestion-accept journal is
   replayed by the recovery path without re-checking the list, so a plan built
   before the deploy (or replayed after a rename/merge/delete) writes its
   stored text; it then shows in "Not on the list". Rare; spec D8 designs the
   replayable plan. Your eye.
2. **RG-2 + B-3:** the AI suggest path also honors a dismissal made before
   the deploy under the model's own text or under a spelling that names ONLY
   the matched entry (so the 2026-07-21 "dismissed is never re-suggested"
   ruling survives the switch to full names). A dismissal of a bare shared
   "AHA"/"MHA" does NOT suppress a later unambiguous full-name suggestion.
   Writes never consult dismissals (as before).
3. **B-2:** Run again (and, since A6, a job delivered after its lock lapsed)
   refuses `org_rewrite_target_gone` when a from-text has since become a
   listed name - stricter than D11's literal text, same intent.
4. **A1:** `POST /api/organizations` (add) is refused 409
   `org_rewrite_running` ONLY when the new name collides with a running
   rewrite's from-texts (the rewrite would erase it); all other adds still go
   through during a rewrite.
5. **A2:** a machine REMOVE of a housing authority (Clear, Move to Agency, the
   cleanup's move) also removes `housingAuthority_source`, so no "Auto" badge
   sits on an empty field.
6. **Typed text in a picker is never dropped silently** (review HIGH
   R1-ADV-FE-1 and its follow-ups): in the tenant and property forms, Save
   commits typed text that names exactly one entry ("Save will use <name>."
   note) and refuses anything else with "Pick a name from the list, add it as
   new, or clear the text."; while the list is loading or failed to load, the
   save is held with its own message instead of dropping the text. The blast
   composer keeps commit-only-on-pick (spec D7) and instead holds Preview back
   while text is typed, freezes the audience while a preview loads, and
   discards a preview whose draft changed (B20 also fixes a PRE-EXISTING race
   where a filter changed mid-preview sent the old candidates to the new
   draft).
7. **Cleanup script counters:** `contactsMissingTypeOrStatus`,
   `recordsWithBlankValues`, `auditFailed` (an audit append failure no longer
   aborts the apply), leftovers counted once per property; on every exit path
   and the lock.
8. **Lock hardening:** the job claims its rewrite (re-validating a lapsed lock);
   a stale heartbeat answers false; the pass checks before each record; a 14
   minute local lease turns failing heartbeats into a stop. The cleanup apply
   now stops PARTIAL if its own lock lapses (laptop asleep) instead of reviving it.
9. Accepted minors: a padded legacy value re-sent by an API caller is checked
   as a new value (U1); Move/Split count a whitespace-only target field as a
   conflict and "Not on the list" skips whitespace-only values (U2,
   R1-CONF-1; the cleanup counts them, expected 0).

**Accepted residual races** (each leaves at most an off-list value that
surfaces in "Not on the list", where Use settles it): plan section 12's two;
the S6 writers' check-then-write window (RB-4); the AI run and the importer
reading the list once per run (RG-3, R2-BE-6); the byTypeStatus walk missing
a contact whose type/status changes mid-walk (RG-4); the journal replay
(RG-1); a property edit's whole-list SET undoing a concurrent rewrite
(R2-BE-5); and the pass-start pacing gap (R4-1, filed).

## Review: 4 rounds, 3 fix waves + 1 micro-wave

| round | reviewers (opus, fresh) | found | outcome |
|---|---|---|---|
| R1 | conformance (205 CONFORMS / 3 PARTIAL / 0 MISSING / 4 DEVIATES-BY-RULING) + plan-blind backend + plan-blind dashboard | 1 HIGH, 3 MEDIUM, 10 LOW, 4 INFO | fix wave 1 (FW-A 5 commits, FW-B 11 commits) |
| R2 | 2 fresh, on wave 1 | 4 MEDIUM, 6 LOW, 7 INFO; every wave-1 fix real but 7 incomplete | fix wave 2 (FW2-A 5, FW2-B 10 incl. 3 e2e cases) |
| R3 | 2 fresh, on wave 2 | 1 MEDIUM (pre-existing composer race), 5 LOW, 6 INFO | fix wave 3 (FW3-A 3, FW3-B 6); 4 items filed |
| R4 | 1 fresh, on wave 3 | 0 MEDIUM+, 2 LOW, 1 INFO | loop CLOSED; R4-1 filed + overclaiming comments corrected; R4-2/R4-3 one-line fixes (FW4), each verified by the orchestrator with a revert check (reverting each fix fails exactly its new tests) |

Full adjudications: `code-review/R1-adjudications.md` ... `R4-adjudications.md`.

## Self-QA (live, hermetic lane 13, on 4b777d26)

All steps PASS - `self-qa.md`: Settings lists, counts and admin actions; add
through "Is this really new?" (close names listed); rename with counts and a
live status line; tenant picker (AHA shows Atlanta and Augusta; unchanged pick
sends nothing; typed `DCA` saved as the full name; unknown text blocked;
chip removal clears); property multi-picker; composer (typing never recreates
the draft; Preview held back while text is typed; one create on the pick);
"Not on the list" via the dev seam, settled with Use + Remember this spelling;
360 px (no page overflow; tables scroll in their wrapper; listbox in view);
the cleanup script rehearsed on the lane (dry run exit 0 writes nothing; apply
exit 0 maps an alias spelling, moves an agency, rewrites a property member;
Activity shows "Housing authority cleaned up"). One measured residual: at
360 px a wrapped blur note moves the next field 18 px (filed
`org-picker-note-wrap-reflow`).

Not covered by any e2e spec (unit/API tests only): merge, delete, kind change,
admin spelling edits and the shared-spelling confirm, Move to Housing
authority, Add as new, Run again, the composer's 422 re-pick after a rename,
the other-kind message in "Is this really new?", Dismiss on a pre-deploy
agency suggestion.

## Issues

- Filed (all `status: open`): `property-authorities-from-address`,
  `ai-extraction-fills-agency`, `ai-adds-new-org-names`,
  `reimport-reverts-unknown-triage` (spec section 12);
  `perf-pages-settings-organizations-surface`;
  `org-spellings-patch-blind-replace`, `org-rewrite-single-message-pass`,
  `composer-org-422-offer-renamed-entry`, `org-list-write-retry-reads-as-lost-race`,
  `org-provisional-entry-concurrent-rename`, `org-settings-details-read-no-age-cap`,
  `org-picker-note-wrap-reflow`, `org-rewrite-pass-start-pacing-gap` (review
  residuals, all low).
- Resolved: `housing-authority-free-text-drift`,
  `contact-authority-clear-empty-string-500` (fixed long ago by d827bab6;
  frontmatter was never closed), `org-settings-notice-stale-after-add`
  (filed and fixed on this branch).
- Updated: `retire-humanize-authority` (only the unit PATCH tombstones remain),
  `unit-accepted-authorities-edge-cases` (case 2 closed for new writes),
  `missed-call-autotext-partial-intake` (D15).

## Open questions for Cameron (none blocks the merge)

1. Keep RG-1 as an accepted residual (deviation 1)?
2. The typed-text Save behavior (deviation 6) is a UX decision made to fix the
   review's HIGH finding: Save quietly uses a typed name or unique spelling
   (the note says so) and refuses anything else. OK as is?
3. The launch-gate ruling (bare "Clayton" is DCA's) cannot reach STORED values:
   the retired alias map saved every bare "Clayton" as "Clayton County", which
   the cleanup maps to Jonesboro Housing Authority (RUNBOOK says to review bare
   "Clayton" rows in the Airtable export with Sam).

## Post-merge operations (Cameron's, never an agent's) - and what is broken until applied

No Terraform, table, index, env var, secret or feature switch: the `org-list`
item creates itself from the starting list on its first read after the deploy.

1. BEFORE the deploy, from a `main` checkout with this branch merged, on a
   machine whose clock is synced: `npx tsx app/scripts/clean-org-names.ts --env dev`,
   then `--env prod` (dry runs; write nothing). Review the leftover values with
   Sam (RUNBOOK section "Organization names cleanup").
2. Deploy dev. IMMEDIATELY after: `npx tsx app/scripts/clean-org-names.ts --env dev --apply`.
3. Deploy prod. IMMEDIATELY after: `--env prod --apply`.
4. Sam settles what is left on Settings > Housing authorities & agencies >
   "Not on the list".

BROKEN until step 2/3's apply runs in that environment: a blast filtered on a
list name misses tenants still holding an old spelling of it. The deploy also
ships whatever else is on main and undeployed (#1 properties available view,
the tour auto-close backlog run) - Cameron's call.

## Tracker notes (for Cameron to paste; neutral third person)

- **#2 One clean name per housing authority:** Built on branch
  feat/clean-org-names (merge-ready; not yet merged or deployed). Housing
  authority and agency names now come from one stored list that the tenant and
  property forms, the blast composer, the AI and the importer all check, and
  Settings > Housing authorities & agencies shows both lists with their use
  counts plus every stored value that is not on the list, with admin actions
  to settle it. Existing values are mapped by a one-time cleanup run right
  after the deploy; anything it cannot map automatically waits on that
  Settings page for Sam.
- **#19 Caseworkers:** This is the second half of the same work (branch B):
  it will be planned after the clean-names branch merges and builds on the same
  organization list (a caseworker's organization, a Caseworkers tab, a review
  of contacts that look like caseworkers, and direct property shares to
  caseworkers). Nothing caseworker-specific ships with the clean-names branch.
