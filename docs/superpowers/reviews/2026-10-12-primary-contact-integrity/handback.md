# Build handback - primary contact integrity + intro fallback explanation

Date: 2026-10-13. Branch `feat/primary-contact-integrity`, worktree
`W:\tmp\primary-contact-integrity`. Build orchestrator: Fable 5.1 (AUTO mode,
subagent of the planner). Ledger and run state: `.superpowers/sdd/` (ignored).

VERDICT: MERGE-READY @283c9cb7 (gated tip; this handback commit is docs-only on
top) on feat/primary-contact-integrity, 0 behind main (main @16ca96cc merged
once at 283c9cb7), UNMERGED (human gate). Post-merge operator action OWED:
the primary-contacts backfill script on dev, then prod, after each deploy
(RUNBOOK). No Terraform, secrets, SSM or index change.

## Work map

| item | status |
|---|---|
| S1 app lookup + heir (`lib/propertyContact.ts`; four ladder copies onto it; docblock) S1.1-S1.8 | SHIPPED c28493f5..d95feb1e (report slices/S1-report.md) |
| S2 app writes: P2 widen, 409, P2b, remove heir + 503, restore heir + `landlordWasPrimary`, swap re-runs the heir, `handOffPrimaryFrom` + `list(consistentRead)`, contact-delete fan-out service + wiring, audit event, API-test fake, parity pin, docblock S2.1-S2.14 | SHIPPED 02ccba0f..77aebbdf, two dispatches (S2a-report.md, S2b-report.md) |
| S3 app reads: `introFallback` reasons, job INFO line, `RosterPreview.introFallback` on OPEN previews, Activity `reason` (R17: one event only), `propertyContact` block + row flags on GET and the two roster writes S3.1-S3.7 | SHIPPED b9ebd67f..ac286827 (S3-report.md) |
| S4 dashboard: dialog box + Check again + edited-draft rule; TourDetail / PlacementDetail callers; property box; "(deleted)" rows without Make primary; 409/503 copy; restore re-read as roster source; restore-dialog 503 (S4.10b); Activity line; Delete-dialog sentence; suggestions skip deleted S4.1-S4.13 | SHIPPED 56a94b1e..2d5daa99, two dispatches (S4a-report.md, S4b-report.md) |
| S5 script (`app/scripts/assign-primary-contacts.ts` + `assignPrimaryIfCurrent`), dev seam `POST /__dev/fixtures/zero-primary-property`, e2e specs (a)(b)(c) + fixture, property-roster.spec update, selectors.md, GLOSSARY, RUNBOOK section, issues S5.1-S5.11 | SHIPPED 08f7de11..3454a0ee (S5a-report.md, S5b-report.md) |
| S5.12 one main sync + the five completion gates | DONE by the orchestrator (below) |

Deviations (all recorded, none silent):

- Beyond the plan: (1) `PlacementDetail.setUnit` keeps the load-time roster
  rows and `propertyContact` block across a final-rent PATCH (spec 7.5 applied
  to the placement page; code review R2-2; 482f9cf4 + test). (2) The
  no-primary box's "Make <Name> primary" button wraps instead of overflowing
  the Contacts card (self-QA measurement; acaea45a). (3) One extra
  DynamoDB-Local test runs the backfill script's REAL wiring (research delta;
  f69d6636). (4) Comment/title/issue tidies from the two fix waves.
- Spec text amended on-branch (each a ruling or a fact, not a product change):
  section 8 narrowed to ruling R17 and section 10's seam sentence to R23
  (6c68f342); 4.7 gains the classification known gap (613edf85); section 10's
  "cannot be reached through the UI" corrected (913c1142). The GLOSSARY lists
  the zero-primary paths the spec's section 12 omits (conformance D-3, accepted).
- Research delta S3-F2 ("the dev seam RED answers 403") was WRONG; the tree
  answers 404 (`originSecret.ts:45` exempts `/__dev/`); withdrawn in
  research/worklist-deltas.md.
- Staff copy the spec does not give verbatim, shipped as accepted at launch:
  "Couldn't check again - please try again." (P-2); the Activity label
  "Primary contact set automatically" with sub-lines "the property had no
  primary contact" / "the previous primary contact was removed" / "the
  previous primary contact was deleted" / "the property's landlord changed
  when it was restored" / "set by a one-time data repair" (P-3); the
  `Make <contactId> primary` fallback for a row with no name; the script's
  operator text.

## Gates on the FINAL gated commit 283c9cb7 (bare, redirected, real exit codes)

1. `npm run typecheck`: `TYPECHECK_EXIT:0`, 0 `error TS` lines, all five
   workspaces (`.superpowers/sdd/p6-gate1-typecheck.log`).
