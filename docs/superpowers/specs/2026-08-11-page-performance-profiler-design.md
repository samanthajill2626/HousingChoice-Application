# Page Performance Profiler - Design and Scope

- Date: 2026-08-11
- Status: Ready for human review
- Owner: Cameron Abt
- Branch: `feat/page-performance-profiler`

## 1. Problem

The dashboard has enough real and imported data that some pages now take a long
time to become usable. The clearest example is `/contacts/tenants`, whose
`useContacts` hook walks every 100-record page before leaving its loading state
and whose list renders every matching row at once. The same full-roster hook is
also mounted by several detail and workflow pages.

The repository has a strong Playwright end-to-end harness, request-duration
logging, and deterministic local seeds, but it has no repeatable way to answer:

1. Which dashboard pages are slowest?
2. Is the delay in application startup, API requests, transfer volume, or
   browser rendering?
3. Does a proposed fix improve the target page without regressing another page?
4. Does behavior change as the local dataset grows?
5. Can the same read-only evidence be collected from the hosted dev
   environment without changing its data?

Ad hoc DevTools sessions are useful for one page but do not provide a comparable
route-wide baseline. Lighthouse alone is also not sufficient because this is an
authenticated SPA whose meaningful page-ready point often occurs after several
API calls and after the browser load event.

## 2. Goal

Build an on-demand Chromium profiler that measures every implemented read-only
staff navigation destination plus representative read-oriented detail pages,
ranks the worst offenders, emits privacy-safe agent-readable evidence, and
compares a later run to a saved baseline.

The profiler supports three explicit target modes:

- a profiler-owned hermetic e2e lane with adjustable synthetic scale;
- the human's loopback `http://localhost:5174` local stack containing imported
  data, after that stack proves it is hermetic local mode;
- the hosted cloud dev environment, after interactive authentication and an
  authenticated environment check proves `env === "dev"`.

Manual local and hosted-dev runs are observation-only. They never seed, reseed,
import, or intentionally change application data.

AGENTS.md ("UI testing and verification") forbids agents from testing or
investigating against the human's live `:5174` / `:8080` ports, including raw
API calls and dev-login, and forbids Playwright outside the e2e workspace. The
local target intentionally drives exactly that stack, so the two are reconciled
explicitly instead of left in conflict:

- The `local` and `hosted-dev` targets are human-invoked only. An agent never
  runs them autonomously; an agent may run them only on the human's explicit
  per-run instruction naming the target.
- This change amends AGENTS.md in the same branch with a narrow carve-out
  naming `npm run perf:pages -- local` and `-- hosted-dev` as the sole
  human-invoked exceptions. If the human declines that amendment, D3 must be
  re-decided and the local target removed.
- Agent self-QA and the profiler smoke use the hermetic target only.

## 3. Success criteria

1. `npm run perf:pages -- hermetic --scale=10` starts an isolated e2e lane,
   replaces that lane's data with a deterministic performance dataset, profiles
   the route registry, writes a report, and tears down only the stack it started.
2. The scale factor grows contacts, properties, placements, tours,
   conversations, messages, and broadcasts proportionally. Per-entity CLI
   overrides can replace the derived counts.
3. `npm run perf:pages -- local --base-url=http://localhost:5174` refuses unless
   `/__dev/ping` proves a local stack with an `hc-local-` table prefix. It uses an
   existing admin dev user and refuses to auto-provision one.
4. `npm run perf:pages -- hosted-dev --base-url=https://... --headed` opens an
   interactive login browser, keeps the resulting authentication state in memory
   only, requires an admin session, and refuses unless `/api/system/flags`
   returns `env: "dev"`.
5. After target verification and authentication, a request firewall blocks every
   `POST`, `PUT`, `PATCH`, and `DELETE` attempted by a measured page. A blocked
   write is recorded in sanitized form and never reaches the server.
6. The runner measures three cold and three warm samples per route by default.
   Both repeat counts are configurable.
7. Routes are ranked separately by cold and warm median meaningful-ready time.
   The report also includes request counts, transfer bytes, request timing,
   long-task time, paint metrics where available, and DOM size.
8. The output contains no response bodies, request bodies, cookies,
   authorization material, headers, contact names, phone numbers, email
   addresses, query values, raw entity IDs, screenshots, HAR files, or raw
   browser traces.
9. A saved result can be supplied as a baseline. The next report shows absolute
   and percentage changes by route and mode without failing the command because
   of a performance threshold.
10. The profiler is on-demand only. It is not a CI job and not a required merge
    gate.

## 4. Locked decisions

| ID | Decision | Choice |
| --- | --- | --- |
| D1 | Isolation | Build on `feat/page-performance-profiler` in `W:\tmp\page-performance-profiler`. |
| D2 | Synthetic data | Coordinated scale factor with per-entity overrides. |
| D3 | Real imported data | Profile an already-running hermetic local `:5174` stack without seeding or importing. |
| D4 | Hosted data | Profile existing hosted-dev data only; never add synthetic data there. |
| D5 | Route scope | Implemented read-only staff navigation destinations, implemented secondary views, settings tabs, and one representative contact/property/tour/placement/conversation/broadcast-results detail. |
| D6 | Interaction scope | Navigation and observation only; no workflow controls are exercised. |
| D7 | Page modes | Cold direct loads plus warm in-app navigations. |
| D8 | Evidence | Privacy-safe performance evidence only. |
| D9 | Hosted safety | Interactive in-memory auth, `env === "dev"` proof, and a strict write firewall. |
| D10 | Comparison | Built-in baseline comparison. |
| D11 | Automation | On-demand only; no CI or enforced budget. |
| D12 | Dependencies | Use Node, TypeScript/tsx, and the existing Playwright dependency; add no runtime dependency. |

