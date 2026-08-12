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
  human-invoked exceptions (exact wording in section 13; `AGENTS.md` is in the
  implementation file list). If the human declines that amendment, D3 must be
  re-decided and the local target removed.
- "Human-invoked only" is enforced, not honored: local mode requires an
  interactive TTY confirmation (section 5.2) with no bypass flag or
  environment variable, and hosted-dev requires a human completing a headed
  interactive login (section 5.3).
- Agent self-QA and the profiler smoke use the hermetic target only.

## 3. Success criteria

1. `npm run perf:pages -- hermetic --scale=10` starts an isolated e2e lane,
   replaces that lane's data with a deterministic performance dataset, profiles
   the route registry, writes a report, and tears down only the stack it started.
2. The scale factor grows the entity counts - contacts, properties, placements,
   tours, conversations, and broadcasts - proportionally. Per-entity densities
   (messages per conversation, recipients per broadcast) are scale-invariant
   defaults; the total message and recipient volumes grow with their parent
   counts, not with the density. Per-entity CLI overrides can replace any
   derived count or density.
3. `npm run perf:pages -- local --base-url=http://localhost:5174` refuses unless
   `/__dev/ping` proves a local stack with an `hc-local-` table prefix. It uses an
   existing admin dev user and refuses to auto-provision one.
4. `npm run perf:pages -- hosted-dev --base-url=https://... --headed` opens an
   interactive login browser, keeps the resulting authentication state in memory
   only, requires an admin session, and refuses unless `/api/system/flags`
   returns `env: "dev"`.
5. After target verification and authentication, a request firewall installs
   browser-side CDP Fetch patterns derived from the mechanically checked
   dashboard mutation catalog. Every matching `POST`, `PUT`, `PATCH`, and
   `DELETE` is blocked before it reaches the network and recorded in sanitized
   form, while static assets, Vite modules, unrelated reads, and `/api/events`
   do not cross the interception boundary. An AST completeness gate, an exact
   two-way catalog match, and a runtime CDP Network watchdog form the safety
   chain: a first-party API-class write that is absent from the catalog and
   therefore escapes Fetch creates sanitized evidence and fails the run with
   its own closed reason. Paths outside the cataloged first-party scope
   (`/public/**`, `/unit-media/**`, the direct-to-storage upload origin) remain
   read-only in the D6 workflow. The full-registry self-QA's state assertions
   (section 15.3) additionally prove that no ENUMERATED automatic write surface
   changed state.
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
| D9 | Hosted safety | Interactive in-memory auth, `env === "dev"` proof, and a scoped write firewall covering every navigation-triggered mutation path (section 6; the scope and its residual surface are stated, not "strict" as a slogan). |
| D10 | Comparison | Built-in baseline comparison. |
| D11 | Automation | On-demand only; no CI or enforced budget. |
| D12 | Dependencies | Use Node, TypeScript/tsx, and the existing Playwright dependency; add no runtime dependency. |

## 5. Command surface

The root command is:

```text
npm run perf:pages -- <target> [options]
```

Every target supports `--print-config`: parse and fully validate the argv,
print the resolved target, counts, and densities as JSON, and exit 0 without
starting a lane, opening a browser, or touching any stack. Argv parsing and
full configuration validation always complete BEFORE any lifecycle step - an
invalid or over-cap configuration is rejected before section 5.1 step 1 runs,
not merely before a table is cleared. `--print-config` exists so the
end-to-end argv test (section 15.1) can execute the real npm script inside the
`npm test` gate without booting - or reaping - a real e2e stack.

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
--recipients-per-broadcast=<non-negative integer>
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
   dies. That watch is armed only after the launcher finishes booting and
   reseeding, so it is a post-ready backstop: the profiler's own `finally`
   cleanup (step 8) is the primary guarantee, and the docs cover recovery for a
   profiler killed during boot (`npm run e2e:stop` clears both state files).
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
Startup and cleanup require both the lane number and `lane.json.launcherPid` to
match the retained child. The shared launcher removes only its matching
`session.pid` during ordinary shutdown and leaves `lane.json` for `e2e:stop` to
reap orphaned app/public-base listeners; profiler-owned cleanup removes the lane
file only after the exact child is dead and both fields still match. The first
SIGINT/SIGTERM starts owned cleanup. A second signal starts a 15-second forced-exit
deadline so wedged cleanup cannot keep the process alive forever.

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

