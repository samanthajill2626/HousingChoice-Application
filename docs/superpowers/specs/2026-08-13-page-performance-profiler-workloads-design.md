# Page Performance Profiler Workload and Inbox Expansion - Design

- Date: 2026-08-13
- Status: Ready for human review
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

The profiler must make those workloads controllable without turning the four
Inbox-filter samples into workflow runs. Those samples must not open an Inbox
row, click Load more, send a message, mark a row read, or perform any other
application workflow. The separately retained conversation-detail warm sample
still activates its resolved exact Inbox-row link under the existing write
firewall; that detail-navigation contract is outside the four filter samples.

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
| W9 | Interaction | The four Inbox-filter samples use cold URL navigation or exact filter-tab activation only; they never click a row or Load more. The existing conversation-detail warm sample may activate its resolved exact Inbox-row link under the write firewall. |
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
| Existing conversation/message timestamp relationship | `app/src/lib/seed/performance.ts:498-506,565-585` |
| Existing broadcast recipient embedding | `app/src/lib/seed/performance.ts:589-641` |
| Native `group_text` row shape | `app/src/lib/seed/lean.ts:227-246`; `app/src/repos/conversationsRepo.ts:35-59,105-130` |
| Canonical native-group roster identity | `app/src/lib/import/ids.ts:68-76` |
| Inbox filter enum and exact empty copy | `dashboard/src/routes/inbox/inboxFilters.ts:11-34` |
| URL-backed selected tab and accessible tab markup | `dashboard/src/routes/inbox/Inbox.tsx:16-43,53-65` |
| Initial Inbox page limit and request call | `dashboard/src/routes/inbox/useInbox.ts:64,93-166` |
| Browser API query construction | `dashboard/src/api/endpoints.ts:1513-1522` |
| Groups-only native partition and All/Unread/Unknown group behavior | `app/src/routes/inbox.ts:158-180,437-451,700-723,844-887,907-920` |
| Existing registry and current single Inbox surface | `e2e/performance/routes.ts:475-502` |
| Existing public CLI option inventories | `e2e/performance/config.ts:59-97` |
| Lean-first additive performance reset | `app/src/lib/performanceSeed.ts:170-190` |
| Live native-group inbound/outbound sender attribution | `app/src/services/groupSend.ts:578-607`; `app/src/routes/webhooks/twilio.ts:1540-1556,1570-1579`; `dashboard/src/lib/memberAttribution.ts:39-68` |
| App-shell unread badge request and current shell classifier | `dashboard/src/app/UnreadContext.tsx:19-38`; `e2e/performance/collect.ts:109-125` |
| Current pathname-only warm-source preparation/readiness | `e2e/performance/cli.ts:524-564` |
| Current route-key sample, report, and comparison joins | `e2e/performance/types.ts:64-84,148-177`; `e2e/performance/report.ts:264-294`; `e2e/performance/compare.ts:24-30,56-81` |
| Current relay DOM proof and over-broad conversation-link selector | `e2e/performance/cli.ts:572-574`; `e2e/performance/collect.ts:880-917`; `e2e/performance/selfQa.ts:335-349`; `dashboard/src/routes/inbox/InboxRow.tsx:27-39,51-65,89-97` |

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

`nativeGroups` is the exact native-group population in the performance workload,
not an additive count on top of lean. The current performance reset installs the
lean seed first, and lean contains one native group plus its transcript. Inside
the profiler-owned lane only, performance reset removes that lean native-group
conversation and its associated message rows before writing the resolved
performance workload. All other lean fallbacks remain. `nativeGroups=0`
therefore produces an empty `group_open` partition, while `nativeGroups=21`
produces exactly 21 native groups.

The generator applies the 95/4/1 contact-type mix deterministically. For counts
that are not a multiple of 100, landlord and unknown counts are the floors of
4 percent and 1 percent respectively, and tenants receive the remainder. The
existing deterministic deleted-row coverage may remain, but the manifest must
report generated totals and active totals separately so the meaning is not
ambiguous.

