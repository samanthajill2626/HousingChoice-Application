# Caseworker integrity - design

Status: DRAFT revision 1 (2026-10-12). Branch `fix/caseworker-integrity`,
worktree `W:\tmp\caseworker-integrity`, cut from `main` @19607658.

Closes three filed issues that share one theme: a contact converted to a
caseworker (or re-typed by hand) can still end up holding tenant-only data or
tenant-only records.

- `docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md` (R2-ADV-1, med)
- `docs/issues/contact-retype-skips-caseworker-refusals.md` (low)
- `docs/issues/tours-placements-no-contact-type-check.md` (low)

Context: tracker #19 (caseworkers, `feat/caseworkers`) is merged to `main` but
NOT deployed anywhere. This branch must merge before #19 deploys; it ships in the
same deploy. Background design: the historical spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(D16-D22) and the review records in
`docs/superpowers/reviews/2026-10-07-caseworkers/` (R2-ADV-1 schedule in
`code-review-adversarial-r2.md`; the executed reproduction in
`planner-final-review.md` section 4).

All decisions below were ruled by Cameron on 2026-10-12.

---

## 1. Invariants this branch establishes

- **I1 (accept fence).** An accepted AI suggestion for a TENANT-ONLY field
  commits only if the contact's classification is unchanged since the accept
  read it. Tenant-only targets: `housingAuthority`, `voucherSize`, `pets`,
  `evictions`, `tenure`, `porting`, `status`. Neutral targets (`firstName`,
  `lastName`, `phone`, `address`) are NOT fenced and still commit after a
  reclassification. (`type` cannot be accepted at all:
  `accept_type_via_triage`, `app/src/services/suggestionResolution.ts:269`.)
- **I2 (tenant records).** A contact that is the tenant of an OPEN tour or an
  OPEN placement is typed `tenant`. Open tour = status in `requested`,
  `scheduled`, `toured`, `no_show` (the conversion's `OPEN_TOUR_STATUSES`,
  `app/src/services/caseworkerConversion.ts:120`). Open placement = stage not
  in `TERMINAL_STAGES` (`moved_in`, `lost`; `app/src/lib/statusModel.ts:118`).
- **I3 (landlord of record).** A unit's `landlordId` names a contact typed
  `landlord` (a property manager is a landlord with a role).
- **I4 (contact list).** A caseworker (`isCaseworker`,
  `app/src/lib/caseworkers.ts:86`) never sits on a property's contact list.
  Other types may, as today; a seat never blocks a type change.

I2-I4 are enforced at BOTH ends: the write that would create the record or
seat (sections 3-4) and the type change that would invalidate it (section 2).
Each is a read-then-write check, not an atomic one; see section 6 (L1).

---

## 2. D1 - R2-ADV-1: fence a claimed accept on the classification revision

### Today

An accept builds a replay plan from a contact read
(`suggestionResolution.ts:778`, eventually consistent), claims the suggestion
(creates an active `resolve#` journal, deletes the `sugg#` row), then commits
the contact effect in one transaction whose condition is the plan's attribute
guard (`guardForPatch`, `suggestionResolution.ts:194`; real commit
`commitContactEffect`, `app/src/repos/suggestionResolutionRepo.ts:770`,
condition built by `contactGuardCondition`; the test fake
`app/test/helpers/suggestionResolutionFake.ts:322` checks the same guard map
with `contactMatchesGuard`). A guard mismatch ends the journal as
`superseded_by_human_edit` and the requester gets 409
`suggestion_field_edited`. A crashed claim is finished later by
`recoverAbandoned` (any ordinary suggestions read) or the daily journal sweep
(`app/src/jobs/journalSweep.ts`).

The guard names only the fields the plan writes. The caseworker conversion
REMOVES `housingAuthority` and `housingAuthority_source`, so an accept whose
guard expected both absent still matches after the conversion and writes the
authority onto the caseworker. Reproduced on FakeWorld routes and on the real
repos (planner-final-review.md section 4).

### Change

1. **Fence.** When `buildPlan` builds an ACCEPT plan for a tenant-only target
   (I1), it adds `classification_revision` to the plan's guard, from the same
   contact read: `{ exists: false }` when the attribute is absent, else
   `{ exists: true, value: <number> }`. The conversion and every contacts-PATCH
   type/role change already bump `classification_revision` atomically with
   their write (`app/src/repos/contactsRepo.ts:1501`), so the existing guard
   transaction now refuses an accept that spans any reclassification. No new
   repo method and no new transaction: the real repo and the fake already
   enforce whatever keys the guard holds. Dismiss plans and neutral-target
   accepts are unchanged.
