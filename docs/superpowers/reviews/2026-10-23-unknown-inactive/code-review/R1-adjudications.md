# Code review round 1 - orchestrator adjudications (feat/unknown-inactive)

Reports: `R1-spec-conformance.md` (SPEC, 99 rows: 97 CONFORMS, 1 PARTIAL,
1 N/A; 0 HIGH, 1 MEDIUM, 4 LOW, 9 INFO) and `R1-adversarial.md` (ADV,
plan-blind: 0 CRITICAL, 0 HIGH, 1 MEDIUM, 4 LOW, 5 INFO). Both reviewed HEAD
8738fcfd. Battery-1 at 8738fcfd: typecheck 0, npm test 0 (app 527 files /
11155 passed, 1 skipped; dashboard 266 / 5481; e2e workspace 22 / 508; 34 /
275; 13 / 111), smoke 0, e2e 0 (372 passed, 15.8m). Every reviewer probe
(`zz-review-*`) was deleted; the tree was clean afterwards.

Rule for each finding: FIX in fix wave 1 (FW1) / RECORD (handback, no code) /
PLANNER (a call for the planner or Cameron, named in the handback).

## FW1 - fix (one fresh child, TDD, every item RED first unless test-only)

FW1-1 (ADV-1, MEDIUM, CONFIRMED) - the client's view of the type is not
fenced. Verified: `/tenant-status` validates and fences `toStatus` against the
type the ROUTE reads (app/src/routes/statusTransition.ts:274-292); the client
never says which type its list was built from (dashboard/src/api/endpoints.ts
setTenantStatus body; ContactEditForm.tsx:551-555 freezes `base`, so its list
stays the opened type's for as long as the form is open). A stale Inactive
pick lands as (tenant, inactive) on a contact a colleague just identified.
Mechanism (extends AR4, does not contradict it - the route still passes
`stored.type` to the service's conditional write):
- route: optional body field `expectedType`; present and not a ContactType ->
  400 `expectedType must be a contact type`; present and !== stored.type ->
  `409 { error: 'contact_type_changed' }` BEFORE the allowlist check, nothing
  written; absent -> today's behavior (API callers);
- dashboard endpoints.ts setTenantStatus input gains `expectedType?:
  ContactType` and sends it when given;
- header (ContactDetail.tsx onChangeStatus) sends `expectedType: contact.type`
  (the type its options were built from); its existing 409 handling and copy
  then cover the page-read-to-pick window, so the comment at ~:961 becomes
  true - re-read and keep it accurate;
- edit form sends `expectedType: statusType` on every setTenantStatus call
  (statusType equals kind.type whenever Save is enabled) and maps
  `409 contact_type_changed` in its catch to a new exported constant (ASCII,
  American English), e.g. "This contact's type changed while you were
  editing, so its status was not saved. Reopen Edit contact details to pick
  a status for its new type." - true whether or not the field PATCH before
  it committed. Draft kept, as for every other save error.
- Tests: route - mismatch 409 (nothing written, no audit, no milestone, no
  contact.updated), match 200, invalid value 400, absent = old behavior; the
  adversarial reviewer's stale-client cases as regressions (unknown re-typed
  to tenant / partner / landlord, then a pick with `expectedType: 'unknown'`
  -> 409 each). Dashboard - header sends expectedType; form sends
  `expectedType: statusType` (incl. the tenant follow-up after a type change:
  `'tenant'`); the form re-rendered with a re-typed contact prop then Save ->
  setTenantStatus carries `expectedType: 'unknown'`; a mocked 409 shows the
  new copy and keeps the form open.
- Residual RECORD (not widened by this branch): the landlord status that
  rides the PATCH (ContactEditForm.tsx ~:341-342) has the same window for the
  values a landlord shares with another type; the PATCH has no expected-type
  field. Pre-existing class.

FW1-2 (SPEC-F1, MEDIUM, test-only) - the service's conditional write is
unpinned in its own read-to-write window (mutant M1 passes 103/103). Add to
app/test/statusTransition.test.ts's AR4 describe: spy `contactsRepo.update`
to re-type the stored contact before delegating to the real update ->
ContactTypeChangedError, stored record unchanged, no audit, no milestone, no
contact.updated; assert the update's `expect` carries
`{ attr: 'type', value: <expected> }`. Rename or strengthen the misleading
PIN at ~:479 so it asserts the guard. Prove it discriminates: the new case
must FAIL against a copy of the service whose update is unconditioned (the
reviewer's M1 shape; scratch copy + throwaway vitest alias config, never an
in-place edit) - record the result.

FW1-3 (ADV-2, LOW, CONFIRMED) - a type-only PATCH that KEEPS the stored
status (normalize branch, team_member/unknown target, contacts.ts
~:1787-1811) is fenced only on classification_revision, so a concurrent
status write between its read and write stores (unknown, active),
(team_member, parked), etc. Fix: on that keep path add
`guardAsRead(stored, 'status')` to the write's guards; a lost guard is the
existing 409 contact_changed. RED: the reviewer's interleaving (PATCH
`{type:'unknown'}` on (team_member, needs_review); a status write to `active`
lands between the PATCH's read and its write) -> 409, stored (team_member,
active). PIN: the same PATCH with no concurrent write -> 200, (unknown,
needs_review). API-only today (KindPicker offers neither target).

