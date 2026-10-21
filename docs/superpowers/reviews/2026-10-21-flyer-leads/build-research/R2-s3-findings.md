# R2 delta findings - S3 (plan section 7, Tasks 3.1-3.5)

Reader: R2 (build research, phase 1). Live tree: W:\tmp\flyer-leads
(feat/flyer-leads @031a46d6; app/dashboard/e2e/scripts/fake-twilio identical
to b7959e2a - `git diff --stat b7959e2a HEAD` on those dirs is empty).
Rules: .superpowers/sdd/research/RESEARCH-RULES.md. Reference (importer lists,
caller traces, byte-exact regions): .superpowers/sdd/research/R2-s3-reference.md.

Counts: BLOCKER 0, MAJOR 0, MINOR 1, NOTE 5.

What was checked and holds (no finding):
- Anchors: all 58 single-line anchors S3 quotes occur exactly once in their
  named files (`grep -cF` = 1 each), and every multi-line anchor block matches
  the live text (shareLedger.ts :24, :40-41, :74, :106-120, :17, :172-195;
  shareAttemptOrder.ts :9; listingSendOutcome.ts :8-9, :18, :20, :61-68,
  :81-83, :123; listingSendsRepo.ts :18-20, :36-37, :102, :104, :132-134,
  :182, :197, :204, :375-387, :407, :415-418; harness :3641-3642,
  :3647-3649, :3657-3659; conformance :1015, :1072-1076; the test-file and
  units.ts anchors). Indentation caveat: finding 1.
- Load-bearing names, as the plan uses them: `ledgerEntryFor` (exported,
  shareLedger.ts:49), `seeded`/`mayReplace`/`summarize` (private, :68/:78/:112),
  `MAX_REAPPLY = 3` (:39, loop `round <= MAX_REAPPLY` = 4 puts),
  `ShareLedgerDeps` (:33-36), the loop and its ERROR fields
  `{ unitId, contactId, broadcastId, attempt, state }` (:182-194 - the plan's
  `...opts.lostIds` spread keeps that key order), `putShareMemory` /
  `getByKeyConsistent` on the real repo (:290, :297) and the fake (:3608,
  :3619), `effectiveDecline` (listingSendOutcome.ts:47-59, param
  `{ declined?, sentAt? }` so `row ?? {}` types), `formatPhoneForDisplay`
  (phone.ts:73-77), `RecipientDisplay` carrying `phone` (contactsRepo.ts:385,
  :397; RECIPIENT_PROJECTION :1096; harness projectRecipient :2240-2251),
  `createLogCapture` `.lines` / `.atLevel(n)` exact-level (logCapture.ts:35-37),
  pino numeric `level` + `msg`; every test helper the new cases call exists in
  scope (shareLedger.test.ts `fakeLedger`/`deps`/`write`/`A1`; repair test
  `ids`/`seedShareWithChain`/`run`/`slotOf`/`ledgerOf`/`listingSends`/`T_ROOT`,
  the inserted case lands inside the describe that spans :108-837;
  contactTimeline D6 describe helpers :1382-1448; listingSendsApi
  `seedUnit`/`seedTenant`/`SECRET`/`SENT_AT`/`ContactItem`;
  listingSendOutcomeApi `seedUnit`/`seedContact`/`post`/`stored`;
  followUps `emptyWorld`/`unit`/`tenant`/`send`/`ago`/`DAY`/`HOUR`/`depsFor`;
  broadcastApi `world` (:194, one top-level describe :193-4137),
  `createDraft` (:869), `declinedRow`/`preview`/`rowsById` (:3399-3433),
  `createLogger` import; `world.listingSends`, `world.toursMap`,
  `makeWebhookHarness({ world })`). Imports are NodeNext `.js`. Base
  tsconfig has `noUncheckedIndexedAccess` - every indexed read in the plan's
  code uses `?.` or is fed to a parameter that accepts undefined.
- Expected REDs hold: vitest 3.2.6 (SSR transform) turns a missing named
  export into `undefined`, so Task 3.3's helper edit does not break the many
  suites importing listingSendSeed.ts before 3.3's implementation lands.
