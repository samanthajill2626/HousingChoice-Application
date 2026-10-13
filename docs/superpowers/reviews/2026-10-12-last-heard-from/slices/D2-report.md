# D2 - S1 Tasks 1.7-1.14: decisions record

Dispatch D2 of the feat/last-heard-from build (implementer, 2026-10-13). Scope:
the three voice inbound paths, the inbound email path, the two dev fixture
seams, the importer stamp, the seed derivation, the I1 refusal + writer audit,
and the dashboard `Contact` type. Plan:
`docs/superpowers/plans/2026-10-12-last-heard-from.md` (S1 Tasks 1.7-1.14).
Binding corrections applied: IB1 (1.10), IB3 (1.12), IB4 (1.13A), IB5 (1.8),
IB8 (1.13B record).

## Commits

- f43ccd92 Task 1.7 - path 5, founder bridge call.
- d93fb8ed Task 1.8 - path 6, refused masked relay call.
- fb27b095 Task 1.9 - path 7, bridged masked relay call.
- e9912093 Task 1.10 - path 8, inbound email, plus IB1.
- d918e7c6 Task 1.11 - the two dev fixture seams.
- cb797428 Task 1.12 - the importer stamp, plus IB3.
- 34530e11 Task 1.13 part A - seed derivation.
- 0f313be4 Task 1.13 part B - server-owned refusal + the I1 writer audit
  (`I1-last-heard-from-writers.md` in this folder).
- 9d8d17be Task 1.14 - dashboard `Contact.last_heard_from_at`.

Every task had at least one case RED for the stated reason (no touch recorded,
the spy never called, a 500 from un-injected repos, an undefined report field,
a missing module, 201/200 instead of 400, TS2344 on the type) before GREEN.
Root `npm run typecheck` exited 0 after every commit. A final run of the 13 app
test files this dispatch touched or relies on passed 362/362 at 9d8d17be.

## Touch sites (as committed)

- Path 5: app/src/routes/webhooks/voice.ts:816 (inside the append's try, after
  the deduped block); the captured caller is kept at :749-751 and cached under
  `From` for the lookup (:831).
- Path 6: voice.ts:1095 (refusal branch, every reason, fresh and deduped).
- Path 7: voice.ts:1204 (bridge).
- Path 8: app/src/services/inboundEmail.ts:815 (the winner's side effects only;
  the deduped early return never reaches it; an `email_new_address` row is
  never attributed).
- Seams: app/src/routes/dev.ts:818 helper `touchFixtureHeardFrom`, called at
  :908 (transcript fixture), :1132 (message fixture append branch), :1169
  (direct-Put branch).
- Importer: app/src/lib/import/apply.ts:533 (after the message flush; a dry run
  only plans).
- Seed: app/src/lib/seed/index.ts:151 calls `deriveSeedHeardFrom`
  (app/src/lib/seed/heardFrom.ts:59) after the cast/matrix/history merge,
  before the Put loop; returns copies.

## Decisions and divergences

1. Masked-path catch logs the error NAME only (voice.ts:1132 path 6, :1229
   path 7), not `err`. The plan logs `err`. Reason: the existing voiceWebhook
   test "persists phone-only metadata and still returns refusal TwiML when
   contact lookup fails" pins that a phone lookup's error text never reaches
   the logs on the masked path (the path's own non-member lookup logs nothing
   of the error). The touch's attribution re-runs findByPhone, so the plan's
   `err` field leaked the message and failed that pin. Path 7 follows path 6
   for the same masked-path reason; path 5 keeps `err` as planned. The
   contract log line text is unchanged on every path. A reviewer preferring
   `err` must re-adjudicate the PII pin first.
2. The plan's "every `contact-mx-*` contact" (1.13A) names ids that do not
   exist: matrix contacts are `tenant-mx-*` / `landlord-mx-*`. The test
   (app/test/seedHeardFrom.test.ts) takes the ids from the matrix's own item
   set. Every exact lean and cast value in the plan matched on the first run.
3. `SERVER_OWNED_CONTACT_FIELDS` (app/src/routes/contacts.ts:300-305) is now a
   multi-line array; same tuple, `last_heard_from_at` last.
4. IB1: the unmatched-email router's `contactsRepo` Pick
   (app/src/routes/unmatchedEmail.ts:83) widens with `findByPhone` and
   `touchLastHeardFrom`; the route test's `MemoryContacts` fake gains inert
   stubs. Without it `npm run typecheck` fails.
5. IB3: app/test/importOrgNames.test.ts `contactUpdate` skips the stamp's
   UpdateCommand by its exact UpdateExpression `SET #lhf = :at`. Proven
   necessary: without it 3 of that file's 9 cases fail.
6. IB4 honored (no second `GetCommand` import); IB5 honored (cases 2, 3, 4, 7
   seed the relay first). No `getByProviderSid` read was added on any voice
   path.
7. IB8: the I1 audit names the seed / live-seed / performance-seed Puts, the
   bulk deletes and the fresh-id-only creators, and records the seed runner's
   full Put (app/src/lib/seed/index.ts:164) moving a live-touched value
   backward on a NON-resetting re-seed as the accepted dev-only exception.
8. 1.13A's integration case sits after the holder-stamp case and before the
   full-profile case (the plan said "after :116"; lines had moved).

## Open notes for later slices

- The I1 audit found no READ of the attribute in app/src yet; the S10 final
  audit adds the S3/S6/S7 projections and the S2 backfill (which must write
  through `touchLastHeardFrom` only).
- The two fixture seams now move lean values forward when an e2e plants a
  newer inbound through them - S8 specs asserting lean values reseed first (I4).