Every breadth override is a non-negative safe integer within the existing
entity-count bound, subject to the native-roster feasibility rule in section
6.5. The scale remains an integer from 1 through 100. All resolved values and
feasibility checks participate in preflight before any lane is started or table
is cleared.

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

The stored chronology remains valid at every allowed depth. For a non-empty
designated tail, its oldest message is
`last_activity_at - (longConversationMessages - 1) minutes`. The designated
conversation's `created_at` is the earlier of its existing deterministic
creation instant and that oldest-message instant, so no message predates the
conversation. With zero messages, retain the existing deterministic creation
instant. This timestamp resolution is pure, deterministic, and represented in
the seed rather than performed during measurement.

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
The knob is deliberately forward-compatible storage workload: the profiler does
not promise that increasing it changes current initial-load latency when the
application reads only an initial page.

### 6.4 Tail workload: one large broadcast

Add:

```text
--large-broadcast-recipients=<0..1000>
```

If omitted, it resolves to `recipientsPerBroadcast`. If provided, it must be
greater than or equal to `recipientsPerBroadcast`. It replaces the ordinary
recipient count for the deterministic terminal broadcast selected by the
`/broadcasts/:broadcastId` resolver.

Recipient IDs remain unique within a broadcast. The eligible recipient pool is
defined exactly as the active generated tenant contacts that have a valid
primary phone and the generated consent fields, in deterministic generation
order. Landlords, unknown contacts, and soft-deleted contacts are excluded. If
that pool is empty, the one lean tenant is the explicit fallback pool. Ordinary
and large broadcasts use this same pool and retain the tenant-only audience
filter. A requested count greater than the pool resolves down to the pool size.
The manifest reports pool source and size plus requested, resolved, and clipped
counts for both populations. If `broadcasts=0`, the large fixture is absent and
its resolved count is zero.

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
  deterministic and unique for a fixed seed anchor and configuration;
- every inbound native-group message carries a `relay_sender_key` in the exact
  `phone#<E164>` form for one roster member; its `author` is that member's
  reviewed tenant, landlord, or partner type, with `unknown` as the honest
  fallback;
- every outbound teammate message carries the fixed `relay_sender_key='team'`
  sentinel used by the live writer so the rendered transcript retains Team
  attribution after refetch.

The native-group member pool contains active generated performance contacts
only; the lean contacts are not group-capacity fallbacks. For every feasible
roster size from two through `min(4, activeGeneratedContacts)`, create a lazy
lexicographic combination iterator over generated contact IDs. Select one
combination from each non-exhausted iterator in round-robin size order. When an
iterator is exhausted, remove it from the rotation; continue among the remaining
iterators. Consume at most `nativeGroups` combinations total and never
materialize a complete combination pool. This preserves a deterministic size
mix without reusing the smaller number of large rosters. Every selected roster
combination is unique.
The maximum exact native-group population is therefore:

```text
C(activeGeneratedContacts, 2)
  + C(activeGeneratedContacts, 3)
  + C(activeGeneratedContacts, 4)
```

where terms larger than the member pool are zero and the calculation saturates
safely at the configured entity-count bound. Capacity uses bounded combinatorial
arithmetic, not candidate enumeration. If `nativeGroups` exceeds that capacity,
configuration fails before lifecycle work; it is never clipped and never reuses
a roster. In particular, a positive native-group count with fewer than two
active generated contacts is invalid. Preflight work is O(active contacts plus
requested native groups), excluding the bounded integer arithmetic; it does not
grow with the full combination space. This guarantees canonical ID uniqueness
and exact manifest/storage counts.

The generator computes `nativeGroupMemberSlotCount` as the sum of the selected
roster lengths. It is a logical-workload count even though the participant
objects are embedded in conversation items.

Some group rows are unread and some are read so the All, Unread, and Groups
branches have coverage at the default scale. The native-group messages use the
same ordinary density as other conversations. Their direction, author, and
phone-scoped sender keys follow the explicit rules above.

