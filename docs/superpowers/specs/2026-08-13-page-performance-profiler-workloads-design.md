# Page Performance Profiler Workload and Inbox Expansion - Design

- Date: 2026-08-13
- Status: Draft for adversarial review
- Owner: Cameron Abt
- Branch: `feat/page-performance-profiler-workloads`
- Extends: `docs/superpowers/specs/2026-08-11-page-performance-profiler-design.md`

## 1. Problem

The page performance profiler is merge-ready, but its hermetic workload is not
yet representative enough for the next round of performance analysis:

1. The scale-1 seed has 100 contacts but its contact-type mix and 25-property
   base do not resemble the imported local population closely enough.
2. Native group texts are absent from the performance seed even though the
   representative local population has roughly 135 native groups for roughly
   650 contacts.
3. The Inbox is measured as one `/inbox` surface even though All, Unread,
   Unknown, and Groups select different server query branches and have
   materially different latency.
4. A uniform ten messages per conversation and 25 recipients per broadcast
   cannot exercise a deliberately deep conversation or large broadcast without
   multiplying that density across the whole seed.
5. The existing command accepts many seed options, but the complete option
   contract is split between source and README examples rather than exposed by
   one authoritative `--help` surface.

The profiler must make those workloads controllable without turning a passive
page-load profiler into a workflow runner. In particular, it must not open an
Inbox row, click Load more, send a message, mark a row read, or perform any other
application workflow.

## 2. Goals

This change will:

1. Recalibrate the hermetic scale model while preserving 100 generated contacts
   as the meaning of scale 1.
2. Add deterministic native group-text conversations to the hermetic seed.
3. Treat the four Inbox filters as independent, ranked performance surfaces.
4. Add independent tail-workload controls for one long conversation and one
   large broadcast without making breadth times depth grow accidentally.
5. Document every profiler argument in `--help` and `e2e/README.md`, and expose
   the fully resolved configuration through `--print-config` and the run
   manifest.
6. Preserve the original profiler's target proofs, write firewall, watchdog,
   privacy wall, lifecycle ownership, comparison behavior, and on-demand-only
   policy.

## 3. Non-goals

This change does not:

- implement or change conversation-history pagination;
- click a conversation-history or Inbox Load more control;
- assert that every seeded message is returned or rendered on initial load;
- open an Inbox row during an Inbox-filter sample;
- seed, reseed, import, or otherwise modify local or hosted-dev data;
- add a performance threshold or CI gate;
- infer production totals from private record contents;
- preserve compatibility with the discarded scale-1, scale-10, or scale-100
  baseline artifacts from the prior calibration;
- change production route behavior.

Conversation depth is a property of the stored hermetic workload. The measured
action is still initial passive navigation and initial meaningful readiness. If
the application initially renders all history in the future, that cost is
captured naturally. If it initially renders a bounded page with a Load more
control, the profiler records the initial result and does not press the control.

## 4. Locked decisions

| ID | Decision | Choice |
| --- | --- | --- |
| W1 | Scale identity | Scale 1 remains 100 generated contacts. |
| W2 | Calibration | Use the authorized aggregate local observation as a shape guide, not as a copied dataset or exact production claim. |
| W3 | Native groups | Add 21 native group-text conversations per scale unit, independently overridable. |
| W4 | Contact mix | Generate approximately 95 tenant, 4 landlord, and 1 unknown contact per 100 contacts. |
| W5 | Properties | Change the scale base from 25 to 16 unit records per 100 contacts. |
| W6 | Coverage workloads | Keep 50 placements, 50 tours, 100 existing non-native conversations, and 10 broadcasts per scale unit as synthetic coverage workloads. |
| W7 | Density | Keep ordinary messages per conversation and recipients per broadcast scale-invariant; provide both uniform density overrides and single-fixture tail overrides. |
| W8 | Inbox surfaces | Rank All, Unread, Unknown, and Groups independently. |
| W9 | Interaction | Cold URL navigation and warm accessible navigation only; never click a row or Load more. |
| W10 | Existing data | Local and hosted-dev targets profile only the data already present on the target. |
| W11 | Evidence | Emit privacy-safe timings, aggregate counts, resolved workload values, and controlled comparison metadata only. |
| W12 | Historical baselines | Start a new comparison lineage; the old calibration artifacts are not comparison-compatible. |

## 5. Calibration and provenance

The human explicitly authorized an aggregate-only inspection of the existing
local stack. That inspection found approximately:

