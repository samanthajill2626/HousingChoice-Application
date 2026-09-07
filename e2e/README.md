# E2E Harness

Playwright end-to-end tests that drive the real dashboard + API against a
hermetic local stack (DynamoDB Local, console messaging, no AWS/Twilio/Google).
Design & rationale: [`docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md`](../docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md).

## Setup (first time)

Run these once from the repo root:

1. **Docker** must be running (DynamoDB Local is a container).
2. **Install deps:** `npm ci` (or `npm install`) — pulls in `@playwright/test`.
3. **Terraform >=1.15** must be on `PATH` for maintenance template tests.
4. **Install the bundled browser** the suite uses (no admin needed):
   ```
   npx playwright install chromium
   ```
5. **Verify:** `npm run e2e` - should boot the stack and pass. You're set for the
   suite and for headed/UI runs (`npm run e2e -- --headed`, `npx playwright test --ui`).

### Interactive driving via the Playwright MCP (optional)

Driving the live UI through an MCP server has a browser-channel wrinkle on Windows:

- **This project's MCP** ([`.mcp.json`](../.mcp.json)) is configured with
  `--browser chromium`, so it reuses the bundled build from step 3 — **no admin
  needed**. Prefer this if your client surfaces it.
- **A Claude-client *plugin* Playwright MCP** (the `mcp__plugin_playwright_*`
  tools) defaults to the **`chrome` channel** (real Google Chrome), NOT bundled
  chromium. If you see:
  ```
  Error: Chromium distribution 'chrome' is not found ... Run "npx playwright install chrome"
  ```
  install the chrome channel **once, in an Administrator terminal** (it writes to a
  machine location, which is why it needs elevation on Windows):
  ```
  # Administrator PowerShell, from the repo root:
  npx playwright install chrome
  ```
- **No admin / don't want the MCP?** You don't need it. The written suite and
  `--headed`/`--ui` runs use bundled chromium and need no elevation; the MCP is
  only for free-form interactive exploration.

## Two modes

| Mode | Command | What it does |
|------|---------|--------------|
| **Suite** (CI / full check) | `npm run e2e` | Playwright cold-boots the stack via `scripts/e2e-session.mjs`, runs every spec, tears down. `reuseExistingServer` reuses a running session locally; CI always boots fresh. |
| **Session** (agent inner loop) | `npm run e2e:session` | Long-lived non-watch stack you leave running and drive via the Playwright MCP. DynamoDB + seed come up once. |

Helpers (session mode):
- `npm run e2e:reseed` - reset local data only after the lane identity ping matches.
- `npm run e2e:restart` - restart **app+worker only** after proving the launcher is live.
- `npm run e2e:stop` - stop a live launcher or confirmed orphan lane and remove its state.
- `npm run e2e -- --grep "<name>"` - run a subset against the live session.
- `npm run e2e:report` - open the last HTML report.

On Windows, profiler lifecycle ownership checks invoke `powershell.exe`; it must
be available on `PATH` for hermetic profiler startup and cleanup.

### Maintenance-page verification

Terraform >=1.15 must be on PATH for maintenance template tests. The renderer runs `terraform console` in an empty temporary directory, reads the actual module template and JSON copy, and deletes only that owned temporary directory. It requires no provider initialization, backend, AWS credentials, app build or cloud access. Missing Terraform fails the test instead of silently skipping it.

From the repository root:

- `npm run test -w @housingchoice/e2e -- support/maintenancePage.test.ts`
- `npm run e2e -- tests/dashboard-next/maintenance-page.spec.ts`
- `node scripts/check-maintenance-infra.mjs`

The browser command uses the ordinary hermetic harness and tests both GET- and POST-originated 502/504 documents, safe GET-home recovery, keyboard focus, narrow/desktop layout and text enlargement. It does not induce an outage or prove AWS substitution.

The infrastructure command initializes locked providers in owned disposable configuration mirrors, validates HCL and executes only `mock_provider` tests in the CloudFront module. It requires six deliberately broken module copies to fail named assertions. It also compares the shared dev/prod composition and runs backend-disabled init/validate in copies of both roots with their respective lockfiles; no root plan, apply, test or provisioner runs. Provider installation may need network access; an existing filesystem mirror containing the locked AWS/random providers can be supplied as the sole argument. Logs are under `.superpowers/maintenance-infra/`. It never loads live environment state or invokes a live plan/apply.

## Page performance profiler (on demand)

`npm run perf:pages` profiles every registered staff navigation destination and
representative read-oriented detail page. It is an on-demand diagnostic, not a CI
gate or production telemetry system. Run it from the repository root and serialize
it with every `npm run e2e`, `npm run e2e:session`, or other profiler run in the same
worktree.

The three target commands are:

```powershell
# Profiler-owned hermetic lane; safe for automated use.
npm run perf:pages -- hermetic --scale=10

# Human only: the imported lane-0 dataset on the local Vite dashboard.
npm run perf:pages -- local --base-url=http://127.0.0.1:5174 --login-email=founder@example.com

# Human only: deployed dev assets/backend with interactive headed OAuth.
npm run perf:pages -- hosted-dev --base-url=https://dev.example.test --headed --browser-channel=chrome
```

An agent may run `local` or `hosted-dev` only when the human explicitly instructs
that individual run and names the target. Their first end-to-end executions are
human-owned: before merge they have guard unit evidence only. This repository does
not automate either target.

### Profiler CLI reference

The public syntax is `npm run perf:pages -- <hermetic|local|hosted-dev> [options]`.
Validation and workload resolution finish before a hermetic lane starts or any table
is cleared. All numeric values are safe integers. A positive value has no separate
upper bound unless this table gives one.

| Option | Syntax, default, and restriction |
| --- | --- |
| `--scale` | `--scale=INTEGER`, default 1, inclusive 1..100. Hermetic only. It scales breadth defaults; explicit breadth overrides win. |
| `--contacts` | `--contacts=INTEGER`, default `100 * scale`, inclusive 0..20000. Hermetic only. |
| `--units` | `--units=INTEGER`, default `16 * scale`, inclusive 0..20000. Hermetic only; the staff UI calls these Properties. |
| `--placements` | `--placements=INTEGER`, default `50 * scale`, inclusive 0..20000. Hermetic only. |
| `--tours` | `--tours=INTEGER`, default `50 * scale`, inclusive 0..20000. Hermetic only. |
| `--conversations` | `--conversations=INTEGER`, default `100 * scale`, inclusive 0..20000. Hermetic only; this is the existing relay-conversation population. |
| `--native-groups` | `--native-groups=INTEGER`, default `21 * scale`, inclusive 0..20000. Hermetic only. It is the exact native group-text population, not additive to lean. |
| `--messages-per-conversation` | `--messages-per-conversation=INTEGER`, default 10, inclusive 0..100. Hermetic only; scale-invariant ordinary stored density for relay and native conversations. |
| `--long-conversation-messages` | `--long-conversation-messages=INTEGER`, derived from ordinary messages when omitted, inclusive 0..20000, and at least ordinary messages when supplied. Hermetic only. |
| `--broadcasts` | `--broadcasts=INTEGER`, default `10 * scale`, inclusive 0..20000. Hermetic only. |
| `--recipients-per-broadcast` | `--recipients-per-broadcast=INTEGER`, default 25, inclusive 0..1000. Hermetic only; scale-invariant ordinary density. |
| `--large-broadcast-recipients` | `--large-broadcast-recipients=INTEGER`, derived from ordinary recipients when omitted, inclusive 0..1000, and at least ordinary recipients when supplied. Hermetic only. |
| `--cold-repeats` | `--cold-repeats=POSITIVE_INTEGER`, default 3. |
| `--warm-repeats` | `--warm-repeats=POSITIVE_INTEGER`, default 3. |
| `--ready-timeout-ms` | `--ready-timeout-ms=POSITIVE_INTEGER`, default 120000 milliseconds. |
| `--source-timeout-ms` | `--source-timeout-ms=POSITIVE_INTEGER`, default 120000 milliseconds. |
| `--login-timeout-ms` | `--login-timeout-ms=POSITIVE_INTEGER`, default 300000 milliseconds. |
| `--settle-ms` | `--settle-ms=POSITIVE_INTEGER`, default 500 milliseconds and at least `--poll-ms`. |
| `--poll-ms` | `--poll-ms=POSITIVE_INTEGER`, default 100 milliseconds. |
| `--route-order-seed` | `--route-order-seed=POSITIVE_INTEGER`, random when omitted. Keep it fixed for controlled comparisons. |
| `--baseline` | `--baseline=SUMMARY_PATH`, an earlier compatible safe `summary.json`; it requests a comparison but never enforces a performance budget. |
| `--base-url` | `--base-url=URL`, required outside hermetic mode. Local accepts only HTTP loopback port 5174; hosted-dev requires HTTPS. |
| `--login-email` | `--login-email=EMAIL`, an existing local user identity; forbidden for hermetic mode. |
| `--browser-channel` | `--browser-channel=chromium|chrome`, default chromium. Hermetic accepts only chromium. |
| `--self-qa` | `--self-qa=narrow|full`, hermetic diagnostic mode. It requires default scale 1, one cold and warm repeat, and no explicit non-scale seed override. |
| `--headed` | `--headed`, use a visible browser; required for hosted-dev and forbidden for hermetic mode. |
| `--print-config` | `--print-config`, print one resolved safe configuration JSON value without lifecycle, network, or browser work. |
| `--contract-checkpoint` | `--contract-checkpoint`, run the locked hermetic contract workload; it has the same default scale-1 and one-repeat lock as self-QA and is mutually exclusive with it. |
| `--help` | `--help` (or `-h`), print help before target validation. |