Local mode also carries a human-presence gate, because "human-invoked only"
must be a mechanism, not an honor system: the runner requires an interactive
TTY and a typed confirmation naming the target stack before authenticating,
and refuses when stdin is not a TTY. The runner never accepts a flag or
environment variable that bypasses the confirmation.

The profiler calls dev-login with an explicit existing-user-only contract:
`POST /auth/dev-login` gains an optional boolean body field `requireExisting`
(camelCase, matching the repository's request-body convention). When true, the
route returns a non-success response if the user does not exist instead of
inviting or provisioning it. Absent or false preserves today's auto-provision
behavior for every other caller (e2e fixtures, the dashboard dev-login button).
The profiler always sends `requireExisting: true`.

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

The deployed login is Google OAuth, and Google can refuse sign-in inside an
automation-controlled browser. The runner therefore accepts
`--browser-channel=chrome` to run the headed login and the measured session in
installed Chrome instead of bundled Chromium; storage state remains
memory-only either way. The chrome channel has a one-time Windows prerequisite
this repo already documents: `npx playwright install chrome` from an
Administrator terminal (`e2e/README.md`), and the channel is a local-human-only
path - CI and agents stay on bundled Chromium. The docs state the prerequisite
up front so the human does not discover it only after OAuth has already
refused.

Even so, hosted-dev ships unverified: the pre-merge smoke is hermetic-only, so
the first real hosted-dev run is the human's, and if Google refuses both
browser channels, D4 must be re-decided on that evidence rather than patched
around. The same caveat applies to local mode, whose TTY gate deliberately
forecloses any automated end-to-end exercise: section 15.1's unit tests of the
loopback/port/prefix guards, `requireExisting`, and `--login-email` are the
ONLY pre-merge evidence for local mode, and the first end-to-end local run is
the human's.

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

For every measured page:

- interception is scoped, not blanket: CDP Fetch patterns are generated from
  every cataloged first-party mutation path under `/api/**`, `/auth/**`, or
  `/__dev/**`, including both the base pattern and a `?*` query variant;
- static assets, Vite modules, unrelated reads, public paths, media paths, and
  direct-to-storage origins do not match those patterns and never pay a driver
  round trip;
- a named never-intercepted list excludes streaming endpoints - at minimum
  `/api/events` - so no permanently open streamed response is ever routed
  through the interceptor;
- on matched paths, allow `GET`, `HEAD`, and `OPTIONS`, and block `POST`,
  `PUT`, `PATCH`, and `DELETE` before the request reaches the network;
- the ratified catalog-derived scope is recorded in the manifest and is part
  of baseline comparability (`scope ratified 2026-08-12,
  INTERCEPTION_SCOPE_VERSION 3`); version 2 predates the query-bearing pattern
  widening and is intentionally not baseline-compatible with this scope;
- block service workers as one-line defense in depth - no service worker is
  registered in the dashboard today, so this guards a future worker, not a
  live threat;
- record the attempted method, a sanitized endpoint template, and a phase tag
  (`source_click`, `destination_mount`, or `out_of_sample`) so a write fired by
  the warm click on the source page is distinguishable from the destination's
  own mount write and from evidence outside an active sample. `out_of_sample`
  evidence is retained once at run scope, never assigned to a neighboring
  route, and has its own contract/self-QA mismatch code;
- never record the body, headers, cookies, or raw URL;
- make blocked requests visible in the route result and top-level report;
- fail the run if a method outside the known HTTP method set is observed on an
  intercepted path;
- run a CDP Network watchdog beside Fetch and fail with
  `uncataloged_write_escaped_firewall` plus sanitized method/template evidence
  if any first-party `POST`, `PUT`, `PATCH`, or `DELETE` is not matched by the
  catalog-derived Fetch scope. Before latching an escape, use a real CDP
  round-trip barrier and one bounded grace re-check so a later-dispatched
  matching `Fetch.requestPaused` can clear the candidate. A confirmed escape
  writes a partial sanitized artifact containing the reason and method/template
  evidence before the run exits nonzero.

Interception has a per-request cost even when scoped. The scoped design exists
so that the cost lands only on requests matching cataloged mutation endpoints
and is identical across routes, repeats, and baselines. The profiler does not
issue `Network.setCacheDisabled`; the manifest records
`browser.httpCache: "not_disabled_by_interception"` as an instrumentation fact,
not as a guarantee about browser cache implementation details.

Three proofs keep the scope honest. A mutation-path inventory test (section 15.1)
is mechanically derived, not hand-maintained: an AST scan of
`dashboard/src` finds every request initiated with a write method - the typed
endpoints module's non-GET functions plus any direct `fetch` call - and the
test fails when a method or path cannot be proved statically. The resulting
discoveries and checked-in catalog must match exactly in both directions, and
every cataloged first-party mutation path must generate an interception
pattern. A future mutation therefore fails the gate until it is cataloged. At
runtime, the Network watchdog catches any remaining first-party API-class write
that was not paused by Fetch. The navigation-reachable subset today is the
mark-read family across contact, conversation, inbox row, email row, and the
tour/placement channel tabs. Finally, the full-registry self-QA run (section
15.3) asserts app state unchanged for EACH enumerated automatic write surface,
not just one of them.

A blocked mount-time mark-read is expected evidence, not a profiler failure. The
route remains measurable when the application treats the failed mark-read as
best effort. If a blocked write prevents a route from reaching its ready state,
that route is reported as `blocked_write_dependency` rather than silently timed
out or permitting the write.

Tour and placement detail resolvers retain one additional sanitized branch fact:
whether the initially selected group or tenant channel has positive unread on
the same first `/api/conversations` page used by the UI. Their mount-write set is
required only when that fact is true. The scale-1 self-QA fixtures prove the
unread group branch and continue to require the write there.

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
- two scale flags, because surface and load can diverge:
  `surface_scale_bearing` (does the list or detail content the route displays
  grow with the generated dataset?) and `load_scale_bearing` (does the request
  volume behind the route grow with it?). `/email` is the canonical split case:
  its unmatched-email surface is never generated, while its load includes full
  capped `useContacts` walks over the generated contact set. Both flags are
  emitted into every ranking row so a reader can tell a route that scaled flat
  from a route that was never varied - on either axis.

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

The two paginated sources behave differently, and the seed contract in section
11 covers each on its own terms - an API-side page walk does not put a row into
the DOM, and D6 forbids clicking Load more:

- The broadcast list renders one 50-row page behind a Load more control, so the
  guaranteed terminal broadcast must sort onto that first page.
- `/inbox` merges relay-group rows additively onto page 1: every open or
  connecting relay group lands there regardless of recency, on top of the
  30-row contact page, bounded only by the relay list's own query budget of
  roughly 2,000 rows. The relay-group fixture is therefore reachable whenever
  that budget is not truncated, so section 11 caps generated open/connecting
  relay groups safely below the budget and asserts the server's `truncated`
  flag stays false.

Without those guarantees the two detail routes would silently degrade to
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
  built assets and skips it. One route suffices only because the dashboard
  bundle is not code-split (every route component is imported statically);
  revisit this if lazy routes are ever introduced.

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
link. For a detail route, the runner first reaches the declared source list and
applies the declared source state. The resolver may page by GET to SELECT its
fixture, but GET paging never puts a row into the DOM - the warm link must
already be rendered on the source page, which is what section 11's reachability
guarantees (first-page sort for broadcasts, the relay volume cap for the inbox)
exist to ensure. The runner then locates the exact accessible row link bound to
the resolver's in-memory ID. Timing and request
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

The network half of that definition has an exact CDP timestamp; the UI half is
observed by polling, so its timestamp is late by up to one poll interval. The
readiness poll interval is therefore a named constant (default 100 ms),
recorded in the manifest next to the settle window, and both are
`environment_mismatch` triggers in section 12 - two runs polled at different
cadences are not comparable on UI-settling routes, which are exactly the routes
this tool exists to find.

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
  during the sample, so a metric plateau caused by client-side truncation is
  never mistaken for the app scaling well. The caps differ per hook: contacts
  truncate at 40 pages x 100 records per type; listings at 40 pages x the
  server's default 50-row page (2,000 units - the hook sends no limit); the
  placements page runs five independent 50-page limit-less walks (placements,
  plus deleted and live variants of both tenant contacts and units) and
  truncates when ANY of the five caps, each at 50 x 50 = 2,500 records;
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
and DOM size. Every ranking row carries the route's `surface_scale_bearing` and
`load_scale_bearing` flags and its `client_truncated` status, so a flat curve
past the client page caps or a never-varied fixed-fixture route cannot be read
as the app scaling well.

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
First-party non-`/api` application paths that carry entity IDs in their segments
are in the template registry too: `/unit-media/<unitId>/<uuid>` maps to
`/unit-media/:unitId/:mediaKey` and `/public/**` paths map to their own
templates, so a `/listings/:unitId` sample's media requests never emit a raw
unit ID. Static assets retain only a non-sensitive asset class and transfer
size. External origins are reduced to `first_party` or `third_party`; hostnames
and paths are not stored.

The redactor has adversarial tests for E.164 phone values, email addresses, URL
encoded values, opaque cursor values, UUIDs, arbitrary slug-like IDs, and unknown
endpoints. A final artifact scan fails the run if common phone/email/cookie/token
patterns are found, or on the repository's entity-ID shapes - raw entity IDs are
not phone/email-shaped, so they need their own scan patterns. The pattern list
is derived from the repository's actual ID constructors and seed namespaces,
not hand-enumerated: every known entity prefix (`contact`, `unit`, `conv`,
`tour`, `placement`, `bcast`, `broadcast`, `user`, `msg`, `um`, `perf`)
followed by a UUID, digit run, hex run, or slug tail, plus bare UUIDs and
ULID-like tokens. The unmatched-email shape is `um-<32 hex chars>` - hex, not
UUID, so it needs its own tail pattern. `bcast` is
the PRODUCTION broadcast prefix (`bcast-${randomUUID()}` in the repo);
`broadcast` covers the seed namespace - deriving from the actual constructors
means both, and the per-kind negative tests feed each real shape through. Matching is
substring, not whole-segment, so an ID embedded in a longer value still trips
it. Patterns match full ID shapes, never bare prefixes, and the known sanitized
template literals and `:placeholder` tokens are exempt - otherwise the scan
would reject its own `/unit-media/:unitId/:mediaKey` output, quarantining every
run that measures `/listings/:unitId`. Tests assert that every template in the
registry passes the final scan AND that one real ID of every entity kind - in
both its production `<prefix>-<uuid>` shape and its seed `<prefix>-<digits>`
shape - fails it.

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
| messages per conversation | 10 (density; scale-invariant) |
| broadcasts | 10 |
| recipients per broadcast | 25 (density; scale-invariant) |

The scale factor multiplies the entity counts only. The two density rows are
scale-invariant: at scale 100 each conversation still carries 10 messages and
each broadcast 25 recipients unless overridden. This is what keeps the
messages-per-conversation bound (0..100) satisfiable at every allowed scale and
what the scale-100 arithmetic in section 11.4 assumes.

The lean seed remains present for stable admin identities and canonical route
fixtures. Generated records use a reserved `perf-` ID namespace and fake `+1555`
numbers. Values are deterministic for the resolved configuration plus a seed
anchor, and contain no real data.

The seed anchor is the clock contract: the generator captures ONE anchor
timestamp at validation time and derives every time value from it - tour
`scheduledAt` spread across the anchor's next 30 days (the `/tours` window
reads `[start-of-today, +30 days]` against the live clock), `last_activity_at`,
`created_at`, placement timestamps, and Today's due/upcoming windows. The
anchor is recorded in the count manifest. "Deterministic" therefore means
configuration + anchor reproduce the same dataset; two runs at different times
produce time-shifted but structurally identical datasets. Without an anchor
contract, fixed timestamps silently age out of the time-windowed readers
(`/tours`, `/api/today`) and those routes go empty while the spec promises
representative rows.