The default scale-1 seed must make all four Inbox filters meaningful:

- All has at least one row;
- Unread has at least one unread row;
- Unknown has at least one unknown row;
- Groups has at least one native `group_text` row.

Explicit zero overrides may legitimately drive a filter to its exact empty
terminal when all of that filter's contributing populations are zero. In
particular, `nativeGroups=0` makes Groups empty because the lean group is removed
from the performance workload first.

### 6.6 Bounds and preflight

The existing `totalItems.max = 250000` guard remains. It is recalculated from
the fully resolved model, including native-group conversation rows, their
embedded `nativeGroupMemberSlotCount`, their messages, the tail-message
replacement, embedded ordinary recipients, and the large-broadcast replacement.
The manifest separates physical DynamoDB item count, logical native-group member
slots, logical broadcast recipients, and their combined `totalItemCount`. No cap
is weakened to make a large request pass.

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

Both forms are valid and exit 0:

```text
npm run perf:pages -- --help
npm run perf:pages -- hermetic --help
```

The parser recognizes help before requiring or validating a target, so help is
available even when no target is supplied. `-h` is identical.

Help covers every accepted option and, for each numeric seed option, states:

- purpose and unit;
- default or derivation;
- inclusive bound;
- target availability;
- whether scale affects it;
- override and clipping behavior;
- parent/capacity relationships, including the active-contact requirement for
  native groups;
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
- `nativeGroupMemberSlotCount`;
- ordinary and tail message counts;
- ordinary and large-broadcast requested/resolved/clipped recipient counts;
- physical item count, logical native-group member-slot count, logical
  broadcast-recipient count, and total item count;
- fixture-presence states and fallback use;
- deterministic anchor.

Requested overrides are invocation provenance only. Baseline compatibility uses
a closed `comparisonWorkload` projection containing resolved workload model
version, resolved breadth/density/tail counts, native-group member-slot count,
resolved pool sizes, and resolved fallback states. It excludes the anchor, the
presence or spelling of requested overrides, and requested values that clip to
the same stored workload. Therefore
an omitted default and the same explicitly supplied default are compatible, and
two requests that resolve to byte-equivalent clipped workloads are compatible.
The full requested/resolved manifest remains available for diagnosis but is not
deep-compared wholesale.

Local and hosted-dev manifests instead say `dataSource: existing` and omit or
set inapplicable synthetic counts to null. They never guess database totals from
the first rendered page.

## 8. Inbox performance surfaces

### 8.1 Stable surface identity

The registry distinguishes identity, application path, and behavior explicitly.
`RouteDefinition` gains these required fields:

| Field | Meaning | Consumers |
| --- | --- | --- |
| `surfaceId` | Unique stable measurement identity | route ordering, sample token, request-evidence join, report map key, aggregation, ranking, baseline comparison, self-QA cardinality, and artifact allowlist |
| `pathTemplate` | Application route/path contract, such as `/inbox` | cold-path validation, resolver path construction, navigation evidence, and route-template reporting |
| `coldTarget` | Closed union of `{ kind: 'static', path }` or `{ kind: 'resolved' }` | exact direct-load URL for static/query surfaces, or an instruction that the existing entity resolver supplies the in-memory concrete URL |
| `behaviorFamily` | Closed internal behavior discriminator, such as `inbox` | Inbox shell/page request classification and other family-specific collector behavior that currently compares a literal route key; the relay-only proof is explicitly excluded and keyed to `inbox-all` |

The current overloaded `route.key` is removed or narrowed so no consumer can
silently guess which meaning it carries. Existing surfaces use their current
route key as `surfaceId` and keep the current path as `pathTemplate`. Inbox uses
four non-path IDs with the shared `/inbox` path template and `inbox` behavior
family. Its four `coldTarget` values are the exact URLs below. Static cold
resolution uses `coldTarget.path`, never `pathTemplate`; entity detail routes
use `coldTarget.kind='resolved'` and retain their current resolver. Query-string
order never becomes identity. The four fixed entries are:

| Surface ID | Cold URL | Selected filter | Initial API query |
| --- | --- | --- | --- |
| `inbox-all` | `/inbox` | `all` | `GET /api/inbox?filter=all&limit=30` |
| `inbox-unread` | `/inbox?filter=unread` | `unread` | `GET /api/inbox?filter=unread&limit=30` |
| `inbox-unknown` | `/inbox?filter=unknown` | `unknown` | `GET /api/inbox?filter=unknown&limit=30` |
| `inbox-groups` | `/inbox?filter=groups` | `groups` | `GET /api/inbox?filter=groups&limit=30` |

The browser navigation URL never carries `limit`. `PAGE_LIMIT = 30` belongs to
`useInbox`, which supplies it only on the API request. A `cursor` is forbidden
on the initial request because this feature never invokes Load more.

Two different first-party requests share the `/api/inbox` template and must not
be conflated:

| Request class | Fixed safe values | Role |
| --- | --- | --- |
| `inbox_page_all` | `filter=all`, `limit=30`, no cursor | required surface request for `inbox-all` |
| `inbox_page_unread` | `filter=unread`, `limit=30`, no cursor | required surface request for `inbox-unread` |
| `inbox_page_unknown` | `filter=unknown`, `limit=30`, no cursor | required surface request for `inbox-unknown` |
| `inbox_page_groups` | `filter=groups`, `limit=30`, no cursor | required surface request for `inbox-groups` |
| `inbox_badge` | `filter=unread`, `limit=100`, no cursor | required app-shell request on cold samples; background shell refresh if observed during warm samples |

The collector classifies these tuples in memory from the parsed URL before it
reduces evidence. Classification uses `behaviorFamily`, never `surfaceId` or a
literal route-key comparison. The cold `inbox_badge` retains the original
profiler semantics: it is required shell work, contributes to the existing
primary API request/byte totals, advances qualifying readiness, and fails the
sample if its required shell contract fails. On warm samples the already-mounted
shell does not require a new badge request; a later one remains
`background_shell` under the existing policy.

Only the matching `inbox_page_*` request can satisfy the page-specific endpoint
contract or contribute to the new `initialInboxPageRequestCount` and templated
page-request timing. The badge and page contracts are independently satisfiable,
so cold `inbox-unread` requires both unread/100 shell work and unread/30 page
work. General cold API counts and bytes include both, preserving existing metric
semantics; the page-specific fields include only unread/30. This distinction is
load-bearing because the filter value alone is identical.

Artifacts store only the closed request-class enum plus the existing templated
endpoint evidence. They never store raw query strings. An `/api/inbox` request
whose values match none of the closed tuples is an endpoint-contract failure
reduced to a fixed reason; arbitrary values are not persisted.

### 8.2 Meaningful-ready terminals

Every successful Inbox terminal requires:

1. the `Inbox filters` tablist;
2. the exact expected tab with `aria-selected=true`;
3. exactly one loaded branch, enforced as an exclusive-or:
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

The terminal evaluator counts populated and filter-specific empty matches before
returning success. Zero matches continue waiting; more than one produces the
closed `contradictory_terminal` failure and preserves the partial artifact. It
must not return populated merely because that check ran first. The
backend-pending and error branches are classified results, not successful ready
terminals. The groups-truncated notice may coexist with a successful terminal
and is recorded through the existing truncation evidence path.

### 8.3 Cold and warm actions

Cold samples navigate directly to the exact URL in the table.

Warm samples generalize the current exact-link activation contract into a typed
accessible action:

- `inbox-all` keeps the existing exact Inbox navigation link from its declared
  ready source;
- each filtered surface first loads canonical bare `/inbox`, waits for the All
  terminal, then
  clears all sample instrumentation and firewall phase buffers immediately
  before clicking the exact `tab` named Unread, Unknown, or Groups.