2. `npm test` (no AWS_* exported; verified `env | grep '^AWS_'` empty):
   `NPMTEST_EXIT:0` - app `Test Files 494 passed (494)` / `Tests 10043 passed
   | 1 skipped (10044)`; dashboard `242 passed (242)` / `4611 passed`; e2e
   workspace `22 passed (22)` / `503 passed`; `34 passed` / `275 passed`;
   `13 passed` / `111 passed`; zero `[dynamoAdmin]` lines
   (`p6-gate2-npmtest.log`).
3. `npm run smoke`: `SMOKE_EXIT:0` - "smoke-dist: OK - 1676 import
   specifier(s) across 291 emitted file(s) resolve under plain Node."
   (`p6-gate3-smoke.log`).
4. `timeout 2700 npm run e2e`: "Running 350 tests using 1 worker" ...
   "350 passed (21.4m)", `E2E_EXIT:0`, zero `[dynamoAdmin]` lines
   (`p6-gate4-e2e.log`). BOTH RUNS REPORTED: the pre-sync run on 29114f8c
   (`gate4-e2e.log`) was "349 passed / 1 failed (22.1m)" - the failure was
   `tests/flows/conversation-fact-extraction.spec.ts:160` timing out 60 s
   waiting for the "Continue as dev user" button on `page.goto`, a flow this
   diff does not touch, while two opus reviewers were reading the repo
   concurrently; the file passed SOLO "12 passed (21.5s)" EXIT 0
   (`gate4-solo-fact-extraction.log`) and passed in the quiet full run above.
   Attribution: load/transient, not a regression. Artifacts preserved under
   `.superpowers/sdd/gate4-run1-artifacts/`. `roster-paging.spec` (60
   concurrent deletes, one consistent units Scan each): 1.4 s, no slowdown
   (S5b measured 183 ms for the whole batch).
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts'
   '*.tsx' '*.js' '*.mjs' '*.cjs')` on 87 files: `ESLINT_EXIT:1`, exactly one
   error - `dashboard/src/routes/tours/TourDetail.tsx 342:85
   react-hooks/purity` - and the same file linted at the merge-base 16ca96cc
   (via stdin) reports the identical error: PRE-EXISTING, not ours
   (`p6-gate5-eslint.log`, `.json`). S4.3 removed the branch's other
   baseline error (`RosterConfirmDialog.tsx:113:5 set-state-in-effect`), so
   the repo lint backlog is now 22 errors / 17 files (issue updated).

Pre-sync gates on 29114f8c were also green except the e2e run above
(typecheck 0; npm test 0 with the same counts minus the fix-wave tests; smoke
0; eslint the same single pre-existing error).

## Files and commits

- 73 branch commits 6c68f342..913c1142 plus the one `main` merge 283c9cb7
  (list: `git log --oneline 14c2856b..HEAD`). This handback is the only commit
  after the gated tip (docs-only).
- 126 files changed, +19549 / -741 vs the mission base 14c2856b: code (app/src,
  app/scripts, dashboard/src, e2e) 45 files +4896 / -562; app tests 46 files
  +8081 / -148; docs 35 files +6572 / -31.
- New modules: `app/src/lib/propertyContact.ts`, `app/src/services/
  primaryHandoff.ts`, `app/scripts/assign-primary-contacts.ts`,
  `e2e/fixtures/primaryContact.ts`, `e2e/tests/dashboard-next/
  primary-contact-integrity.spec.ts`; the lean seed is byte-stable (no file
  under `app/src/lib/seed*` changed).

## Review findings and resolutions

- R1 spec-conformance (code-review/R1-conformance.md): 56 work-map rows,
  56 CONFORMS, 0 PARTIAL, 0 MISSING; 2 LOW (both fixed in fix wave 1), 7 NOTE,
  9 code-vs-spec divergences all accepted (D-1..D-9, reasons in
  R1-adjudications.md).
- R1 adversarial, PLAN-BLIND (R1-adversarial.md): 0 BLOCKING, 0 HIGH,
  1 MEDIUM (F1: the contact-delete hand-off skips a no-flag unit whose
  landlord of record is the deleted contact - BY DESIGN per spec 4.6's last
  bullet; filed as `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`
  with the two-line recipe, for Cameron's call), 4 LOW (eventual-consistency
  shapes F2/F3/F4 - accepted races per spec 4.2 / ruling R13, filed as
  `docs/issues/roster-liveness-read-eventual-consistency.md`; F5 per-delete
  Scan - accepted, projection noted), 7 NOTE, 7 PRE-EXISTING, 17 SOUND. Its
  scratchpad repro was executed once in fix wave 1: F1 and F3 fail as the
  designed behavior predicts, the rest pass.
- Fix wave 1 (5b6c3c7c..6c198707 + e6fec584): the explicit-Make-primary
  appends-no-event test (RED by a temporary break, then green), comment and
  title fixes, four issue updates/filings, selectors clause.
- R2 fresh re-review (R2-rereview.md): 0 BLOCKING/HIGH/MEDIUM, 3 LOW
  (R2-1 classification recreates the 470 Bolton shape - documented as a known
  gap in spec 4.7 / GLOSSARY / RUNBOOK; R2-2 placement page re-offered deleted
  rows after a final-rent PATCH - FIXED; R2-3 six "cannot reach it" sentences
  - FIXED in seven places), 9 NOTE (the cheap ones fixed). No adjudication
  challenged except N2 (taken).
- Fix wave 2 (482f9cf4..ec4ba94c). I read the R2-2 diff myself.
- Self-QA (self-qa.md): one MEASURED defect, fixed (acaea45a).

## Self-QA narrative

On the hermetic lane 13 through the Playwright MCP (never :5174 / :8080):
built the 470 Bolton shape through the real routes + the dev seam, then
walked (a) the property box ("No primary contact." + "Make Mark ... primary";
one click fixes it; the write appends `unit_contact_added` only), (b) the
open-group dialog box (heading, reason line, "Set a primary contact" in a new
tab, Check again: the box clears, an EDITED draft is kept with "The intro
changed." / "Use the updated intro", which swaps in the tour intro naming
Mark), (c) the remove hand-off ("Dana ... becomes the primary contact - new
tours and relay groups for this property will use them."; audit
`handoff_on_remove` with `from`), the Delete dialog's 7.6 sentence, and the
delete fan-out (summary `targets: 1, moved: [], unchanged: [unit2]`; the row
"(deleted) (primary)", the lead "This property's contact was deleted.", no
button, no Make primary in edit mode). Every state was also read at the
boundary (GET /api/units, preview-open, activity). Measured, not eyeballed:
the box button overflowed 246 px in a 226 px box (fixed, re-measured 226 =
226); the dialog box and both dialogs have no horizontal overflow.
Screenshots: `.playwright-mcp/selfqa/selfqa-01..10-*.png` (ignored).

## Issues filed / resolved

- NEW: `primary-handoff-no-flag-landlord-delete-gap` (med, by design,
  decision for Cameron), `roster-liveness-read-eventual-consistency` (low).
- RESOLVED: `unit-primary-contact-unchecked`,
  `restore-without-landlord-can-leave-nobody-reachable`.
- UPDATED: `auto-routing-changes-not-named` (incl. the dashboard path to a
  deleted landlord of record), `contact-list-rule-duplication-and-fake-drift`,
  `lint-backlog-repo-wide` (22 / 17), `tour-reminder-zero-primary-e2e-gap`
  (item 1 partially addressed), `relay-provision-includes-deleted-contacts`
  (docblock part done; provisioning gap stays open).

## Open questions and "your eye" items for Cameron

1. Spec 7.4 copy "Add the landlord or property manager - they become the
   primary automatically." misleads when the landlord of RECORD is
   soft-deleted: adding someone WITH the Landlord role answers 409
   `landlord_reassignment_required` (PM / Owner works). Shipped verbatim;
   change the sentence if you want.
2. F1 (designed asymmetry): should the contact-delete hand-off also cover a
   no-flag unit whose landlord of record is deleted? Two-line reuse of
   `landlordWasPrimary`; the issue has the restricted predicate.
3. R2-1: should classifying a seated contact as a property manager run
   auto-primary? Today it does not (spec 4.4); the box offers the click and
   the backfill is idempotent / safe as a periodic sweep.
4. Not blocking, noted: the remove 503 shows the same sentence in the dialog
   and the row behind it; a promoting "Restore without a landlord" writes two
   Activity rows (`unit_restored.primaryPromoted` + `handoff_on_restore`); a
   failed liveness read logs two WARNs; the intro job's INFO line fires at
   compose time (also on the dev intro-replay endpoint); the property page's
   Activity card refreshes on reload only (same as main); every contact DELETE
   runs one consistent units Scan (spec-accepted; a ProjectionExpression is a
   cheap later optimization); PRE-EXISTING and now documented: a "(deleted)"
   row can be re-roled to Landlord and claim the landlord slot.
5. The two pre-existing ERROR lines the lean world logs at boot
   (relayAnnouncement aggregation "missing"; the seeded relay group "stuck
   connecting") are on files this branch does not touch.

## Post-merge obligations (LOUD)

After EACH environment's deploy, from the repo root (RUNBOOK "Primary
contacts backfill", NOT YET RUN): `npx tsx app/scripts/assign-primary-contacts.ts
--env dev` (dry run) -> `--env dev --apply` -> dry run again -> hand the
`noEligible` unit-id list to Sam (she picks by hand with the property box) ->
the same on prod. Exit 0 = completed (incl. `skippedOnCondition`); 1 = target
unresolved / Scan failed / `unknown > 0` or `writeFailed > 0`; 2 = usage.
Until it runs, existing no-primary properties (470 Bolton) show the property
box and Sam can fix them by hand; tours there keep the general intro with the
explanation. No infra, secrets or index change.

## Recoveries

Zero: no cold-dispatch misfires, no agent deaths, no resumed children; every
child was a fresh foreground dispatch (4 readers, 8 implementers, 3 reviewers,
2 fix waves).
