# Design review R2 - reviewer A (adversarial) - branch B (caseworkers), revision 10

- Date: 2026-10-07
- Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  at 4884aa91 (revision 10).
- Read with: `adjudications.md`, `R1-reviewer-b.md`, and
  `git diff 2ff69142 4884aa91`.
- Tree: `W:/tmp/caseworkers`. Read-only; nothing run. Code is cited
  `file:line` as read in this tree.

Summary: 11 findings (2 HIGH, 5 MEDIUM, 4 LOW) and 1 line of concessions.
Most findings are in revision 10's new material: the conversion inside the
PATCH, its write order and repair, participant matching, carrying off-list
text into `organization`, and superseding every suggestion. Finding 6
contests a rejection.

---

## 1. [HIGH] The conversion overwrites an organization staff picked, including one picked in the same save

**What is wrong.** D19 recomputes `organization` on every conversion: agency
text, then housing authority text, then "stays absent". It never reads an
organization the contact already holds or that the request is setting.

- **Existing partners.** D17 lets staff set Organization on ANY partner page.
  Every imported caseworker is a role-less partner (D19's own population). So
  this sequence is the normal one:
  1. staff set Organization on the partner page;
  2. later they press Make caseworker (or the Caseworker choice).
  - With a housing authority on the record, step 2 replaces the staff pick with
    that authority. On the lean partner, Renee
    (`app/src/lib/seed/lean.ts:170-176`), Atlanta Housing Authority wins.
  - With neither value, step 2 REMOVEs the staff pick ("stays absent").
- **Same-save picks.** The edit form swaps its type-specific fields on the LIVE
  kind (`dashboard/src/routes/contact/ContactEditForm.tsx:157-166`). Choosing
  Caseworker on a tenant shows the partner fields, so B's Organization picker
  appears in the same dialog.
  - The natural single save is `{type: partner, role: Caseworker,
    organization: X}`.
  - The PATCH then runs the conversion, which derives `organization` from
    agency or housing authority and discards X.
- D17's rule that a contact "keeps its organization as data" when re-typed away
  from partner is also undone: converting it back recomputes the value.

**Implies.** The core #19 fact ("each caseworker belongs to an organization")
comes out wrong exactly when staff did the right thing. Fix the order:
1. an `organization` in the request wins;
2. else a stored `organization` is kept;
3. else derive it.

## 2. [MEDIUM] "Make caseworker again repairs it" is not what the mechanism does

**What is wrong.** D19 says a failure after step 1 (the commit point) is
repaired by pressing Make caseworker again, which re-runs steps 2-4. Four
problems:

- **(a) Step 3 is keyed on the wrong type.** D21 re-types threads whose type is
  "the contact's OLD type or `unknown_1to1`". On the re-run the stored type is
  already `partner`, so "old type" is partner. The `tenant_1to1` or
  `landlord_1to1` threads the failed run left are never re-typed, which is the
  very failure the repair exists for.
  - The old-type limit is now vestigial: revision 10 decides ownership by
    participant, so every 1:1 thread the contact owns could be re-typed.
- **(b) The removed values are lost.** They ride the step-4 audit. On a re-run
  `housingAuthority` and `agency` are already gone, so the audit cannot carry
  them. The "put back by hand" promise holds only if step 4 succeeds the first
  time.
- **(c) No button.** The Possible caseworkers list shows only contacts "not yet
  caseworkers" (D19), and the partner page has no Make caseworker. A converted
  contact can be repaired only through the API.
- **(d) The PATCH path cannot repair itself.** The Caseworker choice and Mark
  as Caseworker run inside the PATCH. Saving again finds the contact "already
  that", so the conversion does not run (D16).

**Implies.** Do all of the following, or state the repair as API-only and
accept the loss:
- re-type every 1:1 thread the contact owns that is not already
  `partner_1to1`;
- capture the removed values atomically with step 1, for example a
  `pre_conversion` attribute in the same write, or the audit written first;
- give staff a repair affordance.

## 3. [MEDIUM] Participant matching cannot see a shared phone; "a household phone is left alone" does not hold

**What is wrong.** D21 says "a thread shared with another contact (a household
phone) is left alone whatever its type". The mechanism is "participant
`contactId` is the contact, or none and the phone's owning contact by lookup is
the contact". It cannot detect sharing:

- A 1:1 thread carries exactly ONE participant, written once by the first
  claimer (`app/src/repos/conversationsRepo.ts:174-179`, `setParticipantsIfAbsent`).
