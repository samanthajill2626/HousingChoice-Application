# D2b findings - S2 head, S2.6-S2.11 (matches store, lean seed row, rankingRunsRepo, exclusion pins, tables.ts comment, slice close)

- Reader: D2b (Phase 1 delta reader, read-only).
- Scope: plan section 6 head (lines 3697-3995) and tasks S2.6-S2.11 (lines
  6273-10009); watch items WI1, WI2, WI10 (S2 half), WI19 (S2 grep).
- Read: plan lines 1-590 (binding), 3697-3995, 6273-10009, plus the S5/S6
  call sites of the S2 repos (23693-23707, 24560-24824, 25310-25412,
  25878-25930, 28050-28131, 29285-29450, 29940-29950); spec sections 2, 5,
  6, D7, D8, D8.1, D10, D11; plan-drafts/S2-findings.md; the S2 rows of
  plan-review/plan-adjudications.md.
- Method: every S2.6-S2.10 code block was assembled into a scratch tree,
  applying each quoted "Replace X with Y" as an exact count-must-be-1 string
  replace (all 12 anchors matched once); the result was typechecked against
  the worktree's installed types with the repo's compiler options and
  linted file by file through `eslint --stdin --stdin-filename <tree path>`
  with the repo config. Nothing in the worktree was touched except this file
  and the scratch reference (`.superpowers/sdd/research/D2b-reference.md`,
  which also records the reusable compile/lint method).
- Verdict: buildable as written; one tsc-only error in `matchesRepo.test.ts`
  would fail `npm run typecheck` at S2.11 Step 2 (fix below, verified);
  everything else compiles, lints clean, and the DynamoDB expressions, hand-
  worked values, exclusion pins and WI1/WI2/WI19 greps check out.

Counts: BLOCKER 0, MAJOR 1, MINOR 10.

## Findings

### D2b-1 MAJOR - `stubGetDoc` rejects `MatchRow[]` under tsc (gate 1 fails)

- Plan: 6369-6372 and 6386 (S2.6 Step 1, `app/test/matchesRepo.test.ts`);
  callers 6512, 6529, 6548, 6552.
- Code fact: `stubGetDoc(stored: Array<Record<string, unknown>>, ...)` is
  called with `MatchRow[]` (and `[legacy, row(...)]`). `MatchRow` (plan
  6800-6828) is an interface with no index signature, so it is not
  assignable to `Record<string, unknown>`. Scratch compile with the
  `tsconfig.base.json` options (what `app/tsconfig.test.json` and so
  `npm run typecheck` use): 4 errors, TS2345/TS2322 "Index signature for type
  'string' is missing in type 'MatchRow'".
- Problem: vitest strips types, so S2.6 goes GREEN and the error surfaces
  only at S2.11 Step 2 ("Exit 0" fails) - a gate failure plus a follow-up
  commit.
- Correction: line 6370 `stored: ReadonlyArray<PairKey>,` (`PairKey` is
  declared at 6366) and line 6386
  `served.some((k) => k.tenantId === item.tenantId && k.unitId === item.unitId),`.
  Verified: with this change the whole assembled S2.6-S2.10 set typechecks
  (exit 0) and the file lints clean. Byte-exact text in the reference file.

### D2b-2 MINOR - `MatchRow.promptFingerprint` comment contradicts PR18

- Plan: 6814 (S2.6, `matchesRepo.ts`): "sha256 of the call's system text
  (spec D4, D8.1)".
- Ruling: PR18 (plan 404-408) - sha256 over the system text, a newline, and
  the stable JSON of the schema sent on that call.
- Correction: comment "sha256 of the call's system text, a newline and the
  stable JSON of its schema (PR18)".

### D2b-3 MINOR - `RankingFailedBatch` comment omits S5's `error` kind

- Plan: 7782-7790 (S2.8) lists `refusal | parse | truncated | timeout |
  driver` or `repo`. S5 also writes `failure: 'error'` for a batch that
  threw (plan 25185, 25344, 25353).
- `failure: string` accepts it, so nothing breaks; add "or `error` (an
  unexpected exception in the batch)" so S7's copy for failure kinds sees
  the full set.

### D2b-4 MINOR - a test name says "ignores" where the case asserts a throw

