# Page Performance Profiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each
> implementation task and superpowers:verification-before-completion before every completion
> claim. Execute this plan in order. Each checkbox is a concrete implementation or verification
> step; do not collapse slices or defer a red test to a later slice.

**Goal:** Add an on-demand, privacy-safe Chromium profiler that ranks all implemented read-only
staff pages and representative detail pages across a profiler-owned hermetic stack, the human's
existing local `:5174` stack, or a hosted dev stack, without exercising workflows or allowing an
application write during measured navigation.

**Authoritative design:** Read
`docs/superpowers/specs/2026-08-11-page-performance-profiler-design.md` before editing. The design
is frozen. If this plan and the design disagree, stop and raise the discrepancy. One wording seam
is already adjudicated: the fixed fake unmatched-email appendix in design section 11.2 exists so
the two email pages are representative; it is constant and never scaled. Interpret the older
section 7 phrase "never generated" as "never scale-generated."

**Architecture:** App-owned pure code validates the scale configuration and builds typed seed
rows. A separately guarded dev-only mutation resets only a positive e2e lane, restores lean data,
and batch-writes the performance additions. E2e-workspace tooling owns target proof, in-memory
authentication, a first-party write firewall, route resolution, CDP collection, aggregation,
comparison, privacy scanning, reports, and profiler-owned lane lifecycle. The dashboard and its
production runtime receive no profiler dependency.

**Tech stack:** TypeScript with NodeNext ESM, Express, DynamoDB Local, Vitest, Playwright Chromium,
Chrome DevTools Protocol, React route contracts, and the existing Node standard library. Add no
dependency.

## Global constraints

- Work only in `W:\tmp\page-performance-profiler` on `feat/page-performance-profiler`. Never move
  `HEAD` in the shared main checkout.
- New or touched lines are ASCII-only. Use `apply_patch`, not an encoding-lossy PowerShell rewrite.
- The normal profiler is navigation and observation only. It never clicks create, edit, send,
  upload, delete, transition, mark-read, or other workflow controls. The hermetic self-QA may open
  an inbox or email row only to prove the automatic mark-read mutation is blocked; those are
  observation surfaces, not workflow actions.
- `local` and `hosted-dev` are human-invoked targets. An agent may run either only after a human
  explicitly names that target for that run. Agent self-QA uses `hermetic` only.
- Never collect or emit request/response bodies, headers, cookies, storage state, DOM text,
  console text, raw URLs, query values, raw entity IDs, screenshots, video, HAR, or Playwright
  traces. Auth, resolver, and hermetic self-QA code may inspect response JSON in memory, must
  immediately reduce it to the required decision or boolean/count, and must never log or persist
  it.
- No new runtime dependency. Playwright remains in the e2e workspace; Vitest, TypeScript, and tsx
  are already hoisted root dev dependencies.
- Every slice ends green for `npm run typecheck` and the relevant tests. Final gates are the bare
  commands `npm run typecheck`, `npm test`, and `npm run e2e`, followed separately by the
  full-registry hermetic self-QA.
- Before every commit, run standalone `git status`, check `.git/MERGE_HEAD`, stage explicit paths
  only, and commit with `Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>`. Never use
  `git add -A`.
- Do not merge, deploy, mutate infrastructure, write secrets, edit a real `.env.*`, or clean up
  the branch/worktree.

## File structure

### New app files

| Path | Responsibility |
| --- | --- |
| `app/src/lib/seed/performance.ts` | Pure config resolution, bounds, typed row builders, fixed fixtures, and count manifest. |
| `app/src/lib/performanceSeed.ts` | Positive-lane guard, bounded BatchWrite writer, and reset-plus-append orchestration. |
| `app/test/performanceSeed.test.ts` | Pure validator/generator/relationship tests. |
| `app/test/performanceSeed.integration.test.ts` | DynamoDB Local physical/index/reader/guard tests. |

### New e2e files

| Path | Responsibility |
| --- | --- |
| `e2e/vitest.config.ts` | Restrict workspace unit tests to `performance/**/*.test.ts`. |
| `e2e/performance/types.ts` | Versioned evidence, route, target, sample, manifest, and comparison types. |
| `e2e/performance/config.ts` | CLI parsing and target-specific option validation. |
| `e2e/performance/targets.ts` | Pure local/hosted/hermetic target proof and target metadata. |
| `e2e/performance/auth.ts` | Existing-user local auth and headed hosted auth; storage state stays in memory. |
| `e2e/performance/templates.ts` | Known URL templates and resource classes. |
| `e2e/performance/redact.ts` | URL sanitization, sensitive-pattern scan, and quarantine decision. |
| `e2e/performance/mutationCatalog.ts` | Checked-in classification of every dashboard write call site. |
| `e2e/performance/firewall.ts` | Scoped Playwright routing, method enforcement, and blocked-write evidence. |
| `e2e/performance/routes.ts` | Complete typed route registry, resolvers, warm sources, and readiness contracts. |
| `e2e/performance/readiness.ts` | UI terminal-state polling plus tracked-request quiescence. |
| `e2e/performance/collect.ts` | CDP network/paint/long-task/DOM/console collection for one sample. |
| `e2e/performance/aggregate.ts` | Per-route/mode statistics and ranked tables. |
| `e2e/performance/compare.ts` | Baseline parsing, comparability labels, and metric deltas. |
| `e2e/performance/report.ts` | Run directory, JSON/JSONL/Markdown output, partial reports, and quarantine. |
| `e2e/performance/lifecycle.ts` | Same-worktree refusal, lane launch ownership, readiness, signals, and exact-child teardown. |
| `e2e/performance/selfQa.ts` | Hermetic-only pre/post state reductions for automatic-write proof. |
| `e2e/performance/cli.ts` | Top-level sequencing and process exit semantics. |
| `e2e/performance/*.test.ts` | Pure and fake-server tests for every module above. |

### Modified files

- `app/src/routes/dev.ts`
- `app/test/devGating.test.ts`
- `e2e/package.json`
- `e2e/tsconfig.json`
- `package.json`
- `AGENTS.md`
- `e2e/README.md`

## Stable contracts used across tasks

Define these in `e2e/performance/types.ts` and keep later modules on these names:

```ts
export const PERFORMANCE_SCHEMA_VERSION = 1 as const;
export const INTERCEPTION_SCOPE_VERSION = 1 as const;

export type TargetKind = 'hermetic' | 'local' | 'hosted-dev';
export type SampleMode = 'cold' | 'warm';
export type SampleStatus =
  | 'ok'
  | 'timeout'
  | 'failed'
  | 'blocked_write_dependency'
  | 'skipped_no_fixture'
  | 'skipped_fixture_not_navigable'
  | 'skipped_source_not_ready';
export type FailureReasonCode =
  | 'ready_timeout'
  | 'source_timeout'
  | 'browser_failure'
  | 'target_proof_failed'
  | 'blocked_write_prevented_ready'
  | 'fixture_absent'
  | 'fixture_not_navigable'
  | 'source_not_ready'
  | 'cleanup_failed'
  | 'privacy_scan_failed'
  | 'unexpected_failure';

export interface BlockedWrite {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpointTemplate: string;
  phase: 'source_click' | 'destination_mount';
}

export interface RequestEvidence {
  routeKey: string;
  mode: SampleMode;
  repeat: number;
  method: string;
  resourceClass: string;
  originClass: 'first_party' | 'third_party';
  endpointTemplate: string;
  queryKeys: string[];
  startOffsetMs: number;
  durationMs: number | null;
  ttfbMs: number | null;
  status: number | null;
  transferBytes: number | null;
  unmatchedApi: boolean;
}

export interface SampleResult {
  routeKey: string;
  mode: SampleMode;
  repeat: number;
  status: SampleStatus;
  readyMs: number | null;
  navigation: { ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null };
  paint: { fcpMs: number | null; lcpMs: number | null };
  longTasks: { totalMs: number; maxMs: number; count: number };
  domElements: number | null;
  apiRequestCount: number;
  apiTransferBytes: number;
  resourceRequestCount: number;
  resourceTransferBytes: number;
  blockedWrites: BlockedWrite[];
  consoleCategories: Record<string, number>;
  clientTruncated: boolean;
  terminalState: 'populated' | 'empty' | 'error' | 'unknown';
  reason: FailureReasonCode | null;
}
```

`RunConfig` is an internal-only type in `config.ts`; it may carry `baseUrl`, `loginEmail`, and a
resolved baseline path while the process is alive. `SafeRunConfig` and `TargetMetadata` are the
only config/target types accepted by report, comparison, or stdout code. They contain target kind,
safe numeric/timing/browser options, an optional hermetic count manifest, target revision status,
and structural proof codes only. They have no base URL, hostname, login email, baseline path,
credential, redirect, or generic string/error field. `toSafeRunConfig` and `toTargetMetadata` build
new allowlisted objects; they never spread or clone `RunConfig`.

`app/src/lib/seed/performance.ts` owns and exports `PerformanceSeedInput`,
`ResolvedPerformanceSeedConfig`, `PerformanceSeedManifest`,
`resolvePerformanceSeedConfig(input, anchor)`, `generatePerformanceSeed(config)`, and
`resolvePerformanceSelfQaFixtures(config)`. The last function accepts only the resolved default
scale-1 count/density configuration and returns a private in-memory map with six symbolic surface
keys and their deterministic raw IDs; that map is accepted only by `selfQa.ts` and is structurally
absent from the count manifest, reseed response, stdout, staging, quarantine, and final reports.
The e2e CLI imports only those pure exports; app runtime code never imports e2e code.

---

## Slice 1 - Workspace test wiring, scale validation, and a no-side-effect CLI

### Task 1: Make the command and configuration contract testable before any lifecycle code exists

**Files:**
- Create: `app/src/lib/seed/performance.ts`
- Create: `app/test/performanceSeed.test.ts`
- Create: `e2e/vitest.config.ts`
- Create: `e2e/performance/types.ts`
- Create: `e2e/performance/config.ts`
- Create: `e2e/performance/config.test.ts`
- Create: `e2e/performance/cli.ts`
- Modify: `e2e/package.json`
- Modify: `e2e/tsconfig.json`
- Modify: `package.json`

