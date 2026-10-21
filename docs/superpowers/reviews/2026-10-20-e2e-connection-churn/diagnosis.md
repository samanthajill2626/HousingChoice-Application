# e2e connection churn on Windows - measured diagnosis (2026-10-20)

Assessment only: nothing in the product or the harness was changed. The fix
proposed in section 5 waits for Cameron's go.

## 1. The question

Full `npm run e2e` runs on this PC still lose a test now and then to an entirely
white page (at sign-in, or after an in-app navigation), and the Vite dev proxy
sometimes logs `connect EADDRINUSE 127.0.0.1:<lane app port>`. The 2026-09-30
proxy keep-alive fix (`dashboard/vite.config.ts:27`) cut TIME_WAIT by 70% and
left the rest unchased. A clean 365/365 run made right after restarting both
containers still logged one EADDRINUSE 17 minutes in, with 3,687 TIME_WAIT at
the end - so the churn is produced inside one run. Which connections churn, why,
and what is the smallest change that stops it?

Sightings: `docs/issues/e2e-blank-first-paint-at-sign-in.md`,
`docs/issues/e2e-blank-document-after-contact-navigation.md`. Previous fix:
`docs/superpowers/reviews/2026-09-30-vite-proxy-keepalive/measurements.md`.

## 2. Answer

Almost all of it (96%) is two hops - browser -> Vite and Vite -> app - and the
cause is one thing: **the browser cancelling an API request that is already on
the wire**. Chromium cannot reuse an HTTP/1.1 socket whose response it
abandoned, so it closes its connection to Vite; Vite's bundled proxy then
destroys its pooled connection to the app (`res.on('close')` ->
`proxyReq.destroy()`, Vite 7.3.5 `chunks/config.js:21473`). Two TIME_WAIT
sockets per cancelled request. **81% of those cancels are React StrictMode's
dev-only double mount** (`dashboard/src/main.tsx:15`): every effect's first
fetch is aborted within milliseconds and re-issued, and the aborted one has
already been dispatched. The rest are the SSE stream (14%) and slow reads (5%)
cut by navigation. Deferring a signalled fetch's dispatch by one microtask and
dropping it if its signal already aborted removes the StrictMode cancels
entirely: measured -71% connections on a 25-page tour, with identical rendering.

## 3. Method

Lane 4 of this worktree, hermetic (never :5174 / :8080). Windows 11 Pro 26H2
build 26300; TCP dynamic range 49152 + 16384 minus 1,360 excluded ports
(~15,000 usable); TcpTimedWaitDelay default (120 s). The machine was quiet at
every start (no other e2e lane; 123-262 TIME_WAIT). `E2E_CHILD_LOG_DIR` was
never set. Three instruments, in `tools/`:

1. **Passive TCP-table sampler** (`TcpChurnSampler.cs`, `run-sampler.ps1`).
   Polls `GetExtendedTcpTable` (IPv4 + IPv6, owner pid) every ~30 ms and records
   every loopback endpoint touching a lane port, 8000 or 9000. It touches no
   process under test. A TIME_WAIT tuple lives 120 s, so closed-connection
   counts per port and per closing side are exact even for connections that
   lived under one poll. Self-test: 50 `Connection: close` requests -> exactly
   50 server-side TIME_WAIT tuples.
2. **In-process hook** (`churn-hook.mjs`, `NODE_OPTIONS=--import`, every node
   process of the stack). Through `diagnostics_channel` it records each
   connection a process opens or accepts, every HTTP request that rode it, and
   whether the response finished. One object push per event, flushed once a
   second. Self-test: 51 fresh + 49 reused of 100 requests, all seen. Its "who
   closed first" field is not used; the sampler's TIME_WAIT side is.
3. **Browser-side probes** (no source change): an init script that keeps the
   stack of every `AbortController.abort()` call (Playwright MCP, same lane),
   and a Chromium NetLog of a whole run (`netlog.playwright.config.ts`, copied
   into `e2e/` for that run only, then deleted).

| Run | What | Tests | Result | Peak TIME_WAIT |
|---|---|---|---|---|
| A | e2e:session + hook + sampler; 4 scenario files | 18 | 17 passed, 1 white page | 5,305 |
| B | full `npm run e2e` + hook + sampler | 365 | 364 passed, 1 white page, 20.9 min | 4,784 |
| C | e2e:session, NO hook; sampler + NetLog + `E2E_TRACE=1`; 6 files x2 | 70 | 70 passed, 8.4 min | 3,124 |
| D | fix A/B: 4 navigation tours (MCP), sampler | - | see section 5 | - |