- Plan: 7660-7666 (S2.8) "updateJobProgress ignores an empty notScored list
  (no write of its own)" but the body asserts `rejects.toThrow(/empty
  progress/)` (correct: `{ notScored: [] }` alone is an empty patch, plan
  8167-8171; S5 never sends it alone - it guards with `length > 0`, plan
  25380, 25408).
- Correction: rename, e.g. "an empty notScored list alone is an empty
  patch: it throws and writes nothing".

### D2b-5 MINOR - a host-dependent log assertion

- Plan: 6477 `expect(JSON.stringify(warns[0])).not.toMatch(/c-\d/)`. The
  pino line carries the default `hostname`; any host whose name contains
  "c-" plus a digit (e.g. a container named `...c-1...`) fails this case
  with no product defect. ABT-DESKTOP is safe; cloud hosts are unknown.
- Correction: assert the ids themselves, as the repo's other "no ids in the
  log" cases do (app/test/composeFailTally.test.ts:70,
  shareRecipientState.test.ts:189):
  `for (const id of ['c-1', 'c-2', 'c-3']) expect(JSON.stringify(warns[0])).not.toContain(id);`.
  (6494's `/contact-\d/` is specific enough.)

### D2b-6 MINOR - the house paging helper is bypassed (twice)

- Code fact: `app/src/lib/dynamoPaging.ts:29` exports `queryAll(doc,
  input, opts)`, "THE cursor walk for repo reads that must return a WHOLE
  result set", with a page cap and a WARN at the cap (:51-58);
  `app/test/repoPagingWiring.test.ts` pins repos to it.
- Plan: `matchesRepo.ts` defines a private function also named `queryAll`
  (6928-6941) and `getOpenCandidateFlags` hand-rolls another walk
  (9662-9681), neither capped. Both work; the same-name private helper also
  misleads a `queryAll(` grep.
- Correction (optional): import `queryAll` from `'../lib/dynamoPaging.js'`;
  `(await queryAll<unknown>(doc, input, { logger: log })).filter(isCurrentMatchRow)`
  for the two lists, `queryAll<UnlawfulFlagRecord>(doc, {...}, { logger: log })`
  for the flags.

### D2b-7 MINOR - two more BatchGet walk copies, not on the tracked issue

- Code fact: `docs/issues/units-contacts-batchget-walk-duplicated.md`
  tracks the duplicated by-key BatchGet walk (100-key chunks, 4 attempts,
  25 ms doubling, `requireComplete`); the head (plan 3922-3926) has S8 add
  only `getManyByIds`.
- Plan: `matchesRepo.getPairs` (6983-7009) is the same walk with
  `requireComplete`; `rankingRunsRepo`'s `batchGetRuns` (9143-9163) copies
  `aiRunsRepo.ts:192-223`.
- Correction: S8's issue update also names `matchesRepo.getPairs` (and the
  run-listing walk), or S2.6 adds the issue's `TODO(...)` marker above
  `getPairs`.

### D2b-8 MINOR - WI1's grep cannot see manifest-wide writers

- Plan: 9849-9863 (S2.11 Step 6) and WI1 (plan 116-121) record "no other
  writer" from a by-NAME grep.
- Code fact: `app/src/lib/devReset.ts:94-103` clears every `TABLES` base
  (matches included) on a hermetic reseed, and `seed/index.ts:118` writes
  whatever `SEED` holds; neither names the table.
- Correction (report wording): "no other by-name writer; devReset's
  hermetic clear-all is the one manifest-wide deleter, and seedAll writes
  no matches row once S2.7 lands (seedNoLegacyMatch.test.ts)".

### D2b-9 MINOR - stale line cites for aiRunsRepo in the WI2 record

- Plan: 9883-9885 cites `listByEntity` at `:248-289` and `getRun` at
  `:300-305`; C4 (3757) repeats `:300-305`.
- Code fact at 404e039d: `listByEntity` is `app/src/repos/aiRunsRepo.ts:304-381`
  (its BatchGet walk `:192-223`), `getRun` `:297-302`; S1.4 then adds five
  lines to `AiRunRecord` above them. The report should cite the built tree.

### D2b-10 MINOR - the new `ai_runs` comment overstates "Reads are Query then ONE BatchGetItem"

- Plan: 9341-9342 (S2.9 Step 3c). That sentence now holds only for the two
  pointer listings; the job poll and the flag read are a plain Query, and
  job/run reads are GetItem. "(WI2)" is also a plan-internal tag in a
  source comment.
- Correction (cosmetic): "Listings are Query(byEntity) then ONE
  BatchGetItem; the job poll and the flag read are a plain Query; nothing
  Scans." and drop "(WI2)".

### D2b-11 MINOR - "Restore" in S2.10 Step 1b

- Plan: 9542 "Restore the flag write" - nothing was removed; it is an ADD
  after the job-claim call. The anchor (9545-9549) is unique in that file
  (the `putRun` literal above it uses `expires_at`, not `expiresAt`).
  Wording only: "Add the flag write".

## Checked and fine

- Anchors, byte-exact and once: lean.ts 36-40 (`MATCH_EXPIRES_AT` block)
  and 445-458 (the row); db-seed.ts header 5-8; tables.ts 625-635 and 642;
  the six rankingRunsRepo.ts replacements of S2.9/S2.10 against the
  assembled stages; the S2.10 1b anchor. After S2.7 `T0` and `IDS.unitA`
  stay used; `MATCH_EXPIRES_AT` has no other user; db-seed.ts then greps
  `matches` only in the new sentence.
- Names/signatures: `tableName(base, env)` config.ts:521;
  `createDynamoClient`/`createDocumentClient({ endpoint })` dynamo.ts:61/82;
  `getDocumentClient` :98; `ensureTable(client, spec, name)`
  dynamoAdmin.ts:588; `deleteTableIfExists` :724; `createLogger({ destination })`
  logger.ts:178; `createLogCapture` (`atLevel` is exact-level);
  `IncompleteBatchReadError(unprocessed, requested, table)` contactsRepo.ts:686
  (message "matches batch read incomplete: 1 of 3 keys unread ...");
  `RepoDeps` conversationsRepo.ts:532; `createAiRunsRepo` and
  `AiRunRecordInput` (S1.4 adds only optional `notesDuplicate`);
  `createFakeWorld` / `makeWebhookHarness({ world })` / `ORIGIN_SECRET` /
  `TEST_ADMIN_COOKIE`, with `world.aiRuns` wired to the router
  (harness :5777, routes/api.ts:893-898); `castItems()` cast.ts:1529;
  `matrixItems(now)` matrix.ts:1425; `SEED` typed `Record<string, ...>`
  (lean.ts:85) so dropping `matches` is type-safe.
- Whole assembled set: tsc clean apart from D2b-1 (also with
  `--noUnusedLocals --noUnusedParameters`); eslint clean on all 13 files
  (`_dropped` passes `varsIgnorePattern ^_`; every `let` is reassigned);
  ASCII 0 on every new file and on the added lines of tables.ts/db-seed.ts;
  no `\u` escape anywhere (the sort-key ceiling is `String.fromCharCode`).
- Tsconfig/smoke: new src files fall under app/tsconfig.json and
  tsconfig.test.json, tests under tsconfig.test.json; relative imports are
  `.js`-suffixed; the lib-dynamodb/client-dynamodb names are already
  imported by shipped src (devReset `BatchWriteCommand`, aiRunsRepo
  `TransactWriteCommand`, `ConditionalCheckFailedException`); `node:zlib`;
  no directory import; matchesRepo -> contactsRepo is not a cycle.
- Table facts the code assumes: matches hash `tenantId`, range `unitId`,
  GSI `byUnit` (`unitId`, `tenantId`), TTL `expires_at` (tables.ts:238-252);
  ai_runs hash `itemId`, sparse GSI `byEntity` (`entityKey`, `sortKey`), TTL
  `expires_at` (:624-656); GSIs project ALL, so `listQueued` returns whole
  job records.
- DynamoDB acceptance: every name/value placeholder provided is used;
  `status`, `message`, `kind` and the rest are aliased; no SET/REMOVE path
  overlap; REMOVE drops the sparse keys in `finishJob`/`markExpiredQueued`/
  `markLeaseFailed`; `list_append(if_not_exists(#x, :empty), :v)`;
  `IN (:done, :failed)`; no `ConsistentRead` on any GSI query; the BatchGet
  projection uses `#f0..#f18`; one TransactWrite of run + 2 pointers with
  `attribute_not_exists` on the run; `ConditionalCheckFailedException`
  caught by `instanceof` as aiRunsRepo does.
- Hand-worked values: 60 -> 25/25/10; 150 + 5 repeats -> 100/50; 30 -> 25+5;
  5 write / 4 read attempts; thrown chunk -> written 35, unwritten
  rows 25-49 in order, two WARNs; "1 of 3"; at(599_999)/at(600_000),
  at(90_999)/at(91_000), at(180_999) boundaries; `localeCompare` order
  contact-20, contact-21, contact-3; `batchesDone` [0, 2]; 19 summary
  fields (17 when `failure`/`message` absent); inverted range
  '2026-10-23' > '2026-10-22' + U+FFFF; cursor pages 2/2/1 and the BETWEEN
  boundary trim; flag field order application_process <
  landlord:qualifications < notes; the 300 KB `randomBytes` base64 (409,600
  chars) trips the 358,400-byte guard.
- Isolation: every integration file mints `hc-test-<uuid8>-`
  (RESIDUE_PREFIXES globalTeardown.ts:80-84) and passes the creates-tables
  guard (setup/dynamoAccessKeyGuard.test.ts: `ensureTable` + `randomUUID`);
  the two stub suites create no tables; `DYNAMO_DISABLE_TTL=1`
  (app/vitest.config.ts) keeps the legacy row's past `expires_at` from
  being reaped; djb2 per-file keys of all 57 new app test files in the plan
  collide with none of the 545 existing. In-file ordering holds:
  listQueued's 2020-01 records head the queued partition, listExpiredLeases'
  2020-02 leases are the only ones before its `now`, day 2026-10-20 holds
  only runs a, b, c.
- Exclusion pins (WI2) would fail if the exclusion broke: a ranking pointer
  in any extraction scope adds an entry to `listByEntity` and to
  `GET /api/ai-runs`; a run stored as `run#` is found by `getRun` and the
  detail route; a widened `SCOPE_PATTERN` fails the 400 case; the tenant
  anchor `contact-x` equals the extraction `contactId`, so a `contacts#`
  collision would show.
- WI2 readers as cited: routes/aiRuns.ts `SCOPE_PATTERN` :30-31, detail
  `getRun` :228-230; journalSweep.ts:118 -> suggestionResolution.ts:474
  (`setVerdict` by key); dev.ts:752 -> extraction.ts:695/774/797 (by key);
  devReset.ts:35-62 clears every item (intended); performanceSeed.ts
  `TABLE_BASES` :47-56 (no ai_runs), its `aiRuns` reader (:163) is never
  called in the module; scripts/wipe-dev-data.mjs deletes every item (no
  prefix logic); nothing in app/scripts or scripts/ reads ai_runs.
- WI1 grep reproduces on the assembled tree: app/src 3 hits (tables.ts:240,
  the table name and the error label in matchesRepo.ts); elsewhere only
  scripts/secrets.mjs:301; no S1 or S2.1-S2.5 block adds a `'matches'`
  string.
- WI10 (S2 half): `seedProfile.integration.test.ts` derives count and ids
  from SEED (:43-49); seedHistory/Matrix/HeardFrom/TourTrails/Live and
  seedContactTypeInvariants copy or scan SEED without counting matches;
  performanceSeed reads only `SEED.conversations`; no test pins GSI
  coverage by the seed; no other seed module (cast, matrix, live, history,
  performance, heardFrom, media, orgList) carries a `matches` key; e2e
  imports only seed/performance.ts. The 13 seed suites S2.7 Step 4 does not
  name also never reference the row (S2.11 Step 4 runs them).
- WI19: the exact e2e pattern returns nothing; the "matches property" chip
  text at broadcasts.spec.ts:176, :326 and property-requirements.spec.ts:535-536
  is as cited; no e2e or dashboard code scans DynamoDB or reads a matches
  API.
- RED/GREEN: S2.6/S2.8 fail on the missing module; S2.7 case 1 fails, case 2
  is a PIN; S2.9/S2.10 fail with "not a function" (vite-node leaves a
  missing named export undefined; `rankingRunsRepoListing.test.ts` fails at
  its top-level `rankingRunEntityKey()`); each task greens with only earlier
  tasks.
- Cross-slice contracts: PR5 and the head's "Exports S2 adds" match the code
  name for name; S5's `claimOf` (23693-23707), batch progress patches
  (24595-24824) and `finishJob`/`runJob` (25310-25412) use
  `RankingJobClaim`/`RankingJobProgress` fields exactly and never send an
  empty patch; S6's `getJob`/`getPairs`/`getOpenCandidateFlags`/`listRuns`/
  `getRun` calls (28050-28131, 29293-29365, 29435) match the signatures.
- Spec/rulings: D7 fields + PR13 `notScored` + the C8 takeover reset +
  IR23 `runIds` kept; PR15 `{ count, at }`; PR34 summary projection and
  `incomplete`; PR36 finish conditioned on the generation; PR37 unwritten
  semantics; PR42 `failedBatches` shape; D10 no TTL and the textHash
  condition; D11 `rrun#` and pointer keys, the 350 KB guard, the 180-day
  pointer TTL; D8 legacy rows ignored by all three readers.
- Head facts: config.ts:403-410, :630-632, :641; worker.ts `startPoll`
  :352/388/436/508/526/534; config.ts:887-894; scripts/dev.mjs:113-116;
  devRoutes.ts:18; e2e-session.mjs:144; harness `UnitsRepo` :2969 and
  `PlacementsRepo` :3484 - all as cited.