FW1-4 (ADV-3, LOW, CONFIRMED) - the caseworker conversion
(services/caseworkerConversion.ts make(), ~:533-555) changes type and status
but emits no contact.updated, so another operator's open Today keeps a
threadless contact's "New unknown contact" row. Fix: emit
`contact.updated { contactId }` once after the commit, before followOn (so a
follow-on failure cannot swallow it). RED: a threadless (unknown,
needs_review) conversion emits exactly one contact.updated with the id; PIN:
a refused conversion emits none.

FW1-5 (SPEC-F2, LOW, test-only) - the tenant-target porting branch
(ContactEditForm.tsx ~:522-527, plan clarification 3) is unpinned. Add:
re-type to Tenant, tick Porting, keep Onboarding, Save -> one PATCH
`{ type: 'tenant' }` then exactly one setTenantStatus `{ toStatus:
'onboarding', source: 'manual', porting: true, expectedType: 'tenant' }`.

FW1-6 (ADV-9 + SPEC-F4, comments/docs) - make the claims true:
- app/src/lib/events.ts ~:297-305 names the PATCH as "the edit form's path":
  correct it (a no-type-change status save from the edit form goes through
  setTenantStatus; the PATCH carries type changes and the landlord status).
- documentation/STATUS-MODEL.md ~:248-249 and the UNKNOWN_STATUSES comment in
  app/src/lib/statusModel.ts ("every writer refuses (unknown, active)"): name
  the one exception - a re-import that re-types a contact whose status staff
  set keeps that status (app/src/lib/import/apply.ts preserveStatus), the same
  family as docs/issues/import-bypasses-contact-type-rules.md - and, after
  FW1-3, no longer the PATCH race. Check GLOSSARY.md for the same claim.
- ContactDetail.tsx ~:961 comment: true after FW1-1; keep it precise.

## RECORD - no code change (handback lists each)

- ADV-4 (LOW, PLAUSIBLE) = watch item W8: Today/Inbox refetch over eventually
  consistent reads (today.ts:362 default GetItem, :892-899 GSI; inbox byPhone
  GSI). The planner ruled W8 record-only (plan section 3); DynamoDB Local
  cannot show it. A trailing second refetch is the reviewer's suggested
  follow-up - named for the planner, not built.
- ADV-5 (LOW) = W7: (unknown, active) rows stored before deploy are read by no
  Unknown-tab block or Today pass. Rollout re-count (planner + Cameron) is
  owed before deploy; any found move only on Cameron's go. No script built
  (no data writes in the build).
- ADV-6 (INFO, CONFIRMED) - useContact's initial load is outside the OR-5
  sequence; an initial GET answering after a committed consistent re-read
  overwrites it. Narrow window; a naive "latest-issued only" fix can strand
  the page on loading when the newer re-read fails, so it is not a one-line
  change. Recorded with S2's own residual (setContact does not bump the
  sequence).
- ADV-8 (INFO) - partner/team_member/unknown form status saves are two
  non-atomic writes (field PATCH, then /tenant-status). FW1-1 maps the 409;
  the 400 becomes unreachable from the form (the stale pick now 409s first).
- ADV-10 (INFO) - the Today skip keys on THREAD type: a former unknown's
  secondary-number thread that triage never re-typed stays unknown_1to1, so
  once that tenant is Inactive its unread text leaves Today (before the branch
  it showed, mis-bucketed, under Needs you now). Conforms to spec D5's literal
  rule ("limited to unknown_1to1"); edge case recorded for the planner.
- SPEC-F6 a (INFO) - services/statusTransition.ts imports
  ConditionalCheckFailedException from @aws-sdk/client-dynamodb (plan S2 C1
  told the build to reuse that idiom; precedent caseworkerConversion.ts:12).
- Remaining SPEC-F6 INFO items (label helper return type, the resolved
  unknown-queue-cap-starves-needs-review reopen trigger now structurally 0,
  live inbox update tested in pieces, fixture nits, stale refs): recorded in
  the SPEC report; no action.

## PLANNER - calls for the planner or Cameron (handback "Decisions" section)

- SPEC-F3 / ADV-7: a status write that commits but whose required audit (or,
  on the PATCH, the thread propagation) then throws sends no contact.updated
  (AR3: "after the write, the audit and the activity, on EVERY successful
  call"); spec D2 says the notify fires "for EVERY status change". The build
  follows AR3's letter (pinned). Options: emit right after the committed
  write, or note the exception in D2/STATUS-MODEL.
- SPEC-F5: OR-1 (Contacts > Unknown lists Inactive last) is an orchestrator
  addition beyond the spec - for Cameron to confirm or reverse (revert set:
  ContactsList.tsx `inactiveLast` + its test, the STATUS-MODEL/GLOSSARY
  sentences, the issue sentence, e2e step 6's order assertion).
- SPEC-F4 / invariant-sweep 3 / S1 report D: whether to append the importer's
  preserved-status re-type pair shape to
  docs/issues/import-bypasses-contact-type-rules.md (AR14: no slice edits it).
- SPEC-F2: plan clarification 3 (porting forces the tenant follow-up write)
  deviates from D3's "ONLY if the shown status is not Onboarding"; FW1-5 pins
  it. Amend D3's wording or reverse.
