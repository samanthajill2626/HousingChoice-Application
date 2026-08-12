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
section 7 phrase "never generated" as "never scale-generated." One additional adjudicated spec
erratum is recorded for the next spec touch: tour and placement detail do not mount `useContacts`
on passive navigation because `PeopleCard` mounts `AddAnyContactForm` only while that form is open
(`dashboard/src/routes/shared/PeopleCard.tsx:732`); their profiler
`load_scale_bearing` flag is therefore false. Do not edit the spec in this mission.

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
  an inbox link and may activate the unmatched-email row expansion control only to prove their
  automatic mark-read mutations are blocked. Those two named probes are the only control-level
  exception and remain behind the write firewall.
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
  only, and add a `Co-Authored-By` trailer naming the model that actually authored that commit.
  Never use `git add -A`.
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

### New shared tooling file

| Path | Responsibility |
| --- | --- |
| `scripts/lib/killTree.d.mts` | Type declarations for the existing lifecycle helpers imported by e2e TypeScript. |

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
- `app/src/lib/devReset.ts`
- `app/src/lib/seed/index.ts`
- `app/src/lib/seed/live.ts`
- `app/src/lib/seed/media.ts`
- `app/src/lib/seedData.ts`
- `app/scripts/db-seed.ts`
- `app/test/seedProfile.integration.test.ts`
- `app/test/seedHistory.test.ts`
- `app/test/seedLive.test.ts`
- `app/test/seedMedia.test.ts`
- `app/test/reseedUnmatchedEmail.test.ts`
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

export type ResourceClass = 'document' | 'script' | 'style' | 'font' | 'image' | 'api' | 'other';

export interface RequestEvidence {
  routeKey: string;
  mode: SampleMode;
  repeat: number;
  method: string;
  resourceClass: ResourceClass;
  originClass: 'first_party' | 'third_party';
  endpointTemplate: string;
  queryKeys: string[];
  startOffsetMs: number;
  durationMs: number | null;
  ttfbMs: number | null;
  status: number | null;
  transferBytes: number | null;
  outcome: 'finished' | 'failed' | 'aborted';
  requestRole: 'required' | 'background_refresh' | 'background_shell';
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
  resourceCountsByClass: Record<ResourceClass, number>;
  backgroundRequestCount: number;
  backgroundTransferBytes: number;
  blockedWrites: BlockedWrite[];
  consoleCategories: Record<string, number>;
  clientTruncated: boolean;
  terminalState: 'populated' | 'empty' | 'error' | 'unknown';
  reason: FailureReasonCode | null;
}
```

`RunConfig` is an internal-only type in `config.ts`; it may carry `baseUrl`, `loginEmail`, and a
resolved baseline path while the process is alive. `SafeRunConfig` and `TargetMetadata` are the
only config/target types accepted by report, comparison, or stdout code. `SafeRunConfig` contains
only target kind, safe numeric/timing/browser options, and an optional hermetic count manifest.
`TargetMetadata` contains structural proof codes, `profilerCommit: string | null`,
`targetAppCommit: string | null`, and `targetVersionStatus: 'verified' | 'unverified'`. Commit
fields accept only a normalized 7-40 lowercase-hex Git revision or null; empty strings normalize
to null. Neither type has a base URL, hostname, login email, baseline path, credential, redirect,
or generic string/error field. `toSafeRunConfig` and `toTargetMetadata` build new allowlisted
objects; they never spread or clone `RunConfig`.

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
  hermetic-only `--contract-checkpoint` and `--self-qa=narrow|full`.
- Defaults: cold 3, warm 3, settle 500 ms, poll 100 ms, ready timeout 120,000 ms, source timeout
  120,000 ms, hosted login timeout 300,000 ms, bundled Chromium, and a generated random
  route-order seed that is printed and recorded. The default `--login-email` is exactly
  `founder@example.com` as required by design section 5.2.
- Repeats and all timeouts are positive integers. `settle-ms >= poll-ms`. Local and hosted forbid
  every scale/override/self-QA option. Hermetic forbids `--base-url`, `--login-email`, `--headed`,
  and a non-default browser channel. Hosted requires HTTPS and `--headed`. Local requires exactly
  loopback port 5174. `--self-qa` requires scale 1 plus one cold and one warm repeat and rejects all
  eight entity-count/message-density/recipient-density overrides. Route-order and timeout controls
  remain available. Validation compares the resolved seed config with the default scale-1
  count/density config before any lifecycle import or lane startup.
- `--contract-checkpoint` is hermetic-only, requires default scale 1 and one cold plus one warm
  repeat, and rejects all count/density overrides for the same reason as self-QA. It is the
  builder-only early live contract calibration in Task 13, not a way to bypass subset validation.
- `--contract-checkpoint` and `--self-qa` are mutually exclusive. Reject either ordering of both
  options during pure argument validation, before any lifecycle import, network call, or artifact
  creation.
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
  density override under both self-QA modes, both orderings of the checkpoint/self-QA conflict,
  acceptance of route-order/timeout controls, and error messages that contain option names but
  never option values that may be sensitive. Inject sentinel host,
  email, baseline-path, credential, and redirect strings into internal `RunConfig`; stringify
  `SafeRunConfig` and assert every sentinel is absent. Assert hermetic `seed` is counts-only and
  local/hosted `seed` is null.
- [ ] Add an end-to-end argv test that resolves the repository root from the test module and spawns
  `npm run --silent perf:pages -- hermetic --scale=7 --print-config` with `cwd` set to that root.
  Resolve the executable as `npm.cmd` on Windows and `npm` elsewhere with `shell: false`; do not
  rely on platform shell lookup. Require exit 0, exactly one trimmed JSON value on stdout, and
  `contacts === 700`. Treat stderr as bounded diagnostic input rather than a pass criterion; never
  echo or persist it, and prove a synthetic warning does not corrupt stdout parsing. Set a hard
  60-second child timeout so cold Windows/npm/tsx startup under load does not create a 15-second
  required-gate flake. This proves Windows/npm argument forwarding without starting a lane.
- [ ] Run `npm test -w @housingchoice/app -- performanceSeed` and
  `npm test -w @housingchoice/e2e -- config`. Expected: fail because the exports/scripts do not
  exist.
- [ ] Implement the pure config resolver and the types above. Table-test the exact default login
  email and every `--contract-checkpoint` target/scale/repeat refusal. Keep seed row generation as an
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
  composite `relay_status: 'relay_group#<status>'`, valid participants, the status-appropriate
  owner/pool fields, and a readable thread. A connecting relay deliberately has neither
  `pool_number` nor `participant_phone`; do not invent them. These shapes follow
  `app/src/repos/conversationsRepo.ts:1324-1344`. Other rows cycle tenant, landlord, partner, and
  unknown 1:1 types.
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
- The representative tour and placement self-QA fixtures have no overdue reminder/nudge rung:
  their auxiliary result is empty or every due time is future relative to the anchor. This prevents
  the 20-second overdue refresh from becoming deterministic hermetic noise while preserving the
  production timer contract for ordinary local/hosted data.
- Broadcasts sort newest-first by `created_at`. Index zero is always terminal `sent` when count is
  nonzero, making it first-page reachable; the remainder cycle `failed`, `draft`, `sending`, and
  `sent`. Every row has `_listPartition: 'broadcasts'`, valid stats, and a deduped recipient map.
- Append four constant unmatched-email rows, two `unmatched` and two `quarantined`, with fake
  reserved addresses and IDs shaped `um-<32 lowercase hex>`. These rows are excluded from every
  scale count but included in physical row totals.
- Parent fallback symbols are exactly `lean_tenant`, `lean_landlord`, and `lean_unit`; raw fallback
  IDs may exist in row memory but never in the returned manifest.

**Physical key contract re-derived from the current table definitions:**

| Generated table | Required physical/index fields | Code source |
| --- | --- | --- |
| `contacts` | PK `contactId`; `phone`, `email`, `type` plus `status`, and `housingAuthority` only on rows meant to enter those GSIs | `app/src/lib/tables.ts:76-101` |
| `units` | PK `unitId`; `landlordId`, `status`, and optional sparse `propertyId` | `app/src/lib/tables.ts:103-116` |
| `placements` | PK `placementId`; `tenantId`, `unitId`, `stage`, and optional sparse `tour_date` | `app/src/lib/tables.ts:208-227` |
| `tours` | PK `tourId`; `tenantId`, `unitId`, `status`, `createdAt`; scheduled rows also carry `_schedPartition: 'tours'` and `scheduledAt` | `app/src/lib/tables.ts:477-502` |
| `conversations` | PK `conversationId`; 1:1 rows use the applicable participant key plus `status` and `last_activity_at`; relay rows use `relay_status: 'relay_group#<status>'`, `last_activity_at`, and only status-valid sparse pool fields | `app/src/lib/tables.ts:119-173`; `app/src/repos/conversationsRepo.ts:1324-1344` |
| `messages` | PK `conversationId`; SK `tsMsgId` shaped `<ISO>#<message-id>` | `app/src/lib/tables.ts:175-189` |
| `broadcasts` | PK `broadcastId`; `_listPartition: 'broadcasts'`, `created_at`, and sparse `unitId` when linked | `app/src/lib/tables.ts:300-335` |
| `unmatched_email` | PK `unmatchedId`; feed rows carry `status` and `received_at`; fixed self-QA row is `read: false` | `app/src/lib/tables.ts:545-570`; `app/src/repos/unmatchedEmailRepo.ts:122-139` |

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
  `UnmatchedEmailItem` rather than a generic record. Because `ConversationItem` has
  `[key: string]: unknown` (`app/src/repos/conversationsRepo.ts:221`), `satisfies` is not its
  correctness proof: add a runtime `validatePerformanceConversation` plus unit/integration tests
  that assert `relay_status`, owner, participants, `last_activity_at`, and status-valid
  `pool_number`/`participant_phone` by exact field name. Do not weaken repository types or use
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
- Modify: `app/src/lib/seed/media.ts`
- Modify: `app/src/lib/seedData.ts`
- Modify: `app/scripts/db-seed.ts`
- Modify: `app/test/seedProfile.integration.test.ts`
- Modify: `app/test/seedHistory.test.ts`
- Modify: `app/test/seedLive.test.ts`
- Modify: `app/test/seedMedia.test.ts`
- Modify: `app/test/reseedUnmatchedEmail.test.ts`
- Modify: `app/src/routes/dev.ts`
- Modify: `app/test/devGating.test.ts`