**Interfaces and decisions:**

- Base scale counts are contacts 100, units 25, placements 50, tours 50, conversations 100,
  broadcasts 10. Densities are 10 messages per conversation and 25 recipients per broadcast;
  scale never multiplies the density values.
- Bounds are exactly those in design section 11.4. Resolved total counts physical generated rows
  plus resolved embedded recipients and must be at most 250,000. Resolve/dedupe recipients before
  cap arithmetic.
- Capture exactly one ISO anchor in `resolvePerformanceSeedConfig`; all later time values derive
  from it. The normalized comparison manifest excludes only `anchor`.
- CLI option names are `--scale`, the eight design count/density overrides,
  `--cold-repeats`, `--warm-repeats`, `--ready-timeout-ms`, `--source-timeout-ms`,
  `--login-timeout-ms`, `--settle-ms`, `--poll-ms`, `--route-order-seed`, `--baseline`,
  `--base-url`, `--login-email`, `--browser-channel`, `--headed`, `--print-config`, and
  hermetic-only `--self-qa=narrow|full`.
- Defaults: cold 3, warm 3, settle 500 ms, poll 100 ms, ready timeout 120,000 ms, source timeout
  120,000 ms, hosted login timeout 300,000 ms, bundled Chromium, and a generated random
  route-order seed that is printed and recorded.
- Repeats and all timeouts are positive integers. `settle-ms >= poll-ms`. Local and hosted forbid
  every scale/override/self-QA option. Hermetic forbids `--base-url`, `--login-email`, `--headed`,
  and a non-default browser channel. Hosted requires HTTPS and `--headed`. Local requires exactly
  loopback port 5174. `--self-qa` requires scale 1 plus one cold and one warm repeat and rejects all
  eight entity-count/message-density/recipient-density overrides. Route-order and timeout controls
  remain available. Validation compares the resolved seed config with the default scale-1
  count/density config before any lifecycle import or lane startup.
- `--print-config` fully parses and validates, calls `toSafeRunConfig`, prints only that JSON, and
  exits before imports or calls that can inspect a pid file, open a browser, or access a URL. Its
  `seed` field is the safe resolved count/density manifest for `hermetic` and exactly `null` for
  `local` and `hosted-dev`; it never prints base URL, host, login email, baseline path, credentials,
  redirect values, or raw option values.

- [ ] Write failing tests in `app/test/performanceSeed.test.ts` for base scale, scale 100,
  independent overrides, density invariance, every lower/upper bound, integer rejection,
  recipient dedupe with contacts zero, relay clipping, total cap, and one-anchor capture.
- [ ] Write failing tests in `e2e/performance/config.test.ts` for every target/option combination,
  defaults, target refusals, comparison path parsing, table-driven rejection of every count and
  density override under both self-QA modes, acceptance of route-order/timeout controls, and error messages
  that contain option names but never option values that may be sensitive. Inject sentinel host,
  email, baseline-path, credential, and redirect strings into internal `RunConfig`; stringify
  `SafeRunConfig` and assert every sentinel is absent. Assert hermetic `seed` is counts-only and
  local/hosted `seed` is null.
- [ ] Add an end-to-end argv test that spawns
  `npm run perf:pages -- hermetic --scale=7 --print-config`, parses stdout JSON, and asserts
  `contacts === 700`. Set a hard 15-second child timeout. This test proves Windows/npm argument
  forwarding without starting a lane.
- [ ] Run `npm test -w @housingchoice/app -- performanceSeed` and
  `npm test -w @housingchoice/e2e -- config`. Expected: fail because the exports/scripts do not
  exist.
- [ ] Implement the pure config resolver and the types above. Keep seed row generation as an
  explicit `throw new Error('performance row generation not implemented')` export until Task 2;
  the CLI never calls it for `--print-config`.
- [ ] Add `"test": "vitest run"` to `e2e/package.json`; add
  `performance/**/*.ts` to `e2e/tsconfig.json`; add `e2e/vitest.config.ts` with
  `include: ['performance/**/*.test.ts']`; add only
  `"perf:pages": "tsx e2e/performance/cli.ts"` to root scripts.
- [ ] Run `npm run typecheck`, the two targeted tests, and the real argv test. Expected: all pass;
  no `e2e/.artifacts/session.pid` or performance run directory is created by `--print-config`.
- [ ] Commit the explicit Task 1 paths.

---

## Slice 2 - Typed deterministic performance world

### Task 2: Build every generated table and fixed fixture in pure code

**Files:**
- Modify: `app/src/lib/seed/performance.ts`
- Modify: `app/test/performanceSeed.test.ts`

**Exact generation policy:**

- IDs use `perf-<kind>-<zero-padded index>` and phones use reserved unique `+1555` values. Names,
  addresses, email addresses, subjects, previews, and notes are fixed fake values containing no
  imported data.
- Contacts use a ten-row type cycle of five tenants, three landlords, and two unknown contacts.
  `deleted_at` is present when `index % 7 === 0`, which distributes deleted rows across types.
  Tenant statuses cycle through `TENANT_STATUSES`; landlord statuses cycle through
  `LANDLORD_STATUSES`; unknown status is `needs_review` or `active` by parity.
- Units cycle through `LISTING_STATUSES`, use generated landlords or symbolic `lean_landlord`, and
  carry structured fake addresses. `deleted_at` is present when `index % 7 === 0`.
- Placements cycle through every `PLACEMENT_STAGES` value and link generated-or-lean tenants and
  units. Populate `stage_entered_at`, `created_at`, and `updated_at` from the anchor. A fixed subset
  of nonterminal rows has deterministic `attention` objects, and a different fixed subset has
  `stage_entered_at` older than its stage threshold, so `/api/today` has representative
  `needs_you_now` and derived `follow_ups` rows without adding forbidden deadline-table rows.
- Tours cycle through `TOUR_STATUSES`; scheduled rows include at least one row inside the anchor's
  current local calendar day and spread the remainder deterministically through the following 30
  days. All non-requested rows have the indexed time fields required by their readers. Populate
  `_schedPartition: 'tours'`, `createdAt`, and `updatedAt`. The tour resolver later computes its
  live window independently; it does not reuse this seed anchor.
- Conversations reserve every fifth requested conversation for `relay_group`. Relay groups
  alternate `open` and `connecting`; cap their total at 1,000 and convert overflow to deterministic
  1:1 types without changing the requested conversation total. All relay rows carry
  `relay_status`, valid participants, owner/pool fields required by the current readers, and a
  readable thread. Other rows cycle tenant, landlord, partner, and unknown 1:1 types.
- Generate exactly the resolved messages-per-conversation count for every generated conversation.
  Each message has a unique sortable `tsMsgId`, required channel/direction/timestamp fields, and
  no provider side effect fields. Conversation rows cycle nonzero/zero unread counts and carry the
  current reader-required last-message preview/timestamp fields.
- Scale 1 reserves six distinct self-QA fixtures under symbolic keys `contact_detail`,
  `conversation_detail`, `inbox_row`, `unmatched_email`, `tour_group`, and `placement_group`.
  `contact_detail` and `inbox_row` use different contacts and different unread 1:1 conversations;
  `conversation_detail` is an unread, open, rendered relay row distinct from the other relays;
  `unmatched_email` is one fixed `read: false` row; `tour_group` is an unread open relay owned by
  the representative tour and exactly referenced by its `groupThreadId`; `placement_group` is a
  different unread open relay owned by the representative placement and exactly referenced by its
  `group_thread`. Every conversation fixture has messages and `unreadCount > 0`, each source link
  is first-page/rendered under its declared source state, and all six raw IDs are pairwise distinct
  where their entity type permits comparison.
- Broadcasts sort newest-first by `created_at`. Index zero is always terminal `sent` when count is
  nonzero, making it first-page reachable; the remainder cycle `failed`, `draft`, `sending`, and
  `sent`. Every row has `_listPartition: 'broadcasts'`, valid stats, and a deduped recipient map.
- Append four constant unmatched-email rows, two `unmatched` and two `quarantined`, with fake
  reserved addresses and IDs shaped `um-<32 lowercase hex>`. These rows are excluded from every
  scale count but included in physical row totals.
- Parent fallback symbols are exactly `lean_tenant`, `lean_landlord`, and `lean_unit`; raw fallback
  IDs may exist in row memory but never in the returned manifest.

- [ ] Write failing tests for exact scale-1 table counts, the fixed four-row unmatched appendix,
  fixed-ratio coverage, every required key/index field, all cross-table references, unique IDs,
  unique phones, message totals, relay clipping, first-page terminal broadcast reachability,
  requested-versus-resolved recipient counts, every zero/nonzero parent-child vector, and valid
  time windows at two very different anchors. Also assert Today attention/stuck/current-day-tour
  coverage, unread/preview coverage, and the scale-1 contact/property/tour/placement/conversation/
  broadcast detail fixtures plus their source-link relationships. Deep-assert all six self-QA map
  keys, pairwise fixture separation, exact unread/read predicates, relay owner type/id, exact
  tour/placement back-references, messages, and source-page reachability. Assert the private map is
  absent when manifest/reseed-response shapes are serialized. Assert
  `resolvePerformanceSelfQaFixtures` rejects scale 0, scale 2, and every otherwise scale-1 config
  with a count or density different from the resolved defaults.
- [ ] Add compile-time `satisfies` checks so each builder returns `ContactItem`, `UnitItem`,
  `PlacementItem`, `TourItem`, `ConversationItem`, `MessageItem`, `BroadcastItem`, or
  `UnmatchedEmailItem` rather than a generic record. Do not weaken repository types or use
  `as unknown as` to force a row through.
- [ ] Run `npm test -w @housingchoice/app -- performanceSeed`. Expected: fail at the generator
  placeholder.
- [ ] Implement one named builder per physical table plus `generatePerformanceSeed`. Return
  `{ tables, manifest }`; the table keys are exactly `contacts`, `units`, `placements`, `tours`,
  `conversations`, `messages`, `broadcasts`, and `unmatched_email`.
