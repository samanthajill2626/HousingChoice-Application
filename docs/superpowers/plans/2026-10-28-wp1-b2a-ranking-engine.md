# Implementation plan - WP1 B2a Ranking engine

- Spec (the contract - read it in full before Task S1.1):
  `docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md`
  (rev 6, APPROVED; Cameron passed the spec gate 2026-10-28, answers in its
  section 10). "Spec Dn" means its decisions D1-D19; "spec N" its numbered
  sections.
- Charter: `docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md`
  (amended on this branch through section 20 item 14). Charter decisions
  bind.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:\tmp\wp1-b2-ranking-engine`,
  cut from main @404e039d. Mission records:
  `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/`.
- Spec review: 4 rounds, 63 findings, 0 rejected -
  `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/design-review/adjudications.md`.
- Status: PLAN v1 DRAFT (2026-10-28). Sections 0-4 and 13 are BINDING and
  written by the planner; slice sections 5-12 (S1-S8) are opus section drafts
  assembled verbatim (findings in `plan-drafts/`). Section 4 (planner
  rulings PR1-PRnn) wins over any slice text it contradicts. "Plan section
  N" always means this file's top-level sections.

## 0. Ground rules for this plan

- Precedence: section 4 rulings win over slice text; a ruling that departs
  from spec TEXT is listed for Cameron at the launch gate, and his go is
  the approval. Section 1's "the spec wins on any doubt" governs anything no
  ruling addresses.
- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case, except a task the plan marks comment-only, docs-only or
  fixture-only.
- Setup, once, before S1: the worktree has NO `node_modules`. Run `npm ci`
  at the worktree root (bare; expect exit 0). Never symlink another
  worktree's node_modules. No new dependency is added by this plan (gzip
  is `node:zlib`, hashing is `node:crypto`).
- Every git command carries `-C W:/tmp/wp1-b2-ranking-engine` (the shell
  cwd resets to the SHARED main checkout between calls; a bare `git add` /
  `git commit` there commits someone else's index onto main).
- Commits: a separate bare `git -C W:/tmp/wp1-b2-ranking-engine status`
  read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\wp1-b2-ranking-engine\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name). Use repeated `-m` arguments, or a message
  file OUTSIDE the worktree.
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for a new file;
  for a pre-existing file that already carries non-ASCII, only ADDED lines
  must be ASCII:
  `git -C W:/tmp/wp1-b2-ranking-engine diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints 0. Never "fix" a pre-existing non-ASCII string a test pins.
  U+2028 / U+2029 in tests (S1) are written as the six-character escapes
  `\u2028` / `\u2029` inside string literals, never as raw characters; the
  Edit/Write tools DECODE `\u` escapes, so after any edit near one, grep
  that the six-character escape survived.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool.
- App tests run from `W:/tmp/wp1-b2-ranking-engine/app` with DynamoDB
  Local running (`npm run db:start`). If `env | grep '^AWS_'` shows an
  exported `AWS_ACCESS_KEY_ID`, prefix every app vitest command with
  `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY`. Dashboard tests run
  from `W:/tmp/wp1-b2-ranking-engine/dashboard`.
- Line numbers in slice text are HINTS against main @404e039d; the QUOTED
  text is the anchor. A later slice that edits a region an earlier slice
  rewrote says "re-read after Sn" and applies ON TOP, never reverting.
- Never pipe or `;`-chain a gate command; run it bare and read its real
  exit code. Never test against the live `:5174` / `:8080`; e2e only via
  `npm run e2e` (hermetic). Never edit dashboard or app source while this
  worktree's e2e runs.

## 1. Global constraints (from the spec; the spec wins on any doubt)

- No agent runs a real model, reads `ANTHROPIC_API_KEY` or the testing
  key, or runs `extraction-schema-compile-check.ts` /
  `ranking-counterfactual-check.ts` against the API (spec D16, D17; PR1).
- No infrastructure change, no new table, no new index, no Terraform, no
  deploy, no secret push (spec 7).
- Vendor SDK imports live only in `app/src/adapters/` (the one new import
  site is `adapters/ranking.ts`); services depend on the driver interface.