All seed options, `--self-qa`, and `--contract-checkpoint` are forbidden for
existing-data local and hosted-dev targets. The hermetic target forbids
`--base-url`, `--login-email`, `--headed`, and a non-chromium browser channel.
Local and hosted-dev profile only the target data already present: they never seed,
reseed, import, or modify it.

Scale 1 resolves to 100 generated contacts, 16 units, 21 native groups, 50
placements, 50 tours, 100 relay conversations, and 10 broadcasts. Generated contacts
use a deterministic approximately 95/4/1 tenant/landlord/unknown mix; the manifest
separates generated and active totals. Scale changes only breadth, not ordinary
message or recipient density. Scale 7 resolves to 700 contacts, 112 units, and 147
native groups, a calibration-shaped approximation of the authorized aggregate local
observation, not a copied dataset or production claim.

The native group count must fit the active generated-contact roster capacity
`C(activeContacts,2) + C(activeContacts,3) + C(activeContacts,4)` and a positive
count needs at least two active generated contacts. Native groups are never clipped.
The long fixture replaces one eligible relay conversation when `conversations > 0`;
otherwise its resolved tail is zero. The large fixture replaces one broadcast when
`broadcasts > 0`; otherwise its resolved count is zero. Ordinary and large broadcast
counts clip to the active generated tenant pool, or the explicit lean-tenant fallback
when that pool is empty. The manifest reports requested, resolved, clipped,
fixture-present, pool-source, and pool-size values.

The count manifest records these formulas, including all resolved clipping:

```text
totalConversations = conversations + nativeGroups
totalMessageCount = (totalConversations - 1) * messagesPerConversation + resolvedLongConversationMessages
  when the relay fixture exists; otherwise totalConversations * messagesPerConversation
totalRecipientCount = (broadcasts - 1) * resolvedRecipientsPerBroadcast + resolvedLargeBroadcastRecipients
  when the broadcast fixture exists; otherwise 0
physicalItemCount = contacts + units + placements + tours + totalConversations + totalMessageCount + broadcasts + 4
totalItemCount = physicalItemCount + nativeGroupMemberSlotCount + totalRecipientCount <= 250000
```

Conversation depth is stored workload, not an assertion that all stored history is
rendered initially. The profiler measures passive initial meaningful readiness and a
safe numeric initial message-row count when available. It never clicks Load more and
does not promise current latency changes while the application reads a bounded initial
page.

Use these parser-valid examples. The first five cover standard scaling, each tail,
safe config inspection, and a controlled baseline; the local and hosted-dev target
examples above remain human-only where stated.

```powershell
npm run perf:pages -- hermetic --scale=7
npm run perf:pages -- hermetic --scale=1 --long-conversation-messages=2000
npm run perf:pages -- hermetic --large-broadcast-recipients=1000
npm run perf:pages -- hermetic --scale=7 --print-config
npm run perf:pages -- hermetic --cold-repeats=1 --warm-repeats=1 --route-order-seed=424242 --baseline=e2e/.artifacts/performance/PRIOR_RUN/summary.json
```

`--print-config` is the no-side-effect preflight workflow: inspect its safe resolved
manifest before a browser run, then use that manifest as the controlled-run record.
The hermetic target owns a positive e2e lane, resets only that lane, writes the
synthetic performance world, profiles it, and stops only the launcher it started.
It never clears lane 0 or stops shared DynamoDB Local.

### Inbox workload and passive measurement

The profiler ranks four independent Inbox surface IDs: `inbox-all`,
`inbox-unread`, `inbox-unknown`, and `inbox-groups`. Their cold URLs are `/inbox`,
`/inbox?filter=unread`, `/inbox?filter=unknown`, and `/inbox?filter=groups`.
Their exact initial page requests are respectively
`GET /api/inbox?filter=all&limit=30`,
`GET /api/inbox?filter=unread&limit=30`,
`GET /api/inbox?filter=unknown&limit=30`, and
`GET /api/inbox?filter=groups&limit=30`, with no cursor accepted as profiler evidence.
The shell's unread badge is separately classified traffic:
`GET /api/inbox?filter=unread&limit=100`. It is not the 30-row page request.

Every Inbox warm sample first returns to canonical bare `/inbox` with the exact All
tab selected, then begins timing immediately before one exact named tab activation.
The destination must end in exactly one terminal branch: populated Conversations
list, that filter's exact empty copy, or error alert. The four filter samples never
open a row, click Load more, retry, mark read, or otherwise run an Inbox workflow.
Their request evidence is passive and records the distinct Inbox request class. In
full self-QA, relay-only DOM proof compares the rendered relay-link count on
`inbox-all` against the expected relay population; native groups do not satisfy it.

