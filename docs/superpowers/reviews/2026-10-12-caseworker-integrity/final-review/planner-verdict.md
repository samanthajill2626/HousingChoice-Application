# Planner verdict - caseworker integrity (2026-10-13)

VERDICT: MERGE-READY @8faf4b98 on `fix/caseworker-integrity`
(`W:\tmp\caseworker-integrity`). Product code is e79e408d; the commits after it
are records only. 149 ahead / 0 behind main @5c0d3f6a (synced once, merge
6b220900). UNMERGED - Cameron's gate. Cameron delegated every decision taken
after 2026-10-12 ~21:50; they are listed below so any can be reversed.

## Planner's own gates on 8faf4b98 (bare, from the worktree, real exit codes)

| Gate | Result |
|---|---|
| 1 `npm run typecheck` | exit=0 |
| 2 `npm test` (AWS_* unset) | exit=0 - app 459 files 9542 passed + 1 skipped; dashboard 237/4485; e2e-ws 22/503; fake-twilio 34/275; fake-twilio-web 13/111; 0 `[dynamoAdmin]` lines |
| 3 `npm run smoke` | exit=0 - "smoke-dist: OK - 1660 import specifier(s) across 288 emitted file(s) resolve under plain Node." |
| 4 `timeout 3000 npm run e2e` (after TIME_WAIT drained to 107) | exit=0 - "346 passed (33.8m)" |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 95 files; exit=1 with exactly the two pre-existing errors (`ScheduleTourForm.tsx:242` react-hooks/set-state-in-effect, `TourDetail.tsx:342` react-hooks/purity; at the merge base :241 / :341 - attributed by baseline, 0 owned by the branch) |

The planner also ran all five green on 63b66bc1 (before the final review's
fix waves; e2e "346 passed (25.5m)"). Gate 4 took 33.8m this time against
~25m earlier in the night - the shared DynamoDB Local container has carried
heavy load since the morning (the issue
`dynamodb-local-slows-after-sustained-concurrent-load`); a restart, which
WIPES its data, is Cameron's call and was not done.

## Independent review

- Spec conformance (opus): round 1 CONFORMS 100 / DEVIATES 2 / MISSING 0;
  round 2 re-walk CONFORMS 33 / DEVIATES 2 / MISSING 0 - every deviation was
  spec-text drift, folded into spec revisions 6 and 7.
- Adversarial, PLAN-BLIND (opus): round 1 2 MEDIUM + 7 LOW; round 2 1 MEDIUM
  (a loop the planner's own FWF-1 created) + 4 LOW. No BLOCKING or HIGH in
  either round. Rulings: `adjudications.md` (rounds 1 and 2).
- Planner live QA on a hermetic lane: `planner-live-qa.md`, Q1-Q5 all PASS.
- The planner read the riskiest diffs itself (`unitsRepo.addContact` /
  `restoreWithLandlord`, the `effectiveGuard` fence).

## Decisions taken overnight (planner, delegated)

- Final review round 1: FIX - a restore choice arriving after the property
  no longer needs one is refused with nothing written; typed contact-list
  refusals refresh the Contacts card; one eligibility rule (typed landlord,
  not soft-deleted, not a routing pointer) for auto-primary and the restore
  promotion; the housing-authority review closes when the contact stops being
  a tenant; consistent reads in `addContact`.
- Final review round 2: FIX - that late choice answers its own 409
  `restore_landlord_not_needed`; the dialog closes and the page says "This
  property's landlord changed while you were choosing. Choose Restore again."
  (the plain restore is NOT re-run automatically, so a staff member's explicit
  landlord choice is never silently replaced); a RUNBOOK caution in the
  import procedure.
- DEFERRED (filed / appended, none blocks the merge): the importer can re-add
  a landlord that "Restore without a landlord" removed
  (`import-bypasses-contact-type-rules` - fix BEFORE the next `import:apply`);
  a server-side fence on the housing-authority close-name edit
  (`ha-review-close-name-patch-unfenced`); PATCH `landlordId` leaves the old
  contact-list row (`landlord-of-record-no-reassign-ui`); duplicated rules and
  hand-copied fakes (`contact-list-rule-duplication-and-fake-drift`);
  automatic routing changes not announced, and the resolvers do not skip
  soft-deleted contacts (`auto-routing-changes-not-named`); a refused accept
  re-sent answers 200 (`ai-run-log-refused-accept-replay-200`); odd copy on
  legacy data (`contact-type-refusal-copy-edge-cases`).

Earlier rulings (planner, during the build): Q1 (a housing-authority chip on
a non-tenant skips the review and is refused), Q2/Q3 (the ownerless notice
copy). Cameron's own: Q4 (auto-primary for landlord-typed contacts only),
Q5 (restore without a landlord promotes the sole landlord-typed contact).

## Post-merge / owed

- Deploy: app image only (app + worker). No Terraform, secrets, data
  migration, backfill or new dependency.
- After the deploy: RUNBOOK "Caseworkers" DEPLOYED paragraph - mark the
  integrity fix live (the hand-clear then covers only authorities written
  before it).
- Before the next `import:apply`: fix item 1 of
  `import-bypasses-contact-type-rules`.
- Open questions for later (no merge impact): see the handback's "Open for
  Cameron" list (restore-without-landlord edge cases; the SA-1 sentence
  wording after Q4; legacy-data copy).
- Cleanup (worktree + branch) only on Cameron's explicit go.

## Tracker note for #19 (third person)

The caseworker-integrity follow-up to #19 is built and merge-ready (branch
fix/caseworker-integrity, not yet merged or deployed). A staff accept of an AI
suggestion for a tenant-only field such as housing authority is now refused on
a contact who is not a tenant and can no longer land after a caseworker
conversion; a contact's type cannot change while that would leave behind an
open tour, an open placement or a live property; and tours, placements and a
property's landlord now check the contact's type. Restoring a deleted property
whose landlord is no longer a landlord offers a landlord picker or a restore
without a landlord, and a landlord, property manager or owner added to a
property with no primary contact and no landlord becomes its primary contact;
it ships as an app deploy with no setup step.
