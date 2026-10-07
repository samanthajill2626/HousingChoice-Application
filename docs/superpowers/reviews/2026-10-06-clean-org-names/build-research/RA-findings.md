# RA findings - build research, feat/clean-org-names

- Reader: RA (opus), 2026-10-06, read-only.
- Plan range: S1, S2, S3 - plan lines 555-6906 of
  `docs/superpowers/plans/2026-10-06-clean-org-names.md` (plus sections 0-3
  and section 12).
- Counts: BLOCKER 0, MAJOR 0, MINOR 2.

## What was checked, and how

1. ANCHORS. Every create / append / replace / insert-after in the range was
   REPLAYED mechanically on scratch copies (23 files: the 12 new S1-S3 files
   plus copies of `contactsRepo.ts`, `unitsRepo.ts`, the harness and the four
   typed-fake suites read from the worktree), in plan order, asserting each
   old_string occurs EXACTLY ONCE in its file at that moment. Result: every
   anchor applies uniquely. All MISSING rows of the anchor check for Tasks
   2.2-3.10 are byte-exact copies of the earlier task's new text (indentation
   included); the SEVERAL-FILES rows (plan 3199, 3441, 4699, 5152) and the
   MULTI-IN-FILE row (plan 3326) are unique inside the file the plan names.
   The four insert-after anchors (plan 2112, 4399, 4499, 6647) are unique.
2. SYMBOLS. Every existing symbol the range uses exists with a compatible
   signature (see "Symbols" below). The final state of all 23 files was also
   TYPECHECKED in a scratch overlay of the full app tree (tsconfig.test.json
   options, Bundler resolution only so bare packages resolve from the
   worktree's node_modules): ZERO errors in any plan-touched file (the 39
   errors reported were all in base files importing modules the scratch copy
   omitted - app/scripts, dashboard, root scripts, e2e fixtures - or a
   fake-twilio dependency).
3. CONTRACTS. Plan section 3.2-3.4b/3.5/3.7-3.9 names and shapes match the
   code in S1-S3 exactly (types, the repo interface and errors, the three
   service interfaces and factories, error codes and bodies, the two writers,
   audit payloads, `ORG_REWRITE_JOB` and its `{ jobId }` payload minted before
   the list write). Later S3 tasks call S1/S2 with the shapes S1/S2 define
   (typecheck above).
4. FALLOUT. ContactsRepo gains `rewriteOrgFields`: the only full literals
   are the harness and the four the plan names
   (`contactCapture.test.ts:141`, `sendMessage.test.ts:253`,
   `scheduledSendSuppression.test.ts:269`, `audienceResolution.test.ts:117`);
   every other fake is a `Pick<>` (`groupMembers.test.ts:24`) or an
   `as unknown as ContactsRepo` cast (`groupConvert.test.ts:124`,
   `importConvertGroups.test.ts:127`, `emailEvents.test.ts:358`). UnitsRepo
   gains `rewriteAcceptedAuthorities`: the harness (`:2690`) is the only full
   literal (`placementNudges.test.ts:176` is a cast). Nothing in app/scripts,
   e2e, fake-twilio or dashboard builds either repo. `FakeWorld` gains
   `orgListRepo`: no other FakeWorld object literal exists. No settings-table
   registry or scan pins the item set (`org-list` is new). The new audit
   types have no event-type allowlist on the property Activity projection
   (`routes/units.ts:190-221`, payload-key whitelist only) and no reader of
   `contacts#<id>` trails exists. Clean - the plan's named fallout is complete.
5. TDD VALIDITY. Every RED step is red for the stated reason (missing
   module, or a missing export/method that vite-node surfaces as undefined /
   "not a function" while the earlier blocks of the same file stay green).
   All run commands use existing paths. The pure suites were executed on a
   vitest-like shim against the replayed code: S1 `orgNames.test.ts` (34) and
   `orgStartingList.test.ts` (32), S2 `orgListFake.test.ts` (6), S3
   `orgNamesService.test.ts` (23), `orgRecords.test.ts` (18),
   `orgRewriteService.test.ts` (21) - ALL GREEN, including the starting-list
   conformance (only AHA and MHA shared; every Appendix A and Sam mapping
   resolves). The two DynamoDB Local suites (`orgListRepo.integration`,
   the real half of `orgRecordWriters.integration`) were NOT run (read-only
   brief); traced by reading - every ExpressionAttributeNames/Values entry is
   used by its expression, the list-equality condition has the
   `updateRosterIfCurrent` precedent (`unitsRepo.ts:506-511`), and the
   racing-doc test's `instanceof PutCommand` sees the same class the repo
   sends. One finding (RA-1) below.