Warm-source identity is an exact normalized target, not a pathname-only test.
`WarmSourceContract.path` becomes `target: { path, query }`, where `query` is a
closed exact state: `absent` or a fixed allowlisted key/value map. Normalization
sorts fixed keys but distinguishes absent query from every non-empty query. All
consumers whose source is the Inbox - the three filtered Inbox samples and the
retained conversation-detail warm sample - declare
`{ path: '/inbox', query: 'absent' }` and use the full `inbox-all` terminal as
source readiness, including All selected plus populated/empty XOR. A generic
Inbox heading is insufficient.

The real-page adapter compares the current normalized pathname and query state
to that exact source target. From `/inbox?filter=groups`, Unread, or Unknown it
must navigate back to bare `/inbox`; it cannot return early because the pathname
matches. Source navigation and source-ready checks use the same normalization.
This rule applies regardless of shuffled route order and before the destination
measurement token begins.

The destination sample begins immediately before the activation action. Source
preparation, the All request, and source settling are not charged to the
filtered destination. The selected-tab assertion proves that the click changed
the intended surface. Accessible-name matching is exact for these fixed labels.

The action abstraction remains closed: `link` and `tab` are the only supported
kinds in this change. It does not become a general arbitrary-click facility. A
missing exact fixed tab is the closed `required_action_missing` failure, not
`skipped_fixture_not_navigable`; fixed product chrome is not a data fixture, and
the full self-QA must fail.

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

### 8.5 Relay-only DOM proof

Preserve the existing hermetic proof that every generated relay group expected
on Inbox All is actually rendered, but repair its discriminator before native
groups share the same link family:

- the proof runs exactly once on the successful `surfaceId='inbox-all'` sample;
  it is never gated by `behaviorFamily` and therefore cannot attach to the first
  shuffled Inbox filter;
- within the `Conversations` list, it counts only list items that contain the
  fixed exact kind label `Relay group` and a conversation-detail link;
- it uses the fixed kind label only as a selector and never extracts, records,
  or serializes the surrounding row text;
- rows with the fixed `Group text` label are excluded even though their links
  also begin `/conversations/`;
- the expected value remains the resolved generated `relayGroupCount`, with the
  existing exact equality assertion and no weakening to a lower bound;
- the existing relay query-budget/no-truncation seed guard remains responsible
  for proving every expected relay row belongs on All.

Native groups do not broaden or replace this relay-specific invariant. Their
exact storage count is proven by DynamoDB Local integration, and their rendered
first page is exercised by the separate `inbox-groups` cold/warm surface.

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
- the closed `comparisonWorkload` projection of all resolved seed breadth,
  density, tail, pool, and fallback values for hermetic runs;
- target data-source class.

Requested override syntax and the seed anchor remain in provenance but are not
comparison keys. All sample joins use `surfaceId`; route paths remain separate
diagnostic templates and never serve as unique map keys when multiple surfaces
share them.

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
- the fixed page and badge requests are classified by their exact safe tuples
  before evidence reduction; the badge retains required-cold/background-warm
  shell semantics, while only the page request can satisfy the page-specific
  contract and page-specific metrics;
- a tab that cannot be found exactly is `required_action_missing`, fails the
  warm sample and full self-QA, and never falls back to a different control;
- a selected tab without a loaded list or exact empty branch times out under the
  existing artifact-preserving path;
- simultaneous populated and empty branches are `contradictory_terminal` and
  cannot pass because populated was checked first;
- an observed passive write is handled by the existing firewall failure path
  and cannot be added to the empty expectation merely to make self-QA pass.

## 12. Implementation boundaries

The implementation plan may refine file grouping, but the ownership boundaries
are fixed:

- `app/src/lib/seed/performance.ts` owns pure workload resolution, bounds,
  native-group generation, and manifests;
- `app/src/lib/performanceSeed.ts` owns removal of the lean native-group row and
  its message partition inside the already-owned performance reset, then writes
  the exact resolved native-group population; every deletion remains confined
  to the injected profiler table prefix;
