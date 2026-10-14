# I1 audit (final) - who writes `contacts.last_heard_from_at`

Invariant I1 (spec 5.1, 6): the value never moves backward; the ONE live
writer is `contactsRepo.touchLastHeardFrom`; the seed derivation is the one
spec-named direct writer. Re-run by the build orchestrator on the FINAL tree
(feat/last-heard-from @b8dc2181, code identical to d902b515; 0 behind main
@16ca96cc). The S1-time audit is
`docs/superpowers/reviews/2026-10-12-last-heard-from/I1-last-heard-from-writers.md`.

## 1. Every mention in app/src and app/scripts

`git grep -n "last_heard_from_at" -- app/src app/scripts`:

| hit | kind |
|---|---|
| app/src/repos/contactsRepo.ts:229 | `ContactItem` field (type) |
| app/src/repos/contactsRepo.ts:375 | `RecipientDisplay` field (type, S3 projection) |
| app/src/repos/contactsRepo.ts:935 | doc comment of `touchLastHeardFrom` |
| app/src/repos/contactsRepo.ts:1051 | READ - `RECIPIENT_PROJECTION` name binding (`#lastHeardFromAt`) |
| app/src/repos/contactsRepo.ts:1972, :1980 | WRITER - `touchLastHeardFrom` (`SET #lhf = :at`, condition `attribute_exists(contactId) AND (attribute_not_exists(#lhf) OR #lhf < :at)`) and its debug log |
| app/src/lib/seed/heardFrom.ts:1, :83 | WRITER (direct, spec-named) - the seed derivation's returned copies |
| app/src/lib/heardFrom.ts:2 | comment (the shared normalizer) |
| app/scripts/backfill-last-heard-from.ts:1 | comment (the backfill writes through `touchLastHeardFrom`) |
| app/src/repos/listingSendsRepo.ts:148 | comment on the wire field |
| app/src/routes/contacts.ts:296, :303 | REFUSAL - `SERVER_OWNED_CONTACT_FIELDS` (POST/PATCH answer 400) |
| app/src/routes/contacts.ts:1224, :1263, :1271 | READ - listings-sent projection |
| app/src/routes/units.ts:261, :272 | READ - recipients projection |
| app/src/routes/broadcasts.ts:482, :529 | READ - preview decline labels, `resolveSeeds` projection |
| app/src/services/audienceResolution.ts:56, :182 | READ - resolver projection |
| app/src/services/followUps.ts:157 | READ - the follow-ups builder |

Every hit added after S1 (S3, S6, S7 and the review fix waves) is a READ or a
projection. Nothing but the writer names the attribute in a write expression.

## 2. Contacts-table writers on the final tree - none SETs or REMOVEs it

`app/src/repos/contactsRepo.ts`, every `new PutCommand` / `UpdateCommand` /
`DeleteCommand` (no BatchWrite / TransactWrite in the repo):

| line | writer | expression / guard |
|---|---|---|
| :1077 | `putPointer` | Put of a `phoneref#` pointer row, `attribute_not_exists(contactId)` |
| :1096 | `deletePointer` | Delete of a `phoneref#` pointer row |
| :1114 | `persistPhones` (behind `touchPhoneLastSeen`) | SET phones / phone, `attribute_exists(contactId)` |
| :1150, :1169 | `putEmailPointer`, `deleteEmailPointer` | `emailref#` pointer rows |
| :1187 | `persistEmails` (behind `touchEmailLastSeen`) | SET emails / email, `attribute_exists(contactId)` |
| :1402 | `create` | Put, `attribute_not_exists(contactId)` (fresh id; callers pass allowlisted fields; the POST allowlist refuses the key) |
| :1415 | `createIfAbsent` | Put, `attribute_not_exists(contactId)` (fresh-id stubs: contactCapture, groupMembers, groupConvert) |
| :1434, :1448 | `setFlag`, `clearFlag` | SET one named flag |
| :1462, :1478 | `softDelete`, `restore` | SET / REMOVE `deleted_at` only |
| :1599 | `update` | SETs/REMOVEs exactly the caller's keys; no caller passes the attribute (S1 audit section 2 caller list; `git diff main...HEAD -- app/src app/scripts` adds no `.update(` caller on the contacts repo); the PATCH allowlist refuses the key |
| :1851 | `stampGroupParticipation` | SET `group_participation_at` only |
| :1930 | `rewriteOrgFields` | SET/REMOVE housingAuthority / agency / organization only |
| :1964 | `touchLastHeardFrom` | THE writer (forward-only, normalized, pointer ids skipped) |

Writers outside the repo (unchanged since the S1 audit): the importer
(`app/src/lib/import/apply.ts` UpdateCommands at :748, :861, :1245, :1374,
:1389, :1404, :1420 write named import fields; its last-heard-from stamp goes
through `contactsRepo.touchLastHeardFrom`); the seed / live-seed /
performance-seed Puts and the dev reset / wipe deletes (S1 audit, IB8).

New write commands the branch adds anywhere in app/src: three -
`touchLastHeardFrom` (contacts) and `setDeclined` / `clearDeclined`
(`listing_sends`, not the contacts table).

## 3. Accepted exception (unchanged, dev only)

The seed runner's full-item Put (`app/src/lib/seed/index.ts`, `seedAll`'s Put
loop) rewrites seeded contacts with the DERIVED value, so a NON-resetting
re-seed can move a live-touched value backward for a seeded contact
(`/__dev/reseed` and `npm run dev -- --seeded` reset first). Recorded at build
research (IB8) and in the S1 audit.

Result: I1 holds on the final tree.
