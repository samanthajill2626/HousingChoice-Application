# WP1 B2a plan drafts - interface reconciliation (S1-S8)

Reconciler pass, 2026-10-28. Read-only over the eight drafts in
`.superpowers/sdd/plan-draft-S1.md` ... `plan-draft-S8.md`, the plan head
(PR1-PR11, WI1-WI22), the spec (rev 6) and the drafter findings. Method:
every export a slice's TASK CODE writes was checked against every consumer
in a later slice (imports, calls, assumed fields, fakes, fixtures, wire
parsing, e2e assertions). Cross-slice notes were used only as a pointer;
where a note and the task code differ, the task code is cited.

Citations are `plan-draft-Sn.md:<line>`. "Producer" is the slice whose code
defines the name; the default resolution keeps the producer's shape unless
the spec says otherwise or the consumer's shape is clearly better (stated
where so). Typecheck note: `app` typecheck covers `src`, `scripts` and
`test` (app/package.json `typecheck`), so a test-file or fixture type error
fails gate 1.

Counts: 16 would-not-compile, 10 wrong-behavior, 10 cosmetic (36).

---

## A. Would not compile (slices applied S1 -> S8 in order)

### IR1 - Two slices create the same test helper `app/test/helpers/rankingFixtures.ts`

- Producer: S3 Task S3.2 creates it ("Create `app/test/helpers/rankingFixtures.ts`",
  `plan-draft-S3.md:1287-1293`) with the in-memory world (`tenant`, `unit`,
  `sendRow`, `tourRow`, `rankingWorld`, `DAY_MS`, `NOW`, ...) that all eleven
  S3 suites import.
- Consumer / second creator: S5 Task S5.2 Step 3 writes "New file
  `app/test/helpers/rankingFixtures.ts` (complete ...)" (`plan-draft-S5.md:812-963`)
  with an unrelated export set (`T0`, `ANCHOR_UNIT`, `unitAnchor`,
  `tenantCandidate`, `assembled`, `parsed`, `stubBuildPrompt`, `queuedJob`,
  `matchRow`, `rankingRun`, ... and its own `DAY_MS`). S6 imports S5's names
  from that path (`plan-draft-S6.md:776-789`, `:1197`, `:1729`).
- Breaks: writing S5's file replaces S3's, so every S3 suite fails to
  compile; merging the two by hand gives a duplicate `DAY_MS` export.
- Resolution: S5 writes its helper to a NEW path,
  `app/test/helpers/rankingJobFixtures.ts`; S5 (every `./helpers/rankingFixtures.js`
  import in S5.2-S5.9) and S6 (the three imports above) import from it. S3's
  file is untouched. Change: S5, S6.

### IR2 - The job family's method signatures: S2 defines one API, S5 calls another

- Producer: S2 Task S2.8 `RankingJobFamily` (`plan-draft-S2.md:3751-3871`):
  every write takes a `RankingJobRef { anchorKind, anchorId, generation }`;
  `putJobClaim(claim: RankingJobClaim): Promise<{ ok: true; job } | { ok: false }>`
  (the repo builds the record; TTL field `expiresAt`);
  `takeOver(ref, { nowIso, newGeneration, leaseExpiresAt })`;
  `markLeaseFailed(ref, { nowIso, message })` for the second expiry;
  `renewLease(ref, leaseExpiresAt)`; `markExpiredQueued(ref, { nowIso, message })`;
  `updateJobProgress(ref, RankingJobProgress)` where the progress type has
  `runIds?: string[]` and NO `message`; `finishJob(ref, { status, finishedAt, message? })`.
  Types are named `RankingFailedBatch` and `RankingJobProgress`.
- Consumer: S5 codes to its own assumed API (`plan-draft-S5.md:179-198`) in
  task code: `putJobClaim(record, nowIso): Promise<boolean>` (`:2013`, record
  built by `newClaimRecord` `:1973-1997`); `updateJobProgress(kind, id, generation, patch)`
  (`:2845`, `:3356`, `:3399`) with `runId` and `message` in the patch
  (`:2970`, `:3014-3018`, `:3408`); `finishJob(kind, id, generation, ...)`
  (`:3330`) and `finishJob(..., { leaseExpiredBefore })` for the second
  expiry (`:3881-3886`); `renewLease(kind, id, generation, lease)` (`:3473`);
  `markExpiredQueued(record, nowIso, message)` (`:3851`);
  `takeOver(record, { nowIso, generation, leaseExpiresAt })` (`:3895-3899`,
  `:4098`); imports `FailedBatch`, `JobProgressPatch` (`:1836`, `:2772-2773`).
  The fake `rankingRunsFake.ts` is typed `Pick<RankingRunsRepo, ...>`
  (`:1570-1587`) and implements S5's shapes (`:1664`, `:1749`), so it fails
  against S2's interface too (and `putRun` there returns void where S2's
  returns `Promise<RankingRunRecord>`).
- Breaks: typecheck in `job.ts`, `runBatch.ts`, the fake, the integration
  test S5.8.
- Resolution: keep S2's API (producer; the ref style is uniform and S6 uses
  only `getJob` / `getOpenCandidateFlags`, which already agree). S5 changes:
  `claimRanking` builds a `RankingJobClaim` and reads `{ ok, job }`; every
  job write passes `{ anchorKind, anchorId, generation }` (a whole record
  also satisfies `RankingJobRef` structurally); progress uses
  `runIds: [runId]`; the second expiry calls `markLeaseFailed` (and emits
  with `{ ...record, status: 'failed' }`, as the queue-expiry branch already
  does); `takeOver` passes `newGeneration`; the two type imports are renamed;
  the fake implements S2's signatures, `markLeaseFailed` included. The
  progress `message` (S5 `:3408`, the "N tenants could not be read" text
  while running) is dropped - that text already reaches the record through
  `finishJob`'s message (`:3396`, `:3434`); if the planner wants it shown
  while the job runs, S2 adds `message?: string` to `RankingJobProgress`
  instead. Change: S5 (S2 only if the live message is wanted). See IR23 for
  the takeover `runIds` behavior.