- Still-compiles (charge 3): `INDIVIDUAL_KEY` is private to shareLedger.ts
  (:41, used :74, :119 - both replaced) plus an independent private copy in
  listingSendSeed.ts:19 (unchanged); `summarize` is private (callers :142,
  :187); `applyShareLedgerEntry` signature unchanged for every importer
  (repair-share-outcomes.ts:141, broadcastFanOut.ts:122,
  shareAttemptOutcome.ts:41, listingSendSeed.ts:16, shareLedger.test.ts);
  `ListingSendOutcome` in app is read only by listingSendsRepo.ts (:151, :233)
  and followUps.ts (:56) as plain fields; NO switch / map / Record /
  `satisfies` over it in app/src, app/scripts, app/test, e2e or scripts (the
  only literal readers are wireDecline :90, isWaiting :123 and
  broadcasts.ts:619, all already correct for `signed_up`). No dashboard or e2e file imports the app type
  (dashboard keeps its own union - S5).
- Five callers (charge 4) pass the FULL stored row: contacts.ts:1304
  listByContact (GSI projection ALL: infra main.tf, dynamoAdmin.ts:57; no
  ProjectionExpression, listingSendsRepo.ts:469-481); units.ts:1479 listByUnit
  (:456-467) and :1724 getByKeyConsistent (:290-295) into projectRecipientRow
  (:236, derive at :240/:260); followUps.ts:139 listByUnit via the real repo
  (wired broadcasts.ts:1410); broadcasts.ts:596 listByUnit. Harness fakes
  return `{...r}` / structuredClone - shares included.
- Repair census (charge 5): the script walks BROADCAST slots and forecasts
  only the slot's own key (`ledgerWouldChange(before, share.broadcastId, ...)`,
  repair-share-outcomes.ts:826); a `flyer` entry is seen solely through
  `seeded` + `summarize`, so it keeps a pair counted and turns an uncount into
  an update. Task 3.3's case pins forecast == apply on that path (dry run
  pairsToUncount 0, apply pairsUncounted 0, second run all zeros) against the
  b-4 contrast (:373-381). No other flyer-sensitive census branch exists
  ('create' needs no row; 'recount' cannot flip while the flyer counts).
- AR13 (charge 6): displayNameOfContact has 8 callers (units.ts :268, :473,
  :650, :1871, :2123, :2249, :2522, :2573); `:268` is the only `tenantName`
  assignment; units.ts imports nothing from lib/phone.js yet. Exactly two
  server tests pin a nameless resolved recipient's exact shape
  (listingSendsApi.test.ts:169 via :152 `c-x`, :239 via :217 `c-1`); :83 and
  :576 are missing recipients (unaffected); contactsBatchReads.test.ts:174 and
  listingSendOutcomeApi.test.ts:122 are named. Only dashboard reader of the
  field is ListingDetail.tsx:1343; no e2e spec finds a Sent to row by a raw
  contactId (named contacts throughout, incl. the listing-send-fixture specs).
- Spec coverage (charge 7): every spec 5 "Ledger and outcome" bullet S3 owns
  and every D7/D8 server rule maps to a task (plan section 7 D holds); tours
  are structurally not consulted by the veto (applyFlyerShareEntry has no
  tours dep).

## 1. MINOR - three bullet-nested code blocks do not carry the bullet indent, so section 0's "strip it" rule breaks their Edit anchors