Per-entity overrides replace, rather than add to, the scale-derived generated
count. Referential links use the deterministic generated tenant, landlord, or unit
pool when that required parent kind is non-empty and otherwise use the named lean
fallback in section 11.2. Statuses, contact types, deleted records, tour states,
placement stages, conversation kinds, unread counts, and broadcast states are
distributed by fixed ratios so every list view has representative rows.

The relay-group ratio carries a hard ceiling, not just a ratio: generated
open/connecting relay groups never exceed 1,000 regardless of the conversation
count, because `/inbox` folds every open/connecting relay group onto page 1
additively, one query per status, each bounded by its own roughly 2,000-row
page budget. When the fixed kind ratio would exceed the ceiling (above roughly
scale 50), the clipped conversations are generated as 1:1 conversations
instead, so the conversation TOTAL is preserved deterministically and only the
kind ratio shifts; the count manifest records both the requested and the
clipped relay ratio. Staying below the budget keeps the relay queries untruncated
(asserted by the section 15.2 integration test) and keeps the guaranteed
relay-group fixture reachable. What the ceiling does NOT do is bound `/inbox`
as a measured page: page 1 renders 30 contact rows plus every open/connecting
relay group by design, each relay row costing its own server-side lookup, so at
high relay counts `/inbox` - itself a ranked route and the warm source for
`/conversations/:conversationId` - is legitimately heavy, and its ranking and
the conversation detail's preparation budget must be read with that in mind.
The docs say so.