### IR3 - `RankingRunResult` (the run's `results[]` entry): S2's shape cannot hold an omitted candidate

- Producer: S2 Task S2.9 (`plan-draft-S2.md:4745-4756`): `{ handle, candidateId,
  score: number, for, against, unknowns, failedRequirements, fairHousingFlags,
  cappedAtRun: boolean }` - every field required, no `display`, no `returned`.
- Consumers: S5 `runLog.ts` writes `{ handle, candidateId, display,
  returned: false }` for a candidate the model left out and
  `{ ..., returned: true, score, ..., cappedAtRun: { capped, capReason } }`
  otherwise (`plan-draft-S5.md:2395-2422`; assumed type `:207`). S6
  `adminRankings.ts` reads `result.returned`, `result.display`,
  `result.cappedAtRun?.capped`, `result.cappedAtRun?.capReason` and optional
  `score` / `for` / ... (`plan-draft-S6.md:2219-2237`).
- Breaks: typecheck in S5 `runLog.ts` (object literal typed `RankingRunRecord`)
  and S6 `adminRankings.ts`.
- Resolution: consumer shape (S5 and S6 already agree, and charter 7.4 needs
  the not-returned candidate recorded with no score). S2 retypes
  `RankingRunResult` as `{ handle; candidateId; display; returned: boolean;
  score?; for?: MatchReason[]; against?: MatchReason[]; unknowns?;
  failedRequirements?; fairHousingFlags?: MatchFairHousingFlag[];
  cappedAtRun?: { capped: boolean; capReason: 'requirement not met' | null };
  missing?: MatchMissing[] }` (the `missing` field is IR19's). Repo-local
  types only, so no repo imports a service (PR3). Change: S2.

### IR4 - `matchesWritten`: three different types

- Producer: S2 (`plan-draft-S2.md:78-79` C8, `:4788` `matchesWritten?: { count: number; at: string }`,
  `:4841` `markMatchesWritten(runId, { count, at }): Promise<boolean>`).
- Consumers: S5 calls `markMatchesWritten(runId, rows.length)`
  (`plan-draft-S5.md:2994`; assumed `:200`, `:215` as `number`); S6's test
  fixture builds a run with `matchesWritten: 2` (`plan-draft-S6.md:1882`);
  S7 types `matchesWritten?: boolean` (`plan-draft-S7.md:545`) and renders
  "Matches: not written" unless it is `=== true` (`:3654`), fixtures `:2826`,
  `:3186`.
- Breaks: S5 typecheck; S7 shows "Matches: not written" on every scored run
  whatever the server sends.
- Resolution: S2's `{ count, at }` (producer; charter 11 wants the write
  recorded, the count plus time does it without duplicating `results[]`).
  S5 passes `{ count: rows.length, at: deps.now() }`; S6's fixture uses the
  object; S7 types `matchesWritten?: { count: number; at: string }` and tests
  `=== undefined` for "not written". Change: S5, S6, S7.

### IR5 - `MatchRow.inputSnapshot` and `promptFingerprint`

- Producer: S2 `MatchRow` (`plan-draft-S2.md:2855-2883`): top-level
  `promptFingerprint: string`, `inputSnapshot: string` (the
  `encodeSnapshot` output).
- Consumer: S5 `matchRowOf` writes `inputSnapshot: { data, promptFingerprint,
  rubricVersion, examplesVersion }` and no top-level `promptFingerprint`
  (`plan-draft-S5.md:2888-2893`; assumed `:226`).
- Breaks: S5 typecheck.
- Resolution: S2's shape (spec D8.1 "the snapshot plus `promptFingerprint`,
  `rubricVersion` and `examplesVersion`" is met by the top-level fields the
  row already carries). S5 writes `inputSnapshot: encodeSnapshot(prompt.snapshotOf(id))`
  and `promptFingerprint: prompt.promptFingerprint`. Change: S5.

### IR6 - `AssembledCandidate` is a union; S5 and S6 use it as one record with non-null fields

- Producer: S3 (`plan-draft-S3.md:186-200`, code `:5120-5154`):
  `VerifiedCandidate | UnverifiedCandidate`, the unverified arm carrying
  `card: null, missing: null, pairHistory: null, fingerprints: null,
  propertyFacts: PropertyFacts | null` (S3 C8 `:318-323`).
- Consumers: S5 filters with `!candidate.unverified` (`plan-draft-S5.md:3392-3393`),
  which does not narrow an array, then reads `candidate.missing` (spread,
  `:2876`), `candidate.fingerprints` (`:2887`), `candidate.propertyFacts.*`
  (`:2936`, `:2945`, runLog `:2417`) on `AssembledCandidate`. S6 reads
  `candidate.propertyFacts.recordedRequirementKeys` (`plan-draft-S6.md:631`)
  and `.freeTextByField` (`:1021`) without a guard. S5's assumed type
  (`:241-247`) has `unverified: boolean` on one non-null record.
- Breaks: typecheck (strictNullChecks) in S5 `runBatch.ts`, `runLog.ts` and
  S6 `readRanking.ts`. S6's runtime consequence is IR24.
