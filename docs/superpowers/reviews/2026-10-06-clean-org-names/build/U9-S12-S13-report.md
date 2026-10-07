# U9 report - S12 (seeds use list names + the org-list item) and S13 (POST /__dev/org-fixture)

- Implementer: U9 (Opus 5.5), 2026-10-07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Range: plan Tasks 12.1-13.1 (plan lines
  15378-16211) plus worklist items RD-5, RD-6 (optional, done), RD-3.
- Start: a5e98146 (clean tree, no MERGE_HEAD). End: 7b08ae56 (clean tree).
- S13's full-suite checkpoint (`npm test`) NOT run - the orchestrator's.
- Logs: `.superpowers/sdd/u9-*.log` (gitignored).

## Per task

### Task 12.1 - aa6cabce feat(seed): seed the org-list item with fixed ids; the seed put covers the reseed window (D2)
- Files: app/src/lib/seed/orgList.ts (new), app/test/seedOrgNames.test.ts
  (new), app/src/lib/seed/lean.ts, app/src/lib/devReset.ts (comment only),
  app/test/seedProfile.integration.test.ts (+ RD-5 "Verifies four things:").
- RED: both files fail to load - "Cannot find module '../src/lib/seed/orgList.js'".
- GREEN: seedOrgNames 3, seedProfile.integration 5 (DynamoDB Local up, NOT
  skipped; the new D2-window case ran first on empty tables), seedData 15,
  seedMatrix 51 -> 4 files / 74 passed, exit 0.
- Gates: typecheck exit 0.

### Task 12.2 - b305c8f1 feat(seed): the lean world uses org-list names (spec section 7)
- Files: lean.ts, seedData.test.ts (:216 pin -> 'Atlanta Housing Authority'),
  seedOrgNames.test.ts.
- RED: offList(SEED) held 7 values (housingAuthority "atlanta_housing" x3,
  authorities_served "atlanta_housing"/"ga_dca", accepted_authorities x2), the
  slug regex matched, and seedData's Renee pin got 'atlanta_housing'.
- GREEN: seedOrgNames 5 + seedData 15 + seedProfile.integration 5 = 25 passed,
  exit 0. Check grep on lean.ts for the slugs printed nothing.

### Task 12.3 - 799ae20d feat(seed): cast and live seeds use org-list names (spec section 7)
- Files: cast.ts, live.ts (buildLiveStaticItems exported, no behavior change),
  seedOrgNames.test.ts, seedUnreadFlag.test.ts (RD-6, comment only).
- RED: cast offList held 12 values (dekalb/fulton/atlanta/ga_dca slugs);
  live threw "(0 , buildLiveStaticItems) is not a function".
- GREEN: seedOrgNames 7, seedLive 18, seedPersonaDrift 25, seedRosterShape 2,
  seedUnreadFlag 4 -> 5 files / 56 passed, exit 0. Slug grep on cast.ts +
  live.ts printed nothing.
- Gates: typecheck exit 0.

### Task 12.4 - fabbf80c feat(seed): the matrix pool and seeded broadcast filters use org-list names (spec section 7)
- Files: matrix.ts, seedOrgNames.test.ts.
- RED: matrix offList held 98 slug values; broadcast filters were
  ['atlanta_housing', 'ga_dca'].
- GREEN: seedOrgNames 9, seedMatrix 51, seedMatrixCoherence 40, seedHistory 40
  -> 4 files / 140 passed, exit 0. Extra fallout: seedUnreadFlag,
  seedRosterShape, seedTourTrails, castMessageTransport, seedMessageTransport
  -> 5 files / 33 passed. `_housing'|ga_dca` grep on matrix.ts printed nothing;
  the broadcast body_template lines (pre-existing non-ASCII) untouched.
- Gates: typecheck exit 0.

### Task 12.5 - e56b455f feat(seed): the performance seed writes Georgia Department of Community Affairs, not a spelling
- Files: performance.ts, seedOrgNames.test.ts.
  PERFORMANCE_SEED_WORKLOAD_MODEL_VERSION stays 2 (as the plan says).
