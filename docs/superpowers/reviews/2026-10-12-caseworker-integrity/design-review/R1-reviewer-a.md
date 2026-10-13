# Design review R1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`
(revision 1, commit cc10cb44). Repository read at the worktree tip; no tests,
servers or DynamoDB were run. Every claim about existing behavior below cites
the line read. Severity = consequence if it ships unfixed.

Verified as stated (no finding): every file:line the spec cites resolves to
the code it describes (suggestionResolution.ts:194/269/778, repo:770, fake:322,
contactsRepo.ts:1501, caseworkerConversion.ts:120/217-266, statusModel.ts:118,
caseworkers.ts:86, tours.ts:157/310-406/1145/1641-1684, toursModel.ts:147,
placements.ts:566-627/635-905, statusTransition.ts:335-355/390,
routes/statusTransition.ts:102, units.ts:464-514/1061-1137/1376-1491,
unitsRepo.ts:773-823, unitFields.ts:46, CaseworkerDialog.tsx:62-89,
TenantFile.tsx:320/348). Placement `stage` is not PATCH-writable
(placements.ts:279-285), so the transition service really is the only
terminal-exit path. The conversion writes `caseworker_conversion` in the same
update as the type change (caseworkerConversion.ts:555-577), and
`contactsRepo.update` bumps `classification_revision` whenever `type` or `role`
is in the patch (contactsRepo.ts:1467-1469, 1501-1508). Extraction only
suggests a type (services/extraction/apply.ts:576-632). The dashboard edit
form sends type/role only when changed (ContactEditForm.tsx:306-308).

---

## 1. [HIGH] The landlord-of-record refusal on a type change has no remedy in the product

**What is wrong.** D2 refuses any type change away from `landlord` while the
contact is the landlord of record of any unit, soft-deleted units included,
and reuses the conversion's sentence byte-identically: "This contact is the
landlord of record for a property. Change that property's landlord first."
The spec itself says (section 4, I3 Dashboard) that no dashboard UI reassigns
`landlordId`. The sentence instructs staff to do something the product cannot
do.

**Evidence.**
- Sentence: `dashboard/src/routes/contact/CaseworkerDialog.tsx:76-80`; spec
  section 3 "The four sentences and View links stay byte-identical".
- No landlord field in the unit edit form: `ListingEditForm.tsx` has no
  `landlord` reference (grep); the only `landlordId` writers in the dashboard
  are `UnitCreateForm.tsx:192` (create only).