- No switch: the ranking poll always starts (charter item 12), except the
  hermetic-only `RANKING_WORKER_POLL=off` (refused in production).
- A default or guessed score is never written (charter 7.4): a candidate
  the model did not score gets no new match.
- One card definition per record, whichever side of the ranking it is on
  (charter 6.2); cards are allowlists at runtime (charter 6.1).
- The event `ranking.updated` never carries a score, a name or a card
  field.
- Express middleware order stays locked (AGENTS.md); the rank limiter
  mounts the way the broadcast send limiter does.
- New user-facing copy is plain and short; dashboard pages full width.
- Typed input is trimmed before store or compare; codes and names compare
  with case and spacing folded, never fuzzy (Cameron's standing rule).

## 2. Work map (build order; each slice ends with its report and commit)

| Slice | Scope | Depends on |
|---|---|---|
| S1 | The Notes box: line-break collapse helper shared with the transcript, `duplicate` count and `notesDuplicate` on the run record + dashboard twin + run detail, `notes_updated_at` stamped by every Notes writer, the PATCH `notes_expected_updated_at` guard and `notes_stale`, the edit form's conflict panel, the staff_notes comment (spec D14, D15) | - |
| S2 | Foundations: every D19 config variable (fail-fast, production refusals, `AI_PRICE_TABLE`, the API-key requirement), B1 list `completeness` + mirror + drift test, `unitsRepo.getManyByIds`, `placementsRepo.hasActivePlacementForOtherTenant`, `matchesRepo`, `rankingRunsRepo` (job, run, pointer and flag families), the lean seed's legacy match row removed, the tables.ts comment, the extraction-log exclusion pins (spec D6 config, D8, D11 keys, D19, spec 5) | S1 |
| S3 | Pool and cards: `pool.ts`, `cardFields.ts` + the classification test, `cards.ts`, the seen set and `seenFeedback.ts`, pair history and the tour projection, `completeness.ts`, `fingerprints.ts`, `assemble.ts` (the one gatherer the job and the read share), B1's reader-test scan widened (spec D1, D2, D3, D13) | S2 |
| S4 | The model call: `rubric.ts`, `examples.ts`, `prompt.ts` (handles, `homesSeen`, `promptFingerprint`), `schema.ts` + offline shape test, `parse.ts`, `bands.ts`, `cap.ts`, `cost.ts`, the driver interface, `adapters/ranking.ts`, `adapters/rankingFake.ts` (fake + console), the compile-check's two `ranking` variants (spec D4, D5, D6, D9 bands and cap) | S3 |
| S5 | The job: claim / join / 409, the ranking poll with expiry, lease, renewal, takeover and the in-process limit, the fresh context, batches in parallel, match / run / pointer / flag writes, `flags.ts`, the `ranking.updated` event (server side), the worker poll, `POST /__dev/ranking/tick`, the hermetic lane env (spec D7, D8 writes, D10, D11, D12 event) | S4 |
| S6 | The read and the API: `readRanking.ts` (bands, cap, out of date, sort, not ranked / not scored, the ceiling), the rankings router (rank, read, job) with roles and the rate limit, the admin rankings router (runs, run detail, cost), the 150-tenant read budget measured (spec D9, D12) | S5 |
| S7 | Dashboard and e2e: the Rankings settings tab, runs list, run detail, "Rank this anchor" panel with job polling and the event, API client types, `EventStreamProvider`, every new e2e spec (ranking flows and the Notes conflict) (spec D18, spec 6 e2e) | S6 |
| S8 | The merge-gate scripts and docs: `ranking-counterfactual-check.ts` + synthetic data + `--timing` + offline stub-driver tests, `gate-run-commands.md`, RUNBOOK, GLOSSARY, env example files, the issue registry updates (spec D17, spec 5 docs) | S7 |
| S9 | Sync main once, the five gates, self-QA on the hermetic lane, the handback (plan section 13) | S8 |

Slices are strictly serial. S1 is independent of the ranking code and goes
first so the extraction and contacts edits land before anything reads the
Notes box.

## 3. Watch items (each is checked and the result recorded in a slice report)

- WI1 `matches` writers: ONLY the ranking job writes it (S5). The lean
  seed's legacy row is removed (S2); a repo grep for the matches table
  name (`tableName('matches')` / `TABLES.matches` / the string) is recorded
  in the S2 report and lists no other writer. Readers: the read (S6), the
  run detail's "since re-scored" lookup (S6), tests. A row without
  `schema: 2` is ignored by every reader (S2 test). (S2, S5, S6)
- WI2 AI runs table families `rjob#`, `rrun#`, `ptr#rankings#...`,
  `uflag#`: never returned by `GET /api/ai-runs` (list) or
  `GET /api/ai-runs/:runId` (detail), never read by
  `aiRunsRepo.listByEntity`; `jobs/journalSweep.ts`, `routes/dev.ts`
  (reseed / sweeps) and `lib/performanceSeed.ts` are read and the S2
  report says whether each scans by prefix and why the new families are
  safe. Pins are S2 tests. (S2)
- WI3 Every writer of a contact's `notes` stamps `notes_updated_at` in the
  same write: the contacts PATCH, manual create, extraction apply, the
  importer's overwrite. S1 greps for every other `notes` writer (public
  sign-up, caseworker conversion, merges, contact capture, seeds, dev
  routes) and the S1 report lists each with "writes notes: yes/no" and
  what it does about the stamp. (S1)