**Interfaces:**

```ts
export async function writePerformanceSeed(deps: {
  config: AppConfig;
  namespace: TableNamespace;
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

export interface DevRouterDeps {
  // Keep every existing slot at app/src/routes/dev.ts:73-96 and add this one.
  performanceReseed?: typeof resetPerformanceData;
}
```

Build the production instance from `config.tablePrefix`, not ambient `process.env`; its `env` is a
fresh object with that exact `TABLE_PREFIX`. Thread it through `resetLocalData`, `seedAll`,
`seedInboundVoiceLineHolder`, `seedLive`, and `seedMedia`. Direct table operations use
`tableNameFor`; media/config construction receives `namespace.env`; the
existing full-profile deadline/reminder/settings repo factories receive `namespace.env` through
their existing `deps.env` seam. Existing callers get a namespace derived from their current env
for backward compatibility. Update the `seedData.ts` barrel, `db-seed.ts`, dev reset, and every
listed seed/reseed test caller in this task; do not leave a positional signature drift for a later
slice. No test mutates `process.env.TABLE_PREFIX`.

`createPerformanceSeedReaders` is the one direct-repository integration path for proving seeded
data. It must reject a missing `config`/prefix at runtime and create a frozen
`readerEnv = Object.freeze({ TABLE_PREFIX: config.tablePrefix }) as NodeJS.ProcessEnv`. Pass
`{ doc, env: readerEnv }` explicitly to `createContactsRepo`, `createUnitsRepo`,
`createPlacementsRepo`, `createToursRepo`, `createConversationsRepo`, `createMessagesRepo`,
`createBroadcastsRepo`, `createUnmatchedEmailRepo`, `createUsersRepo`, `createSettingsRepo`,
`createAiRunsRepo`, `createPoolNumbersRepo`, `createPlacementNudgesRepo`,
`createPlacementDeadlinesRepo`, `createTourRemindersRepo`, `createActivityEventsRepo`,
`createListingSendsRepo`, `createPendingRosterActionsRepo`, `createSuggestionResolutionRepo`,
`createAuditRepo`, `createContactVocabularyRepo`, and `createExtractionRepo`. The last three are
required because audit has a real lean fixture, `/api/today` reads extraction, and the auxiliary
contract includes contact vocabulary (`app/src/repos/auditRepo.ts:54`,
`app/src/repos/extractionRepo.ts:189`, `app/src/repos/contactVocabularyRepo.ts:54`).
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
  throws with table/count/attempt metadata only. It rejects when
  `namespace.tablePrefix !== config.tablePrefix` and uses only `namespace.tableNameFor`; it never
  derives a table name from ambient env.
- Add `POST /__dev/performance/reseed` with route-local `json()`. Resolve
  `const performanceReseed = deps.performanceReseed ?? resetPerformanceData` through the existing
  `DevRouterDeps` injection pattern at `app/src/routes/dev.ts:138`; unit tests inject the slot and
  never clear real tables. Its body is
  `{ input: PerformanceSeedInput, anchor: string }`; the CLI-generated anchor is revalidated and
  the entire config is resolved again before reset. It calls `resetPerformanceData`, clears the
  session epoch cache after reset, and returns only
  `{ ok: true, manifest }`. The manifest contains counts and symbolic fallbacks, never row data.
- The router remains behind existing production/flag/local-endpoint gates; the mutation boundary
  repeats the prefix/endpoint guard.

- [ ] Write failing unit tests in `devGating.test.ts` for successful counts-only output, invalid
  input before reset, lane 0 refusal, exact positive-lane acceptance, absent route when the dev
  router is absent, and response absence of every raw ID prefix.
- [ ] Write the new DynamoDB Local suite only in
  `app/test/performanceSeed.integration.test.ts`. Follow the explicit `env: { TABLE_PREFIX }`
  dependency-injection pattern in `app/test/unitsRepo.integration.test.ts`, not the global
  `process.env.TABLE_PREFIX` mutation in `seedProfile.integration.test.ts`. Preserve the repository's
  Docker-optional default: when DynamoDB Local is unavailable and
  `PERF_SEED_REQUIRE_DYNAMO` is absent, emit the stable warning
  `performance_seed_integration_skipped_dynamodb_unavailable` and mark the suite skipped so an
  ordinary Dockerless `npm test` remains green like its sibling integration suites. When
  `PERF_SEED_REQUIRE_DYNAMO=1`, fail setup instead with stable error
  `dynamodb_local_required`; this is the mandatory mode for every plan-owned targeted proof.
  Create standard tables under two unique high-number `hc-local-<positive>-` prefixes A and B,
  inject only B into the performance path, and delete only those two named throwaway table sets in
  `afterAll`.
- [ ] Update `seedProfile.integration.test.ts` only for the namespace signature and replace its
  process-global prefix mutation with explicit namespace/repository env injection. Update the
  other listed seed/reseed callers and tests in the same slice; preserve their existing coverage.
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
- [ ] Ensure Docker is available and start DynamoDB Local with `npm run db:start` if it is not
  already reachable. Set `PERF_SEED_REQUIRE_DYNAMO=1` only in the targeted command's child
  environment and run `npm test -w @housingchoice/app -- performanceSeed`; require the output to
  name the new integration file and report its tests passed, not skipped. Prove separately that an
  unreachable fake endpoint fails with `dynamodb_local_required` when the signal is set and loudly
  skips when it is absent. Leave the shared DynamoDB Local container running even if this task
  started it; never stop a shared container. Expected: unit and integration tests pass without
  touching lane 0.
- [ ] Run `npm run typecheck` and `npm test -w @housingchoice/app`.
- [ ] Run bare `npm run e2e` after the shared reset/seed signature changes. If a documented flake
  appears, rerun once and record both results. Do not defer this shared-seed regression proof to
  the final slice.
- [ ] Run standalone `git status`, then commit exactly the Task 3 files that changed using explicit
  pathspecs; do not rely on a stale path count.

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

- The profiler has two transport classes. Raw app-port requests are limited to owned-lane proof
  `GET /__dev/ping` and hermetic `POST /__dev/performance/reseed`. Send `/auth/dev-login`,
  `/auth/me`, every `/api/**` request, and all other profiler reads through the dashboard origin
  with its browser/request context so the Vite proxy supplies `x-origin-verify` locally and the
  deployed origin path is preserved in hosted mode. Never copy, read, or synthesize the origin
  secret in profiler code. This follows the pre-validator dev-router mount at
  `app/src/app.ts:85`, origin validator at `app/src/app.ts:87`, post-validator auth/API mounts at
  `app/src/app.ts:163-165`, and proxy header injection at `dashboard/vite.config.ts:13-16,57-69`.
- `/auth/dev-login` body becomes `{ email?: unknown; requireExisting?: unknown }`.
  `requireExisting: true` returns 404 `{ error: 'dev_user_not_found' }` without calling invite.
  Absent or false preserves current auto-provision behavior. A non-boolean supplied value returns
  400. Do not change the dashboard `devLogin()` call.
- `verifyLocalTarget` accepts only `http://localhost:5174`, `http://127.0.0.1:5174`, or IPv6
  loopback port 5174; `GET /__dev/ping` must return `dev: true` and exact `tablePrefix:
  'hc-local-'`. A lane prefix is not the human local stack.
- After the local proof, require `stdin.isTTY` and exact typed text
  `PROFILE <normalized-base-url>`. There is no flag or environment bypass. Only then POST
  `/auth/dev-login` with `{ email, requireExisting: true }`; `email` defaults to the Task 1 value
  `founder@example.com`. Retain storage state in memory, and
  verify `/auth/me` is admin.
- Hosted requires HTTPS and headed mode. Open `/`, let the human perform normal OAuth, and poll
  `/auth/me` until admin or timeout. Then GET `/api/system/flags` and require exact `env: 'dev'`.
  Close the login page, retain the storage-state object in memory, and never write it.
- Before any target proof, capture `profilerCommit` with `git rev-parse --short HEAD` in the
  profiler worktree. Normalize command failure/non-hex output to null without persisting stderr.
  Normalize `/__dev/ping.appCommit` empty string or absence to null. For hermetic, the expected
  target commit is the non-null `profilerCommit`; a pair of non-null unequal revisions is a hard
  wrong-stack refusal, while either null continues as `target_version_unverified`. Local records a
  nonempty ping commit without equality enforcement; hosted records null unless its authenticated
  proof exposes a validated revision. Emit the explicit revision pair in `TargetMetadata`.
- Hermetic verifies `/__dev/ping` against the expected lane prefix and the revision rule above,
  calls only performance reseed on the app port, then uses the dashboard-origin request context to
  authenticate seeded founder with existing-user-only true and verify admin through `/auth/me`.
- Firewall installation is not part of this task; Task 6 installs it immediately after the proofs
  and before any measured navigation.

- [ ] Extend `devGating.test.ts` first: missing user plus `requireExisting: true` is 404 and invite
  count stays zero; false/absent still provisions; seeded existing user succeeds; malformed flag
  is 400.
- [ ] Add fake-fetch/request-context tests for loopback spelling, port, prefix, dev ping shape,
  hosted scheme, admin, exact env, timeout, local TTY refusal, typed-confirmation mismatch, and
  memory-only storage state. Assert raw app-port traffic is limited to ping and reseed; direct
  app-port `/auth/me` and `/api/**` are never attempted, while dashboard-origin requests carry the
  authenticated browser context. Assert no filesystem write API is called from auth. Feed raw
  local and hosted hosts, login emails, OAuth redirects, and response errors through target proof,
  then assert `TargetMetadata` and every thrown safe failure contain only target kind,
  revision/proof status, the normalized `profilerCommit`/`targetAppCommit` pair, and closed reason
  codes.
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
  `automatic_in_scope`, `automatic_out_of_scope`, or `workflow_only`, and as `first_party_api` or
  `outside_interception`. The exact discovered and cataloged fingerprint sets must match both
  ways, so new call sites fail the test.