## 5. Command surface

The root command is:

```text
npm run perf:pages -- <target> [options]
```

### 5.1 Hermetic target

```text
npm run perf:pages -- hermetic --scale=10
```

Supported scale options:

```text
--scale=<positive integer>
--contacts=<non-negative integer>
--units=<non-negative integer>
--placements=<non-negative integer>
--tours=<non-negative integer>
--conversations=<non-negative integer>
--messages-per-conversation=<non-negative integer>
--broadcasts=<non-negative integer>
```

The scale factor supplies every count not explicitly overridden. The resolved
counts and estimated total item count are printed before seeding and written to
the run manifest. Invalid, negative, non-integer, over-cap, or over-total
configurations fail before any table is cleared.

Hermetic mode owns its lifecycle:

1. Refuse if this worktree has a live e2e session of either kind - an
   interactive `e2e:session` or a full-suite run. Both write
   `e2e/.artifacts/session.pid` through the same launcher, so the profiler
   performs its own pre-flight check: if `session.pid` exists and its recorded
   pid is alive, refuse. The check is the profiler's own. It never delegates to
   the launcher, because `scripts/e2e-session.mjs` self-heals by killing a live
   recorded launcher tree before claiming the pid file - the opposite of
   refusing.
2. Resolve a free lane with the existing lane resolver. Lane 0 is impossible.
3. Start `scripts/e2e-session.mjs` for that exact lane, spawned attached so the
   launcher's parent-death watch tears the stack down if the profiler process
   dies.
4. Confirm `/__dev/ping`, including the expected per-lane table prefix and launch
   commit.
5. Call the new performance reseed seam with the validated scale configuration.
6. Authenticate as the seeded admin after the reseed.
7. Enable the write firewall and run the profile.
8. In `finally`, stop only the session started by this command and preserve the
   profiler artifacts.

If startup or profiling fails, cleanup is still attempted. A failed cleanup is
reported with the exact lane and normal `npm run e2e:stop` recovery command; the
runner never kills a process selected only by a broad process name.

Known limitation, stated rather than pretended away: the pre-flight refusal
protects only one direction. A full suite or interactive session started later
in the same worktree will reap the profiler's launcher through the launcher's
own self-heal. The guard against that remains the human's serialization of
runs, and the docs say so.

### 5.2 Manual local target

```text
npm run perf:pages -- local --base-url=http://localhost:5174
```

Local mode accepts only loopback hostnames and port 5174. Before authentication
it requires:

- `GET /__dev/ping` returns HTTP 200 and `{ dev: true }`;
- `tablePrefix` is exactly `hc-local-`, not a deployed prefix and not an e2e
  lane prefix;
- no seed or reseed option is present.

The profiler calls dev-login with an explicit existing-user-only contract:
`POST /auth/dev-login` gains an optional boolean body field `require_existing`.
When true, the route returns a non-success response if the user does not exist
instead of inviting or provisioning it. Absent or false preserves today's
auto-provision behavior for every other caller (e2e fixtures, the dashboard
dev-login button). The profiler always sends `require_existing: true`.

The login identity defaults to `founder@example.com` and can be overridden with
`--login-email=<address>` under the same existing-user-only and admin-session
requirements, because an imported local stack does not necessarily carry the
seed personas.

After login, the write firewall is installed before any measured navigation.
The profiler never invokes the import scripts. The human owns importing the
desired dataset before starting this command.

### 5.3 Hosted-dev target

```text
npm run perf:pages -- hosted-dev --base-url=https://dev.example.test --headed
```

Hosted-dev mode requires HTTPS, a headed interactive browser, and no seed-related
options. It opens the target login page and waits up to a configurable timeout for
the human to complete normal authentication. Once `/auth/me` reports an admin
session, the runner keeps Playwright's storage-state object in process memory and
closes the login page. It never writes storage state to disk.

Before measurement, an authenticated `GET /api/system/flags` must return
`env: "dev"`. `local`, `prod`, missing, unauthorized, or any other value is a hard
refusal. The check intentionally requires an admin because the selected route
scope includes admin-only settings pages.

The write firewall is installed only after interactive authentication and the
environment check. Authentication traffic is outside the measured samples.

## 6. Read-only request firewall

Navigation is not inherently read-only in the current dashboard. At minimum:

- contact detail marks the contact's communications read on view;
- relay conversation detail marks the conversation read on view;
- visible communication tabs on tour and placement detail can mark a person or
  group read;
- opening an inbox or email row fires a mark-read from the row's own click
  handler, so the warm click that navigates to a conversation detail is itself
  a write, with an optimistic patch that rolls back inside the destination's
  measured window when the write is blocked.

