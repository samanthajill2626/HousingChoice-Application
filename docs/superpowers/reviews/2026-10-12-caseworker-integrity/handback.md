# Handback - caseworker integrity (`fix/caseworker-integrity`)

Build orchestrator, 2026-10-12/13. Worktree `W:\tmp\caseworker-integrity`,
branch `fix/caseworker-integrity`, cut from main @19607658, synced ONCE with
main @5c0d3f6a (merge 6b220900, clean; main has not moved since). Spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`: APPROVED
revision 3 at dispatch; revisions 4-5 are Cameron's mid-build rulings, 6-7 the
planner's final-review rulings (decisions delegated by Cameron overnight).
Plan v2 (58 tasks + 2 checkpoints) executed in 7 dispatch units, then three
build fix waves, scope addition SA-1, and the final-review waves FWF and FWF2.

## Verdict

MERGE-READY @e79e408d on `fix/caseworker-integrity` (`W:\tmp\caseworker-integrity`),
0 behind main (main @5c0d3f6a), UNMERGED (human gate). The branch tip is the
records-only commit that adds this handback on top of e79e408d. The code at
e79e408d is byte-identical to 05db50e0 (the one commit between them appends an
e2e sighting to `docs/issues/e2e-blank-document-after-contact-navigation.md`).

NO infra, NO data migration, NO new dependency, NO backfill: deploy the app
image (app + worker). Owed after the merge/deploy: one RUNBOOK touch and the
importer gate (see "Post-merge").

## Gates on the final code, bare, real exit codes

Gates 1-3 and 5 ran on 05db50e0; gate 4's clean run is on e79e408d, which
differs from 05db50e0 only by the issue append above. No second main sync was
needed (main has not moved past 5c0d3f6a).

| Gate | Result |
|---|---|
| 1 `npm run typecheck` | exit 0 (all five workspaces) |
| 2 `npm test` | exit 0 - app 459 files / 9542 passed + 1 skipped; dashboard 237 / 4485; e2e workspace 22 / 503; fake-twilio 34 / 275; fake-twilio-web 13 / 111; no `[dynamoAdmin]` line |
| 3 `npm run smoke` | exit 0 - "1660 import specifier(s) across 288 emitted file(s) resolve under plain Node" |
| 4 `npm run e2e` (timeout 2100) | e79e408d: exit 0 - "346 passed (24.8m)" (started after TIME_WAIT drained to 179). The first run, on 05db50e0, was exit 1 - "1 failed / 345 passed (24.8m)": `unknown-caller-triage.spec.ts:115` waited 15 s for the Unknown tab after `page.goto`; its screenshot is an entirely white document - the known environmental blank-document signature (fourth sighting, appended in e79e408d; 2843 TIME_WAIT sockets right after, about 50 other node processes on the host). Artifacts were copied before any re-run (`.superpowers/sdd/logs/p9-e2e-artifacts/`); the spec file passed alone 2/2 (18.1 s); not touched by this branch. |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 95 files; exit 1 with EXACTLY the two pre-existing baseline errors (`ScheduleTourForm.tsx:242` react-hooks/set-state-in-effect, `TourDetail.tsx:342` react-hooks/purity; at the merge base :241 / :341, same rule and source); 0 errors owned by the branch |

Earlier full batteries: f11e46fb (build tip, all green, e2e 345/345);
d640cfb4 (SA-1, e2e 345/345; npm test exit 1 from one `connect ENOBUFS`
socket error, the file 17/17 alone twice); 2bbc6799 (fix wave 2, all green);
6b220900/5ffcb6c6 (after the main sync: all green, e2e first run 344/2 on the
known blank-document pair - environmental, isolated 6/6, clean re-run
346/346); 63b66bc1 (the planner's gates, all green, e2e 346/346); 1358fb42
(FWF, all green, e2e 346/346).

## Work map

| Item | Status |
|---|---|
| S1 D1 accept fence (consistent plan read; plan-time 409 `suggestion_contact_not_tenant`; `classification_revision` in the guard; `effectiveGuard` at all three real-repo sites + the fake; 409 `suggestion_contact_reclassified`; SSE emit; dashboard copy + refetch; FakeWorld AND DynamoDB Local regressions) | SHIPPED (958d6e64..928fd4a1) |
| + planner Q1: a housing-authority chip on a non-tenant skips "Is this really new?" | SHIPPED (1a6b140b) |
| S2 D2 type change (`contactHoldings.ts`, conversion byte-identical; `contactKind`; PATCH 409 `type_change_refused`; edit form + Unknown card) | SHIPPED (f4b0ea26..99c2e52d) |
| S3 D3 tours/placements (`contactTypeGuards.ts`; create / revive / reopen; placement create / from-tour / terminal exit; `handleTransitionError`; `deriveTenantStatus` skip; team-member buttons; every copy site incl. TourModals) | SHIPPED (599e7cac..3ce049f3) |
| S4 properties (unit create / PATCH; contact-list caseworker then landlord claim; `restoreWithLandlord` + route + "Restore property" dialog; Add contact picker; `runRosterWrite`; ownerless crash fix + optional `landlordId`) | SHIPPED (f3abdd3f..efcdb4b9) |
| S5 (seed invariant test; e2e; selectors; RUNBOOK; 3 issues resolved; 4 filed) | SHIPPED (7f909843..4115c30c) |
| Cameron SA-1 / Q4 / Q5 (spec rev 4-5): auto-primary for landlord-typed contacts; "Restore without a landlord" promotes the sole landlord-typed contact | SHIPPED (ecbaa09c..5d9c317b, 874bc6dc, 460b5cd7) |
| Final review FWF (spec rev 6): a late restore body is refused, nothing written (FWF-1); typed contact-list refusals re-read the property (FWF-2); ONE automatic-routing eligibility rule - typed landlord, not soft-deleted, not a routing pointer - for auto-primary and the restore promotion (FWF-3); the housing-authority review closes when the contact stops being a tenant (FWF-4); `addContact` reads consistently (FWF-5) | SHIPPED (3a0ed89d..8da0f6c8) |
| Final review round 2 FWF2 (spec rev 7): the late body answers its own 409 `restore_landlord_not_needed`; the dialog closes and a still-deleted page says "This property's landlord changed while you were choosing. Choose Restore again." (no automatic plain restore) - fixing FWF-1's retry loop (R2-1); `addContact`'s conflict re-read consistent (R2-4); comments, RUNBOOK import caution, issue appends | SHIPPED (ea518b87..28980d2e) |
| Known lint baseline (not fixed) | NAMED (gate 5) |

Deviations from the approved spec: none beyond the recorded rulings
(planner Q1-Q3, Cameron SA-1 / Q4 / Q5, planner final review rounds 1-2, all
folded into spec revisions 4-7). The plan's ruling S4-1 was superseded by
review R2's accepted challenge B-1 (`addContact` re-decides the contact-list
rules on each attempt's own read).

## Review trail (all records in this directory)

- Build research: 7 readers (`build-research/`); 1 BLOCKER, 4 corrections, 2
  questions.
- Code review R1 -> fix wave 1; R2 -> fix wave 2a/2b (+ Cameron Q4/Q5); R3
  (terminal) -> micro-wave FW3, verified by orchestrator revert checks
  (`code-review/`).
- Planner final review (`final-review/`): conformance CONFORMS 100 / DEVIATES 2;
  plan-blind adversarial 2 MEDIUM / 7 LOW -> FWF. The orchestrator's fresh
  re-review of FWF (`FWF-review.md`, dispositions in
  `FWF-review-dispositions.md`) and the planner's round 2 found the same
  MEDIUM (FWF-1's retry loop) independently -> FWF2. Orchestrator revert
  checks: FWF-1 6/32 red, FWF-3 2/19 red, FWF2 R2-1 6/32 red, each restored
  byte-identical.
- Self-QA (`self-qa.md`): 8 measured live states on lane 6, all PASS (before
  the final review; the final-review waves are covered by unit, route and
  DynamoDB Local tests plus the full e2e).

## Deferred (recorded; nothing blocks the merge)

From the planner's final review (rulings in `final-review/adjudications.md`):
- A1 - re-running the importer re-adds a landlord that "Restore without a
  landlord" removed: FIRST item in `import-bypasses-contact-type-rules`, to fix
  before the next `import:apply` run; the RUNBOOK import procedure now says so.
- A5 (server) - the close-name path's plain contacts PATCH is not fenced on
  type or revision: `ha-review-close-name-patch-unfenced` (the client closes
  the review on a conversion; a generic re-type usually emits no event).
- A6 - an API-only PATCH of `landlordId` leaves the old landlord's row and
  primary behind: `landlord-of-record-no-reassign-ui`.
- A7 (refactor) - duplicated contact-list rules and hand-copied fakes;
  FakeWorld `getById` returns the live object; `removeContact` reads
  eventually consistently: `contact-list-rule-duplication-and-fake-drift`.
- A8 / R2-3 - automatic routing changes are not named before the write; the
  resolvers do not filter soft-deleted contacts and the I3 claim is type-only:
  `auto-routing-changes-not-named`.
- A9 - a replay of an accept refused by reclassification answers 200:
  appended to `ai-run-log-refused-accept-replay-200`.
- R2-5 - the "must stay a landlord" sentence on a legacy landlord of record:
  `contact-type-refusal-copy-edge-cases`.
From the build's own reviews:
- `restore-without-landlord-can-leave-nobody-reachable` - "Restore without a
  landlord" leaves nobody reachable when no row was flagged primary (legacy) or
  zero / two-plus landlord-typed contacts remain.
- `listing-detail-dialogs-survive-property-navigation` - the pre-existing
  "Delete property?" dialog survives an in-place property move; a late roster
  answer can still overwrite another property's Contacts card state.
- `contact-type-refusal-copy-edge-cases` - legacy-data copy, the banner
  Restore's silent failure (pre-existing), the Activity row not naming a
  landlord change.
- FWF re-review INFO, recorded only: a refused row's sentence disappears when
  the settle re-read removes the row (F3); a plain restore of an already-live
  property writes a second `unit_restored` audit (pre-existing, F6); a review
  closed while its own "Yes, add it" is in flight still sends the accept, which
  the server refuses (F8).
- Housekeeping: several open issues outside this branch's scope cite line
  numbers the final waves moved (not re-pointed).

## Issues

- Resolved: `claimed-suggestion-accept-after-caseworker-conversion`,
  `contact-retype-skips-caseworker-refusals`,
  `tours-placements-no-contact-type-check` (corrected),
  `contact-list-checks-outside-roster-write-loop` (filed and fixed here).
- Partly addressed (open): `stale-suggestions-survive-contact-retype`.
- Filed: `placement-terminal-stage-exit-unguarded`,
  `import-bypasses-contact-type-rules`, `landlord-of-record-no-reassign-ui`,
  `unit-primary-contact-unchecked`, `contact-type-refusal-copy-edge-cases`,
  `listing-detail-dialogs-survive-property-navigation`,
  `restore-without-landlord-can-leave-nobody-reachable`,
  `ha-review-close-name-patch-unfenced`,
  `contact-list-rule-duplication-and-fake-drift`,
  `auto-routing-changes-not-named`.
- Appended: `ai-run-log-refused-accept-replay-200`, the third sightings of
  `e2e-blank-first-paint-at-sign-in` / `e2e-blank-document-after-contact-navigation`,
  and the fourth sighting of `e2e-blank-document-after-contact-navigation`
  (e79e408d).

## Post-merge

- Deploy: the app image only - NO Terraform, NO secrets, NO table/GSI, NO
  script, NO backfill. Nothing is BROKEN before or after.
- After the deploy, RUNBOOK.md "Caseworkers" DEPLOYED paragraph: mark the
  integrity fix deployed in the sentence "Until it is live, ... clear the
  authority by hand." (the hand-clear then covers only authorities written
  before the deploy).
- Before the NEXT `import:apply` run: read / fix
  `import-bypasses-contact-type-rules` item 1 (it can re-add a landlord that
  "Restore without a landlord" removed) - the RUNBOOK import procedure carries
  this caution line now.
- Agent memory updated in the MAIN checkout (uncommitted there):
  `.claude/agent-memory/abt-build-orchestrator/caseworker-integrity.md`, its
  MEMORY.md line, two traps in `housingchoice-build-traps.md`.

## Known flakes / environment

- One `connect ENOBUFS` socket error (d640cfb4, `npm test`), one
  blank-document e2e pair (6b220900, first run) and one blank-document e2e
  failure (`unknown-caller-triage.spec.ts:115`, 05db50e0, first run) - Windows
  socket exhaustion on a shared, busy host; isolated green and re-run green
  each time; all three recorded in the open issues. The other four batteries
  were clean. None of the three failing e2e spec files is touched by this
  branch.
- No `[dynamoAdmin]` line in any run; the shared DynamoDB Local container was
  never started, stopped or restarted by this mission.

## Numbers

- 147 branch commits including this handback (82 touch `app/src` or
  `dashboard/src`) plus the main merge. Children: 7 research readers, 7 implementer units, fix waves 1,
  2a, 2b, 3, SA-1, FWF, FWF2 (14 build children), 8 reviewers; 0 recoveries,
  0 misfires; 5 questions to the planner (Q1-Q5).
- Branch vs main excluding `docs/superpowers/` (spec, plan, mission records):
  117 files, +12345 / -348; product source (non-test `app/src` +
  `dashboard/src`) 38 files, +2073 / -213; `docs/superpowers/` 49 files.
- Commit list: `git log --oneline --no-merges main..fix/caseworker-integrity`.

## Tracker note for #19 (neutral, third person)

The caseworker-integrity follow-up to #19 (`fix/caseworker-integrity`) is
merge-ready and unmerged: a staff Accept of a tenant-only AI suggestion is now
refused on a non-tenant and fenced across a caseworker conversion (R2-ADV-1),
a contact's type change is refused while it would orphan an open tour, an open
placement or a live property, and tours, placements and properties check the
contact's type. Restoring a deleted property whose landlord is no longer a
landlord offers a landlord picker or a restore without a landlord (promoting
the one remaining live landlord-typed contact), and a live landlord-typed
contact added to a property with no primary contact and no landlord of record
becomes its primary contact. It ships as an app-image deploy with no
infrastructure or data changes.