| Population | Aggregate observation |
| --- | ---: |
| Active contacts | 630 |
| Tenants | 598 |
| Landlords | 24 |
| Unknown contacts | 8 |
| Active properties | 100 |
| Native group texts | approximately 135, supplied by the human and corroborated by the visible group surface shape |
| Active placements | 0 |
| Active tours | 0 |
| Matching broadcasts | 0 |

No names, phone numbers, email addresses, message bodies, raw IDs, or other
record contents become seed inputs or artifacts. These figures are calibration
guidance only. The zero tour, placement, and broadcast observations do not
remove those entities from the hermetic seed: those are explicitly retained as
coverage workloads so their pages remain measurable.

At the new defaults, scale 7 is a convenient approximation of the observed
contact, property, and native-group population. It is not labeled a production
copy, and exact equality is not a success condition.

### 5.1 Current-code source anchors

The implementation plan and reviewers must re-check these anchors against the
then-current branch rather than treating this table as a substitute for source:

| Contract | Current source anchor |
| --- | --- |
| Existing performance bases, bounds, manifest fields, and cap arithmetic | `app/src/lib/seed/performance.ts:21-81,150-238` |
| Existing 50/30/20 contact mix and deleted-row cadence to be replaced/reported honestly | `app/src/lib/seed/performance.ts:301-346` |
| Existing relay-group ratio and deterministic conversation/message generation | `app/src/lib/seed/performance.ts:487-586,730-795` |
| Existing broadcast recipient embedding | `app/src/lib/seed/performance.ts:589-641` |
| Native `group_text` row shape | `app/src/lib/seed/lean.ts:227-246`; `app/src/repos/conversationsRepo.ts:35-59,105-130` |
| Inbox filter enum and exact empty copy | `dashboard/src/routes/inbox/inboxFilters.ts:11-34` |
| URL-backed selected tab and accessible tab markup | `dashboard/src/routes/inbox/Inbox.tsx:16-43,53-65` |
| Initial Inbox page limit and request call | `dashboard/src/routes/inbox/useInbox.ts:64,93-166` |
| Browser API query construction | `dashboard/src/api/endpoints.ts:1513-1522` |
| Groups-only native partition and All/Unread/Unknown group behavior | `app/src/routes/inbox.ts:158-180,437-451,700-723,844-887,907-920` |
| Existing registry and current single Inbox surface | `e2e/performance/routes.ts:475-502` |
| Existing public CLI option inventories | `e2e/performance/config.ts:59-97` |

## 6. Hermetic workload model

### 6.1 Scaled breadth

For every field not explicitly overridden, resolve the following base times
`scale`:

| Field | Scale-1 base | Classification |
| --- | ---: | --- |
| contacts | 100 | locally calibrated breadth |
| units | 16 | locally calibrated breadth; dashboard label is Properties |
| native groups | 21 | locally calibrated breadth |
| placements | 50 | synthetic coverage workload |
| tours | 50 | synthetic coverage workload |
| existing conversations | 100 | synthetic coverage workload containing current 1:1 and relay-group fixtures |
| broadcasts | 10 | synthetic coverage workload |

`--conversations` retains its current meaning for the existing performance-seed
conversation population. `--native-groups` is an additional population because
native group texts use the separate `group_open` partition and are the only
rows returned by the Inbox Groups filter. The manifest reports all three values:
`conversations`, `nativeGroups`, and `totalConversations`.

The generator applies the 95/4/1 contact-type mix deterministically. For counts
that are not a multiple of 100, landlord and unknown counts are the floors of
4 percent and 1 percent respectively, and tenants receive the remainder. The
existing deterministic deleted-row coverage may remain, but the manifest must
report generated totals and active totals separately so the meaning is not
ambiguous.

Every breadth override is a non-negative safe integer within the existing
entity-count bound. The scale remains an integer from 1 through 100. All
resolved values participate in the existing total-work bound before any lane is
started or table is cleared.

### 6.2 Ordinary density

The existing options remain supported:

```text
--messages-per-conversation=<0..100>
--recipients-per-broadcast=<0..1000>
```

They are scale-invariant defaults. `--messages-per-conversation` applies to the
existing conversation population and native group-text conversations.
`--recipients-per-broadcast` applies to every broadcast except the designated
large-broadcast fixture described below.

Increasing breadth alone therefore remains linear. The runner never silently
multiplies either density by `scale`.

### 6.3 Tail workload: one long conversation

Add:

```text
--long-conversation-messages=<0..20000>
```

If omitted, it resolves to `messagesPerConversation`. If provided, it must be
greater than or equal to `messagesPerConversation`. It replaces, rather than
adds to, the ordinary message count for one deterministic readable relay-group
conversation that is also the resolver fixture for
`/conversations/:conversationId`.

When at least one existing conversation is generated:

```text
totalMessageCount =
  (totalConversations - 1) * messagesPerConversation
  + longConversationMessages
```

When no eligible relay-group fixture exists because its parent population is
zero, every native group still receives the ordinary density and no tail
replacement occurs. In that case `totalMessageCount` is
`totalConversations * messagesPerConversation`. The manifest records the
requested value, resolved value, fixture-presence state, ordinary message count,
tail message count, and total message count.

The tail depth is stored workload, not a render-count assertion. During the
conversation-detail sample the profiler:

1. navigates to the designated fixture;
2. waits for the existing meaningful-ready terminal and settle policy;
3. records the safe numeric initial message-row count when it can do so without
   reading row text;
4. never clicks Load more or asserts that initial rows equal the seeded depth.

This contract supports both an all-history initial render and a paginated
initial render. A future change in initial-history behavior will show up as a
rendered-row-count and timing change, not as a broken profiler workflow.

### 6.4 Tail workload: one large broadcast

Add:

```text
--large-broadcast-recipients=<0..1000>
```

If omitted, it resolves to `recipientsPerBroadcast`. If provided, it must be
greater than or equal to `recipientsPerBroadcast`. It replaces the ordinary
recipient count for the deterministic terminal broadcast selected by the
`/broadcasts/:broadcastId` resolver.

Recipient IDs remain unique within a broadcast. A requested count greater than
the eligible unique recipient pool resolves down to that pool. The manifest
reports requested, resolved, and clipped counts for both the ordinary and large
broadcast populations. If `broadcasts=0`, the large fixture is absent and its
resolved count is zero.

The total logical recipient count is:

```text
totalRecipientCount =
  (broadcasts - 1) * resolvedRecipientsPerBroadcast
  + resolvedLargeBroadcastRecipients
```

for a non-zero broadcast population. Logical recipients continue to count
toward the total-work cap even though they are embedded in broadcast items.

### 6.5 Native group-text construction

Every native group fixture must satisfy the current production data contract:

- `type` is `group_text`;
- `status` is `group_open`;
- `ai_mode` is `manual`;
- the roster contains typed `ConversationParticipant` objects;
- no `pool_number`, `relay_status`, or relay-only participant-phone field is
  present;
- conversation identity uses the canonical roster-derived identity helper, not
  an arbitrary hand-written ID;
- `last_activity_at`, `created_at`, provider IDs, and message sort keys are
  deterministic and unique for a fixed seed anchor and configuration.

The roster size cycles deterministically through two, three, and four contacts
when enough generated contacts exist, with the existing lean fallbacks used only
when a parent override makes that impossible. Some group rows are unread and
some are read so the All, Unread, and Groups branches have coverage at the
default scale. The native-group messages use the same ordinary density as other
conversations and valid group-message author metadata.

The default scale-1 seed must make all four Inbox filters meaningful:

- All has at least one row;
- Unread has at least one unread row;
- Unknown has at least one unknown row;
- Groups has at least one native `group_text` row.

Explicit zero overrides may legitimately drive any filter to its exact empty
terminal.

### 6.6 Bounds and preflight

The existing `totalItems.max = 250000` guard remains. It is recalculated from
the fully resolved model, including native-group conversation rows, their
messages, the tail-message replacement, embedded ordinary recipients, and the
large-broadcast replacement. No cap is weakened to make a large request pass.

All numeric parsing, parent-child resolution, clipping, fixture-presence
resolution, and total-work validation complete before lifecycle discovery,
port probing, browser startup, or destructive reseed. `--print-config` uses the
same resolver as a real run.

## 7. Command and documentation contract

### 7.1 Hermetic seed arguments

The hermetic target supports and documents:

```text
--scale=N
--contacts=N
--units=N
--placements=N
--tours=N
--conversations=N
--native-groups=N
--messages-per-conversation=N
--long-conversation-messages=N
--broadcasts=N
--recipients-per-broadcast=N
--large-broadcast-recipients=N
```

These join the existing target, sampling, timeout, route-order, baseline,
browser, output, checkpoint, and `--print-config` arguments.

