# Plan assembly - section writers' contract issues and the planner's rulings

Six opus section writers drafted S1-S10 against plan sections 0-3 (binding)
and `planner-rulings.md`. Each listed CONTRACT ISSUES at the top of its
draft. Rulings below; plan section 3 was amended where marked PLAN. Where two
drafts collide, the ruling names the winner; the loser's task carries a
skip-if-done step.

## S1/S2 writer (9 tasks)

1. `ContactDisplay` does not exist - ACCEPT (PLAN 3.3): `RecipientDisplay =
   ContactDisplayItem & { type?; role? }`, exported.
2. `OrgRecordField` lives in `repos/orgListRepo.ts` and widening it in S1
   breaks `FIELD_ORDER` - ACCEPT (PLAN 3.2): S1 widens only `OrgField` and
   `KINDS_FOR_FIELD`; `OrgRecordField` gains `organization` in S5.
3. `ListUnitsOpts.deleted` is boolean - ACCEPT (PLAN 3.3): S2 adds
   `deleted: 'any'` (no deleted filter) to `queryIndex`, `list` and the fake;
   the refusals use it.
4. `setTypeIfCurrent` must return the updated row for the event - ACCEPT
   (PLAN 3.3): `SetTypeIfCurrentResult = { outcome: 'updated'; conversation }
   | { outcome: 'skipped' }`.

## S3/S4 writer (13 tasks)

1. `deleted: 'any'` - resolved by S1/S2-3.
2. A shared classification module - ACCEPT (PLAN 3.1):
   `app/src/services/contactClassification.ts` (`displayNameOf`,
   `supersedePendingSuggestion`, `drainTypeSuggestion`) extracted from the
   PATCH, with its test; the PATCH and the conversion both call it.
3. `caseworker_conversion.by` is the actor's userId - ACCEPT (PLAN 3.2), as
   the audit and the org routes record actors.
4. `leftOther` defined two ways - ACCEPT (PLAN 3.2): `leftShared` = another
   live holder of the phone/address OR a participant `contactId` that is not
   this contact; `leftOther` = type-less rows only.
5. Roster vs landlord double count - ACCEPT (PLAN 3.2): one refusal per unit,
   landlord-of-record wins over roster for the same unit; ids sorted within
   each kind.
6. `listPossibleCaseworkers` deps narrow to `Pick<ContactsRepo,
   'listByType'>` - ACCEPT (PLAN 3.4).
7. `setTypeIfCurrent` result - resolved by S1/S2-4.

## S5/S7 writer (13 tasks)

1. S7 helper names - ACCEPT (PLAN 3.1/3.9): NewOrgDialog `kind: OrgKind |
   'organization'`; `dashboard/src/routes/orgs/OrgKindChoice.tsx` (radio group
   "Kind", no default); `orgCopy` exports `ORGANIZATION_KINDS`,
   `kindsForField`, `OrgFormField`, `orgPickField`, `newOrgDialogKind`,
   `isOrgFormField`, `blockingUses`. Sent to the S8 writer mid-draft.
2. The ContactEditForm seam - ACCEPT: S7 makes the form field-keyed
   (`adding.field`, `orgSetters`, `applyOrg(field, ref)`) with the tenant
   arms only; S8 adds the organization arm, state, picker, typed text,
   `buildPatch`/settle arms and the type changes. Sent to S8 mid-draft.
3. Deleted organization holders - ACCEPT (PLAN 3.6): they count in `deleted`
   once per column for DISPLAY only; every refusal reads `inUse` /
   `kindLocked`. Types `OrgUseTotal`, `OrgUsageCounts`.
4. Open copy - ACCEPT (PLAN 3.9): radio group "Kind"; intro exactly "Check
   that this organization is really new."; the Used by cell adds "N
   organization field(s)" only when N > 0; organization refusals say
   "organization", never a kind; the Change kind and Settle "Add as new"
   sentences as drafted in S7.
