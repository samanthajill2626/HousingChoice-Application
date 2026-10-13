# S3a build report - D3 / I2 backend: tours and placements check the tenant (U3)

Implementer: U3 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from b4740954 (S1 and S2 done; base 19607658).
Plan `docs/superpowers/plans/2026-10-12-caseworker-integrity.md` Tasks
3.1-3.10 (the BACKEND half of slice S3), orchestrator corrections C1-C2, the
half-slice gate and the required mutant check (M1-M9). The dashboard half
(Tasks 3.11-3.18) is the next implementer's; no dashboard file was edited.
Findings only; code is cited by file:line at c474d923 (the last code commit).

Headline: 10 commits, one per plan task. Every RED failed for the reason the
plan states, every GREEN passed as written, every plan anchor matched exactly
once (the `replace_all` matched its 16), and no step needed rework. The
half-slice gate is green (all exit 0), lint is clean on all 17 app files, and
all nine mutants were killed by the existing slice tests, so no gap test was
added. No STOP condition was hit: no unexpected importer, import cycle,
contract mismatch with plan section 2, failing RED/GREEN, or unlisted
mutation surface or reader.

## Per task

| Task | Commit | RED observed | GREEN |
|---|---|---|---|
| 3.1 contactTypeGuards.ts | 599e7cac | the file failed to load (`Cannot find module '../src/services/contactTypeGuards.js'` / `Failed to load url ... Does the file exist?`); no tests ran | 26/26; `tsc -p tsconfig.test.json` 0; eslint 0 |
| 3.2 W3 fixture sweep (+ C1) | 17a4fdde | with `-t "fixture: a tour posted"`: 1 failed, `seeds an absent tenantId ...` (`expected [] to deeply equal [ {...} ]`); the second case passed (PIN) | toursApi 230 + toursReopenApi 18 + scheduledUpdatedEvent 7 = 3 files / 255 on the UNCHANGED route; `npm run typecheck` 0; eslint 0 |
| 3.3 POST /api/tours | 29085db2 | 8 failed, 2 passed (10): the 404 case and the six 409 cases got 201; the tenant case got 201 without a `{ consistentRead: true }` call; both PINs passed | toursCreateContactType, toursApi, toursReopenApi, scheduledUpdatedEvent, devGating: 5 files / 306 |
| 3.4 PATCH revive from canceled | 11be6dcd | 10 failed, 5 passed (15): four landlord revivals, the caseworker and the missing-contact cases got 200; the four tenant revivals lacked the consistent read; the five PINs passed | toursReviveContactType, toursApi, scheduledUpdatedEvent: 3 files / 252; extra toursReopenApi + toursCreateContactType 2 files / 28 |
| 3.5 POST reopen | e824e63a | 8 failed, 1 passed (9): three landlord cases, caseworker and missing contact got 200; three tenant cases lacked the consistent read; the PIN passed | toursReopenContactType, toursReopenApi: 2 files / 27 |
| 3.6 POST /api/placements | ca5b7f0d | 8 failed, 1 passed (9): five non-tenants and the `lost` start got 201; the unit-order case got 404 (`expected 404 to be 409`, unit_not_found); the tenant case lacked the consistent read; the 404 PIN passed | placementsCreateContactType, placementsApi, sse, unitsApi, contactVoucherSync: 5 files / 108 |
| 3.7 POST from-tour | a4b556de | 5 failed, 1 passed (6): four non-tenants got 201 (converted); the tenant case lacked the consistent read; the 404 PIN passed | placementsFromTourContactType, placementConvert, toursReopenApi: 3 files / 43 |
| 3.8 transitionPlacement terminal exit | cb15fb32 | 6 failed, 3 passed (9): three landlord exits and the caseworker resolved (`expected {...} to be an instance of ContactNotTenantError`); the missing tenant `promise resolved ... instead of rejecting`; the tenant case lacked the consistent read; three PINs passed | statusTransitionContactType, statusTransition, transitionRoutes: 3 files / 97 |
| 3.9 handleTransitionError | b6aeee3f | 3 failed, 2 passed (5): the three refusals answered 500 (`expected 500 to be 409` / `to be 404`); both PINs passed | transitionRoutesContactType, transitionRoutes: 2 files / 30 |
| 3.10 deriveTenantStatus skip | c474d923 | 4 failed, 1 passed (5): the stored status read `placing` / `searching` instead of `interested` / `active` (first assertion of each); the PIN passed | deriveTenantStatusSkip, statusTransition, transitionRoutes, placementConvert, placementsApi, unitsApi: 6 files / 195 |