**Perturbation check.** Run B took 20.9 min against Cameron's clean 19.5 min.
Hook-free run C (which carried NetLog + trace instead, its tests 20-40% slower)
counted 2-14% fewer browser -> Vite and 6-28% fewer Vite -> app connections per
test than hooked runs A and B, file for file over the five shared files - same
ranking, same magnitude. So the hook may inflate the Vite -> app count by up to
a quarter; it does not create the churn. The sampler and the hook agree on the
two hops to 1.6% (22,471 vs 22,831 connections in run B).

## 4. Results

### 4.1 Churners, full suite (run B)

| # | Hop | Connections per run | Closed by | Requests per connection |
|---|---|---|---|---|
| 1 | browser -> Vite (:9411) | **13,811** | browser (10,067 seen in TIME_WAIT on its side, 3 on Vite's) | 45.6 |
| 2 | Vite -> app (:9401) | **9,020** | Vite (all) | 3.5 |
| 3 | app -> DynamoDB Local (:8000) | 865 | Docker's port proxy | 186 |
| 4 | Playwright fixtures -> Vite / app / fake | ~65 | - | 29 |
| 5 | everything else (fake Twilio both ways, MinIO, launcher) | < 120 | - | - |

About 24,000 short-lived connections in 21 minutes (~19 a second, a TIME_WAIT
floor of ~2,300). Rows 3-5 already pool; they are not worth touching. Of the
browser's 13,811 Vite connections, 9,108 ended with a proxied API response
unfinished, 3,117 ended normally (context close), and 1,586 never carried an
HTTP request (mostly the Vite HMR WebSocket, one per page load; NetLog run C
saw 456 of them in 70 tests). Of Vite's 9,020 app
connections, 6,632 carried a request the browser had abandoned; most of the
rest were pool sockets the 30 s idle timeout retired after a burst.
**No module or static response was ever cut mid-flight** (run A: 0 of 2,860).

### 4.2 Why the browser cancels (run B: 9,029 cancelled proxied requests)

| Cause | Count | Share | Signature |
|---|---|---|---|
| React StrictMode double mount | **7,353** | 81% | cancelled < 50 ms after start AND the same URL re-requested within 100 ms |
| SSE `GET /api/events` cut at navigation | 1,268 | 14% | one per page load; lifetime 50 ms - 1 s (303 of 321 in run A) |
| other reads cut at navigation | 408 | 5% | - |

The StrictMode attribution is proven, not inferred from timing: on a contacts
page load, 5 of 6 `abort()` stacks run through React's
`doubleInvokeEffectsOnFiber`; the sixth is UnreadContext superseding its own
read (`dashboard/src/app/UnreadContext.tsx:111`). Top StrictMode paths:
`/api/inbox/unread-count` 853, `/api/unmatched-email` 823 (both UnreadContext,
every page), `/api/contacts` 488, `.../timeline` 483, `.../listings-sent` 391,
`/api/today` 364. Heaviest files: the scenario specs - approval-and-move-in
~670 connections per test, post-tour-application ~400, tours ~240 - against
20-60 for most dashboard-next specs.

### 4.3 Why connects fail at 2-5k TIME_WAIT, far below the ~15k pool

- Run C's NetLog: 4,572 browser TCP connects, **one** failed - `os_error=10048`
  (WSAEADDRINUSE) -> `ERR_ADDRESS_IN_USE`, 2 ms into a connect to
  `127.0.0.1:9411` for the HMR WebSocket, at **2,890** machine TIME_WAIT. The
  test survived (the HMR client reconnects); the same failure on a module fetch
  is a white page.
- Windows hands these loopback connects ephemeral ports mostly at random (run
  B: 22,652 client endpoints over 12,034 distinct ports; 72% of consecutive
  connects jump more than 200 ports), and a wildcard bind defers the address
  check to connect -
  which then fails when that 4-tuple is still in TIME_WAIT. So the failure rate
  scales with connects x TIME_WAIT occupancy: there is no safe threshold, and
  both terms come from the same churn. (Windows' exact selection rule is
  inferred from this behavior and the error code, not from its source.)
- The white pages caught here have the module-graph-stopped shape of the traced
  sightings. Run B (maintenance-page.spec.ts:22, "502 GET ... width 320", ~2,000
  TIME_WAIT): Vite served the document and 9 modules within 15 ms, then the
  browser never requested `react-dom_client.js` (asked 3 ms after `react.js` in
  the next, healthy load) and nothing at all for 15 s; the app saw no request.
  Run A (post-tour-application.spec.ts:210, at the 5,305 peak): the last
  `/placements/<id>` load made 56 requests and never reached `/auth/me`. Neither
  run carried a browser trace, so for these two the failed request is shown by
  absence, not by its error. The maintenance spec also routes requests through
  `page.route`, which cannot be excluded for that one; no other sighting's spec
  routes.

## 5. Proposal (smallest first)

**5.1 The fix: never dispatch a fetch whose signal aborts in the same tick.**
In `requestWithStatus` (`dashboard/src/api/client.ts:117`), when a `signal` is
passed, await one microtask before calling `fetch`; if the signal has aborted
by then, throw the same `AbortError` `fetch` would have thrown (callers already
rethrow it, `client.ts:125`). About 5 lines plus a unit test. StrictMode still
double-invokes every effect; only the wire traffic of a request that was dead
before it left is skipped, so a component that forgets its cleanup still
double-fetches visibly. In production (no StrictMode) the check never fires;
the cost is one microtask per signalled request.

Emulated with an init script on the hook-free lane (`tools/ab-tour.js`; four
identical tours of dev-login + 24 page loads, fresh context each):

| Variant | API requests issued | Cancelled by the browser | Connections (browser->Vite + Vite->app) | Pages rendered |
|---|---|---|---|---|
| today | 395, 395 | 149, 149 | 331, 313 | 24/25 |
| deferred dispatch | 254, 254 | **0, 0** | **92, 94** | 24/25 |

-71% connections; console output identical (the expected pre-login 401s). The
tour waits for network idle, so it has no navigation cancels; on the full suite
the fix removes ~7,350 of ~9,030 cancels, about 14,700 of ~24,000 connections
(-60%), which should take peak TIME_WAIT from ~4,800 to roughly 2,000 and the
connect-failure rate down by more than that (fewer connects AND lower
occupancy). Those are estimates; section 6 measures them. Check during the
build: 6 dashboard test files stub `fetch` globally and 3 use
`AbortController` - any that assert `fetch` was called synchronously must
`await` first.

**5.2 Only if a residual remains: no HMR WebSocket in the e2e lane.** One
connection per page load (~1,600 per full run, ~7%). The e2e stack must not
hot-reload anyway (it serves source live). Vite's `server.ws: false`, gated on
the e2e env (`VITE_E2E_COMMIT`); whether the Vite client tolerates it quietly is
unverified.

**5.3 Host belt, not a fix (Cameron's machine, admin + reboot):**
`TcpTimedWaitDelay = 30` (HKLM `...\Tcpip\Parameters`) cuts the TIME_WAIT
population 4x for every hop. Do not do it instead of 5.1.

Not recommended: turning StrictMode off in e2e (loses the double-mount coverage
the dashboard relies on); patching Vite's proxy to keep upstream sockets on a
client abort (vendor internals, fixes only the Vite -> app half); routing
Vite -> app over a named pipe (an app change for half the churn). The SSE cut
per navigation (14%) is inherent to full page loads and stays.

## 6. How to prove the fix

1. Unit: a request whose signal aborts in the same tick never calls `fetch` and
   rejects with `AbortError`; a request aborted after dispatch behaves as today.
2. Full `npm run e2e`, hook-free, with `tools/run-sampler.ps1` running (or
   `tools/full-run.ps1` without `-Hook`): **peak machine TIME_WAIT** (4,784 for
   this suite today; expect about 2,000) and **zero `connect EADDRINUSE` proxy
   lines**.
3. The direct metric: one full run under the NetLog config, scanned with
   `tools/netlog-scan.mjs` - **zero `ERR_ADDRESS_IN_USE` / `ERR_NO_BUFFER_SPACE`
   connect failures** (run C today: 1 in 4,572 connects). A TIME_WAIT count alone
   does not prove it: a failed connect was seen here at 2,890 and a white page
   at ~2,000.
4. Then three consecutive full gate runs with no white-page failure (today: one
   every one to four full runs, per the issue history).

## 7. Records

Raw data, kept while this worktree exists (gitignored):
`.superpowers/churn-2026-10-20/` - per-run sampler tables, hook logs, run logs,
results.json, failure screenshots and videos, the run C NetLog (gzipped), and
the tools exactly as run. The tools are committed beside this file so the proof
run can reuse them; `netlog.playwright.config.ts` must be copied into `e2e/`
for its run and deleted afterwards - it is not part of the suite.