- Resolution: S3's union (it is the honest shape). S5 narrows with a type
  guard (`(c): c is VerifiedCandidate => !c.unverified`) and types batches,
  `BuildRunInput.candidates` and `runBatch`'s parameter as
  `VerifiedCandidate[]`; S6 handles the null arm (IR24). Change: S5, S6.

### IR7 - `display: string | null` from S3; every consumer needs a string

- Producer: S3 `AssembledAnchor.display` and `CandidateBase.display` are
  `string | null` (`plan-draft-S3.md:180`, `:188`, code `:5108`, `:5125`,
  `:5272`, `:5318`, `:5341`, `:5372`).
- Consumers: S4 `buildRankingPrompt` candidates need `display: string`
  (`plan-draft-S4.md:217-223`); S5 passes candidates through and writes
  `handles[].display` (`plan-draft-S5.md:2455`); S6 `RankingReadRow.display`
  and `RankingReadAnchor.display` are `string` and assigned from it
  (`plan-draft-S6.md:530`, `:552`, `:656`, `:1122`) and sort with
  `display.localeCompare` (`:716`); S7 renders `display: string`.
- Breaks: typecheck in S5 (prompt call) and S6.
- Resolution: consumer shape (four consumers, one producer). S3 returns a
  string: a unit's `propertyLabel(unit) ?? NO_ADDRESS_LABEL` (S3's own
  placeholder, `:113`) and a tenant's `contactDisplayName(contact) ?? contactId`
  (the fallback S6's admin route already uses for anchors). The display never
  reaches the model (handles do), so the id fallback leaks nothing to it.
  Change: S3.

### IR8 - `AssembledCandidate.sortRecencyAt` does not exist

- Producer: S3 publishes no such field; its note tells S6 to read
  `last_heard_from_at` / `created_at` from `candidate.record`
  (`plan-draft-S3.md:384-386`).
- Consumers: S6 `recencyMs` reads `candidate.sortRecencyAt`
  (`plan-draft-S6.md:667-672`; C8 `:76-80`; assumed `:140`) and its sort
  tests pass it (`:386-390`); S5's fixture sets it (`plan-draft-S5.md:899`).
- Breaks: typecheck in S6 (source and tests).
- Resolution: producer (S3) owns the pool's recency rule (charter 9.1: last
  heard from, else `created_at` for a tenant admitted on that fallback),
  which `inPoolWindow` already applies, so the sort must not re-derive it.
  S3 exports that instant from `pool.ts` (for example
  `poolRecencyAt(contact: ContactItem): string | null`, the same rule
  `inPoolWindow` uses); S6's `recencyMs` calls it on `candidate.record`
  (property anchor only); the S5/S6 fixture supplies `record` instead of
  `sortRecencyAt`. Change: S3, S6, S5 (fixture).

### IR9 - `createAssembleDeps` and `loadPropertyFacts` are called but no slice writes them

- Producer: none. S3's `assemble.ts` exports `assembleRanking`,
  `readTenantInputs`, `buildTenantSide`, `buildPropertySide` only
  (`plan-draft-S3.md:210-213`, code `:5089-5384`).
- Consumers: S5 `jobWiring.ts` (`plan-draft-S5.md:4314`, `:4326`);
  S6 `readRanking.ts` (`plan-draft-S6.md:491`, `:1141`), `adminRankings.ts`
  (`:2008`, `:2086-2092`), the WI18 integration test (`:2431`, `:2634`,
  which needs `env` / `doc` honored for a throwaway `TABLE_PREFIX`).
- Breaks: typecheck (missing exports) in S5 and S6.
- Resolution: S3 owns `assemble.ts` (PR2) and the one-gatherer rule (WI12),
  so S3 adds both: `createAssembleDeps({ config, logger, env?, doc? }): AssembleDeps`
  (contacts, units, listingSends, tours, placements repos and the org names
  service on the given env/doc) and
  `loadPropertyFacts(unitIds, deps): Promise<Map<string, PropertyFacts>>`
  (one complete `getManyByIds`, landlords when the switch is on, then
  `propertyFacts`), with unit tests. Signatures as S6 wrote them
  (`plan-draft-S6.md:142-143`). Change: S3.

### IR10 - `PropertyFacts` imported from the wrong module

- Producer: S3 exports `PropertyFacts` from `cards.ts` (`plan-draft-S3.md:77`);
  `assemble.ts` only imports it (`:5060`), it does not re-export it.
- Consumer: S6 `adminRankings.ts` imports `type PropertyFacts` from
  `../services/ranking/assemble.js` (`plan-draft-S6.md:2008`).
- Breaks: typecheck.
- Resolution: S6 imports it from `cards.js`. Change: S6.

### IR11 - `AssembledAnchor.propertyFacts` is `PropertyFacts | null`, not optional

- Producer: S3 (`plan-draft-S3.md:183`, code `:5115`, `:5377`): always
  present; `null` for a tenant anchor.
- Consumers: S6 checks `anchorFacts !== undefined` then dereferences
  (`plan-draft-S6.md:1018-1019`); S5's fixture and assumed type use
  `propertyFacts?:` (`plan-draft-S5.md:239`, `:875`).
- Breaks: typecheck in S6 (`null` not excluded).
- Resolution: producer. S6 tests `!== null`. Change: S6.

### IR12 - `result.size` on a failure union that includes `AnchorUnreadable`

- Producer: S3 `AssembleResult = AssembledRanking | PoolFailure | AnchorUnreadable`
  (`plan-draft-S3.md:207-208`, `:5167-5173`); only `PoolFailure` has `size`.
- Consumer: S5 `runJob` reads `result.size` after `!result.ok`
  (`plan-draft-S5.md:3381-3384`; assumed a single failure shape `:238`).