Therefore the profiler must enforce read-only behavior at the browser context,
not by assuming every page is passive.

For every measured context:

- interception is scoped, not blanket: only first-party API-class paths
  (`/api/**`, `/auth/**`, `/__dev/**`) are intercepted, so static-asset and
  Vite module traffic never pays a driver round trip;
- a named never-intercepted list excludes streaming endpoints - at minimum
  `/api/events` - so no permanently open streamed response is ever routed
  through the interceptor;
- on intercepted paths, allow `GET`, `HEAD`, and `OPTIONS`, and block `POST`,
  `PUT`, `PATCH`, and `DELETE` before the request reaches the network;
- the interception scope is a named constant recorded in the manifest and is
  part of baseline comparability;
- block service workers as one-line defense in depth - no service worker is
  registered in the dashboard today, so this guards a future worker, not a
  live threat;
- record the attempted method, a sanitized endpoint template, and a phase tag
  (`source_click` or `destination_mount`) so a write fired by the warm click on
  the source page is distinguishable from the destination's own mount write;
- never record the body, headers, cookies, or raw URL;
- make blocked requests visible in the route result and top-level report;
- fail the run if a method outside the known HTTP method set is observed on an
  intercepted path.

Interception has a per-request cost even when scoped. The scoped design exists
so that the cost lands only on API-class requests and is identical across
routes, repeats, and baselines. The end-to-end proof that no write escapes
remains the hermetic smoke assertion that the fake server observed no write.

A blocked mount-time mark-read is expected evidence, not a profiler failure. The
route remains measurable when the application treats the failed mark-read as
best effort. If a blocked write prevents a route from reaching its ready state,
that route is reported as `blocked_write_dependency` rather than silently timed
out or permitting the write.

The firewall applies to hermetic measurements too. This keeps all repeats
read-only and comparable after the synthetic dataset has been created.

## 7. Route registry

Routes are declared in one typed registry. Each entry owns:

- a stable report key and display label;
- a route template with no entity ID;
- required role;
- cold URL resolver;
- warm navigation source and accessibility-first link locator;
- meaningful-ready contract;
- API endpoint templates expected during the load;
- whether the route is static or needs a read-only representative entity
  resolver;
- a `scale_bearing` flag: whether the route's data surface grows with the
  generated dataset or is fixed-fixture (backed only by tables the generator
  never writes). The flag is emitted into every ranking row so a reader can
  tell a route that scaled flat from a route that was never varied.

The initial registry includes:

### 7.1 Main and secondary staff pages

- `/`
- `/contacts`
- `/contacts/tenants`
- `/contacts/landlords`
- `/contacts/unknown`
- `/contacts/deleted`
- `/listings`
- `/listings/deleted`
- `/tours`
- `/tours/closed`
- `/placements`
- `/inbox`
- `/email`
- `/email/quarantine`
- `/broadcasts`

### 7.2 Settings tabs

- `/settings/team`
- `/settings/templates`
- `/settings/notifications`
- `/settings/voice`
- `/settings/system`
- `/settings/ai-runs`
- `/settings/numbers`

The redirect-only `/settings` path is not ranked separately because it only
redirects to a role-dependent tab.

Two settings-specific caveats the registry encodes explicitly:

- The admin default tab is `/settings/team`, so the footer Settings link lands
  there via the redirect. `/settings/team` therefore declares an explicit warm
  source: arrive on a different settings tab (`/settings/templates`) and click
  the Team tab link. The footer-link redirect is never used as the Team warm
  click, because clicking a link that redirects to an already-mounting tab
  measures the redirect, not the tab.
- `/settings/system` renders alarm and error panels that short-circuit to an
  unavailable state on local stacks, so hermetic and hosted-dev measure
  structurally different pages under the same route key. Its registry entry and
  report rows carry a target-structural note.

### 7.3 Representative detail pages

- `/contacts/:contactId`
- `/listings/:unitId`
- `/tours/:tourId`
- `/placements/:placementId`
- `/conversations/:conversationId`
- `/broadcasts/:broadcastId`

Entity resolvers use authenticated GET requests only. Each detail registry entry
declares its exact source list, source filters and sort, eligibility predicate,
pagination behavior, and accessible link role. The resolver pages through its
declared source with authenticated GET requests, selects the first row that
satisfies the eligibility predicate under the declared sort, keeps the raw ID in
memory only, and derives both the cold URL and the warm-link href from that same
ID. The warm
locator uses the accessible link role plus the resolved href; it never uses a
person's name, phone number, or other domain text. If the exact link cannot be
exposed, the route is `skipped_fixture_not_navigable`; it never substitutes a
different row.

`/conversations/:conversationId` accepts only a readable `relay_group`, because a
1:1 conversation redirects to contact detail. Its source is the relay-group row in
`/inbox`. `/broadcasts/:broadcastId` accepts only a terminal `sent` or `failed`
broadcast whose list row links to results and whose embedded recipients make the
results surface representative. A `sending` broadcast is ineligible because its
two-second polling cannot satisfy the comparable quiet-window contract. External
targets without an eligible record use
`skipped_no_fixture`. The report key always remains the route template, and no raw
ID is emitted.