At least one eligible detail fixture of each required kind is guaranteed whenever
the corresponding count is non-zero. When an override intentionally sets a kind to
zero, affected detail routes are honestly skipped.

Fixtures behind paginated sources get a reachability guarantee matched to how
each source actually renders:

- the guaranteed terminal broadcast carries the newest `created_at` among
  generated broadcasts, so it sorts onto the broadcast list's first 50-row page
  at every scale;
- relay-group rows do not compete for the inbox's 30 contact-row slots - they
  merge additively onto page 1, queried per status (open, then connecting),
  each status call bounded by its own roughly 2,000-row page budget - so the
  guarantee for the relay-group fixture is a volume cap, not a sort position:
  generated open/connecting relay groups stay safely below the per-status
  budget (section 11.2). The budget flag never leaves the server, so the
  assertion is two-sided: a DynamoDB-Local integration test (section 15.2)
  asserts `listRelayGroups` reports no truncation at the generated volume, and
  in hermetic mode only, the runner counts the relay-group rows RENDERED in the
  inbox DOM by accessible role - never by reading the response body, which the
  privacy contract forbids and which carries member names and message previews -
  and flags any shortfall against the manifest's generated relay count in the
  route result. Local and hosted-dev have no manifest and perform no such
  comparison.

### 11.2 Physical table and reader manifest

