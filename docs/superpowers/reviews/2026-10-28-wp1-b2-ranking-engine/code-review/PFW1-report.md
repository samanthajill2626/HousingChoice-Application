# B2a planner fix wave PFW1 - implementer report (2026-10-29)

Branch feat/wp1-b2-ranking-engine, worktree W:/tmp/wp1-b2-ranking-engine.
Base: 1fc83739 (spec rev 7, charter items 15-16). Scope: the planner's
PFW1-1 .. PFW1-5 (the worktree's gitignored
.superpowers/sdd/PFW1-planner-instruction.md) with the orchestrator's binding
notes; spec D10 rev 7, charter section 20 items 15-16 and 7.2, intent.md
"Handback-review rulings (2026-10-29)" and planner-adjudications.md read
first. handback.md and the ledger were NOT touched (the orchestrator's).

## Commits (in order)

| Commit | Row | One line |
|---|---|---|
| 1a590afb | PFW1-1 | an unlawful-flag record always stores the fixed reason, never a pair's text |
| de8c1f2c | PFW1-2 | open unlawful flags show only for a property anchor's ranking and runs |
| d6ef89d8 | PFW1-1 follow-up | a valid reason source in the PFW1-1 landlord flag test (typecheck caught it) |
| 2a131b18 | PFW1-3 | the property page's read-only fair-housing notice, re-checked after a save |
| 45fc3326 | PFW1-3 | e2e pickTenant: a click and a web-first check (see deviation 7) |
| 40238a00 | PFW1-4 | GLOSSARY and RUNBOOK: the fixed reason and where flags show |
| 0a7c85f7 | PFW1-5 | seven new issues, two appends, the flag-reason decision resolved |

(This report is committed on its own after them.)

## PFW1-1 - the record's reason is always the fixed sentence (PA-1, Q1 = a)

Changes:
- app/src/services/ranking/flags.ts: `flagReason`, `fieldWords`, `folded`
  removed (were :61-82); `mergeRaisedFlags` writes `DEFAULT_FLAG_REASON`
  (:95); header paragraph on why (:20-24); `DEFAULT_FLAG_REASON` documented
  (:29-30).
- app/src/repos/rankingRunsRepo.ts:861 - the `reason` doc comment now says
  "Always the fixed sentence, never the model's text".

Tests (RED for the stated reason, then GREEN):
- app/test/rankingFlags.test.ts:66-116 replaces the old `flagReason` block
  (:67-88): an accessibility case ("tenant uses a wheelchair" in against and
  unknowns), a pets case ("tenant has 2 cats", "assistance animals") and a
  landlord: flag - each pins `reason === DEFAULT_FLAG_REASON` and that no pair
  word appears anywhere in the record. RED: 3 failed, "expected 'no pets
  rule, tenant has 2 cats' to be 'flagged as a requirement fair housing...'".
- app/test/rankingRunBatch.test.ts:323-341 (the issue's suggested test):
  after runBatch the stored record holds the fixed sentence and no pair text,
  while the run's own results keep the pair's against text. RED: "expected
  'accessibility: 3rd floor walkup, tenant uses a wheelchair' to be 'flagged
  as ...'".
- GREEN: 2 files, 36 tests. Typecheck then refused the landlord case's
  reason `source: 'qualifications'` (not a reason source): one-value test fix
  to `'requirements'` in d6ef89d8, no behavior change.

## PFW1-2 - flags only for a property anchor (Rankings page)

Changes:
- app/src/services/ranking/readRanking.ts:477-488 - `flags` is `[]` for a
  tenant anchor (field KEPT: the dashboard type is non-optional); the type
  doc (:113). The cap is untouched: a tenant anchor still reads each
  candidate property's open flags (:426-456) into `openFieldsByUnit`.
- app/src/routes/adminRankings.ts:268-287 - a tenant-anchor run reads NO
  flag record (no `flags` entries, never `flagsUnavailable`); a
  property-anchor run reads its one property (loadPropertyFacts + openFlags).
  The per-unit `mapWithConcurrency` walk and its import went with the
  candidate reads; header note :31-33.
- dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:36 and
  RankingRunDetail.tsx:54-56 - the panel and the run detail show no flag line,
  section or "Could not read the open fair-housing flags." note for a tenant
  anchor whatever they are sent (deviation 3).
- dashboard/src/api/types.ts - the flag view, `flags` and `flagsUnavailable`
  doc comments.

Tests:
- app/test/rankingRead.test.ts:215 - a tenant anchor reads each candidate
  property's flags (spy: u-1, u-2), the open flag still keeps u-1's failed
  qualifications from capping (capped false, band strong), and
  `flags` is `[]`; :167 the PR17 case now expects `[]`. RED: "expected [
  { unitId: 'u-1', ... } ] to deeply equal []".
- app/test/rankingsApi.test.ts:238, :246 - GET /api/rankings through the
  REAL readRanking (the `read` seam wired to it): a tenant anchor answers
  `flags: []` though a candidate's flag is open; a property anchor answers its
  own flag with the fixed reason. RED on the tenant case.
- app/test/adminRankingsApi.test.ts:252 - a tenant-anchor run makes no flag
  read (even one that would throw), `flags: []`, no `flagsUnavailable`, pairs
  untouched (RED: "expected [ 'u-1', 'u-2', 'u-3' ] to deeply equal []");
  :271 pins a property-anchor run's failed read -> `flagsUnavailable` (green
  before and after: a pin). The old WL-S6-4 concurrency test (five candidate
  properties, RANKING_READ_CONCURRENCY 2) was removed: there are no candidate
  reads left to bound.