- The roster cannot do it either: DELETE refuses the landlord of record
  (`app/src/routes/units.ts:1150-1152`), and adding a different contact with
  role `landlord` on an owned unit is refused
  (`app/src/repos/unitsRepo.ts:774-780`; dashboard copy "reassign it before
  choosing Landlord", `ListingDetail.tsx:120-121`).
- Soft-deleted units count (spec section 3, same read as
  `caseworkerConversion.ts:235-237`). A deleted property's page is read-only
  (`ListingDetail.tsx:360` comment, "A deleted property is read-only"), so
  the View link lands on a page where nothing can be changed.

**What it implies.** Before this branch the dead end existed only on the rare
conversion. D2 makes it apply to EVERY type change of EVERY contact that has
ever owned a unit, including one deleted years ago: a mis-typed owner can never
be corrected from the dashboard, and the refusal tells staff to take an action
that does not exist. The spec must choose: ship a reassign-landlord path, or
narrow the rule (e.g. live units only, with soft-deleted owners handled on
restore), or at minimum change the copy and document the API/runbook remedy
(PATCH /api/units/:id `landlordId`, which D3 now also restricts to a
landlord-typed target).

---

## 2. [MEDIUM] I1 fences only a reclassification that lands INSIDE the claim; a tenant-only accept planned against a contact that is already not a tenant still commits

**What is wrong.** The fence compares the revision at plan time with the
revision at commit time. `buildPlan` never checks the contact's CURRENT type
for a tenant-only target (`app/src/services/suggestionResolution.ts:328-375`:
the housingAuthority arm and the generic EXTRACTABLE arm read no type; only
`status` is type-scoped, line 271). So an accept that READS a contact that is
already a landlord, team member or caseworker builds a guard with the new
revision and commits.

Reachable today, with the spec's mechanism in place:
- Generic re-type, through the UI. The contacts PATCH supersedes only the
  pending suggestions for fields it changed (`app/src/routes/contacts.ts:1737-1746`,
  `1801-1817`); a type change leaves `voucherSize`, `housingAuthority`, `pets`
  etc. pending. A tenant re-typed to `team_member` still renders TenantFile
  (`ContactDetail.tsx:574-584`), which still renders those chips
  (`TenantFile.tsx:240-251`, EligibilityIntakeCard). Accept writes them onto
  the team member.
- Conversion. The pending-suggestion sweep runs AFTER the commit and is
  best-effort, failures swallowed (`caseworkerConversion.ts:385-398`), and an
  extraction run in flight (L3) can create fresh tenant suggestions after it
  (RUNBOOK.md:473). An accept of such a row (stale TenantFile tab, or the API)
  reads the caseworker at its current revision and writes the housing
  authority - the R2-ADV-1 end state by a different schedule.

**Contradiction.** Section 8 requires "a `voucherSize` accept spanning a
generic tenant -> landlord re-type is refused", while the same accept clicked
one second after the re-type commits. Section 7 then mandates a RUNBOOK edit
saying "the hand-clear applies to the extraction writer only" - false while
the paths above exist.

**What it implies.** Add the plan-time rule the fence implies: with the
consistent read D1.2 already adds, refuse (before the claim, so the chip is not
consumed) a tenant-only accept when the contact is not typed `tenant`. The
fence then covers only the in-claim window, which is its real job. Otherwise
narrow I1's wording and the RUNBOOK edit to what the mechanism delivers.

---

## 3. [MEDIUM] The new 409 `suggestion_contact_reclassified` has three readers the spec does not name

**What is wrong.** Every existing consumer of the refusal is keyed on the
literal `suggestion_field_edited`:
- Server SSE: the suggestions router emits `suggestion.updated` for a refused
  accept only when `error.code === 'suggestion_field_edited'`
  (`app/src/routes/suggestions.ts:224-226`).
- Dashboard copy: `SUGGESTION_RESOLUTION_ERROR_COPY`
  (`dashboard/src/api/types.ts:1655-1700`); an unknown code falls back to
  "Something went wrong - please try again."
- Dashboard refetch: `failSuggestion` refetches the list only for three named
  codes (`ContactDetail.tsx:720-725`).

**What it implies.** Built as written, the requester sees "Something went
wrong - please try again", the consumed chip stays on screen, other open tabs
are never told it is gone. Clicking again then returns 200: the completed
journal row matches the identity and is replayed as an idempotent success
(`suggestionResolution.ts:756-770`) with nothing applied. The spec must list
these three sites (and their tests) alongside the copy.

---

## 4. [MEDIUM] The "honest answer" cannot be delivered on the spec's own crash schedule

**What is wrong.** D1.4 says the requester gets 409
`suggestion_contact_reclassified`. That holds only when the requester's own
request drives its claim to the refusal without interruption.
- Completed rows keep no outcome (`makeCompletedResolution`,
  `app/src/repos/suggestionResolutionRepo.ts:299-315`), so any later request
  with the same identity is answered 200 (`suggestionResolution.ts:756-770`).
- When the requester retries while its own journal is still active and
  expired, `resolve()` takes it over with `helping: true` and discards the
  refusal by design (`suggestionResolution.ts:748-754`), then loops into the
  completed-row 200.

So in test schedule (B) - crash after claim, convert, recover - the requester
can never receive the 409; a retry is told it succeeded. Pre-existing for
`suggestion_field_edited`, but this spec states the guarantee anew.

**What it implies.** Either scope D1.4 to the uninterrupted request, or carry
the refusal onto the completed row (a PII-free disposition, like
`released_unsafe`) and answer it on replay. Pick one explicitly.

---

## 5. [MEDIUM] Tour PATCH can move a `canceled` tour straight into the open set; D3 names only the reschedule

**What is wrong.** The tour PATCH guard (`app/src/routes/tours.ts:1210-1265`)
has no rule for `canceled -> toured` or `canceled -> no_show`: closed is
refused, `requested` as a target is refused, a `requested` source is
restricted, and `scheduled` as a target needs `canReschedule`. Nothing else is
checked. Both targets are in `OPEN_TOUR_STATUSES`. D3's row is labelled "a
PATCH that reschedules a `canceled` tour to `scheduled` (`canReschedule`)".
Its Change cell says "when the tour leaves `canceled`", which literally also
covers `canceled -> closed` (not open).

**What it implies.** A builder following the row label leaves two API paths
that revive a resolved tour for a non-tenant, breaking I2. State the rule by
result: check when the current status is `canceled` (or `closed`, via reopen)
and the resulting status is open. Add both transitions to the section 8 tests.

---

## 6. [MEDIUM] The dashboard surfaces for `contact_not_tenant` / `landlord_not_landlord` are not enumerated, and most cannot show a server sentence today

**What is wrong.** Section 4 says "Copy (dashboard, wherever these actions
report errors)". Several of those sites cannot show it as they stand:
- TourDetail shows the RAW code: `err.message` at `TourDetail.tsx:382`
  (status changes), `:514` (Start placement / from-tour) and `:589` (outcome
  then from-tour).
