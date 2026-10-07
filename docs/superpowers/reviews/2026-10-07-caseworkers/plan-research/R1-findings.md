# R1 findings - contacts server and the caseworker conversion (plan research)

Branch feat/caseworkers @ 97ac55ee, spec revision 13
(docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md).
Scope: the contacts PATCH/POST, contactsRepo, conversationsRepo, the
caseworker conversion and its routes, the possible-caseworkers read, the
shared kind helpers, the importer guard, wiring and fakes. Code is cited by
file:line (app/ unless noted). Each finding says what the spec says, what the
code does, and the ruling the plan needs.

Severity: MEDIUM = a builder following the spec literally ships a wrong
write; LOW = the spec leaves a choice the plan must make explicit; INFO =
context worth a line in the plan.

---

## F1 (MEDIUM) Pointer rows are not "missing": the conversion must 404 them

Spec D19: "a deleted or missing contact answers 404; a `team_member` answers
400; an `unknown`, tenant, landlord or partner that is not a caseworker
converts".

Code: `contactsRepo.getById` returns phone and email POINTER rows by id
(`phoneref#<E.164>`, `emailref#<addr>`; repos/contactsRepo.ts:341-354). A real
pointer row carries no `type` and no `status` (comment at
repos/contactsRepo.ts:260-268). GET `/:contactId` hides only phone pointers
(routes/contacts.ts:1153 checks `phone_ref === true`; `email_ref` is not
checked). The PATCH has no pointer guard at all (pre-existing).

Consequence if built as written: a pointer id falls through every domain
check (not deleted, not team_member, not a caseworker) and `make` SETs
`type: partner`, `status: active` on the pointer row - which puts the pointer
into the byTypeStatus partner partition (it would then show in lists and the
Possible list). The FakeWorld hides this: fake pointer rows carry a sentinel
`type: 'unknown'` (test/helpers/twilioWebhookHarness.ts:2080-2086 phone,
2134-2148 email), so a fake-backed test would "convert" an unknown.

Ruling needed: `make`, `dismiss` and the preview answer 404
`contact_not_found` for any row with `phone_ref === true` or
`email_ref === true` (and, belt-and-braces, for a row whose `type` is not one
of the five ContactTypes). Pin it with a test that uses a pointer id.

## F2 (MEDIUM) The commit guard does not exclude a contact deleted after the read

Spec D19 step 1: the write is "conditional on the `classification_revision`
AND the `housingAuthority`, `agency` and `organization` values the route
read ... maps a failed condition to 404 when a re-read finds the contact
gone, else 409".

Code: soft delete only stamps `deleted_at` (repos/contactsRepo.ts softDelete,
condition `attribute_exists(contactId)`); it does not bump
`classification_revision` or touch the org fields. So a staff delete landing
between the route's read and the commit passes the four-part guard and the
contact is converted while deleted (and its threads re-typed in step 3).
"Gone" in the spec's 404 mapping covers only a missing item.

Ruling needed: add `attribute_not_exists(deleted_at)` to the commit
condition (a fifth clause) and map a failed condition whose consistent
re-read is deleted to 404, as the domain rule already does for a deleted
contact at read time. The repair path (`make` on a caseworker, steps 2-4)
should re-check `isDeleted` too.

## F3 (LOW) The revision clause must guard the RAW attribute, not the folded number

Spec: "the plan extends it to this four-part guard (the revision number,
and each org field as a value, `''` or absent)".

Code: `UpdateContactOptions.expect` is `{ attr: string; value: string | null }`
(repos/contactsRepo.ts:625-627) - one STRING clause. The fence is written as
`if_not_exists(#classificationRevision, 0) + 1` (1352-1358), so a legacy
contact has NO attribute (not 0). `contactClassificationRevision()`
(329-338) folds absent and invalid values to 0, so a guard built from it
(`classification_revision = 0`) fails on every legacy contact and the route
answers a spurious 409.

Ruling needed: the guard carries the stored attribute as read - a number
clause when present, `attribute_not_exists` when absent; the option widens
to a list of clauses whose value may be a number; the no-op path
(1360-1381) evaluates every clause; the FakeWorld `update`
(twilioWebhookHarness.ts:2340-2346) mirrors all of it.