6. SPEC. S1 starting list equals spec Appendix A entry for entry; D3, D4, D5
   (S1 part), D10 (Split contacts-only, name-variant 409, Use/Move/Add/Clear),
   D11 (lock, id-first ordering, heartbeat/finish re-check, fields fixed at
   start, run-again target re-check, cleanup lock), D12 (automatic additions
   skip, admin edits refuse, confirm for same-kind shares), D13 (caps,
   control characters, '' after normalization) all conform. Prose 400 bodies
   in merge/resolve are the accepted house style (plan-assembly ruling S2-S5
   #11). No contradiction found.

## Findings

### RA-1 | Task 3.5, plan line 4143 | MINOR

- Evidence: the case `(PIN) use whose from-text IS the name ...` is marked
  PIN, and plan section 0 (lines 21-23) defines a PIN as "already green on
  unchanged code - write it, confirm it passes". At Task 3.5's RED run
  (plan 4393-4395) `records.rewrite` does not exist, so this case fails with
  the rest of the appended block (TypeError: not a function); it can only
  pass after GREEN.
- Correction: write it with the block, expect it RED at the RED run for the
  same reason as its neighbors, and GREEN after the implementation. Do not
  try to "confirm it passes" before GREEN, and do not treat its RED as a
  regression. (Optionally drop the "(PIN)" marker in the test name.)

### RA-2 | Task 2.2, plan line 1918 | MINOR

- Evidence: "replace the two import lines" - the old text is in fact TWO
  separate blocks in `app/test/orgListRepo.integration.test.ts`: the one-line
  `@aws-sdk/lib-dynamodb` import (plan 1920-1922) and, seven lines later, the
  two-line orgListRepo + orgFixtures imports (plan 1924-1927).
- Correction: two Edit calls - block plan 1921 -> block plan 1932, and block
  plan 1925-1926 -> block plan 1936-1953. Both old blocks are unique in the
  file (verified by replay).

## Clean checks (one line each)

- Anchors: all unique and byte-exact; base line numbers accurate except
  unitsRepo's implementation anchor, cited `:947-952`, actually `:948-952`
  (text match governs - harmless).
- Symbols: clean (table below).
- Contracts with section 3: clean.
- Fallout: clean (named fallout complete).
- TDD validity: clean apart from RA-1.
- Spec conformance: clean.
- ASCII: plan lines 555-6906 contain no non-ASCII byte and no `\u` escape.
- Lint (gate 5, tseslint recommended + no-unused-vars): no unused import or
  binding in any S1-S3 block in its final state.

## Symbols the range uses (base tree, all compatible)

| symbol | where | used as |
|---|---|---|
| `createDynamoClient(opts)` / `createDocumentClient(opts)` / `getDocumentClient()` | `app/src/lib/dynamo.ts:61`, `:82` (removeUndefinedValues on), `:98` | as the plan calls them |
| `tableName(base, env?)` | `app/src/lib/config.ts:512` | `tableName('settings', testEnv)` |
| `ensureTable(client, spec, name, env?, opts?)` / `deleteTableIfExists(client, name, opts?)` | `app/src/lib/dynamoAdmin.ts:588`, `:724` | 3-arg / 2-arg calls |
| `getTableSpec('settings' / 'contacts' / 'units')` | `app/src/lib/tables.ts:660`; settings spec `:309` (hash `settingId`, no GSIs) | |
| `RepoDeps { doc?, env?, logger? }` | `app/src/repos/conversationsRepo.ts:530-536` | |
| `createLogger({ destination })`, `logger`, `type Logger` | `app/src/lib/logger.ts:178`, `:261`, `:14` | |
| `createLogCapture().stream` | `app/test/helpers/logCapture.ts:14` | |
| `ConditionalCheckFailedException` instanceof | precedent `settingsRepo.ts:425` | |
| `contactsRepo.listByType(type, { deleted?, exclusiveStartKey? })` -> `{ items, lastEvaluatedKey? }` | interface `contactsRepo.ts:659`, impl `:1124` (no Limit; deleted filter), opts `:596-614`, page `:591-594` | every contact of every type, active then deleted |
| `unitsRepo.list({ deleted?, exclusiveStartKey? })` -> `UnitsPage` | interface `unitsRepo.ts:430`, impl `:930` (Scan, deleted filter, cursor) | every unit, active then deleted |
| `isDeleted` (contacts / units) | `contactsRepo.ts:324`, `unitsRepo.ts:285` | |
| `EmptyIndexKeyError(attribute)` | `contactsRepo.ts:525`; already imported by the harness (`:36`) | |
| `ContactType` (5 members) | `contactsRepo.ts:51` | `CONTACT_TYPE_KEYS` record |
| `UnitItem.accepted_authorities?: string[]`, `address?: Address`, `[key]: unknown` | `unitsRepo.ts:159`, `:165`, `:277` | |
| `formatAddress(a)` / `contactDisplayName(c)` | `app/src/lib/address.ts:112` / `app/src/lib/contactName.ts:74` (undefined when no name) | holders() |
| `AuditRepo.append(entityKey, eventType, payload?)`, `createAuditRepo(deps)` | `app/src/repos/auditRepo.ts:43`, `:102` | |
| `enqueue(jobName, payload, opts?)` -> `Promise<JobEnvelope>` | `app/src/jobs/jobs.ts:107-111`; `JobEnvelope` / `JOB_ENVELOPE_VERSION` `app/src/jobs/types.ts:5-24` | `typeof enqueue` dep; test envelope literal |
| harness `FakeWorld` / `createFakeWorld()` / contacts `listByType` fake (pages at 50, honors the contactId cursor) / units `list` fake (ignores cursor, caps 50, no lastEvaluatedKey) / audit fake | `twilioWebhookHarness.ts:241`, `:507`, `:2211`, `:2862`, `:2483` | |