- [ ] Run the targeted test, `npm run typecheck`, and `npm test -w @housingchoice/app`. Expected:
  all pass.
- [ ] Commit `app/src/lib/seed/performance.ts app/test/performanceSeed.test.ts`.

---

## Slice 3 - Destructive boundary and real DynamoDB proof

### Task 3: Add a positive-lane-only reset, bounded writer, and dev seam

**Files:**
- Create: `app/src/lib/performanceSeed.ts`
- Create: `app/test/performanceSeed.integration.test.ts`
- Modify: `app/src/lib/devReset.ts`
- Modify: `app/src/lib/seed/index.ts`
- Modify: `app/src/lib/seed/live.ts`
- Modify: `app/test/seedProfile.integration.test.ts`
- Modify: `app/src/routes/dev.ts`
- Modify: `app/test/devGating.test.ts`

**Interfaces:**

```ts
export async function writePerformanceSeed(deps: {
  config: AppConfig;
  tables: PerformanceSeedTables;
  maxAttempts?: number;
}): Promise<number>;

export async function resetPerformanceData(deps: {
  config: AppConfig;
  logger?: Logger;
  input: PerformanceSeedInput;
  anchor?: string;
  reset?: typeof resetLocalData;
}): Promise<PerformanceSeedManifest>;
```

Add one explicit namespace dependency:

```ts
export interface TableNamespace {
  tablePrefix: string;
  tableNameFor: (base: string) => string;
  env: NodeJS.ProcessEnv;
}

export function createPerformanceSeedReaders(deps: {
  doc: DynamoDBDocumentClient;
  config: AppConfig;
}): PerformanceSeedReaders;
```

Build the production instance from `config.tablePrefix`, not ambient `process.env`; its `env` is a
fresh object with that exact `TABLE_PREFIX`. Thread it through `resetLocalData`, `seedAll`,
`seedInboundVoiceLineHolder`, and `seedLive`. Direct table operations use `tableNameFor`; the
existing full-profile deadline/reminder/settings repo factories receive `namespace.env` through
their existing `deps.env` seam. Existing callers get a namespace derived from their current env
for backward compatibility. No test mutates `process.env.TABLE_PREFIX`.

`createPerformanceSeedReaders` is the one direct-repository integration path for proving seeded
data. It must reject a missing `config`/prefix at runtime and create a frozen
`readerEnv = Object.freeze({ TABLE_PREFIX: config.tablePrefix }) as NodeJS.ProcessEnv`. Pass
`{ doc, env: readerEnv }` explicitly to `createContactsRepo`, `createUnitsRepo`,
`createPlacementsRepo`, `createToursRepo`, `createConversationsRepo`, `createMessagesRepo`,
`createBroadcastsRepo`, `createUnmatchedEmailRepo`, `createUsersRepo`, `createSettingsRepo`,
`createAiRunsRepo`, `createPoolNumbersRepo`, `createPlacementNudgesRepo`,
`createPlacementDeadlinesRepo`, `createTourRemindersRepo`, `createActivityEventsRepo`,
`createListingSendsRepo`, `createPendingRosterActionsRepo`, and `createSuggestionResolutionRepo`.
The integration suite does not construct these readers through their optional ambient defaults and
does not call Express routes; later hermetic self-QA covers the HTTP composition path.

- `resetPerformanceData` validates before calling `reset`; requires a local DynamoDB endpoint and
  exact prefix `hc-local-<N>-` where `N` is any positive integer; rejects `hc-local-`,
  `hc-local-0-`, cloud prefixes, and absent endpoints. The real profiler still gets lanes 1 through
  16 from `resolveLane`; the wider positive guard lets integration tests use collision-free
  throwaway prefixes without weakening the explicit lane-0 refusal. It calls
  `resetLocalData(..., profile: 'lean', tableNameFor)`, then batch writes generated additions with
  the same resolver. Clearing, lean/full seeding, inbound-voice holder stamping, and performance
  BatchWrite table maps therefore cannot diverge from injected `config.tablePrefix`.
- `writePerformanceSeed` sends at most 25 requests per `BatchWriteCommand`, retries only
  `UnprocessedItems` with bounded exponential backoff plus deterministic test injection, and
  throws with table/count/attempt metadata only.
- Add `POST /__dev/performance/reseed` with route-local `json()`. Its body is
  `{ input: PerformanceSeedInput, anchor: string }`; the CLI-generated anchor is revalidated and
  the entire config is resolved again before reset. It calls `resetPerformanceData`, clears the
  session epoch cache after reset, and returns only
  `{ ok: true, manifest }`. The manifest contains counts and symbolic fallbacks, never row data.
- The router remains behind existing production/flag/local-endpoint gates; the mutation boundary
  repeats the prefix/endpoint guard.

- [ ] Write failing unit tests in `devGating.test.ts` for successful counts-only output, invalid
  input before reset, lane 0 refusal, exact positive-lane acceptance, absent route when the dev
  router is absent, and response absence of every raw ID prefix.
- [ ] Write the self-skipping DynamoDB Local integration suite using the throwaway-prefix pattern
  in `app/test/seedProfile.integration.test.ts`. Create standard tables under two unique
  high-number `hc-local-<positive>-` prefixes A and B, inject only B into the performance path, and
  delete only those two named throwaway table sets in `afterAll`.
- [ ] Integration assertions must use `createPerformanceSeedReaders` and cover all enumerated
  registry-used list/detail/index readers, contact
  cursor paging, unit/tour/placement/relay-group/broadcast reads, valid empty auxiliary readers,
  no relay truncation at 1,000 open/connecting rows, identical logical rows for the same config
  and anchor, BatchWrite retry, and guard refusal before a reset spy is called. Add an adversarial
  prefix test with two unique high-positive throwaway namespaces A and B. Write a distinguishable
  sentinel row to A; inject only B into reset, seed, and `createPerformanceSeedReaders`; prove a
  contacts list plus unit, tour, placement, conversation/message, broadcast, unmatched-email, and
  auxiliary reads see B, never A, while the A sentinel remains unchanged. Add a test that the
  integration helper rejects missing explicit config instead of falling back to ambient reader
  construction. Run it without global env mutation so Vitest concurrency cannot redirect another
  test, and delete only both named throwaway table sets in `afterAll`.
- [ ] Run the two targeted suites. Expected: fail because the module and route do not exist.
- [ ] Implement the writer, reset orchestration, and route. Reuse `resetLocalData`; do not copy its
  table-clear algorithm and do not call business routes or jobs.
- [ ] Start DynamoDB Local with `npm run db:start` if it is not already running, run
  `npm test -w @housingchoice/app -- performanceSeed`, then stop only a database instance this
  task started. Expected: unit and integration tests pass without touching lane 0.
- [ ] Run `npm run typecheck` and `npm test -w @housingchoice/app`.
- [ ] Commit the eight Task 3 paths.

---

## Slice 4 - Existing-user auth and target safety proofs

### Task 4: Make local login non-provisioning and prove each target before measurement

**Files:**
- Modify: `app/src/routes/dev.ts`
- Modify: `app/test/devGating.test.ts`
- Create: `e2e/performance/targets.ts`
- Create: `e2e/performance/targets.test.ts`
- Create: `e2e/performance/auth.ts`
- Create: `e2e/performance/auth.test.ts`

**Interfaces and order:**

- `/auth/dev-login` body becomes `{ email?: unknown; requireExisting?: unknown }`.
  `requireExisting: true` returns 404 `{ error: 'dev_user_not_found' }` without calling invite.
  Absent or false preserves current auto-provision behavior. A non-boolean supplied value returns
  400. Do not change the dashboard `devLogin()` call.
- `verifyLocalTarget` accepts only `http://localhost:5174`, `http://127.0.0.1:5174`, or IPv6
  loopback port 5174; `GET /__dev/ping` must return `dev: true` and exact `tablePrefix:
  'hc-local-'`. A lane prefix is not the human local stack.
- After the local proof, require `stdin.isTTY` and exact typed text
  `PROFILE <normalized-base-url>`. There is no flag or environment bypass. Only then POST
  `/auth/dev-login` with `{ email, requireExisting: true }`, retain storage state in memory, and
  verify `/auth/me` is admin.
- Hosted requires HTTPS and headed mode. Open `/`, let the human perform normal OAuth, and poll
  `/auth/me` until admin or timeout. Then GET `/api/system/flags` and require exact `env: 'dev'`.
  Close the login page, retain the storage-state object in memory, and never write it.
- Hermetic verifies `/__dev/ping` against the expected lane prefix and expected git commit, calls
  performance reseed on the app port, authenticates seeded founder with existing-user-only true,
  and verifies admin.
- Firewall installation is not part of this task; Task 6 installs it immediately after the proofs
  and before any measured navigation.

- [ ] Extend `devGating.test.ts` first: missing user plus `requireExisting: true` is 404 and invite
  count stays zero; false/absent still provisions; seeded existing user succeeds; malformed flag
  is 400.
- [ ] Add fake-fetch/request-context tests for loopback spelling, port, prefix, dev ping shape,
  hosted scheme, admin, exact env, timeout, local TTY refusal, typed-confirmation mismatch, and
  memory-only storage state. Assert no filesystem write API is called from auth. Feed raw local and
  hosted hosts, login emails, OAuth redirects, and response errors through target proof, then assert
  `TargetMetadata` and every thrown safe failure contain only target kind, revision/proof status,
  and closed reason codes.
- [ ] Run the targeted app/e2e tests and verify they fail.
- [ ] Implement app auth first, then target/auth modules. Sanitize every thrown message; do not
  include raw redirect URLs or response bodies.
- [ ] Run `npm run typecheck`, `npm test -w @housingchoice/app -- devGating`, and
  `npm test -w @housingchoice/e2e -- targets auth`.
- [ ] Commit the six Task 4 paths.

---

## Slice 5 - URL templates, redaction, and artifact privacy wall

### Task 5: Make sensitive evidence impossible to serialize

**Files:**
- Create: `e2e/performance/templates.ts`
- Create: `e2e/performance/redact.ts`
- Create: `e2e/performance/redact.test.ts`

