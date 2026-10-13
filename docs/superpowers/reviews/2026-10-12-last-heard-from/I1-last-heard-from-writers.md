# I1 audit - who writes `contacts.last_heard_from_at`

Invariant I1 (spec 5.1): nothing but the one writer,
`contactsRepo.touchLastHeardFrom`, moves the value; the seed derivation is the
one named direct writer. Audit run by the D2 implementer on
`feat/last-heard-from` after Task 1.13 part A (tree @34530e11 plus the 1.13B
change). Line numbers are as of that tree. Re-run at the final gate step
(S10, `i1-audit-final.md`) and update if new reads appeared.

## 1. Every mention in app/src and app/scripts

Command: `git grep -n "last_heard_from_at" -- app/src app/scripts`

| hit | kind |
|---|---|
| app/src/repos/contactsRepo.ts:229 | the `ContactItem` field (type only) |
| app/src/repos/contactsRepo.ts:922 | doc comment of the `touchLastHeardFrom` interface member |
| app/src/repos/contactsRepo.ts:1950 | WRITER - `touchLastHeardFrom` (impl :1927), the `#lhf` name binding of its `SET #lhf = :at` |
| app/src/repos/contactsRepo.ts:1958 | log text inside `touchLastHeardFrom` |
| app/src/lib/seed/heardFrom.ts:1, :83 | WRITER (direct, spec-named) - the seed derivation's returned copies |
| app/src/lib/heardFrom.ts:2 | comment only (the shared normalizer) |
| app/src/routes/contacts.ts:297, :304 | REFUSAL - `SERVER_OWNED_CONTACT_FIELDS` and its comment |

No READ hits exist yet in app/src (the GET contact routes return the stored
item whole; projections arrive in S3, S6, S7). The importer, the dev fixture
seams and the live inbound paths reach the value only through
`touchLastHeardFrom`, so they do not name the attribute.

## 2. Contacts-table writers - none SETs or REMOVEs the attribute

### app/src/repos/contactsRepo.ts

`grep -n "new UpdateCommand\|new PutCommand\|new DeleteCommand"`:

- :1058 `putPointer` - Put of a `phoneref#` pointer row (conditional).
- :1077 `deletePointer` - Delete of a `phoneref#` pointer row.
- :1095 `persistPhones` - SET `phones` (and `phone`); also the write behind
  `touchPhoneLastSeen` (read, then SET phones only - not a full-item Put).
- :1131 `putEmailPointer`, :1150 `deleteEmailPointer` - `emailref#` pointer rows.
- :1168 `persistEmails` - SET `emails` (and `email`); behind `touchEmailLastSeen`.
- :1380 `create` - Put with `attribute_not_exists(contactId)`: a FRESH id only.
  It spreads its input; every caller builds explicit fields:
  routes/contacts.ts:1151 (`parseCreateBody` allowlist, :815, which now refuses
  the key - section 3), routes/public.ts:340 (named intake fields),
  routes/unmatchedEmail.ts:462 (named fields).
- :1393 `createIfAbsent` - Put with `attribute_not_exists(contactId)`: a fresh
  id only, never overwrites. Callers build stubs with named fields:
  services/contactCapture.ts:111, services/groupMembers.ts:155,
  services/groupConvert.ts:347.
- :1412 `setFlag`, :1426 `clearFlag` - SET one named flag.
- :1440 `softDelete` - SET `deleted_at`; :1456 `restore` - REMOVE `deleted_at`.
- :1577 `update` (impl :1469) - writes exactly the keys its caller passes.
  `git grep -n "\.update("` callers on the contacts repo, none passing the
  attribute: app/scripts/backfill-join-housing-authority.ts:759
  (`housingAuthority` only); routes/contacts.ts:1788 (PATCH, `parseTriageBody`
  allowlist :537, which now refuses the key); routes/dev.ts:1291 (field
  allowlisted to housingAuthority / agency / organization); routes/public.ts:399
  (`housing_fair_welcomed`); routes/webhooks/twilio.ts:1210, :1251 and
  routes/webhooks/voice.ts:727 (consent fields); services/caseworkerConversion.ts:542
  (named conversion patch), :580 (`caseworker_review`);
  services/extraction/apply.ts:500 (extraction schema fields + `_source`
  stamps; no schema names the attribute - section 1 shows no hit), :745
  (`notes`); services/statusTransition.ts:355, :622 (status fields).
- :1829 `stampGroupParticipation` - SET `group_participation_at` only.
  Callers: services/groupConvert.ts:319, :351, :471, services/groupMembers.ts:165.
