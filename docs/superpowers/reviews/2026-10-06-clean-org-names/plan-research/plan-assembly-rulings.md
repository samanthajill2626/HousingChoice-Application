# Plan assembly - section writers' contract issues and the planner's rulings

Six opus section writers drafted S2-S16 against plan sections 0-3 (binding)
and `planner-rulings.md`; the planner wrote S1 and S17. Each writer listed
CONTRACT ISSUES at the top of its draft. Rulings below; plan section 3 was
amended where marked PLAN.

## S6/S9/S10 writer

1. Factory/wiring names unpinned - ACCEPT (PLAN 3.4b): `createOrgNamesService`,
   `createOrgRecordsService`, `createOrgRewriteService` (every dep optional);
   `ApiRouterDeps.orgListRepo`; composition-root locals `orgNames` /
   `orgRecords` / `orgRewrite`; router deps keys `orgNamesService` /
   `orgRecordsService` / `orgRewriteService`; harness `FakeWorld.orgListRepo`.
   Sent to the S2-S5, S7 and S8/S12/S13/S15 writers mid-draft.
2. `checkListWrite` compared held members untrimmed - ACCEPT (PLAN S1 Task
   1.3): trims both sides; new test case.
3. Section 1's D5 row contradicted ruling R1-F1 - ACCEPT (PLAN section 1).
4. D7 exactness re-check built inline from S1 exports - ACCEPT, no change.

## S7 writer

1. `orgListFingerprint` cannot be required (skip gates exit before the list
   is read) - ACCEPT (PLAN 3.10): optional on the run draft and
   `AiRunRecord`, the `promptFingerprint?` precedent.
2. New internal names (`ORG_LIST_BLOCK_BUDGET`, `ORG_LIST_BLOCK_HEADER`,
   `OrgListBlock`, `ExtractionJobDeps.orgListRepo`,
   `ResolutionServiceDeps.orgNamesService`, `valueKey` fields,
   `resolutionValueKey()`, `SuggestionResolutionError.details`) - ACCEPT,
   internal to S7.

## S8/S12/S13/S15 writer

1. `orgRecords.rewrite` cannot express the cleanup's per-value mapping -
   ACCEPT (PLAN 3.8): the script plans each record (`planContact` /
   `planUnit`) and writes through the 3.7 writers.
2. Audit `from`/`to` must be strings - ACCEPT (PLAN 3.8): a list joined with
   `', '`, a removal is `''`. Sent to the S2-S5 and S11 writers.
3. An `agency` already holding the SAME agency name is compatible, not a
   conflict - ACCEPT (PLAN 3.8): applies to Move to Agency, Split and the
   cleanup. Sent to the S2-S5 writer.

## S14/S16 writer

1. Accessible names beyond the three field labels - ACCEPT: the S14 selector
   contract table is the preferred contract; sent to the S11 writer to adopt.
   Assembly reconciles any difference (S11 as built wins; S14's constants
   follow it).
2. `lastRewrite.counts` keys unnamed - ACCEPT (PLAN 3.2): `housingAuthority`,
   `agency`, `accepted_authorities`, `skipped`, `conflicts`.
3. The dev seam's `field` for a unit - ACCEPT (PLAN 3.12):
   `accepted_authorities`.
4. The run detail route returns `orgListFingerprint` - ACCEPT (PLAN 3.10).
5. e2e tasks covering unit-tested behavior may be PIN-only - ACCEPT (PLAN
   section 0).
6. Noted: `contact-authority-clear-empty-string-500` looks resolved by the
   current code and S6's pins - S16 closes it if S6's '' -> REMOVE pin holds.

## S2-S5 writer

1. `NameProblem` / `SpellingProblem` widened for `org_name_invalid` /
   `invalid` in Task 3.1 (S1 functions unchanged) - ACCEPT.
2. `rewrite()` is one pass per field; rename/merge run one pass per field of
   the target's kind (housing authority: `housingAuthority` +
   `accepted_authorities`; agency: `agency`) - ACCEPT.
3. Normalized matching could let Clear (or Use of a different entry) on a case
   variant of an exact name hit on-list holders - ACCEPT the guard:
   `resolveNotOnList` refuses (400) an on-list value and a name variant unless
   the action is "Use <that entry>"; rename/merge/use passes skip values
   already equal to `toName`.
4. `org_in_use` computed by the router via `orgRecordsService.usage` before
   delete / kind change - ACCEPT.
5. Delete and kind change also refuse 409 `org_rewrite_running` - ACCEPT.
6. A kind change that would make a shared spelling cross-kind -> 409
   `org_spelling_refused` (`cross_kind`) - ACCEPT.
7. `createOrgRewriteService`'s `orgRecords` dep unused - ACCEPT (documented).
8. Contacts read through `listByType` (the byTypeStatus index projects every
   attribute) rather than a base-table scan - ACCEPT (SPEC note): the contacts
   table also holds pointer rows and has no full scan; base-item conditional
   writes make a stale page cost a skip, never a wrong write; a record written
   in the instant before a rename can be missed and then shows in "Not on the
   list" (resolution: one entry), where "Use" settles it.
9. `ORG_REWRITE_JOB` declared in `services/orgRewrite.ts`, re-exported from
   `jobs/orgRewrite.ts` (import cycle) - ACCEPT.
10. An enqueue failure answers 202 with `lastRewrite.status: 'failed'` (the
    list change is committed) - ACCEPT.
11. Validation 400s without a plan-3.5 code use human-readable messages (house
    style) - ACCEPT.

## S11 writer

1. The control-character codes missing from the S1 unions - ALREADY
   RESOLVED by S3 Task 3.1 (widened `NameProblem` / `SpellingProblem`); the
   dashboard mirrors the superset.
2. `spellingFor` is an entry's `orgId` - CONFIRMED against S3 Task 3.6
   (`entries.find((e) => e.orgId === spellingFor)`, unknown id -> 404
   `org_not_found`); PLAN 3.4 comment updated.
3. Noted: one lint error already exists at the base commit in a touched file
   (`dashboard/src/routes/broadcasts/useComposerDraft.ts:116`,
   `react-hooks/refs`) - gate 5 attributes it by baseline, not to this branch.

## Starting list (planner, 2026-10-06)

Sam's section-13 answers no longer block the build. "Fulton County Housing
Authority" joins the starting list (spelling "Housing Authority of Fulton
County"); the old values `Fulton County`, `Clayton County`, `Cobb County` and
`McDonough` are NOT spellings of anything and surface in "Not on the list" for
Sam to settle. The seeds map `fulton_housing` to Fulton County Housing
Authority. Applied in S1 Task 1.5 and S12.

## Assembly

Assembled 2026-10-06: 85 tasks in 17 slices, ~29,000 lines, ASCII clean,
code fences balanced. Coverage walk: every spec decision D1-D15, sections 7-9
and 12 map to at least one task. Added to Task 16.2: close
`contact-authority-clear-empty-string-500` once Task 6.1's clear pin holds.