- ScheduleTourForm and PlacementCreateForm use bare `catch {` with fixed
  copy (`ScheduleTourForm.tsx:326`, `PlacementCreateForm.tsx:248`).
- Stage moves use fixed copy (`PlacementsPage.tsx:96`,
  `PlacementDetail.tsx:402`).
- UnitCreateForm and the property Add contact form are named only for the
  roster sentence.

**What it implies.** Section 8 tests only the server refusals and two pickers,
so a build can pass every listed test while staff see `contact_not_tenant` or
"That move was rejected". Name each surface and its test, or say which ones
deliberately keep generic copy.

---

## 7. [LOW] The 409 body cannot produce the copy it is meant to drive

`{ error: 'contact_not_tenant', contactType }` carries the stored type only,
but the copy wants "the dashboard's existing label for the contact (Caseworker
for a caseworker)". That label is derived from role as well as type
(`displayKind`, `ContactDetail.tsx:586`; `isCaseworker` needs the role,
`caseworkers.ts:86`). On TourDetail and PlacementDetail the page holds no
contact record, so it cannot add the role itself. A caseworker would be
called "a Partner". Add `role` (or a kind token) to the body.

## 8. [LOW] The tie-break "if both mismatched, report the field edit" mislabels the conversion case it exists for, and role-only edits read as "type changed"

The conversion REMOVES `housingAuthority` and sets `status: 'active'` in its
commit (`caseworkerConversion.ts:555-565`). So any housingAuthority accept
whose contact had a prior authority, and every status accept, that spans a
conversion mismatches on the field too, and the spec's rule answers
`suggestion_field_edited` ("Someone changed that field..."). Only the
absent-authority case gets the new answer. Separately, a role-only edit bumps
the revision (`contactsRepo.ts:1467-1469`), so the reclassified copy says
"This contact's type changed" when only the role did. Decide the tie-break by
cause, or soften the copy to "type or role".

## 9. [LOW] D1.4 changes a repo contract that the spec describes as unchanged

The reason for a refusal is known only inside `commitContactEffect`
(`suggestionResolutionRepo.ts:820-851`) and the fake
(`suggestionResolutionFake.ts:334-336`). Both return the single value
`'superseded_by_human_edit'` from the union at repo:159-164, and
`applyJournal` carries only a boolean (`suggestionResolution.ts:585`). "No new
repo method and no new transaction" is true, but the result union, the fake
and the service plumbing must all change. Name the new result value so the
real repo and the fake are specified together, the parity D1.3 insists on.

## 10. [LOW] The transition service cannot return the specified refusal through today's error mapping

`handleTransitionError` maps `TransitionRefusedError` to 400 `{ error }` and
`EntityNotFoundError('contact')` to `contact_not_found`
(`app/src/routes/statusTransition.ts:330-342`). D3 requires 404
`tenant_not_found` and 409 `contact_not_tenant` with `contactType`, raised
"in the service". Specify the error type and its route mapping.

## 11. [LOW] Factual errors a builder will trip on

- Section 1 cross-references are wrong. Record creation is section 4 and the
  type change is section 3; the text says "sections 3-4" and "section 2". For
  I4 the "type change end" is the unchanged conversion, not D2.
- Section 3 says the edit form shows "Couldn't save" for every non-org error.
  It already has its own copy for 409 `caseworker_use_conversion`
  (`ContactEditForm.tsx:517-519`).
- Section 5 says all accept effects commit through `commitContactEffect`. Phone
  accepts commit through `commitPhoneEffect` (`suggestionResolution.ts:489-490`).
  This is harmless only because phone is neutral.
- Section 7: the importer's re-type also never bumps `classification_revision`
  (`app/src/lib/import/apply.ts:1071-1073`), so it escapes I1 as well. The
  filed `import-bypasses-contact-type-rules` issue should name I1 next to
  I2 / I3.

## 12. [LOW] Check order on `POST /api/units/:id/contacts` is unspecified

A request can fail three ways at once:
- `contact_list_caseworker`: the contact is a caseworker (any role, I4).
- `landlord_not_landlord`: role `landlord` with a non-landlord contact (I3).
- `landlord_reassignment_required`: role `landlord` on an owned unit
  (`unitsRepo.ts:774-780`).

The spec does not say which wins. Neither of its new checks says whether it
runs before the repo's read-then-write retry loop or inside it. State the
order so the 409 a client sees is deterministic.