- :1908 `rewriteOrgFields` (impl :1849) - org fields only; caller
  app/scripts/clean-org-names.ts:785.
- :1942 `touchLastHeardFrom` - THE writer (forward-only,
  `attribute_exists(contactId)` guarded, pointer ids skipped).

### app/src/repos/suggestionResolutionRepo.ts

- :871 `commitContactEffect` Update - SET/REMOVE of the journal plan's patch
  keys (extraction-schema targets; none is the attribute).
- :917 ConditionCheck (no write).
- :1036 Update - SET phone fields (`phones`, `phone`).
- :1047 Put / :1068 Delete - the `phoneref#` pointer row only.
- Other Put/Delete items in this file target the extraction, audit and
  activity tables.

### app/src/repos/extractionRepo.ts

- :792 ConditionCheck on the contacts table (no write); :820 a GetCommand.

### app/src/lib/import/apply.ts

- :748 SET `import_retract_started_at` (retract marker, conditional).
- :833 Delete of the import-created contact (retract; conditional on no group
  participation).
- :861 REMOVE `import_retract_started_at`.
- :1245 `upsertContact` (impl :1114) - SET-only on named import fields
  (`phone`, `phones`, names, voucher size, notes, `if_not_exists` authority /
  agency, status, opt-out, consent). A re-import neither sets nor clears the
  attribute.
- :540 the NEW stamp (Task 1.12) - through `contactsRepo.touchLastHeardFrom`
  only, after the message flush.
- Other UpdateCommands (:1374-:1420 `upsertConversation`, :1592 `upsertUnit`)
  target the conversations and units tables.

### app/scripts

- backfillConsentMethod.ts:127 - SET consent fields, conditional.
- backfill-join-housing-authority.ts:759 - `contactsRepo.update` with the one
  named field.
- clean-org-names.ts:785 - `rewriteOrgFields`.
- import-apply.ts - runs `runApply` (above).
- import-convert-groups.ts:162 - builds a contacts repo for the group
  conversion (services/groupConvert.ts: `createIfAbsent` fresh ids,
  `stampGroupParticipation`).
- backfill-unread-flag.ts:353 reads contact KEYS only; its writes (:375, :408,
  :456) target the conversations table. backfill-relay-optout-flag.ts,
  backfill-broadcast-list-partition.ts and retire-paused-tour-reminders.ts
  write the conversations, broadcasts and tourReminders tables.
- app/scripts/backfill-last-heard-from.ts (S2, not yet written) must write
  through `touchLastHeardFrom` only.

### Seed, live seed, performance seed and bulk deletes (IB8)

- app/src/lib/seed/index.ts:164 - the seed runner's full-item PutCommand loop,
  now carrying the derived value (seed/heardFrom.ts). ACCEPTED DEV-ONLY
  EXCEPTION (adjudication IB8): on a NON-resetting re-seed (`db-seed` / a bare
  `seedAll` over a live local DB) the Put REPLACES a value a live touch moved
  later, i.e. the value can move backward for a seeded contact. The spec's I1
  names the seed derivation as a direct writer, and `/__dev/reseed` and
  `npm run dev --seeded` reset the tables first.
- app/src/lib/seed/live.ts:460 - Put of the `contact-live-*` items (overwrite
  by key; live.ts seeds no messages, so no derived value).
- app/src/lib/performanceSeed.ts:208 - BatchWrite PutRequest of the
  performance world's contacts (never derived, D13).
- app/src/lib/devReset.ts:53-58 and scripts/wipe-dev-data.mjs:207 - BatchWrite
  DeleteRequests (table clears).
- No contact merge/clone writer exists, and no full-item Put of an EXISTING
  contact exists outside the seed loops above.

## 3. Client refusal (I1 at the API edge)

`last_heard_from_at` is the last entry of `SERVER_OWNED_CONTACT_FIELDS`
(app/src/routes/contacts.ts:300-305); both parsers call
`refuseServerOwnedFields` (:542 in `parseTriageBody`, :820 in
`parseCreateBody`), so a client value answers 400
`{ error: 'last_heard_from_at is set by the server, not the client' }` before
any write. Pinned in app/test/contactsCrud.test.ts, describe
`server-owned contact fields (caseworkers spec D21, D22)`:

- `POST refuses a client-sent last_heard_from_at with 400 and creates nothing`
- `PATCH refuses a client-sent last_heard_from_at with 400 and writes nothing`

Before this change both parsers silently dropped the unknown key (POST 201,
PATCH 200). The dashboard `ContactPatch` type is an explicit field list and
every `updateContact` caller builds explicit fields, so no dashboard path can
echo the value back.