Plan location: section 0 (R1 #13 rule); Task 3.2 step 1a and step 3c; Task
3.5 step 1a.

Section 0 says a block under a bullet carries the bullet's 2-space indent and
the implementer strips it. Most S3 blocks follow that (e.g. 3.1 3b, 3.2 3a,
3.2 3c's COMMENT anchor at 6 spaces for live :3641-3642 at 4, 3.4 step 3,
3.5 3a), but these are written at the TARGET file's own indentation, so
stripping 2 spaces yields an anchor the Edit tool cannot find (or a
misindented replacement):
- Task 3.2 1a, the replacement for the `expect(after?.shares_op)...` line:
  6 spaces in the plan = live `app/test/listingSendsRepo.integration.test.ts:168`
  (6); stripping gives 4.
- Task 3.2 3c, both body anchors and both replacements (`row.declined =
  JSON.parse(...)` / `delete row.declined;` blocks): 6 spaces = live
  `app/test/helpers/twilioWebhookHarness.ts:3647-3649` and `:3657-3659` (6);
  stripping gives 4. (The comment anchor in the same step DOES carry it.)
- Task 3.5 1a, the `:169` replacement, the five-line `seedTenant(world,
  'c-1');` ... `// c-1 has a scheduled tour` anchor and the `:239`
  replacement: 4 spaces = live `app/test/listingSendsApi.test.ts:169`,
  `:217-221`, `:239` (4); stripping gives 2.

Correction: for these five blocks use the text as written, at the live
file's indentation (section 0's last clause - "the target file's own
indentation is the authority" - governs). Optionally add "(written at the
target's indent - do not strip)" to each step.

## 2. NOTE - line hints in plan 7 B that drifted (quoted text is right)

- `lib/blastAudienceRules.ts:62-64` (checkedByDefault) is at `:181-182`.
- `services/followUps.ts:180` (the isWaiting gate) is at `:176`.
- `routes/dev.ts:1452-1458` (the fixture's create-only refusal) is at
  `:1456-1462`.
- Task 3.2 3a labels the NO-RESET anchor `:18-21`; the three quoted lines
  are `listingSendsRepo.ts:18-20`.

No action; anchors are the quoted text.

## 3. NOTE - the broadcasts.ts:612 caller test cannot observe `signed_up`

Plan location: plan 2.4 ("a test per caller pins `signed_up` reaching its
wire"); Task 3.4 step 1e; section D "all five callers".

`app/src/routes/broadcasts.ts:619` consumes only `outcome === 'not_interested'`.
Task 3.4's broadcastApi case is (correctly) a PIN that is green before Task
3.4 - pre-change the superseded pair derives `no_reply`, post-change
`signed_up`, and both stay checked. It proves the D5 default, not that this
caller passes `shares` (which cannot change its behavior). Four callers have
a real `signed_up` wire pin; this one has the D5 PIN only. Correction: none
in code; the slice report / reviewers should count it as the D5 PIN, not a
fifth `signed_up` wire pin.

## 4. NOTE - two comments S3 leaves describing the pre-change rule

Plan location: Task 3.1 step 3b (ledgerEntryCounts "stays ... unchanged");
Task 3.2 step 3c.

- `app/src/services/shareLedger.ts:92` (ledgerEntryCounts doc) says it is
  "the summary's rule". After Task 3.1, summarize no longer calls it; the
  summary's rule is `latestCountedShareKey` (`typeof countedAt === 'string'`
  vs `countedAt !== undefined` - equivalent for the stored types). Suggest
  the doc point at lib/shareLedgerKeys.ts latestCountedShareKey so the two
  "an entry counts" definitions are tied together.
- `app/test/helpers/twilioWebhookHarness.ts:3612-3614` (fake putShareMemory
  comment): a tokenless write needs "NO stored token (an absent row or a
  seeded row)". After O1 a seeded row that was declined carries a token (the
  code is right; the comment is not). Suggest mirroring Task 3.2's repo-doc
  edit: "(an absent row, or a seeded row nobody has written memory or a
  decline on)".

## 5. NOTE - spec D7's residual overstates which pins flip to "Property sent"

Plan location: spec D7 residuals, spec section 4 (`propertySentWords`);
Task 3.3 step 1d (pins the TRUE behavior).

Spec D7 says an uncounted pair's "old 'Property text failed' pin reads
'Property sent'". Live `app/src/routes/contactTimeline.ts:731-739`: only a
pin with no share id (pre-branch) or whose share has no entry reads the
PAIR; a modern pin whose own share failed keeps reading its entry, so it
stays "Property text failed" after a flyer entry counts the pair. Task 3.3's
PIN asserts exactly that. Correction: none for S3; S6's GLOSSARY / any doc
text should say "a pre-branch pin (no share id), or a pin whose share has no
entry", not "its old Property text failed pin".

## 6. NOTE - two sub-second ordering residuals beyond the one spec D7 names

Plan location: spec D7 (O1, "newest counted entry" residual); Tasks 3.1 /
3.3. No plan change; worth one line each in the S3 slice report.

- O1 closes the race in one direction only. The outcome route takes its
  decline instant before the write (`app/src/routes/units.ts:1577`
  `const at = new Date().toISOString();`, write at `:1671`). A flyer write
  that lands inside that one-UpdateItem window with `signedUpAt > at` moves
  sentAt past `at`, so the new decline is superseded at birth
  (`app/src/lib/listingSendOutcome.ts:55`) and the route's own re-projection
  (`units.ts:1743`) answers `signed_up` - a public request undoing a staff
  click, which D7 says never happens. Clock skew between app instances
  widens the window; a second click (later `at`) sticks.
- The tie rule "FIRST in Object.entries order" (plan 2.1 / 3.2 watch) is not
  guaranteed across a DynamoDB round trip: DynamoDB promises no Map key
  order, so the stored order need not be the insertion order. On an exact
  countedAt tie, summarize (write time, in-memory order)
  and deriveListingSendOutcome (read time, unmarshalled order) can pick
  different keys - the wire could carry a broadcast's `broadcastId` with
  outcome `signed_up`. Needs an exact-millisecond tie between the app clock
  and a whole-second Twilio instant; same "cosmetic" class the spec accepts.
