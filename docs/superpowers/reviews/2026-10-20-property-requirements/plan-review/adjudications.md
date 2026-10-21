# Plan review adjudications - property requirements (tracker #11 + #12)

Plan: `docs/superpowers/plans/2026-10-20-property-requirements.md`
Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md` (rev 6, approved)

## Round 1 (2026-10-20) - two fresh opus reviewers, PLAN brief

Plan v1 @dbde9f58. Reports: `R1-reviewer-a.md` (9 findings), `R1-reviewer-b.md`
(8 findings). The two overlap heavily: 7 findings were raised by both. 10
unique findings; all 10 ACCEPTED. No BLOCKING. Neither reviewer found an
unenumerated writer or reader of `requirement_sources`, `landlordId`, the
`req_` keys, `voucher_size_accepted` or `bedroomSize` (B grepped app/src,
app/test, dashboard/src and e2e).

The dominant class (PR1-1, -2, -7): rulings written into plan section 4 but
not carried into the slices' verbatim code and tests. A literal builder
follows the task code, so a prose-only ruling is not delivered. Fix: the
slice writers edited their own drafts, and the plan's sections 5-11 were
rebuilt from the edited drafts.

| # | Finding (raised by) | Severity (reviewer) | Ruling | Decision changed? | Fixed in |
|---|---|---|---|---|---|
| PR1-1 | AR32 `deposit_conflict` copy has no implementing step or test; both forms fall through to the generic error and staff are stuck (A1, B1) | MEDIUM | ACCEPT: Task 5.8 and Task 6.9 render the bound copy, keep the form open, and test it | YES (adds UI behavior) | S5 5.8, S6 6.9 |
| PR1-2 | AR1 (Owning landlord row) not applied to Task 1.7's table, sample or tests; S5's drift test would fail and S5 may not edit S1 (A2, B2a) | MEDIUM | ACCEPT: Task 1.7 carries the 35-row list equal to S5 5.2 | no (applies AR1) | S1 1.7 |
| PR1-3 | Dashboard mirror reads `tour_type` as free text, the app checks the enum; the drift fixture `{ tour_type: 'bogus' }` is red as written (A3, B4) | MEDIUM / LOW | ACCEPT: the mirror reads `tour_type` through the dashboard's tour type list | no | S5 5.2 |
| PR1-4 | Task 7.4's M1 liveness check runs the wrong test file; the `planUnitApply` cases live in `requirementsApply.test.ts` (A4, B3) | MEDIUM | ACCEPT | no | S7 7.4 |
| PR1-5 | Task 7.4's M3 targets the dialog, but the start-state rule is `rowIsChecked` in `applyRequirementsModel.ts`; the revert covers one file (A5, B6) | LOW | ACCEPT | no | S7 7.4 |
| PR1-6 | AR6 claims Task 3.2 clones the read; it passes the live harness object, so the fake fence checks nothing (A6, B5) | LOW | ACCEPT: the route clones once and passes the clone to both calls; a harness-level race test added | no (applies AR6) | S3 3.2 |
| PR1-7 | AR36 / AR39 / AR46 only in prose: Task 6.9 imports names S5 never exports, 6.2 defines a second `WASHER_DRYER_LABELS`, 7.9 still edits AGENTS.md (A7, B2b-d) | LOW / MEDIUM | ACCEPT: the task code follows the rulings; the `ok: false` branch of `buildRequirementPatch` gets a test | no (applies rulings) | S6 6.2, 6.9; S7 7.9 |
| PR1-8 | `planUnitApply` treats `deleted_at: ''` as live (as `isDeleted` does) but the Apply write conditions on `attribute_not_exists(deleted_at)`; such a unit is skipped on every Apply (A8, B7) | LOW | ACCEPT: the write follows `isDeleted` - `(attribute_not_exists(deleted_at) OR deleted_at = '')`; harness mirrors; tests for both | YES (the not-deleted condition) | S2 2.1 |
| PR1-9 | The importer's import-owned branch REPLACES `landlordId` (`app/src/lib/import/apply.ts:1604-1609`), a writer the spec and the plan omit (A9) | LOW | ACCEPT as a WATCH row in plan 3.1, no code: every writer of `requirement_sources` (API create, PATCH, Apply) stamps `updated_at`, which makes the unit human-owned, and the importer only replaces `landlordId` on import-owned units, so such a unit never holds a map. If that ever changes, the importer must REMOVE the map with the landlord. | no | plan 3.1 |
| PR1-10 | AR8 widened D13 ("the unit keys the write actually changed") to every normalized body key, an undeclared deviation from the approved spec (B8) | LOW | ACCEPT: the fenced path's `fields` = keys whose STORED value the write changes; the plain path keeps today's body keys. Supersedes AR8. | YES (audit contents) | S2 2.5 |

Reviewer to continue in rounds 2+: A (9 accepted vs 8; B's report path is
handed to A).

Round 1 changed decisions (PR1-1, PR1-8, PR1-10), so round 2 runs.

## Round 2 (2026-10-20) - reviewer A continued, RE-REVIEW CHARGE

Plan v2 @51893e3a. Report: `R2-reviewer-a.md` (2 findings). The reviewer
also had round 1's reviewer-B report.

| # | Finding | Severity (reviewer) | Ruling | Decision changed? |
|---|---|---|---|---|
| PR2-1 | Task 6.9's new `ok: false` UI test can never pass: the Fixed amount input has `min={0}` and the form has no `noValidate`, so Save stops at native constraint validation before `onSubmit`; contests PR1-7's "the `ok: false` branch gets a test" | MEDIUM | ACCEPT: the UI test is removed; the branch stays as a defensive path, pinned at the helper level (`buildRequirementPatch`'s `ok: false`, S5 Task 5.3); S5 and S6 scanned their own UI tests for the same native-validation trap | no (test design) |
| PR2-2 | PR1-10 / PR1-10a make the audit depend on the path: a no-change save is audited with every body key on the plain path and not at all on the fenced path; PR1-10a's cited precedent (`units.ts:2122-2129`) argues against stamping `updated_at` too | LOW | REJECT. The plain path is today's behavior and this mission does not change it; the fenced path follows D13 literally ("the keys the write actually changed"). A no-change fenced save is reachable only from a raw API call (the edit form sends only changed keys), so the asymmetry costs nothing a person sees. The `updated_at` stamp stays because every staff save stamps it today (it is the importer's human-owned signal); dropping it for this one case would change ownership semantics for no user-visible gain. Conceded in part: the tombstone citation supports dropping the empty row, not keeping the write; the write is kept for consistency with the plain path. | no |

Round 2 changed no decision: it is the TERMINAL round. PR2-1 is folded in
and the plan review closes (2 rounds, 12 unique findings, 11 accepted, 1
rejected).

Addendum (round 2 fold-in): while scanning for PR2-1's trap, the S5 writer
found a related risk - the money inputs keep today's `step={1}`
(`ListingEditForm.tsx:378,525`), so a stored or landlord-prefilled deposit
with cents (1250.50; D1 allows any finite amount >= 0) fails native step
validation and silently blocks Save / Create. PR2-3 ACCEPTED as precision:
`step="any"` on "Fixed amount" and "Application fee", tested in Tasks 5.8
and 5.9. No decision changed; round 2 stays terminal.