- When the converted contact X is that participant, a phone that tenant Y also
  holds is re-typed to `partner_1to1`.
- The fallback lookup is non-deterministic for exactly this case: `findByPhone`
  returns "the FIRST item the GSI yields (arbitrary order)" for duplicate
  phones (`app/src/repos/contactsRepo.ts:1069-1083`).
- The conversion's refusals check only X's tours and placements. Y's open tour
  then loses its reminders (`app/src/jobs/tourReminders.ts:1092-1099`), which is
  R1-F2's damage on the guarded path.

**Implies.** "Shared" must mean that ANY other contact holds the phone or
address. That needs a byPhone Query over all items, pointer rows resolved, not
`findByPhone`. Otherwise drop the sentence and accept the risk.

## 4. [MEDIUM] Superseding ALL pending suggestions contradicts D16's `accepted` verdict and bypasses the type-suggestion protocol

**What is wrong.**
- D16 changes the canonicalizer so that Mark as Caseworker (or the Caseworker
  choice) on an unknown contact with a pending `partner` type suggestion
  records `accepted`.
- D19 step 2 supersedes every pending suggestion, "all fields", with "the
  verdict stamps the PATCH writes when it supersedes". That is
  `superseded_by_human_edit`.
- The pending `type` suggestion is one of them. D16 says `accepted`, D19 says
  `superseded`.
- Today the type suggestion is removed only by the revision-guarded drain
  (`app/src/routes/contacts.ts:1712-1794`, `deleteTypeSuggestionIfCurrentAtContactRevision`
  :1747), which exists so that a replacement suggestion racing the contact
  write is not lost. A blanket supersede in step 2 bypasses that protocol.

**Implies.** Exclude `type` from step 2, and resolve it through the existing
guarded drain with `canonicalSuggestedContactKind(updated)`. Order step 2
after that drain.

## 5. [MEDIUM] The rules for "the PATCH runs the conversion" are missing for everything else in the same request

**What is wrong.** The conversion now runs inside a contacts PATCH. The edit
form's PATCH carries every changed field, not only type and role
(`dashboard/src/routes/contact/ContactEditForm.tsx:276-330`). The spec does not
say:

- what happens to a `status` in the body. Non-tenant status rides the plain
  PATCH (`ContactEditForm.tsx:287`), and once the live kind is partner the form
  sends it. The conversion writes `active`.
- what happens to `housingAuthority` or `agency` in the body. The conversion
  REMOVEs or clears them.
- what happens to `organization` in the body (finding 1).
- whether the PATCH's own post-write pipeline also runs. The PATCH already does
  the provenance clear, the type drain, the unknown flip, the `contact_updated`
  audit, the milestone, events and vocabulary (`app/src/routes/contacts.ts:1600-1960`).
  The conversion's step 4 produces the same items, so either the conversion
  replaces that tail or there is a double audit and double events.
- what the "one conditional write" of step 1 is conditional on. It is
  unnamed, and the PATCH may also carry the `staff_notes` stale guard
  (:1647-1651).
- whether a 409 refusal throws away the name and notes edits in the same save.

**Implies.** State that the conversion owns the whole write: request fields are
merged under the conversion's rules, and the PATCH's own tail is skipped. Name
the write condition.

## 6. [MEDIUM] Contest: the reasons given for rejecting admin-only tenant rows do not hold for two of the three paths

**Adjudication.** B-F1 was rejected because "the confirm plus the recoverable
audit cover it".

**Why that fails.**
- The confirm exists only on the Possible caseworkers list (D19).
- The edit form's Caseworker choice and the one-click Mark as Caseworker run
  the SAME destructive conversion with no confirm. That conversion REMOVEs the
  housing authority, clears agency, supersedes every suggestion, re-types
  threads and stamps `type_source` so a re-import cannot repair it.
  - Mark as Caseworker is one click on an Unknown page that may carry an
    imported authority.
- The audit is the last step and is lost on a partial failure (finding 2b).

I do not ask for admin-only. Either:
- put the same confirm on every path that converts a contact holding a housing
  authority, agency or pending suggestions; or
- revise the rejection's reasoning to rest on something the mechanism actually
  delivers.

## 7. [MEDIUM] Revision 10 silently widens the relationship signal to every partition, and the e2e lean world now differs by spec order

**What is wrong.**
- Revision 9 limited the relationship signal to tenants. Revision 10 reads
  "contacts linked as another contact's caseworker relationship", from all
  three partitions. Neither the adjudication nor the diff note explains the
  widening.
