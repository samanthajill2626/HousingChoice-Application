# Page Performance Profiler Workload and Inbox Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recalibrate the hermetic profiler workload, add deterministic native group texts and independent long-conversation/large-broadcast controls, and measure Inbox All, Unread, Unknown, and Groups as separate passive performance surfaces.

**Architecture:** Keep workload resolution and row generation in app-owned pure TypeScript, keep destructive reset inside the already guarded profiler-only lane, and carry a new stable `surfaceId` through the e2e collector and report pipeline. The four Inbox surfaces share `/inbox` as an application path but have distinct static cold targets, exact accessible warm actions, closed request classes, and independent rankings. Local and hosted-dev remain existing-data-only and receive no seed controls.

**Tech Stack:** TypeScript with NodeNext ESM, Express, DynamoDB Local, Vitest, Playwright Chromium, Chrome DevTools Protocol, React accessibility contracts, and the existing Node standard library. Add no dependency.

**Spec:** `docs/superpowers/specs/2026-08-13-page-performance-profiler-workloads-design.md`

## Global Constraints

- Work only in `W:\tmp\page-performance-profiler-workloads` on `feat/page-performance-profiler-workloads`. Never move `HEAD` in the shared main checkout.
- Read the authoritative design before editing. If source has changed enough to invalidate a locked design decision, stop and raise the discrepancy; do not silently reinterpret the design.
- New or touched lines are ASCII-only. Use `apply_patch`, not an encoding-lossy PowerShell rewrite.
- Use red-green-refactor within every task. Run the named focused test in the red state before implementation and record the expected assertion failure. Do not weaken an assertion, endpoint contract, cardinality, privacy rule, or gate to make it pass.
- Do not click an Inbox row, Inbox Retry, Groups notice link, or any Inbox or conversation-history Load more control. The four Inbox surfaces are cold navigation or exact filter-tab activation only. The retained conversation-detail warm sample keeps its existing exact-row activation under the write firewall.
- Do not collect or persist request/response bodies, headers, cookies, storage state, DOM text, console text, raw URLs, raw query values, raw IDs, screenshots, video, HAR, or traces. New evidence fields are integers, booleans, fixed enums, and version strings only.
- Preserve the existing request firewall, escaped-write watchdog, `/api/events` never-match interception rule, artifact privacy preflight and defense scan, lane ownership, signal cleanup, and partial-report behavior.
- `local` and `hosted-dev` are existing-data-only. Reject every seed option on those targets even when its value equals the default. Do not infer target totals from rendered pages.
- An agent may run `local` or `hosted-dev` only after a human explicitly authorizes that specific target for that run. All implementation self-QA uses `hermetic`.
- No new dependency and no production dashboard behavior change. Reuse `conversationIdForGroup` from `app/src/lib/import/ids.ts` and `TEAM_SENDER_KEY` from `app/src/jobs/relayFanOut.ts`; do not duplicate either contract.
- Every task ends green for the named focused tests and `npm run typecheck`. Commit only the exact paths named in that task, after a standalone `git status` and a `.git/MERGE_HEAD` check. Add a `Co-Authored-By` trailer naming the model that actually authored the commit.
- Before merge-ready handback, sync current `main` once, preserving both sides' intent, then run the bare gates `npm run typecheck`, `npm test`, and `npm run e2e`. Never pipe a gate command.
- Do not merge, deploy, mutate infrastructure, edit a real `.env.*`, push secrets, or clean up the branch/worktree.

## File Map

### Workload and reset

| Path | Responsibility in this change |
| --- | --- |
| `app/src/lib/seed/performance.ts` | Workload bases, bounds, input/resolved manifest types, contact calibration, lazy roster selection, native group/message rows, tail formulas, broadcast pool, and self-QA fixture bindings. |
| `app/src/lib/performanceSeed.ts` | Profiler-owned removal of the lean native group and its messages, then exact write of the resolved workload. |
| `app/src/routes/dev.ts` | Validated dev reseed payload forwarding through the existing injectable `DevRouterDeps.performanceReseed` seam. |
| `app/test/performanceSeed.test.ts` | Pure workload, generation, chronology, capacity, and count tests. |
| `app/test/performanceSeed.integration.test.ts` | DynamoDB Local reset, physical rows, GSI visibility, exact group count, and lane confinement tests. |
| `app/test/devGating.test.ts` | Dev-route validation and injected reseed payload tests. |

### Profiler configuration and route contracts

| Path | Responsibility in this change |
| --- | --- |
| `e2e/performance/config.ts` | Public option catalog, help text, early help exit data, hermetic-only validation, and resolved safe configuration. |
| `e2e/performance/config.test.ts` | Parser/help parity, target restrictions, defaults, tail relationships, and true early-exit tests. |
| `e2e/performance/types.ts` | Versioned `surfaceId`, request-class, Inbox evidence, manifest, aggregate, and comparison types. |
| `e2e/performance/routes.ts` | Unique surface registry, cold target union, exact warm source/action union, Inbox terminals, endpoint contracts, and static resolver behavior. |
| `e2e/performance/routes.test.ts` | Registry uniqueness/cardinality, four Inbox contracts, static query targets, and action/source invariants. |

### Collection and browser adapter

| Path | Responsibility in this change |
| --- | --- |
| `e2e/performance/collect.ts` | Surface-keyed ordering/joining, closed Inbox request classification, buffer boundary, safe row counts, and relay-only proof dispatch. |
| `e2e/performance/collect.test.ts` | Request-class separation, shuffled warm normalization, passive evidence, fixed-action failures, and relay discriminator tests. |
| `e2e/performance/cli.ts` | Help early exit, exact pathname/query source normalization, terminal XOR, static cold target use, and safe browser DOM adapters. |
| `e2e/performance/cli.test.ts` | End-to-end argv, no-lifecycle help, real adapter contract, and manifest wiring tests. |
| `e2e/performance/readiness.ts` | No semantic change expected; type-only terminal compatibility if required. |
| `e2e/performance/readiness.test.ts` | Closed terminal failure propagation if its public type changes. |

### Evidence, reporting, comparison, and self-QA

| Path | Responsibility in this change |
| --- | --- |
| `e2e/performance/aggregate.ts` | Group and rank by `surfaceId`. |
| `e2e/performance/aggregate.test.ts` | Duplicate-path surface aggregation and independent Inbox ranking. |
| `e2e/performance/report.ts` | Schema/registry/workload versions, closed sanitizers, comparison workload projection, Inbox evidence, and surface-keyed checkpoint/report output. |
| `e2e/performance/report.test.ts` | Privacy allowlists in both directions, schema shape, projection equivalence, and old-baseline incompatibility. |
| `e2e/performance/compare.ts` | Compatibility and aggregate matching by `surfaceId` plus resolved comparison workload. |
| `e2e/performance/compare.test.ts` | Added/removed shared-path surfaces, equivalent resolved workloads, and incompatible version/workload cases. |
| `e2e/performance/selfQa.ts` | Surface-keyed endpoint proof, 31/62 cardinality, four Inbox presence, and `inbox-all` relay equality. |
| `e2e/performance/selfQa.test.ts` | Full registry/cardinality, request-class proof, relay-only proof, and unchanged write tuple assertions. |
| `e2e/README.md` | Complete CLI reference, formulas, calibration provenance, passive navigation, target restrictions, and report interpretation. |

## Source Contracts to Re-verify Before Editing

These are review anchors, not permission to copy stale values. Re-open the cited source at the start of the owning task and update the test contract if the source has legitimately moved without changing product meaning.