Every seed argument is hermetic-only. Local and hosted-dev reject it with an
actionable error even when the value equals the default; they never ignore a
seed option. Local data may be prepared separately by the human through the
existing import workflow, but `perf:pages -- local` only observes the resulting
stack.

### 7.2 Authoritative help

Add `--help` and `-h` as true early exits. They must not load target state,
probe ports, read credentials, start a browser, create an artifact directory,
or touch a lane.

Help covers every accepted option and, for each numeric seed option, states:

- purpose and unit;
- default or derivation;
- inclusive bound;
- target availability;
- whether scale affects it;
- override and clipping behavior;
- its contribution to the total-work cap.

Help also explains that conversation depth is seeded storage depth and that
the profiler measures only initial passive readiness without clicking Load
more. The examples include:

1. a nominal production-shaped hermetic run at scale 7;
2. a smaller diagnostic run with one deep conversation;
3. a large-broadcast run;
4. `--print-config` before an expensive run;
5. local existing-data and hosted-dev existing-data commands.

`e2e/README.md` contains the same option reference plus the workload formulas,
calibration provenance, privacy statement, target restrictions, and report
interpretation. Non-obvious resolver, clipping, identity, and cap arithmetic
receive concise ASCII-only source comments. Comments do not restate obvious
syntax.

A help/parser parity test mechanically proves that every accepted public option
appears in help and every documented public option is accepted by the parser.

### 7.3 Print-config and manifest

`--print-config` and the artifact manifest use the same structured resolved
configuration. Hermetic output includes at least:

- workload model version;
- scale and all requested overrides;
- every resolved breadth count;
- contact type counts and active/deleted counts;
- `nativeGroups` and `totalConversations`;
- ordinary and tail message counts;
- ordinary and large-broadcast requested/resolved/clipped recipient counts;
- physical item count, logical recipient count, and total item count;
- fixture-presence states and fallback use;
- deterministic anchor.

Local and hosted-dev manifests instead say `dataSource: existing` and omit or
set inapplicable synthetic counts to null. They never guess database totals from
the first rendered page.

## 8. Inbox performance surfaces

### 8.1 Stable surface identity

The registry distinguishes an application route from a measured surface. Add a
stable `surfaceId` (or an equivalent typed field) so multiple surfaces may share
one route component and so query-string order never becomes report identity.
Existing surfaces may derive their identity from the current route key. The four
Inbox identities are fixed:

| Surface ID | Cold URL | Selected filter | Initial API query |
| --- | --- | --- | --- |
| `inbox-all` | `/inbox` | `all` | `GET /api/inbox?filter=all&limit=30` |
| `inbox-unread` | `/inbox?filter=unread` | `unread` | `GET /api/inbox?filter=unread&limit=30` |
| `inbox-unknown` | `/inbox?filter=unknown` | `unknown` | `GET /api/inbox?filter=unknown&limit=30` |
| `inbox-groups` | `/inbox?filter=groups` | `groups` | `GET /api/inbox?filter=groups&limit=30` |

The browser navigation URL never carries `limit`. `PAGE_LIMIT = 30` belongs to
`useInbox`, which supplies it only on the API request. A `cursor` is forbidden
on the initial request because this feature never invokes Load more.

The endpoint contract validates the exact allowlisted filter and numeric limit
internally, not merely the presence of the `filter` and `limit` keys. The fixed
filter enum and limit may appear as safe structured fields in artifacts; raw
query strings and arbitrary query values remain forbidden.

### 8.2 Meaningful-ready terminals

Every successful Inbox terminal requires:

1. the `Inbox filters` tablist;
2. the exact expected tab with `aria-selected=true`;
3. exactly one loaded branch:
   - a `Conversations` list; or
   - that filter's exact empty title;
4. no page-level alert;
5. the existing quiet-window and poller policy after the branch appears.

The empty titles are:

| Filter | Empty title |
| --- | --- |
| All | `No conversations yet` |
| Unread | `You're all caught up` |
| Unknown | `No unknown numbers` |
| Groups | `No group texts yet` |

The backend-pending and error branches are classified results, not successful
ready terminals. The groups-truncated notice may coexist with a successful
terminal and is recorded through the existing truncation evidence path.

### 8.3 Cold and warm actions

Cold samples navigate directly to the exact URL in the table.

Warm samples generalize the current exact-link activation contract into a typed
accessible action:

- `inbox-all` keeps the existing exact Inbox navigation link from its declared
  ready source;