The inbox and broadcast lists render only their first page behind a Load more
control, and D6 forbids clicking it - an API-side page walk does not put a row
into the DOM. Section 11's seed contract therefore guarantees the eligible
relay-group and terminal-broadcast fixtures sort onto the first page of those
sources; without that guarantee the two routes would silently degrade to
`skipped_fixture_not_navigable` as scale rises.

The catch-all not-found route, public pages, create forms, broadcast
composition, and workflow actions are outside the initial registry. Implemented read-only broadcast results
are included.

## 8. Measurement protocol

### 8.1 Default samples

- cold repeats: 3;
- warm repeats: 3;
- Chromium desktop viewport from the existing Playwright desktop configuration;
- no artificial CPU or network throttle;
- one route at a time and one browser worker;
- deterministic route ordering with the order written to the manifest;
- one discarded warmup pass before any counted sample on hermetic and local
  targets: the first registry route is loaded cold and thrown away so the Vite
  dev server's process-global transform and pre-bundle caches are warm before
  measurement begins. The warmup is recorded in the manifest. Hosted-dev serves
  built assets and skips it.

Both repeat counts are configurable positive integers. A run with fewer than
three samples is allowed for smoke testing but is labeled `low_sample_count`.

### 8.2 Cold sample

Each cold sample creates a fresh browser context from the in-memory authenticated
state, with empty HTTP cache and service workers blocked. Timing begins immediately
before direct navigation to the resolved route and ends at the route's meaningful
ready point. The context closes after evidence collection.

Cold evidence can include Navigation Timing, FCP, and LCP. A metric absent from
Chromium for that page is stored as `null`, never synthesized.

### 8.3 Warm sample

Warm samples reuse one authenticated browser context and the application shell.
For a navigation destination or settings tab, the runner uses its real accessible
link. For a detail route, the runner first reaches the declared source list,
applies the declared source state, pages by GET when necessary, and exposes the
exact accessible row link bound to the resolver's in-memory ID. Timing and request
collection start immediately before that exact click, so preparation traffic is
not attributed to the destination. A missing or filtered-out link produces
`skipped_fixture_not_navigable`, not a click on the first available row.

Before every warm sample, the source page reaches its own ready state. Source
preparation has its own timeout, separate from the destination ready timeout; a
source that cannot reach ready inside it produces `skipped_source_not_ready` for
that sample rather than misattributing the failure to the destination route.
Reaching a source list's ready state can require its full capped page walk, so
the preparation budget scales with the resolved dataset and the docs publish a
rough expected wall-clock per scale.

The warm click itself can fire a source-side mark-read write (section 6). Its
blocked-write evidence is tagged `source_click`, and for those routes the
optimistic-rollback re-render is acknowledged as landing inside the
destination's measured window; cold and warm evidence for such routes is not
write-for-write identical, and the report says so rather than hiding it.

The runner rotates route order between repeats to reduce one fixed cache-order
bias. The exact order is deterministic for a given run seed and is recorded.

### 8.4 Meaningful ready

`load` and `networkidle` are not page-ready signals for this application. The app
holds `/api/events` open and many pages render a heading before their data is usable.

A route is ready when all of these are true:

1. the expected URL template matches;
2. the route-specific primary heading or region is visible;
3. the route-specific data surface has reached one of its terminal states:
   populated, empty, or visible error;
4. no tracked non-stream GET request started by the route is still in flight;
5. the tracked requests have remained quiet for the settle window - a named
   constant (default 500 ms) recorded in the manifest.

`readyMs` stamps at quiescence start: the timestamp of the last qualifying
event (the final tracked response or the terminal UI state, whichever is
later), confirmed retroactively once the settle window elapses quiet. The
settle window confirms readiness; it is never added to `readyMs`.

The event stream, known long polling, and third-party authentication traffic are
excluded from request quiescence. Each exclusion is named in code; there is no
blanket `networkidle` fallback.

If the ready timeout expires, the sample is retained as `timeout` with its
sanitized request evidence and visible terminal state. Failed routes remain in the
ranking appendix and are never silently dropped.

## 9. Collected evidence

The primary metric is `readyMs`.

Per sample, collect when available:

- target mode, route key, cold/warm mode, repeat index, and status;
- `readyMs`;
- navigation TTFB, DOMContentLoaded, and load time for cold samples;
- FCP and LCP for cold samples;
- total long-task duration, maximum long task, and long-task count;
- DOM element count at ready;
- request count by resource class;
- API request count;
- API request start offset, duration, TTFB, status, transfer bytes, and sanitized
  endpoint template;
- total API transfer bytes and total resource transfer bytes;
- blocked-write count and sanitized method/template/phase-tag triples;
- console error and warning counts with message content omitted and only a
  stable category; the known list-hook page-cap warnings map to a
  `client_truncated` category;
- a `client_truncated` flag when any tracked list hook reported its page cap
  during the sample, so a metric plateau caused by client-side truncation
  (contacts/listings cap at 40 pages x 100, placements at 50) is never
  mistaken for the app scaling well;
- readiness or skip reason.