- The current in-scope automatic-navigation family is fully enumerated: contact detail through
  `markInboxRead`, relay conversation detail through `markConversationRead`, inbox row opening
  through `markInboxRead` or `markConversationRead`, unmatched-email row expansion through
  `markUnmatchedRead`, and tour/placement communication channels through the same inbox or
  conversation mark-read endpoints. Include all three inbox templates:
  `POST /api/inbox/:contactId/read`, id-less `POST /api/inbox/read` for phone-kind rows
  (`dashboard/src/api/endpoints.ts:1493-1503`), and
  `POST /api/conversations/:conversationId/read`; include
  `POST /api/unmatched-email/:unmatchedId/read`. Every in-scope automatic entry must sanitize to an
  intercepted first-party API template.
- Catalog the mount/debounce `POST /api/broadcasts` and unmount/supersession
  `DELETE /api/broadcasts/:broadcastId` from
  `dashboard/src/routes/broadcasts/useComposerDraft.ts:117-205` as `automatic_out_of_scope` because
  `/broadcasts/new` is excluded from the route registry. Do not misclassify them as workflow-only.
  Direct-to-storage media upload and user-initiated create/edit/send/delete/transition actions are
  `workflow_only`; their existence stays cataloged even when they are outside interception.

**Firewall contract:**

- Register the Playwright route with a URL predicate that matches first-party `/api/**`, `/auth/**`,
  and `/__dev/**` except exact pathname `/api/events`. The stream is on a named never-matched list:
  no profiler route handler, sanitizer, recorder, or `continue()` call may ever observe it. Allow
  GET, HEAD, OPTIONS. Abort POST, PUT,
  PATCH, DELETE before the fake origin observes them. Fail on any other method in the scoped set.
- Block service workers in browser context options. Record only method, sanitized template, and
  phase. Cold traffic is always `destination_mount`. For a warm sample, start a fresh recording
  token immediately before the timed click and classify each blocked request from its frame's
  current sanitized page URL at interception time: the exact prepared source URL is
  `source_click`, the resolved destination route is `destination_mount`, and any third page URL
  fails the sample. Do not use a shared mutable phase toggle; same-document React Router
  navigation can race such a toggle.
- A declared no-navigation probe sets destination equal to source and classifies every intercepted
  write under its fresh token as `source_click`. This special case is probe metadata, not a mutable
  runtime phase toggle; it covers unmatched-email expansion without weakening third-page failure
  for normal warm navigation.

- [ ] Before generating the catalog, add independent positive controls against the scanner's raw
  discovered set. Require both `markInboxRead` branches, `markConversationRead`,
  `markUnmatchedRead`, `request` and `requestWithStatus` writes (including placement/tour relay
  provisioning), the raw `fetch` plus `XMLHttpRequest.open('POST', post.url)` presigned-upload
  pair, `/public/housing-fair`, and a no-method request proven GET. Classify the runtime presigned
  URL as the closed path category `external_presigned_storage`; do not require a literal URL that
  cannot exist. A synthetic fixture module with a computed method must fail discovery. These
  controls assert discovery output directly, never merely the populated catalog.
- [ ] Write the AST inventory test and run it once to obtain the complete discovered set. Populate
  the checked-in catalog with every result and the classification above; do not weaken discovery
  to make the list shorter.
- [ ] Write fake HTTP origin tests showing all read methods reach the server, all four write
  methods do not, `/api/events` remains open/usable and the interception-handler spy has zero calls
  for it, non-scoped static/public/storage requests are
  not intercepted, URL-at-interception phase tags separate source/destination writes under a
  same-document navigation race, the explicit source-equals-destination probe remains
  `source_click`, prior preparation writes are outside the sample token, and dynamic/unknown
  methods fail.
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
| `/` | heading `Today` | from `/contacts`, primary nav `Today` | static |
| `/contacts` | heading `Contacts` | from `/`, primary nav `Contacts` | static |
| `/contacts/tenants` | heading `Tenants` | from `/contacts`, filter `Tenants` | static |
| `/contacts/landlords` | heading `Landlords` | from `/contacts`, filter `Landlords` | static |
| `/contacts/unknown` | heading `Unknown` | from `/contacts`, filter `Unknown` | static |
| `/contacts/deleted` | heading `Deleted` | from `/contacts`, filter `Deleted` | static |
| `/listings` | heading `Properties` | from `/`, primary nav `Properties` | static |
| `/listings/deleted` | heading `Deleted properties` | from `/listings`, tab `Deleted` | static |
| `/tours` | heading `Tours` | from `/`, primary nav `Tours` | static |
| `/tours/closed` | heading `Closed tours` | from `/tours`, tab `Closed` | static |
| `/placements` | heading `Placements` | from `/`, primary nav `Placements` | static |
| `/inbox` | heading `Inbox` | from `/`, primary nav `Inbox` | static |
| `/email` | heading `Email`, list `Unmatched email` | from `/`, primary nav `Email` | static, fixed surface, contact-load bearing |
| `/email/quarantine` | heading `Email`, list `Quarantined email` | from `/email`, tab `Quarantine` | static, fixed surface, contact-load bearing |
| `/broadcasts` | heading `Matching` | from `/`, primary nav `Matching` | static |
| `/settings/team` | heading `Settings`, selected tab `Team` | from `/settings/templates`, tab `Team` | static, admin |
| `/settings/templates` | heading `Settings`, selected tab `Templates` | from `/settings/team`, tab `Templates` | static |
| `/settings/notifications` | heading `Settings`, selected tab `Notifications` | from `/settings/templates`, tab `Notifications` | static |
| `/settings/voice` | heading `Settings`, selected tab `Voice` | from `/settings/templates`, tab `Voice` | static |
| `/settings/system` | heading `Settings`, selected tab `System status` | from `/settings/templates`, tab `System status` | static, admin, target-structural note |
| `/settings/ai-runs` | heading `Settings`, selected tab `AI run log` | from `/settings/templates`, tab `AI run log` | static, admin |
| `/settings/numbers` | heading `Settings`, selected tab `Phone numbers` | from `/settings/templates`, tab `Phone numbers` | static |
| `/contacts/:contactId` | group `View` plus settled contact/file surfaces | `/contacts/tenants` exact href | first nondeleted tenant from paged GET |
| `/listings/:unitId` | level-1 property heading | `/listings` exact href | first nondeleted unit from paged GET |
| `/tours/:tourId` | back link `Back to tours` | `/tours` exact href | first upcoming rendered tour |
| `/placements/:placementId` | back link `Back to placements` | `/placements` exact href | first rendered active placement |
| `/conversations/:conversationId` | text `Group text` plus `Back to inbox` | `/inbox` exact href | first readable relay-group inbox row |
| `/broadcasts/:broadcastId` | recipients region | `/broadcasts` exact href | first-page sent/failed row only |

All warm-source and terminal locators in this registry assume Task 9's existing Desktop Chrome
viewport. The settings `<select>` variant and narrow two-pane `View` toggle are explicitly outside
the measured contract; do not silently substitute their locators. This dependency comes from
`dashboard/src/routes/settings/SettingsPage.tsx:13,26-50`,
`dashboard/src/ui/twoPaneShell.module.css:126-169`, and
`dashboard/src/routes/contact/ContactDetail.tsx:496-543`.

**Checked-in endpoint contracts:**

Endpoint paths below are sanitized templates. Braces after a path are the only allowed sorted query
key sets; values stay in memory. Multiplicity is recorded separately and does not widen a set.
Every set below was re-derived from the named current source; a future contract edit must cite the
changed call site and is later proved by Task 13's live checkpoint.

- `COLD_SHELL_GETS`: `/auth/me {}`, `/api/inbox {filter,limit}`, and
  `/api/unmatched-email {filter}`. Source:
  `dashboard/src/app/AuthContext.tsx:27-44` and
  `dashboard/src/app/UnreadContext.tsx:27-104`. `/api/events` is not a GET contract: it is
  never matched by interception or readiness.
- `WARM_SOURCE_GETS` is completely derived from the explicit source column above: `/contacts` uses
  `CONTACT_LIVE_WALK` for all three types; `/` uses `TODAY_GETS`; `/listings` uses
  `UNIT_LIVE_WALK`; `/tours` uses `TOUR_LIST_ACTIVE_GETS`; `/email` uses `EMAIL_GETS`;
  `/settings/team` uses `TEAM_GETS`; `/settings/templates` uses `TEMPLATE_GETS`;
  `/contacts/tenants` uses the tenant `CONTACT_LIVE_WALK`; `/placements` uses
  `PLACEMENT_LIST_GETS`; `/inbox` uses `INBOX_GETS`; and `/broadcasts` uses
  `BROADCAST_LIST_GETS`. Those are the only source routes in the 28 bindings.
  The source-path and accessible-link declarations come from `dashboard/src/app/nav.ts:55-87`,
  `dashboard/src/app/NavContents.tsx:32-116`,
  `dashboard/src/routes/contacts/ContactsList.tsx:43-52,241-262`,
  `dashboard/src/routes/listings/ListingsList.tsx:71-76,155-166`,
  `dashboard/src/routes/tours/ToursPage.tsx:173-178,263-274`,
  `dashboard/src/routes/email/EmailTriage.tsx:286-305`, and
  `dashboard/src/routes/settings/SettingsPage.tsx:11-55` plus
  `dashboard/src/routes/settings/settingsTabs.ts:20-32`. Source preparation is asserted separately
  and discarded before `beginSample`; it cannot satisfy destination evidence.
- `CONTACT_LIVE_WALK`: `/api/contacts {limit,type}` and `{cursor,limit,type}`;
  `CONTACT_DELETED_WALK` adds `deleted`. Single-filter pages run one type; `all`/`deleted`
  consumers fan out tenant, landlord, and unknown as three independent chains. Source:
  `dashboard/src/routes/contacts/useContacts.ts:17-40,58-91` and
  `dashboard/src/api/endpoints.ts:1115-1138`.
- `UNIT_LIVE_WALK`: `/api/units {}` and `{cursor}`; `UNIT_DELETED_WALK` adds `deleted`.
  Source: `dashboard/src/routes/listings/useListings.ts:13-25,36-55` and
  `dashboard/src/api/endpoints.ts:845-858`.
- `TODAY_GETS`: `/api/today {day,toursFrom,toursTo}`; only its 404 compatibility branch adds
  `/api/placements {}`, `/api/conversations {}`, and `/api/tours {from,to}`. Source:
  `dashboard/src/routes/today/useToday.ts:47-67` and `dashboard/src/api/endpoints.ts:110-141`.