Full self-QA requires the exact 31 registered surfaces and 62 successful one-cold /
one-warm samples, all four Inbox surfaces in both rankings, all four page classes,
the separate badge class, no Inbox cursor evidence, no Inbox sample writes, exact
relay-only proof, healthy watchdog, and privacy/state/cleanup proofs. It fails closed
if a surface is absent, duplicated, or misclassified.

Profiler ownership is fail-closed. The runner acquires an exclusive same-worktree
marker, ignores an inherited `E2E_LANE`, selects a free lane, and gives its launcher
a random owner token. The launcher does not reap occupied ports in profiler mode and
must observe its exact commit and token from its child app before any destructive
reseed. Readiness travels over the direct parent-child IPC channel, not shared stdout.

These are rough second-run planning envelopes, not performance claims. A second run
must first scan and clear the previous generated rows, including embedded broadcast
recipient maps; a first run can therefore be materially faster.

| Scale | Second-run reseed | Default 3 cold + 3 warm total |
|------:|------------------:|------------------------------:|
| 1 | about 1-3 minutes | about 15-30 minutes |
| 10 | about 2-8 minutes | about 30-90 minutes |
| 100 | about 15-45 minutes | about 2-6 hours |

Machine load, Docker storage, route timeouts, client truncation, and the shape of a
prior overridden run can move these ranges substantially. Use lower repeat counts
for exploration, then repeat the controlled command for evidence.

### Local imported-data target (human only)

