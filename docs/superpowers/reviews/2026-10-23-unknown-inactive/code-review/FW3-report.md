# Fix wave 3 report - feat/unknown-inactive (code review R3, FW3-1 .. FW3-2)

Base for this wave: d71b776f (R3 report + adjudications). Commits, in order:

- 0345be47 FW3-1 fix(contact) - the edit form's 409 contact_type_changed makes
  the page re-read the contact
- 0f1b973f FW3-2 docs(status-model,glossary,today) - UNKNOWN threads; the
  importer beside the second number
- d7abe437 FW3-1 test(contact) - the FW2-2 case's comment (comment only)

Gates run by this wave (the orchestrator re-runs the battery):
ContactDetail.test.tsx 155/155 and ContactEditForm.test.tsx 119/119;
typecheck exit 0 after FW3-1; dashboard workspace `npx vitest run` 266 files,
5492 passed, exit 0 (battery-3 5487; +5 = this wave's 1 + 4 cases);
app/test/todayApi.test.ts 70/70, exit 0, no `[dynamoAdmin]` line, no AWS_
variable exported. eslint on the 5 touched TS/TSX files (ContactEditForm.tsx,
ContactDetail.tsx, ContactDetail.test.tsx, ContactEditForm.test.tsx,
app/src/routes/today.ts): exit 0, no output. Every added line ASCII (diff
against 916258ae). No root `npm test`, no e2e;
e2e/tests/dashboard-next/unknown-inactive.spec.ts never opens the edit form
and no e2e drives a concurrent re-type.

## FW3-1 (R3-1) - the form's 409 re-reads the contact on the page

Changed:
- dashboard/src/routes/contact/ContactEditForm.tsx:132-135 optional
  `onStale?: () => void` prop (docblocked); :143-149 destructured; :621
  `onStale?.()` in the `409 contact_type_changed` arm only, after the copy and
  `setRetypedUnderForm(true)` (both kept, copy text unchanged).
- dashboard/src/routes/contact/ContactDetail.tsx:935-948
  `rereadRetypedContact` - the header 409's own read moved verbatim into one
  helper: `getContact(contact.contactId, undefined, { consistent: true })` ->
  `setContact`, `.catch` best-effort. The header's 409 calls it (:990); the
  form gets it as `onStale` (:1384). One body for both 409 paths, so "exactly
  as the header's" holds by construction; the header's behavior is unchanged
  and its case (ContactDetail.test.tsx:573-597) passes as written. Only the
  catch comment changed ("each 409's copy already says what to do": the
  form's copy says Reload, the header's says try again). No new effect.
- Comments R3 listed as made false, now true: ContactEditForm.tsx:109-124
  (the copy's docblock: Save off for this opening, `onStale`, the page's
  consistent re-read, the reopen built from the stored contact, the copy's
  reload when that read fails), :339-343, :614-618; ContactEditForm.test.tsx
  :1946-1949 (d7abe437).

RED (real code, before the change):
- dashboard/src/routes/contact/ContactDetail.test.tsx:600-666 (new): an
  Inactive unknown contact; Edit contact details, Change type -> Tenant,
  Searching, Save; the PATCH resolves, the status write answers 409; then
  the page re-read must happen. Failed at :641 with
  `AssertionError: expected 1 to be greater than 1` (getContact called once,
  the initial load) - every assertion before it passed (the copy, the
  `{ type: 'tenant' }` PATCH, the status write with `expectedType: 'tenant'`).
  GREEN: getContact last called `('u9', undefined, { consistent: true })`; the
  header pill reads "Contact status: Interested" and no "Type unknown" card;
  the open form keeps the copy with Save disabled; Cancel, reopen (no event
  at any point): the Status options equal `statusOptionsFor('landlord')`,
  value `interested`, Save enabled; one PATCH and one status write in all.
- dashboard/src/routes/contact/ContactEditForm.test.tsx:2033-2074 (new
  it.each): the 409 contact_type_changed row failed `expected "spy" to be
  called 1 times, but got 0 times`. The three "not called" rows (status
  write 400 bad_transition, field PATCH 409 contact_changed, offline) passed
  on unchanged code and pin that onStale is that 409's only.

## FW3-2 (R3-3, R3-4) - docs and the today.ts comment

- documentation/STATUS-MODEL.md:282-294 (5b): an Inactive unknown contact's
  or team member's UNKNOWN threads do not show in Needs you now (those unread
  texts show only in the inbox); a typed thread such a contact kept from an
  earlier type still feeds Unreplied - a re-type to unknown or team member
  re-types none of the contact's threads. The unknown-thread cause for an
  Inactive tenant's or partner's row now names the importer (every imported
  one-to-one thread is minted unknown, the filed issue cited) before the
  second number.
- documentation/GLOSSARY.md:717-730 (Inactive entry): the same two changes.
- app/src/routes/today.ts:761-770 (skip comment): the importer cause
  (lib/import/apply.ts upsertConversation; the issue slug) beside the second
  number. Comment only; the skip at :773-781 is untouched.
- docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md: NOT
  edited (adjudication, AR14).

Beyond the named lines (same claim class, recorded as a choice):
- GLOSSARY.md:702 - the flyer sign-up entry's parenthetical (branch-authored)
  said an Inactive unknown contact's "thread then shows only in the inbox";
  now "its unknown thread shows only in the inbox". One line.
- The re-type wording says "through the API or an import", not the API
  alone: the importer can write team_member or unknown onto an existing
  contact (VALID_TYPES, app/src/lib/import/apply.ts:264-270, unless
  type_source is manual) and its thread upsert is `if_not_exists` on type
  (:1284-1290), so it re-types no existing thread either; the contacts PATCH
  flips only unknown_1to1 threads and has no unknown/team_member arm
  (app/src/routes/contacts.ts:541-547, :2149-2152). "The Edit contact details
  picker offers neither" is KindPicker.tsx:39.

## Tree vs adjudication

Nothing contradicted it: the header's 409 read, the form's 409 arm, the
`onSaved`-after-both-writes order and apply.ts:1284 are where and what the
adjudication and R3 say.

## Residuals (recorded, not built)

- The re-read is best-effort, as the header's: if it fails, a reopen is built
  from the stale contact again with Save on, and R2-6's overwrite is one
  redone draft away; the copy's reload is then the only safe path.
- The re-read is outside useContact's latest-wins sequence
  (useContact.ts:74-87): a contact.updated re-read in flight at the same time
  can be answered first and then overwritten by this older consistent read
  until the next event. The header's 409 has had the same exposure since
  FW1-1; this wave adds the form's 409 to it. Narrow (both reads consistent,
  both after the re-type).
- R3's "secondary" (the PATCH's saved fields not shown after the 409) is
  covered by the same re-read but not separately pinned: the test's re-read
  contact differs in type and status, not in a saved name.
- R3-2 (the PATCH's own 409 contact_changed: generic copy, Save on) is
  untouched by design (RECORD, planner); the form row at :2051 pins that
  onStale does not fire there.
- Line citations into ContactDetail.tsx, ContactEditForm.tsx and today.ts in
  older records and docs/issues files drift with these edits; AR14 keeps them
  unedited.