- RED: offList held 55 values - housingAuthority "Georgia DCA" and 8
  accepted_authorities "Georgia DCA" members.
- GREEN: seedOrgNames 10, performanceSeed 134, seedUnreadFlag 4 -> 148 passed,
  exit 0. Extra: performanceSeed.integration 12 passed (exit 0); e2e workspace
  `npx vitest run performance/` 17 files / 473 passed (exit 0).
- Gates: typecheck exit 0.

### Task 13.1 - 7b08ae56 feat(dev): POST /__dev/org-fixture plants raw organization values for e2e (plan 3.12)
- Files: app/src/routes/dev.ts, app/test/devOrgFixture.test.ts (new),
  e2e/README.md (dev-surface bullet).
- RED: 14/14 failed - every POST answered 404 (no route), e.g. "expected 404
  to be 200"; 404 case "expected {} to deeply equal { error: 'contact_not_found' }".
- GREEN: devOrgFixture 14 + devTourAutoCloseTick 7 = 21 passed, exit 0.
  Extra fallout: the other 7 dev* suites (devGating, devGroupGuardrailTicks,
  devJournalSweepTick, devLogtail, devMessageTransportFixture, devMode,
  devRelayReplay) -> 101 passed, exit 0.
- Gates: typecheck exit 0.

## Final re-run on 7b08ae56

All 14 task-level suites together (seedOrgNames, seedProfile.integration,
seedData, seedMatrix, seedLive, seedPersonaDrift, seedRosterShape,
seedMatrixCoherence, seedHistory, performanceSeed, seedUnreadFlag,
seedTourTrails, devOrgFixture, devTourAutoCloseTick): 14 files / 389 passed,
exit 0, no `[dynamoAdmin]` line.

## Lint (gate 5 preview on every touched .ts file)

`npx eslint` on the 13 touched TS files: 8 errors, ALL pre-existing - the same
rules and identifiers lint at merge base d839494a (base run via `--stdin`;
lines shift only by my inserted lines). New files clean. Add to the gate-5
baseline list:
- app/src/lib/seed/cast.ts no-unused-vars `CP`, `poolNum`, `listingSendId`,
  `UNIT_SEARCHING_A` (base :79 :109 :110 :434)
- app/src/lib/seed/live.ts no-unused-vars `overdueAt`, `followUpAt` (base :129 :131)
- app/src/lib/seed/matrix.ts no-unused-vars `DEADLINE_TYPES` (base :134)
- app/test/seedProfile.integration.test.ts no-unused-vars `getTableSpec` (base :16)

## Divergences from the plan / worklist

1. RD-6 (optional) done in Task 12.3's commit, slightly wider than "reason 1":
   reason 1 now says the builder was module-private when the guard was
   written and is EXPORTED now (for seedOrgNames.test.ts), so the exclusion
   rests on reason 2; the closing line "export the builder and add it below"
   (stale once exported) became "add `buildLiveStaticItems(now)` below".
   Comment only, ASCII.
2. Import placement: "add to the import block" - the cast/live/matrix/
   performance imports sit directly under the seed/orgList.js import in
   seedOrgNames.test.ts. No code change.
3. Anchor drift only (text matched exactly once): the deadline-fixture
   route's closing lines were at dev.ts:1182-1187 (plan said 1177-1182).
No other divergence; every plan code block transcribed verbatim.

## Out of scope noticed (not changed)

- S14 (already named by the plan's Task 12.2 NOTE): the lean world now holds
  `Atlanta Housing Authority` / `Georgia Department of Community Affairs`, so
  e2e/tests/dashboard-next/contact-detail.spec.ts:90 (+ restore :109),
  e2e/support/selectors.md:117, e2e/scenarios/steps.ts:827, :958-959, :974,
  and the comments at contacts-list-facets.spec.ts:11-12 and
  broadcasts.spec.ts:20 are stale or failing until S14.
- Nothing in app/e2e/dashboard indexes `SEED.settings[0]` or pins a lean
  item count, so the extra settings row is safe (grep).