| Contract | Current source |
| --- | --- |
| Workload bases, input/resolved fields, bounds, and total-work arithmetic | `app/src/lib/seed/performance.ts:21-81,118-238` |
| Existing contact mix and deleted cadence | `app/src/lib/seed/performance.ts:301-346` |
| Existing relay-group construction, activity time, and message builders | `app/src/lib/seed/performance.ts:487-586` |
| Existing broadcast recipient embedding and generation assembly | `app/src/lib/seed/performance.ts:611-641,730-795` |
| Lean native group and transcript that performance reset must replace | `app/src/lib/seed/lean.ts:227-246,299-332` |
| Canonical native group identity | `app/src/lib/import/ids.ts:68-76` |
| Live outbound Team sender sentinel | `app/src/jobs/relayFanOut.ts:94`; consumed by `app/src/services/groupSend.ts:598-605` |
| Live native-group sender attribution and persisted shape | `app/src/services/groupSend.ts:578-607`; `app/src/routes/webhooks/twilio.ts:1540-1556,1570-1579`; `dashboard/src/lib/memberAttribution.ts:39-68` |
| Existing lean-first performance reset and injected app config | `app/src/lib/performanceSeed.ts:80-110,170-190` |
| Existing injectable dev reseed seam and request handler | `app/src/routes/dev.ts:93-121,335-365` |
| Inbox filter enum, tab labels, and exact empty titles | `dashboard/src/routes/inbox/inboxFilters.ts:6-34` |
| Canonical bare-All URL and accessible tab markup | `dashboard/src/routes/inbox/Inbox.tsx:16-65` |
| Inbox populated list, truncation notice, and Load more controls | `dashboard/src/routes/inbox/Inbox.tsx:68-102,112-158` |
| Fixed Relay group and Group text row labels and shared detail-link family | `dashboard/src/routes/inbox/InboxRow.tsx:27-39,51-65,89-97` |
| Initial Inbox page request and limit 30 | `dashboard/src/routes/inbox/useInbox.ts:64,93-166` and `dashboard/src/api/endpoints.ts:1513-1522` |
| App-shell unread badge request and limit 100 | `dashboard/src/app/UnreadContext.tsx:19-38` |
| Server filter enum and group source semantics | `app/src/routes/inbox.ts:158-180,437-451,700-723,844-887,907-920` |
| Existing route registry and single Inbox row | `e2e/performance/routes.ts:41-68,474-502` |
| Existing shell classification and surface joins | `e2e/performance/collect.ts:109-125,200-299,721-934` |
| Existing pathname-only warm source and terminal evaluation | `e2e/performance/cli.ts:482-574` |
| Existing route-key report/comparison joins | `e2e/performance/types.ts:64-84,148-187`; `e2e/performance/report.ts:264-294,602-624`; `e2e/performance/compare.ts:24-30,56-81` |
| Current broad relay DOM selector | `e2e/performance/cli.ts:572-574`; dispatched by `e2e/performance/collect.ts:880-917` |
| Timeline has a safe enclosing region but no stable semantic message-row marker | `dashboard/src/routes/contact/Timeline.tsx:1221-1282`; therefore conversation-detail row count remains nullable unless a pre-existing safe selector is verified |

## Stable Contracts Used Across Tasks

The worker must implement these names or an equally closed, type-equivalent shape. Do not retain `routeKey` as a second identity alias.

```ts
export const PERFORMANCE_SCHEMA_VERSION = 2 as const;
export const PERFORMANCE_REGISTRY_VERSION = 2 as const;
export const PERFORMANCE_WORKLOAD_VERSION = 2 as const;

export type SurfaceId = string;
export type BehaviorFamily = 'standard' | 'inbox';
export type StaticColdTarget = Readonly<{ kind: 'static'; path: string }>;
export type ResolvedColdTarget = Readonly<{ kind: 'resolved' }>;
export type ColdTarget = StaticColdTarget | ResolvedColdTarget;

export type ExactQueryState =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'fixed'; values: Readonly<Record<string, string>> }>;

export interface ExactBrowserTarget {
  path: string;
  query: ExactQueryState;
}

export type WarmAction =
  | Readonly<{ kind: 'link'; locator: LocatorContract; exactHref: string | 'resolved_exact_href' }>
  | Readonly<{ kind: 'tab'; locator: LocatorContract }>;

export type InboxFilterValue = 'all' | 'unread' | 'unknown' | 'groups';
export type InboxRequestClass =
  | 'inbox_page_all'
  | 'inbox_page_unread'
  | 'inbox_page_unknown'
  | 'inbox_page_groups'
  | 'inbox_badge';

export interface InboxSampleEvidence {
  kind: 'inbox';
  filter: InboxFilterValue;
  renderedRowCount: number;
  groupsTruncated: boolean;
  initialInboxPageRequestCount: number;
}

export interface ConversationDetailSampleEvidence {
  kind: 'conversation_detail';
  initialRenderedMessageCount: number | null;
}

export type SurfaceEvidence =
  | InboxSampleEvidence
  | ConversationDetailSampleEvidence
  | null;

// Add this required field to SampleResult and initialize it on every return path.
// Non-Inbox/non-conversation surfaces use null.
export interface SampleResultEvidenceContract {
  surfaceEvidence: SurfaceEvidence;
}

// Optional only on exact role locators. Route construction rejects selected on
// any role other than tab, and the browser adapter maps it to ARIA state.
export interface LocatorContract {
  role: string;
  name?: string;
  exactness: LocatorExactness;
  scope?: string;
  selected?: true;
}
```

Add `required_action_missing`, `contradictory_terminal`, and `endpoint_contract_mismatch` to the existing closed `FailureReasonCode` union; do not introduce a second overlapping reason type.

The workload input and resolved manifest must expose requested provenance separately from resolved storage shape. `PerformanceSeedInput` belongs to `app/src/lib/seed/performance.ts`; `ComparisonWorkload` is the closed e2e artifact type produced later by report code:

```ts
export interface PerformanceSeedInput {
  scale?: number;
  contacts?: number;
  units?: number;
  placements?: number;
  tours?: number;
  conversations?: number;
  nativeGroups?: number;
  messagesPerConversation?: number;
  longConversationMessages?: number;
  broadcasts?: number;
  recipientsPerBroadcast?: number;
  largeBroadcastRecipients?: number;
}

export interface ComparisonWorkload {
  workloadModelVersion: 2;
  contacts: number;
  activeContacts: number;
  units: number;
  placements: number;
  tours: number;
  conversations: number;
  nativeGroups: number;
  totalConversations: number;
  messagesPerConversation: number;
  resolvedLongConversationMessages: number;
  totalMessageCount: number;
  nativeGroupMemberSlotCount: number;
  broadcasts: number;
  resolvedRecipientsPerBroadcast: number;
  resolvedLargeBroadcastRecipients: number;
  totalRecipientCount: number;
  recipientPoolSize: number;
  recipientPoolSource: 'generated_tenants' | 'lean_tenant';
  longConversationFixturePresent: boolean;
  largeBroadcastFixturePresent: boolean;
}
```

`ComparisonWorkload` deliberately excludes anchor and requested option syntax. The full seed manifest retains those values for diagnosis.

---

## Task 1: Resolve the calibrated workload and all bounds before lifecycle work

**Files:**

- Modify: `app/src/lib/seed/performance.ts`
- Test: `app/test/performanceSeed.test.ts`

**Interfaces:**

- Produces: expanded `PerformanceSeedInput`, `ResolvedPerformanceSeedConfig`, `PerformanceSeedManifest`, and `resolvePerformanceSeedConfig()`.
- Consumes: current `PERFORMANCE_SEED_BOUNDS`, `PERFORMANCE_SEED_BASE`, deterministic anchor normalization, and total-work cap.

