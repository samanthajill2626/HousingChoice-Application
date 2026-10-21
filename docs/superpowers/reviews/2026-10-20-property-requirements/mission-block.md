# MISSION: Landlord requirements and property fields (tracker #11 + #12)

Worktree: W:\tmp\property-requirements  Branch: feat/property-requirements  (cut from main @1d7a4667; main is 4 commits ahead as of 2026-10-20, docs + a merged fix - sync ONCE at the final pre-handback step, Task 7.8)
Profile: W:\AI Projects\Housing Choice\HC Application\.claude\feature-mission.profile.md
Spec: W:\tmp\property-requirements\docs\superpowers\specs\2026-10-20-property-requirements-design.md (revision 6, APPROVED by Cameron 2026-10-20)
Plan: W:\tmp\property-requirements\docs\superpowers\plans\2026-10-20-property-requirements.md (v3 - sections 0-4 BINDING incl. rulings AR1-AR48, 4.1, 4.2; slices S1-S7 in sections 5-11)
Records: W:\tmp\property-requirements\docs\superpowers\reviews\2026-10-20-property-requirements\ (commit every record as produced; intent.md is the planner's, do not edit it)
Design review: spec R4 (cap; Cameron decided O1/O2 at the gate) - design-review/adjudications.md; plan R2 (terminal) - plan-review/adjudications.md   [REQUIRED]

Work map (strictly sequential; each slice ends green on its own unit suites + `npm run typecheck`; e2e is NOT expected green until S7 - plan section 3 lists the stated mid-build breakage):
- S1 (Tasks 1.1-1.7) App foundations: app/src/lib/requirements.ts registry (items, kinds, interpretation, equality, sources, own value, snapshot parse, classification, planUnitApply, PROPERTY_FORM_FIELDS 35 rows), unit validator kinds, UnitItem / contact types, toUnitFlyer + the D10a walk.
- S2 (Tasks 2.1-2.6) App property writes: unitsRepo fenced methods (+ harness repo + parity), landlord-change REMOVEs, create snapshot + classification, PATCH fenced loop (retry, 409 property_changed, deposit_conflict, audit = keys actually changed), Activity reason lift.
- S3 (Tasks 3.1-3.3) App landlord + Apply: contacts PATCH req_ keys, the Apply route (contactRequirementsApply.ts), the full-profile demo seed (lean byte-stable).
- S4 (Tasks 4.1-4.6) Matching, app + dashboard: bedroomSizes normalizer / match rule (4 = 4 or more) / parse / wire / matrix seed; composer multi-select, pre-fill, summary, draft key.
- S5 (Tasks 5.1-5.9) Dashboard property forms: types + endpoints (+ e2e mutation catalog entry), registry mirror + drift test, FlyerTag / legend, VoucherSizePicker, RequirementsFields, ListingEditForm, UnitCreateForm (D7 prefill + snapshot).
- S6 (Tasks 6.1-6.12) Dashboard pages: requirementDisplay / formatItemValue, property Requirements card + ListingDetail rows + useListing re-read, listingFormat, FlyerPage wording, landlord Requirements card + ContactEditForm fieldset, Apply dialog + wiring.
- S7 (Tasks 7.1-7.10) e2e repairs + label sweep, the new e2e spec with its RED-by-mutation proof, selectors.md, GLOSSARY + mermaid, issue registry, main sync, the five gates, handback.

Watch items:
- Copy is BINDING (plan 1.1, AR3, AR32, AR38, 4.1): tests assert exact strings. ASCII only in every new or touched line.
- The harness units repo hands out LIVE objects: every caller of updateIfRequirementsCurrent / applyRequirements passes its own structuredClone of the read (AR6, PR1-6).
- Playwright getByLabel is a case-insensitive SUBSTRING match; the new labels collide with old selectors (plan 3.2). Tags stay OUTSIDE the <label> element, tied by aria-describedby.
- The lean seed stays byte-stable; only the full profile gains the demo landlord (AR20).
- Gate 2 (`npm test`) includes the e2e workspace's mutationCatalog.test.ts - the applyLandlordRequirements entry lands with the endpoint (Task 5.1).
- Never edit app/dashboard source while this worktree's e2e runs (it serves the source live). Never touch :5174 / :8080. DynamoDB Local may be STARTED (`npm run db:start`), never restarted.
- npm test red on DynamoDB Local suites: re-run-and-compare per AGENTS.md; any `[dynamoAdmin]` line in real output is a real container fault - capture it.
- The named-flake list is EMPTY: a named-spec e2e failure is a regression to diagnose. One open environmental issue to compare against before calling a failure yours: docs/issues/e2e-blank-first-paint-at-sign-in.md (a white page at sign-in; re-run the file alone; a db/s3 restart does not cure it).
- Where a slice's quoted anchor no longer matches because an earlier task changed the region, apply the change on top (AR47); the tree wins over a draft's "facts" (AR48) - raise a QUESTION when that changes a decision.
- Out of scope (spec section 5): no ranking or filtering on requirements, no backfill, no importer change, no AI prompt change, no Area on the forms.

Gates (bare, never piped, from the worktree, after the single main sync - AGENTS.md "Required completion gates"):
1. npm run typecheck
2. npm test
3. npm run smoke
4. npm run e2e
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')   (no new errors in touched files; baseline comparison at the merge base; skip if the list is empty)

Post-merge obligations already known: none expected (no new dependency, no infra, no backfill, no Terraform). Deploy and any tracker #11 / #12 update are Cameron's.