- Breaks: typecheck.
- Resolution: producer. S5 reads it as
  `'size' in result && result.size !== undefined`. Change: S5.

### IR13 - `buildRankingPrompt` needs `batchIndex` and `landlordCard`; S5 does not pass them

- Producer: S4 (`plan-draft-S4.md:220-223`; C12 `:131-146`; finding S4-F2).
- Consumer: S5 `runBatch` calls it with `{ direction, anchor, candidates, homes }`
  (`plan-draft-S5.md:2909-2914`); `RankingJobDeps.config` has no
  `rankingLandlordCard` (`:1929-1932`).
- Breaks: typecheck; with a defaulted `false` it would silently use the
  wrong schema and drop valid `landlord:` flags (S4-F2).
- Resolution: producer (S4-F2's ruling). S5 adds `batchIndex: index` and
  `landlordCard: deps.config.rankingLandlordCard`, and `rankingLandlordCard`
  to the config `Pick`. Candidates passed are `VerifiedCandidate` with a
  string `display` (IR6, IR7). Change: S5.

### IR14 - S5's stub prompt does not type-check against S4's `RankingPrompt`

- Producer: S4 `RankingPrompt.snapshotOf(candidateId): RankingPairSnapshot`
  and `buildRankingPrompt`'s input type (`plan-draft-S4.md:217-223`).
- Consumer: S5 `stubBuildPrompt(input: { candidates: AssembledCandidate[] }): RankingPrompt`
  returns `snapshotOf: () => ({ candidateId, anchorCard })`
  (`plan-draft-S5.md:954-963`) and is assigned to the seam
  `buildPrompt?: typeof buildRankingPrompt` (`:1925`, used `:4177`).
- Breaks: test typecheck (snapshot literal is not a `RankingPairSnapshot`;
  under strictFunctionTypes the stub's parameter type is not a supertype of
  S4's input).
- Resolution: S5 types the seam as
  `(input: Parameters<typeof buildRankingPrompt>[0]) => RankingPrompt`, the
  stub takes that input, and its snapshot is built `as unknown as
  RankingPairSnapshot` (a test value). Change: S5.

### IR15 - `RankingReason.source` is S4's enum; the stored row's is `string`

- Producers: S4 `RankingReason { text; source: RankingSource }`
  (`plan-draft-S4.md:184`); S2 `MatchReason { text; source: string }`
  (`plan-draft-S2.md:2833-2836`), used by `MatchRow.for` / `against`.
- Consumer: S6 types `RankingReadMatch.for` / `against` as `RankingReason[]`
  (`plan-draft-S6.md:497`, `:515-516`) and assigns `row.for` / `row.against`
  (`:639-640`).
- Breaks: typecheck (`string` not assignable to the source union).
- Resolution: S6 types them `MatchRow['for']` / `MatchRow['against']` (what
  it actually reads). S5's write direction (enum into string) is fine.
  Change: S6.

### IR16 - S8's card adapter uses context shapes and function names S3 does not export

- Producer: S3 `PropertyCardCtx { orgEntries; landlordCard; landlord?: ContactItem | null }`,
  `TenantCardCtx { now; seenMax; seen: readonly SeenHome[] }`,
  `tenantMissing(contact)`, `propertyMissing(unit, ctx)`
  (`plan-draft-S3.md:67-76`, `:143-144`); S3 recommends
  `buildTenantSide` / `buildPropertySide` for S8 (`:351-354`).
- Consumer: S8 `rankingCounterfactual/cards.ts` (`plan-draft-S8.md:1300-1358`;
  C1 `:37-48`): imports `tenantMissingFlags` / `propertyMissingFlags`, builds
  `PropertyCardCtx` with an extra `now`, and `TenantCardCtx` as
  `{ now, orgEntries, landlordCard, seen: { sends, tours, units, seenMax } }`.
- Breaks: typecheck of `tsconfig.scripts.json` (missing exports, excess and
  wrong properties).
- Resolution: producer (S8 C1 already defers to it). S8's one file uses
  `tenantMissing` / `propertyMissing`, `propertyCtx()` =
  `{ orgEntries, landlordCard: false, landlord: null }`, `tenantCtx()` =
  `{ now, seenMax: 8, seen: [] }` (the D19 default; synthetic tenants have no
  seen homes). Nothing else in S8 changes. Change: S8.

---

## B. Wrong behavior (compiles, but runs wrong, fails a test, or departs from the spec)

### IR17 - `propertiesSeen` entries name their home as `homeRef`; S4 replaces `home`

- Producer: S3 `PropertiesSeenEntry.homeRef` (`plan-draft-S3.md:79`; C9
  `:325-330`; writer `:3827`, reader `listedHomeIds` `:3856-3857`).
- Consumer: S4 `SEEN_HOME_KEY = 'home'` (`plan-draft-S4.md:3164-3165`,
  replacement `:3282-3288`), and the rubric text tells the model the entry
  names its home 'in "home"' (`:1708`). S4's own test pins that an entry
  "without a string home" is left AS IT IS (`:3037-3040`).
- Breaks: compiles, but every tenant card reaches the model with raw
  `homeRef: <unitId>` (an id leak the S3 note forbids, `:362-363`), no
  `homesSeen` entry is written, and the missing-home guard never fires.
- Resolution: S3 renames the key to `home` (type field, `cards.ts` writer,
  `listedHomeIds`, the S3 tests; the fingerprint never reads it, C9). S4
  stays as written; its rubric already says "home". Add an S4 or S5 test
  that no `unitId` appears in the user text for a card with seen homes.
  Change: S3.

### IR18 - The read's pool ceiling: S6 answers `anchor: null`; S7 dereferences the anchor

- Producer: S6 route answers 200 `{ anchor: null, job, rows: [], flags: [],
  poolTooLarge: { size, message } }` (`plan-draft-S6.md:1590-1597`; C5
  `:62-65`, "the pool's failure result carries no anchor card"). S3 in fact
  hands the read `anchorRecord` and `anchorNotes` on `pool_too_large` "for
  the header" (`plan-draft-S3.md:47`, `:383-384`); S6 drops them
  (`RankingRead` `pool_too_large` arm `:561`).
- Consumer: S7 types `anchor: RankingAnchorView` (non-null) and
  `poolTooLarge?: { size }` (`plan-draft-S7.md:481-488`; N1 `:132-136`), and
  `AnchorRead` maps `read.anchor.anchorNotes` / `.missing` / `.id` before it
  checks `poolTooLarge` (`:2471-2481`).
- Breaks: TypeError on the Rankings page for any pool over the ceiling.
- Resolution: spec D9 keeps the anchor block in the response, and S3 already
  supplies the data. S6's `pool_too_large` arm carries an anchor block built
  from `PoolFailure.anchorRecord` / `anchorNotes` (display as in IR7,
  `missing: []`, `cardChanged: false`) and the route sends it; S7 widens
  `poolTooLarge` to `{ size: number; message: string }` (and may render the
  server's message). Change: S6, S7.

### IR19 - The run detail's pairs: field names, "missing", and where `anchorDisplay` sits

- Producer: S6 `GET /api/admin/rankings/runs/:runId` (`plan-draft-S6.md:2214-2261`)
  answers `{ run: { ...record, anchorDisplay? }, input, pairs, flags,
  currentUnavailable?, flagsUnavailable? }`; each pair is `{ handle,
  candidateId, display, returned, score, band, capped, capReason, for,
  against, unknowns, failedRequirements, fairHousingFlags, currentMatch:
  { runId, score, computedAt } | null, sinceRescored }`, and a not-returned
  pair has no score or band (`:2219-2221`). S6 C7 (`:72-75`): show
  `unknowns`, S7 labels them "missing".
- Consumer: S7 (`plan-draft-S7.md:550-576`; N1 `:153-164`; N3 `:176-179`)
  expects `{ run, anchorDisplay (top level), input, pairs, flags }` with each
  pair `{ candidateId, handle, display, score, band, cappedAtRun: boolean,
  for, against, missing: { key?, text }[], failedRequirements,
  fairHousingFlags, currentRunId: string | null }`, and renders
  `pair.missing.length`, `pair.cappedAtRun`, `currentMatchText(pair.currentRunId, ...)`
  and `{anchorDisplay}` (`:3631`, `:3638`, `:3685-3692`). The S7.10 e2e
  asserts "Capped" and "This run" in the pairs table (`:4316-4319`).
- Breaks: `pair.missing.length` throws (S6 sends `unknowns`); every pair
  reads "Capped: No" and "Since re-scored"; the header shows no anchor. The
  S7.10 e2e fails.
- Resolution: spec D18 lists "missing" per pair and D3 defines missing as
  the code flags then the model's unknowns, so S7 N3 is the spec's reading.
  (1) S2 adds `missing?: MatchMissing[]` to `RankingRunResult` (folded into
  IR3); (2) S5 `runLog.ts` writes `missing: mergeMissing([...anchor.missing,
  ...candidate.missing], result.unknowns)` on each returned result (the same
  value the match row gets, `plan-draft-S5.md:2876`); (3) S6 shapes each pair
  with S7's names - `cappedAtRun: boolean` (from `cappedAtRun.capped`),
  `missing`, `currentRunId` (the current match's `runId` or null) - keeps
  `returned`, `capReason` and `unknowns` as extra fields, and puts
  `anchorDisplay` at the top level, falling back to `run.anchorId`; (4) S7
  adds `returned: boolean` with `score` / `band` optional and renders a
  not-returned pair as "not returned". If the planner prefers no new stored
  field, the alternative is S6 C7 (S7 renders `unknowns` under "Missing");
  either way S6 and S7 must agree on one name. Change: S2, S5, S6, S7.

### IR20 - Cost totals: different response shapes

- Producer: S6 `GET /api/admin/rankings/cost` (`plan-draft-S6.md:2304-2314`):
  `{ weeks: [{ week, costUsd, runs }], environments: [{ environment, costUsd,
  runs }], totalUsd, runs, truncated }`.
- Consumer: S7 (`plan-draft-S7.md:578-593`; N1 `:165-167`) reads
  `cost.environment` (this deployment's name, rendered "Environment: ..."
  `:3549`) and `weeks[]` rows each with `environment`, `inputTokens`,
  `outputTokens` (`:3564-3567`). The S7.10 e2e asserts
  `Environment: \S+` (`:4309`).
- Breaks: the cost panel renders blanks; the e2e fails.
- Resolution: spec D18 wants "weekly cost totals with the environment name
  above the list" and D12 "totals by ISO week and by environment": S7's
  shape says both. S6 answers `{ environment: config.appEnv, weeks: [{ week,
  environment, runs, inputTokens, outputTokens, costUsd }] }` (grouped by
  week AND environment, summing `usage`), and may keep `totalUsd` /
  `truncated` as extra fields. Change: S6.

### IR21 - The runs list's `anchorDisplay` is optional on the server, required on the page

- Producer: S6 sends `anchorDisplay` only when the display read resolved it
  (`plan-draft-S6.md:2147`, `:2155`).
- Consumer: S7 `anchorDisplay: string` "falls back to the id" (`plan-draft-S7.md:497-498`;
  N1 `:150-152`), rendered `:3485`; e2e expects the property line in the row
  (`:4303`).
- Breaks: a blank anchor cell whenever the best-effort display read fails or
  a record has no name / label.
- Resolution: consumer (spec D18 "anchor (name or label)"). S6 always sends
  `anchorDisplay`, falling back to `run.anchorId`. Change: S6.

### IR22 - S5-F1's extra `failedBatches` entries make S7's batch counts wrong

- Producer: S5 records an omitted candidate as `{ index: <batch>, failure:
  'omitted' }` with the same index ALSO in `batchesDone`, and the unreadable
  candidates as `{ index: -1, failure: 'unreadable' }` (`plan-draft-S5.md:82-90`,
  `:3014-3018`, `:3402-3409`; finding S5-F1); its own `finishedBatchCount`
  counts distinct indexes >= 0 (`:2812-2817`).
- Consumers: S6 reads every entry for `notScored` / `failedBatch` (fine as
  S5-F1 intends, `plan-draft-S6.md:586-588`). S7 `jobStatusText` counts
  `failedBatches.length` as failed batches and adds it to
  `batchesDone.length` (`plan-draft-S7.md:1158-1172`).
- Breaks: one batch with an omission reads "Done: 1 of 1 batches scored, 1
  failed" (running: "2 of 1 batches finished"); unreadable candidates read as
  a failed batch.
- Resolution: accept S5-F1 (one rule for the read). S7 counts failed batches
  as distinct `index >= 0` entries whose index is not in `batchesDone`, the
  same rule as `finishedBatchCount`, and adds a test with an `omitted` and an
  index `-1` entry. Change: S7. (Planner: S5-F1 still needs its ruling.)

### IR23 - A takeover keeps `runIds` (S2) but S5's test expects them cleared

- Producer: S2 `takeOver` resets the progress fields and KEEPS `runIds`
  ("those runs happened", `plan-draft-S2.md:80-84`, `:3846-3851`).
- Consumer: S5 assumes a reset to `[]` (`plan-draft-S5.md:111-115`, `:194`)
  and its poll test asserts `record.runIds` no longer holds the dead
  attempt's run (`:3655-3662`).
- Breaks: that S5 test fails against S2's repo semantics (and against S5's
  own fake once the fake follows S2, IR2).
- Resolution: producer (the billed runs of a dead attempt are real; nothing
  reads `runIds` to count progress). S5's test asserts the old run id is
  KEPT and the new attempt's ids are appended. Change: S5.

### IR24 - Spec D2.3: an unverified PROPERTY candidate (tenant anchor) crashes the read

- Producer: S3 gives an unverified tenant-anchor candidate
  `propertyFacts: null` (`plan-draft-S3.md:198`, code `:5346-5348`).
- Consumer: S6 `propertiesInView` reads `candidate.propertyFacts.freeTextByField`
  for every candidate (`plan-draft-S6.md:1020-1022`), and `deriveMatch` reads
  `candidate.propertyFacts.recordedRequirementKeys` for every candidate with
  a stored row (`:627-633`). `readRanking` is not wrapped and the route has no
  catch (`:1585`), so the request errors out.
- Breaks: spec D2.3 (spec lines 345-351, 1221): an unverified candidate's
  stored match "is still shown, with out-of-date reason `unverified`"; only
  the anchor's own card answers 503.
- Resolution: S6 skips a candidate with null facts in `propertiesInView` (no
  flag read for that property) and, in `deriveMatch`, computes the cap with
  `recordedRequirementKeys: []` when facts are null (the row already carries
  `unverified`, which says the match could not be checked); a unit test pins
  a tenant anchor with one unverified property candidate that has a stored
  match. Change: S6.

### IR25 - S6 widens the 503 beyond the anchor card, including candidate-scoped reads

- Producer (of the rule): the spec - "an incomplete units read ... marks only
  its row `unverified` in the read, and fails the read only for the anchor's
  own card" (spec line 1221; D9 line 351).
- Consumer: S6 C6 answers 503 also for an organization-list failure, an
  incomplete matches read, a failed job read, and ANY property's flag read
  (`plan-draft-S6.md:66-71`; code `:1076-1085`, one failed
  `getOpenCandidateFlags` fails the whole read).
- Breaks: a single candidate property's flag-read failure blanks the page,
  which the spec scopes to the one candidate. (The org-list, matches and job
  cases are defensible extensions - the pool cannot be computed, and an
  unread pair must never read "not ranked yet" - but they are spec departures
  the plan head has not ruled.)
- Resolution: S6 degrades a per-property flag-read failure to that
  property's rows (`unverified`, no flags listed for it) instead of 503; the
  org-list / matches / job 503s go to the planner as a named ruling (record
  in section 4 if kept). Change: S6 (plus a planner ruling).

### IR26 - S7.12 drives the Notes box with an exact label the form cannot satisfy

- Producer: S1 keeps the contact edit form's Notes control a WRAPPING label
  (`plan-draft-S1.md:197-202`; the tree: dashboard/src/routes/contact/ContactEditForm.tsx:1190-1197).
  e2e/support/selectors.md:143 records that an exact `getByLabel('Notes')` on
  a wrapping label "only matches while the box is empty" and prescribes
  `getByLabel(/^Notes/)`.
- Consumer: S7.12 creates the tenant WITH notes (`plan-draft-S7.md:4761`)
  and then uses `getByLabel('Notes', { exact: true })` (`:4772`, `:4777`,
  `:4788`); N5 asserts the name is "exactly 'Notes'" (`:186-191`).
- Breaks: the first `fill` times out; the e2e spec fails.
- Resolution: producer. S7.12 uses `dialog.getByLabel(/^Notes/)` for the
  three Notes calls (First name stays exact: an input's value is not label
  text); S7 N5 is corrected. S1's `role="alert"` panel, its copy
  (`plan-draft-S1.md:2603`, `:2720`) and both asserted phrases otherwise
  match S7.12. Change: S7.

---

## C. Cosmetic (no compile or runtime break today; drift or duplication)

### IR27 - The event's `batchesDone`: a count on the server, an array on the page

- S5 sends a COUNT of finished batches (`plan-draft-S5.md:76-81`,
  `toRankingEvent` `:2820-2829`); S7 types `batchesDone: number[]`
  (`plan-draft-S7.md:169-174`, `:599-606`). S7 never reads the field (it
  re-reads the job on any event for its anchor, `:1714-1718`), so nothing
  breaks today; the type is a lie a later reader would trip on.
- Resolution: producer. S7 types `batchesDone: number` with S5's meaning
  ("finished batches, scored or failed"); WI16's key set is unchanged.
  Change: S7.

### IR28 - How a seen home that IS the property anchor is referenced

- S3 recommends an `anchor` handle (`plan-draft-S3.md:358-362`); S4 C10
  applies the spec literally and lists it as an ordinary `h<n>` home, its
  card written a second time (`plan-draft-S4.md:116-121`). Both work: S3's
  `homes` includes the anchor unit when a tenant card lists it
  (`plan-draft-S3.md:4726-4729`, `:5307-5310`).
- Resolution: keep S4's (spec D4 names only the candidate exception); strike
  S3's recommendation from its cross-slice notes. Change: S3 (note only).

### IR29 - Helpers re-implemented in later slices instead of imported

- S5 `mapPool` (`plan-draft-S5.md:2082-2098`) duplicates S3
  `mapWithConcurrency` (`plan-draft-S3.md:64`); S5 `runLog.ts` re-defines
  `gzipBase64`, a 350 KB constant and the size guard
  (`plan-draft-S5.md:2367`, `:2391-2393`, `:2461-2464`) that S2 exports and
  `putRun` already applies (`plan-draft-S2.md:128`, `:4718`, `:4827-4831`,
  `:4839`); S5 `RANKJOBS_*` (`:1846-1847`) duplicate S2's entity constants
  (`:3746-3747`); S5 `accommodationFieldsOf` (`:2387-2389`, used by S6
  `plan-draft-S6.md:499`) duplicates S4 `flagFieldsOfKind(flags, 'accommodation')`
  (`plan-draft-S4.md:164`); S6 `pairKey` (`:582-584`) duplicates S2
  `matchPairKey`; S6 spells `'rankings#global'` / `rankings#<kind>#<id>`
  (`:2135`, `:2279`) instead of S2 `rankingRunEntityKey`; S5 computes TTLs
  inline instead of S2 `rankingExpiresAt`; S5 derives `directionOf` rather
  than reading `AssembledRanking.direction`.
- Resolution: S5 and S6 import the earlier slice's helper (PR7's spirit: one
  definition). S5 builds a `RankingRunRecordInput` and lets `putRun` add the
  key, kind and guard. Change: S5, S6.

### IR30 - The reader-scan test is edited twice for the same files

- S3.1 already scans `adapters/ranking.ts` and `adapters/rankingFake.ts`
  through `RANKING_DRIVERS` filtered by `existsSync`
  (`plan-draft-S3.md:798-804`; note `:372-376`); S4.8 / S4.9 also add both to
  `READERS` (`plan-draft-S4.md:3470-3483`, `:3998-4008`), so each file is
  scanned twice.
- Resolution: S4 drops both 1a edits and instead asserts in its driver test
  that both files exist (S3's suggestion), so the `existsSync` filter is never
  vacuous. Change: S4.

### IR31 - S7's `RankingJobView` declares fields the server never sends

- S7 adds `anchorKind`, `anchorId` (`plan-draft-S7.md:404-405`; N1 `:126`);
  S5's `jobView` emits neither (`plan-draft-S5.md:2043-2079`). No S7 code
  reads them. Also S7 types `batchCount?` (S5 always sends a number) so the
  "Ranking..." branch of `jobStatusText` (`plan-draft-S7.md:1168`) is
  unreachable and a running job before its pool is built reads "0 of 0".
- Resolution: S7 drops the two fields and types `batchCount: number`
  (treating `batchCount === 0` while running as "Ranking..."). Change: S7.

### IR32 - S7's 503 fixture uses an error code S6 does not send

- S6 answers 503 `{ error: 'ranking_unavailable', message }`
  (`plan-draft-S6.md:1602-1604`); S7's test mocks
  `ApiError(503, 'anchor_unreadable', ...)` (`plan-draft-S7.md:1505`) and its
  copy says "This record could not be read" for every 503 (`:1616`), also
  shown for an org-list failure.
- Resolution: S7's fixture uses `ranking_unavailable`; optionally render the
  server's `message`. Change: S7.

### IR33 - S6 edits `routes/api.ts` after S5 without the "re-read after S5" line

- S5 edits the SSE block of `routes/api.ts` (`plan-draft-S5.md:69-72`); S6
  edits the imports, `ApiRouterDeps` and the mounts of the same file
  (`plan-draft-S6.md:1612-1683`, `:2321-2378`). Regions differ, but plan
  section 0 requires the note.
- Resolution: S6.3 / S6.4 say "re-read after S5". Change: S6.

### IR34 - A `RankingPromptError` is recorded as failure `error`, not `driver`

- S4 asks S5 to treat a thrown `RankingPromptError` as a failed batch with
  `failure: 'driver'` (`plan-draft-S4.md:288-289`); S5 lets it escape
  `runBatch` to `runBatchSafely`, which records `failure: 'error'` and writes
  no run (`plan-draft-S5.md:3343-3367`).
- Resolution: S5 catches `RankingPromptError` around the prompt build and
  records the batch failed `'driver'` (no model call was made, so no run).
  Change: S5.

### IR35 - Optional-vs-required drift on the run record and the cost function

- S2 `RankingRunRecord.usage?` (`plan-draft-S2.md:4773`) while S5 always
  writes it and S7 renders `run.usage.inputTokens` unguarded
  (`plan-draft-S7.md:534`, `:3644`); S4 `costUsd` THROWS for an unpriced
  billed model (`plan-draft-S4.md:171`) while S5's note assumes it returns 0
  (`plan-draft-S5.md:281`) - unreachable for the configured model because S2
  refuses startup without its price, but a throw there would land after a
  paid call.
- Resolution: S7 guards `run.usage` (or S2 makes `usage` required); S5's
  cross-slice note is corrected to S4's semantics. Change: S7, S5 (note).

### IR36 - S3 published shape and S5/S6 assumed shape of `AssembleResult` differ in extras

- S3's ok result carries `direction` and `unverifiedCount`, and its anchor
  carries `record`, `fingerprint`, `authorities` (`plan-draft-S3.md:179-206`);
  S5's fixture `assembled()` / `unitAnchor()` build objects without them under
  an `as` cast (`plan-draft-S5.md:868-934`), so S5 / S6 tests exercise a shape
  production never returns (the job then derives the direction and the
  unreadable count itself, IR29).
- Resolution: the S5/S6 fixture (now `rankingJobFixtures.ts`, IR1) builds
  `AssembledRanking` and `VerifiedCandidate` values with every field and no
  `as` cast, so the compiler checks the fixtures against S3. Change: S5.

---

## D. Checked and consistent (no IR)

- `RANKING_SUPPORTED_MODELS`, `DEFAULT_AI_PRICE_TABLE`, `AiPrice`,
  `RankingEffort`: defined once in S2 `lib/config.ts`
  (`plan-draft-S2.md:96-106`, `:586-597`); S4 imports them and only
  re-asserts the model set in `createRankingDriver` (`plan-draft-S4.md:106-114`,
  `:123-129`); S8 imports them (`plan-draft-S8.md:2321`).
- "Current model" under the fake driver: S4's fake stamps `model: 'fake'` /
  `'console'` (`plan-draft-S4.md:3912`), S5 writes `call.meta.model` onto the
  row, S6 `currentRankingModel` compares against the driver literal for
  non-anthropic drivers (`plan-draft-S6.md:577-579`), matching S7 N10 and
  spec D6. Consistent.
- The dev tick: S5 `POST /__dev/ranking/tick`, no body, no session, 200
  `{ ok, expired, claimed, tookOver, failedStale }` after its jobs finish
  (`plan-draft-S5.md:4438-4457`); S7's fixture checks `res.ok()` only
  (`plan-draft-S7.md:4074-4077`; N4). Consistent; the lane env
  (`RANKING_DRIVER: 'fake'`, `RANKING_WORKER_POLL: 'off'`) matches S7.10's
  prerequisite grep.
- "Anchor not found": S3 `computePool` (`plan-draft-S3.md:304-310`) and S5
  `rankingAnchorExists` (`plan-draft-S5.md:2027-2037`) apply the same rule
  (missing, soft-deleted, or a non-tenant contact as a tenant anchor). S3-F1
  and S5-F2 need one ruling, not two.
- `mergeMissing` and `anchor_unreadable` exist in S3 with the signature and
  reason S5 / S6 assume (`plan-draft-S3.md:145`, `:207`).
- The `ranking.updated` event name, the SSE listener and the dashboard
  listener agree (`plan-draft-S5.md:347-412`; `plan-draft-S7.md:892`).
- PR4 config field names: S2's `RankingConfig` (`plan-draft-S2.md:600-660`)
  matches every `Pick<AppConfig, ...>` in S3-S6 and S8.
- S2's `getPairs`, `getRun`, `listRuns`, `getJob`, `getOpenCandidateFlags`
  signatures match S6's calls.
- S1's conflict panel (`role="alert"` inside the Edit contact dialog, the
  "Nothing was saved." and "These notes were changed since you opened this
  form." text) matches S7.12 apart from the label selector (IR26).

---

## E. Edits per draft

| Draft | IRs | Count |
|---|---|---|
| plan-draft-S1.md | none | 0 |
| plan-draft-S2.md | IR3, IR19 (both: `RankingRunResult`); IR2 only if the live job message is kept | 2 |
| plan-draft-S3.md | IR7, IR8, IR9, IR17, IR28 | 5 |
| plan-draft-S4.md | IR30 | 1 |
| plan-draft-S5.md | IR1, IR2, IR4, IR5, IR6, IR8, IR12, IR13, IR14, IR19, IR23, IR29, IR34, IR35, IR36 | 15 |
| plan-draft-S6.md | IR1, IR4, IR6, IR8, IR10, IR11, IR15, IR18, IR19, IR20, IR21, IR24, IR25, IR29, IR33 | 15 |
| plan-draft-S7.md | IR4, IR18, IR19, IR22, IR26, IR27, IR31, IR32, IR35 | 9 |
| plan-draft-S8.md | IR16 | 1 |

Rulings the planner still owes that these resolutions lean on: S5-F1
(IR22), S4-F2 (IR13), S7-F1 (settled field by field by IR4, IR18-IR21,
IR27, IR31), the IR19 choice (stored `missing` vs `unknowns` labelled
missing), and the IR25 503 scope.
