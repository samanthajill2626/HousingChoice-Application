---
id: contacts-create-does-not-require-status
title: contactsRepo.create neither requires nor defaults `status`, so the byTypeStatus invariant is enforced on update() only
type: bug
severity: low
status: open
area: app/contacts
created: 2026-08-26
refs: app/src/repos/contactsRepo.ts, app/src/lib/tables.ts, app/src/routes/contacts.ts, app/scripts/measure-unread-contact-coverage.ts
---

**Problem.** `REQUIRED_INDEX_KEY_ATTRIBUTES` (`app/src/repos/contactsRepo.ts`)
is derived from the byTypeStatus GSI spec and names `type` AND `status` as
attributes a contact may never be WITHOUT - the index is SPARSE, so a row
missing either one is not in it at all: invisible to the Unknown tab, to Today's
triage block, to `GET /api/contacts?type=`, and to `audienceResolution`, while
still reading back perfectly by id. `RequiredIndexKeyRemovalError` enforces that
on `update()`, added 2026-08-26.

`create()` does not. Its input type is
`Partial<ContactItem> & { type: ContactType }`, `status` is optional on
`ContactItem`, and `create` applies no default - it spreads the input, fills
`contactId` and `created_at`, and Puts. So `contacts.create({ type: 'unknown' })`
TYPE-CHECKS and writes a contact stranded outside the index. That is the same
failure class the guard's own message calls out, arriving through the door the
guard does not cover. `createIfAbsent(item: ContactItem)` has the identical hole
for the identical reason.

**Latent, not live.** Every one of the eight live call sites sets a real status:
`routes/contacts.ts` (`parseCreateBody` defaults it), `routes/public.ts`,
`routes/unmatchedEmail.ts`, `services/contactCapture.ts`,
`services/groupConvert.ts`, `services/groupMembers.ts`, and both seeds
(`seed/cast.ts`, `seed/performance.ts`). Enumerated 2026-08-26 during the
`feat/inbox-unread-cluster` blast-radius review (finding B6). This was reported
once during slice 1 of that branch as well; it is filed rather than mentioned a
third time.

**The complication, which is why "every row" is the wrong invariant.** POINTER
rows - the phone/email alias items written by `putPointer` and its email twin -
are raw `PutCommand`s carrying `{contactId, phone, phone_ref, phone_ref_owner}`
and NO `type` or `status`. They are UN-INDEXED ON PURPOSE: a pointer is not a
contact and must never appear in a `listByType` read, which is exactly what the
sparse index buys. `app/test/helpers/contactsPartitionFake.ts` models this as
rule 1 and filters `phone_ref`/`email_ref` items out before anything else.

So the invariant to enforce is **"every row created through `create` /
`createIfAbsent` carries both index keys"**, never "every row in the table has a
status". Any fix or audit written against the stronger statement will flag every
pointer row in the table and be abandoned as noise.

**A detector already exists**, which is what keeps this at `low`:
`app/scripts/measure-unread-contact-coverage.ts` Scans the base table and
reports rows that are "NOT deleted, type=unknown - INVISIBLE TO THE
byTypeStatus PARTITION", so an existing or future stranded row is findable
without new tooling.

**Suggested fix.** Either

1. make `status` REQUIRED in `create`'s input type (and in the `ContactItem`
   `createIfAbsent` takes for real contacts), so omitting it is a typecheck
   failure - the load-bearing-map style the rest of that branch uses; or
2. default it in `create` the way `parseCreateBody` does, per `type`.

Option 1 is preferred: a default invents a triage state nobody chose, and the
eight call sites already pass one. Whichever is taken, mirror it in the
in-memory double (`app/test/helpers/twilioWebhookHarness.ts`), which already
mirrors the `update()` guard, so no fake accepts what the repo refuses.