**Contract:**

- Template every dashboard API/auth/dev request used by the registry, including dynamic contact,
  unit, tour, placement, conversation, broadcast, inbox, unmatched-email, settings, system,
  timeline, roster, scheduled-message, media-metadata, and mark-read routes.
- Template non-API entity paths, especially `/unit-media/:unitId/:mediaKey` and known `/public/**`
  shapes. Static files reduce to asset classes such as `document`, `script`, `style`, `font`,
  `image`, and `other`; external URLs reduce to `third_party` with no host/path.
- Known query strings retain sorted names only. An unknown first-party API path becomes
  `unmatched_api` plus method/resource class/segment count. No raw segment survives.
- Every caught network, browser, target, resolver, readiness, cleanup, or filesystem error is
  reduced at its catch boundary to a closed `FailureReasonCode` plus optional numeric/status
  facts. Raw `Error.message`, stack, command line, URL, and response text are discarded before the
  result reaches CLI, partial-report, quarantine, or stdout code. Privacy scanning remains a final
  backstop, not the mechanism that makes ordinary failure artifacts safe.
- `scanArtifactText` uses substring patterns derived from repository ID constructors/prefixes for
  `contact`, `unit`, `conv`, `tour`, `placement`, `bcast`, `broadcast`, `user`, `msg`, `um`, and
  `perf`, production UUID forms, seed numeric/slug forms, bare UUIDs, ULID-like tokens,
  `um-<32hex>`, E.164, email, cookie/auth/token patterns, and encoded variants. Exempt only exact
  checked-in template literals and `:placeholder` tokens.

- [ ] Write adversarial failing tests for phone, email, URL encoding, cursor, every production and
  seed ID kind, unmatched-email hex ID, UUID, ULID, slug-tail IDs, an ID embedded inside longer
  text, unknown endpoints, static assets, unit media, public paths, and third-party origins.
- [ ] Add a positive test that serializes every known template and passes the final scan. Add
  negative tests that one real-shaped ID of every kind fails. Tests must verify the sanitizer
  output itself never includes the input value.
- [ ] Throw adversarial errors containing all sentinel forms at target, resolver, collector,
  cleanup, and report seams. Assert the persisted `reason`, partial report, quarantine result, and
  CLI stderr contain only stable reason codes and safe numeric facts.
- [ ] Run `npm test -w @housingchoice/e2e -- redact`. Expected: fail because modules are absent.
- [ ] Implement with allowlisted output fields only. Do not build an object containing raw URL and
  delete fields later; transform directly from the URL object into sanitized evidence.
- [ ] Run targeted tests and `npm run typecheck`.
- [ ] Commit the three Task 5 paths.

---

## Slice 6 - Complete mutation inventory and enforced write firewall

### Task 6: Mechanically pin every dashboard mutation and block automatic writes

**Files:**
- Create: `e2e/performance/mutationCatalog.ts`
- Create: `e2e/performance/mutationCatalog.test.ts`
- Create: `e2e/performance/firewall.ts`
- Create: `e2e/performance/firewall.test.ts`

**Mutation completeness invariant:**

- Use the existing `typescript` compiler API in the test to recursively parse non-test `.ts` and
  `.tsx` files under `dashboard/src`. Detect exported/local functions that call `request` or
  `requestWithStatus` with POST/PUT/PATCH/DELETE, every direct `fetch` call, and every
  `XMLHttpRequest.open` call. A missing fetch method is proven `GET`; a static literal method is
  normalized; any computed, spread-derived, aliased, or otherwise unprovable method fails the
  inventory until the scanner or catalog gives it an explicit safe classification. Fingerprint by
  repository-relative file, enclosing symbol, method class, and literal/template path category;
  never by line number.
- `DASHBOARD_MUTATION_CATALOG` classifies every discovered fingerprint as
  `automatic_navigation` or `workflow_only`, and as `first_party_api` or
  `outside_interception`. The exact discovered and cataloged fingerprint sets must match both
  ways, so new call sites fail the test.
- The current automatic-navigation family is fully enumerated: contact detail through
  `markInboxRead`, relay conversation detail through `markConversationRead`, inbox row opening
  through `markInboxRead` or `markConversationRead`, email row observation through
  `markUnmatchedRead`, and tour/placement communication channels through the same inbox or
  conversation mark-read endpoints. Every automatic entry must sanitize to an intercepted
  first-party API template.
- Direct-to-storage media upload and all create/edit/send/delete/transition actions are
  `workflow_only`; their existence stays cataloged, but navigation never triggers them.

**Firewall contract:**

- Intercept first-party `/api/**`, `/auth/**`, and `/__dev/**` only. Named stream exclusions include
  `/api/events`; route them without handler latency. Allow GET, HEAD, OPTIONS. Abort POST, PUT,
  PATCH, DELETE before the fake origin observes them. Fail on any other method in the scoped set.
- Block service workers in browser context options. Record only method, sanitized template, and
  phase. Cold traffic is always `destination_mount`. For a warm sample, start a fresh recording
  token immediately before the timed click and classify each blocked request from its frame's
  current sanitized page URL at interception time: the exact prepared source URL is
  `source_click`, the resolved destination route is `destination_mount`, and any third page URL
  fails the sample. Do not use a shared mutable phase toggle; same-document React Router
  navigation can race such a toggle.

- [ ] Write the AST inventory test and run it once to obtain the complete discovered set. Populate
  the checked-in catalog with every result and the classification above; do not weaken discovery
  to make the list shorter.
- [ ] Write fake HTTP origin tests showing all read methods reach the server, all four write
  methods do not, `/api/events` remains open/usable, non-scoped static/public/storage requests are
  not intercepted, URL-at-interception phase tags separate source/destination writes under a
  same-document navigation race, prior preparation writes are outside the sample token, and
  dynamic/unknown methods fail.
- [ ] Run `npm test -w @housingchoice/e2e -- mutationCatalog firewall`. Expected: fail before
  implementation, then pass only when catalog and scanner agree.
- [ ] Run `npm run typecheck` and root `npm test` to prove the new e2e workspace suite executes.
- [ ] Commit the four Task 6 paths.

---

## Slice 7 - Complete route registry and representative resolvers

### Task 7: Encode every page, source, fixture predicate, and terminal state once

**Files:**
- Create: `e2e/performance/routes.ts`
- Create: `e2e/performance/routes.test.ts`
- Modify: `e2e/performance/templates.ts`
- Modify: `e2e/performance/redact.test.ts`

**Registry rows:**

| Stable key | Heading/region | Warm source | Representative rule |
| --- | --- | --- | --- |
| `/` | heading `Today` | primary nav `Today` | static |
| `/contacts` | heading `Contacts` | contacts filter/nav link | static |
| `/contacts/tenants` | heading `Tenants` | contacts filter link | static |
| `/contacts/landlords` | heading `Landlords` | contacts filter link | static |
| `/contacts/unknown` | heading `Unknown` | contacts filter link | static |
| `/contacts/deleted` | heading `Deleted` | contacts filter link | static |
| `/listings` | heading `Properties` | primary nav link | static |
| `/listings/deleted` | heading `Deleted properties` | property filter link | static |
| `/tours` | heading `Tours` | primary nav link | static |
| `/tours/closed` | heading `Closed tours` | tour filter link | static |
| `/placements` | heading `Placements` | primary nav link | static |
| `/inbox` | heading `Inbox` | primary nav link | static |
| `/email` | heading `Email`, list `Unmatched email` | Email/Unmatched link | static, fixed surface, contact-load bearing |
| `/email/quarantine` | heading `Email`, list `Quarantined email` | Quarantine link | static, fixed surface, contact-load bearing |
| `/broadcasts` | heading `Matching` | primary nav link | static |
| `/settings/team` | heading `Settings`, selected tab `Team` | start Templates, click Team | static, admin |
| `/settings/templates` | heading `Settings`, selected tab `Templates` | settings tab link | static |
| `/settings/notifications` | heading `Settings`, selected tab `Notifications` | settings tab link | static |
| `/settings/voice` | heading `Settings`, selected tab `Voice` | settings tab link | static |
| `/settings/system` | heading `Settings`, selected tab `System status` | settings tab link | static, admin, target-structural note |
| `/settings/ai-runs` | heading `Settings`, selected tab `AI run log` | settings tab link | static, admin |
| `/settings/numbers` | heading `Settings`, selected tab `Phone numbers` | settings tab link | static |
| `/contacts/:contactId` | group `View` plus settled contact/file surfaces | `/contacts/tenants` exact href | first nondeleted tenant from paged GET |
| `/listings/:unitId` | level-1 property heading | `/listings` exact href | first nondeleted unit from paged GET |
| `/tours/:tourId` | back link `Back to tours` | `/tours` exact href | first upcoming rendered tour |
| `/placements/:placementId` | back link `Back to placements` | `/placements` exact href | first rendered active placement |
| `/conversations/:conversationId` | text `Group text` plus `Back to inbox` | `/inbox` exact href | first readable relay-group inbox row |
| `/broadcasts/:broadcastId` | recipients region | `/broadcasts` exact href | first-page sent/failed row only |

**Checked-in endpoint contracts:**

Endpoint paths below are sanitized templates. Braces after a path are the only allowed sorted query
key sets; values stay in memory. `+cursor` means the same key set with `cursor` added on later
pages. The implementation defines these named readonly sets verbatim in `routes.ts`:

- `COLD_SHELL_GETS`: `/auth/me {}`, `/api/inbox {filter,limit}`, and
  `/api/unmatched-email {filter}`. `/api/events {}` is the one named stream exclusion and never
  participates in readiness. Warm destination sets do not include shell/source-preparation GETs.
- `WARM_SOURCE_GETS` maps each row's declared source route to that source row's exact GET set (for
  example Templates uses `TEMPLATE_GETS`, a contact detail uses the matching contact-list set, and
  a conversation detail uses `INBOX_GETS`). These requests may be asserted while preparing the
  source but are discarded before `beginSample` and can never satisfy or enter destination
  evidence.