Prepare and review the real-data import before profiling. Follow
[`RUNBOOK.md`'s import procedure](../RUNBOOK.md#importing-the-founders-quo--airtable-data-m16):
run `import:plan`, review the external workbook, run `import:apply --dry-run`, then
explicitly apply it with the target environment set to DynamoDB Local and
`TABLE_PREFIX=hc-local-`. The profiler never runs the importer, seeds, reseeds,
provisions a user, or changes this dataset. Start the local dev stack normally and
use an already existing admin email with `--login-email` when the imported data does
not contain the default `founder@example.com` identity.

Local accepts only a loopback URL on port 5174 and verifies `dev: true` plus exactly
the lane-0 `hc-local-` prefix. It then requires an interactive terminal and this
exact typed response before login:

```text
PROFILE http://127.0.0.1:5174
```

There is no flag or environment bypass. A local run measures Vite-served development
modules and is best for dataset-scaling diagnosis. It does not represent built
assets, CDN behavior, or production-user telemetry.

### Hosted-dev target (human only)

Hosted-dev requires HTTPS and `--headed`. Complete normal Google OAuth in the opened
browser; the runner waits for an admin session and then proves the authenticated
environment is exactly `dev`. Authentication is outside measured samples. The
Playwright storage-state object stays only in process memory and is never written to
disk.

Google may reject an automation-controlled bundled Chromium session. Before using
the documented `--browser-channel=chrome` fallback on Windows, install that channel
once from an Administrator PowerShell:

```powershell
npx playwright install chrome
```

Hosted-dev measures the deployed build, CDN/network effects, and deployed backend.
It is still not production-user telemetry. If OAuth refuses both browser channels,
stop and reassess the authentication approach; do not work around the target proof.

### Read-only boundary

The profiler performs navigation and exact read-oriented row-link clicks only. It
does not exercise workflow actions, forms, uploads, or media controls. Before any
measured navigation it installs browser-side CDP Fetch patterns derived from the
mechanically checked mutation catalog. The patterns cover cataloged first-party
`/api/**`, `/auth/**`, and `/__dev/**` mutation paths, with base and query-bearing
variants for every template. Matching reads continue and every matching `POST`,
`PUT`, `PATCH`, and `DELETE` is blocked before the network and recorded only as a
sanitized method, endpoint template, and `source_click`, `destination_mount`, or
`out_of_sample` phase. Static assets, Vite modules, and unrelated reads do not cross
the driver interception boundary. The profiler does not call
`Network.setCacheDisabled`; `summary.json` records the narrower instrumentation fact
as `browser.httpCache: "not_disabled_by_interception"`. Mount-time and row-click
mark-read attempts are expected blocked evidence, not proof of a failed run.

The catalog is held complete by an AST inventory and exact two-way catalog match.
A CDP Network watchdog independently observes first-party API-class writes. If a
write is not paused by the catalog-derived Fetch patterns, the profiler emits only
its sanitized method and endpoint template, fails with
`uncataloged_write_escaped_firewall`, and still runs owned cleanup.
The watchdog waits for a CDP protocol barrier plus a bounded grace re-check before
confirming an escape. A confirmed escape produces a partial sanitized report with
the method/template evidence before returning nonzero.
That safety report intentionally discards all collected samples and rankings from
the escaped run rather than publishing measurements from an untrusted lane.

Writes observed without an active sample token are stored once in the run-level
`outOfSampleWrites` list. They are never charged to the next or previous route;
contract-checkpoint and self-QA modes fail them under a dedicated proof.
Plain reports surface `WARNING: out_of_sample_write`, and their compact evidence
table is deduplicated and sorted deterministically.

This is a navigation-only guarantee, not a blanket network sandbox. Public paths
under `/public/**`, media reads under `/unit-media/**`, and direct storage origins
are outside the interception scope. The registry does not navigate public pages or
invoke media/storage write controls, so those residual paths are read-only in the
documented workflow. A new navigation-triggered mutation must be added to the
mechanically checked mutation catalog and self-QA state proof.

`/api/events` is a permanent event stream and is never intercepted, never counted
as pending readiness work, and never emitted as request evidence. Known timer polls
and SSE-triggered refreshes are retained as `background_refresh` or
`background_shell` counts separately from the primary page-load request counts,
bytes, and quiet-window timing. They cannot satisfy a required endpoint contract.

### Artifacts, privacy, and baselines

Each run writes a gitignored directory at
`e2e/.artifacts/performance/<timestamp>-<random>/` containing `report.md`,
`summary.json`, and `requests.jsonl`. A valid baseline additionally produces
`comparison.md` and `comparison.json`. Normal hermetic output first prints safe
resolved seed counts, then the safe run-directory name. Candidate serialized artifact
strings are scanned in memory before staging is created or bytes are written, then
the final staged bytes are scanned again before publication. On either failure the
runner writes only a fixed allowlisted `quarantine.json` manifest in a
`-quarantined` directory, prints the safe directory plus filenames and closed reason
categories in fixed terminal records, and returns nonzero.

Artifacts contain sanitized endpoint templates and allowlisted numeric/categorical
evidence. They never contain response or request bodies, headers, cookies, auth
material, query values, raw entity IDs, names, phone numbers, email addresses,
screenshots, HAR files, or browser traces. A quarantined artifact contains only the
fixed manifest, never scanned report content. Do not paste private source data into a
handback.

Compare a controlled run with a prior `summary.json`:

```powershell
npm run perf:pages -- hermetic --scale=10 --route-order-seed=240812 --baseline=e2e/.artifacts/performance/PRIOR_RUN/summary.json
```

Comparison reports absolute and percentage deltas for matching route/mode medians.
It does not enforce a budget or fail because a metric regressed. Keep target kind,
resolved counts/densities, route set, browser major/channel, viewport, repeat counts,
route-order seed, firewall version, settle window, and poll interval identical for a
controlled comparison. A changed app revision is the intended experimental variable;
a missing revision is warned as `target_version_unverified`.

This workload model starts comparison lineage version 2. Baselines from the discarded
earlier calibration are intentionally incompatible: do not relabel, edit, or compare
them. A compatible baseline has the same workload model, registry and surface set,
resolved comparison workload, request-evidence schema, and controlled environment.

### Reading the report

A cold sample uses a fresh authenticated browser context, empty HTTP cache, blocked
service workers, and direct navigation. A warm sample reuses one context and the SPA
shell, prepares the declared source page outside measurement, then resets collection
immediately before the exact destination click. Hermetic and local runs first warm
the process-wide Vite transform/module cache with one discarded route; hosted-dev
uses built assets and skips that warmup.

Default results are three cold and three warm samples per route. Read the median with
the minimum/maximum spread, request/resource counts, background counts, and recorded
route order. Contention, Docker and filesystem caches, browser/OS version, network/CDN
variance, long tasks, Vite transform caching, and earlier route order all add noise.
Warm samples deliberately share a context, so use the same `--route-order-seed` for
comparisons. Increase repeats when the spread is material; P95 remains null until a
route/mode has at least 20 successful samples.

`client_truncated: true` means a list hook hit its client walk ceiling, so a plateau
past that point is truncation, not evidence that the page scales. Contacts stop at 40
pages x 100 records per type; properties stop at 40 pages x the server default of 50
(2,000); the placements page performs five independent walks capped at 50 pages x 50
(2,500) each. Every passive `useContacts` consumer inherits the contacts ceiling:
contact lists, email and quarantine, tour lists, contact detail, property detail, and
relay conversation detail. Tour detail and placement detail do not passively mount
`useContacts`; the hook exists only inside their closed add-contact form, so both are
correctly reported with `load_scale_bearing: false`. This is the adjudicated correction
to the design document's older enumeration; the approved design remains unchanged.

Every ranking row separately reports `surface_scale_bearing` (does rendered volume
grow with the synthetic world?) and `load_scale_bearing` (does background/read work
grow?). A low-ranked route with a false flag on the relevant axis is not proof that it
scales. Email is the useful split example: its fixed unmatched-email surface does not
grow, but its passive contact load does.

At higher conversation scales, `/inbox` is legitimately expensive: page 1 renders 30
contact rows plus every generated open/connecting relay group, up to the profiler's
1,000-group ceiling, and each relay row has server-side lookup cost. Inbox is both a
ranked destination and the warm source for `/conversations/:conversationId`, so read
the conversation detail's source-preparation time separately from its measured click.

### Session ownership and recovery

Hermetic mode refuses to start if this worktree already has a live interactive
session or full-suite launcher. The guard is one-directional: a later e2e command in
the same worktree can apply the launcher's normal self-heal and reap the profiler's
owned launcher. The human must serialize profiler and e2e work in a worktree.

Normal profiler cleanup stops only its recorded launcher and leaves shared DynamoDB
Local running. If cleanup fails, or the profiler is killed during boot before the
launcher's parent-death watch is armed, run the same-worktree recovery command:

```powershell
npm run e2e:stop
```

It reaps the lane processes and clears the session/lane state files. Confirm the
ports are free before rerunning; never kill shared MCP browser processes.

The first interrupt starts owned cleanup. A second interrupt allows 15 seconds for
cleanup and then forces a nonzero exit, so a wedged browser cannot hold the command
open indefinitely.

### DynamoDB Local integration proof

The performance seed integration suite follows the repository's Docker-optional test
convention. If DynamoDB Local is unavailable, ordinary `npm test` emits the stable
`performance_seed_integration_skipped_dynamodb_unavailable` warning and skips that
suite so pure tests remain usable. This is intentionally a loud skip, not proof that
the seed boundary ran. Plan-owned seed verification sets
`PERF_SEED_REQUIRE_DYNAMO=1`; in that mode an unreachable DynamoDB Local is a hard
failure and the targeted suite cannot pass without executing its physical namespace,
reset, writer, and reader assertions.

## Port-lane model

Each e2e run (or `npm run e2e:session`) operates in an isolated **lane** — a
block of four ports that are never shared with `npm run dev` or another concurrent
worktree.

### Lane 0 — dev only

Ports `8080 / 5174 / 8889 / 5173` are **lane 0** — the conventional `npm run dev`
ports. **No e2e run ever uses lane 0.** The lane resolver always returns a lane
≥ 1, and lane 0 is explicitly forbidden.

### Lanes 1–16 — e2e lanes

| Resource | Formula | Example (lane 1) |
|----------|---------|------------------|
| App (Express) | `9001 + L*100 + 0` | `:9101` |
| Dashboard (Vite) | `9001 + L*100 + 10` | `:9111` |
| Fake-Twilio | `9001 + L*100 + 20` | `:9121` |
| Public base URL | `9001 + L*100 + 30` | `:9131` |

Each lane gets its own DynamoDB table prefix (`hc-local-<L>-`), its own S3 bucket
(`hc-local-media-<L>`), **and its own DynamoDB Local *database* via a per-lane
access key (`hclane<L>`)** — the shared container (no `-sharedDb`) keeps a
separate store + write lock per (access key, region) pair, so lanes never share
data OR write throughput. To inspect a lane's tables with the AWS CLI you must
use ITS key (see `accessKeyId` in `e2e/.artifacts/lane.json`); the `local` key
shows only the dev loop's store.

### How a lane is picked

1. **`E2E_LANE` env var** (set by `playwright.config.ts` when it resolves a lane;
   also an escape hatch for hash collisions — e.g. `E2E_LANE=3 npm run e2e`).
2. **Hash → preferred lane.** `e2e/support/lane.mjs` hashes `git rev-parse
   --absolute-git-dir` (per-worktree gitdir) with djb2 → maps to lane `[1..16]`.
   Different worktrees hash to different preferred lanes, so concurrent worktrees
   naturally spread out.
3. **Free-probe.** If the preferred lane's four ports are occupied (a session is
   already running there), the resolver walks forward until it finds a completely
   free lane.