- `TOUR_LIST_ACTIVE_GETS`: `/api/tours {from,to}`, `/api/tours {status}` plus both contact walks
  and both unit walks. `TOUR_LIST_CLOSED_GETS` contains the same query-key set because
  `useTours()` still mounts, while `useClosedTours(true)` adds two more calls of the already
  declared `{status}` shape. Source: `dashboard/src/routes/tours/ToursPage.tsx:180-194` and
  `dashboard/src/routes/tours/useTours.ts:37-44,52-62,109-123`.
- `PLACEMENT_CONTACT_LIVE_WALK`: `/api/contacts {type}` and `{cursor,type}`;
  `PLACEMENT_CONTACT_DELETED_WALK` adds `deleted`. These are tenant-only and never contain
  `limit`. `PLACEMENT_LIST_GETS` is `/api/placements {}` and `{cursor}`, both placement-specific
  contact walks, and both unit walks. Source:
  `dashboard/src/routes/placements/usePlacements.ts:33,50-64,73-93,112-128,214-225`.
- `INBOX_GETS`: `/api/inbox {filter,limit}`. `EMAIL_GETS`:
  `/api/unmatched-email {filter}` plus `CONTACT_LIVE_WALK`. `BROADCAST_LIST_GETS`:
  `/api/broadcasts {limit}` because `BroadcastsList` initializes its filter to `all`; any non-`all`
  filter would add `status` and is outside the route's passive default branch. Sources:
  `dashboard/src/routes/inbox/useInbox.ts:46-155`,
  `dashboard/src/routes/email/useUnmatchedEmail.ts:67-158`,
  `dashboard/src/routes/email/EmailTriage.tsx:238`,
  `dashboard/src/routes/broadcasts/BroadcastsList.tsx:43-46`, and
  `dashboard/src/routes/broadcasts/useBroadcastsList.ts:29-50,89-97`.
- Settings sets: `TEAM_GETS` is `/api/users {}`; `TEMPLATE_GETS` is `/api/settings {}`;
  `NOTIFICATION_GETS` is empty; `VOICE_GETS` is `/api/users/me {}`; `SYSTEM_GETS` is
  `/api/settings {}`, `/api/system/flags {}`, `/api/system/alarms {}`, and
  `/api/system/errors {since}`; `AI_RUN_GETS` is `/api/system/flags {}` and
  `/api/ai-runs {scope}`; `NUMBER_GETS` is `/api/settings {}` and `/api/pool-numbers {}`.
  Sources: `dashboard/src/routes/settings/TeamSection.tsx:31-34`,
  `dashboard/src/routes/settings/useSettings.ts:36-53`,
  `dashboard/src/routes/settings/useNotifications.ts:79-96`,
  `dashboard/src/routes/settings/VoiceSection.tsx:27`,
  `dashboard/src/routes/settings/useSystemStatus.ts:35-198`,
  `dashboard/src/routes/settings/aiRuns/AiRunsSection.tsx:22-25`,
  `dashboard/src/routes/settings/aiRuns/useAiRuns.ts:34-58`, and
  `dashboard/src/routes/settings/NumbersSection.tsx:84-111,175-180`.
- `CONTACT_DETAIL_GETS`: `/api/contacts/:contactId {}`,
  `/api/contacts/:contactId/suggestions {}`, `/api/users/me {}`,
  `/api/contacts/:contactId/timeline {}`, `/api/placements {}`, `/api/units {}`,
  `/api/contacts/:contactId/listings-sent {}`, `/api/contacts/:contactId/media {}`,
  `/api/contacts/:contactId/relay-groups {}`, and `CONTACT_LIVE_WALK`. The selected tenant branch
  adds `/api/tours {tenantId}`; a landlord branch instead sends one `/api/tours {unitId}` per owned
  unit; unknown/partner sends neither. The timeline's 404 compatibility branch adds
  `/api/conversations {}` and `/api/conversations/:conversationId/messages {}`. Source:
  `dashboard/src/routes/contact/ContactDetail.tsx:111-140`,
  `dashboard/src/routes/contact/useContact.ts:23-64`,
  `dashboard/src/routes/contact/useSuggestions.ts:46-72`,
  `dashboard/src/routes/contact/useContactFile.ts:91-152`, and
  `dashboard/src/routes/contact/useContactTimeline.ts:136-172,188-337`.
- `UNIT_DETAIL_GETS`: `/api/units/:unitId {}`, `/api/units {}`, `/api/placements {}`,
  `/api/units/:unitId/related {}`,
  `/api/units/:unitId/recipients {}`, `/api/units/:unitId/similar {}`,
  `/api/units/:unitId/activity {}`, `/api/tours {unitId}`, `CONTACT_LIVE_WALK`, and
  `CONTACT_DELETED_WALK`. A selected `unit_has_landlord` branch adds
  `/api/contacts/:contactId {}`; `unit_without_landlord` does not issue it. Source:
  `dashboard/src/routes/listing/useListing.ts:110-185` and
  `dashboard/src/routes/listing/ListingDetail.tsx:175-192`.
- `TOUR_DETAIL_BASE_GETS`: `/api/tours/:tourId {}`, `/api/units/:unitId {}`,
  `/api/contacts/:contactId {}`, `/api/tours/:tourId/roster {}`, `/api/conversations {}`,
  `/api/tours/:tourId/activity {limit}`, and `/api/tours/:tourId/reminders {}`. Optional
  extra-roster members repeat `/api/contacts/:contactId`. Source:
  `dashboard/src/routes/tours/useTour.ts:85-122`,
  `dashboard/src/routes/tours/TourDetail.tsx:170-216`,
  `dashboard/src/routes/shared/useRoster.ts:76-137`,
  `dashboard/src/routes/shared/useRosterContacts.ts:29-61`,
  `dashboard/src/routes/tours/useTourChannels.ts:164-241`,
  `dashboard/src/routes/tours/useTourActivity.ts:52-103`, and
  `dashboard/src/routes/tours/RemindersPanel.tsx:141-221`.
- `PLACEMENT_DETAIL_BASE_GETS`: `/api/placements/:placementId {}`, `/api/units/:unitId {}`,
  `/api/contacts/:contactId {}`, `/api/placements/:placementId/roster {}`,
  `/api/conversations {}`, `/api/placements/:placementId/history {limit}`, and
  `/api/placements/:placementId/nudges {}`. Optional extra-roster members repeat
  `/api/contacts/:contactId`. Source:
  `dashboard/src/routes/placements/PlacementDetail.tsx:166-296`,
  `dashboard/src/routes/shared/useRoster.ts:76-137`,
  `dashboard/src/routes/shared/useRosterContacts.ts:29-61`,
  `dashboard/src/routes/placements/usePlacementChannels.ts:165-249`,
  `dashboard/src/routes/placements/usePlacementHistory.ts:52-103`, and
  `dashboard/src/routes/placements/usePlacementNudges.ts:56-122`.
- Tour and placement details select one conditional passive branch. If the row has its group-thread
  pointer, `GROUP_THREAD_GETS` adds `/api/conversations/:conversationId {}`,
  `/api/conversations/:conversationId/members {}`,
  `/api/conversations/:conversationId/messages {}`, and
  `/api/conversations/:conversationId/scheduled {}` and permits
  `POST /api/conversations/:conversationId/read`. Otherwise `PERSON_THREAD_GETS` adds
  `/api/contacts/:contactId/timeline {}`; its 404-only fallback adds
  `/api/conversations {}` and `/api/conversations/:conversationId/messages {}`. It permits
  `POST /api/inbox/:contactId/read`. Source:
  `dashboard/src/routes/tours/TourConversation.tsx:117-119,420-439`,
  `dashboard/src/routes/placements/PlacementConversation.tsx:110-112,280-295`,
  `dashboard/src/routes/conversation/useRelayThread.ts:190-209`,
  `dashboard/src/routes/contact/ContactCommsTab.tsx:64-122`, and
  `dashboard/src/routes/contact/useContactTimeline.ts:136-172`.
  Do not include `CONTACT_LIVE_WALK`; passive detail navigation never mounts it.
- `CONVERSATION_DETAIL_GETS`: `/api/conversations/:conversationId {}`,
  `/api/conversations/:conversationId/members {}`,
  `/api/conversations/:conversationId/messages {}`,
  `/api/conversations/:conversationId/scheduled {}`, and `CONTACT_LIVE_WALK`. Source:
  `dashboard/src/routes/conversation/ConversationDetail.tsx:74-218` and
  `dashboard/src/routes/conversation/useRelayThread.ts:190-209`.
- `BROADCAST_DETAIL_GETS`: `/api/broadcasts/:broadcastId/results {}`. Source:
  `dashboard/src/routes/broadcasts/useBroadcastResults.ts:48-155`. The resolver excludes
  `sending`, so its two-second sending poll is not an allowed measured branch.
- `BLOCKED_WRITE_CONTRACTS`: contact detail and person-thread branches use
  `POST /api/inbox/:contactId/read`
  (`dashboard/src/routes/contact/useMarkContactRead.ts:15-47`,
  `dashboard/src/routes/tours/useTourChannels.ts:260-280`, and
  `dashboard/src/routes/placements/usePlacementChannels.ts:268-290`);
  conversation/group-thread branches use
  `POST /api/conversations/:conversationId/read`
  (`dashboard/src/routes/conversation/ConversationDetail.tsx:210-214`); inbox row opening selects
  one of those or id-less `POST /api/inbox/read` by row kind
  (`dashboard/src/routes/inbox/useInbox.ts:180-202`); unmatched-email expansion uses
  `POST /api/unmatched-email/:unmatchedId/read`
  (`dashboard/src/routes/email/UnmatchedRow.tsx:98-116`). All other registered routes have an empty
  automatic-write set, proved by Task 6's complete mutation inventory rather than assumption.
- The hermetic probes declare `INBOX_GETS`, contact/relay destination GETs as applicable,
  `GET /api/unmatched-email/:unmatchedId {}`, and the closed blocked-write templates
  `POST /api/inbox/:contactId/read`, id-less `POST /api/inbox/read`,
  `POST /api/conversations/:conversationId/read`, and
  `POST /api/unmatched-email/:unmatchedId/read`. Sources:
  `dashboard/src/routes/inbox/useInbox.ts:180-202`,
  `dashboard/src/api/endpoints.ts:1493-1503`, and
  `dashboard/src/routes/email/UnmatchedRow.tsx:98-116`. The probes are not extra registry routes.