- [ ] Add failing tests for exact scale-1 defaults: contacts 100, units 16, placements 50, tours 50, conversations 100, native groups 21, broadcasts 10, messages per conversation 10, and recipients per broadcast 25.
- [ ] Add table tests for the 95/4/1 contact-type split. For a count `n`, assert `landlords = floor(n * 4 / 100)`, `unknown = floor(n / 100)`, and `tenants = n - landlords - unknown`. Assert both the pure resolved counts and generated table counts use that allocation, and that generated totals and active/deleted totals reconcile.
- [ ] Add failing bound and relationship tests for all three new options. `longConversationMessages` must be in `0..20000` and at least ordinary message density; `largeBroadcastRecipients` must be in `0..1000` and at least ordinary recipient density; `nativeGroups` must be in `0..20000` and not exceed exact roster capacity.
- [ ] Add a table test for saturated combination capacity at active-contact counts 0, 1, 2, 3, 4, 100, and 20000. Assert the helper stops at the entity-count bound instead of overflowing or enumerating combinations. Use bounded `bigint` arithmetic internally so the intermediate multiplication cannot lose safe-integer precision.
- [ ] Add formula tests for parent-zero, ordinary, tail, and clipped cases. Include physical items, logical member slots, logical recipients, and combined total items; keep `totalItems.max = 250000` unchanged.
- [ ] Run the focused test and confirm it fails on missing fields/defaults:

```powershell
npm run test -w @housingchoice/app -- performanceSeed.test.ts
```

- [ ] Implement pure bounded arithmetic. Use a saturating helper that never materializes combinations:

```ts
function saturatedCombination(n: number, k: number, cap: number): number {
  if (k > n) return 0;
  let value = 1n;
  const bounded = BigInt(cap);
  for (let i = 1; i <= k; i += 1) {
    value = (value * BigInt(n - k + i)) / BigInt(i);
    if (value >= bounded) return cap;
  }
  return Number(value);
}

function nativeGroupCapacity(activeContacts: number): number {
  let total = 0;
  for (const size of [2, 3, 4] as const) {
    total = Math.min(
      PERFORMANCE_SEED_BOUNDS.entityCount.max,
      total + saturatedCombination(activeContacts, size, PERFORMANCE_SEED_BOUNDS.entityCount.max),
    );
  }
  return total;
}
```

- [ ] Resolve parent presence before tail replacement. When `conversations=0`, long fixture is absent and existing-conversation tail replacement is zero. When `broadcasts=0`, large fixture is absent and both its resolved count and replacement are zero.
- [ ] Compute the selected roster-size schedule and `nativeGroupMemberSlotCount` during pure preflight using only saturated per-size capacities and at most `nativeGroups` round-robin selections. The generator must consume the same schedule when it chooses actual contacts, so total-work rejection completes before lifecycle discovery.
- [ ] Compute the active generated tenant recipient pool after the deleted cadence and consent rules. Clip both ordinary and large recipient counts to that pool, or to the explicit one-row lean-tenant fallback only when the generated eligible pool is empty.
- [ ] Replace `contactTypeAndOrdinal()` in this task with the deterministic 95/4/1 allocation before using active counts for native-group capacity or broadcast clipping. Keep the existing deterministic deleted cadence and generated consent fields unless a test proves a direct conflict.
- [ ] Build the full requested/resolved manifest. Ensure `toPerformanceSeedManifest()` explicitly copies every new field; do not spread an unreviewed object into artifact data. The closed comparison projection remains report-owned in Task 9.
- [ ] Run the focused test and typecheck:

```powershell
npm run test -w @housingchoice/app -- performanceSeed.test.ts
npm run typecheck
```

- [ ] Commit only the two task files:

Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add -- app/src/lib/seed/performance.ts app/test/performanceSeed.test.ts`, and then a separate commit with subject `feat(perf): resolve calibrated workload model`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 2: Generate deterministic native groups, deep history, and eligible broadcasts

**Files:**

- Modify: `app/src/lib/seed/performance.ts`
- Test: `app/test/performanceSeed.test.ts`

**Interfaces:**

- Produces: deterministic native `group_text` conversations/messages, long-conversation fixture, large-broadcast fixture, roster slot counts, and updated `resolvePerformanceSelfQaFixtures()`.
- Consumes: resolved config from Task 1, `conversationIdForGroup()` from `app/src/lib/import/ids.ts`, `TEAM_SENDER_KEY` from `app/src/jobs/relayFanOut.ts`, `ConversationParticipant`, and current row builders.

- [ ] Add failing generation tests for exact 95/4/1 types at 100 contacts, exact native-group count, unique canonical IDs, roster sizes 2 through 4, no roster reuse, and no lean contact in a native roster.
- [ ] Add a small-pool exhaustive matrix: requested counts from zero through exact capacity for active pools of 0 through 5. Assert infeasible requests reject before generation and every feasible request returns exactly the requested number.
- [ ] Add a non-exhausted iterator test where the size-3 and size-4 iterators exhaust before size-2. Assert they leave rotation and size-2 continues without collision.
- [ ] Add scale-1, scale-7, and cap-valid `nativeGroups=20000` instrumentation tests proving only requested combinations are visited/yielded and no complete combinatorial pool is allocated. The 20000 case must explicitly set `messagesPerConversation=0` and `longConversationMessages=0` while retaining enough active contacts for roster capacity; assert resolution succeeds before inspecting iterator instrumentation. In a separate test, assert the same 20000 groups at ordinary density is rejected by the unchanged total-work cap.
- [ ] Add row-shape tests for `type='group_text'`, `status='group_open'`, `ai_mode='manual'`, typed `participants`, absent relay-only fields, deterministic activity/provider/message keys, mixed read/unread rows, and exact sender attribution. Inbound rows use `phone#<E164>` and the roster member's reviewed type; outbound rows use imported `TEAM_SENDER_KEY`.
- [ ] Add long-conversation tests at zero, ordinary default, the seven-day boundary on both sides, and 20000. Assert the designated conversation is the detail resolver fixture, the oldest message does not predate `created_at`, and total messages match the replacement formula.
- [ ] Add large-broadcast tests for eligible generated tenants only, exclusion of landlord/unknown/deleted contacts, unique recipients, lean fallback, clipping, and terminal-broadcast fixture selection.
- [ ] Add tests that `nativeGroupMemberSlotCount` equals the sum of roster lengths and every table length matches the manifest physical/logical counts.
- [ ] Run the focused test and confirm failures on the current generator:

```powershell
npm run test -w @housingchoice/app -- performanceSeed.test.ts
```

- [ ] Implement one lazy lexicographic iterator per feasible roster size. Keep only current index vectors and the selected `nativeGroups` rows; round-robin over non-exhausted iterators and remove an iterator only after it yields its final combination.
- [ ] Derive each group ID through `conversationIdForGroup(participantPhones)`. Sort/canonicalize only as required by that helper; do not invent an ID or reuse the existing performance ID namespace.
- [ ] Generate native messages at ordinary density. Preserve deterministic timestamps and unique sort keys. Alternate or otherwise deterministically cover inbound and outbound sender attribution at default scale.
- [ ] Designate one readable relay-group conversation as the long fixture when at least one existing conversation exists. Move only its `created_at` earlier when required by its oldest message. Do not add long messages on top of ordinary messages.
- [ ] Build broadcasts from the resolved eligible pool and replace the terminal broadcast's recipient count with the large value. Keep audience `tenant` and recipient IDs unique within each item.
- [ ] Update `resolvePerformanceSelfQaFixtures()` default-shape checks for units 16, native groups 21, resolved long-conversation messages 10, and resolved large-broadcast recipients 25. In pure generation tests, prove that its conversation detail ID names the designated long relay conversation and that the generated broadcast ordering/status makes the designated large broadcast the terminal-list candidate, without serializing either raw ID.
- [ ] Run focused tests and typecheck:

