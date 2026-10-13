# Research findings - S3 (app reads) and S5.1-S5.5 (script, dev seam) vs the live tree

Reader: live-tree verification of plan
`docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` lines
11167-14028 (S3.1-S3.7) and 17524-19849 (S5.1-S5.5), at worktree tip
14c2856b (code tree byte-identical to the plan base 0e565b86 - `git diff
0e565b86 HEAD -- app dashboard e2e` is empty). Byte-exact quotations backing
every check live in the gitignored reference
`.superpowers/sdd/research-S3-S5app-reference.md`; this file cites code by
file:line only.

## Summary

- Anchor verification: 0 byte-level mismatches. Every old_string, import line,
  function/type name, test name and test-file anchor the two ranges quote was
  found in the live tree exactly once (or exactly as many times as the plan
  says - the S3.6 `res.json` line is present twice, units.ts:1311 and :1346).
  Plan anchors that depend on S1/S2 output (the units.ts propertyContact
  import, the restored `isDeleted as isContactDeleted` import, S2's
  byte-identical `res.json` lines - R16, `list`'s `consistentRead`) were
  traced through the S1/S2 task text and are consistent.
- Rulings R16, R17, R22, R23 hold against the code (details in the reference).
- Findings below are all LOW: two text inaccuracies in the plan, one coverage
  gap, two stale-doc/uncovered-consumer notes, three informational notes. None
  blocks the build.

## F1 (low, plan text) - S5's assumption names the wrong type for `consistentRead`

- Plan line 17604-17605 ("Assumptions on S1-S4") says S2 provides
  `ListUnitsOpts.consistentRead?: boolean`.
- S2 deliberately does NOT put it on `ListUnitsOpts` (plan line 3680-3683,
  S2 contract issue 7, and the S2.9 interface edit at plan line 9655-9666):
  it is typed on `list`'s own parameter, `ListUnitsOpts & { consistentRead?:
  boolean }`, because `ListUnitsOpts` also feeds the GSI queries
  (`app/src/repos/unitsRepo.ts:406-421` type; `:625-652` queryIndex) and
  DynamoDB rejects `ConsistentRead` on a GSI.
- No code impact: S5.3 calls `deps.units.list({ deleted: 'any',
  consistentRead: true, ... })` through `Pick<UnitsRepo, 'list' | ...>`, and
  the S5.3 test's `FakeUnits.list(opts = {})` is contextually typed from the
  same Pick, so both compile against S2's shape.
- Risk: a builder who "fixes" the mismatch by adding the field to
  `ListUnitsOpts` would widen it onto the GSI list methods. Correct the
  assumption line to name `list`'s parameter.

## F2 (low, plan text) - S5.5's RED step predicts the wrong status code

- Plan line 19685-19687 expects the RED run to fail with
  `expected 404 to be 201` (or `404 to be 400`).
- The dev router is mounted BEFORE the origin-secret validator
  (`app/src/app.ts:127-133`), and the S5.5 test requests carry no
  `x-origin-verify` header (only the "absent" test sets it). Before the route
  exists, the POST falls through the dev router to the validator, which
  answers `403 { error: 'forbidden' }` (`app/src/middleware/originSecret.ts:62`).
  The RED lines will read `expected 403 to be 201` / `403 to be 400` /
  `403 to be 404`.
- The RED/GREEN logic is unaffected (still only "is absent when the dev router
  is not mounted" passes at RED). Fix the expected text so a builder comparing
  RED output does not stop on a false mismatch.

## F3 (low-medium, coverage gap) - nothing executes the script's real wiring

- Every S5.4 CLI test injects `run` (and `resolveStage`), and every S5.3 run
  test injects fake repos; S5.1 integration-tests `assignPrimaryIfCurrent`
  alone and S2.9 tests `list({ consistentRead })` alone. No planned test calls
  `buildAssignDeps(stage, logger)` or `main`'s default `run`, i.e. the
  composition the operator actually runs.
- The pattern the script follows has such a test:
  `app/test/cleanOrgNames.test.ts:309` (`describe.skipIf(!reachable)(
  'clean-org-names against DynamoDB Local')`) drives `cleanOrgNames({ doc,
  env, apply })`, which builds its real deps via `buildCleanupDeps`
  (`app/scripts/clean-org-names.ts:447-469`).
- Failure mode: a wiring slip in `buildAssignDeps` (e.g. a repo built without
  the stage `env`, so it resolves the ambient `TABLE_PREFIX`) passes all 34
  planned script tests and surfaces only in the operator's dev run. The S5.4
  lane rehearsal that would catch it is marked optional (plan line
  19464-19468: "Not required for the task").
- Suggest one DynamoDB-Local case (skipIf unreachable, throwaway prefix, one
  470-Bolton-shaped unit and one live landlord-typed contact): run
  `assignPrimaryContacts(buildAssignDeps({ doc, env: testEnv }, logger),
  { apply: true })`, assert the stored flag, scalar and the backfill audit
  row - or make the lane rehearsal a required step.

## F4 (low, doc drift) - the spec text was not amended for R17 and R23

- Spec section 8 (spec lines 666-667) still says "The Activity projection
  whitelist (`routes/units.ts:217-248`) gains `reason`". R17 narrowed this to
  `unit_primary_contact_assigned` ONLY (confirmed: `listing_status_changed`
  stores staff free text under `reason` -
  `app/src/services/statusTransition.ts:647-653`, fed by
  `app/src/routes/statusTransition.ts:308-317`). Plan C11 is updated; the spec
  is not.
- Spec section 10 (spec lines 814-821) still says the seam "CREATES a NEW
  property and contact of its own ... one non-primary contact - and returns
  their ids". R23 (and plan contract 2.7) has the e2e spec create the
  contacts through `POST /api/contacts`; the seam writes only the unit, takes
  1-5 non-landlord rows and returns `{ unitId }`.
- The plan and rulings govern, so the build is unaffected; amend or annotate
  the spec before it is frozen as historical so the merged record does not
  describe a different seam and a blanket whitelist.

## F5 (low, uncovered consumer) - dashboard endpoint docblocks go stale; no task owns them

- No plan task touches `dashboard/src/api/endpoints.ts` (grep of the plan for
  `endpoints.ts` returns nothing). Its docblocks describe the routes S2/S3
  change:
  - `restoreUnit` (`endpoints.ts:1037-1043`): "Sole-landlord promotion ...
    with zero or two-plus, nobody. The answer's enriched roster carries the
    flags, so render the answer's roster" - S2.8 replaces
    `soleLandlordToPromote` with `chooseHeir` (earliest eligible), and
    R18/S4.10 make the page REFETCH after a restore instead.
  - `addUnitContact` (`endpoints.ts:1072-1079`): the caseworker-integrity
    auto-primary rule (no primary row and no landlordId) - S2 widens it (spec
    4.4) and adds 409 `primary_contact_deleted`.
  - `removeUnitContact` (`endpoints.ts:1100-1107`): "promotes the landlord of
    record in its place (or clears the primary entirely when the property has
    no landlordId)"; error list lacks 503 `roster_read_failed` - S2.5/S2.6.
  - `getUnit` (`endpoints.ts:995-1002`): silent on the S3.5 row flags and the
    `propertyContact` block.
- Spec 9.2's comment-correction list does not include this file. Suggest a
  one-commit docblock touch in S4 (S4.1 already edits the sibling
  `api/types.ts`).

## F6 (info, consumer not in the plan) - the landlord timeline will not show the new event

- `app/src/routes/contactTimeline.ts:1431-1450` reads every owned unit's
  `units#<unitId>` audit trail for a landlord's timeline, but keeps only
  `LANDLORD_FEED_TYPES` (`contactTimeline.ts:331-336`: broadcast_sent,
  listing_status_changed, unit_contact_added, unit_contact_removed). So
  `unit_primary_contact_assigned` (S2 handoffs, S5 backfill) appears on the
  property Activity card only, never on the landlord's timeline. Nothing in the
  spec asks for it; recorded so S4 and review do not assume otherwise.