- WI4 `notes_updated_at` joins `SERVER_OWNED_CONTACT_FIELDS` (a client
  write is refused) and is EXCLUDED from the tenant card (S3 registry).
  (S1, S3)
- WI5 The extraction PROMPT TEXT is byte-unchanged (its prompt fingerprint
  test stays green unchanged); only the transcript line folding gains
  U+2028 / U+2029 (spec D14.1). (S1)
- WI6 The fake and console ranking drivers and `RANKING_WORKER_POLL=off`
  are refused under `NODE_ENV=production`; every new variable parses
  fail-fast; production requires `ANTHROPIC_API_KEY` whatever
  `AI_EXTRACTION_ENABLED` says; `ANTHROPIC_API_BASE_URL` stays refused in
  production. Existing config tests that build a production config gain
  the key where they now need it, each named in the S2 report. (S2)
- WI7 No test, the hermetic stack or any script run by an agent reaches
  the network or reads `ANTHROPIC_API_KEY`. The two real-model scripts
  are unit-tested with stub drivers only. (S4, S8)
- WI8 B1's `tenantMatchingInputsReaders` scan gains
  `app/src/services/ranking/`; `examples.ts` is its only exemption; the
  fake driver (in `adapters/`) finds its inputs through the list by `kind`
  / entry, never a spelled key. (S3, S4)
- WI9 `unitsRepo.getDisplaysByIds` and its callers are byte-unchanged;
  `getManyByIds` is a new function. (S2)
- WI10 The lean seed stays byte-stable apart from the removed match row;
  seed stability tests change only for that, with the reason in the S2
  report. No seed writes a contact's `notes` or `notes_updated_at`. (S1,
  S2)
- WI11 Fingerprint invariants (spec D13), each a named S3 test: a bare
  send, a re-send that re-orders, a ninth send that pushes an entry off
  the listed ones, the first send of a home a Notes line already names, a
  tour reminder or roster change, an edit to a home with feedback only -
  each changes NO fingerprint; a decline, a tour, a feedback line on any
  property, and an edit to any card field of a seen home with a decline
  or tour change the tenant fingerprint. (S3, S6)
- WI12 One card definition per record: `tenantCard` / `propertyCard` are
  the only card builders; the job, the read, the counterfactual check and
  seen homes all call them. (S3, S5, S6, S8)
- WI13 One cap function (`cap.ts`) serves the read, the run's
  `cappedAtRun` and the counterfactual check. (S4, S5, S6, S8)
- WI14 The job's log lines carry the press's `requestId` (fresh
  `runWithContext`, no `pollRunId` / `jobRunId`); a test reads the logger
  output. (S5)
