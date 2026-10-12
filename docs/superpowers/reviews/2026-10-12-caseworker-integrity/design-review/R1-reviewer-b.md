# Caseworker integrity design - R1 adversarial review (reviewer B)

Spec under review: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`
(DRAFT revision 1, branch `fix/caseworker-integrity` @cc10cb44).
Method: every claim about current behavior was checked in the code at the
cited lines; anything not checked is marked UNVERIFIED. No tests, servers or
DynamoDB were run.

Claims verified as accurate (no finding): suggestionResolution.ts:778 plan
read is eventually consistent; guardForPatch at :194; accept_type_via_triage at
:269; commitContactEffect at repo:770 with contactGuardCondition; fake at
suggestionResolutionFake.ts:322 with its own mirrored contactMatchesGuard;
contactsRepo.update bumps classification_revision whenever `type` or `role`
is in the patch (contactsRepo.ts:1467-1469, 1501-1508); the conversion writes
`caseworker_conversion` and bumps the revision in the same write
(caseworkerConversion.ts:555-577); OPEN_TOUR_STATUSES (:120);
TERMINAL_STAGES (statusModel.ts:118); collectRefusals (:217-266); POST
/api/tours never reads the contact (tours.ts:310-406); POST /api/placements and
/from-tour check existence only (placements.ts:576, 666); tenantId immutable
(tours.ts:157, placements.ts:253-285 has no tenantId and refuses `stage`);
`stage` changes only through transitionPlacement (placements.ts:279-285);
UnitCreateForm offers landlords only (UnitCreateForm.tsx:143); the Unknown
card swallows errors (ContactDetail.tsx:672); TenantFile renders for
team_member (ContactDetail.tsx:577-584).

---

## 1. [HIGH] The new 409 `suggestion_contact_reclassified` has three consumers keyed on the error CODE that the spec never names

**What is wrong.** D1.4 introduces a new requester answer, 409
`suggestion_contact_reclassified`, and gives its copy, but does not enumerate
where the existing refusal code `suggestion_field_edited` is consumed. Every
consumer switches on the literal code, so a build that adds the new code at
the service alone silently drops all three behaviors for exactly the refusal
this branch exists to produce:

- Server notify: `routes/suggestions.ts:219-226` emits `suggestion.updated`
  only when `error.code === 'suggestion_field_edited'` (the H1 fix: claim()
  already deleted the `sugg#` row, so every open dashboard shows a chip that
  no longer exists). The new code is not in that test, so no tab is told.
- Dashboard copy: `dashboard/src/api/types.ts:1677-1678` maps
  `suggestion_field_edited`; an unmapped code falls to "Something went wrong -
  please try again." (`types.ts:1695-1697`) - which invites a retry on a chip
  that is already gone.
- Dashboard refetch: `ContactDetail.tsx:720-725` refetches the suggestion
  list only for `no_pending_suggestion`, `suggestion_already_resolved`,
  `suggestion_field_edited`. The requester's own chip stays on screen.

**Evidence.** Spec section 2 item 4 (lines 105-111) names the code and copy
only. Code as cited above.

**Implies.** The spec must list the three sites (and the e2e/dashboard tests
that pin them). As written, the H1 guarantee regresses for the reclassified
refusal, and the staff member is told to try again.

---

## 2. [MEDIUM] Tour "revive" is misenumerated: a PATCH can move a canceled tour to `toured` or `no_show`, and the row's two descriptions contradict each other

**What is wrong.** I2 (section 1) and section 4's lead sentence cover every
path that "moves one back into the open set", and the open set includes
`toured` and `no_show`. The PATCH guard (`tours.ts:1210-1265`) refuses only:
anything from `closed`, any move to `requested`, non-booking exits from
`requested`, and `scheduled` from a non-reschedulable status. Nothing refuses
`canceled -> toured` or `canceled -> no_show` (the file's own comment at
`tours.ts:1361-1364` notes no same-status or edge rule beyond these). Both
land a canceled tour back in the open set.

The table row (spec line 183) is headed "a PATCH that reschedules a `canceled`
tour to `scheduled` (`canReschedule`...)" - which misses those two edges -
while its Change column says "same check when the tour leaves `canceled`",
which also catches `canceled -> closed` (legal, not an open move) and would
over-refuse closing a non-tenant's dead tour. A builder must pick one reading;
either is wrong. Note also that `canceled -> scheduled` has two request
shapes: explicit `status: 'scheduled'` and the scheduledAt-only auto-advance
(`tours.ts:1302-1308`); the check must key on the EFFECTIVE status.