## F7 (info) - the job's INFO line fires at compose time

- S3.2 / D6 logs `relay intro: general intro used` right after
  `composeIntroBody`, before `sendRelayAnnouncement`
  (`app/src/jobs/relayFanOut.ts:949-974`), which no-ops on an unusable
  (e.g. closed) conversation; spec 5.2 says "when it sends". The dev replay
  seam (`app/src/routes/dev.ts`, `/__dev/relay/replay-intros`, persist:false)
  will also emit it for owned seeded groups. Observability-only; acceptable.
- Nit: the S3.2 test's PII check stringifies the whole pino line including
  `hostname` (plan line 12326-12329), unlike S5.3/S5.5 which strip it (plan
  lines 18731, 19663). Harmless on this machine (`ABT-DESKTOP`); align for
  consistency if touched.

## F8 (info) - stale docblock on `RosterResolutionDeps`

- `app/src/lib/rosterResolution.ts:144-154` says an omitted tours / placements
  / settings pick makes the preview "degrade to the naked intro". After S3.1 it
  also yields `introFallback: { reasons: ['lookup_failed'] }`, which S4 renders
  as "Some property details couldn't be loaded." Both production open-preview
  routes wire what they need (`app/src/routes/tours.ts:689-697` - no
  `placements`, irrelevant for a tour owner; `app/src/routes/placements.ts:978-991`
  complete), and the job wires all five (`relayFanOut.ts:787-797`), so behavior
  is right. Only the in-test owner fixture (`app/test/rosterEdits.test.ts:117-148`,
  no tours/settings) hits it, and S3.3 1b/1c already account for that.

## F9 (info, e2e consumers) - existing dialogs that will now show the box

- `e2e/tests/tour-roster.spec.ts:228-296` and
  `e2e/tests/roster-quiet-hours.spec.ts:335-360` open the group on TIMELESS
  tours, so after S3+S4 the confirm dialog carries the fallback box
  (`tour_not_scheduled`). Their assertions are scoped by region / list / button
  names and exact strings and do not collide. The only `getByRole('status')`
  scoped inside a confirm dialog (`e2e/tests/dashboard-next/contact-create-relay-group.spec.ts:397`)
  is the standalone flow, which never carries `introFallback`. No change
  needed; S5.8's selectors.md row covers the two-status case.