The 28 route bindings are exact:

For endpoint enforcement, every declaration carries
`requirement: 'required' | 'conditional'`. `required` means the selected route branch must observe
at least one non-aborted completion of that exact template/query-key shape. `conditional` means the
shape is allowed when its runtime precondition occurs but its absence is not a mismatch. An
observed conditional endpoint must still match exactly and cannot satisfy a different required
entry. Pagination continuations and only the 404 compatibility fallbacks named above are
conditional. All other passive mount calls are required after applying the selected branch.

Define the sanitized, ID-free `RouteContractBranch` union as `{ kind: 'none' }`,
`{ kind: 'contact_detail'; contactType: 'tenant' | 'landlord' | 'other'; landlordUnitCount: number }`,
`{ kind: 'unit_detail'; hasLandlord: boolean }`, or
`{ kind: 'thread_detail'; thread: 'group_thread' | 'person_thread' }`. The resolver records the
matching branch in the sample closure before collection. Contact detail promotes tenant tours, or
landlord tours when `landlordUnitCount > 0`, to required; the other branch omits them. Unit detail
promotes the landlord contact only when `hasLandlord`. Tour and placement detail promote exactly
the selected group/person set. Today and contact/person timeline 404 fallbacks remain conditional
because their precondition is a response outcome, not a resolver choice.

For a cold sample, evaluate `COLD_SHELL_GETS union selected destination declarations`; for warm,
evaluate only the selected destination declarations. Background refresh policy is separate in
Task 8 and never widens either requirement class. `/api/events` and `WARM_SOURCE_GETS` never enter
measured destination evidence. Implement the rule once as
`expectedGets(route: RouteDefinition, mode: 'cold' | 'warm', branch: RouteContractBranch): readonly EndpointContract[]`.
It returns a newly frozen, deduplicated array whose entries retain their requirement class; callers
cannot mutate registry constants. The collector, checkpoint, and self-QA subset gate call this
function rather than assembling their own allowlists. A missing-endpoint failure applies only to a
selected `required` entry.

Define `expectedBlockedWrites(route, mode, branch)` as a frozen
`ReadonlySet<BlockedWriteTuple>`, where a tuple is symbolic surface, method, sanitized template,
and phase. Sets express legitimate multiplicity: warm relay conversation navigation permits both
`source_click` and `destination_mount` tuples for
`POST /api/conversations/:conversationId/read`; the supplemental contact inbox probe permits both
phases for `POST /api/inbox/:contactId/read`. Cold detail samples permit only their destination
tuple. Tour/placement choose the group or person branch recorded by their resolver. No code infers
an exact-one-write rule from a set.

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
| `/tours/:tourId` | `TOUR_DETAIL_BASE_GETS` plus selected group/person branch | selected conversation/contact mark-read set | `TOUR_DETAIL_TERMINAL` |
| `/placements/:placementId` | `PLACEMENT_DETAIL_BASE_GETS` plus selected group/person branch | selected conversation/contact mark-read set | `PLACEMENT_DETAIL_TERMINAL` |
| `/conversations/:conversationId` | `CONVERSATION_DETAIL_GETS` | cold destination tuple; warm source plus destination tuple set | `CONVERSATION_DETAIL_TERMINAL` |
| `/broadcasts/:broadcastId` | `BROADCAST_DETAIL_GETS` | none | `BROADCAST_DETAIL_TERMINAL` |

**Checked-in terminal contracts:**

Locators below are constructors, not captured content. Static `getByText`/`hasText` matching is
allowed; code never calls `textContent`, `innerText`, or persists matched text.
Never rely on Playwright's default substring behavior: a literal accessible name or static string
is exact unless its entry explicitly says `prefix`, `contains`, or gives an anchored regular
expression. Implement `prefix` as an anchored regular expression. A role-only locator has no
`name` option; prose such as "mobile teammate list" is descriptive, not an accessible name.

- `TODAY_TERMINAL`: populated is any role `list` named `Group texts to close`,
  `Needs you now`, `Tours today`, `Unreplied`, `Follow-ups due`, or
  `AI suggestions to review`; empty is exact `All caught up`; error is role `alert` containing
  `We couldn't load your queue`. Source: `dashboard/src/routes/today/Today.tsx:27-31,172-205`.
- `CONTACT_LIST_TERMINAL(heading)`: populated is role `list` named `heading`; empty is exact
  `No <lowercase heading> yet`; error is the page role `alert`. `UNIT_LIST_TERMINAL(heading)` uses
  role `list` named `Properties`; its exact empty strings are `No properties yet` and
  `No deleted properties`; error is the page role `alert`. Sources:
  `dashboard/src/routes/contacts/ContactsList.tsx:232,290-301` and
  `dashboard/src/routes/listings/ListingsList.tsx:144,248-257`.
- `TOUR_ACTIVE_TERMINAL`: wait until both regions `Upcoming tours` and `Needs booking` exist;
  populated means either contains a role `list`, empty means both exact strings
  `No tours scheduled in the next 30 days.` and `No unbooked tour requests.` are visible, and error
  is role `alert`. `TOUR_CLOSED_TERMINAL` uses role `list` named `Closed tours list`, exact empty
  `No closed or canceled tours yet.`, or role `alert`. Source:
  `dashboard/src/routes/tours/ToursPage.tsx:250-346`.
- `PLACEMENT_LIST_TERMINAL`: loaded structure is searchbox `Search placements`; populated is any
  descendant role `list`, empty is exact `No active placements.`, and error is role `alert` with
  exact `We couldn't load placements. Please try again.`. `INBOX_TERMINAL` uses role `list` named
  `Conversations`, exact empty `No conversations yet` (or structural pending
  `The inbox turns on with its backend`), and role `alert`. The generated hermetic result must take
  the populated branch. Sources:
  `dashboard/src/routes/placements/PlacementsPage.tsx:128-134,169-176` and
  `dashboard/src/routes/inbox/Inbox.tsx:53-75`.
- `EMAIL_TERMINAL`: populated is role `list` named `Unmatched email` or `Quarantined email`; empty
  is exact `No unmatched email` or `Quarantine is empty` (or structural pending
  `Email triage turns on with its backend`); error is role `alert`. The fixed hermetic fixtures
  must take the populated branch. `BROADCAST_LIST_TERMINAL` uses role `list` named
  `Property sends`, exact empty `No sends yet`, or role `alert`. Sources:
  `dashboard/src/routes/email/EmailTriage.tsx:276-348` and
  `dashboard/src/routes/broadcasts/BroadcastsList.tsx:130-140`.
- `TEAM_TERMINAL`: at the contracted desktop viewport, populated is the role-only `table`; empty
  is anchored prefix `^No teammates yet`; error is role `alert`. The narrow role-only teammate
  `list` has no accessible name and is recorded only as an out-of-contract responsive alternative.
  `TEMPLATE_TERMINAL` is textbox with anchored accessible-name regex
  `^Missed-call auto-text [0-9]+/320$` or role `alert`. `NOTIFICATION_TERMINAL` is exact heading
  `Notifications`; it has no tracked mount request or asynchronous data branch, so the heading is
  produced in the same render as its device-capability content and heading plus settle is the
  honest terminal. `VOICE_TERMINAL` is a
  textbox named `Your mobile number` for an unverified user, or exact static text `Your cell` plus
  role `status` for the seeded verified founder; error is role `alert`. Sources:
  `dashboard/src/routes/settings/TeamSection.tsx:42-91`,
  `dashboard/src/routes/settings/TemplatesSection.tsx:149-199`,
  `dashboard/src/routes/settings/NotificationsSection.tsx:22-100`, and
  `dashboard/src/routes/settings/VoiceSection.tsx:93-127,176`.
- `SYSTEM_TERMINAL` is compound and every subcondition is required. First, the exact quiet-hours
  checkbox `Pause automated messages overnight` proves the async settings branch loaded. Second,
  the role `listitem` with anchored name `^Environment: ` proves the sibling flags list reached its
  ready branch; do not scope a list beneath the `Go-live flags` heading. Third, the block containing
  exact heading `Alarms` must independently expose a role-only `list`, exact
  `Available in deployed environments.`, exact `No alarms configured for this environment.`, or
  role `alert`. Fourth, the block containing exact heading `Recent errors` must independently
  expose a role-only `list`, exact `Available in deployed environments.`, exact
  `No recent errors in this window.`, or role `alert`. Any alert classifies error; all four
  subconditions must otherwise resolve before populated. `AI_RUN_TERMINAL` uses role `list` named
  `AI runs`, exact empty `No extraction runs match this scope.`, or role `alert`.
  `NUMBER_TERMINAL` requires two independent positive branches. The `Our number` block must expose
  exact `Couldn't load our number.`, exact `Not set`, or an allowlisted formatted-number match
  `^(?:\([0-9]{3}\) [0-9]{3}-[0-9]{4}|\+[0-9]{8,15})$`; never use absence of `Loading` as its
  signal and never retain the matched value. The admin pool must expose role `list` named
  `Pool number counts`, exact empty
  `No group text numbers yet - a number is provisioned with the first group text.`, or role
  `alert`. Sources: `dashboard/src/routes/settings/QuietHoursSection.tsx:135-155`,
  `dashboard/src/routes/settings/FlagPills.tsx:41-69`,
  `dashboard/src/routes/settings/AlarmGrid.tsx:43-95`,
  `dashboard/src/routes/settings/RecentErrors.tsx:69-129`,
  `dashboard/src/routes/settings/aiRuns/AiRunList.tsx:43-47`, and
  `dashboard/src/routes/settings/NumbersSection.tsx:150-164,232-253`.