- each filtered surface first loads `/inbox`, waits for the All terminal, then
  clears all sample instrumentation and firewall phase buffers immediately
  before clicking the exact `tab` named Unread, Unknown, or Groups.

The destination sample begins immediately before the activation action. Source
preparation, the All request, and source settling are not charged to the
filtered destination. The selected-tab assertion proves that the click changed
the intended surface. Accessible-name matching is exact for these fixed labels.

The action abstraction remains closed: `link` and `tab` are the only supported
kinds in this change. It does not become a general arbitrary-click facility.

### 8.4 Passive-only evidence

For each Inbox sample, record the following safe structured values in addition
to the existing performance metrics:

- `surfaceId`;
- selected filter enum;
- terminal state (`populated`, `empty`, or closed failure category);
- initial `/api/inbox` request count and the existing templated request timing;
- initial rendered row count, computed from row elements without reading their
  text;
- groups-truncated boolean when observable through the existing safe signal.

The profiler never clicks an Inbox row, its mark-read affordance, the Groups
notice link, Retry, or Load more. The existing write firewall remains installed
and the expected blocked-write set for these passive filter samples is empty.

## 9. Registry, reports, and comparison

The current registry has 28 surfaces. Replacing its one Inbox entry with four
first-class Inbox surfaces yields 31 surfaces. A full-registry self-QA pass has
one cold and one warm sample per surface, so its exact expected cardinality is
62 successful samples when no explicit skip fixture applies.

The report schema and workload model version both change. Comparison is
controlled only when all existing compatibility fields match and the following
new fields also match:

- report schema version;
- registry/surface-set version;
- workload model version;
- all resolved seed breadth, density, and tail values for hermetic runs;
- target data-source class.

An older 28-surface baseline or a baseline from the discarded scale
calibration produces an explicit incompatible-comparison result. The runner
does not silently align `/inbox` with `inbox-all` or compare different workload
shapes as if controlled.

Rankings include all four Inbox surface IDs independently. The existing cold
and warm rankings, medians, request metrics, byte counts, long-task metrics,
DOM metrics, timeout handling, and low-sample labels remain unchanged.

## 10. Privacy and safety invariants

All original profiler privacy and safety requirements remain binding. In
particular:

- no response or request body is collected;
- no message body, preview, contact name, phone number, email address, raw ID,
  cookie, token, or header is written to an artifact or terminal;
- native-group and tail-fixture IDs remain in memory only and are represented
  by stable surface/template labels;
- row counts come from element cardinality, not text extraction;
- the request firewall and CDP escaped-write watchdog cover every measured
  sample;
- `/api/events` remains never-matched by interception;
- local and hosted-dev remain observation-only;
- only profiler-owned hermetic state may be reset or cleaned up;
- a privacy preflight failure creates no staging data, and a post-write defense
  failure follows the existing scrub/quarantine policy.

The new report fields are closed allowlists of integers, booleans, fixed enums,
and version strings. Any arbitrary browser, network, or error string remains
outside the artifact schema.

## 11. Failure behavior

In addition to the original closed failure categories:

- an invalid density or tail relationship fails config validation before lane
  work;
- an over-total resolved workload fails before reseed;
- a missing parent population resolves the designated tail fixture absent and
  the corresponding detail route follows its existing fixture-skip contract;
- a mismatched Inbox filter value, limit, or unexpected initial cursor is an
  endpoint-contract failure, never rewritten into expected evidence;
- a tab that cannot be found exactly is `skipped_fixture_not_navigable` for that
  warm sample and never falls back to a different control;
- a selected tab without a loaded list or exact empty branch times out under the
  existing artifact-preserving path;
- an observed passive write is handled by the existing firewall failure path
  and cannot be added to the empty expectation merely to make self-QA pass.

## 12. Implementation boundaries

The implementation plan may refine file grouping, but the ownership boundaries
are fixed:

- `app/src/lib/seed/performance.ts` owns pure workload resolution, bounds,
  native-group generation, and manifests;
- the dev reseed seam continues to accept only validated performance-seed input
  and remains structurally unavailable outside hermetic local development;
- `e2e/performance/config.ts` owns CLI parsing and target-specific rejection;
- the profiler CLI owns help and early exits but not seed arithmetic;
- `e2e/performance/routes.ts` owns stable surface contracts, exact Inbox
  terminals, endpoint expectations, and typed warm actions;