The destructive boundary and generated additions are separate contracts:

- the existing reset clears every base in `TABLES` plus the dev outbox, restores
  the complete lean seed, and stamps the lean admin identity;
- performance generation then appends rows to exactly `contacts`, `units`,
  `placements`, `tours`, `conversations`, `messages`, and `broadcasts`, plus
  one FIXED-FIXTURE appendix: a small constant set of fake unmatched-email
  rows (a few inbox rows and a few quarantined, fake addresses in the reserved
  namespace, never scaled) so `/email` and `/email/quarantine` render
  representative rows and the email no-write assertion in section 15.3 has a
  row to open - the lean seed contains no unmatched-email fixture at all;
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
  above. Broadcast recipients are a map keyed per contact, so fallback
  references COLLAPSE: with `contacts=0`, 25 requested recipients resolve to
  one entry keyed on the lean tenant. Recipient resolution is de-duplicated
  against the resolved recipient pool BEFORE the total-item cap is computed,
  and the count manifest reports requested versus resolved recipient totals.
  The zero/non-zero parent-child test matrix includes the
  recipients-to-contacts vector.

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
a hang. The published figure is a SECOND-run figure: the clear phase scans full
items from the previous run, including broadcasts carrying embedded recipient
maps, so every run after the first pays a clear cost the first run never shows.

