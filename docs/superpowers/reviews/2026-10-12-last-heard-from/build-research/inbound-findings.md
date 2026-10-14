# Build research - inbound area (S1, S2, S9): findings

Scope: plan v3 sections 0-3, S1 (Tasks 1.1-1.14), S2 (2.1-2.2), S9 (9.1-9.2),
section 11, checked against the live tree at 25adc1ef (code = f6aba402).
Only what the plan gets WRONG or MISSES is listed. Byte-exact anchors and the
full checklists are in the gitignored `.superpowers/sdd/worklist-inbound.md`.

## IB1 (high, breaks tsc) Task 1.10 - one of the three ingest construction sites passes a Pick, not a full repo

Task 1.10 widens `InboundEmailDeps.contacts` (`app/src/services/inboundEmail.ts:212`)
with `findByPhone` and `touchLastHeardFrom` and says the three construction
sites pass a full repo. Two do (`app/src/worker.ts:211,219`;
`app/src/routes/webhooks/ses.ts:93,110`). The third does not:
`app/src/routes/unmatchedEmail.ts:81-84` types `contactsRepo` as a five-member
`Pick` (`getById | findByEmail | addEmail | create | touchEmailLastSeen`), and
`:188` / `:216` pass that value to `ingestInboundEmail`. After the widening
this is a type error. Fix: add `'findByPhone' | 'touchLastHeardFrom'` to that
Pick, and add both members to the test fake that satisfies it
(`app/test/unmatchedEmailRoutes.test.ts:129-136` `MemoryContacts`,
`:138-173` `createMemoryContacts`, passed at `:200`). Stubs suffice there: the
route suite injects `reingest`, so the ingest never runs.
`app/src/routes/api.ts:1286` already passes the full shared repo.

## IB2 (high, existing test goes red) Task 1.3 - the invariant-13.2 exact repo-call list

`app/test/groupTextWebhook.test.ts:137-155` asserts the EXACT ordered repo-call
sequence of a plain 1:1 inbound from a known contact through a Proxy spy
(`:103-121`). Task 1.3 adds a `contacts.touchLastHeardFrom` call after the
touchPhoneLastSeen block, so the list gains one entry and `toEqual` fails. No
other call is added on that path (the fresh branch reuses `conversation`; the
captured contact is the lookup cache). The plan does not mention this test.
Fix (knowing rewrite, same commit as Task 1.3): insert
`'contacts.touchLastHeardFrom'` after `'contacts.touchPhoneLastSeen'` (`:150`),
with a comment that the touch is 1:1-path work, not group-branch I/O, so 13.2's
intent still holds.

## IB3 (high, existing test goes red) Task 1.12 - importOrgNames expects one contact UpdateCommand per contact

`app/test/importOrgNames.test.ts:77-86` (`contactUpdate`) filters every
`UpdateCommand` whose `Key.contactId` is the phone's contact and expects
EXACTLY one. Task 1.12's stamp sends a second `UpdateCommand` (Key
`{ contactId }`, `SET #lhf = :at`) for every contact with an attributed
inbound. `PHONES.caseworker` has one (fixture AC007,
`app/test/importFixture.ts:90`), so the assertions at `:110`, `:153` (loop),
`:174` and `:180` fail. `PHONES.conflictResolved` (`:99`) has no traffic and
is unaffected; the dry-run check at `:146` is unaffected. Fix in Task 1.12:
narrow the helper to the upsert, for example skip an UpdateCommand whose
`UpdateExpression` is `SET #lhf = :at`.

## IB4 (low, compile trap) Task 1.13A - GetCommand is already imported

RED 2 says "add `GetCommand` to the file's lib-dynamodb import" for
`app/test/seedProfile.integration.test.ts`. It is already imported there (`:13`)
and used (`:122`, `:130`). Adding it again is a duplicate-identifier error.

## IB5 (low) Task 1.8 - four RED cases omit `seedRelay(world)`

The new describe builds `world = createFakeWorld()` per case. Case 1 seeds the
relay explicitly. Cases 2, 3, 4 (`non_member` live / soft-deleted /
unmatched) and 7 (case 2 redelivered) do not. Without a seeded group, To=POOL
resolves no relay and the call goes to founder triage
(`app/src/routes/webhooks/voice.ts:594-633`), where the default harness has no
verified holder, so no row is written. Case 2 then fails for the wrong reason
and case 4 passes vacuously while testing the wrong path. The existing
non-member tests seed it (`app/test/voiceWebhook.test.ts:489`, `:517`).
Each of those cases needs `seedRelay(world)` (default roster ALICE + BOB;
CAROL is the non-member).

## IB6 (low) Task 2.1 Half 1 case 6 - the expected count is wrong

"All six contacts planned; `unattributed` 2". The listed rows attribute to FOUR
distinct contacts: `c-a`, `c-p`, `c-z` (twice, via the non-member key and via
the keyless external phone), and `c-ext`. That is 5 attributed rows and 2
unattributed. A builder who writes `latest.size === 6` writes a test the
correct planner fails. Expect `latest.size` 4.

## IB7 (low) Task 1.1 - the implementation anchor is off by one line

The plan says `rewriteOrgFields` closes with `},` at `contactsRepo.ts:1913`
and the object's `};` is `:1914`. In the live tree they are `:1914` and
`:1915`, and the function's `}` is `:1916`. The text anchors are right; only
the line numbers drift.

## IB8 (low) Task 1.13B - the I1 audit's writer list misses the seed and bulk writers

Part B item 2 lists the contacts-table writer files to audit. It does not name
these contacts-table writers. None of them SETs or REMOVEs the attribute, but
an audit that claims completeness should name them:

- `app/src/lib/seed/index.ts:153`: a full-item `PutCommand` per contact. On a
  re-run of `db-seed` / `seedAll` that does NOT reset first, it replaces a
  live-touched `last_heard_from_at` with the derived value. That can move the
  value backward for a seeded contact. This is dev-only:
  - `/__dev/reseed` and `npm run dev -- --seeded` reset first (`scripts/dev.mjs:303-316`)
  - spec I1 already names the seed derivation as a direct writer

  Record it as the accepted exception.
- `app/src/lib/seed/live.ts:458-461`: Puts `contact-live-*` items.
- `app/src/lib/performanceSeed.ts:208`, `:219`: `BatchWrite` `PutRequest`s for the performance world.
- `app/src/lib/devReset.ts:58`, `scripts/wipe-dev-data.mjs:207`: delete requests.
- Fresh-id-only creators:
  - `createIfAbsent` callers `app/src/services/contactCapture.ts:111`,
    `app/src/services/groupMembers.ts:155`, `app/src/services/groupConvert.ts:347`
  - `stampGroupParticipation` callers `groupConvert.ts:319`, `:351`
- `app/scripts/import-convert-groups.ts:162`, which reaches `groupConvert`.

The S10 final audit (`i1-audit-final.md`) should carry the same list.