- `CONTACT_LIVE_WALK`: `/api/contacts {limit,type}` and `{cursor,limit,type}`.
  `CONTACT_DELETED_WALK` adds `deleted` to each set. Single-filter contact pages use the same key
  shapes but one in-memory `type`; all/deleted consumers fan out tenant, landlord, and unknown.
- `UNIT_LIVE_WALK`: `/api/units {}` and `{cursor}`. `UNIT_DELETED_WALK` is
  `/api/units {deleted}` and `{cursor,deleted}`.
- `TODAY_GETS`: `/api/today {day,toursFrom,toursTo}`; the declared 404-only fallback is
  `/api/placements {}`, `/api/conversations {}`, and `/api/tours {from,to}`.
- `TOUR_LIST_ACTIVE_GETS`: `/api/tours {from,to}`, `/api/tours {status}` plus both contact walks
  and both unit walks. `TOUR_LIST_CLOSED_GETS` is `/api/tours {status}` plus both walks.
- `PLACEMENT_LIST_GETS`: `/api/placements {}` and `{cursor}`, both contact walks, and both unit
  walks. `INBOX_GETS`: `/api/inbox {filter,limit}`. `EMAIL_GETS`:
  `/api/unmatched-email {filter}` plus `CONTACT_LIVE_WALK`. `BROADCAST_LIST_GETS`:
  `/api/broadcasts {limit}`.
- Settings sets are exact: `TEAM_GETS` is `/api/users {}`; `TEMPLATE_GETS` is
  `/api/settings {}`; `NOTIFICATION_GETS` is empty because mount only inspects browser push state;
  `VOICE_GETS` is `/api/users/me {}`; `SYSTEM_GETS` is `/api/settings {}`,
  `/api/system/flags {}`, `/api/system/alarms {}`, and `/api/system/errors {since}`;
  `AI_RUN_GETS` is `/api/system/flags {}` and `/api/ai-runs {scope}`; `NUMBER_GETS` is
  `/api/settings {}` and `/api/pool-numbers {}`.
- `CONTACT_DETAIL_GETS`: `/api/contacts/:contactId {}`,
  `/api/contacts/:contactId/suggestions {}`, `/api/users/me {}`,
  `/api/contacts/:contactId/timeline {}`, `/api/placements {}`, `/api/units {}`,
  `/api/contacts/:contactId/listings-sent {}`, `/api/contacts/:contactId/media {}`,
  `/api/contacts/:contactId/relay-groups {}`, `/api/tours {tenantId}`, and
  `CONTACT_LIVE_WALK`. Its 404-only timeline fallback additionally permits
  `/api/conversations {}` and `/api/conversations/:conversationId/messages {}`. Its blocked-write
  set is exactly `POST /api/inbox/:contactId/read`.
- `UNIT_DETAIL_GETS`: `/api/units/:unitId {}`, `/api/contacts/:contactId {}`,
  `/api/units {}`, `/api/placements {}`, `/api/units/:unitId/related {}`,
  `/api/units/:unitId/recipients {}`, `/api/units/:unitId/similar {}`,
  `/api/units/:unitId/activity {}`, `/api/tours {unitId}`, `CONTACT_LIVE_WALK`, and
  `CONTACT_DELETED_WALK`. It has no mount-time blocked write.
- `TOUR_DETAIL_GETS`: `/api/tours/:tourId {}`, `/api/units/:unitId {}`,
  `/api/contacts/:contactId {}`, `/api/tours/:tourId/roster {}`, `/api/conversations {}`,
  `/api/tours/:tourId/activity {limit}`, `/api/tours/:tourId/reminders {}`,
  `CONTACT_LIVE_WALK`, `/api/conversations/:conversationId {}`,
  `/api/conversations/:conversationId/members {}`,
  `/api/conversations/:conversationId/messages {}`, and
  `/api/conversations/:conversationId/scheduled {}`. Optional extra-roster contacts reuse
  `/api/contacts/:contactId`; a representative scale-1 fixture starts on its group tab. Its
  blocked-write set is exactly `POST /api/conversations/:conversationId/read`.
- `PLACEMENT_DETAIL_GETS`: `/api/placements/:placementId {}`, `/api/units/:unitId {}`,
  `/api/contacts/:contactId {}`, `/api/placements/:placementId/roster {}`,
  `/api/conversations {}`, `/api/placements/:placementId/history {limit}`,
  `/api/placements/:placementId/nudges {}`, `CONTACT_LIVE_WALK`,
  `/api/conversations/:conversationId {}`,
  `/api/conversations/:conversationId/members {}`,
  `/api/conversations/:conversationId/messages {}`, and
  `/api/conversations/:conversationId/scheduled {}`. Optional extra-roster contacts reuse
  `/api/contacts/:contactId`; a representative scale-1 fixture starts on its group tab. Its
  blocked-write set is exactly `POST /api/conversations/:conversationId/read`.
- `CONVERSATION_DETAIL_GETS`: `/api/conversations/:conversationId {}`,
  `/api/conversations/:conversationId/members {}`,
  `/api/conversations/:conversationId/messages {}`,
  `/api/conversations/:conversationId/scheduled {}`, and `CONTACT_LIVE_WALK`. Its blocked-write
  set is exactly `POST /api/conversations/:conversationId/read`.
- `BROADCAST_DETAIL_GETS`: `/api/broadcasts/:broadcastId/results {}` with no mount-time blocked
  write. The hermetic row-opening probes separately declare inbox source GETs plus
  `POST /api/inbox/:contactId/read`, and
  `GET /api/unmatched-email/:unmatchedId {}` and
  `POST /api/unmatched-email/:unmatchedId/read`; they are self-QA probes, not 29th/30th routes.

The 28 route bindings are exact:

For subset enforcement, a cold sample's allowed set is
`COLD_SHELL_GETS union destination GET set`; a warm sample's allowed set is only its destination
GET set. The blocked-write set is checked separately in both modes. `/api/events` and
`WARM_SOURCE_GETS` are never unioned into measured evidence.

Implement that rule once as
`expectedGets(route: RouteDefinition, mode: 'cold' | 'warm'): readonly EndpointContract[]`.
It returns a newly frozen, deduplicated union of `COLD_SHELL_GETS` and the bound destination set for
cold, and the frozen destination set alone for warm; callers cannot mutate registry constants.
Both the collector and self-QA exact-subset gate call this function rather than assembling their
own allowlists.

| Route keys | Destination GET set | Blocked-write set | Terminal contract |
| --- | --- | --- | --- |
| `/` | `TODAY_GETS` | none | `TODAY_TERMINAL` |
| `/contacts`, `/contacts/tenants`, `/contacts/landlords`, `/contacts/unknown` | matching live contact walk | none | `CONTACT_LIST_TERMINAL` with row heading |
| `/contacts/deleted` | `CONTACT_DELETED_WALK` | none | `CONTACT_LIST_TERMINAL('Deleted')` |
| `/listings` | `UNIT_LIVE_WALK` | none | `UNIT_LIST_TERMINAL('Properties')` |
| `/listings/deleted` | `UNIT_DELETED_WALK` | none | `UNIT_LIST_TERMINAL('Deleted properties')` |
| `/tours` | `TOUR_LIST_ACTIVE_GETS` | none | `TOUR_ACTIVE_TERMINAL` |
| `/tours/closed` | `TOUR_LIST_CLOSED_GETS` | none | `TOUR_CLOSED_TERMINAL` |
| `/placements` | `PLACEMENT_LIST_GETS` | none | `PLACEMENT_LIST_TERMINAL` |
| `/inbox` | `INBOX_GETS` | none during normal route measurement | `INBOX_TERMINAL` |
| `/email`, `/email/quarantine` | `EMAIL_GETS` | none during normal route measurement | matching `EMAIL_TERMINAL` |
| `/broadcasts` | `BROADCAST_LIST_GETS` | none | `BROADCAST_LIST_TERMINAL` |
| `/settings/team` | `TEAM_GETS` | none | `TEAM_TERMINAL` |
| `/settings/templates` | `TEMPLATE_GETS` | none | `TEMPLATE_TERMINAL` |
| `/settings/notifications` | `NOTIFICATION_GETS` | none | `NOTIFICATION_TERMINAL` |
| `/settings/voice` | `VOICE_GETS` | none | `VOICE_TERMINAL` |
| `/settings/system` | `SYSTEM_GETS` | none | `SYSTEM_TERMINAL` |
| `/settings/ai-runs` | `AI_RUN_GETS` | none | `AI_RUN_TERMINAL` |
| `/settings/numbers` | `NUMBER_GETS` | none | `NUMBER_TERMINAL` |
| `/contacts/:contactId` | `CONTACT_DETAIL_GETS` | contact mark-read | `CONTACT_DETAIL_TERMINAL` |
| `/listings/:unitId` | `UNIT_DETAIL_GETS` | none | `UNIT_DETAIL_TERMINAL` |
| `/tours/:tourId` | `TOUR_DETAIL_GETS` | conversation mark-read | `TOUR_DETAIL_TERMINAL` |
| `/placements/:placementId` | `PLACEMENT_DETAIL_GETS` | conversation mark-read | `PLACEMENT_DETAIL_TERMINAL` |
| `/conversations/:conversationId` | `CONVERSATION_DETAIL_GETS` | conversation mark-read | `CONVERSATION_DETAIL_TERMINAL` |
| `/broadcasts/:broadcastId` | `BROADCAST_DETAIL_GETS` | none | `BROADCAST_DETAIL_TERMINAL` |

**Checked-in terminal contracts:**

Locators below are constructors, not captured content. Static `getByText`/`hasText` matching is
allowed; code never calls `textContent`, `innerText`, or persists matched text.

- `TODAY_TERMINAL`: populated is any role `list` named `Group texts to close`,
  `Needs you now`, `Tours today`, `Unreplied`, `Follow-ups`, or `AI suggestions`; empty is exact
  `All caught up`; error is role `alert` containing `We couldn't load your queue`.
- `CONTACT_LIST_TERMINAL(heading)`: populated is role `list` named `heading`; empty is exact
  `No <lowercase heading> yet`; error is the page role `alert`. `UNIT_LIST_TERMINAL(heading)` uses
  role `list` named `Properties`; its exact empty strings are `No properties yet` and
  `No deleted properties`; error is the page role `alert`.