**Evidence.** tours.ts:1210-1265, 1302-1308. The dashboard offers only
Reschedule on a canceled tour (`TourDetail.tsx:104-109`, 639-644), so the
hole is API-reachable (e2e helpers PATCH `status` directly, e.g.
`today-past-tours.spec.ts:65`) rather than one click away.

**Implies.** Define the trigger as "the effective post-patch status is open
AND the stored status is not open" and list the concrete edges. Section 5's
"the six surfaces" count and section 8's D3 tests inherit the gap.

---

## 3. [MEDIUM] The landlord-of-record refusal on every type change is a permanent dashboard dead end, and its copy tells staff to do something no UI can do

**What is wrong.** D2 refuses any type change away from `landlord` while the
contact is the landlord of record of any unit, soft-deleted units included
(spec lines 134-137). The refusal reuses the conversion's sentence
byte-for-byte (spec line 160-161): "This contact is the landlord of record
for a property. Change that property's landlord first."
(`CaseworkerDialog.tsx:76-80`). But section 4 itself states "no dashboard UI
reassigns `landlordId`" (spec line 221), and the code agrees: the only
dashboard writer of `landlordId` is unit creation (`UnitCreateForm.tsx:192`).
Deleting the property does not help either, because deleted units count.

So any contact that has ever owned a property - including one mistriaged
with "Mark as Landlord" and given a property before the mistake was noticed -
can never be re-typed from the dashboard. The only way out is a raw
`PATCH /api/units/:id { landlordId }` per unit, live or deleted, which the
spec neither documents (RUNBOOK) nor acknowledges. For the conversion this
was one rare path; D2 extends it to every type change of every landlord.

**Evidence.** Spec section 3 rule and Dashboard bullets; section 4 Dashboard
line; CaseworkerDialog.tsx:76-80; unitFields.ts:46 (`landlordId` writable only
through the API); UnitCreateForm.tsx:192.

**Implies.** Either state the dead end as an accepted limit with an operator
procedure in RUNBOOK (section 7 docs), or give D2 its own sentence for this
kind that does not promise an action the product lacks. "Byte-identical"
and "no UI reassigns landlordId" cannot both stand without one of those.

---

## 4. [LOW] The legacy effective guard must also reach the repo's stale-vs-mismatch re-check, or a legacy journal on a converted contact becomes a poison journal

**What is wrong.** D1.3 says the effective guard is "ONE shared pure function
used by the real repo's commit, its mismatch arm, and the fake". The real
repo consults the guard at THREE places: the commit condition
(`suggestionResolutionRepo.ts:798`), the in-memory re-check on the consistent
read that decides stale vs mismatch (`:827`, `contactMatchesGuard`), and the
mismatch ConditionCheck (`:831`). If `:827` keeps reading `plan.guard`, a
legacy housingAuthority journal on a converted contact runs: commit fails on
`caseworker_conversion` -> `:827` sees the plan guard satisfied (the
conversion removed authority and source, which the plan expected absent) ->
returns `stale` -> 409 `suggestion_resolution_lost` (retryable) on resolve, or
a logged failure in recoverAbandoned -> the journal stays active and every
read and every daily sweep retries it forever.

**Evidence.** suggestionResolutionRepo.ts:798, 820-829, 831-851; fake
suggestionResolutionFake.ts:334 (one site only, so fake-only tests cannot
catch a real-repo omission).

**Implies.** Name the three real-repo sites explicitly, and add a real-repo
test for the legacy case on a converted contact (section 8 lists the case
but not that it must run on the real repo, where the third site lives).

---

## 5. [LOW] D1.4's "honest answer" has no specified carrier, and its tie-break makes the answer unreachable for `status`