## F4 (LOW) An extraction run in flight can write tenant facts onto a fresh caseworker

Spec D19 says the conversion removes the housing authority "on purpose" and
the importer guard protects that; it says nothing about the AI.

Code: the extraction job reads the contact once at run start
(jobs/extraction.ts:430-441) and applies against that snapshot:
`fieldApplies` is decided on the snapshot type (services/extraction/apply.ts:137-142)
and the direct write is unconditional (apply.ts:500
`deps.contacts.update(contactId, writePatch)`; notes at 745). A run that
read the contact as a tenant and commits after the conversion's step 1 can
write `housingAuthority` + `housingAuthority_source` (and voucherSize etc.)
onto the new caseworker, and can put new suggestions after step 2's sweep
(they would then sit pending on a partner that is never extracted again,
jobs/extraction.ts:456).

Ruling needed: accept and file (the same class as the generic type change),
or fence the apply layer's contact write on the snapshot's
`classification_revision`. If accepted, RUNBOOK's repair note should say a
second `make` re-sweeps suggestions but does NOT remove an AI-written
authority.

## F5 (LOW) The importer guard is a read-then-write, and imports never bump the fence

Spec D21: the importer "writes none of `type`, `status`, `housingAuthority`
or `agency`" for a contact whose `type_source` is `'manual'`; D19: the
revision guard catches "a concurrent classification".

Code: `upsertContact` reads the item (lib/import/apply.ts:1057-1060) and later
issues one UpdateCommand with no ConditionExpression (1159-1166); it always
SETs `#type = :type` (1080) and never touches `classification_revision`. So
(a) a conversion committing between the importer's read and write has its
type and status reverted and its removed housing authority refilled
(`if_not_exists` after a REMOVE, 1133-1136); (b) an import's type write is a
classification the conversion's revision clause cannot see.

Ruling needed: either make the importer write conditional
(`attribute_not_exists(type_source) OR type_source <> :manual` when the read
saw no stamp, re-running the reduced write on a lost condition) or state the
race as accepted, as `preserveStatus` (1074-1077) already accepts it. Note
(b) in the plan so no one reads the revision clause as covering imports.

## F6 (LOW) "Any unit" vs soft-deleted units; the landlord check has an index

Spec D19: refuse "any unit's landlord of record (`landlordId`)" and "a seat on
any unit's contact roster", the roster check being "a scan of every unit (no
index)".

Code: both `listByLandlord` (repos/unitsRepo.ts:367, filter at 480-483) and
the `list()` Scan (1007-1025, filter at 1013) EXCLUDE soft-deleted units by
default. A restored unit would then have a caseworker as landlord of record.
Also the byLandlord GSI exists, so the landlord-of-record refusal does not
need the scan; one Scan with `unitContacts(unit)` (296-305) still answers
both refusals.

Ruling needed: whether soft-deleted units count (recommend yes: two passes,
`deleted` false and true, or a Scan without the filter), and which read
answers which refusal (the `unitsRepo` dep must be added to the contacts
router; routes/api.ts:853-886 does not pass one today).

## F7 (LOW) The relationship signal's role match is unspecified

Spec D19: "tenants linked as another contact's caseworker relationship (a
relationship row that carries a `contactId`)". D16 names three match tiers
(byte-exact canonicalizer, `isCaseworkerRole`, the looser "mentions") but not
which one a relationship row's `role` uses.

Code: relationship rows are `{ role, name, contactId? }` with a free-text,
trimmed role (lib/contactProfile.ts:1, 9-24), suggested from the vocabulary.
e2e/tests/dashboard-next/contact-create.spec.ts:186 writes role `'Caseworker'`.

Ruling needed: name the tier (recommend the same "mentions" rule as roles,
so "Case Manager" and "Case worker" rows count).

## F8 (LOW) "Mentions" and "the AI's own line" need exact definitions

Spec: role "mentions caseworker or case manager"; notes carry "the AI's own
'Identified as a caseworker' line".