- Detail contracts have no empty branch; missing data is a resolver skip. The representative
  tenant contact requires heading with anchored name `^Details(?: Edit)?$` plus exact region
  `Communications and activity`; these are
  both visible at the desktop viewport and replace the narrow-only `View` toggle. Property uses a
  level-1 heading plus heading `Photos`; tour, placement, and
  conversation use exact links `Back to tours`, `Back to placements`, and `Back to inbox`;
  broadcast results uses heading `Recipients` plus its role `list` or exact
  `No recipients recorded yet.`. A visible load/not-found or required-subpanel role `alert`
  classifies the matching detail terminal as error before populated.
  Sources: `dashboard/src/routes/contact/ContactDetail.tsx:151-164,496-543`,
  `dashboard/src/routes/contact/TenantFile.tsx:97-160`,
  `dashboard/src/routes/contact/Timeline.tsx:1168-1201`,
  `dashboard/src/ui/twoPaneShell.module.css:89-90,147-148`,
  `dashboard/src/routes/listing/ListingDetail.tsx:259-266,630,1180-1187`,
  `dashboard/src/routes/tours/TourDetail.tsx:551`,
  `dashboard/src/routes/placements/PlacementDetail.tsx:515`,
  `dashboard/src/routes/conversation/ConversationDetail.tsx:379`, and
  `dashboard/src/routes/broadcasts/BroadcastResults.tsx:101-162`.

For each row, declare stable label, role, route template, resolver, source route state, exact href
locator, terminal populated/empty/error locators, expected endpoint-template set, stream
exclusions, source/load scale flags, and target-structural note. The contact-load-bearing flag also
applies to routes that passively mount `useContacts`: contact lists, email, tour lists, contact
detail, property detail, and conversation detail. It is false for tour detail and placement detail;
`PeopleCard`'s `useContacts` consumer exists only inside the closed-by-default
`AddAnyContactForm` (`dashboard/src/routes/shared/PeopleCard.tsx:732`). Record that discrepancy as
the adjudicated spec erratum stated at the top of this plan.

Resolvers use authenticated GETs and page according to the real endpoint contract, keep IDs only
in closure memory, and return either `{ kind: 'resolved', coldPath, warmHref, branch }` or an
explicit skip reason. `branch` is the matching sanitized `RouteContractBranch`; contact and unit
resolvers retain the type/count or landlord-presence facts above, and tour/placement retain the
group/person choice. They never write an ID to evidence. Warm detail locators are
`page.getByRole('link').filter({ has: page.locator('[href="<exact in-memory href>"]') })` or the
equivalent exact `locator('a[href=...]')` plus role assertion; they never select by domain text.
They never click Load more. Broadcast selection is restricted to the first 50 API rows and inbox
relay selection stays below its generated cap.

The resolver request contracts are explicit:

- contact: page `/api/contacts?limit=100&type=tenant` by opaque cursor; never send
  `deleted=false`, because `getContacts` omits false (`dashboard/src/api/endpoints.ts:1115-1138`).
  Choose the first nondeleted row under API order, then require its exact link on
  `/contacts/tenants`;
- property: page `/api/units` by opaque cursor; omit `deleted` unless true, matching
  `dashboard/src/api/endpoints.ts:845-858`. Choose the first nondeleted row under API order, then
  require its exact link on `/listings`;
- tour: at resolver execution evaluate the source browser's current clock/timezone and compute its
  local midnight and `to = local-midnight + 30 days`, matching the inclusive query values from
  `toursDateRange` (`dashboard/src/routes/tours/useTours.ts:37-44`). Do not import that React hook
  across workspaces; implement a small pure e2e helper with a source-citation comment and parity
  tests for DST/month/year boundaries. Keep ISO values only in resolver memory and do not use the
  seed anchor. GET that live `from`/`to` window, require `status === 'scheduled'` as the page does
  (`useTours.ts:68-72`), choose the first rendered upcoming row under page sort, and require its
  exact link on `/tours`;
- placement: page `/api/placements` by cursor, choose the first active row under API order, then
  require its exact link on `/placements`
  (`dashboard/src/routes/placements/usePlacements.ts:50-64,214-225`);
- conversation: GET `/api/inbox?filter=all&limit=30`, choose the first `relay_group` row from the
  additively merged relay rows, then require its exact `/conversations/...` link on `/inbox`
  (`dashboard/src/routes/inbox/useInbox.ts:46-155`);
- broadcast: GET only `/api/broadcasts?limit=50`, choose the first `sent` or `failed` row, never
  page or accept `sending`, then require its exact results link on `/broadcasts`
  (`dashboard/src/routes/broadcasts/useBroadcastsList.ts:29-50,89-97`).

- [ ] Write failing registry tests asserting the exact 28 keys above, no `/settings` redirect,
  no public/create/catch-all route, unique keys, role/readiness/source completeness, scale flags,
  template-only paths, and no raw-ID field on a resolved result.
- [ ] Mechanically inspect `dashboard/src/App.tsx` route elements in the test and compare the
  implemented in-scope path set to the registry, with an explicit checked-in exclusion list for
  `/p/:unitId`, `/join`, `/broadcasts/new`, `/settings`, and `*`. Parse the dynamic placeholder
  generator at `dashboard/src/App.tsx:218-222` together with `allNavTargets()` and `IMPLEMENTED`;
  an unresolved/nonliteral `<Route path>` expression fails unless its exact expression and
  resolved paths are in the checked-in exclusion record. Assert today's
  `allNavTargets - IMPLEMENTED` difference is empty. A future implemented read-only route or
  newly generated placeholder must fail until registered or explicitly excluded.
- [ ] Add fake paged API plus fake DOM tests for exact fixture-to-link binding, broadcast terminal
  first-page eligibility, relay-only eligibility, missing fixture, missing rendered link, source
  timeout, and the rule that an API-page selection never substitutes a different DOM row. Freeze
  the seed anchor at a different day than resolver time and test a resolver call across local
  midnight to prove the live tour window is recomputed.
- [ ] Assert every route expands to exactly the endpoint and terminal contracts above, every
  observed query-key set is one declared shape, stream/source GETs cannot enter destination
  evidence, every literal/regex locator carries its explicit exactness mode, and a synthetic
  undeclared template makes the registry test fail. Prove the broadcast default `all` branch emits
  `{limit}` and a non-default filter would emit the out-of-contract `{limit,status}` shape. Assert
  every warm source and terminal declares the Desktop Chrome viewport dependency.
- [ ] Deep-compare `expectedGets` for every one of the 28 route bindings in both modes, including
  every exact query-key shape and selected `RouteContractBranch`. Prove cold retains and accepts
  shell requests, warm excludes shell and `WARM_SOURCE_GETS`, required entries fail when missing,
  absent conditional continuations/fallbacks pass, observed conditional entries still require an
  exact declaration, tenant/landlord/other contact branches differ, unit landlord presence differs,
  group/person branches differ, returned arrays are immutable, and an undeclared query key fails. Also
  deep-compare `expectedBlockedWrites` as sets for cold/warm conversation detail, the two
  tour/placement branches, and both supplemental row probes; include the legitimate two-phase
  same-template warm cases.
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
2. Track first-party non-stream GET request start/finish/failure through CDP Network events. Exclude
   exact `/api/events` before creating a pending request or evidence row. Track
   request IDs but store only sanitized evidence. Use `responseReceived - requestWillBeSent` for
   TTFB and `loadingFinished - requestWillBeSent` for duration. Use `encodedDataLength` for bytes;
   never call `response.body()`. `loadingFailed` always removes the request from pending;
   `canceled === true` becomes outcome `aborted`, other failures become `failed`, and an aborted-only
   request cannot satisfy a required endpoint.
3. Poll URL plus the route's heading/region and populated/empty/error terminal locators every
   100 ms by default. Do not read `textContent`; use role/visibility/count/state only.
4. `readyMs` is the later of the final tracked network event and first observed terminal UI state,
   relative to sample start. Confirm it only after 500 ms with no later qualifying request or UI
   transition. Do not add the settle window to `readyMs`.
5. Timeout preserves the sanitized request evidence and current terminal classification.

**Repeating-network policy re-derived from the current dashboard:**

- The repeating timer inventory is: `/api/system/alarms` every 60 seconds
  (`dashboard/src/routes/settings/useSystemStatus.ts:124-132`); tour reminders every 20 seconds
  while an overdue rung remains plus a one-shot due-time anchor
  (`dashboard/src/routes/tours/RemindersPanel.tsx:47-72,188-208`); placement nudges with the same
  policy (`dashboard/src/routes/placements/usePlacementNudges.ts:96-116`); and broadcast results
  every two seconds only while status is `sending`
  (`dashboard/src/routes/broadcasts/useBroadcastResults.ts:46,140-155`). The resolver excludes a
  sending broadcast, so seeing that poll in a measured sample is contract drift, not background.
- The SSE refresh inventory is the 300 ms debounces in `UnreadContext`, `useToday`, `useInbox`,
  `useUnmatchedEmail`, `useRoster`, `useTourChannels`, `usePlacementChannels`, and
  `useContactTimeline`, plus the 400 ms broadcast-results debounce. Source:
  `dashboard/src/app/UnreadContext.tsx:19,52-115`,
  `dashboard/src/routes/today/useToday.ts:39,126-145`,
  `dashboard/src/routes/inbox/useInbox.ts:49,139-155`,
  `dashboard/src/routes/email/useUnmatchedEmail.ts:69,142-158`,
  `dashboard/src/routes/shared/useRoster.ts:98-137`,
  `dashboard/src/routes/tours/useTourChannels.ts:100,221-241`,
  `dashboard/src/routes/placements/usePlacementChannels.ts:101,229-249`,
  `dashboard/src/routes/contact/useContactTimeline.ts:91,320-337`, and
  `dashboard/src/routes/broadcasts/useBroadcastResults.ts:41,120-138`. The EventSource 10-second
  watchdog is network-silent while healthy (`dashboard/src/api/EventStreamProvider.tsx:93,264`).
- Define a checked-in `BACKGROUND_REFRESH_GETS` map from those exact source fingerprints to their
  already-declared endpoint/query shapes. During cold, shell GETs are required until their initial
  completion; later exact first-page refetches are `background_shell`. During warm, shell inbox and
  unmatched-email refetches are always `background_shell`. For a route-owned timer/SSE endpoint,
  requests remain `required` until the endpoint has a non-aborted completion and terminal UI is
  visible; only a later repeat of the same transient in-memory full URL from a cataloged refresh
  fingerprint becomes `background_refresh`. Raw URL comparison never leaves collector memory.
- Background requests are preserved as sanitized `RequestEvidence`, counted only in
  `backgroundRequestCount/backgroundTransferBytes`, and surfaced as a background-noise warning.
  They do not reset readiness quiet, satisfy required endpoint contracts, enter primary API
  count/byte rankings, or widen `expectedGets`. An endpoint outside the selected
  required/conditional declarations and the explicit background map remains `unmatched_api` and
  fails self-QA. This separates real page-load work from unrelated live SSE/poll noise without
  hiding it.

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
`error_other`. Count every started request, including aborted work, in its resource class; sum only
actual encoded bytes. This makes contact detail's initial aborted file batch visible rather than
silently treating it as useful data.