```powershell
npm run test -w @housingchoice/app -- performanceSeed.test.ts
npm run typecheck
```

- [ ] Commit only the task files:

Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add -- app/src/lib/seed/performance.ts app/test/performanceSeed.test.ts`, and then a separate commit with subject `feat(perf): generate representative tail workloads`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 3: Make profiler reset replace the lean native group exactly

**Files:**

- Modify: `app/src/lib/performanceSeed.ts`
- Modify: `app/src/routes/dev.ts`
- Test: `app/test/performanceSeed.integration.test.ts`
- Test: `app/test/devGating.test.ts`

**Interfaces:**

- Produces: exact performance `group_open` population, deletion of the lean native group's message partition, and dev-route support for every new input.
- Consumes: Task 2 generated tables/manifest, injected `AppConfig` table namespace, existing `DevRouterDeps.performanceReseed` seam, and lean-first reset.

- [ ] Add a DynamoDB Local test that performs performance reset with `nativeGroups=0`, queries the `group_open` byLastActivity partition, and asserts zero native group rows and zero messages for the removed lean group.
- [ ] Add integration tests for exact default and non-default native-group counts, newest-first `group_open` query order, all four Inbox branch coverage, stored tail-message depth, stored unique large-broadcast recipients, and exact resolved manifest counts.
- [ ] Add a spy/table-namespace test proving every read/delete/write uses the injected profiler lane prefix and no production or foreign prefix.
- [ ] Add dev-route tests proving camelCase JSON fields `nativeGroups`, `longConversationMessages`, and `largeBroadcastRecipients` reach the injected `performanceReseed` function only after shared resolution succeeds. Assert invalid relationships produce the existing closed validation response without calling the seam.
- [ ] Run red tests. If DynamoDB Local is unavailable, start the shared container with `npm run db:start`; do not stop it when done:

```powershell
npm run test -w @housingchoice/app -- devGating.test.ts
$env:PERF_SEED_REQUIRE_DYNAMO='1'
npm run test -w @housingchoice/app -- performanceSeed.integration.test.ts
Remove-Item Env:PERF_SEED_REQUIRE_DYNAMO
```

- [ ] In `resetPerformanceData()`, after lean reset and before performance writes, identify the lean native group from the lean seed contract, delete its conversation row, and delete every message in its conversation partition. Use the injected readers/client and injected `AppConfig` table names; do not read `process.env` for a physical table name.
- [ ] Keep deletion inside the already validated positive e2e lane. Batch/delete with existing retry rules and prove `nativeGroups=0` does not leave the lean row behind.
- [ ] Forward the expanded `PerformanceSeedInput` through the existing dev route. Do not introduce another mutation route or a production import.
- [ ] Run the focused tests and typecheck, requiring the integration file and its tests to execute rather than skip:

```powershell
npm run test -w @housingchoice/app -- devGating.test.ts
$env:PERF_SEED_REQUIRE_DYNAMO='1'
npm run test -w @housingchoice/app -- performanceSeed.integration.test.ts
Remove-Item Env:PERF_SEED_REQUIRE_DYNAMO
npm run typecheck
```

- [ ] Commit only the task paths:

Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add -- app/src/lib/performanceSeed.ts app/src/routes/dev.ts app/test/performanceSeed.integration.test.ts app/test/devGating.test.ts`, and then a separate commit with subject `feat(perf): replace lean native groups during reset`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 4: Make the CLI option contract authoritative and target-safe

**Files:**

- Modify: `e2e/performance/config.ts`
- Modify: `e2e/performance/config.test.ts`
- Modify: `e2e/performance/cli.ts`
- Modify: `e2e/performance/cli.test.ts`

**Interfaces:**

- Produces: public option catalog, help renderer, true help early exit, expanded `RunConfig`/`SafeRunConfig`, and hermetic reseed payload.
- Consumes: Task 1 resolver and manifest; existing target, sampling, browser, baseline, output, checkpoint, and self-QA options.

- [ ] Add parser tests for all twelve hermetic seed options, both help spellings, bounds, parent relationships, print-config equality, and local/hosted-dev rejection of each explicitly present seed option.
- [ ] Add a mechanical parity test: every accepted public long option appears exactly once in help, every documented long option belongs to the parser inventory, and aliases `-h`/`--help` render identical output.
- [ ] Add CLI dependency-spy tests proving `npm run perf:pages -- --help` and `hermetic --help` do not parse/validate a target, probe ports, read auth, launch a browser, create output paths, or start a lane.
- [ ] Add print-config tests proving it uses the same resolved manifest as a real hermetic run, including contact-type/active counts, tails, pool source, member slots, physical/logical totals, fixture presence, workload version, and anchor.
- [ ] Extend `assertLockedDiagnosticMode()` default-shape tests for units 16, native groups 21, resolved long-conversation messages 10, and resolved large-broadcast recipients 25. Full self-QA and contract checkpoint continue to reject every explicitly supplied non-scale seed override, including the three new options.
- [ ] Run the focused tests and confirm the new inventory/help assertions fail:

```powershell
npm run test -w @housingchoice/e2e -- performance/config.test.ts performance/cli.test.ts
```

- [ ] Define a single public option catalog used by parsing, help, parity tests, and seed-option presence detection. Do not maintain independent handwritten sets that can drift.
- [ ] Render help with purpose/unit, default or derivation, inclusive bound, hermetic-only availability, scale behavior, override/clipping rules, parent/capacity relationships, total-work contribution, passive initial-history wording, and the five examples required by design section 7.2.
- [ ] Detect help from raw argv before target requirement or any side effect. Return exit 0 through a small closed result rather than throwing a target-validation sentinel.
- [ ] Map kebab-case public inputs to the Task 1 camelCase `PerformanceSeedInput`; preserve explicit-option presence so local/hosted-dev reject even default-equal values.
- [ ] Update the hermetic dev-reseed body and safe config serialization. Continue emitting only the explicit manifest allowlist.
- [ ] Run focused tests and typecheck:

```powershell
npm run test -w @housingchoice/e2e -- performance/config.test.ts performance/cli.test.ts
npm run typecheck
```

- [ ] Commit only the four task files:

Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add -- e2e/performance/config.ts e2e/performance/config.test.ts e2e/performance/cli.ts e2e/performance/cli.test.ts`, and then a separate commit with subject `feat(perf): document and validate workload options`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 5: Separate stable surface identity from shared application paths

**Files:**

- Modify: `e2e/performance/types.ts`
- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/routes.test.ts`
- Modify: `e2e/performance/collect.ts`
- Modify: `e2e/performance/collect.test.ts`
- Modify: `e2e/performance/aggregate.ts`
- Modify: `e2e/performance/aggregate.test.ts`
- Modify: `e2e/performance/compare.ts`
- Modify: `e2e/performance/compare.test.ts`
- Modify: `e2e/performance/report.ts`
- Modify: `e2e/performance/report.test.ts`
- Modify: `e2e/performance/selfQa.ts`
- Modify: `e2e/performance/selfQa.test.ts`
- Modify: `e2e/performance/cli.ts`
- Modify: `e2e/performance/cli.test.ts`

**Interfaces:**