**What is wrong.** (a) The only signal from the repo today is the single
result `superseded_by_human_edit` (`suggestionResolutionRepo.ts:159-164`),
turned into one service flag (`suggestionResolution.ts:585`). The decision
"revision/conversion vs field" is made on the consistent read INSIDE the
repo (`:822`) and the fake (`:329`), so the result type, both
implementations, the lost-ack branch (`:854-861`) and applyJournal must all
carry a second outcome. "No new repo method and no new transaction" (D1.1) is
true but hides that the repo contract changes; the spec does not say how.
(b) "If both mismatched, report the field edit": every reclassification path
also rewrites `status` - the conversion sets `active`
(`caseworkerConversion.ts:558`), and a PATCH re-type auto-advances or
normalizes status (`contacts.ts:1579-1616`). So a `status` accept spanning any
reclassification always answers `suggestion_field_edited`; the new code is
unreachable for one of the seven fenced targets. (c) The copy says "type
changed", but a role-only edit also bumps the revision
(`contactsRepo.ts:1467-1469`) and is refused with that sentence.

**Implies.** Specify the result variant; state the status outcome on purpose
or reverse the tie-break; word the copy as "type or role".

---

## 6. [LOW] The opening theme is overclaimed: a contact re-typed by hand can still be given tenant-only data through an accept

**What is wrong.** Spec line 6-8 says the branch closes "a contact converted
to a caseworker (or re-typed by hand) can still end up holding tenant-only
data". The D1 fence only refuses an accept whose plan read PRECEDES the
reclassification. A generic re-type supersedes only the type suggestion and
suggestions for fields the PATCH itself changed (`contacts.ts:1735-1746`,
1801-1830), so pending `housingAuthority` / `voucherSize` / `pets` / ...
chips survive it. An accept made after the re-type reads the new revision,
passes the fence, and writes: `buildPlan` checks the contact's type only for
`status` (`suggestionResolution.ts:270-273`); the housingAuthority and
generic arms (`:328-375`) check nothing. A team member still renders
TenantFile with its suggestion chips (`ContactDetail.tsx:577-584`,
1195-1199). (The conversion itself removes pending suggestions, so for
caseworkers only L3 remains - this is about the generic re-type D2 now
governs.)

**Implies.** Either narrow the theme sentence to what I1 delivers, or note
this as a known limit. Not a request to add scope.

---

## 7. [LOW] The D3 409 body cannot produce the promised copy, and the transition path's error mapping is not addressed

**What is wrong.** The body is `{ error: 'contact_not_tenant', contactType:
<stored type> }` (spec line 189), but the copy promises "Caseworker for a
caseworker" (line 192-193). A caseworker's stored type is `partner`
(`lib/caseworkers.ts:86-88`), and the dashboard surfaces that would show this
sentence do not hold the contact's role (e.g. ScheduleTourForm loads only
`type: 'tenant'` contacts, `ScheduleTourForm.tsx:179`). Separately, the
placement-transition check lives in the service, whose errors reach the
route through `handleTransitionError` (`routes/statusTransition.ts:330-343`):
`TransitionRefusedError` becomes 400 `{ error }` with no extra fields, and
`EntityNotFoundError('contact')` becomes 404 `contact_not_found`, not
`tenant_not_found`. The spec's 409/404 codes need a new mapping it does not
mention. The dashboard callers today show generic text on any failure
(`PlacementsPage.tsx:95-97`, `PlacementDetail.tsx:403`); "wherever these
actions report errors" (line 190) does not enumerate them.

**Implies.** Put the role (or a display label) in the body or drop the
Caseworker promise; specify the transition error mapping; list the dashboard
catch sites.

---

## 8. [LOW] Roster row actions share the new refusals, and the roster's catch-all 409 copy is false for them

**What is wrong.** Section 4 assigns copy only to "the property Add contact
form". All roster writes go through one handler, `runRosterWrite`
(`ListingDetail.tsx:388-412`), whose fallthrough for ANY unmapped 409 is
`ROSTER_CONFLICT_COPY` = "That contact is the landlord of record now -
reassign the property's landlord first." (`ListingDetail.tsx:115-116`). The
new `contact_list_caseworker` and `landlord_not_landlord` would render that
false sentence unless mapped there. The row actions also hit the new checks:
"Make primary" re-sends the row's own role (`ListingDetail.tsx:437-445`), so
on the landlord-of-record row it is a `role: 'landlord'` re-assert, refused
when the owner is not typed landlord (L2 data); the role select
(`:425-433`) and Make primary on a seated caseworker are refused for "any
role".

**Implies.** Name `runRosterWrite` as the copy site and decide what the row
actions do on legacy rows.

---

## 9. [LOW] "Deleted -> 404" is new behavior on live surfaces with no dashboard handling