- [ ] Write fake-clock/unit tests for a heading that appears early, a request that finishes later,
  terminal UI after network, a late request resetting quiet, settle not added to readyMs, polling
  cadence, event-stream exclusion, timeout retention, source-preparation timeout isolation, and
  token/native-cutoff rejection of late events from a prior sample and explicit normalization of
  page, CDP, and Node offsets without cross-clock absolute comparison.
- [ ] Write CDP-adapter tests with synthetic Network events for duration/TTFB/bytes, failed/null
  fields, static and third-party classification, unknown API handling, no body retrieval, and
  `loadingFailed`/canceled completion. Model contact detail's first five-request batch abort followed
  by its live batch: both starts count, aborted rows are labeled, readiness pending is cleared, and
  only a non-aborted required completion satisfies the endpoint.
- [ ] Table-test every timer/SSE fingerprint above. Prove initial required calls affect readiness;
  declared later repeats are retained only as background evidence; warm shell refreshes do not
  cause a destination subset failure; undeclared repeats still fail; and `/api/events` creates no
  pending/evidence row.
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
  source and wait with the separate source timeout. Resolve the exact in-memory href and, for tour
  or placement detail, retain the conditional `group_thread`/`person_thread` branch; retain the
  contact-type/landlord-unit-count and unit-landlord-presence branches for their detail routes.
  Store only the sanitized `RouteContractBranch` in the sample closure. Set firewall
  source/destination URL predicates, atomically call `beginSample` to clear every collector, start
  timing immediately before the exact accessible click, wait for destination ready, and collect.
  For warm samples, call page-side `beginSample(token, performance.now())` with `page.evaluate` in
  the already-loaded source document and start CDP/Node collectors with the same token and their
  native cutoffs before the click.
  The interception handler derives source/destination phase from frame URL; the driver never flips
  a mutable phase flag. Preparation requests and observer events are discarded rather than
  attached to the destination.
- Do one discarded cold warmup of `/`, the first route in registry declaration order, for
  hermetic/local; it is independent of shuffled/rotated measured order. Hosted skips it. The bundle
  is currently not code-split. Record the fixed warmup route and choice in the manifest.
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
  interception-time URL phase classification, conditional detail branch retention, deterministic
  rotated order, fixed declaration-order `/` warmup
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
  long-task total, DOM count, and per-`ResourceClass` request counts. Every row includes scale
  flags, any client truncation, and background request count/bytes as noise fields separate from
  primary API metrics.
- Compare schema plus matching route/mode keys. Metric deltas cover readyMs, API count, API bytes,
  long tasks, DOM count, and resource-class counts with `{ absolute, percent }`; percent is null
  for baseline zero.
- Environment mismatch fields are exactly target kind, normalized scale/count manifest excluding
  anchor, route set, browser major/channel, viewport, cold/warm repeats, route-order seed,
  `INTERCEPTION_SCOPE_VERSION`, settle window, and poll interval. Target app revision difference
  is the experimental variable, never a mismatch. Always emit the normalized
  `{ profilerCommit, targetAppCommit }` pair; a missing/empty/unparseable revision becomes null and
  adds `target_version_unverified`.
- Compute deltas even with mismatches, but label them uncontrolled. List added, removed, skipped,
  timed-out, and failed entries separately. Slower metrics never change process exit status.

- [ ] Write failing table tests for odd/even medians, min/max, p95 at 19/20, null metrics, failed
  sample exclusion, low sample count, stable tie ordering, zero baseline, added/removed routes,
  every mismatch field, anchor exclusion, revision pair/difference, empty-to-null normalization,
  resource-class counts, background-noise separation, missing revision, and status lists.
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
  metadata, explicit normalized `profilerCommit`/`targetAppCommit` pair,
  browser/channel/viewport/OS/Node, per-resource-class counts, background-noise counts, and no raw
  requests array. It records `INTERCEPTION_SCOPE_VERSION` and only `SafeRunConfig` plus
  `TargetMetadata`, never `RunConfig`. `requests.jsonl` contains one sanitized `RequestEvidence`
  per line.
- `report.md` contains target/revision warnings, count manifest, cold and warm worst-offender
  tables, secondary rankings, client-truncation and scale-bearing labels, failures/skips, blocked
  writes, unmatched API counts, resource-class counts, background-refresh noise, and artifact
  filenames.
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
  Assert the revision pair, `resourceCountsByClass`, request outcome/role, and separate background
  fields survive their allowlisted outputs.
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
- Create: `scripts/lib/killTree.d.mts`
- Modify: `e2e/tsconfig.json`

**Lifecycle contract:**

- Before spawning, read `e2e/.artifacts/session.pid`. If it names a live process, refuse. Do not
  call `scripts/e2e-session.mjs` and rely on its self-heal because that launcher kills the prior
  tree.
- Call `resolveLane()` from `e2e/support/lane.mjs`; lane 0 remains impossible. Spawn
  `process.execPath scripts/e2e-session.mjs` with exact `E2E_LANE`, `detached: false`, piped
  stdout/stderr, and the profiler as parent. Retain `child.pid` immediately. Attach drain handlers
  to both streams before awaiting readiness and keep them attached until close. The stdout handler
  decodes incrementally, retains at most 4 KiB of one unterminated line, discards the remainder of
  an oversized line through its newline, tests only
  `line.startsWith('[e2e-session] ready')`, then discards it; stderr is discarded by chunk. Never
  accumulate, echo, persist, attach to an error, or pass launcher/app/worker/Vite output to report
  or privacy-scan code. This remains true on startup and cleanup failures; child output can contain
  raw emails, paths, and IDs.
- Wait for the line beginning with the ASCII prefix `[e2e-session] ready` with a hard startup
  timeout; do not exact-match the full line because its real suffix contains non-ASCII text. Then read
  `lane.json`, confirm exact lane/ports/prefix, read `session.pid`, and require it equals the child
  PID. Verify `/__dev/ping` prefix and normalized revision pair from Task 4 before reseed.
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
  app-port reseed with item-count-scaled timeout, switch to the dashboard-origin browser/request
  context for dev-login, `/auth/me`, every `/api/**` read, and all remaining work, authenticate,
  install firewall, warmup, collect, report, finally cleanup. Assert no post-reseed raw app-port
  business/auth request is possible.
- Local order is parse/validate, ping/prefix proof, TTY confirmation, existing-user auth, install
  firewall, warmup, collect, report. It never imports or calls lifecycle/reseed functions.
- Hosted order is parse/validate, headed login, admin/env proof, install firewall, collect, report.
  It never has a seed path.
- Add `scripts/lib/killTree.d.mts` declarations for `isAlive`, `killTree`, `pidsOnPort`, and
  `killPort`, and include the declaration plus `performance/**/*.ts` explicitly from
  `e2e/tsconfig.json`. Do not copy/reimplement process-kill logic in TypeScript.

- [ ] Write failing lifecycle tests with a fake spawned child and temp state files for live-pid
  refusal, dead/stale pid acceptance without broad killing, lane resolution, ready/pid/lane
  validation, startup failure cleanup, profiling failure cleanup, signal cleanup, state-file
  compare-before-delete, kill-tree completion polling, death on the final 10-second tick, timeout
  preservation of both state files, later reaper detection, and cleanup failure reporting.
- [ ] Add a high-volume fake-child test that writes beyond an OS pipe buffer after the ready line;
  prove profiling can continue and both streams drain through child close. Feed email/path/ID
  sentinels through stdout/stderr on success and failure and prove no CLI output, error object, or
  artifact sink receives them. Prove an oversized unterminated line stays within the fixed buffer
  bound. Test the ready prefix with the real non-ASCII-style suffix and reject `fake-twilio ready`.
- [ ] Write CLI sequencing tests that spy every phase and prove parse errors and `--print-config`
  perform zero lifecycle/network/browser work; firewall precedes measured navigation; local/hosted
  never seed; hermetic always cleans up; slower comparisons exit zero; safety/auth/privacy/browser
  failures exit nonzero.
- [ ] Implement lifecycle and replace the Task 1 print-only CLI shell with full orchestration.
  Dynamically import Playwright/lifecycle modules only after the `--print-config` early exit.
- [ ] Run `npm test -w @housingchoice/e2e -- lifecycle cli`, `npm run typecheck`, and root
  `npm test`.
- [ ] Run `npm run typecheck` to prove the `.mjs` import declarations resolve, then commit the six
  Task 12 paths explicitly.

---

## Slice 13 - Early live contract calibration

### Task 13: Falsify the checked-in route contracts before self-QA hardens them