5. Ownership - ACCEPT: S5 owns the e2e usage pin
   (`org-lists.spec.ts:557-562`), `OrgUsageWire` and `OrgRecordField` in
   `e2e/fixtures/orgFixture.ts`, the dev-seam README line and the cleanup
   script docblock line - the task that changes a wire also changes its pins.
   S10 Task 10.3 keeps a skip-if-done grep. The RUNBOOK sentence is S10's.

## S6/S9 writer (11 tasks)

1. `RecipientDisplay` base type - resolved by S1/S2-1.
2. The landlord timeline's stored-count site must keep "Sent to " at zero or
   the recount predicate skips it - ACCEPT (PLAN 3.7): the stored-count site
   (`contactTimeline.ts:762-764`) reads "Sent to N recipient(s)" for every N
   including 0; only the recount site says "No recipients reached".
3. Exact share strings - ACCEPT (PLAN 3.9): S9's table becomes 3.9's
   share-wording table verbatim (singular at N = 1). It agrees with the S10
   writer's CI-4 list except the `empty_audience` line, where S9 wins: a
   touched line is ASCII, so "Nothing selected - check at least one
   recipient to send." (the em dash becomes " - ").
4. A second recipients-route pin - ACCEPT (PLAN 3.7):
   `contactsBatchReads.test.ts:141-169` is amended in Task 6.4.

## S8 writer (13 tasks)

1. S7 names - adopted (S5/S7-1, -2). The four assumed S7 items (dashboard
   `OrgField` accepts `organization`, the organization 422 wording, "Couldn't
   load organizations", "Add <text> as a new organization") are all in S7's
   draft.
2. The mutation catalog test goes red the moment the endpoints exist - ACCEPT:
   Task 8.1 adds `makeCaseworker` and `dismissPossibleCaseworker` and bumps
   the pin 118 -> 120. S10's Task 10.1 catalog step becomes skip-if-done.
3. The route registry fails on an unregistered route - ACCEPT: Task 8.13 adds
   `/contacts/caseworkers` to IMPLEMENTED and the excluded set, the TODO, the
   README line and the issue `perf-pages-contacts-caseworkers-surface`, and
   carries R5-F11's `contact-create.spec.ts:201` fix. S10's Task 10.1 and
   the 10.2 selector step become skip-if-done. (This is also the S10
   writer's CI-6, resolved the other way round: every task ends green.)
4. Dialog counts - ACCEPT (PLAN 3.9): singular/plural sentences as drafted,
   and `leftOther` gets "<n> conversation(s) without a type stay as they
   are." (singular "1 conversation without a type stays as it is.").
5. S8-only copy (failure lines, page load/empty/no-match lines, "No
   organizations recorded yet") - ACCEPT as drafted.
6. Filter contacts controls are links - ACCEPT (PLAN 3.9): "link
   'Caseworkers'" in the `nav aria-label="Filter contacts"`.
7. The stored-caseworker check - ACCEPT with a move (PLAN 3.1):
   `isCaseworkerContact` lives in `dashboard/src/routes/contact/caseworkerRole.ts`
   (S1's module; Task 8.3 adds it there), not in a component file, so the
   Caseworkers page does not import the dialog for a predicate.

## S10 writer (13 tasks)

- CI-1 tabs are links - same as S8-6.
- CI-2 row lists - ACCEPT (PLAN 3.9): `<ul aria-label="Caseworkers">` and
  `<ul aria-label="Possible caseworkers">`, one `<li>` per row; locators use
  `exact: true`. S8's Task 8.12 must render exactly these.
- CI-3 the dismiss confirm container - RULED: S8 as drafted wins (a Modal
  whose name is the confirm's first sentence); S10 finds it by its sentence,
  which holds either way.
- CI-4 exact strings - see S6/S9-3 (S9 wins on the dash).
- CI-5 dev-seam e2e ownership - see S5/S7-5 (S5 owns; 10.3 skips if done).
- CI-6 perf pins red between S8 and S10 - see S8-2, S8-3 (moved into S8).
- CI-7 singular dialog sentences - same as S8-4.

## Assembly order

S1, S2, S3, S4, S5, S6, checkpoint, S7, S8, S9, S10. Where a later task
repeats an earlier one's step, the later step is marked "skip if done"
with a grep that proves it.