### 11.4 Bounds

The initial safety bounds are:

- scale: greater than 0 and at most 100;
- contacts, units, placements, tours, conversations, broadcasts: 0 through
  20,000 each;
- messages per conversation: 0 through 100;
- recipients per broadcast: 0 through 1,000 (default 25, scale-invariant) -
  deliberately below the repository's `MAX_BROADCAST_RECIPIENTS` (1,500) and
  sized so the embedded recipients map stays well under the 400KB DynamoDB item
  ceiling, because broadcast recipients live on the broadcast item itself;
- generated open/connecting relay groups: at most 1,000 (section 11.2's inbox
  budget ceiling);
- resolved generated items across every table: at most 250,000, with embedded
  broadcast recipients counted toward the resolved total. The default
  configuration stays inside the cap at every allowed scale (scale 100 resolves
  to roughly 133,500 rows plus 25,000 embedded recipients); a high
  recipients-per-broadcast override multiplied by a high broadcast count can
  exceed it, and the pre-flight validator rejects that combination before
  anything is cleared.

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

Comparison requires the same schema version and route key. It reports target
mode, profiler commit, target app revision, scale/count manifest with its seed
anchor, browser version, browser channel, viewport, OS, Node version, cold and
warm repeat counts, route-order seed, interception scope, settle window,
readiness poll interval, and timestamps so a reviewer can judge whether two
runs are comparable.

Profiler commit and target app revision are separate fields, because the
runner's checkout does not identify the application being measured. Hermetic
mode gets the target revision from `/__dev/ping`'s `appCommit`, which the e2e
launcher populates. On a manual local stack that field is normally null, and
the hosted flags endpoint exposes no commit at all - in those cases the target
revision is recorded as `target_version_unverified` and the comparison carries
that WARNING label. A DIFFERING target revision is never a mismatch: comparing
two revisions is the tool's central use case ("did the fix help?"), so the
revision pair is reported as the experimental variable, not as evidence the
comparison is uncontrolled.

The seed anchor is provenance, not identity: two anchors produce time-shifted
but structurally identical datasets, so scale-manifest equality for
comparability EXCLUDES the anchor and keys on the resolved configuration
(counts, densities, ratios) alone. Otherwise every hermetic baseline would be
an `environment_mismatch` by construction.

When target kind, scale manifest (anchor excluded), route set, browser major
version, browser channel, viewport, cold or warm repeat count, route-order
seed, interception scope, settle window, or readiness poll interval differs,
the comparison is labeled `environment_mismatch` and lists the mismatches. A
missing target revision adds the `target_version_unverified` warning; a
differing target revision is the experimental variable and triggers nothing. It still computes route deltas but never presents them
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
e2e/vitest.config.ts
package.json
AGENTS.md
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
`e2e/package.json` adds `"test": "vitest run"` - Vitest is already a hoisted
root devDependency that the app workspace runs without declaring, so this adds
zero dependencies and uses the same runner as every other workspace. An
`e2e/vitest.config.ts` restricts the include to `performance/**/*.test.ts` so
Vitest never picks up the Playwright specs, and Vitest fails by default when no
test files match, which closes the zero-test-green gate hazard natively. Root
`npm test` already runs workspace test scripts with `--if-present`, so it
executes these modules without a new dependency. The root package also adds only
the on-demand `perf:pages` command, and its form is pinned:

```text
"perf:pages": "tsx e2e/performance/cli.ts"
```