- dashboard RankAnchorPanel.test.tsx:192 and RankingRunViews.test.tsx:351 -
  RED (the panel rendered the line / the section and note), then GREEN.
- e2e rankings.spec.ts had no assertion of a flag line on a tenant anchor
  (nothing to update); the new PFW1-3 test asserts the tenant ranking shows
  none.

## PFW1-3 - the property page notice (new)

Server:
- app/src/routes/rankings.ts:168-198 - `GET /api/rankings/:anchorKind/:anchorId/flags`
  (served for `unit` only): 400 `invalid_anchor_kind` for a tenant (and the
  parse 400s), 404 `anchor_not_found` for a missing or soft-deleted
  property, 200 `{ flags: [{ field, label, reason }] }`, 503
  `flags_unavailable` on any failed read (WARN with the unitId). Behind the
  /api mount's requireAuth only: admin AND va. Header contract :7-17. Deps:
  `contactsRepo` widened to `getById | getManyByIds`, new `flagsRepo` seam.
- app/src/services/ranking/propertyFlags.ts (new) - `readPropertyFlags`:
  the ranking's one anchor-exists rule (pool.ts readRankingAnchor, PR21) on
  a CONSISTENT unit read (:49-52), the facts from assemble.ts
  `propertyFactsOf` (landlord-card switch and landlord defaults honored),
  then `getOpenCandidateFlags` + flags.ts `openFlags` - no second definition
  of open. Returns field, label, reason only (no run id, no pair text).
- app/src/services/ranking/assemble.ts:505-541 - `loadPropertyFacts` now
  reads the units then calls the new `propertyFactsOf` (the landlord read +
  `propertyFacts` mapping, unchanged); see deviation 1.
- app/src/services/ranking/cardFields.ts:350-363 - `flagFieldLabel`: the
  PROPERTY_CARD_FIELDS label ("Qualifications", "Lease terms", ...); a
  `landlord:<key>` flag reads "<label> (from the landlord)"; an unknown key
  reads as its words.

Dashboard:
- dashboard/src/api/endpoints.ts:3106-3113 `getUnitFairHousingFlags`;
  types.ts:688-700 `UnitFairHousingFlag`, `UnitFairHousingFlagsResponse`.
- dashboard/src/routes/listing/useUnitFlags.ts (new) - reads on mount (in
  parallel with the page), again when `check` changes, not while `enabled`
  is false (a deleted property) and again when it turns true (a restore); a
  404 is "no notice", any other failure the `error` state; the previous
  answer stays up during a re-check; an answer never shows for another unit.
- dashboard/src/routes/listing/FairHousingFlagNotice.tsx + .module.css (new)
  - one line per open flag: "Fair-housing flag - <label>: <reason>. Edit
  this text to clear the flag."; nothing while loading or with no flag; the
  failure note "Could not check fair-housing flags." is a plain <p>, never an
  alert (the perf registry's error terminal is `alert`); no button (B4's
  Dismiss).
- dashboard/src/routes/listing/ListingDetail.tsx:247-254 (the hook, a
  `flagsCheck` counter, `enabled = !deleted`), :952-954 (the notice under the
  header; none on a deleted property), :1631-1637 (ListingEditForm onSaved
  bumps `flagsCheck`). The Requirements, Notes and Tour & application cards'
  Edit open the same ListingEditForm, so every free-text edit re-checks.

Perf registry: e2e/performance/templates.ts:161-162 (the template; required
by `assertEndpointTemplate` - deviation 2), routes.ts:352-353
(UNIT_DETAIL_BASE_GETS) and the '/listings/:unitId' provenance string (:813),
routes.test.ts:139. The mutation catalog is unchanged (no new mutation) and
green.