- collection owns accessible activation and safe DOM cardinality;
- report code owns the schema/version change and closed allowlists;
- `e2e/README.md` owns the durable operator reference;
- no production dashboard behavior or runtime dependency is added.

## 13. Tests and verification

### 13.1 Pure tests

Add or update tests for:

- the new scale bases and deterministic 95/4/1 contact allocation, including
  remainder counts;
- native-group counts, valid `group_text` shapes, canonical identities, roster
  sizes, uniqueness, read/unread coverage, and deterministic messages;
- ordinary and tail message formulas, parent-zero behavior, bounds, and total
  cap accounting;
- ordinary and large-broadcast recipient formulas, uniqueness, clipping,
  parent-zero behavior, and total cap accounting;
- `--native-groups`, `--long-conversation-messages`, and
  `--large-broadcast-recipients` parsing and target restrictions;
- `--help`/`-h` true early exit and parser/help parity;
- `--print-config` equality with the real run resolver;
- local and hosted-dev rejection of every seed option;
- four stable Inbox surface IDs, exact cold URLs, exact API query values, and no
  initial cursor;
- selected-tab plus populated/empty terminal alternatives for every filter;
- warm buffer reset immediately before exact tab activation;
- no Load more or row activation in the action registry;
- safe rendered-row cardinality without text collection;
- comparison incompatibility across old/new schema, registry, workload, or
  seed values;
- exact registry cardinality of 31 and self-QA cardinality of 62;
- privacy allowlists in both directions for every new manifest and sample field.

### 13.2 DynamoDB Local integration

The performance-seed integration suite must execute, not silently self-skip, in
the final feature gates. It proves:

- exact resolved counts at scale 1 and a non-default scale;
- native groups are queryable from the `group_open` byLastActivity partition in
  newest-first order;
- the Inbox Groups branch can return seeded native groups;
- All, Unread, Unknown, and Groups have the intended default-scale branch
  coverage;
- the designated long conversation contains the resolved tail depth in storage;
- the designated broadcast contains the resolved unique recipient count;
- destructive reset remains confined to the injected profiler lane prefix;
- no production or non-owned table name is addressed.

### 13.3 Full profiler self-QA

Run a full hermetic registry self-QA at default scale 1 and require:

- 31 resolved surfaces;
- 62 successful samples, one cold and one warm for each surface;
- all four Inbox surfaces present and independently ranked;
- exact filter/limit contracts passing;
- zero unexpected write tuples and a healthy escaped-write watchdog;
- fixture reachability for the long conversation and large broadcast;
- all original state-preservation, privacy, cleanup, lane-ownership, and report
  assertions passing.

The self-QA does not click Load more and does not assert that the initial
conversation row count equals the stored long-conversation depth.

### 13.4 Repository gates

Before merge-ready handback, sync the latest `main` once as required by
`AGENTS.md`, then run the bare gates from this feature worktree:

```text
npm run typecheck
npm test
npm run e2e
```

Also run the explicit non-skipped DynamoDB Local performance-seed integration
suite and the exact hermetic profiler self-QA command defined by the
implementation plan. Gate output must be captured without piping the command.

## 14. Acceptance criteria

The feature is acceptable when:

1. `--scale=1 --print-config` resolves 100 contacts, 16 units, 21 native groups,
   50 placements, 50 tours, 100 existing conversations, and 10 broadcasts.
2. Contact-type counts resolve to 95 tenants, 4 landlords, and 1 unknown at 100
   contacts.
3. Scale and every override are deterministic, bounded, documented, and fully
   represented in print-config and hermetic manifests.
4. One designated conversation and broadcast can be made deep/wide without
   changing every parent density.
5. All, Unread, Unknown, and Groups are four separately identified, timed, and
   ranked cold/warm surfaces.
6. Filtered warm timing begins immediately before the exact tab click after all
   source evidence has been discarded.
7. No Inbox or conversation-history Load more control is exercised.
8. Seeded conversation depth and observed initial rows are reported as distinct
   concepts, with no equality assertion.
9. Local and hosted-dev reject seed controls and retain their existing-data-only
   guarantee.
10. Old baselines cannot be silently compared with the new workload or surface
    set.
11. All original profiler privacy, firewall, watchdog, ownership, and cleanup
    invariants remain true.
12. Required unit, integration, self-QA, typecheck, test, and e2e gates pass with
    real exit code 0.

## 15. Design gate

This document must pass two independent adversarial reviews and planner
adjudication before it is presented for human approval. No implementation plan
or implementation code is written before that approval.