Before its commit every task ran eslint on its files (0) and the C2 ASCII
checks (0); Tasks 3.4-3.10 also ran `npx tsc -p tsconfig.json --noEmit` in
`app` (0), Task 3.1 `tsc -p tsconfig.test.json` (0) and Task 3.2
`npm run typecheck` (0). Task 3.3 ran no typecheck of its own; its route edit
was compiled by Task 3.4's run and by gate step 2.

Where the code landed:
- `app/src/services/contactTypeGuards.ts`: error classes `:25`, `:33`, `:41`,
  `:49`; `requireTenantContact` `:62` (consistent read `:66`);
  `requireLandlordContact` `:77` (consistent read `:81`);
  `sendContactTypeError` `:91`. Imports only `express` types,
  `lib/caseworkers.js` (`contactKind`, a leaf) and contactsRepo types - no
  cycle.
- `app/src/routes/tours.ts`: imports `:141-142`; create check `:355` (after
  the body validation, before `tours.create` `:367`); revive check
  `:1404-1411` (after the transition guards and the patch build, before the
  one write `tours.patch` `:1421`); reopen check `:1696` (after the
  `reopenTargetFor` decision, before `reopenIf` `:1701`).
- `app/src/routes/placements.ts`: import `:68`; create check `:582` (before the
  unit check `:587` and `placements.create` `:595`); from-tour check `:678`
  (before the unit check `:683` and the conversion claim `:720`).
- `app/src/services/statusTransition.ts`: import `:48`; deriveTenantStatus
  skip `:345` (the read at `:338` stays eventually consistent, CONTRACT ISSUE 5
  as ruled); terminal-exit check `:421` (before the first write
  `placementsRepo.update` `:477`).
- `app/src/routes/statusTransition.ts`: import `:45`; `handleTransitionError`
  `:331` maps the guard errors first (`:336`). Its three callers (`:214`
  transition, `:291` tenant-status, `:323` listing-status) share it; only the
  transition can raise the new errors.

## W3 - every fixture fixed (the rule was never weakened)

- `app/test/toursApi.test.ts`: the file-local tenant fixture (CONTRACT ISSUE 3,
  ruling S3-3): `harnessWorlds` `:71`, the `makeWebhookHarness` wrapper `:73`,
  `seedPostedTenant` `:82`, `authed().post('/api/tours')` seeding at send time
  `:91`; pinned by the two fixture tests at `:122`. It covers all 137
  `POST /api/tours` calls in the file (every one goes through `authed()`,
  checked by script). The ladder test `400 relay_member_unresolvable names
  each missing rung of the resolution ladder` now creates its tour in the store
  (`:3332`), because its first rung needs the missing tenant.
- `app/test/toursReopenApi.test.ts`: `createTour(app, world)` `:83` seeds
  TENANT as a typed tenant when absent; all 16 callers pass `world`.
- `app/test/scheduledUpdatedEvent.test.ts`: the four tour tests push
  `contact-tenant-1` typed tenant (`:57`, `:68`, `:79`, `:96`).

No other fixture needed a fix. The plan's re-check grep, re-run after Task
3.3, hit only the files the sweep names (plus the new test file); the only
direct router/service builders (`placementsApi.test.ts`,
`seedHistory.test.ts`, `statusTransition.test.ts`,
`statusTransition.integration.test.ts`) all stayed green. After Task 3.10 I
also ran the eleven other suites that touch derivation, transitions or
`status_source` (aiRunVerdicts, contactTriage, importApply.integration,
seedData, seedHistory, seedLive, seedMatrix, statusModel,
statusTransition.integration, suggestions, unitFields): 11 files / 370 passed,
DynamoDB Local suites included.

## Orchestrator corrections

- C1 (RC-F1): the comment in the no-show draft test (`toursApi.test.ts:2615-2619`)
  was replaced with RC-S3-findings F1's exact new_string in Task 3.2's commit
  (as step 3g). No assertion changed; the test stays green (a nameless tenant
  takes the same no-name fallback as an absent one).
- C2: every ASCII check ran from the worktree with an explicit `cd`, a
  `test -f || echo MISSING` per file, `tr` over each new file and
  `git diff -U0 19607658 -- <edited files> | grep '^+'` over the edited files,
  in each task and at the gate. All printed 0; no MISSING line.