- `TOUR_ACTIVE_TERMINAL`: wait until both regions `Upcoming tours` and `Needs booking` exist;
  populated means either contains a role `list`, empty means both exact strings
  `No tours scheduled in the next 30 days.` and `No unbooked tour requests.` are visible, and error
  is role `alert`. `TOUR_CLOSED_TERMINAL` uses role `list` named `Closed tours list`, exact empty
  `No closed or canceled tours yet.`, or role `alert`.
- `PLACEMENT_LIST_TERMINAL`: loaded structure is searchbox `Search placements`; populated is any
  descendant role `list`, empty is exact `No active placements.`, and error is role `alert` with
  `We couldn't load placements.`. `INBOX_TERMINAL` uses role `list` named `Conversations`, exact
  empty `No conversations yet` (or structural pending `The inbox turns on with its backend`), and
  role `alert`. The generated hermetic result must take the populated branch.
- `EMAIL_TERMINAL`: populated is role `list` named `Unmatched email` or `Quarantined email`; empty
  is exact `No unmatched email` or `Quarantine is empty` (or structural pending
  `Email triage turns on with its backend`); error is role `alert`. The fixed hermetic fixtures
  must take the populated branch. `BROADCAST_LIST_TERMINAL` uses role `list` named
  `Property sends`, exact empty `No sends yet`, or role `alert`.
- `TEAM_TERMINAL`: populated is role `table` or the mobile teammate role `list`; empty is static
  prefix `No teammates yet`; error is role `alert`. `TEMPLATE_TERMINAL` is textbox
  `Missed-call auto-text` or role `alert`. `NOTIFICATION_TERMINAL` is heading `Notifications`; it
  has no tracked mount request and is classified populated once visible. `VOICE_TERMINAL` is
  textbox `Your mobile number` or a `Your cell` status plus role `status`; error is role `alert`.
- `SYSTEM_TERMINAL` is compound: quiet-hours checkbox `Pause automated messages overnight`, the
  `Go-live flags` role list, and a settled `Alarms` plus `Recent errors` block must all be present;
  each AWS block may be list, exact deployed-environment/empty state, or role `alert`. Any alert
  classifies error; otherwise populated. `AI_RUN_TERMINAL` uses role `list` named `AI runs`, exact
  empty `No extraction runs match this scope.`, or role `alert`. `NUMBER_TERMINAL` requires the
  `Our number` block to leave `Loading` and the admin pool to expose `Pool number counts`, exact
  empty `No group text numbers yet - a number is provisioned with the first group text.`, or role
  `alert`.
- Detail contracts have no empty branch; missing data is a resolver skip. Contact uses role
  `group` named `View`; property uses a level-1 heading plus heading `Photos`; tour, placement, and
  conversation use exact links `Back to tours`, `Back to placements`, and `Back to inbox`;
  broadcast results uses heading `Recipients` plus its role `list` or exact
  `No recipients recorded yet.`. Each uses its page-level load/not-found role `alert` as error.

For each row, declare stable label, role, route template, resolver, source route state, exact href
locator, terminal populated/empty/error locators, expected endpoint-template set, stream
exclusions, source/load scale flags, and target-structural note. The contact-load-bearing flag also
applies to every route mounting `useContacts`, including email, tours, and the relevant detail
pages.

Resolvers use authenticated GETs and page according to the real endpoint contract, keep IDs only
in closure memory, and return either `{ kind: 'resolved', coldPath, warmHref }` or an explicit skip
reason. They never write the ID to evidence. Warm detail locators are
`page.getByRole('link').filter({ has: page.locator('[href="<exact in-memory href>"]') })` or the
equivalent exact `locator('a[href=...]')` plus role assertion; they never select by domain text.
They never click Load more. Broadcast selection is restricted to the first 50 API rows and inbox
relay selection stays below its generated cap.

The resolver request contracts are explicit:

- contact: page `/api/contacts?deleted=false&limit=100&type=tenant` by opaque cursor, choose the
  first nondeleted row under API order, then require its exact link on `/contacts/tenants`;
- property: page `/api/units?deleted=false` by opaque cursor, choose the first nondeleted row under
  API order, then require its exact link on `/listings`;
- tour: at resolver execution evaluate the source browser's current clock/timezone and compute its
  current local-day start and exclusive +30-day boundary with the same `toursWindow(new Date())`
  contract the UI uses; keep the returned ISO values only in resolver memory and do not use the
  seed anchor. GET that live `from`/`to` window, choose the first eligible rendered upcoming row
  under the page's sort, then require its exact link on `/tours`;
- placement: page `/api/placements` by cursor, choose the first active row under API order, then
  require its exact link on `/placements`;
- conversation: GET `/api/inbox?filter=all&limit=30`, choose the first `relay_group` row from the
  additively merged relay rows, then require its exact `/conversations/...` link on `/inbox`;
- broadcast: GET only `/api/broadcasts?limit=50`, choose the first `sent` or `failed` row, never
  page or accept `sending`, then require its exact results link on `/broadcasts`.

- [ ] Write failing registry tests asserting the exact 28 keys above, no `/settings` redirect,
  no public/create/catch-all route, unique keys, role/readiness/source completeness, scale flags,
  template-only paths, and no raw-ID field on a resolved result.
- [ ] Mechanically inspect `dashboard/src/App.tsx` route elements in the test and compare the
  implemented in-scope path set to the registry, with an explicit checked-in exclusion list for
  public pages, `/broadcasts/new`, `/settings`, and `*`. A future implemented read-only route must
  fail until registered.
- [ ] Add fake paged API plus fake DOM tests for exact fixture-to-link binding, broadcast terminal
  first-page eligibility, relay-only eligibility, missing fixture, missing rendered link, source
  timeout, and the rule that an API-page selection never substitutes a different DOM row. Freeze
  the seed anchor at a different day than resolver time and test a resolver call across local
  midnight to prove the live tour window is recomputed.
- [ ] Assert every route expands to exactly the endpoint and terminal contracts above, every
  observed query-key set is one declared shape, stream/source GETs cannot enter destination
  evidence, and a synthetic undeclared template makes the registry test fail.
- [ ] Deep-compare `expectedGets` for every one of the 28 route bindings in both modes, including
  every exact query-key shape. Prove cold retains and accepts shell requests, warm excludes shell
  and `WARM_SOURCE_GETS`, returned arrays are immutable, and an undeclared query key fails.
- [ ] Run `npm test -w @housingchoice/e2e -- routes`. Expected: fail, then pass after registry and
  resolvers exist.
- [ ] Run `npm run typecheck` and commit the Task 7 paths.

---

## Slice 8 - Meaningful-ready engine and raw instrumentation

### Task 8: Measure application readiness without `networkidle`

**Files:**
- Create: `e2e/performance/readiness.ts`
- Create: `e2e/performance/readiness.test.ts`
- Create: `e2e/performance/collect.ts`
- Create: `e2e/performance/collect.test.ts`

**Timing algorithm:**

1. At sample start call CDP `Performance.getMetrics` and retain the `Timestamp` monotonic value;
   also capture Node `performance.now()` for UI-poll mapping. Page observers use a page-native
   `performance.now()` cutoff captured inside the active document. These are separate clock
   domains normalized to sample-relative offsets; no code compares their absolute values.
2. Track first-party non-stream GET request start/finish/failure through CDP Network events. Track
   request IDs but store only sanitized evidence. Use `responseReceived - requestWillBeSent` for
   TTFB and `loadingFinished - requestWillBeSent` for duration. Use `encodedDataLength` for bytes;
   never call `response.body()`.
3. Poll URL plus the route's heading/region and populated/empty/error terminal locators every
   100 ms by default. Do not read `textContent`; use role/visibility/count/state only.
4. `readyMs` is the later of the final tracked network event and first observed terminal UI state,
   relative to sample start. Confirm it only after 500 ms with no later qualifying request or UI
   transition. Do not add the settle window to `readyMs`.
5. Timeout preserves the sanitized request evidence and current terminal classification.

Define one idempotent page-store installer used by every bootstrap. Register the base installer as
an init script before navigation; it records PerformanceObserver entries for `longtask`, `paint`,
and `largest-contentful-paint` as numeric values only and installs no duplicate listeners when
called twice. The page-side store and Node-side CDP/console/request collectors expose
`beginSample(sampleToken, cutoff)` and
`endSample(sampleToken)`. `beginSample` atomically clears observer entries, pending request IDs,
sanitized request rows, console category counts, blocked writes, DOM/UI transition state, and the
prior timing origin, then records its collector-native monotonic cutoff. All collectors share the
sample token, not an absolute cutoff value. Events without the current token or before their
collector's cutoff are ignored. This reset runs immediately before every cold navigation and, critically,
immediately before every timed warm click after source readiness; source/prior-sample events cannot
leak into the destination.

At ready, collect long-task total/max/count, cold FCP/LCP, navigation
TTFB/DOMContentLoaded/load, and `document.getElementsByTagName('*').length`. Warm
paint/navigation fields are always null because an SPA click has no meaningful navigation/paint
origin. Count console warning/error events but immediately map and discard text; the exact existing
page-cap warning prefixes map to `client_truncated`, everything else to stable `warning_other` or
`error_other`.

- [ ] Write fake-clock/unit tests for a heading that appears early, a request that finishes later,
  terminal UI after network, a late request resetting quiet, settle not added to readyMs, polling
  cadence, event-stream exclusion, timeout retention, source-preparation timeout isolation, and
  token/native-cutoff rejection of late events from a prior sample and explicit normalization of
  page, CDP, and Node offsets without cross-clock absolute comparison.
- [ ] Write CDP-adapter tests with synthetic Network events for duration/TTFB/bytes, failed/null
  fields, static and third-party classification, unknown API handling, and no body retrieval.
- [ ] Test long-task aggregation, missing FCP/LCP, DOM count, console category-only behavior, and
  page-cap detection for contacts/listings/all five placements walks. Add a warm test that records
  source long tasks, warnings, GETs, and blocked writes, calls `beginSample` immediately before the
  click, then proves all four source buffers are absent and warm navigation/paint metrics are null.