Chromium DevTools Protocol network events provide encoded transfer size without
reading response bodies. The profiler never calls `response.body()` merely to
calculate size.

The summary reports median, minimum, and maximum for the default repeat count.
P95 is scoped per route-and-mode pair and is reported only when that pair has at
least 20 successful samples; with fewer it is `null` rather than a misleading
percentile. At the default repeat counts it is therefore always `null` by
design; the field exists for deliberate elevated-repeat runs.

Worst-offender tables rank cold and warm routes separately by median `readyMs`.
Secondary tables rank API transfer bytes, API request count, long-task duration,
and DOM size. Every ranking row carries the route's `scale_bearing` flag and its
`client_truncated` status, so a flat curve past the client page caps or a
never-varied fixed-fixture route cannot be read as the app scaling well.

## 10. Privacy and redaction

The output is designed to be safe for review by an agent that should not receive
the imported contact dataset.

### 10.1 Never collected

- response or request bodies;
- HTTP headers;
- cookies or storage state;
- screenshots, videos, HAR, or raw Playwright traces;
- DOM text;
- console message text;
- raw URLs or query values;
- names, phone numbers, email addresses, notes, or other domain values;
- raw entity IDs.

### 10.2 URL sanitization

Known application requests map through a typed endpoint-template registry. Dynamic
segments become semantic placeholders such as `:contactId`, `:unitId`, and
`:conversationId`. Query strings retain sorted parameter names only, for example:

```text
/api/contacts?cursor&deleted&limit&type
```

No query value is retained. An unmatched `/api` URL is reduced to the HTTP method,
resource class, segment count, and `unmatched_api`; it is not emitted verbatim.
Static assets retain only a non-sensitive asset class and transfer size. External
origins are reduced to `first_party` or `third_party`; hostnames and paths are not
stored.

The redactor has adversarial tests for E.164 phone values, email addresses, URL
encoded values, opaque cursor values, UUIDs, arbitrary slug-like IDs, and unknown
endpoints. A final artifact scan fails the run if common phone/email/cookie/token
patterns are found.

### 10.3 Artifact location and files

Every run writes under the already-gitignored directory:

```text
e2e/.artifacts/performance/<run-id>/
```

Files:

- `report.md` - ranked human and agent-readable findings;
- `summary.json` - versioned machine-readable run, aggregates, and samples;
- `requests.jsonl` - sanitized request waterfall rows;
- `comparison.md` and `comparison.json` when a baseline is supplied.

The run ID contains a timestamp and short random suffix, not a user or entity ID.

## 11. Synthetic performance dataset

Synthetic scale is available only through a structurally dev-only route and only
against the same hermetic-prefix/local-endpoint guard as `resetLocalData`.

### 11.1 Base scale

At scale 1, generated additions are:

| Entity | Count |
| --- | ---: |
| contacts | 100 |
| units | 25 |
| placements | 50 |
| tours | 50 |
| conversations | 100 |
| messages per conversation | 10 |
| broadcasts | 10 |

The lean seed remains present for stable admin identities and canonical route
fixtures. Generated records use a reserved `perf-` ID namespace and fake `+1555`
numbers. Values are deterministic for the resolved configuration and contain no
real data.

Per-entity overrides replace, rather than add to, the scale-derived generated
count. Referential links use the deterministic generated tenant, landlord, or unit
pool when that required parent kind is non-empty and otherwise use the named lean
fallback in section 11.2. Statuses, contact types, deleted records, tour states,
placement stages, conversation kinds, unread counts, and broadcast states are
distributed by fixed ratios so every list view has representative rows.

At least one eligible detail fixture of each required kind is guaranteed whenever
the corresponding count is non-zero. When an override intentionally sets a kind to
zero, affected detail routes are honestly skipped.

Fixtures whose declared warm source paginates behind a Load more control get a
first-page sort guarantee: the guaranteed eligible relay-group conversation
carries the newest `last_activity_at` among generated conversations, and the
guaranteed terminal broadcast the newest `created_at` among generated
broadcasts, so each sorts onto the first rendered page of its declared source
(`/inbox` pages at 30, the broadcast list at 50) at every scale.

### 11.2 Physical table and reader manifest

The destructive boundary and generated additions are separate contracts:

- the existing reset clears every base in `TABLES` plus the dev outbox, restores
  the complete lean seed, and stamps the lean admin identity;
- performance generation then appends rows to exactly `contacts`, `units`,
  `placements`, `tours`, `conversations`, `messages`, and `broadcasts`;
- it does not append generated rows to any other physical table;
- auxiliary readers backed by settings, users, unmatched email, audit/activity,
  reminders, deadlines, nudges, pool numbers, or other tables must either receive
  their lean fixture or return their existing valid empty state. Empty auxiliary
  state is asserted and is not treated as a seed failure.

Generated rows must satisfy this minimum physical/query contract:

| Table | Required keys and indexed fields | Relationships and readers |
| --- | --- | --- |
| `contacts` | `contactId`; fake unique `phone`; `type`; `status`; optional `deleted_at` | Ratios cover tenant, landlord, unknown, and deleted queries through `byTypeStatus`; IDs are referenced by units, tours, placements, conversations, and messages. |
| `units` | `unitId`; `landlordId`; `status` | Landlords resolve through the generated-or-lean policy; list/status, landlord, detail, tour, and placement readers return valid units. |
| `placements` | `placementId`; `tenantId`; `unitId`; `stage`; required timestamps | Tenant/unit references resolve; stage/list and detail/roster readers work. Deadlines, nudges, and history may be valid empty auxiliary results. |
| `tours` | `tourId`; `tenantId`; `unitId`; `status`; `createdAt`; `_schedPartition` and `scheduledAt` when scheduled | Status, scheduled-range, tenant, unit, list, roster, and detail readers work. Activity and reminder readers may be valid empty auxiliary results. |
| `conversations` | `conversationId`; `type`; `status`; `last_activity_at`; 1:1 participant fields; `relay_status`, pool/owner/roster fields for relay groups | Inbox and detail readers work; at least one open readable `relay_group` is guaranteed when conversations are non-zero. |
| `messages` | `conversationId`; unique sortable `tsMsgId`; required direction/channel/timestamp fields | Every row belongs to a generated conversation and is readable through the thread/timeline query without pointer or provider side effects. |
| `broadcasts` | `broadcastId`; `_listPartition = "broadcasts"`; `created_at`; `status`; embedded stats and recipients | List/status queries work; when broadcasts are non-zero, at least one terminal `sent` or `failed` fixture has bounded embedded recipient results and an accessible results link. |

Independent zero overrides follow one fixed relation policy:

- tenant references use generated tenants when present, otherwise lean
  `contact-tenant-0001`;
- landlord references use generated landlords when present, otherwise lean
  `contact-landlord-0001`;
- unit references use generated units when present, otherwise lean `unit-0001`;
- message rows are generated only for generated conversations, so
  `conversations=0` resolves the generated message total to zero;
- conversation rosters and broadcast recipients use the tenant/landlord rules
  above.

The count manifest records requested counts, resolved counts, and symbolic
fallback keys such as `lean_tenant`, never fallback raw IDs. Tests cover every
zero/non-zero parent-child vector. A fallback changes only references, never the
requested generated entity count.

The generator owns explicit TypeScript row builders per table rather than casting
arbitrary objects into a generic map. Tests prove every contractual key/index
attribute, relationship, list partition, detail fixture, and intentional empty
auxiliary result. This prevents the profiler from mistaking malformed seed data for
page performance.

### 11.3 Seed implementation

A pure generator returns a table-to-items map plus a count manifest. A bounded
batch writer writes 25-item batches and retries unprocessed items. It does not call
business routes, enqueue jobs, send messages, or create media.

The new dev-only performance reseed route:

1. validates and resolves the entire configuration before clearing anything;
2. calls the existing hermetic reset with the lean profile;
3. appends generated items with the batch writer;
4. returns only generated/resolved counts and no row data;
5. is absent from deployed environments through the existing dev-router gates;
6. repeats the local-endpoint and `hc-local-`/per-lane-prefix guard at the mutation
   boundary.

The route accepts only a per-lane prefix for profiler-owned hermetic mode. It
refuses lane 0 with its own explicit check so the profiler cannot erase the
human's imported local dataset - the existing `resetLocalData` prefix guard is
not sufficient for this, because its lane regex admits `hc-local-0-`.

The profiler calls the route directly on the app port, not through the Vite
proxy, with an explicit HTTP timeout scaled by the resolved item count. A
scale-100 reseed performs on the order of ten thousand sequential 25-item batch
writes on top of a full multi-table clear, so the docs publish a rough expected
reseed wall-clock per scale and the runner must not misreport a long reseed as
a hang.

### 11.4 Bounds

The initial safety bounds are:

- scale: greater than 0 and at most 100;
- contacts, units, placements, tours, conversations, broadcasts: 0 through
  20,000 each;
- messages per conversation: 0 through 100;
- recipients per broadcast: 0 through 1,000 - deliberately below the
  repository's `MAX_BROADCAST_RECIPIENTS` (1,500) and sized so the embedded
  recipients map stays well under the 400KB DynamoDB item ceiling, because
  broadcast recipients live on the broadcast item itself;
- resolved generated items across every table: at most 250,000, with embedded
  broadcast recipients counted toward the resolved total.

The total-item cap wins over individual caps. The validator reports the resolved
count that exceeded the cap and runs entirely before any table is cleared, so an
over-size embedded-recipients configuration fails before the lane loses data,
not mid-write after the reset. Bounds are constants covered by tests, not hidden
magic in CLI parsing.

## 12. Baseline comparison

The runner accepts:

```text
--baseline=<path-to-summary.json>
```

Comparison requires the same schema version and route key. It reports target mode,
git commit, scale/count manifest, browser version, OS, Node version, repeat counts,
and timestamps so a reviewer can judge whether two runs are comparable.

When target kind, scale manifest, route set, browser major version, interception
scope, or settle window differs, the comparison is labeled `environment_mismatch`
and lists the mismatches. It still computes route deltas but never presents them
as controlled proof.

For each matching route and cold/warm mode, compare median:

- meaningful-ready time;
- API request count;
- API transfer bytes;
- total long-task duration;
- DOM element count.