- Produces: one unique `surfaceId` identity through registry, samples, requests, orders, branches, aggregates, rankings, reports, comparisons, self-QA, tokens, and sanitizers; separate `pathTemplate`, `coldTarget`, and `behaviorFamily` contracts.
- Consumes: existing 28-route registry and all current `route.key`/`routeKey` consumers.

- [ ] Add a registry test that creates multiple entries with the same `/inbox` path and proves uniqueness is enforced only on `surfaceId`. Assert all detail routes use `coldTarget.kind='resolved'` and all static routes use `coldTarget.kind='static'`.
- [ ] Add aggregate/comparison/report tests with two samples sharing `/inbox` but using different surface IDs. Assert they remain distinct in orders, request joins, aggregates, rankings, added/removed results, and privacy allowlists.
- [ ] Add a repository-level test or source assertion that no persisted or join-bearing interface contains `routeKey`/`routeKeys` after migration. `pathTemplate` remains diagnostic and must never be used as a unique map key.
- [ ] Run the focused suite and observe duplicate-path collisions or missing fields:

```powershell
npm run test -w @housingchoice/e2e -- performance/routes.test.ts performance/collect.test.ts performance/aggregate.test.ts performance/compare.test.ts performance/report.test.ts performance/selfQa.test.ts performance/cli.test.ts
```

- [ ] Change `RouteDefinition` to require:

```ts
export interface RouteDefinition {
  surfaceId: string;
  label: string;
  pathTemplate: string;
  coldTarget: ColdTarget;
  behaviorFamily: BehaviorFamily;
  resolver: ResolverName;
  source: WarmSourceContract;
  terminal: TerminalContract;
  gets: readonly EndpointContract[];
  surfaceScaleBearing: boolean;
  loadScaleBearing: boolean;
  blockedSurface?: BlockedWriteSurface;
}
```

- [ ] Migrate every identity consumer in one compile-safe slice: `RequestEvidence`, `SampleResult`, `RouteScaleMetadata`, `RouteModeAggregate`, `ComparisonEntryRef`, branch observations, route-order rows, warmup metadata, sample tokens, browser failure samples, checkpoint rows, report maps, aggregate group keys, comparison keys, self-QA lookup, and serializers.
- [ ] Introduce the closed `SurfaceEvidence` union and required `SampleResult.surfaceEvidence` in this compile-wide task. Initialize it to null in every production constructor (`routes.ts` skip results, `collect.ts` success/failure paths, and `cli.ts` assembled results), every typed test fixture in aggregate/compare/report/self-QA/collect/routes/cli tests, and every serializer clone. Add basic serializer tests for null and both closed union members so later tasks can replace null without reopening compile-wide ownership; Task 9 still adds the adversarial privacy matrix.
- [ ] Existing surfaces retain their former key string as `surfaceId` and current path as `pathTemplate`. Static routes receive their current literal path as `coldTarget.path`; resolved details use `{ kind: 'resolved' }`. Assign `behaviorFamily='standard'` except Inbox surfaces.
- [ ] Change static resolver/navigation to consume `coldTarget.path`; do not reconstruct a cold URL from `pathTemplate`.
- [ ] Keep `INTERCEPTION_SCOPE_VERSION = 3`; this task changes attribution, not what browser requests are intercepted. Bump report schema, registry, and workload versions as specified.
- [ ] Run the full e2e-workspace unit suite, search for stale identity fields, and typecheck:

```powershell
npm run test -w @housingchoice/e2e
rg -n "routeKey|routeKeys|\.key\b" e2e/performance
npm run typecheck
```

The `rg` result may contain explanatory migration tests only. It must not find live persisted/joining fields or `RouteDefinition.key` consumers.

- [ ] Commit only the listed e2e files:

Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add` for the files listed in this task, and then a separate commit with subject `refactor(perf): separate surface identity from routes`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 6: Register four exact Inbox surface contracts and request classes

**Files:**

- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/routes.test.ts`
- Modify: `e2e/performance/types.ts`
- Modify: `e2e/performance/collect.ts`
- Modify: `e2e/performance/collect.test.ts`

**Interfaces:**

- Produces: `inbox-all`, `inbox-unread`, `inbox-unknown`, and `inbox-groups`; exact page/badge request classification; full All-source terminal; fixed accessible warm actions.
- Consumes: `INBOX_FILTERS` and empty titles from `dashboard/src/routes/inbox/inboxFilters.ts`, URL/tab behavior from `dashboard/src/routes/inbox/Inbox.tsx`, page limit 30 from `dashboard/src/routes/inbox/useInbox.ts`, and badge limit 100 from `dashboard/src/app/UnreadContext.tsx`.

- [ ] Add route tests for the exact contract matrix:

```text
inbox-all     /inbox                 all      inbox_page_all
inbox-unread  /inbox?filter=unread   unread   inbox_page_unread
inbox-unknown /inbox?filter=unknown  unknown  inbox_page_unknown
inbox-groups  /inbox?filter=groups   groups   inbox_page_groups
```

Each shares `pathTemplate='/inbox'`, uses `behaviorFamily='inbox'`, has an exact tab locator with `selected: true`, and uses its filter-specific empty title. Route validation permits `selected` only for a `tab` role. The three filtered entries use tab actions from canonical bare `/inbox`; no entry declares Load more or row activation.

- [ ] Retain route resolver tests proving conversation detail selects the designated newest readable relay fixture and broadcast detail selects the designated first terminal broadcast fixture under the Task 2 ordering contract.

- [ ] Add network tests that classify only these exact tuples: page `filter=<surface>&limit=30` without cursor and badge `filter=unread&limit=100` without cursor. Assert unread/30 and unread/100 remain distinct, an unexpected cursor/value/limit is a closed endpoint-contract failure, and no raw query value enters evidence.
- [ ] Add cold/warm role tests: badge is required shell and readiness-bearing in cold mode, background shell if observed in warm mode; only the matching page class satisfies the page contract and increments `initialInboxPageRequestCount`.
- [ ] Add tests that general cold API counts/bytes include both unread page and badge, while page-specific count/timing includes unread/30 only.
- [ ] Run the red tests:

```powershell
npm run test -w @housingchoice/e2e -- performance/routes.test.ts performance/collect.test.ts
```

- [ ] Replace the single Inbox registry row with four definitions. Keep exact cold URL query order in the checked-in contract, but normalize query state before equality comparisons so identity does not depend on order.
- [ ] Extend endpoint expectations to include safe fixed values for Inbox request classes, not merely the presence of `filter` and `limit` keys. Preserve the existing general endpoint-template subset gate.
- [ ] Classify parsed URLs in memory before redaction, return only a closed `InboxRequestClass`, and mark unmatched `/api/inbox` shapes with a fixed failure code. Never persist the rejected values.
- [ ] Make Inbox badge/page roles conditional on `behaviorFamily='inbox'`; remove the literal `/inbox` route identity comparison from `isShellRequest()`.
- [ ] Run focused tests and typecheck:

```powershell
npm run test -w @housingchoice/e2e -- performance/routes.test.ts performance/collect.test.ts
npm run typecheck
```

- [ ] Commit only the task files:

Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add -- e2e/performance/routes.ts e2e/performance/routes.test.ts e2e/performance/types.ts e2e/performance/collect.ts e2e/performance/collect.test.ts`, and then a separate commit with subject `feat(perf): register four inbox surfaces`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 7: Enforce exact warm sources, tab activation, and Inbox terminal XOR

**Files:**

- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/routes.test.ts`
- Modify: `e2e/performance/collect.ts`
- Modify: `e2e/performance/collect.test.ts`
- Modify: `e2e/performance/cli.ts`
- Modify: `e2e/performance/cli.test.ts`
- Modify if type propagation requires: `e2e/performance/readiness.ts`
- Modify if type propagation requires: `e2e/performance/readiness.test.ts`