- [ ] Add an idempotence/bootstrap test proving the first observer entry after a cold `goto`
  carries the active sample token and is retained, while an event from the prior blank document or
  an earlier cutoff is rejected.
- [ ] Run `npm test -w @housingchoice/e2e -- readiness collect`. Expected: fail, then pass after
  implementation.
- [ ] Run `npm run typecheck` and commit the four Task 8 paths.

---

## Slice 9 - Cold and warm sampling protocol

### Task 9: Drive routes in controlled contexts and keep preparation out of measurements

**Files:**
- Modify: `e2e/performance/collect.ts`
- Modify: `e2e/performance/collect.test.ts`
- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/routes.test.ts`

**Protocol:**

- Cold: create a fresh context from the in-memory authenticated state with the existing Desktop
  Chrome viewport and service workers blocked. Register the shared idempotent page-store installer
  as a base init script, then create one page per sample with a bounded next-document bootstrap init
  script whose only argument is the fresh sample token. That bootstrap calls the same installer,
  captures `performance.now()` in the new document, and calls `beginSample(token, pageCutoff)`
  before application code runs. Start CDP and Node-side collectors with the same token and their
  own native cutoffs immediately before direct navigation; normalize each source to offsets from
  its own start; collect; close context. Do not rely on evaluating
  `beginSample` in the initial `about:blank`, because its store does not survive navigation.
- Warm: reuse one authenticated context and shell. Before each sample navigate to the declared
  source and wait with the separate source timeout. Resolve the exact in-memory href. Set firewall
  source/destination URL predicates, atomically call `beginSample` to clear every collector, start
  timing immediately before the exact accessible click, wait for destination ready, and collect.
  For warm samples, call page-side `beginSample(token, performance.now())` with `page.evaluate` in
  the already-loaded source document and start CDP/Node collectors with the same token and their
  native cutoffs before the click.
  The interception handler derives source/destination phase from frame URL; the driver never flips
  a mutable phase flag. Preparation requests and observer events are discarded rather than
  attached to the destination.
- Do one discarded cold warmup of the first registry route for hermetic/local; hosted skips it.
  The bundle is currently not code-split. Record this choice in the manifest.
- Use a deterministic Fisher-Yates shuffle from `route-order-seed`; rotate the base order by repeat
  index so one route does not always run first. Record every actual order.
- A blocked write is expected evidence. If the route reaches ready, status is `ok`; if the blocked
  write prevents readiness, use `blocked_write_dependency`. Missing fixture/link/source uses the
  exact skip statuses from `SampleStatus`.
- In hermetic mode only, compare rendered inbox relay-group link count by role/href pattern with the
  generated relay manifest. Record only counts and a shortfall boolean.

- [ ] Write failing tests with fake Page/Context adapters for fresh cold contexts, warm reuse,
  first-document cold token bootstrap, atomic warm buffer reset, source/prior-token traffic
  exclusion, exact click binding,
  interception-time URL phase classification, deterministic rotated order, warmup
  inclusion/exclusion, low sample count, skip classification, and context cleanup after thrown
  errors.
- [ ] Implement `collectColdSample`, `collectWarmSample`, and `collectRunSamples` against the
  stable types; keep Playwright calls behind small interfaces so most tests do not launch a real
  browser.
- [ ] Run targeted tests, `npm run typecheck`, and root `npm test`.
- [ ] Commit the four Task 9 paths.

---

## Slice 10 - Aggregation and baseline comparison

### Task 10: Produce honest statistics and controlled-comparison labels

**Files:**
- Create: `e2e/performance/aggregate.ts`
- Create: `e2e/performance/aggregate.test.ts`
- Create: `e2e/performance/compare.ts`
- Create: `e2e/performance/compare.test.ts`
- Modify: `e2e/performance/types.ts`

**Contract:**

- Aggregate successful samples per route and mode into median/min/max. P95 is null below 20
  successful samples and uses nearest-rank or one documented deterministic algorithm at 20+.
  Preserve null metrics; do not coerce them to zero. Mark fewer than three successful samples as
  `low_sample_count`.
- Rank cold and warm separately by median `readyMs`; secondary rankings use API bytes, API count,
  long-task total, and DOM count. Every row includes scale flags and any client truncation.
- Compare schema plus matching route/mode keys. Metric deltas cover readyMs, API count, API bytes,
  long tasks, and DOM count with `{ absolute, percent }`; percent is null for baseline zero.
- Environment mismatch fields are exactly target kind, normalized scale/count manifest excluding
  anchor, route set, browser major/channel, viewport, cold/warm repeats, route-order seed,
  `INTERCEPTION_SCOPE_VERSION`, settle window, and poll interval. Target app revision difference
  is the experimental variable, never a mismatch. A missing revision adds
  `target_version_unverified`.
- Compute deltas even with mismatches, but label them uncontrolled. List added, removed, skipped,
  timed-out, and failed entries separately. Slower metrics never change process exit status.

- [ ] Write failing table tests for odd/even medians, min/max, p95 at 19/20, null metrics, failed
  sample exclusion, low sample count, stable tie ordering, zero baseline, added/removed routes,
  every mismatch field, anchor exclusion, revision difference, missing revision, and status lists.
- [ ] Implement pure functions only; no filesystem or Playwright imports.
- [ ] Run `npm test -w @housingchoice/e2e -- aggregate compare` and `npm run typecheck`.
- [ ] Commit the five Task 10 paths.

---

## Slice 11 - Reports, JSONL waterfall, and quarantine

### Task 11: Write only allowlisted evidence and scan the final bytes

**Files:**
- Create: `e2e/performance/report.ts`
- Create: `e2e/performance/report.test.ts`
- Modify: `e2e/performance/types.ts`
- Modify: `e2e/performance/redact.ts`
- Modify: `e2e/performance/redact.test.ts`

**Contract:**

- Run IDs are UTC compact timestamp plus a short random hex suffix. Output root is
  `e2e/.artifacts/performance/<run-id>/`.
- `summary.json` is the versioned manifest, samples, aggregates, route orders, warnings, target
  metadata, profiler commit, target revision, browser/channel/viewport/OS/Node, counts, and no raw
  requests array. It records `INTERCEPTION_SCOPE_VERSION` and only `SafeRunConfig` plus
  `TargetMetadata`, never `RunConfig`. `requests.jsonl` contains one sanitized `RequestEvidence`
  per line.
- `report.md` contains target/revision warnings, count manifest, cold and warm worst-offender
  tables, secondary rankings, client-truncation and scale-bearing labels, failures/skips, blocked
  writes, unmatched API counts, and artifact filenames.
- With baseline, add `comparison.json` and `comparison.md`. Baseline parse/schema failure still
  writes the current report, marks comparison failed, and returns nonzero.
- Build every serialized object from explicit allowlists. Write to a staging subdirectory, scan
  every final byte with `scanArtifactText`, and rename to final only on success. On failure rename
  staging to `<run-id>-quarantined`, print filenames plus reason categories only, and return a
  privacy-failure result. Never print offending content.
- Browser crashes and fatal profiler errors write a partial sanitized summary/report when possible.
  Partial and quarantined output use the same closed reason codes; they never persist raw caught
  errors for a later scan to discover.

- [ ] Write failing temp-directory tests for exact filenames, schema version, JSONL line shape,
  Markdown rankings, comparison presence/absence, partial reports, baseline errors, and quarantine.
  Inject adversarial sensitive values at every pre-serialization boundary and prove no normal
  artifact survives.
- [ ] Implement atomic-ish staging/final directory handling with Node fs APIs. Do not overwrite an
  existing run directory.
- [ ] Run `npm test -w @housingchoice/e2e -- report redact` and `npm run typecheck`.
- [ ] Commit the five Task 11 paths.

---

## Slice 12 - Profiler-owned hermetic lifecycle and top-level CLI

### Task 12: Start, verify, profile, and stop only the stack this process owns

**Files:**
- Create: `e2e/performance/lifecycle.ts`
- Create: `e2e/performance/lifecycle.test.ts`
- Modify: `e2e/performance/cli.ts`
- Create or modify: `e2e/performance/cli.test.ts`

**Lifecycle contract:**

- Before spawning, read `e2e/.artifacts/session.pid`. If it names a live process, refuse. Do not
  call `scripts/e2e-session.mjs` and rely on its self-heal because that launcher kills the prior
  tree.
- Call `resolveLane()` from `e2e/support/lane.mjs`; lane 0 remains impossible. Spawn
  `process.execPath scripts/e2e-session.mjs` with exact `E2E_LANE`, `detached: false`, piped
  stdout/stderr, and the profiler as parent. Retain `child.pid` immediately.
- Wait for the launcher's exact `[e2e-session] ready` line with a hard startup timeout, then read
  `lane.json`, confirm exact lane/ports/prefix, read `session.pid`, and require it equals the child
  PID. Verify `/__dev/ping` prefix and `appCommit` before reseed.
- On any error, SIGINT, SIGTERM, or normal finish, call `killTree(child.pid)` only. Remove
  `session.pid` only if it still contains that child PID; remove `lane.json` only if it still
  describes that lane. After `killTree`, poll injected `isAlive(child.pid)` every 100 ms for at
  most 10 seconds. Delete matching state files only after the child is proven dead. On deadline,
  preserve both state files, return `cleanup_failed`, and print only the lane plus the static
  recovery command. Never call `e2e:stop` during normal owned cleanup and never select by process
  name or broad port.
- If cleanup cannot prove completion, print lane and the recovery command `npm run e2e:stop`, set
  nonzero, and preserve profile artifacts. If another e2e run reaps the profiler later, detect the
  dead child and fail rather than attaching to the replacement.
- Hermetic order is parse/validate, same-worktree preflight, resolve/spawn, verify ping, call the
  app-port reseed with item-count-scaled timeout, authenticate, install firewall, warmup, collect,
  report, finally cleanup.
- Local order is parse/validate, ping/prefix proof, TTY confirmation, existing-user auth, install
  firewall, warmup, collect, report. It never imports or calls lifecycle/reseed functions.
- Hosted order is parse/validate, headed login, admin/env proof, install firewall, collect, report.
  It never has a seed path.

- [ ] Write failing lifecycle tests with a fake spawned child and temp state files for live-pid
  refusal, dead/stale pid acceptance without broad killing, lane resolution, ready/pid/lane
  validation, startup failure cleanup, profiling failure cleanup, signal cleanup, state-file
  compare-before-delete, kill-tree completion polling, death on the final 10-second tick, timeout
  preservation of both state files, later reaper detection, and cleanup failure reporting.
- [ ] Write CLI sequencing tests that spy every phase and prove parse errors and `--print-config`
  perform zero lifecycle/network/browser work; firewall precedes measured navigation; local/hosted
  never seed; hermetic always cleans up; slower comparisons exit zero; safety/auth/privacy/browser
  failures exit nonzero.
- [ ] Implement lifecycle and replace the Task 1 print-only CLI shell with full orchestration.
  Dynamically import Playwright/lifecycle modules only after the `--print-config` early exit.
- [ ] Run `npm test -w @housingchoice/e2e -- lifecycle cli`, `npm run typecheck`, and root
  `npm test`.
- [ ] Commit the Task 12 paths.

---

## Slice 13 - Hermetic no-write self-QA and live profile proof

### Task 13: Prove every automatic mutation surface remains unchanged

**Files:**
- Create: `e2e/performance/selfQa.ts`
- Create: `e2e/performance/selfQa.test.ts`
- Modify: `e2e/performance/cli.ts`
- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/report.ts`