Tests (RED, then GREEN):
- app/test/rankingCardFields.test.ts:371-393 `flagFieldLabel` (every
  free-text field's label, landlord twins, unknown key). RED: "flagFieldLabel
  is not a function".
- app/test/rankingsApi.test.ts:286-409 the route through the real wiring with
  fake repos: VA 200 and admin 200 with OPEN flags only (a closed record
  omitted) and `getById` called with `consistentRead: true`; an edit to the
  flagged text -> `{ flags: [] }`; a landlord: flag open with the switch on
  ("Qualifications (from the landlord)"), closed with the switch off, closed
  when the property records its own value; tenant 400, missing 404,
  soft-deleted 404 with no flag read; a failed read 503; 401 with no session.
  RED: 404 (no route) on every case but the 401.
- dashboard/src/api/rankings.endpoints.test.ts:76-85 (path, encoding,
  signal). RED: not a function.
- dashboard/src/routes/listing/useUnitFlags.test.tsx (new; 6 tests): mount
  read, re-check on `check` with no flicker, error, 404 = no notice,
  disabled then enabled, no cross-unit leak. RED: module missing.
- dashboard/src/routes/listing/ListingDetail.test.tsx:3452-3525 (the hook
  mocked, like useListing): the notice's exact lines (incl. a landlord flag)
  and no control inside it, the five Edit buttons unchanged; nothing when no
  flag or in flight; the failure note with the page intact and no alert;
  a real save through the edit form (Qualifications typed, `updateUnit`
  called) re-checks (`useUnitFlags` last called with check 1) and the notice
  goes; a deleted property shows none and asks with `enabled` false. RED: 4
  failed (no notice rendered).
- dashboard/src/routes/listing/useListing.test.tsx - its api mock gained
  `getUnitFairHousingFlags` (its last cases render ListingDetail with real
  hooks); test-only.
- e2e/tests/dashboard-next/rankings.spec.ts:269-326 (new test): a property
  whose notes hold `[fake:unlawful:qualifications]` and whose qualifications
  hold text (e2e/fixtures/ranking.ts:77-99 gained `notes` and
  `qualifications`), one authority-matched searching tenant; Rank, tick; the
  property ranking's facts list shows "Fair-housing flag on <line1>..." and
  "qualifications: flagged as a requirement fair housing does not allow";
  the tenant anchor's ranking shows the pair (Good) and no "Fair-housing
  flag" text; the property page shows the exact notice line; the
  Qualifications text is edited in the edit form and saved; the re-check GET
  answers 200 and the notice is gone, with a window marker proving no
  reload. The VA case (:354-357) reads `GET /api/rankings/unit/unit-0001/flags`
  -> 200 `{ flags: [] }`.

## PFW1-4 - docs

- documentation/GLOSSARY.md:941-949 "Unlawful flag": the fixed reason
  (never the model's text), where it shows (the property page for every staff
  role; Settings > Rankings only for the property's own ranking and runs;
  never a tenant's ranking or the composer).
- RUNBOOK.md:1895-1908 "Fair-housing flags": the same, the notice's copy and
  the landlord label, the re-check after a save, the "Could not check
  fair-housing flags." note and its route, "B4 builds only the admin
  Dismiss".
- handback.md: not touched (the orchestrator refreshes it).

## PFW1-5 - issues (`npm run issues` exit 0: 465 open, 218 closed, 683)

New (frontmatter from _TEMPLATE.md; status open; created 2026-10-29):
- docs/issues/ranking-reason-text-protected-traits.md (decision, med, PA-2)
- docs/issues/ranking-spend-ceiling.md (decision, med, PA-3)
- docs/issues/ranking-stored-input-retention.md (decision, med, PA-4; extends A1-12)
- docs/issues/ranking-card-text-length.md (bug, low, PA-8 + PA-9)
- docs/issues/ranking-read-cost.md (improvement, low, PA-10)
- docs/issues/ranking-cost-undercount.md (bug, low, PA-12 + PC-2)
- docs/issues/ranking-notes-injection-surface.md (security, low, PA-13)

Appended: docs/issues/ranking-job-lifecycle-robustness.md (PA-6 = item 1,
PA-7 = item 3, with the new "not picked up" consequence) and
docs/issues/extraction-text-field-write-races-staff-fill.md (PA-11: the
cheap conditional-append idea, re-found).

Resolved: docs/issues/ranking-unlawful-flag-reason-source.md - `status:
resolved`, `resolved: 2026-10-29`, a Resolution paragraph naming PFW1-1
(1a590afb) and its tests.

## Verification (at 0a7c85f7)

| Check | Result |
|---|---|
| app: `npx vitest run ranking Ranking` (every ranking test file, the DynamoDB Local integrations included) | 47 files, 855 passed; no `[dynamoAdmin]` line |
| dashboard: `npx vitest run src/routes/settings/rankings src/routes/listing src/api/rankings.endpoints.test.ts` | 33 files, 872 passed |
| dashboard: `npx vitest run src/api` | 13 files, 188 passed |
| e2e: `npx vitest run performance` (registry + mutation catalog) | 17 files, 479 passed (RED first: 1 failed, the '/listings/:unitId' warm shape 13 vs 14) |
| root `npm run typecheck` | exit 0 |
| `npx eslint` on the 32 touched .ts/.tsx (`git diff --name-only --diff-filter=d 1fc83739..HEAD`) | exit 0 |
| ASCII: added lines in `git diff 1fc83739..HEAD` | 0 non-ASCII |
| e2e `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/rankings.spec.ts`, run 1 (at 2a131b18) | 5 passed, 1 failed: the new test, `locator.check: Clicking the checkbox did not change its state` in pickTenant (deviation 7) |
| same, run 2 (at 45fc3326) | 6 passed (14.6s) |
| `npm run e2e:stop` after each run | both found a stale session.pid, "nothing to stop"; no pid left |

Not run, by the orchestrator's rule (more than five): the existing specs
that open the property page, 16 files - broadcasts, caseworkers, flyer-leads,
listing-activity, listing-photos, matching-entry-points, org-lists,
partner-share, placement-create, primary-contact-integrity,
property-priority, property-requirements, property-roster,
send-outcome-cards, share-sent-outcome, tours-page (all under
e2e/tests/dashboard-next/). What they now see: one extra GET per property
page load; no notice (no open flag in their worlds); no new button, region,
status or alert unless a flag read fails.

The full gate battery (npm test, smoke, full e2e) was NOT run: the planner
runs it.

## Deviations and choices (each one line of reason)

1. Consistent read. The orchestrator note said reuse `loadPropertyFacts`;
   the flag route instead reads its unit with `getById({ consistentRead:
   true })` and builds facts through `propertyFactsOf`, split OUT of
   loadPropertyFacts (one builder, both call it). Reason: loadPropertyFacts
   reads through an eventually consistent BatchGet, so on real DynamoDB the
   re-check right after a save could read the old text and leave the notice
   up, against D10's "an edited field's notice goes at once". DynamoDB Local
   is always consistent, so only the route test (consistentRead pinned) can
   see this.
2. e2e/performance/templates.ts changed too (not in the allowed list): a
   template must exist for `required(...)` to typecheck and not throw
   `undeclared_endpoint_template`. Also the '/listings/:unitId' provenance
   string in routes.ts names useUnitFlags.ts:31-47 (documentation only).
3. The Rankings panel and the run detail also refuse to show flags for a
   tenant anchor on the dashboard side (a display guard over the server
   rule), so the planner's "panel" tests test something; the server stays the
   rule.
4. Restore re-checks through `enabled` (no read while deleted; a read when
   restored), so all four restore paths need no wiring; a 404 from the flag
   route is "no notice", never the failure note.
5. Label copy for a landlord default: "<label> (from the landlord)" - plain
   and short; staff copy elsewhere says "the landlord's requirements". Easy
   to change in cardFields.ts flagFieldLabel.
6. The fixed notice line ends "Edit this text to clear the flag." for a
   landlord default too, though that text lives on the landlord's record (or
   is cleared by giving the property its own value) - the planner's sentence,
   kept verbatim.
7. pickTenant (e2e) now clicks the Tenant radio and waits for toBeChecked
   instead of `check()`: from a property anchor the radio follows the anchor
   in the URL, which the router clears in a later render, so `check()`'s
   immediate state test failed although the page ended on Tenant (the error
   context shows `radio "Tenant" [checked]`). Not a product defect: the
   control settles one render later.

## Open points for the planner

- Per-pair "Flags" column on a TENANT-anchor run (left as it is, D11). It is
  RankingRunDetail.tsx:114 / :131, `flagsText(pair.fairHousingFlags)`
  (:22-25), fed from the run's OWN parsed results (adminRankings.ts:307,
  runLog.ts:72). On a tenant-anchor run it shows, on each candidate
  property's row, the model's flags for that pair as "<kind> on <field>"
  joined by ", " - e.g. "unlawful on qualifications" next to the property the
  model flagged in that run, and "accommodation on no_pets" for an
  accommodation - and "-" when none. It shows no reason text and nothing
  about whether the property's record is still open (it is that run's output,
  with the run's 180-day TTL). So a tenant-anchor RUN still names an unlawful
  flag per pair, while its "Open fair-housing flags" section is gone; whether
  D10's "its runs carry no flag list" covers this column is the planner's
  call. The ranking TABLE (RankingTable.tsx) shows no per-pair flags on either
  anchor.
- Roster writes that change the landlord of record (a landlord-slot claim)
  do not re-check the notice; a `landlord:<key>` flag (only with
  RANKING_LANDLORD_CARD on, default off) that opens or closes that way shows
  correctly on the next page load. The edit form and restores do re-check.

## Questions

None. Nothing in PFW1 contradicted spec rev 7 or a ruling.
