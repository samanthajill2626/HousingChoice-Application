# Handback - caseworker integrity (`fix/caseworker-integrity`)

Build orchestrator, 2026-10-12. Worktree `W:\tmp\caseworker-integrity`,
branch `fix/caseworker-integrity`, cut from main @19607658, synced ONCE with
main @5c0d3f6a (merge 6b220900, clean). Spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md` (APPROVED
revision 3 at dispatch; revisions 4 and 5 are Cameron's mid-build rulings,
below). Plan v2 (58 tasks + 2 checkpoints) executed in 7 dispatch units.

## Verdict

MERGE-READY @5ffcb6c6 on `fix/caseworker-integrity` (`W:\tmp\caseworker-integrity`),
0 behind main (main @5c0d3f6a), UNMERGED (human gate). The branch tip is the
records-only commit that adds this handback on top of 5ffcb6c6.

NO infra, NO data migration, NO new dependency, NO backfill: deploy the app
image (app + worker). One documentation touch is owed after the deploy (see
"Post-merge").

## Work map

| Item | Status |
|---|---|
| S1 D1 accept fence: consistent plan read; plan-time 409 `suggestion_contact_not_tenant` (chip kept, dismiss never refused); `classification_revision` in the guard; `effectiveGuard` (legacy `caseworker_conversion` fallback) at all three real-repo sites + the fake; `superseded_by_reclassification` -> 409 `suggestion_contact_reclassified` (classification wins a tie); SSE emit; dashboard copy + refetch; FakeWorld AND DynamoDB Local regressions (R2-ADV-1 schedules A and B, legacy journal) | SHIPPED (958d6e64..928fd4a1) |
| + planner Q1: a housing-authority chip on a non-tenant skips "Is this really new?" and sends the plain accept | SHIPPED (1a6b140b) |
| S2 D2 type change: `contactHoldings.ts` extraction (conversion byte-identical - its 3 test files unedited, `git diff --exit-code` 0), `contactKind`, PATCH 409 `type_change_refused` (live landlord units only; after the caseworker 409, W6), edit form keeps the draft + sentences/links, Unknown card stops swallowing errors | SHIPPED (f4b0ea26..99c2e52d) |
| CK1 / CK2 | GREEN (typecheck, npm test, smoke at b4740954 and 18509585) |
| S3 D3 tours/placements: `contactTypeGuards.ts`; tour create / revive-from-canceled / reopen; placement create / from-tour (before any write) / terminal exit (in the service); `handleTransitionError`; `deriveTenantStatus` skip (W5); TenantFile hides both buttons for a team member; `contactTypeErrors.ts` + every copy site incl. TourModals `failureCopy` | SHIPPED (599e7cac..3ce049f3) |
| S4 properties: unit create / PATCH landlord type; contact-list caseworker (new seat) then landlord claim, both before the repo call; `restoreWithLandlord` + restore route + "Restore property" dialog; Add contact picker hides caseworkers; `runRosterWrite` mapping; ownerless crash fix + optional dashboard `landlordId` | SHIPPED (f3abdd3f..efcdb4b9) |
| + planner Q2/Q3 + Cameron SA-1: the ownerless "Remove the primary contact?" sentence (final: Cameron's SA-1 text) | SHIPPED (ff28ad70, 37bfcfa1) |
| S5: seed invariant test over every seed world; e2e (edit-form refusal, picker, Reopen-dialog refusal, placement refusal, restore dialog); selector rows; RUNBOOK; 3 issues resolved (third corrected); 4 issues filed | SHIPPED (7f909843..4115c30c) |
| Scope addition SA-1 (Cameron, spec rev 4): auto-primary on the contact-list add | SHIPPED (ecbaa09c..5d9c317b), then NARROWED by Q4 |
| Cameron Q4 (spec rev 5): auto-primary only for contacts typed `landlord` | SHIPPED (874bc6dc) |
| Cameron Q5 (spec rev 5): "Restore without a landlord" promotes the sole remaining landlord-typed contact (same conditional write; audit `primaryPromoted`) | SHIPPED (460b5cd7; FW3 d7a01893, b29f6e13) |
| Known lint baseline (not fixed): `TourDetail.tsx:342` react-hooks/purity, `ScheduleTourForm.tsx:242` react-hooks/set-state-in-effect | NAMED (both present at the merge base at :341 / :241) |

Deviations: none from the approved spec text except where Cameron or the
planner ruled (Q1-Q5, SA-1, all recorded with the spec revisions). The plan's
ruling S4-1 (contact-list checks route-side only) was superseded in fix wave 2
by accepting review R2's challenge B-1: the route pre-checks stay (same
answers, same order) and `unitsRepo.addContact` re-decides both rules on each
attempt's own read, closing two confirmed races.

## Gates on the final commit, after the main sync, bare, real exit codes

The code at 5ffcb6c6 is byte-identical to the merge commit 6b220900 (the only
commit between them appends two issue sightings: `git diff --stat 6b220900
5ffcb6c6` = `docs/issues/e2e-blank-*.md`, 2 files, +25).

| Gate | Commit | Result |
|---|---|---|
| 1 `npm run typecheck` | 6b220900 | exit 0 (all five workspaces) |
| 2 `npm test` | 6b220900 | exit 0 - app 459 files / 9530 passed + 1 skipped; dashboard 237 / 4476; e2e workspace 22 / 503; fake-twilio 34 / 275; fake-twilio-web 13 / 111; no `[dynamoAdmin]` line |
| 3 `npm run smoke` | 6b220900 | exit 0 - "1660 import specifier(s) across 288 emitted file(s) resolve under plain Node" |
| 4 `npm run e2e` (timeout 2100) | 5ffcb6c6 | exit 0 - 346 passed (26.9 min) |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 6b220900 | 95 files; exit 1 with EXACTLY the two pre-existing baseline errors (`ScheduleTourForm.tsx:242` react-hooks/set-state-in-effect, `TourDetail.tsx:342` react-hooks/purity; at the merge base :241 / :341, same rule and source); 0 errors owned by the branch |

Gate 4, both runs: the first full run on 6b220900 (exit 1) finished 344
passed / 2 failed in 27.9 min - `inbox-comms.spec.ts:20` (sign-in) and
`approval-and-move-in.spec.ts:242` (placement page), each an ENTIRELY WHITE
document, the known environmental pair (`e2e-blank-first-paint-at-sign-in`,
`e2e-blank-document-after-contact-navigation`: Windows socket exhaustion on a
machine running other missions' gates; 2672 TIME_WAIT sockets right after).
Artifacts were copied before any re-run
(`.superpowers/sdd/logs/p6-e2e-artifacts/`), both sightings appended to the
issues (5ffcb6c6), the two spec files passed alone (6/6, 1.9 min), and the
clean full re-run above passed 346/346. Neither spec is touched by this
branch.

Earlier full batteries, all green: f11e46fb (build tip: e2e 345/345), d640cfb4
(SA-1: e2e 345/345; npm test exit 1 from one `connect ENOBUFS` socket error,
the file 17/17 alone twice), 2bbc6799 (fix wave 2: everything green, e2e
345/345).

## Review

Design: spec R1, plan R1 (planner). Build: research (7 readers), three code
review rounds, three fix waves, all recorded in `code-review/`.

- R1 (`R1-*`): conformance 190/190 CONFORMS; plan-blind adversarial backend
  0/0/0/2 LOW/8 INFO, dashboard 1 MEDIUM/5 LOW/5 INFO. Fix wave 1 (FW-1..FW-13):
  `restoreWithLandlord` only restores a soft-deleted unit (it could swap a LIVE
  property's landlord in a race); routing-pointer rows answer 404; the restore
  dialog's failed landlord load is said; dialog bound to its property; the
  ownerless sentence (MEDIUM, planner Q3); six test-only pins.
- R2 (`R2-*`): every FW-1..13 and SA-1 REAL by mutant; new 0 MEDIUM+/5 LOW/8
  INFO. Fix wave 2: B1 fixed per attempt (challenge accepted); audit records the
  EFFECTIVE primary flag; pointer 404 on the contact-list add; the
  `useListing.setUnit` forId guard (a late write froze another property's page);
  Q4 and Q5 (Cameron); pins and docs.
- R3 (`R3-*`, terminal: LOW/INFO filed, MEDIUM+ reopens): 0 MEDIUM+; every
  fix-wave-2 item REAL. Micro-wave FW3, verified by the orchestrator's own revert
  checks: a soft-deleted contact is never promoted; the restore reads the list
  once before the type reads.
- REJECTED with reasons (`R1-adjudications.md`): B9 (Express `Response` type in
  `services/contactTypeGuards.ts` - plan-bound, type-only), B10 (a wire flag for
  an ignored restore choice), D11 (hide Accept on a non-tenant's chip - spec D1
  design). Spec-approved copy kept and filed: D2, D10.

Self-QA (`self-qa.md`): 8 measured live states on lane 6, all PASS - the
team-member chip refused with the plain accept (network 409), no Schedule /
Start placement on a team member, the Unknown card's landlord-of-record
refusal (legacy data planted directly), the edit form's two refusals at
360 px (no overflow, 16 px gutters), Q5's promotion, Q4 (a tenant joins
non-primary, a PM auto-promotes), the SA-1 sentence, the restore dialog's
load error under StrictMode.

## Issues

- Resolved: `claimed-suggestion-accept-after-caseworker-conversion`,
  `contact-retype-skips-caseworker-refusals`,
  `tours-placements-no-contact-type-check` (record corrected: the contact-list
  add is in `units.ts`; terminal exit unguarded; tenant-only ruling),
  `contact-list-checks-outside-roster-write-loop` (filed in FW1, fixed in FW2).
- Partly addressed (stays open): `stale-suggestions-survive-contact-retype`
  (tenant-only accepts now refused on a non-tenant; `address` neutral by
  ruling; pending chips still survive a re-type).
- Filed: `placement-terminal-stage-exit-unguarded`,
  `import-bypasses-contact-type-rules`, `landlord-of-record-no-reassign-ui`,
  `unit-primary-contact-unchecked` (the plan's four);
  `contact-type-refusal-copy-edge-cases`,
  `listing-detail-dialogs-survive-property-navigation`,
  `restore-without-landlord-can-leave-nobody-reachable` (from review).

## For Cameron (open, each recorded; nothing blocks the merge)

1. `restore-without-landlord-can-leave-nobody-reachable`: after "Restore
   without a landlord" nobody is reachable (silently) when (a) no row was
   flagged primary and the landlord of record was the routing fallback (R3 C-1:
   count that as "was the primary"? one disjunct, recorded in the issue), or
   (b) zero or two-plus landlord-typed contacts remain (your Q5 ruling).
2. The SA-1 sentence ends "...or a new contact is added"; after Q4 that holds
   for a new landlord, property manager or owner (the contacts normally added
   to a property list), not a new tenant/partner. Kept as ruled.
3. `contact-type-refusal-copy-edge-cases`: spec-approved sentences that read
   oddly on legacy data ("must stay a landlord" for an unknown landlord of
   record; "no longer a landlord" for a deleted one), the restore dialog
   closing when the server ignored the choice, the banner Restore's silent
   failure (pre-existing), the Activity row not naming a landlord change.
4. Premise change: #19 shipped (release 1.5.1) before this branch, so the D1
   legacy-journal fallback is live-relevant and the RUNBOOK's hand-clear
   applies until this deploys; no repair step was built (spec D1.7 / L2).

## Post-merge

- Deploy: the app image only - NO Terraform, NO secrets, NO table/GSI, NO
  script, NO backfill. Nothing is BROKEN before or after.
- Owed doc touch after the deploy: RUNBOOK.md, section "Caseworkers", the
  DEPLOYED paragraph's sentence "Until it is live, a caseworker converted while
  a housing authority suggestion accept was in flight can end up holding that
  authority ... clear the authority by hand." - mark the integrity fix deployed
  (the hand-clear then covers only authorities written BEFORE the deploy).
- Agent memory updated in the MAIN checkout (uncommitted there, as usual):
  `.claude/agent-memory/abt-build-orchestrator/caseworker-integrity.md`, the
  MEMORY.md index line, and two traps in `housingchoice-build-traps.md`.

## Known flakes / environment

- p4 run only: `npm test` exit 1 from ONE `connect ENOBUFS 127.0.0.1:65533`
  (OS socket-buffer exhaustion, not an assertion) in
  `app/test/unitsApiRosterTypeChecks.test.ts`; the file passed 17/17 alone
  twice; p5 and the final run are clean.
- Final battery, first e2e run: the blank-document pair (see Gates) - third
  sightings of both open issues, same environmental class (socket exhaustion
  on a shared, busy Windows host; the run was 27.9 min against about 22 min).
  Isolated 6/6 and a clean full re-run 346/346.
- No `[dynamoAdmin]` line in any run; the shared DynamoDB Local container was
  never started, stopped or restarted by this mission.

## Numbers

- 130 branch commits including this handback (74 touch product code) plus the
  main merge; 7 implementer units + fix waves 1, 2a, 2b, 3 + SA-1 = 12 build
  children, 7 research readers, 7 reviewers; 0 recoveries, 0 misfires; 5
  questions to the planner (Q1-Q5), each answered within minutes.
- Branch vs main (excluding mission records): 113 files, +11299 / -340; product
  source (non-test) 38 files, +1913 / -206; mission records 41 files.
- Commit list: `git log --oneline --no-merges main..fix/caseworker-integrity`.

## Tracker note for #19 (neutral, third person)

The caseworker-integrity follow-up to #19 (`fix/caseworker-integrity`) is
merge-ready and unmerged: a staff Accept of a tenant-only AI suggestion is now
refused on a non-tenant and fenced across a caseworker conversion (R2-ADV-1),
a contact's type change is refused while it would orphan an open tour, an open
placement or a live property, and tours, placements and properties check the
contact's type. Restoring a deleted property whose landlord is no longer a
landlord offers a landlord picker or a restore without a landlord (promoting
the one remaining landlord-typed contact), and a landlord-typed contact added
to a property with no primary contact and no landlord of record becomes its
primary contact. It ships as an app-image deploy with no infrastructure or
data changes.