- `e2e/tests/dashboard-next/contact-create.spec.ts:185-200` adds a "Caseworker"
  relationship pointing at the seeded landlord Marcus Bell
  (`contact-landlord-0001`) on every run.
- So after that spec runs, Marcus Bell is in the lane's Possible caseworkers
  list. Before it runs, he is not.
- Any Possible-list e2e that pins its rows (D19 already says "e2e expectations
  include" Renee) now depends on run order.
- A landlord of record listed this way can never be converted (409
  `caseworker_landlord_of_record`). He stays until someone dismisses him.

**Implies.** Restore the tenant-only signal, or state the widening and make
the spec world deterministic: the spec dismisses its own link, or uses a
run-unique target.

## 8. [LOW] "The other provenance stamps the PATCH clears on a type change" is the empty set

**What is wrong.**
- The PATCH clears `<field>_source` only for CHANGED provenance fields
  (`app/src/routes/contacts.ts:1609-1612`; `PROVENANCE_FIELDS` =
  the extractable fields plus `address`, `app/src/services/extraction/schema.ts:24-40`).
- `type` is not one of them, so a type change clears none.
- Step 1 therefore says nothing about `voucherSize_source`, `pets_source`,
  `address_source` and the rest. State which stamps stay on the converted
  partner.

## 9. [LOW] The off-list carry has an agency-first inversion and skips D13's limits

**What is wrong.**
- **Agency-first is inverted for off-list agencies.** "The first that resolves"
  means an OFF-list agency (the employer, by D19's own reasoning) loses to an
  ON-list housing authority. The agency text is then cleared and survives only
  in the audit (finding 2b).
- **D13 limits are skipped.** The carried text is pre-A free text. Nothing
  applies D13's limits: 120 characters, no control or invisible characters, not
  empty after normalization.
  - The carried value then becomes an organization chip on the Caseworkers tab.
  - It also becomes a "Not on the list" row.
  - The D17 exception should state the limits it skips, or apply them
    (truncate, or refuse to carry).

## 10. [LOW] The PATCH and the route accept different inputs, and "already a caseworker" is undefined

**What is wrong.**
- **Deleted contacts.** The route answers 404 for a deleted contact. The PATCH
  handler has no deleted check (`app/src/routes/contacts.ts:1449-1475`), so the
  same conversion runs on a deleted contact through the PATCH. Partly
  UNVERIFIED: the dashboard may not offer edit on a deleted contact.
- **"Already a caseworker" is undefined.** The route's repair branch triggers on
  "already a caseworker"; the PATCH triggers on role EXACTLY `Caseworker`. For
  a partner with role "Case worker" (on the tab via `isCaseworkerRole`), does
  `make` run the full conversion with its refusals, or only steps 2-4? Pick one
  definition.

## 11. [LOW] An interactive save now pays for a full units scan

**What is wrong.**
- The roster refusal is "a unit scan - no index" (D19).
- With the conversion inside the contacts PATCH, every Caseworker save and
  every one-click Mark as Caseworker scans every unit before answering.
- The spec states the scan's cost only for the possible-caseworkers read
  (section 12). Add this path, or bound it.

## 12. [LOW] Concessions on the other two rejections

- **Send-time re-type: conceded.** Imported tenants already receive shares on
  `unknown_1to1` threads (`app/src/lib/import/apply.ts:1208`;
  `conversationsRepo.ts:1252-1264`), so it is pre-existing.
- **Tour and placement guards: conceded as out of B.** The section 12 issue
  should say that a tour reopened after a conversion has NO reminder thread:
  the conversion re-typed it, and reminders want `tenant_1to1`
  (`app/src/jobs/tourReminders.ts:1092-1093`). That is the concrete harm, not
  only "state comes back".

---

## Checked and correct in revision 10

- **Generic type change keeps today's thread rule.** It matches
  `app/src/routes/contacts.ts:1876-1888` (primary phone plus emails, flip
  `unknown_1to1` only).
- **Header facts for `tenant` and `unknown`.** Consistent with
  `dashboard/src/routes/contact/ContactDetail.tsx:563-573` (team_member maps to
  the tenant kind, so keying on `type` is right).
- **Contact create stays a plain save.** POST refuses an existing phone or email
  with 409 `contact_exists` (`app/src/routes/contacts.ts:1070-1086`), so a new
  caseworker never inherits a thread.
- **Kind-change and usage text.** D10, D17 and section 6 now agree that
  organization holders do not block a kind change.