Direct invocation, never a nested `npm run ... -w <workspace>` - the root
`"e2e"` script is exactly that nested shape and it swallows the caller's `--`
arguments, which for this command would mean `--scale=10` silently never
arrives and the run "succeeds" at scale 1 while reporting a trusted manifest.
Section 15.1 includes an end-to-end argv test through `npm run perf:pages`, not
only a unit test of the parser. The direct form also keeps all Playwright
execution inside e2e-workspace code, which is how the root command satisfies
AGENTS.md's Playwright rule for the hermetic target.

`AGENTS.md` is in the file list because the D3 reconciliation in section 2 is a
required edit, not aspiration. The carve-out wording the branch adds to
AGENTS.md's "UI testing and verification" section is:

> `npm run perf:pages` is a sanctioned Playwright entry point: the root script
> delegates directly into e2e-workspace code, so it satisfies the
> e2e-workspace-only rule for its hermetic target. Its `-- local` and
> `-- hosted-dev` targets are additionally human-invoked only: an agent may run
> them only on the human's explicit per-run instruction naming the target, and
> the local target requires an interactive TTY confirmation the runner
> enforces.

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
  options, plus an end-to-end argv check through
  `npm run perf:pages -- hermetic --scale=7 --print-config` proving `--`
  options actually reach the CLI on Windows - `--print-config` exits before
  any lane work, so the check runs safely inside the `npm test` gate.
- local target loopback/port/ping/prefix checks.
- hosted HTTPS, admin, and exact `env === "dev"` checks.
- existing-user-only dev login: `requireExisting: true` refuses a missing user,
  and absent/false preserves current auto-provision behavior for other callers.
- request firewall allows read methods and blocks every write method before a fake
  server observes it, on intercepted paths only; the never-intercepted list keeps
  `/api/events` un-intercepted and the stream alive under the firewall.
- blocked-write phase tagging separates `source_click` from `destination_mount`.
- `client_truncated` detection maps the known list-hook page-cap warnings to the
  stable category and route flag.
- recipients-per-broadcast bound and embedded-recipient counting toward the
  total-item cap.
- fixture reachability: the terminal-broadcast first-page sort guarantee against
  the broadcast list's 50-row page, the relay-group ceiling against the
  per-status relay page budget, and the hermetic-only DOM relay-row-count
  versus manifest comparison (the repo-level no-truncation assertion is a
  section 15.2 integration test, because the budget flag never leaves the
  server; the runner never reads the inbox response body).
- the zero/non-zero parent-child matrix including the recipients-to-contacts
  vector: recipient map collapse under `contacts=0`, requested-versus-resolved
  recipient totals in the manifest, and de-duplication before the total-item
  cap arithmetic.
- endpoint templating and final artifact privacy scans against adversarial values.
- cold/warm aggregation, null metrics, low sample count, and percentile rule.
- baseline deltas, zero baseline, missing routes, and environment mismatch.
- scale resolution, overrides, every bound, and total-item cap.
- deterministic seed output for a fixed configuration + anchor, ID uniqueness,
  and time-window coverage: at any anchor, the generated dataset puts
  representative rows inside the `/tours` 30-day window and Today's
  due/upcoming windows.
- the mutation-path inventory: every navigation-reachable client mutation call
  site maps to an intercepted path (section 6).
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
- `listRelayGroups` reports no truncation for either status at the maximum
  generated relay-group volume (the ceiling-versus-budget assertion; the flag
  never leaves the server, so this is the only place it can be tested);
- a second identical reseed produces the same logical dataset;
- the performance reseed guard refuses lane 0, cloud-dev prefixes, absent local
  endpoints, and over-cap input before clearing data.

Ownership split, so the two sides cannot drift silently: these integration
tests live in the app workspace (the existing `app/test/*.integration.test.ts`
convention) and assert the section 11.2 physical/query contract, which is
app-owned. They never import the e2e-workspace route registry. The
registry-to-endpoint binding (that each registry entry's declared endpoint
templates and fixture predicates match what its route actually requests) is
observable only at runtime, so it is asserted by the full-registry self-QA run
(section 15.3), which measures every registry entry: each route's observed
sanitized API templates must be a subset of its registry entry's declared set. Section 15.1's unit tests cover
only what is statically checkable - registry completeness against the
implemented route table and registry well-formedness - and the runtime
`unmatched_api` flag feeds ongoing registry maintenance.