Both absolute and percentage deltas are emitted. Zero baselines use an explicit
`percent: null` rule. Added, removed, skipped, timed-out, and failed routes are
listed separately.

There is no pass/fail performance budget in this feature. The command exits nonzero
for invalid configuration, unsafe target, authentication failure, profiler failure,
or privacy scan failure, not for a slower metric.

## 13. Architecture and repository placement

Expected implementation areas:

```text
e2e/performance/
  cli.ts
  targets.ts
  auth.ts
  firewall.ts
  routes.ts
  readiness.ts
  collect.ts
  redact.ts
  aggregate.ts
  compare.ts
  report.ts
  types.ts
  *.test.ts

app/src/lib/seed/performance.ts
app/src/lib/performanceSeed.ts
app/src/routes/dev.ts
app/test/performanceSeed.test.ts
app/test/devRoutes.test.ts or the existing dev-route test surface
e2e/tsconfig.json
e2e/package.json
package.json
```

The exact split may change in the plan, but the boundaries do not:

- seed generation and validation are pure and backend-owned;
- destructive performance reseed is dev-router-only and guarded locally;
- target verification, browser lifecycle, collection, redaction, aggregation,
  comparison, and reports are e2e-workspace developer tooling;
- the root package exposes the one on-demand command;
- no production runtime code path imports Playwright or performance runner code.

The e2e TypeScript configuration includes performance sources: `e2e/tsconfig.json`
has an explicit `include` allowlist, so it gains a `performance/**/*.ts` entry -
without it the `npm run typecheck` gate would silently skip every new source.
`e2e/package.json` adds `"test": "tsx --test performance/"` - the directory form,
not a shell glob, because npm scripts run through `cmd.exe` on Windows and a glob
that expands to nothing would exit green having run zero tests. The plan must
prove a non-zero executed-test count on Windows; a zero-test run fails the gate.
The tests use `node:test` through the already-hoisted `tsx` rather than adding
Vitest to the e2e workspace, keeping D12's no-new-dependency rule. Root
`npm test` already runs workspace test scripts with `--if-present`, so it
executes these modules without a new dependency. The root package also adds only
the on-demand `perf:pages` command.

## 14. Failure behavior

- Unsafe target proof: refuse before measured navigation.
- Local dev user absent: refuse without provisioning.
- Hosted login timeout or non-admin: refuse with an actionable message.
- Hosted environment not exactly `dev`: refuse.
- Existing same-worktree e2e session, interactive or full-suite: refuse via the
  profiler's own `session.pid` liveness check before spawning anything; never
  delegate the check to the launcher, whose self-heal kills a live recorded
  launcher rather than refusing.
- Missing representative entity: skip only that route and continue.
- Warm source not ready within its preparation budget:
  `skipped_source_not_ready` for that sample, never a timeout attributed to the
  destination route.
- Route timeout: retain evidence and continue unless the browser is unhealthy.
- Browser crash: finish the partial report, exit nonzero, and run owned-session
  cleanup.
- Blocked write: record and continue when the page reaches ready; otherwise classify
  `blocked_write_dependency`.
- Unknown API URL: redact to `unmatched_api`, flag it for registry maintenance, and
  continue.
- Artifact privacy scan failure: quarantine the output under the gitignored run
  directory, print only filenames and reason categories, and exit nonzero.
- Baseline parse/schema failure: profile can still finish, but comparison fails and
  the process exits nonzero.

Every non-success path avoids printing sensitive raw URLs, response text, or console
messages to the terminal.

## 15. Tests and verification

### 15.1 Pure unit tests

- CLI target and numeric option parsing, including conflicting and forbidden
  options.
- local target loopback/port/ping/prefix checks.
- hosted HTTPS, admin, and exact `env === "dev"` checks.
- existing-user-only dev login: `require_existing: true` refuses a missing user,
  and absent/false preserves current auto-provision behavior for other callers.
- request firewall allows read methods and blocks every write method before a fake
  server observes it, on intercepted paths only; the never-intercepted list keeps
  `/api/events` un-intercepted and the stream alive under the firewall.
- blocked-write phase tagging separates `source_click` from `destination_mount`.
- `client_truncated` detection maps the known list-hook page-cap warnings to the
  stable category and route flag.
- recipients-per-broadcast bound and embedded-recipient counting toward the
  total-item cap.
- first-page sort guarantee for the relay-group and terminal-broadcast fixtures
  against the inbox and broadcast-list page limits.
- endpoint templating and final artifact privacy scans against adversarial values.
- cold/warm aggregation, null metrics, low sample count, and percentile rule.
- baseline deltas, zero baseline, missing routes, and environment mismatch.
- scale resolution, overrides, every bound, and total-item cap.
- deterministic seed output and ID uniqueness.
- referential integrity across contacts, units, placements, tours, conversations,
  messages, and broadcasts.
- fixed-ratio coverage for list statuses/types and guaranteed detail fixtures.
- route-registry completeness against implemented read-only routes and exact
  cold/warm fixture-to-link binding, including pagination and skip behavior.

### 15.2 DynamoDB Local integration