- the dev reseed route/parser and CLI-to-dev payload types are updated for every
  new input and continue to accept only validated performance-seed input while
  remaining structurally unavailable outside hermetic local development;
- `e2e/performance/config.ts` owns CLI parsing and target-specific rejection;
- the profiler CLI owns help and early exits but not seed arithmetic;
- `e2e/performance/routes.ts` owns stable surface contracts, exact Inbox
  terminals, exact safe request classes, endpoint expectations, and typed warm
  actions plus the static/resolved cold-target union and exact warm-source
  target/query contract;
- `e2e/performance/types.ts` carries `surfaceId`, `pathTemplate`, and closed
  behavior/request classes through samples and request evidence without
  duplicating raw URL values;
- `e2e/performance/collect.ts` migrates route ordering, sample tokens, shell
  classification, request attribution, branch evidence, Inbox DOM proofs,
  accessible activation, and safe DOM cardinality off the overloaded route key;
  its relay proof is keyed only to `inbox-all` and uses the fixed relay kind
  label rather than the shared conversation-link prefix;
- readiness/CLI terminal evaluation enforces the Inbox XOR and the fixed-action
  failure contract, and static route resolution navigates to `coldTarget.path`
  rather than deriving a concrete URL from `pathTemplate`;
- the real-page adapter in `e2e/performance/cli.ts` prepares and verifies warm
  sources with exact normalized pathname-plus-query identity; every Inbox source
  consumer requires canonical bare `/inbox` and the full All terminal;
- aggregation, report assembly/sanitization, ranking, comparison, baseline
  parsing, self-QA, contract checkpoints, and their tests migrate every map,
  set, join, allowlist, and compatibility key from route identity to
  `surfaceId`, while retaining `pathTemplate` only as route evidence;
- report code owns the schema/workload/registry version changes, the resolved
  comparison projection, and closed allowlists;
- `e2e/README.md` owns the durable operator reference;
- no production dashboard behavior or runtime dependency is added.

## 13. Tests and verification

### 13.1 Pure tests

Add or update tests for:

- the new scale bases and deterministic 95/4/1 contact allocation, including
  remainder counts;
- native-group counts, valid `group_text` shapes, canonical identities, roster
  sizes, uniqueness, read/unread coverage, phone-scoped inbound sender keys,
  inbound reviewed-type/unknown author mapping, outbound `team` sender keys,
  and deterministic messages;
- native-roster capacity at 0, 1, 2, 3, 4, and default active-contact counts,
  including every requested count from zero through the complete small-pool
  capacities and pre-lifecycle rejection above capacity;
- non-exhausted-size round-robin generation: when the only 3-member or 4-member
  combination is consumed, that size leaves the rotation and remaining unique
  combinations continue without a canonical-ID collision;
- lazy combination selection at scale 1, scale 7, and the 20000-group bound,
  proving at most the requested groups are visited/materialized and capacity is
  computed with saturating arithmetic;
- `nativeGroupMemberSlotCount` equals the sum of generated roster lengths and
  participates in manifest, comparison, and total-work cap arithmetic;
- removal of the lean native-group conversation and all of its messages before
  exact performance group generation, including `nativeGroups=0`;
- ordinary and tail message formulas, parent-zero behavior, bounds, and total
  cap accounting;
- designated-conversation chronology at zero, the seven-day boundary on both
  sides, and the 20000-message maximum, proving no message predates its parent;
- ordinary and large-broadcast recipient formulas, uniqueness, clipping,
  active-generated-tenant pool membership, exclusion of landlord/unknown/deleted
  contacts, lean fallback, parent-zero behavior, and total cap accounting;
- `--native-groups`, `--long-conversation-messages`, and
  `--large-broadcast-recipients` parsing and target restrictions;
- `--help`/`-h` true early exit and parser/help parity;
- `--print-config` equality with the real run resolver;
- local and hosted-dev rejection of every seed option;
- four stable Inbox surface IDs, exact cold URLs, exact API query values, and no
  initial cursor;