2. **Consistent plan read.** The contact read that feeds `buildPlan` becomes a
   consistent read. An eventually consistent read can only make the fence
   refuse spuriously (a stale revision), never write wrongly - but a spurious
   refusal CONSUMES the staff member's chip, so it must not happen right after
   an ordinary triage.
3. **Pre-deploy journals (legacy fallback).** An active journal claimed by the
   old code has no `classification_revision` key in its guard. For a
   tenant-only target with no such key, the commit condition (real and fake
   alike) additionally requires `attribute_not_exists(caseworker_conversion)`.
   The conversion writes that attribute atomically with the type change, so a
   legacy accept can never land on a converted contact. Implement the
   "effective guard" as ONE shared pure function used by the real repo's
   commit, its mismatch arm, and the fake, so parity is by construction.
   Known limit: a legacy journal is not fenced against a GENERIC re-type
   (accepted - the window is crash-recovery of a claim made before the deploy,
   and a generic re-type does not clear the authority anyway).
4. **Honest answer.** When the fence refuses because the classification
   changed (the revision or the conversion record mismatched, not the field
   itself), the requester gets 409 `suggestion_contact_reclassified`, copy:
   "This contact's type changed after the AI suggested it, so nothing was
   applied." A field mismatch keeps `suggestion_field_edited`. The journal
   outcome and the run-log verdict are unchanged (`superseded_by_human_edit`).
   Decide which by re-checking the guard keys against the consistent read the
   refusal path already takes; if both mismatched, report the field edit.
5. **No repair step.** #19 is not live anywhere, so no caseworker can hold a
   late authority yet; `make` again stays follow-on only.

---

## 3. D2 - The generic type change refuses what would break I2 / I3

Surfaces: the contacts PATCH (`app/src/routes/contacts.ts`, type handling
around :1500-1650), reached from the edit form's kind picker
(`dashboard/src/routes/contact/ContactEditForm.tsx`) and the Unknown card's
Mark as Tenant / Landlord / Partner / Property Manager
(`dashboard/src/routes/contact/UnknownFile.tsx` via `onTriage`,
`ContactDetail.tsx:667-676`). The API also allows `team_member` and `unknown`
as targets; the rule applies to every target type.

### Rule

When a PATCH changes `type` (resulting type differs from the stored type):

- resulting type is not `tenant` -> refuse while the contact is the tenant of
  any open placement or open tour (I2);
- resulting type is not `landlord` -> refuse while the contact is the landlord
  of record of any unit, soft-deleted units included (I3; same read as the
  conversion, D22: a restored unit must not come back with a non-landlord
  owner);
- contact-list seats never refuse a type change.

Order: after the existing 409 `caseworker_use_conversion` check and before
any write. Role-only changes (no type change) are not checked.

Response: 409 `{ error: 'type_change_refused', refusals: [...] }`, each refusal
one of `{ code: 'open_placement', placementId }`, `{ code: 'open_tour', tourId }`,
`{ code: 'landlord_of_record', unitId }`, ordered as the conversion orders
them (kind, then id ascending).

### Shared reads

Extract the conversion's private `collectRefusals`
(`caseworkerConversion.ts:217-266`) into a shared module that returns the
four kinds separately (open placements, open tours, landlord-of-record units,
roster seats). The conversion keeps its exact current behavior, codes
(`caseworker_*`) and order; the PATCH asks only for the kinds its rule needs
(it never pays for the roster Scan).

### Dashboard

- Move `refusalCopy` out of `CaseworkerDialog.tsx` (:62-89) into a shared
  module keyed by refusal KIND; the dialog maps its `caseworker_*` codes onto
  it. The four sentences and View links stay byte-identical.
- Edit form: on 409 `type_change_refused`, keep the draft and show each
  refusal's sentence with its View link beside the kind picker (today every
  non-org error shows "Couldn't save - please try again.").
- Unknown card: Mark as ... stops swallowing errors (`.catch(() => {})`,
  `ContactDetail.tsx:672`). `type_change_refused` shows the sentences with
  links on the card; any other failure shows "Couldn't save - please try
  again." on the card.

---

## 4. D3 - Tours, placements and properties check the contact's type

### Tours and placements (I2)

Every path that creates a tour or placement, or moves one back into the open
set, reads the tenant contact and refuses unless it exists, is not deleted,
and is typed `tenant`:

| Surface | Today | Change |
| --- | --- | --- |
| `POST /api/tours` (`app/src/routes/tours.ts:310-406`) | never reads the contact | 404 `tenant_not_found` when missing or deleted; 409 `contact_not_tenant` when not typed `tenant` |
| tour revive: a PATCH that reschedules a `canceled` tour to `scheduled` (`canReschedule`, `app/src/lib/toursModel.ts:147`; route `tours.ts:1145`) | no contact read | same check when the tour leaves `canceled`; rescheduling an already-open tour is not checked |
| `POST /api/tours/:id/reopen` (`tours.ts:1641-1684`, `closed` -> scheduled / toured / no_show) | no contact read | same check |
| `POST /api/placements` (`app/src/routes/placements.ts:566-627`) | 404 `tenant_not_found` when missing | also deleted -> 404; wrong type -> 409 `contact_not_tenant` |
| `POST /api/placements/from-tour` (`placements.ts:635-905`) | existence only | same as above, before any write |
| placement transition from a terminal stage (`moved_in`, `lost`) to a non-terminal stage (`transitionPlacement`, `app/src/services/statusTransition.ts:390`; route `app/src/routes/statusTransition.ts:102`) | no check | same check, in the service so every caller is covered |

409 body: `{ error: 'contact_not_tenant', contactType: <stored type> }`.
Copy (dashboard, wherever these actions report errors): "Tours and
placements are for tenants. This contact is a <kind label>." where the kind
label is the dashboard's existing label for the contact (Caseworker for a
caseworker).

Moving a placement between non-terminal stages, or into a terminal stage, is
not checked. WHETHER a placement may leave `lost` / `moved_in` at all is a
separate question, filed as its own issue (section 7), not decided here.

### Derived tenant status

`deriveTenantStatus` (`statusTransition.ts:335-355`) writes nothing (no
status, no audit, no milestone) when the contact is not typed `tenant`, and
logs at info. Listing-status derivation is unchanged.

### Team members

`TenantFile` also renders for `team_member` contacts
(`ContactDetail.tsx:574-584`) and offers "+ Schedule" and "+ Start placement"
(`TenantFile.tsx:320,348`) there. Hide both for a team member. The server
refuses a team member under the I2 rule like every other non-tenant.

### Landlord of record (I3)

| Surface | Change |
| --- | --- |
| `POST /api/units` (`app/src/routes/units.ts:464-514`; `landlordId` required) | 404 `landlord_not_found` when the contact is missing or deleted; 409 `landlord_not_landlord` when not typed `landlord` |
| `PATCH /api/units/:id` with a changed `landlordId` (`units.ts:1376-1491`; writable per `app/src/lib/unitFields.ts:46`) | same |
| `POST /api/units/:id/contacts` with role `landlord` (claims a vacant landlord slot or re-asserts the owner; `app/src/repos/unitsRepo.ts:773-823`) | 409 `landlord_not_landlord` when the contact is not typed `landlord` |

Dashboard: `UnitCreateForm` already offers landlords only; no dashboard UI
reassigns `landlordId`; the property Add contact form shows the server's
sentence: "Only a landlord can be a property's landlord of record."

### Contact list (I4)

`POST /api/units/:id/contacts` (`units.ts:1061-1137`) refuses a caseworker
with 409 `contact_list_caseworker` (any role), copy: "Caseworkers can't be on
a property's contact list." The property Add contact picker
(`dashboard/src/routes/listing/ListingDetail.tsx:194,367,967-986`, fed by
`useContacts('all')`) hides caseworkers.

---

## 5. Surface inventory (planner sweep, for the plan's invariant rule)

Writers of the protected state and how each is handled:

- **Contact classification:** contacts PATCH (D2); caseworker conversion
  (unchanged; already refuses all four kinds); the Airtable importer's
  re-type (`app/src/lib/import/apply.ts:883-1110`) - OUT OF SCOPE, filed
  (section 7); AI extraction only suggests a type.
- **Tour/placement creation and reopen:** the six surfaces in section 4.
  `tenantId` is immutable after create on both (tours `PATCH_ALLOWED`,
  `tours.ts:157`; placements PATCH). No job or dev seam creates or reopens
  them (`jobs/tourAutoClose.ts` only closes).
- **landlordId:** unit create, unit PATCH, roster landlord claim (section 4);
  the importer's `landlordId` fact (`apply.ts:1519`) - OUT OF SCOPE, filed.
- **Contact-list seats:** `POST /api/units/:id/contacts` only.
  (`app/src/services/rosterEdits.ts` edits tour/placement RELAY rosters, not
  property contact lists - the filed issue named it in error.)