- a small performance reseed writes valid rows to real DynamoDB Local;
- list endpoints page through generated contacts and return cursors;
- every generated table's list/detail/index contract used by the route registry
  resolves against real DynamoDB Local;
- every registered auxiliary reader returns either its declared lean fixture or
  the declared valid empty state;
- representative unit/tour/placement/relay-group/broadcast-results reads resolve;
- a second identical reseed produces the same logical dataset;
- the performance reseed guard refuses lane 0, cloud-dev prefixes, absent local
  endpoints, and over-cap input before clearing data.

### 15.3 Profiler smoke

Run one cold and one warm sample over a narrow hermetic route subset at scale 1.
Assert:

- the runner starts and stops its lane;
- the output files exist and pass the privacy scan;
- `/contacts/tenants` contains sanitized `/api/contacts` request evidence;
- a detail-page mark-read attempt is blocked and recorded;
- no write reaches the fake server after the firewall is installed;
- the report includes route ranking and a count manifest.

This smoke is an explicit feature verification command and live self-QA step, not a
new full-suite test repeated inside every existing Playwright spec.

### 15.4 Required repository gates

Before handback, after the final `main` sync:

1. `npm run typecheck`
2. `npm test`
3. `npm run e2e`

Run a real hermetic profiler smoke separately and report its exit code and artifact
path. Do not run it concurrently with the worktree's full e2e suite or interactive
session.

## 16. Documentation

Add an `e2e/README.md` section covering:

- all three target commands;
- synthetic scale and override examples;
- how the human imports real data before a local run;
- hosted interactive authentication;
- exact read-only guarantees and the mount-time write caveat;
- artifact locations and privacy guarantees;
- baseline comparison;
- interpreting cold versus warm results;
- known sources of measurement noise;
- the client list page caps (contacts and listings at 40 pages x 100,
  placements at 50) and why metrics plateau past them under the
  `client_truncated` label;
- why a low rank for a route that is not scale-bearing is not evidence it
  scales;
- rough expected reseed and total run wall-clock by scale;
- the one-direction session guard: a later e2e run in the same worktree reaps
  the profiler's launcher, so runs must be serialized by the human;
- safe cleanup when a profiler-owned lane fails to stop.

The docs explicitly warn that a Vite local run and a deployed production build are
different environments. Local evidence is best for dataset-scaling diagnosis;
hosted-dev evidence includes deployed assets, CDN/network effects, and the deployed
backend. Neither is silently presented as production-user telemetry.

## 17. Risks and mitigations

### R1. Measuring a mutation by accident

Mitigation: method firewall after auth, service workers blocked, blocked-write
evidence, and a smoke proof that the fake server saw no write.

### R2. Running against production

Mitigation: hosted target is HTTPS plus interactive admin login plus authenticated
`env === "dev"`. There is no generic external target. Any mismatch is a hard stop.

### R3. Leaking imported data into artifacts

Mitigation: do not collect bodies, headers, DOM text, console text, raw URLs,
screenshots, HAR, or traces; allowlist endpoint templates; strip query values;
final adversarial privacy scan; gitignored output.

### R4. Destroying the human's local imported dataset

Mitigation: synthetic reseed accepts only a per-lane `hc-local-<N>-` prefix and
refuses lane 0. Manual local mode has no code path to the reseed seam.

### R5. Noisy or misleading comparisons

Mitigation: separate cold/warm rankings, repeat samples, environment manifest,
mismatch labels, no p95 below 20 samples, no invented composite score, and no CI
budget until the tool is calibrated.

### R6. Profiling never finishes because of SSE

Mitigation: explicit meaningful-ready contracts and named stream exclusions; never
use blanket network idle.

### R7. Very large seeds monopolize DynamoDB Local

Mitigation: isolated lane database/access key, batch writes, hard per-entity and
total-item caps, resolved-count preview, and single-worker profiling.

### R8. Warm results depend on route order

Mitigation: deterministic order rotation between repeats and order recorded in the
manifest.

### R9. The instrument perturbs the measurement

Interception, readiness polling, and CDP collection all cost something on every
request. Mitigation: interception scoped to API-class paths so static and Vite
module traffic pays nothing; a named never-intercepted list for streams; one
discarded warmup pass for the dev server's process-global caches; an identical
interception scope across routes, repeats, and baselines, recorded in the
manifest and enforced by the `environment_mismatch` label.

## 18. Out of scope

- fixing the measured page performance in this branch;
- production profiling or production authentication;
- real-user monitoring, browser telemetry, or analytics ingestion;
- CI workflows or enforced performance budgets;
- Lighthouse scoring;
- cross-browser testing;
- mobile viewport profiling;
- workflow performance such as creating, sending, editing, uploading, or deleting;
- broadcast composition and other create/edit forms;
- raw trace, HAR, screenshot, video, DOM snapshot, or response-body capture;
- exporting or copying the actual imported domain dataset;
- automatically running the import scripts;
- external load generation or concurrent-user load testing;
- infrastructure changes or deployment.

## 19. Post-merge obligations

None expected. This feature adds on-demand local developer tooling and a dev-only
hermetic seed seam. It does not require Terraform, secrets, database migrations,
deployment, or a dev data reseed.
