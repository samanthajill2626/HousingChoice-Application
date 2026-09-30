# Vite proxy keep-alive - measurements (2026-09-30)

Why this branch exists: on the new Windows 11 PC every full `npm run e2e`
(main included) lost 4-6 random late specs to `net::ERR_ADDRESS_IN_USE` /
`net::ERR_NO_BUFFER_SPACE` and the dashboard proxy logged `connect EADDRINUSE`
to the app - ephemeral port exhaustion. Evidence for that verdict:
`docs/superpowers/reviews/2026-09-30-today-past-tours/gate-runs.md` on
feat/today-past-tours.

## The machine

Windows 11 Pro 26H2 (build 26300.9457); 24 cores. TCP dynamic range the
Windows default (49152, 16384 ports) minus ~1,300 ports in 14 Hyper-V/WSL
exclusions (~15k usable); TcpTimedWaitDelay not set (2 min default). The old
PC (Windows 10 22H2, 8 cores) has the identical range and 5 exclusions (~360
ports); it cannot run the suite today (it reads the repo over SMB from this PC
and Vite's watcher crashes), so no load comparison exists. Likely why it never
hit the wall: a third of the cores, so a lower connection rate against the same
2-minute TIME_WAIT window, and ~900 more usable ports. Unproven.

## Cause

`dashboard/vite.config.ts` gave the proxy no `agent`. Vite 7's bundled proxy
then sets `outgoing.agent = false` and forces `Connection: close` upstream
(node_modules/vite/dist/node/chunks/config.js, the setupOutgoing pass): one new
proxy->app connection per request, the app answers close, and that header is
passed back so the browser's socket to Vite is closed too.

Isolation test (a real Vite 7.3.5 dev server proxying to a plain Node target,
20 sequential requests over a keep-alive client):

| proxy option | proxy->app connections | responses with Connection: close |
|---|---|---|
| no agent (before) | 20 | 20 |
| `new http.Agent({ keepAlive: true, timeout: 30_000 })` (after) | 1 | 0 |

Node 24 does NOT derive a pooled socket's idle timeout from the server's
`Keep-Alive: timeout=65` hint (measured: free-socket timeout 0), so the agent
sets its own 30 s idle timeout, under the app's 65 s keepAliveTimeout, to avoid
reusing a socket the server is closing. Measured separately: that timeout
retires idle pooled sockets but never cuts an in-flight response (a 2 s silent
stream survived a 500 ms agent timeout) - the SSE stream is safe.

## Under load (three scenario specs: post-tour-application, approval-and-move-in, participant-names)

| | Before (main code) | After (this branch) |
|---|---|---|
| Tests | 10 passed, 1 failed (1.8 min) | 11 passed (1.8 min; 1.6 min on a repeat) |
| Peak TIME_WAIT sockets | 15,490 | 4,707 |
| Client-side, to the app port | 4,420 | 1,974 |
| Client-side, to the dashboard port | 5,609 | 2,607 |
| Server-side (a server closed the connection) | 5,307 | 0 |

A 70% cut, and the servers no longer close connections at all. Residual churn
remains: sampling ESTABLISHED owners during the run showed the headless browser
still opening short-lived connections to Vite and Vite still opening fresh
ones to the app (each sampled connection distinct). The isolation test proves
the pool itself works, so the residue is most likely requests that tests abort
mid-flight (navigation cancels in-flight fetches, and an aborted proxied
request cannot return its socket to the pool) and per-test browser contexts.
Not chased further: the full-suite gate on this branch is the judge of whether
the remaining rate fits the pool.

## Regression guard

`e2e/support/viteProxyKeepAlive.test.ts` drives the REAL config's `/api` proxy
entry through a real Vite server to a real target: 20 requests must reuse one
connection and never answer `Connection: close`, and every proxy entry must
share one keep-alive agent with an idle timeout under 65 s. Mutation-checked:
removing `agent: appAgent` fails both tests.

## Completion gates - HEAD 3d1f804c (2026-09-30 15:01-15:22)

Run bare, one after another, by a detached script; Terraform 1.16.2 (winget,
installed during this session) prepended to PATH.

| Gate | Exit | Reading |
|---|---|---|
| 1 `npm run typecheck` | 0 | clean |
| 2 `npm test` | 0 | every workspace green - app 399 files / 8109 tests, dashboard 210 / 3554, e2e workspace 22 / 501 (incl. the new keep-alive test and maintenancePage.test.ts, now that Terraform is on PATH), 34 / 275, 13 / 111. No `[dynamoAdmin]` line. |
| 3 `npm run smoke` | 0 | clean |
| 4 `npm run e2e` | 1 | **303 passed, 1 failed, 0 did not run** (18.3 min). The one failure is `contact-create.spec.ts:157`, the pre-existing failure that reproduces alone on main (issue `contact-create-link-relationship-e2e-fails-on-rerun`, filed on feat/today-past-tours). The dashboard proxy logged `connect EADDRINUSE` twice in the whole run and no test failed from it. |
| 5 `npx eslint <branch files>` | 0 | clean |

Before the fix, every full run on this PC (four runs, main included) ended
292-293 passed, 5-6 failed, 7 did not run, with a different set of late specs
each time. The LOGGED socket errors were never numerous - 2 to 9 proxy
`connect EADDRINUSE` lines and 0 to 2 browser `net::ERR_*` per run - because
most exhaustion failures surfaced as timeouts and missing elements, not as a
logged error. So the evidence is the outcome, not the error count: one full
run after the fix, clean except the pre-existing failure. The 2 residual
EADDRINUSE lines say the pool still runs close to its edge at peak; the
residual churn (see "Under load" above) is the lever if failures return.

## Confirmation run - same HEAD (2026-09-30, full e2e again)

303 passed, 1 failed, 0 did not run (17.8 min), and this time ZERO socket
errors in the log (no proxy `connect EADDRINUSE`, no browser `net::ERR_*`).
`contact-create.spec.ts:157` passed; the one failure was
`a2p-compliance.spec.ts:323` (test #5, early in the run): the property prefill
and the test's typed text concatenated in the Message field. The same failure
appeared once before the fix (feat/today-past-tours, first full run), so it is
an intermittent race of its own, not port exhaustion - filed
`docs/issues/a2p-consent-reinclude-fill-races-prefill.md`.

Two full runs after the fix, 303/304 each, against four before it at
292-293 with 7 unrun each time.