**What is wrong.** Today a soft-deleted tenant passes the existence check
(`placements.ts:576`, 666 - `getById` returns soft-deleted items). The spec
makes create, from-tour, reopen and revive refuse a deleted tenant with 404
`tenant_not_found`, but TenantFile still offers "+ Schedule" and "+ Start
placement" on a deleted tenant (`ContactDetail.tsx:1203-1204`; contrast the
relay action, withheld when deleted at `:631-633`). A toured, move-forward
tour whose tenant was later deleted now cannot convert, and auto-close skips
it because it is convertible (`toursModel.ts:204`); it waits for a manual
close or a restore.

**Implies.** Say whether the actions hide on a deleted contact and what copy
`tenant_not_found` gets; mention the stranded-convertible case.

---

## 10. [LOW] L2's rationale is wrong: caseworkers exist without the conversion

**What is wrong.** L2 says "the conversion never shipped, so none should
involve caseworkers". A caseworker is any partner whose role is
"caseworker"/"case worker" (`lib/caseworkers.ts:52-55`, 86-88), and the API
creates one directly: e2e does so via POST /api/contacts
(`partner-share.spec.ts:69`, `org-lists.spec.ts:700`), and RUNBOOK.md:466
documents contacts "CREATED as a caseworker". Whether production holds
partner+caseworker contacts seated on property contact lists or holding
tours is UNVERIFIED, but the reasoning that none can exist does not hold.

**Implies.** Restate L2 without the claim, or check the data.

---

## 11. [LOW] Import re-types never bump `classification_revision`, so I1's fence does not see them - and the filed issue omits I1

**What is wrong.** `lib/import/apply.ts:1070-1072` states an import "never
bumps classification_revision". I1 is stated universally ("commits only if
the contact's classification is unchanged"), but an import re-type spanning a
claimed accept passes the fence. Section 7's filed issue
`import-bypasses-contact-type-rules` is scoped to I2/I3 only.

**Implies.** Add I1 to the filed issue's text (no build change).

---

## 12. [LOW] Section 1's enforcement sentence cites the wrong sections and overstates I4

**What is wrong.** "the write that would create the record or seat (sections
3-4) and the type change that would invalidate it (section 2)". Section 2 is
D1 (the accept fence); the type change is section 3 (D2) and creation is
section 4 (D3). And D2 explicitly never refuses for seats, so I4's
type-change end is the conversion plus `caseworker_use_conversion`
(`contacts.ts:1624-1636`), not D2.

**Implies.** Fix the references; name the actual I4 type-change guard.

---

## 13. [LOW] The edit form's current error handling is misdescribed

**What is wrong.** Spec line 163-164: "today every non-org error shows
'Couldn't save - please try again.'". `ContactEditForm.tsx:517-519` already
special-cases 409 `caseworker_use_conversion` with its own sentence. A
rewrite of the catch block from the spec's description could drop it.

**Implies.** Correct the sentence; the new branch sits beside the existing one.

---

## 14. [LOW] Excluding `unknown` from I2 departs from the filed issue without a stated reason

**What is wrong.** The issue being closed suggests refusing a tour or
placement whose tenant is "not typed `tenant` (or `unknown`, for triage)"
(`docs/issues/tours-placements-no-contact-type-check.md`, Suggested fix). The
spec requires `tenant` only. Existing readers are built for an unknown
tenant: reminders accept `unknown_1to1` threads (`jobs/tourReminders.ts:1092`,
`routes/tourReminders.ts:1027`), and UnknownFile renders an unknown contact's
placements (`UnknownFile.tsx:85`, 200-205). The stricter rule is defensible
(the dashboard pickers already load only tenants, `ScheduleTourForm.tsx:179`),
but a builder cannot tell it was deliberate.

**Implies.** One sentence recording the ruling, so the issue's Resolution
paragraph does not contradict the issue body.

---

## 15. [LOW] L1 understates its window: the refusal reads are index reads and the contact reads are unspecified

**What is wrong.** L1 calls the gap a "millisecond race" between two staff
"at the same instant". D2's refusal reads are GSI queries (byTenant,
byLandlord - never strongly consistent), and section 4 does not say whether
the new contact reads in tours/placements/units are consistent (the existing
ones at `placements.ts:576`, 666 are not). The window is index propagation
lag, which one staff member acting in sequence (schedule, then re-type) can
cross.

**Implies.** Require consistent contact reads in D3, and word L1 as an
eventual-consistency window.