**Self-QA modes:**

- `--self-qa=narrow` profiles one cold and one warm sample for `/contacts/tenants`,
  `/contacts/:contactId`, `/inbox`, and `/conversations/:conversationId` at scale 1.
- `--self-qa=full` profiles one cold and one warm sample for all 28 registry entries at scale 1.
- Both are hermetic-only. Resolve the six private scale-1 keys through
  `resolvePerformanceSelfQaFixtures`; fail before collection if any exact source link, ownership,
  back-reference, unread predicate, or pairwise separation proof differs from the generator
  contract. Before profiling, use authenticated GETs to reduce each keyed fixture state into an
  in-memory map of unread/read scalars for contact detail, relay conversation detail, inbox row,
  unmatched-email row, tour group channel, and placement group channel, plus dev-outbox count.
  After profiling, repeat the GET reductions and compare. Persist only surface names and
  unchanged booleans, never IDs or domain values.
- In full mode, bind the four detail route resolvers to the keyed `contact_detail`,
  `conversation_detail`, `tour_group`, and `placement_group` fixtures. Run two supplemental
  navigation-only probes under the same firewall: click the keyed unread `inbox_row` link and open
  the keyed unread `unmatched_email` row, but click no workflow/action controls. The supplemental
  probes are not ranking samples and cannot satisfy the 56-sample cardinality.
- In full mode, require one sanitized blocked-write record for every expected surface tuple, not aggregate phase
  counts: contact detail plus `/api/inbox/:contactId/read` plus `destination_mount`; conversation
  detail, tour group, and placement group each plus `/api/conversations/:conversationId/read` plus
  `destination_mount`; inbox row plus its declared read endpoint plus `source_click`; and unmatched
  email plus `/api/unmatched-email/:unmatchedId/read` plus `source_click`. Associate identical
  endpoint templates with the route/probe's symbolic surface label before disposing raw IDs.
  De-duplicate identical attempts for assertion and fail full self-QA if any required tuple is
  absent, attributed to the wrong phase, or an undeclared automatic surface appears.
- Assert every measured route's observed API templates are a subset of its declared set; no
  `unmatched_api`; inbox rendered relay count matches the generated manifest; outbox count is
  unchanged; output exists and passes the same final privacy scan; report has count manifest plus
  both rankings. Scale 1 is a complete fixture world: full mode requires exactly 56 `ok` samples
  (28 cold plus 28 warm), with zero skips, timeouts, failures, or
  `blocked_write_dependency` results. The write firewall may record blocked writes while readiness
  still succeeds.

- [ ] Write failing tests for reduction-only snapshots, raw-value disposal, all six keyed fixtures,
  exact per-surface path/phase attempts, missing/wrong/unexpected attempt rejection, before/after
  mismatch reporting without value leakage, narrow subset enforcement, full registry enforcement,
  endpoint subset mismatch, relay count mismatch, outbox delta, non-ok full sample rejection,
  supplemental-probe exclusion from rankings, exact 56-ok cardinality, and self-QA result
  serialization.
- [ ] Implement the hermetic-only state guardian and wire it around collection. Do not expose a
  generic workflow scripting API.
- [ ] Run unit tests and `npm run typecheck`.
- [ ] Run the real narrow smoke, bare and unpiped:

```text
npm run perf:pages -- hermetic --scale=1 --cold-repeats=1 --warm-repeats=1 --self-qa=narrow
```

  Expected: exit 0; the owned lane is stopped; report files exist; `/contacts/tenants` has
  sanitized `/api/contacts` evidence; blocked writes are recorded; named state checks are true.
- [ ] Fix only defects attributable to this slice, re-run its focused tests, then re-run narrow
  smoke. Record both attempts if an existing documented flake is encountered.
- [ ] Commit the five Task 13 paths.

---

## Slice 14 - Operator documentation and repository policy

### Task 14: Document safe on-demand use and the exact agent carve-out

**Files:**
- Modify: `AGENTS.md`
- Modify: `e2e/README.md`
- Modify: `e2e/performance/config.test.ts`

- [ ] Add the design section 13 wording verbatim to AGENTS.md's UI testing section:

```text
`npm run perf:pages` is a sanctioned Playwright entry point: the root script
delegates directly into e2e-workspace code, so it satisfies the
e2e-workspace-only rule for its hermetic target. Its `-- local` and
`-- hosted-dev` targets are additionally human-invoked only: an agent may run
them only on the human's explicit per-run instruction naming the target, and
the local target requires an interactive TTY confirmation the runner
enforces.
```

- [ ] Add an e2e README section for all three commands, scale/override examples, importing before
  local use, local typed confirmation, hosted headed OAuth, memory-only auth, Chrome channel
  Administrator prerequisite, navigation-only/write-firewall scope, residual public/media/storage
  paths, artifact/privacy contract, baselines, cold versus warm, expected noise, route order,
  `client_truncated` caps, every useContacts consumer, scale-bearing labels, inbox relay cost,
  second-run reseed/runtime estimates, one-direction session guard, and killed-during-boot recovery.
- [ ] State clearly that local and hosted modes ship pre-merge with guard unit evidence only; their
  first end-to-end execution belongs to the human. State that local Vite evidence and hosted
  built/CDN evidence answer different questions and neither is production telemetry.
- [ ] Run a command-example test or `--print-config` for every documented noninteractive example.
  Do not run local or hosted.
- [ ] Run ASCII scan on all new/touched profiler docs/source lines and fix any non-ASCII additions.
- [ ] Run `npm run typecheck` and root `npm test`.
- [ ] Commit `AGENTS.md e2e/README.md` plus only any Task 14 test adjustment.

---

## Slice 15 - Final sync, required gates, full-registry self-QA, and handback

### Task 15: Validate the merge candidate without running a human target

- [ ] Read bare `git status`, check `.git/MERGE_HEAD`, and inspect current `main` drift. If `main`
  advanced, sync it into the feature branch once at this final pre-handback step. Preserve both
  sides' intent; if active work makes the sync conflict-risky, stop and ask the human before the
  sync.
- [ ] After the sync, run the required gates from `W:\tmp\page-performance-profiler`, bare and
  unpiped, one at a time:

```text
npm run typecheck
npm test
npm run e2e
```

  Record each exit code. If either named known flake occurs, rerun that gate once and report both
  results.
- [ ] After `npm run e2e` has fully stopped, run the full-registry live self-QA separately:

```text
npm run perf:pages -- hermetic --scale=1 --cold-repeats=1 --warm-repeats=1 --self-qa=full
```

  Expected: exit 0; all 28 route keys have one `ok` cold and one `ok` warm result (56 successful
  samples, no skips/timeouts/failures); every observed endpoint is declared; privacy scan passes;
  every automatic-write state proof is unchanged; both blocked phases appear; relay count is not
  truncated; owned lane stops.
- [ ] Inspect the generated `report.md`, `summary.json`, and `requests.jsonl` structurally without
  copying domain data into the handback. Report artifact path, route/result counts, privacy result,
  and the worst route keys/metrics only.
- [ ] Run standalone `git status`; ensure artifacts remain gitignored and only intended tracked
  files differ. Commit any verification-only fixes with explicit paths and rerun the affected
  focused test plus all four final commands above.
- [ ] Do not run `local` or `hosted-dev`, do not merge, deploy, or remove the worktree. Hand back
  branch, HEAD, commits, bare gate exit codes, self-QA exit/path, reviewer findings/adjudications,
  current main drift, and the explicit note that first local/hosted runs remain human actions.

## Plan self-review checklist

Before dispatching implementation, confirm all of the following against the current spec and
repository:

1. Every design route appears exactly once and out-of-scope routes do not.
2. Every destructive path validates before reset and refuses lane 0 independently of
   `resetLocalData`.
3. Local and hosted code paths cannot import or reach reseed/lifecycle mutation code.
4. Every dashboard write call site is mechanically discovered and cataloged; every automatic
   reader/renderer surface has a pre/post self-QA assertion.
5. Raw IDs and bodies exist only in transient resolver/auth/self-QA memory and no evidence type has
   a field capable of carrying them.
6. Seed anchor is recorded but excluded from equality; target revision difference is not a
   mismatch.
7. E2e Vitest is wired into root `npm test`, and e2e typecheck includes every performance source.
8. Hermetic cleanup compares pid/lane ownership before deleting state and never calls broad stop
   logic during normal cleanup.
9. No local/hosted live run, deployment, infrastructure mutation, or new dependency is hidden in
   a task.
10. All new plan lines are ASCII and all commit instructions use explicit paths.