### Concurrent worktrees

Multiple worktrees can each run `npm run e2e` simultaneously. Each auto-picks its
own free lane (step 3 above), so they never share ports, tables, or buckets. If
all 16 lanes are occupied, the resolver exits with a clear error and the offending
worktree can use `E2E_LANE=<n>` to force a specific lane after a `npm run
e2e:stop` in that worktree.

**Cold-start caveat.** The shared containers (DynamoDB Local `:8000`, MinIO `:9000`)
are single instances. If two sessions start *from cold at the same instant*, both
race to `docker run` the same container — the loser hits a name/port conflict. This
is narrow (it only bites when both containers are down AND two starts land within
the same moment) and self-corrects on a re-run. To avoid it entirely when kicking
off several worktrees at once, warm the containers first: `npm run db:start &&
npm run s3:start` (idempotent — "already running" once up), then start the e2e runs.
The lanes themselves are fully isolated once booted.

### `e2e/.artifacts/lane.json`

Every session writes its resolved state to `e2e/.artifacts/lane.json` before
starting children:

```json
{
  "launcherPid": 4321,
  "lane": 1,
  "ports": { "app": 9101, "dashboard": 9111, "fake": 9121, "publicBase": 9131 },
  "urls":  { "app": "http://127.0.0.1:9101", "dashboard": "http://127.0.0.1:9111",
              "fake": "http://127.0.0.1:9121", "publicBase": "http://127.0.0.1:9131" },
  "tablePrefix": "hc-local-1-",
  "mediaBucket": "hc-local-media-1",
  "accessKeyId": "hclane1"
}
```