### 15.3 Profiler smoke

Two tiers, both hermetic:

- NARROW SMOKE, for quick iteration: one cold and one warm sample over a small
  route subset at scale 1.
- FULL-REGISTRY SELF-QA, the pre-handback live verification: one cold and one
  warm sample for EVERY registry entry at scale 1. The registry-to-endpoint
  binding check and the per-surface write assertions below run here, because a
  narrow subset cannot validate declarations it never exercises - a registry
  entry outside the subset could carry a wrong endpoint contract undetected.

Assert (narrow smoke on its subset; full-registry self-QA on everything):

- the runner starts and stops its lane;
- the output files exist and pass the privacy scan;
- `/contacts/tenants` contains sanitized `/api/contacts` request evidence;
- every measured route's observed sanitized API templates are a subset of its
  registry entry's declared templates - this is the live registry-to-endpoint
  binding check, and the only place it is observable (section 15.2);
- a detail-page mark-read attempt is blocked and recorded;
- no blocked write landed, observed in app state per enumerated surface. In the
  full-registry self-QA this covers EVERY automatic write surface from section
  6: the visited contact's unread state, the visited relay conversation's
  unread state, the inbox row's read state, the email row's read state, and the
  tour/placement channel read states are each re-read over the API afterward
  and asserted unchanged; `GET /__dev/outbox` shows no new outbound message.
  The narrow smoke asserts the surfaces its subset touches. A fake-twilio
  no-SMS check alone would be vacuous here - the enumerated mount-time writes
  are app-side POSTs that never touch the comms mock, so the proof must observe
  app state;
- the report includes route ranking and a count manifest.

Both tiers are explicit feature verification commands, not a new full-suite
test repeated inside every existing Playwright spec. The full-registry self-QA
is the live self-QA step reported at handback.

### 15.4 Required repository gates

Before handback, after the final `main` sync:

1. `npm run typecheck`
2. `npm test`
3. `npm run e2e`

Run the real hermetic full-registry self-QA (section 15.3) separately and report
its exit code and artifact path. Do not run it concurrently with the worktree's
full e2e suite or interactive session.

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
- the client list page caps and why metrics plateau past them under the
  `client_truncated` label, with the per-hook numbers from section 9 and the
  note that EVERY route mounting `useContacts` inherits the contacts cap
  (email triage, tours, and the contact/listing/conversation/tour/placement
  detail pages, not just the contact lists);
- why a low rank for a route that is not scale-bearing on the relevant axis is
  not evidence it scales;
- why `/inbox` is legitimately heavy at high relay-group counts (page 1 renders
  every open/connecting relay group by design) and how that reads in the
  ranking and in `/conversations/:conversationId` warm preparation;
- the chrome browser channel's one-time Administrator install prerequisite on
  Windows, stated before the hosted-dev instructions rather than discovered at
  OAuth-refusal time;
- rough expected reseed and total run wall-clock by scale, quoted as second-run
  figures (the clear phase scans the previous run's items);
- the one-direction session guard: a later e2e run in the same worktree reaps
  the profiler's launcher, so runs must be serialized by the human;
- safe cleanup when a profiler-owned lane fails to stop, including a profiler
  killed during boot before the launcher's parent-death watch is armed.

The docs explicitly warn that a Vite local run and a deployed production build are
different environments. Local evidence is best for dataset-scaling diagnosis;
hosted-dev evidence includes deployed assets, CDN/network effects, and the deployed
backend. Neither is silently presented as production-user telemetry.

## 17. Risks and mitigations

### R1. Measuring a mutation by accident

Mitigation: scoped method firewall on API-class paths after auth, blocked-write
evidence with phase tags, service workers blocked as defense in depth, D6's
navigation-only interaction contract for the un-intercepted residual paths, and
the smoke's app-state proofs that no write landed (unchanged unread count on a
visited conversation, empty dev outbox delta).

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