**Interfaces:**

- Produces: exact normalized warm source targets, closed `link|tab` activation, measurement boundary immediately before click, `required_action_missing`, and `contradictory_terminal`.
- Consumes: Task 6 route contracts, Playwright accessibility locators, existing readiness settling, instrumentation/firewall reset APIs, and partial-report failure flow.

- [ ] Add exact-target tests where current URLs are bare `/inbox`, each filtered query, the same keys in another order, and an extra query key. Only exact normalized equality may return ready; filtered or extra-query state must navigate to bare `/inbox`.
- [ ] Add shuffled-order tests for every filtered-to-filtered transition and filtered-to-conversation-detail transition. Assert source All navigation/request/settle occurs before buffers reset, and destination timing begins immediately before the exact tab/link activation.
- [ ] Add terminal tests for each filter: selected tab plus populated only succeeds, selected tab plus exact empty only succeeds, neither keeps waiting, both fail `contradictory_terminal`, wrong selected tab cannot succeed, pending/error remain non-success terminal states. Include a direct real-adapter test where the expected tab is visible but `aria-selected=false`; it must remain unready even while a Conversations list is visible.
- [ ] Add warm action tests proving exact tab names, a missing fixed tab yields `required_action_missing`, and fixture-only resolved links retain `fixture_not_navigable`. Assert no action contract can express Load more, Retry, notice navigation, or arbitrary selector clicks.
- [ ] Add an instrumentation test that source requests/firewall events exist, then reset immediately before click, and assert none appear in the destination sample.
- [ ] Run red tests:

```powershell
npm run test -w @housingchoice/e2e -- performance/routes.test.ts performance/collect.test.ts performance/cli.test.ts performance/readiness.test.ts
```

- [ ] Replace `WarmSourceContract.path` with `target: ExactBrowserTarget` and require the full source terminal. All Inbox source consumers, including conversation detail, use `{ path: '/inbox', query: { kind: 'absent' } }` plus the full All terminal.
- [ ] In the real-page adapter, normalize `location.pathname` plus allowlisted search keys into the closed query state. Source preparation and readiness must call the same normalizer.
- [ ] Map `LocatorContract.selected === true` to Playwright's `getByRole(..., { selected: true })` option and evaluate it in the same readiness poll as the populated/empty XOR. Do not infer selected state from a preceding click.
- [ ] Extend the action switch only with `link` and `tab`. Use `getByRole('tab', { name, exact: true })` for fixed filter chrome. Do not fall back to substring or a generic locator.
- [ ] Order `collectWarmSample()` as: prepare source, wait full source terminal, resolve fixture if needed, create/reset sample instrumentation and firewall phase state, then immediately activate exact action. Dispose all state through existing `finally` paths on missing actions or other failures.
- [ ] Evaluate both populated and exact empty locators before returning terminal state. Surface a closed contradictory result through the existing artifact-preserving sample failure path.
- [ ] Run focused tests and typecheck:

```powershell
npm run test -w @housingchoice/e2e -- performance/routes.test.ts performance/collect.test.ts performance/cli.test.ts performance/readiness.test.ts
npm run typecheck
```

- [ ] Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add` for only files actually changed from this task's list, and then a separate commit with subject `feat(perf): enforce exact inbox activation`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 8: Record passive Inbox evidence and preserve the relay-only DOM proof

**Files:**

- Modify: `e2e/performance/collect.ts`
- Modify: `e2e/performance/collect.test.ts`
- Modify: `e2e/performance/cli.ts`
- Modify: `e2e/performance/cli.test.ts`

**Interfaces:**

- Produces: closed `InboxSampleEvidence`, safe Inbox row count, groups-truncated boolean, optional initial conversation-detail message-row count, and relay-only exact DOM count on `inbox-all`.
- Consumes: fixed `Conversations` list label, fixed `Relay group` and `Group text` kind labels from `dashboard/src/routes/inbox/InboxRow.tsx`, and existing `relayGroupCount` manifest equality.

- [ ] Add DOM adapter tests with a `Conversations` list containing contact, relay-group, and native Group text rows. Assert rendered row count includes every row, but relay count includes only list items with the exact fixed `Relay group` label and a descendant `/conversations/` link.
- [ ] Add a negative test proving a native row with fixed `Group text` and the same href prefix is excluded. Add shuffled-order coverage proving the relay proof runs exactly once on successful `surfaceId='inbox-all'`, never on the first `behaviorFamily='inbox'` sample.
- [ ] Add tests for safe `groupsTruncated` detection and populated/empty Inbox rendered counts. For All/Unknown, detect truncation only through the exact visible `See all group texts` link; for Unread, only through the exact visible `Browse all group texts (read and unread)` link; for Groups, only through an anchored fixed selector matching `Not all group texts are shown here.` or `Showing the latest <positive integer> group text(s).`. Add zero-row, singular, plural, Unread, and negative cases. Use those strings only as selectors and return only a boolean.
- [ ] Assert the current conversation-detail initial rendered-message count is null because `Timeline.tsx` has no stable message-specific semantic marker. Do not add a speculative numeric branch, count generic Timeline children, or add a dashboard-only profiler marker. Preserve the nullable schema so a later product-owned semantic marker can enable numeric evidence without a schema change.
- [ ] Add a test that no Inbox sample invokes row click, mark-read, notice link, Retry, or Load more and that expected blocked-write sets remain empty.
- [ ] Run red tests:

```powershell
npm run test -w @housingchoice/e2e -- performance/collect.test.ts performance/cli.test.ts
```

- [ ] Add one closed browser adapter method that returns only safe Inbox counts/booleans. Keep fixed labels inside selectors and never return the matched text. The Groups notice regex is anchored and ASCII-only; it permits only the fixed zero sentence or the fixed positive-integer singular/plural sentence.
- [ ] Implement relay counting with a scoped locator equivalent to:

```ts
const rows = page.getByRole('list', { name: 'Conversations', exact: true }).getByRole('listitem');
const relayRows = rows
  .filter({ has: page.getByText('Relay group', { exact: true }) })
  .filter({ has: page.locator('a[href^="/conversations/"]') });
return relayRows.count();
```

Use a page-scoped or row-scoped locator construction that Playwright supports; retain the exact-label and descendant-link semantics.

- [ ] Replace the Task 5 null evidence only after a successful sample: attach `InboxSampleEvidence` only for `behaviorFamily='inbox'` and attach `{ kind: 'conversation_detail', initialRenderedMessageCount: null }` for conversation detail on the current dashboard. All failed/skipped/other surfaces retain null. Do not compare the nullable count with stored tail depth.
- [ ] Dispatch the relay proof only when `surfaceId === 'inbox-all'`, `status === 'ok'`, and the one-run proof has not yet executed. Keep exact equality to `relayGroupCount` and the existing no-truncation/query-budget guard.
- [ ] Run focused tests and typecheck:

```powershell
npm run test -w @housingchoice/e2e -- performance/collect.test.ts performance/cli.test.ts
npm run typecheck
```

- [ ] Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add` for the four Task 8 files, and then a separate commit with subject `feat(perf): capture passive inbox evidence`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 9: Version, sanitize, compare, and self-QA the expanded evidence

**Files:**