**Files:**
- Modify: `e2e/performance/cli.ts`
- Modify: `e2e/performance/cli.test.ts`
- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/routes.test.ts`
- Modify: `e2e/performance/readiness.ts`
- Modify: `e2e/performance/readiness.test.ts`
- Modify: `e2e/performance/collect.ts`
- Modify: `e2e/performance/collect.test.ts`
- Modify: `e2e/performance/firewall.ts`
- Modify: `e2e/performance/firewall.test.ts`
- Modify: `e2e/performance/templates.ts`
- Modify: `e2e/performance/report.ts`
- Modify: `e2e/performance/report.test.ts`

**Checkpoint contract:**

- Immediately after Task 12 makes owned lifecycle executable, run the hermetic-only
  `--contract-checkpoint` mode against default scale 1 with one cold and one warm sample for all 28
  routes. It uses the real browser, API, seed, firewall, conditional detail branches, terminal
  locators, timer/background classifier, and collector. It writes only sanitized
  `contract-observations.json` beside the ordinary report: route key, mode, selected symbolic
  branch, terminal classification, observed endpoint templates/query-key sets/multiplicity/outcome,
  background roles, and blocked-write tuples. It contains no raw URLs, values, IDs, or content.
- Normal branch-aware subset enforcement remains enabled. Any observed endpoint outside the
  selected required/conditional declarations, missing selected required endpoint, unmatched API,
  wrong blocked-write tuple, unresolved terminal, or undeclared background fingerprint makes the
  checkpoint exit nonzero after the sanitized observation file is safely finalized. Absence of a
  conditional endpoint is not a failure. The diagnostic mode does not auto-edit source and does
  not turn an unexpected endpoint into background noise.
- For each failure, inspect the current dashboard call site and server/client contract. If evidence
  proves the checked-in contract wrong, update the named contract constant, its adjacent
  `CONTRACT_SOURCES` file:line citation, terminal/branch rule, and its unit expectation with a short
  code-based justification in the commit message. Never weaken `expectedGets`, the exact subset
  gate, never-matched stream rule, firewall, privacy scan, or 56-sample later gate. If code and
  contract agree, fix collector/readiness/resolver behavior instead. Rerun the focused unit tests
  and the whole live checkpoint after every correction wave.
- Changing an endpoint between `required`, `conditional`, and `background_refresh` is a separately
  audited correction. Name the exact dashboard call site and explain whether it is passive mount
  work, a response-conditioned fallback, or a later timer/SSE refresh. Record every class change in
  the checkpoint history and final handback; a citation alone is not sufficient.

- [ ] Write failing CLI/report tests proving checkpoint mode is hermetic-only, scale/repeat locked,
  preserves a sanitized mismatch artifact, exits nonzero on every mismatch class, and cannot
  mutate contract source automatically. Cover missing required versus absent conditional entries
  separately, every selected branch, and an audited requirement/background class change in the
  checkpoint history.
- [ ] Add a contract-source ledger in `routes.ts` that maps every endpoint set, terminal,
  resolver, blocked-write set, and background refresh rule to the current source citations
  recorded in Tasks 6, 7, and 8. Unit tests require every registry binding and conditional branch
  to have a nonempty file-and-line citation entry. Keep Task 2's physical-key source table adjacent
  to its app integration assertions; do not invent an e2e import solely to duplicate that proof.
- [ ] Run targeted e2e-workspace unit tests and `npm run typecheck`.
- [ ] Run bare and unpiped:

```text
npm run perf:pages -- hermetic --scale=1 --cold-repeats=1 --warm-repeats=1 --contract-checkpoint
```

  Expected final run: exit 0; 28 cold and 28 warm observations resolve; endpoint/query contracts,
  selected branches, terminals, background classifications, and blocked-write sets match; privacy
  scan passes; owned lane stops.
- [ ] If the first run fails, preserve its sanitized artifact, update contracts only with cited code
  evidence and stated justification, and rerun until the checkpoint passes. Record every attempt
  and do not defer a contract mismatch to final self-QA.
- [ ] Run standalone `git status` and commit only the explicit Task 13 files that changed.

---

## Slice 14 - Hermetic no-write self-QA and live profile proof

### Task 14: Prove every automatic mutation surface remains unchanged

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
  contract. Before profiling, use dashboard-origin authenticated GETs to reduce each keyed fixture
  state into an
  in-memory map of unread/read scalars for contact detail, relay conversation detail, inbox row,
  unmatched-email row, tour group channel, and placement group channel, plus dev-outbox count.
  After profiling, repeat the GET reductions and compare. Persist only surface names and
  unchanged booleans, never IDs or domain values.
- In full mode, bind the four detail route resolvers to the keyed `contact_detail`,
  `conversation_detail`, `tour_group`, and `placement_group` fixtures. Run two supplemental
  navigation-only probes under the same firewall: click the keyed unread `inbox_row` link and
  activate only the keyed unread `unmatched_email` row's expansion control. Do not click any
  action inside the expanded email. The supplemental probes are not ranking samples and cannot
  satisfy the 56-sample cardinality.
- Declare the unmatched-email expansion as a no-navigation probe: source and destination are both
  `/email`, its fresh token starts immediately before activation, and every intercepted write is
  classified `source_click` under Task 6's explicit source-equals-destination rule.
- In full mode, define expected tuples as frozen sets per surface and mode. The required sets are:
  contact detail `{destination_mount /api/inbox/:contactId/read}`; cold conversation detail
  `{destination_mount /api/conversations/:conversationId/read}`; warm conversation detail
  `{source_click, destination_mount}` for that same conversation template; tour group and placement
  group each `{destination_mount /api/conversations/:conversationId/read}`; the supplemental
  contact inbox probe `{source_click, destination_mount /api/inbox/:contactId/read}`; and unmatched
  email `{source_click /api/unmatched-email/:unmatchedId/read}`. The id-less
  `/api/inbox/read` remains cataloged but is not expected for the keyed contact probe. Associate
  identical templates with route/probe symbolic surfaces before disposing raw IDs. De-duplicate
  repeated identical attempts, then require set equality: every required tuple appears and no
  tuple outside the closed union appears. Two legitimate phases for one template are not an error.
- Assert every measured route's observed API templates are a subset of its declared set; no
  `unmatched_api`; inbox rendered relay count matches the generated manifest; outbox count is
  unchanged; output exists and passes the same final privacy scan; report has count manifest plus
  both rankings. Scale 1 is a complete fixture world: full mode requires exactly 56 `ok` samples
  (28 cold plus 28 warm), with zero skips, timeouts, failures, or
  `blocked_write_dependency` results. The write firewall may record blocked writes while readiness
  still succeeds.

- [ ] Write failing tests for reduction-only snapshots, raw-value disposal, all six keyed fixtures,
  exact per-surface/mode tuple-set equality, legitimate two-phase same-template acceptance,
  missing/wrong/unexpected attempt rejection, before/after
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
- [ ] Commit the five Task 14 paths.

---

## Slice 15 - Operator documentation and repository policy

### Task 15: Document safe on-demand use and the exact agent carve-out

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
  `client_truncated` caps, every passive `useContacts` consumer (contact lists, email, tour lists,
  contact detail, property detail, and conversation detail), scale-bearing labels, inbox relay cost,
  second-run reseed/runtime estimates, one-direction session guard, and killed-during-boot recovery.
  State explicitly that tour and placement detail do not passively mount `useContacts` and have
  `load_scale_bearing: false`; record this as the adjudicated correction to the design's older docs
  enumeration without editing the spec. Document background poll/SSE counts separately from primary
  page-load metrics and `/api/events` as never intercepted.
- [ ] Document the DynamoDB integration tradeoff: ordinary Dockerless `npm test` loudly skips this
  suite to preserve repository convention, while plan-owned seed proofs set
  `PERF_SEED_REQUIRE_DYNAMO=1` and cannot pass without executing it.
- [ ] State clearly that local and hosted modes ship pre-merge with guard unit evidence only; their
  first end-to-end execution belongs to the human. State that local Vite evidence and hosted
  built/CDN evidence answer different questions and neither is production telemetry.
- [ ] Run a command-example test or `--print-config` for every documented noninteractive example.
  Do not run local or hosted.
- [ ] Run ASCII scan on all new/touched profiler docs/source lines and fix any non-ASCII additions.
- [ ] Run `npm run typecheck` and root `npm test`.
- [ ] Commit `AGENTS.md e2e/README.md` plus only any Task 15 test adjustment.

---

## Slice 16 - Final sync, required gates, full-registry self-QA, and handback

### Task 16: Validate the merge candidate without running a human target

- [ ] Read bare `git status`, check `.git/MERGE_HEAD`, and inspect current `main` drift. If `main`
  advanced, sync it into the feature branch once at this final pre-handback step. Preserve both
  sides' intent; if active work makes the sync conflict-risky, stop and ask the human before the
  sync.
- [ ] Require Docker and DynamoDB Local before the gates. Run `npm run db:start` if the shared
  endpoint is not reachable and leave it running. Run the targeted
  `performanceSeed.integration.test.ts` suite once with `PERF_SEED_REQUIRE_DYNAMO=1` in that child
  environment and require its filename/test count to appear as passed, never skipped. Remove the
  signal before the bare gates; Docker remains available, and root `npm test` must also show that
  file passed rather than the stable loud-skip warning. A green root test without the targeted
  required-mode execution evidence is not a valid handback.
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
  every automatic-write state proof is unchanged; every per-surface/mode blocked-write tuple set
  matches, including both legitimate two-phase warm cases; relay count is not truncated; owned lane
  stops.
- [ ] Inspect the generated `report.md`, `summary.json`, and `requests.jsonl` structurally without
  copying domain data into the handback. Report artifact path, route/result counts, privacy result,
  and the worst route keys/metrics only.
- [ ] Run standalone `git status`; ensure artifacts remain gitignored and only intended tracked
  files differ. Commit any verification-only fixes with explicit paths and rerun the affected
  focused test plus all four final commands above.
- [ ] Do not run `local` or `hosted-dev`, do not merge, deploy, or remove the worktree. Hand back
  branch, HEAD, commits, bare gate exit codes, explicit non-skipped DynamoDB integration evidence,
  contract-checkpoint history, self-QA exit/path, reviewer findings/adjudications,
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
11. Every checked-in endpoint set, terminal locator, resolver request shape, blocked-write
    template, and generated-table physical/index key has been re-derived from current code and has
    an adjacent file-and-line citation; the early live checkpoint cannot weaken the subset gate.
12. `/api/events` is excluded by the interception predicate and by readiness before pending/evidence
    creation; tests prove the interception handler observes it zero times.
13. Expected blocked writes are immutable per-surface/mode/branch tuple sets, including legitimate
    source-click plus destination-mount attempts for one template.
14. The repeating timer/SSE inventory is complete, and background evidence is retained separately
    without satisfying readiness or required endpoint sets.
15. The branch-aware endpoint contract distinguishes required from conditional entries; missing
    failures apply only to the selected required set, and every requirement/background class change
    is justified by a cited call site and recorded in handback history.
16. Every terminal locator declares exact, prefix, contains, anchored-regex, or role-only matching;
    system AWS blocks wait for explicit terminal branches and the number route uses positive states.
17. Raw app-port traffic is limited to owned ping and hermetic reseed; auth, `/auth/me`, `/api/**`,
    resolver, and self-QA reads use the dashboard-origin browser/request context.
18. No-navigation probes classify source-equals-destination writes as `source_click`, and
    checkpoint/self-QA modes are mutually exclusive before side effects.
19. Registry locators declare their Desktop Chrome dependency and the broadcast list contract cites
    its default `all` filter branch.
20. Docker-optional root tests emit a stable loud skip, while plan-owned targeted integration proof
    sets `PERF_SEED_REQUIRE_DYNAMO=1`; final handback names the suite and passed test count.