## Divergences from the plan

- Code and tests of Tasks 3.1-3.10: none. Every old_string matched exactly once
  and every new_string is the plan's text.
- Task 3.2's commit carries one extra body paragraph naming the C1 comment fix;
  its subject is the plan's.
- Task 3.1's RED message reads `Cannot find module` / `Failed to load url`
  rather than the plan's `Failed to resolve import`; same cause (the module did
  not exist).
- Task 3.10's RED: each skip case failed at its first assertion (the stored
  status), so the audit-row and skip-line assertions the plan also names were
  not observed separately; the GREEN run proves all of them.
- Gate form: each vitest and typecheck run redirected its output to a file
  under `.superpowers/sdd/logs/` and echoed `$?` (a redirect, never a pipe), as
  in S2. Same command lines otherwise.
- Extra, for the record: per-task `tsc` and eslint, the merge-base lint
  baseline (not required - eslint reported nothing), the section-0 coverage
  check, and the eleven wider suites above.
- No good divergence found (nowhere was the live code better than the plan).

## Half-slice gate (bare commands, from the worktree, at c474d923)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app vitest, the plan line 9177 command exactly (20 files) | 0 | 20 files, 596 passed |
| 2 | `npm run typecheck` | 0 | all five workspaces (app incl. scripts and tests) |
| 3 | `npx eslint` on the 17 `app/...` paths of plan line 9188 | 0 | no output; `--print-config` on `tours.ts`: 47 rules, `@typescript-eslint/no-unused-vars` at error |
| 4 | ASCII (C2) | - | 10 new files: 0 each, no MISSING; 7 edited files, added lines vs 19607658 (215 `+` lines): 0 |
| 5 | coverage: `git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx'` | 0 | 47 paths, every one in the S1 (plan line 3253 + aiRunVerdicts.test.ts), S2 (5558) or S3 (9188) list |

Lint: clean. The section-0 merge-base baseline (a diagnostic) shows the 7
existing files lint clean at base too (rc 0 each); the 10 new files have no
baseline and lint clean on the branch. No pre-existing error to name in these
files. The two baseline dashboard errors (`TourDetail.tsx`,
`ScheduleTourForm.tsx`) belong to the dashboard half's gate.

No `[dynamoAdmin]` line appeared in any of the slice's 35 run logs (tasks,
gate, wider suites, mutants). DynamoDB Local was already up; it was not
started, restarted or stopped. No `AWS_*` variable was exported in the shell.

## Mutant check

Each mutant was applied and reverted with the Edit tool; the sha256 of the five
mutable files was checked against a pre-mutant baseline after every revert
(all OK). Every mutant ran the full 20-file gate list. After the last revert
`git status` was clean and `git diff --stat` empty.