- static cold targets preserve the three filtered query URLs while all four
  entries retain the query-free `/inbox` path template; resolved detail cold
  targets still come only from their resolvers;
- full route-key identity migration: unique `surfaceId` map/join/order keys,
  retained path templates, behavior-family special cases, report allowlists,
  self-QA keys, and comparison keys;
- exact distinction between required-cold/background-warm `inbox_badge`
  unread/100 traffic and every unread/30 or sibling page request, including a
  cold `inbox-unread` sample requiring and accounting for both;
- selected-tab plus populated/empty terminal alternatives for every filter;
- terminal XOR rejection when populated and empty branches coexist;
- warm buffer reset immediately before exact tab activation;
- exact warm-source normalization across every permutation where a filtered
  Inbox surface precedes another filtered surface or the conversation-detail
  surface; bare `/inbox` plus the full All terminal is re-established before
  activation/resolution;
- no Load more or row activation in the four Inbox-filter action contracts,
  while the separate conversation-detail exact-row activation remains;
- `required_action_missing` for a missing fixed tab, never a fixture skip;
- safe rendered-row cardinality without text collection;
- relay-only DOM cardinality runs only on `inbox-all`, counts fixed-label Relay
  group rows exactly, excludes native Group text rows sharing the same href
  prefix, and remains correct under shuffled filter order;
- comparison incompatibility across old/new schema, registry, workload, or
  seed values;
- comparison compatibility for omitted versus explicit equal defaults and for
  different requested values that resolve to the same clipped workload;
- exact registry cardinality of 31 and self-QA cardinality of 62;
- privacy allowlists in both directions for every new manifest and sample field.

### 13.2 DynamoDB Local integration

The performance-seed integration suite must execute, not silently self-skip, in
the final feature gates. It proves:

- exact resolved counts at scale 1 and a non-default scale;
- zero lean native-group rows/messages survive the performance-reset cleanup,
  and stored native-group count equals the exact resolved count including zero;
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
- the `inbox-all` relay-only rendered count exactly matching
  `relayGroupCount`, with all native Group text rows excluded from that count;
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
3. The performance reset removes the lean native group and produces exactly the
   resolved native-group count; infeasible roster counts are rejected before
   lifecycle work.
4. Scale and every override are deterministic, bounded, documented, and fully
   represented in print-config and hermetic manifests.
5. One designated conversation and broadcast can be made deep/wide without
   changing every parent density.
6. All, Unread, Unknown, and Groups are four separately identified, timed, and
   ranked cold/warm surfaces.
7. Filtered warm timing begins immediately before the exact tab click after all
   source evidence has been discarded.
8. Every Inbox warm-source consumer re-establishes canonical bare `/inbox` and
   the full All terminal regardless of the prior shuffled surface.
9. The badge unread/100 request retains required cold-shell readiness and
   primary metrics but can never satisfy or inflate the Inbox page-specific
   filter/30 contract or page-only metrics.
10. Missing fixed tabs and contradictory populated/empty branches fail closed.
11. No Inbox or conversation-history Load more control is exercised.
12. Seeded conversation depth and observed initial rows are reported as distinct
   concepts, with no equality assertion.
13. Local and hosted-dev reject seed controls and retain their existing-data-only
   guarantee.
14. Old baselines cannot be silently compared with the new workload or surface
    set.
15. Equivalent resolved workloads compare as controlled regardless of whether a
    default was omitted or explicitly supplied.
16. Native-group member slots are included in the advertised total-work bound.
17. The original exact relay DOM proof remains relay-only, runs on `inbox-all`,
    and cannot count native Group text links.
18. All original profiler privacy, firewall, watchdog, ownership, and cleanup
    invariants remain true.
19. Required unit, integration, self-QA, typecheck, test, and e2e gates pass with
    real exit code 0.

## 15. Design gate

This document must pass two independent adversarial reviews and planner
adjudication before it is presented for human approval. No implementation plan
or implementation code is written before that approval.