Code: the AI line is model-authored text appended as
`[Auto - <Mon> <D>] <line>` (services/extraction/apply.ts:144-149, 749-750),
lines joined by `\n`; the only anchor is the prompt example
(services/extraction/prompt.ts:93, "Identified as a caseworker at Hope
Atlanta"), so the model may write "Identified as caseworker ..." or "...case
worker ...". Staff can edit `notes` freely (contacts.ts:582-587), so the
prefix is evidence, not proof.

Ruling needed: (a) "mentions" = which normalization (recommend D4's
`normalizeOrgText`, lib/orgNames.ts:49) and which substrings
(`caseworker`, `case worker`, `case manager`; is `case mgr` / `case
management` in?); (b) the notes match = a line whose text after an optional
`[Auto - ...]` prefix starts with "identified as" followed by an
"a caseworker"/"caseworker"/"a case worker" form, case-insensitive (or
exactly the prompt's phrase). Test with the prompt.ts:93 string verbatim.

## F9 (LOW) Possible-list row shape and `dismiss` side effects are open

Spec section 6: "one row per contact with its name, type, current role and
the signal that put it there"; D19 `dismiss` "writes `caseworker_review:
'dismissed'`".

Open choices: a contact can match several signals (a role, the AI line, a
relationship) - one signal (which precedence?) or a list; whether `dismiss`
writes an audit row (`contact_updated` with `fields: ['caseworker_review']`
would match the PATCH's audit) and whether it goes through
`contactsRepo.update` (it is not a classification, so no revision bump - it
will make a concurrent `make` NOT 409, which is fine); what `dismiss` does on
an `unknown` (the domain lists unknown under "converts" only) and on a body
carrying `organization`.

## F10 (LOW) Does contacts POST refuse the server-owned fields too?

Spec D21: `type_source` "is refused as `consent_captured_by` is"; section 6
lists the refusal of `caseworker_review`, `caseworker_conversion` and
`type_source` under the contacts PATCH only.

Code: `consent_captured_by` is refused on BOTH paths through the shared
`applyConsentFields` (routes/contacts.ts:313-315; pinned by
test/contactsCrud.test.ts:271 for POST and :489 for PATCH). `parseCreateBody`
otherwise drops unknown keys silently (782-952).

Ruling needed: refuse the three keys on POST too (recommend yes, one helper
both parsers call) or say POST ignores them.

## F11 (LOW) The 409 decision needs a consistent read and the merged kind

Spec D16: the PATCH refuses 409 `caseworker_use_conversion` "a write whose
result would be a caseworker on a contact that is not one".

Code: the PATCH's stored read is eventually consistent unless an org field is
in the body (routes/contacts.ts:1467-1472). The "result" must merge the
stored role when the body omits `role` (and treat `role: ''`/null as
absent): a tenant whose stored role is "Case worker", re-typed to Partner
from the edit form with no role in the body, is a caseworker result and must
409 - correct per D16, but the dashboard must surface it. A stale read can
mis-classify "already a caseworker".

Ruling needed: read consistently when `type` or `role` is in the patch;
compute the result kind from the merge; optionally pass the read's revision
as an `expect` clause so the decision and the write see the same kind.

## F12 (LOW) The status milestone labels by the OLD type

Spec D19 step 4: "the `contact_status_changed` milestone when the status
changed", one of "the PATCH's side effects".

Code: the PATCH picks the label map from the STORED type (routes/contacts.ts:1924,
landlord -> LANDLORD_STATUS_LABELS else TENANT_STATUS_LABELS);
TENANT_STATUS_LABELS has no `active` (lib/statusModel.ts:154-162), so a tenant
converted to `active` records the raw "active". Pre-existing for a generic
tenant -> partner change.

Ruling needed: the conversion labels by the NEW type (partner -> "Active").

## F13 (LOW) "Clears `agency`" - `''` or REMOVE

Spec D19 step 1: "REMOVEs `housingAuthority` and `housingAuthority_source`;
clears `agency`". D5: `agency: ''` keeps today's stored `''`.

Code: every machine clear of agency SETs `''` (services/orgRecords.ts:292;
`rewriteOrgFields` "next.agency is SET, '' included",
repos/contactsRepo.ts:818). With `''` the importer's fill-only
`if_not_exists(#agency, ...)` (lib/import/apply.ts:1139-1143) cannot refill it
even without the `type_source` guard.

Ruling needed: state `''` (recommended) so the guard, the preview and the
`caseworker_conversion.agency` capture agree on the representation.

## F14 (LOW) "One shared helper" is two copies plus a mirror test

Spec D16: "one constant, `CASEWORKER_ROLE`, beside `PROPERTY_MANAGER_ROLE`"
and tiers "each named and owned by one shared helper".

Code: the server constant lives in services/extraction/contactKinds.ts:4; the
dashboard has its own `PM_ROLE` (dashboard/src/routes/contact/contactProfile.ts:11)
and cannot import app code at runtime. The repo's parity precedent is a
dashboard mirror test that imports app source
(dashboard/src/routes/contact/mediaTypeMirror.test.ts:30).
`isCaseworkerRole` needs D4 normalization, which the dashboard already
mirrors by hand (dashboard/src/routes/orgs/orgCopy.ts, noted at
lib/orgNames.ts:47).

Ruling needed: server copy beside PROPERTY_MANAGER_ROLE, dashboard copy
beside PM_ROLE, and a mirror test pinning `CASEWORKER_ROLE` and a table of
`isCaseworkerRole` cases.

## F15 (LOW) The conversion's thread step needs a new conditional primitive and two small rules

Spec D21: "Each re-type is conditional on the type the read returned."

Code: `applyTriage` is unconditional (repos/conversationsRepo.ts:1516-1561,
condition `attribute_exists(conversationId)` only) and so is the fake
(twilioWebhookHarness.ts:823-831). The PATCH denormalizes
`participant_display_name` on every linked thread (routes/contacts.ts:1880-1885);
the spec does not say whether the conversion does. Legacy 1:1 rows may lack
`type` (the `UnreadBucket` note, conversationsRepo.ts:84-90).

Ruling needed: a new repo primitive (type SET conditional on
`#t = :expected`, lost condition = skipped and counted, not thrown to the
client) mirrored in the fake; whether the conversion also writes the display
name; whether a type-less open 1:1 row is re-typed (recommend: leave it,
count it as left).

## F16 (INFO) Tenant status derivation does not check type (section 12 follow-up)

Spec section 12 files that tours and placements check no contact type after
a conversion. One more consequence for that issue: `deriveTenantStatus`
(services/statusTransition.ts:335-342) writes a tenant lifecycle status
(`placing`, `placed`, ...) with `status_source: 'derived'` onto whatever
contact the placement names, with no type check - so a placement created or
reopened for a converted caseworker writes a status outside the partner
allowlist (lib/statusModel.ts:194, 204-208) into the byTypeStatus partner
partition. Name it in the follow-up.

## F17 (INFO) The existing `contact.caseworker` attribute is a different thing

A tenant's free-text `caseworker` name exists today: seeded at
app/src/lib/seed/lean.ts:121 (`caseworker: 'D. Okafor'`), read by
dashboard/src/routes/tours/TourDetail.tsx:664-666 and
dashboard/src/routes/placements/PlacementDetail.tsx:238-240 into PeopleCard
("Caseworker on file: ... - not a contact record",
dashboard/src/routes/shared/PeopleCard.tsx:433-434). B neither reads nor
writes it. The GLOSSARY "caseworker" entry should say so, so no one wires
the Possible list or the Caseworkers tab to it.

## F18 (INFO) e2e world: Renee and residue

Renee Carter (lean.ts:160-178) is a role-less partner WITH
`housingAuthority: SEED_AUTHORITY.atlanta` and a `role_title` (not `role`).
A spec that converts her mutates the shared lean world (removes her
authority) - specs should create their own contacts. Every run of
e2e/tests/flows/conversation-fact-extraction.spec.ts:315-347 leaves a new
role-less partner carrying the AI caseworker line, so Possible-list e2e
assertions must target their own rows, never a count.