The helper scripts (`e2e:reseed`, `e2e:restart`, `e2e:stop`) treat this gitignored
file as a routing record, not proof of liveness. Ordinary launcher shutdown retains
it after removing the matching `session.pid`, because `e2e:stop` needs the lane
ports to reap reparented Windows orphans. Reseed requires an exact lane and table
prefix identity ping before any write. Restart requires the recorded launcher to
be live. Stop proceeds only for a live launcher or a matching app identity, reports
when it is reaping from a stale launcher record, and compare-deletes unchanged
state. Profiler cleanup removes the record only after its exact `launcherPid` is
dead and the lane number still matches.

### 127.0.0.1 convention

All URLs in the harness use `127.0.0.1` — **never** bare `localhost`. On systems
where Node resolves `localhost` to `::1` (IPv6) instead of `127.0.0.1` (IPv4),
a probe of `127.0.0.1:<port>` sees a free port even if the process is listening
on `localhost`, causing a false "free" and a double-bind. Forcing IPv4 throughout
the lane stack eliminates this class of failure.

## Requirements
- Docker running (DynamoDB Local). The launcher sets `DEV_AUTH_ENABLED=1` so
  dev-login and the dev seams are available.
- **Env vars:** the session launcher reads only `process.env` (hermetic/reproducible) and does NOT merge a local `.env` the way `npm run dev -- --local` does — so `TABLE_PREFIX`/`DYNAMODB_ENDPOINT` overrides in `.env` won't affect `e2e:session`.
- **Windows note:** killing the background task alone can leave the reparented node tree running on `:8080`/`:5173`. The launcher now auto-exits when its parent dies (parent-death watch), and `npm run e2e:stop` or the next `npm run e2e:session` (self-heal) also clean up any stale processes.
- **Browsers:** see [Setup](#setup-first-time) — the suite uses bundled Chromium
  (no admin); interactive MCP driving may need a one-time admin `npx playwright
  install chrome` if your client's plugin MCP uses the chrome channel. The suite
  never depends on the MCP.

## Agent workflow (driving the UI yourself)
1. Start the stack in the background: `npm run e2e:session` (wait for `ready`).
2. The launcher logs the lane URLs: `app=http://127.0.0.1:<port> dashboard=…`.
3. Confirm you're on the hermetic stack: `GET /__dev/ping` via the dashboard URL → `{"dev":true}`.
4. Authenticate the MCP browser: `POST /auth/dev-login` `{ "email": "va@example.com" }`
   (proxied via the dashboard URL), or navigate the UI. Then drive with the Playwright MCP
   (navigate, snapshot, click, fill, screenshot).
5. Assert outbound texts via the fake's thread store: `GET <fake-url>/control/threads`
   (in specs, `getOutboundTo(request, { to, since })` from `fixtures/fakeTwilio.ts`).
6. After a change: backend → `npm run e2e:restart`; data → `npm run e2e:reseed`;
   then re-drive (the browser keeps its page) or run a spec subset.
7. Before claiming done: `npm run e2e` (full suite, green).

## Dev-only surface (local stack only)
These mount ONLY when `DEV_AUTH_ENABLED=1`, `NODE_ENV!=production`, AND a local
`DYNAMODB_ENDPOINT` is set. They never exist in a deployed environment - the dev
router module is not even imported there.

- `POST /auth/dev-login` - mint a real session without Google.
- `GET  /__dev/ping` - stack-identity probe (the preflight's staleness check).
- `POST /__dev/reseed[?profile=full]` - clean slate. Logs the browser out.
  (Proof-of-send is NOT here any more: the deprecated `/__dev/outbox` log was
  removed 2026-08-24 - assert sends against the fake's thread store instead.)
- `GET  /__dev/logtail?level=&since=&contains=&event=` - the app process's
  WARN+ERROR ring buffer, and the ONLY way a spec can assert on an app log line.
  The response carries `capturing`: an empty `lines` from a stack that never
  installed the ring proves nothing, so a spec claiming "no ERROR" must check it
  (`fixtures/groupText.ts` throws rather than pass silently).
  `POST /__dev/logtail/clear` scopes a spec to its own window.
- The `*/tick` seams - `tour-reminders`, `roster-actions`, `placement-nudges`,
  `extraction`, and `group-guardrails` (plus `group-send-staleness/check`).

**THE TICKS ARE NOT A CONVENIENCE.** The lane runs jobs in-process in the APP
*and* spawns a real worker with its own pollers. Only the app's log lines reach
`/__dev/logtail`, so any spec asserting a guardrail line must drive the app-side
tick - waiting on the worker's copy proves nothing either way. The guardrail
tick's `force` defaults to TRUE for the same reason: the worker may have just
claimed the cadence period.

## Layout
- `playwright.config.ts` - one `chromium` project, reporters, `webServer` (which runs `scripts/e2e-session.mjs`).
- `fixtures/` - `reseed`, `fakeTwilio` (inbound injection incl. CARRIER GROUP texts, the Conversations inspectors, and `getOutboundTo` proof-of-send reads), `groupText` (log tail + guardrail ticks), `fakeEmail`, `fakeVoice`, `relayConnect`, `voiceSetup`, `extraction`.
- `support/` - `selectors.md` (the selector conventions), `urls.ts` (central lane-URL module), `lane.mjs` (lane resolver), `preflight.ts` (globalSetup), `viewport.ts`.
- `tests/` - `dashboard-next/`, `flows/`, `scenarios/`, plus two loose specs.
- `scenarios/` - `steps.ts`, the sequence-diagram vocabulary.
- `.artifacts/` - reports, traces, screenshots, the `.restart` sentinel, `lane.json` (gitignored).

There is no `auth.setup.ts` and no `vaPage` fixture: every spec declares its own
four-line `devLogin(page)` helper. (This section claimed otherwise for a long
time - it was describing a shape the harness never grew.)

## CI readiness (documented, not yet wired)

CI is intentionally **not built** (project decision D4) — but the harness is
CI-ready and `npm run e2e` already honors CI semantics via `playwright.config.ts`:
- `reuseExistingServer: !process.env.CI` — CI always boots a fresh stack (never
  reuses a stale/leaked one); locally a running `e2e:session` is reused.
- `forbidOnly: !!process.env.CI` — a stray `test.only` fails the CI run.

To wire it later, a GitHub Actions job needs all of the following:

1. **Node 24 + `npm ci`.**
2. **Docker / DynamoDB Local.** The e2e launcher starts the container via
   `scripts/db.mjs` (GitHub `ubuntu-latest` runners have Docker preinstalled).
   The app `*.integration.test.ts` and the e2e launcher BOTH need DynamoDB Local —
   without it the integration suites silently **self-skip** (zero coverage) and the
   launcher's DB step fails. Start + create + seed it before the unit/integration
   run: `npm run db:start && npm run db:create && npm run db:seed`.
3. **Bundled Chromium with caching** — `npx playwright install --with-deps
   chromium` (cache `~/.cache/ms-playwright`). Do NOT use the `chrome` channel.
4. **Run with `CI=1`** so the semantics above engage.
5. **Upload `e2e/.artifacts/`** (HTML report, traces, screenshots, videos) on
   failure for debugging.
6. **Cold-runner timing:** first `--local` boot pulls `amazon/dynamodb-local` +
   cold-starts tsx/vite; if `webServer.timeout` (180s) proves tight on a cold
   runner, prewarm the image (`docker pull amazon/dynamodb-local`) or raise it.

Sample workflow (copy to `.github/workflows/e2e.yml` when CI is adopted):

```yaml
name: e2e
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-pw-${{ hashFiles('package-lock.json') }}
      - run: npx playwright install --with-deps chromium
      - name: Start DynamoDB Local (+ tables + seed)
        run: npm run db:start && npm run db:create && npm run db:seed
      - name: Unit + integration tests
        run: npm test
      - name: E2E
        run: npm run e2e
        env: { CI: '1' }
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: e2e-artifacts, path: e2e/.artifacts/ }
```

**Known limitations to resolve when CI lands:**
- CI uses the Playwright-managed `webServer` (it starts/stops
  `scripts/e2e-session.mjs`); on Linux, Playwright tears the webServer down via its
  own process-group kill, so suite teardown is clean. The **standalone**
  `e2e:session`/`e2e:stop` teardown is verified on Windows but **not yet validated
  on Linux** (children aren't reaped via process groups since they aren't spawned
  detached) — only relevant for interactive Linux use, not the CI suite.
- Consider pinning `@playwright/mcp` to the installed Playwright version in
  `.mcp.json` (the MCP is interactive-only; CI never uses it).