- WI15 Ticks overlap (unref'd `setInterval`, no await): the in-process job
  counter and the conditional claims are tested with two overlapping
  ticks and with two pollers. (S5)
- WI16 The event payload carries only `{ anchorKind, anchorId,
  generation, status, batchesDone, batchCount }`; a test asserts the exact
  key set. (S5)
- WI17 Roles: va can rank, read and poll the job; only admin reaches
  `/api/admin/rankings/*` and the Rankings tab. (S6, S7)
- WI18 The 150-tenant property read completes under 5 s on the hermetic
  stack; the measurement and its number are in the S6 report. A miss is
  fixed in S6 (batch the per-tenant reads), never by dropping the
  out-of-date test. (S6)
- WI19 e2e: the lean world has no available unit and one searching
  tenant; every ranking spec builds its fixtures through the API, uses a
  unique per-spec name, and runs jobs only through
  `POST /__dev/ranking/tick`. No existing spec reads the legacy match row
  (S2 greps e2e/ and records it). (S2, S7)
- WI20 The anchor tenant's own active placement does not exclude a unit
  from a tenant anchor's pool. (S3)
- WI21 The schema stays at most five object nodes, zero optional
  parameters, `additionalProperties: false`, no numeric or length bounds
  (offline test). (S4)
- WI22 The unlawful-flag field list (spec D5) is confirmed against
  `UnitItem`: each named free-text field is stored as a string; the S4
  report quotes the type line of each. (S4)

## 4. Planner rulings (binding; win over slice text)

- PR1 THE REAL-MODEL RUNS ARE CAMERON'S. No agent runs the compile check
  or the counterfactual check against a real model, reads the testing key,
  or writes the counterfactual record. S4 and S8 build and unit-test the
  scripts with stub drivers; S8 writes `gate-run-commands.md`. A script
  may be run with `--dry-run` ONLY when `ANTHROPIC_API_KEY` is unset in
  that shell (it calls nothing and prints the plan). The orchestrator
  hands back "merge-ready PENDING Cameron's real-model runs".
- PR2 File ownership by slice, so a later slice never re-decides an
  earlier one:
  - S1: `services/extraction/apply.ts` note path, the shared one-line
    helper (`lib/singleLine.ts`, PR10), `services/extraction/prompt.ts`'s
    `toSingleLine` call site, the extraction run record's
    `notesDuplicate` (app + dashboard twin + AiRunDetail), the contacts
    route Notes guard, `contactsRepo.ts` (the stamp and the comment),
    `possibleCaseworkers.ts` comment, `lib/import/apply.ts` stamp, the
    contact edit form.
  - S2: `lib/config.ts` and its tests, `lib/tenantMatchingInputs.ts`
    `completeness` + the dashboard mirror and drift test, `unitsRepo`,
    `placementsRepo`, `repos/matchesRepo.ts`, `repos/rankingRunsRepo.ts`,
    `lib/tables.ts` comment, `seed/lean.ts`.
  - S3: `services/ranking/{types,pool,cardFields,cards,seenSet,seenFeedback,pairHistory,completeness,fingerprints,assemble}.ts`
    and `app/test/tenantMatchingInputsReaders*` scan widening.
  - S4: `services/ranking/{rubric,examples,prompt,schema,parse,bands,cap,cost,driverTypes}.ts`,
    `adapters/ranking.ts`, `adapters/rankingFake.ts`,
    `scripts/extraction-schema-compile-check.ts`, RUNBOOK "Changing a
    structured-output schema" (that one subsection only).
  - S5: `services/ranking/{job,runBatch,flags,runLog}.ts`, `lib/events.ts`
    and the SSE handler / event bridge entries, `worker.ts`,
    `routes/dev.ts` tick, `scripts/e2e-session.mjs` env.
  - S6: `services/ranking/readRanking.ts`, `routes/rankings.ts`,
    `routes/adminRankings.ts`, their mount in `routes/api.ts`.
  - S7: everything under `dashboard/src` for rankings, the dashboard API
    client and types for rankings, `EventStreamProvider`, every new
    `e2e/` spec and helper.
  - S8: `app/scripts/ranking-counterfactual-check.ts`,
    `app/scripts/rankingCounterfactual/`, `gate-run-commands.md`, RUNBOOK
    (all other ranking sections), GLOSSARY, `.env*.example`, `docs/issues/`.
  A file names its owner slice; another slice that must touch it says so
  in its Cross-slice notes and the planner rules.
- PR3 Module map and the names other slices rely on (the drafts may add
  exports; they may not rename these):

  ```ts
  // services/ranking/types.ts - a LEAF: imports only `import type` from repos.
  export type AnchorKind = 'unit' | 'tenant';
  export interface AnchorRef { kind: AnchorKind; id: string }
  export type AnchorNote = 'not_searching' | 'not_sendable' | 'not_available';
  export type Card = Record<string, unknown>;          // registry key order
  export interface MissingFlag { key: string; label: string }
  export interface TourProjection { status: string; outcome: string | null; scheduledAt: string | null }
  export interface SendFact { at: string; kind: 'sent' | 'signed_up' }
  export interface PairHistory {
    sends: SendFact[]; declined: { by: string; at: string } | null;
    tours: TourProjection[]; daysSinceLastSend: number | null;
  }
  export interface CardFingerprints { tenantCard: string; unitCard: string; pairHistory: string }
  export type Direction = 'tenants_for_property' | 'properties_for_tenant';

  // services/ranking/pool.ts
  export function computePool(anchor: AnchorRef, opts: { includeOlder: boolean; now: Date }, deps: PoolDeps): Promise<PoolResult>;
  // PoolResult: { ok: true; anchorRecord; candidates (pool order); anchorNotes; authorities: { mapped: string[]; unmapped: string[] } }
  //           | { ok: false; reason: 'anchor_not_found' | 'org_list_failed' | 'pool_too_large'; size?: number; message: string }

  // services/ranking/cards.ts
  export function tenantCard(contact: ContactItem, ctx: TenantCardCtx): Card;
  export function propertyCard(unit: UnitItem, ctx: PropertyCardCtx): Card;
  export function propertyFacts(unit: UnitItem, ctx: PropertyCardCtx): { recordedRequirementKeys: string[]; freeTextByField: Record<string, string> };

  // services/ranking/assemble.ts - the ONE gatherer the job and the read share
  export function assembleRanking(anchor: AnchorRef, opts: { includeOlder: boolean; now: Date }, deps: AssembleDeps): Promise<AssembleResult>;
  // AssembleResult ok: { anchor: { ref, display, card, missing, anchorNotes, fingerprints part },
  //   candidates: AssembledCandidate[] (pool order; each has tenantId, unitId, candidateId,
  //   display, hasConsent?, priority?, card, missing, pairHistory, fingerprints,
  //   propertyFacts of the pair's property, unverified: boolean),
  //   homes: Map<unitId, { label: string; card: Card }> (every seen home any tenant card references) }

  // services/ranking/bands.ts, cap.ts
  export type Band = 'strong' | 'good' | 'possible' | 'weak';
  export function bandOf(score: number): Band;
  export function capOf(input: { failedRequirements: string[]; accommodationFields: string[];
    recordedRequirementKeys: string[]; openUnlawfulFields: string[] }): { capped: boolean; capReason: 'requirement not met' | null };

  // services/ranking/driverTypes.ts (no SDK import)
  export interface RankingDriver { kind: 'anthropic' | 'console' | 'fake'; rankBatch(input: RankingBatchInput): Promise<RankingCall> }

  // services/ranking/job.ts
  export function claimRanking(anchor: AnchorRef, press: { includeOlder: boolean; requestedBy: string; requestId: string; traceparent?: string }, deps): Promise<{ status: 202; job; joined: boolean } | { status: 409; error: 'ranking_running' } | { status: 404 }>;
  export function runDueRankings(nowIso: string, deps: RankingJobDeps): Promise<void>;
  export function rankAnchor(job: RankingJobRecord, deps: RankingJobDeps): Promise<void>;

  // services/ranking/readRanking.ts
  export function readRanking(anchor: AnchorRef, opts: { includeOlder: boolean; now: Date }, deps): Promise<RankingRead>;
  ```

  Persisted record types live in their repos (`MatchRow` in
  `matchesRepo.ts`; `RankingJobRecord`, `RankingRunRecord`,
  `RankingPointer`, `UnlawfulFlagRecord` in `rankingRunsRepo.ts`), never in
  services. S3 publishes the exact `AssembleResult` / `PoolDeps` /
  `AssembleDeps` shapes at the top of its section; S4-S6 drafts code
  against the names above and flag any shape they need in Cross-slice
  notes.
- PR4 Config fields are flat camelCase on `AppConfig`, as the file's style
  is: `rankingDriver`, `aiRankingModel`, `rankingEffort`,
  `rankingMaxOutputTokens`, `rankingCallTimeoutMs`, `rankingBatchSize`,
  `rankingBatchConcurrency`, `rankingMaxConcurrentJobs`, `rankingLeaseMs`,
  `rankingQueueExpiryMs`, `rankingPoolWindowDays`, `rankingMaxPool`,
  `rankingSeenMax`, `rankingMaxAgeDays`, `rankingPairTtlDays`,
  `rankingPriorityStrength`, `rankingLandlordCard`,
  `rankingReadConcurrency`, `rateLimitRankPerMin`, `aiPriceTable`
  (`Record<string, { in: number; out: number }>`), `rankingWorkerPoll`
  (boolean). Env names are spec D19's.
- PR5 Repository APIs other slices rely on:
  - `matchesRepo`: `putMatches(rows: MatchRow[]): Promise<void>` (BatchWrite,
    unprocessed retried, throws when still unprocessed),
    `getPairs(keys: { tenantId; unitId }[], { requireComplete: true }):
    Promise<Map<string, MatchRow>>` (key `${tenantId}#${unitId}`;
    consistent base-table read; legacy rows without `schema: 2` absent from
    the map), `listByUnit(unitId)`, `listByTenant(tenantId)` (Rankings page
    only), `encodeSnapshot(obj) / decodeSnapshot(b64)` (gzip + base64).
  - `rankingRunsRepo`: job - `getJob(kind, id, { consistent })`,
    `putJobClaim(...)` (the conditional put), `listQueued(limit)`,
    `listExpiredLeases(nowIso, limit)`, `claimQueued`, `takeOver`,
    `renewLease`, `markExpiredQueued`, `updateJobProgress`, `finishJob`;
    run - `putRun(record)` + pointers in one call, `markMatchesWritten`,
    `getRun(runId)`, `listRuns({ entityKey, from, to, cursor, limit })`;
    flag - `getOpenCandidateFlags(unitId)` (all records for the unit),
    `putFlagIfAbsentOrClosed(...)`. Key builders `rankingJobItemId`,
    `rankingRunItemId`, `rankingPointerItemId`, `unlawfulFlagItemId` are
    exported.
  - `unitsRepo.getManyByIds(ids, { requireComplete: true }): Promise<Map<string, UnitItem>>`
    (100 keys per BatchGet; a failed chunk rethrows, keys still
    unprocessed after retries throw `IncompleteBatchReadError` - B1 PR16's
    precedent).
  - `placementsRepo.hasActivePlacementForOtherTenant(unitId, tenantId): Promise<boolean>`.
- PR6 The B1 list gains `completeness: boolean` on every entry
  (`area_preference` and `max_tenant_portion` true, the other two false);
  the dashboard mirror carries it and the drift test compares it.
- PR7 One cap, one band, one card: `capOf`, `bandOf`, `tenantCard`,
  `propertyCard` are called, never re-implemented, by the job's
  `cappedAtRun`, the read and the counterfactual check (WI12, WI13).
- PR8 The fake and console drivers share one rules module in
  `adapters/rankingFake.ts`; the console driver differs only in its log
  line and its `model: 'console'` stamp.
- PR9 Every new e2e spec is S7's, including the Notes edit-form conflict
  (S1 builds and unit-tests the form; S7 drives it end to end). S5 owns
  only the e2e-session env and the dev tick route.
- PR10 The one-line helper is `toOneLine(text: string): string` in a new
  leaf `app/src/lib/singleLine.ts` (each run of CR, LF, U+2028, U+2029 to
  " / "); `prompt.ts`'s private `toSingleLine` is replaced by it, and
  `filterNoteLines` calls it before the clamp.
- PR11 Hours (Cameron's hands-on hours): charter amendment 13's 24-30
  stands until the drafts are assembled; firmed in plan v2.

<!-- Slice sections 5-12 (S1-S8) are assembled here from the drafts. -->

## 13. S9 - Sync, gates, self-QA, handback

Written by the planner after assembly.