- **Accept effects:** `resolve` and both recovery paths (`recoverAbandoned`,
  journal sweep) all commit through `commitContactEffect` (D1).
- **Seeds** (`app/src/lib/seed/*`: lean, full/cast, live, matrix,
  performance) write tours, placements, units and rosters directly. They
  must satisfy I2-I4; the plan adds a seed-invariant test over every profile.
- **e2e fixtures** that create tours, placements, units or roster seats
  through the API must use correctly typed contacts; any that do not must be
  found and fixed by the build (they will now be refused).

Readers that depend on these invariants (unchanged, listed so nothing
contradicts them): tour reminders (`jobs/tourReminders.ts:1093`,
`routes/tourReminders.ts:1027`), placement nudges, relay fan-out, the contact
timeline, the Possible caseworkers list.

---

## 6. Known limits (documented, not fixed)

- **L1 - millisecond race.** I2-I4 checks are reads before writes. Two staff
  acting on the same contact at the same instant (one converting or re-typing
  it, the other creating a tour or seat for it) can both pass their reads.
  No cross-record lock is built (Cameron, 2026-10-12). Contrast D1, whose
  window is durable (crash recovery can run hours later) and is therefore
  fenced atomically.
- **L2 - existing data.** No backfill. Records created before this branch
  that violate I2-I4 are left as they are (the conversion never shipped, so
  none should involve caseworkers).
- **L3 - extraction in flight.** Unchanged and out of scope:
  `extraction-in-flight-writes-onto-converted-caseworker` (deferral approved).

---

## 7. Docs owed in this branch

- RUNBOOK "What the conversion does not fence" paragraph (RUNBOOK.md:473):
  state that a staff accept claimed before a conversion is now refused (D1),
  so the hand-clear applies to the extraction writer only; add L1.
- Resolve `claimed-suggestion-accept-after-caseworker-conversion`,
  `contact-retype-skips-caseworker-refusals`, `tours-placements-no-contact-type-check`
  (status, resolved date, Resolution paragraph). In the last one, correct the
  record: the property contact-list add is in `units.ts`, not `rosterEdits.ts`,
  and note that a placement can leave `lost` / `moved_in` with no guard.
- File `placement-terminal-stage-exit-unguarded` (a placement can move out of
  `lost` or `moved_in` to any stage; whether that is allowed is undecided).
- File `import-bypasses-contact-type-rules` (the importer's re-type and
  `landlordId` writes do not apply I2 / I3).
- GLOSSARY: no new domain noun expected; update only if one appears.

---

## 8. Tests the build must add

- **D1 regressions, real AND fake:** the R2-ADV-1 schedule as a deterministic
  test - (A) claim paused at the `claimed` boundary, convert, resume ->
  409 `suggestion_contact_reclassified`, no authority, journal completed;
  (B) crash after claim, convert, recover via an ordinary suggestions read
  and via the journal sweep -> no authority. Run on FakeWorld routes and on
  the real repos (DynamoDB Local). Plus: a neutral target (address and phone)
  claimed before the conversion still commits; a `voucherSize` accept spanning
  a generic tenant -> landlord re-type is refused; a legacy journal (guard
  without the revision key) recovered onto a converted contact is refused,
  onto an unconverted contact commits; the effective-guard function is
  shared by the real repo and the fake.
- **D2:** PATCH refusal matrix (to/from tenant, landlord, partner, unknown,
  team_member) with open placement, open tour, landlord of record
  (soft-deleted unit included), roster seat (never refuses); dashboard tests
  for the edit form and the Unknown card showing sentences and links.
- **D3:** each surface in section 4 refuses a non-tenant / non-landlord /
  caseworker as specified and still accepts the valid case;
  `deriveTenantStatus` skips a non-tenant; TenantFile hides both buttons for
  a team member; the Add contact picker hides caseworkers.
- **Seeds:** the invariant test in section 5.
- **e2e:** extend existing specs for one refusal per area (type change from
  the edit form; tour create for a non-tenant is not offered / refused; Add
  contact hides a caseworker). New behavior gets a spec; reuse fixtures.

## 9. Gates

The five AGENTS.md gates, bare, from the worktree: `npm run typecheck`,
`npm test`, `npm run smoke`, `npm run e2e`, and
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
(skip only if that list is empty). Do not restart the shared DynamoDB Local
container without Cameron's go.

## 10. Non-goals

- Tracker #14 (the /join form) - a separate branch and agent.
- Whether a placement may leave a terminal stage at all (filed).
- The importer (filed).
- Making I2-I4 atomic across records (L1).
- Any change to the conversion's behavior, codes or copy.