- Modify: `e2e/performance/report.ts`
- Modify: `e2e/performance/report.test.ts`
- Modify: `e2e/performance/compare.ts`
- Modify: `e2e/performance/compare.test.ts`
- Modify: `e2e/performance/aggregate.ts`
- Modify: `e2e/performance/aggregate.test.ts`
- Modify: `e2e/performance/selfQa.ts`
- Modify: `e2e/performance/selfQa.test.ts`
- Modify: `e2e/performance/types.ts`

**Interfaces:**

- Produces: schema 2 artifacts, registry/workload compatibility, resolved comparison projection, 31 independent rankings, 31/62 full self-QA, and privacy-safe new fields.
- Consumes: Tasks 1, 5, 6, and 8 contracts; existing report preflight/defense scan and comparison mismatch machinery.

- [ ] Add schema tests that assert the exact property allowlist for every new/changed object: seed manifest, comparison workload, request evidence, `SampleResult.surfaceEvidence`, both discriminated surface-evidence members, route order, branch observation, aggregate, ranking entry, comparison entry, and self-QA result. Prove the conversation-detail serialized sample retains the exact null value instead of dropping the field.
- [ ] Add the inverse privacy test: mutate each new field with an arbitrary string, raw ID-like value, phone, email, URL/query, or extra property and assert sanitization rejects/replaces it through the existing closed path. Numeric fields must require non-negative safe integers; enums must use explicit allowlists.
- [ ] Add comparison tests for each incompatibility field: schema version, registry version, workload version, surface set, target data-source class, and resolved comparison workload. Assert old 28-surface baselines are incompatible and `/inbox` is never silently aligned to `inbox-all`.
- [ ] Add compatibility tests for omitted versus explicit equal defaults and distinct requested/clipped values that produce the same resolved workload.
- [ ] Add ranking tests proving all four Inbox IDs can coexist with the same path template and are ranked independently for cold and warm metrics.
- [ ] Update full self-QA tests to require exactly 31 routes and 62 successful samples, all four Inbox surfaces, matching page request classes, no unexpected cursor, relay equality on `inbox-all`, zero passive Inbox writes, and every original state/firewall/privacy proof.
- [ ] Run red tests:

```powershell
npm run test -w @housingchoice/e2e -- performance/report.test.ts performance/compare.test.ts performance/aggregate.test.ts performance/selfQa.test.ts
```

- [ ] Build `ComparisonEnvironment.comparisonWorkload` from the closed Task 1 projection for hermetic runs. For local/hosted-dev use `dataSource='existing'` and null synthetic workload; never infer totals.
- [ ] Update report writers/readers and Markdown tables to label by `surfaceId` while retaining `pathTemplate` as a separate diagnostic column where useful.
- [ ] Preserve privacy scan order and quarantine semantics. New fields must pass in-memory preflight before staging and the exact persisted-byte defense scan afterward.
- [ ] Update self-QA narrow keys to use stable surface IDs and full expected count from 28 to 31. Do not alter existing blocked-write tuple sets except the passive Inbox additions, whose expected set is empty.
- [ ] Run the complete e2e unit suite and typecheck:

```powershell
npm run test -w @housingchoice/e2e
npm run typecheck
```