| Mutant | Where | Tests that went red (of 596) |
|---|---|---|
| M1 create never reads the contact | `tours.ts:355` commented out | 8, all `toursCreateContactType.test.ts`: the consistent-read case, the 404, the five 409s, the timeless case |
| M2 revive checks only a result of `scheduled` | `tours.ts:1404` | 4, `toursReviveContactType.test.ts`: `status toured` / `status no_show` 409 for a landlord, and their tenant consistent-read cases |
| M3 also checks open -> open | `tours.ts:1404` | 3: the two open-to-open PINs (`expected 409 to be 200`) and toursApi `UNRELATED PATCH on an already-terminal tour rotates nothing and sweeps nothing` (a store-created toured tour with no tenant contact, `expected 404 to be 200`) |
| M4 reopen skips the guard | `tours.ts:1696` commented out | 8, all `toursReopenContactType.test.ts`: three consistent-read, three landlord 409, caseworker, 404 |
| M5 from-tour checks AFTER the claim | the check moved below `placements.ts:720` | 5, `placementsFromTourContactType.test.ts`: the four 409s and the 404 PIN - the status codes still matched, but `expectTourUntouched` failed on the claim's `pending:` sentinel left on the tour |
| M6 transitionPlacement checks every move | `services/statusTransition.ts:420` | 9: the three PINs of `statusTransitionContactType.test.ts`, three `deriveTenantStatusSkip.test.ts` cases (landlord, caseworker, lost bounce) and three `statusTransition.test.ts` cases whose tenant is not in the world (inspection_date / rent_determined captures) |
| M7 ContactNotTenantError -> 400 `{ error }` | top of `handleTransitionError` | 2, `transitionRoutesContactType.test.ts`: both 409 cases (`expected 400 to be 409`) |
| M8 no non-tenant skip | `services/statusTransition.ts:345` | 4, `deriveTenantStatusSkip.test.ts`: the four skip cases |
| M9 requireTenantContact reads without consistentRead | `contactTypeGuards.ts:66` | 12 across 7 files: every "read CONSISTENTLY" case (guards unit test, create, four revivals, three reopens, placements create, from-tour, the service's lost exit) |

## Surprising, or sub-threshold worries

- M5 shows what the order protects: a tenant check placed after the claim
  leaves the `pending:` sentinel on a refused tour, which would then answer
  every later conversion 409 `tour_already_converted`. The pinned order
  (check before claim) is load-bearing, and the tests see it.
- `deriveTenantStatus`'s read (`services/statusTransition.ts:338`) and the
  service's placement read that decides "leaving a terminal stage"
  (`:408`, used by the check at `:420`; RF1-F3) stay eventually consistent -
  both as ruled (CONTRACT ISSUE 5, L1 class); recorded only.
- `contactKind` is `String(type)` for a non-caseworker, so a legacy contact row
  with no `type` would answer `contactKind: 'undefined'`. The dashboard's
  fallback phrase ("not a tenant", CONTRACT ISSUE 2) covers it; no such row is
  known.
- The tours create route still never checks that the unit exists (pre-existing,
  out of scope); the new tenant check simply runs before the create.
- `from-tour` reads the tour eventually consistently and never checks its
  status (RF1-F4: a canceled but `convertible` tour converts); the tenant check
  is independent of that, so I2 holds. Pre-existing; recorded only.

## HANDOFF for the dashboard implementer (Tasks 3.11-3.18)

The wire shapes shipped. Both bodies are exact (no other keys); the dashboard's
`ApiError` puts `error` in `code` and the whole JSON in `body`, so
`body.contactKind` is readable.

- 404 `{ "error": "tenant_not_found" }`
- 409 `{ "error": "contact_not_tenant", "contactKind": <kind> }` - `<kind>` is
  `caseworker` (a partner whose role is a caseworker role) or the stored type:
  `landlord`, `partner`, `team_member`, `unknown`. Never `tenant`. Treat any
  other value (or none) with the "not a tenant" phrase.

Per route, and what still answers BEFORE the tenant check:

| Route | When it can answer the two codes | Earlier answers kept |
|---|---|---|
| `POST /api/tours` (ScheduleTourForm) | every create, timed or timeless | 400 body/validation errors |
| `PATCH /api/tours/:id` | ONLY when the stored status is `canceled` and the result is open: `{ scheduledAt }` alone (auto-advances to scheduled), or `{ status: 'scheduled' \| 'toured' \| 'no_show' }` (the Reschedule dialog on a canceled tour). Never for a move between open statuses (Mark toured / no-show on a scheduled tour, a no_show reschedule) or into canceled / closed | 400 validation; 404 `tour_not_found`; 409 `illegal_status_transition` / `illegal_exit_gate`; 400 `scheduledAt is required ...` |
| `POST /api/tours/:id/reopen` (Reopen dialog) | every reopen that would proceed | 400 body; 404 `tour_not_found`; 409 `tour_not_closed` / `tour_converted` / `tour_reopen_unsupported` |
| `POST /api/placements` (PlacementCreateForm) | every create, any starting stage; the 404 shape is unchanged from before | 400 validation |
| `POST /api/placements/from-tour` (TourDetail Start placement / outcome then convert) | every conversion that passed the fast-path checks | 400 body; 404 `tour_not_found`; 409 `tour_not_convertible`; 409 `tour_already_converted` (fast path) |
| `POST /api/placements/:id/transition` (PlacementsPage / PlacementDetail stage moves) | ONLY a move from `moved_in` or `lost` into a non-terminal stage | 400 route validation (`toStage`, `source`, `lostReason`, `finalRent`, `inspectionOutcome` ...); 400 `{ error: 'bad_stage' }`; 404 `placement_not_found`. The service's other 400 refusals key on non-terminal `from` stages, so they never meet this check |

After the tenant check: tours PATCH 409 `tour_changed` (a concurrent status
change) and reopen 409 `tour_changed`; placements 404 `unit_not_found`;
from-tour's racing claim 409 `tour_already_converted`. A refusal writes
nothing on any route (no tour, reminder, emit, audit, milestone, claim or
placement).