- [ ] Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add` for the nine task files, and then a separate commit with subject `feat(perf): version expanded profiler evidence`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 10: Document the complete contract and prove end-to-end integration

**Files:**

- Modify: `e2e/README.md`
- Modify as required by integration findings: files from Tasks 1-9 only

**Interfaces:**

- Produces: operator-facing CLI reference and final evidence that parser, reset, browser collection, artifact writing, comparison, and self-QA agree.
- Consumes: all prior tasks and the authoritative design acceptance criteria.

- [ ] Update `e2e/README.md` with every public option, inclusive bounds, defaults/derivations, scale behavior, clipping, parent/capacity rules, total-work contribution, formulas, scale-7 calibration provenance, five required examples, local/hosted existing-data restriction, and `--print-config` workflow.
- [ ] State explicitly that conversation depth is stored workload; the profiler measures initial passive readiness and initial row count, never clicks Load more, and does not promise current latency changes while the application reads a bounded initial page.
- [ ] Document four Inbox surfaces, cold URLs, API page queries, badge/page distinction, canonical warm source, exact tab activation, terminal XOR, safe evidence, relay-only proof, 31/62 cardinality, and baseline incompatibility.
- [ ] Add/refresh CLI integration assertions that help contains every README option token and examples use accepted syntax. Keep prose comments ASCII-only.
- [ ] Run the non-skipped DynamoDB Local integration suite. If Docker is not running, start the shared service with `npm run db:start`; do not stop it:

```powershell
$env:PERF_SEED_REQUIRE_DYNAMO='1'
npm run test -w @housingchoice/app -- performanceSeed.integration.test.ts
Remove-Item Env:PERF_SEED_REQUIRE_DYNAMO
```

The output must identify `performanceSeed.integration.test.ts` and executed tests; a skip is a gate failure.

- [ ] Run a config-only dry proof before browser work:

```powershell
npm run perf:pages -- hermetic --scale=1 --print-config
```

Assert the output resolves contacts 100, units 16, native groups 21, placements 50, tours 50, conversations 100, broadcasts 10, and the documented densities/tails without starting a lane or creating artifacts.

- [ ] Run the exact full hermetic self-QA:

```powershell
npm run perf:pages -- hermetic --scale=1 --cold-repeats=1 --warm-repeats=1 --self-qa=full
```

Require exit 0, 31 resolved surfaces, 62 successful samples, all four Inbox surfaces in both rankings, exact page/badge contracts, relay-only DOM equality, fixture reachability, zero unexpected write tuples, healthy watchdog, and all privacy/state/cleanup assertions.

- [ ] Run a separate non-self-QA baseline with omitted seed defaults and a fixed order. This is distinct from the 31/62 self-QA because diagnostic mode intentionally rejects explicit seed overrides. Capture only stdout to one exact gitignored temporary file so the safe directory token can be parsed without piping the profiler command:

```powershell
$baselineOutput = Join-Path (Resolve-Path '.superpowers/design-review') 'workload-baseline.stdout.txt'
npm run perf:pages -- hermetic --cold-repeats=1 --warm-repeats=1 --route-order-seed=424242 1> $baselineOutput
if ($LASTEXITCODE -ne 0) { throw "default_baseline_failed exit=$LASTEXITCODE" }
```

- [ ] In the next standalone PowerShell call, parse exactly one safe `performance_report=<directoryName>` line, validate the value against the CLI's existing `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` grammar, construct its exact summary beneath the known repo-root artifact directory, enforce containment/existence, remove the exact temporary capture, and run the explicit-default half. Do not choose an artifact by modification time and do not make the CLI print an absolute path:

```powershell
$baselineOutput = Join-Path (Resolve-Path '.superpowers/design-review') 'workload-baseline.stdout.txt'
$reportLines = @(Get-Content -LiteralPath $baselineOutput | Where-Object { $_ -match '^performance_report=[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' })
if ($reportLines.Count -ne 1) { throw 'baseline_report_token_invalid' }
$baselineDirectory = $reportLines[0].Substring('performance_report='.Length)
$artifactRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'e2e/.artifacts/performance'))
$baselineSummary = [IO.Path]::GetFullPath((Join-Path $artifactRoot (Join-Path $baselineDirectory 'summary.json')))
if ($baselineDirectory -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') { throw 'baseline_directory_invalid' }
if (-not $baselineSummary.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'baseline_summary_outside_root' }
if (-not (Test-Path -LiteralPath $baselineSummary -PathType Leaf)) { throw 'baseline_summary_missing' }
Remove-Item -LiteralPath $baselineOutput
npm run perf:pages -- hermetic --scale=1 --contacts=100 --units=16 --placements=50 --tours=50 --conversations=100 --native-groups=21 --messages-per-conversation=10 --long-conversation-messages=10 --broadcasts=10 --recipients-per-broadcast=25 --large-broadcast-recipients=25 --cold-repeats=1 --warm-repeats=1 --route-order-seed=424242 "--baseline=$baselineSummary"
if ($LASTEXITCODE -ne 0) { throw "explicit_default_comparison_failed exit=$LASTEXITCODE" }
```

Require an explicitly controlled comparison with no workload, route-order, schema, registry, or surface-set mismatch. If parsing or comparison fails, remove only the exact `$baselineOutput` file after inspecting it; never use a glob or recursive removal.
- [ ] Run targeted suites once more after any integration fixes:

```powershell
npm run test -w @housingchoice/app -- performanceSeed.test.ts devGating.test.ts
npm run test -w @housingchoice/e2e
npm run typecheck
```

- [ ] Run standalone `git status`, the `MERGE_HEAD` check, explicit-path `git add` for `e2e/README.md` and any narrowly required integration fixes, and then a separate commit with subject `docs(perf): document representative workloads`. Its `Co-Authored-By` trailer must name the model that actually authored the commit.

---

## Task 11: Final sync, bare gates, and merge-ready handback

**Files:**

- Modify: only conflict resolutions or gate fixes directly required by this feature
- Verify: all files changed since `main`

- [ ] Inspect worktree ownership and branch state. If `main` advanced, sync it once into this feature branch. If syncing would conflict with another agent's active work, stop and ask the human.
- [ ] Re-run the explicit non-skipped DynamoDB Local integration suite after the sync. If Docker is unavailable, start the shared service with `npm run db:start` and leave it running. A skip is a final-gate failure:

```powershell
$env:PERF_SEED_REQUIRE_DYNAMO='1'
npm run test -w @housingchoice/app -- performanceSeed.integration.test.ts
Remove-Item Env:PERF_SEED_REQUIRE_DYNAMO
```

Require the output to name `performanceSeed.integration.test.ts` and report executed tests, then record that executed count in the handback.
- [ ] Run the bare required gates from `W:\tmp\page-performance-profiler-workloads`, without piping:

```powershell
npm run typecheck
npm test
npm run e2e
```

- [ ] If a documented known flake occurs, rerun it once and report both runs. Do not classify a new failure as a flake without evidence.
- [ ] Run the exact full hermetic profiler self-QA again on the final commit candidate and verify the 31/62 and privacy/firewall/state assertions from Task 10:

```powershell
npm run perf:pages -- hermetic --scale=1 --cold-repeats=1 --warm-repeats=1 --self-qa=full
```
- [ ] Run ASCII and change-scope checks:

```powershell
git diff --check main...HEAD
git status
git diff --name-only main...HEAD
```

- [ ] Commit only any final feature-owned fixes after the same standalone status, `MERGE_HEAD`, explicit-stage, and actual-model trailer discipline. Confirm a clean worktree and record the final commit SHA, base SHA, gate exit codes, executed integration-test count, self-QA artifact path, 31/62 counts, and any remaining human-only actions.
- [ ] Do not merge. Hand the branch back for independent review and human merge approval.

## Acceptance Mapping

| Design acceptance criterion | Plan evidence |
| --- | --- |
| 1. Exact scale-1 breadth | Task 1 resolver tests; Task 4 print-config tests; Task 10 dry proof |
| 2. Exact 95/4/1 contact mix | Tasks 1 and 2 pure tests |
| 3. Exact native groups and pre-lifecycle capacity failure | Tasks 1-3 pure and DynamoDB Local tests |
| 4. Deterministic bounded documented values in config/manifest | Tasks 1, 4, 9, and 10 |
| 5. Independent deep conversation and large broadcast | Tasks 1 and 2 generation/formula tests |
| 6. Four separately timed/ranked Inbox surfaces | Tasks 5, 6, and 9 |
| 7. Destination timing begins immediately before tab activation | Task 7 instrumentation-boundary tests |
| 8. Every Inbox source consumer re-establishes canonical All | Task 7 permutation tests |
| 9. Badge and page request roles remain distinct | Task 6 collector tests |
| 10. Missing tabs and contradictory terminals fail closed | Task 7 action/terminal tests |
| 11. No Inbox or history Load more | Tasks 6-8 closed action tests and Task 10 documentation |
| 12. Stored depth and nullable initial rows remain distinct | Tasks 2, 8, and 9 |
| 13. Local/hosted existing-data-only restriction | Tasks 4, 9, and 10 |
| 14. Old baselines are incompatible | Task 9 comparison tests |
| 15. Equivalent resolved workloads compare as controlled | Task 9 comparison tests and Task 10 round trip |
| 16. Native-group member slots count toward the cap | Tasks 1 and 2 formula/count tests |
| 17. Relay-only exact DOM proof on `inbox-all` | Tasks 8 and 9 |
| 18. Original safety/privacy/ownership invariants remain | Global constraints; Tasks 3, 6-11 regression gates |
| 19. Required unit, integration, self-QA, and repository gates | Tasks 10 and 11 |

## Plan Self-Review Checklist

- [ ] Every design acceptance criterion 1-19 maps to at least one task and a falsifiable test or gate.
- [ ] Every checked-in workload base, bound, formula, native-group shape, sender key, Inbox query, UI label, empty title, page limit, badge limit, and selector is cited to a current source file in this plan or the authoritative design's source-anchor table.
- [ ] The workload preflight covers all numeric parsing, tail relationships, capacity, clipping, fixture presence, and total-work arithmetic before lifecycle discovery or reset.
- [ ] Lazy native-group selection never materializes a complete combination pool and bounded capacity arithmetic cannot overflow.
- [ ] The lean native group and all its messages are removed inside the injected profiler lane before exact performance group generation.
- [ ] No `routeKey` alias remains in persisted evidence or any map/set/join/order/comparison key; `surfaceId` is unique and `pathTemplate` is diagnostic.
- [ ] Initial Inbox page tuples and the unread/100 badge tuple are exact, independently satisfiable, and never conflated.
- [ ] `/api/events` remains never matched by interception and this plan does not change interception scope version.
- [ ] Warm source identity includes exact query state; every Inbox source consumer re-establishes bare `/inbox` plus the complete All terminal.
- [ ] Destination buffers reset immediately before the exact tab/link activation and no source work enters the measured sample.
- [ ] Inbox loaded terminals enforce populated/empty XOR and missing fixed tabs fail as `required_action_missing`.
- [ ] All four Inbox surfaces are passive, with empty blocked-write sets; no Load more, Retry, row, mark-read, or notice-link workflow is exercised.
- [ ] Relay DOM proof runs only on `inbox-all`, requires the exact `Relay group` label plus conversation link, and excludes exact `Group text` rows.
- [ ] New artifact fields are closed safe scalars/enums with privacy allowlists tested in both directions; no raw URL/query/ID/text can enter output.
- [ ] Baseline compatibility uses only resolved stored workload, schema, registry, surface set, and data-source class; requested syntax and anchor are excluded.
- [ ] Full self-QA requires exactly 31 surfaces and 62 successful cold/warm samples without weakening existing tuple/state/privacy assertions.
- [ ] DynamoDB Local integration cannot silently self-skip in final gates.
- [ ] No placeholders such as `TODO`, `TBD`, `etc.`, ellipses, or unspecified implementation decisions remain.
- [ ] Commit commands use explicit paths and the actual authoring model trailer.
