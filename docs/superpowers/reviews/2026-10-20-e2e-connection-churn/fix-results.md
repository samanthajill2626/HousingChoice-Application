# e2e connection churn - fix results (2026-10-20)

Branch `fix/e2e-strictmode-aborts` (worktree `W:\tmp\e2e-strictmode-aborts`),
fix commit `b222a4ac` on top of the diagnosis `15532983`. Before numbers are
from [`diagnosis.md`](diagnosis.md) (runs B and C, main `1d7a4667`, lane 4);
after numbers are from this branch, lane 3, same machine, same tools.

## 1. What changed

Section 5.1 of the diagnosis, as proposed: `requestWithStatus` in
`dashboard/src/api/client.ts` awaits one microtask before a SIGNALLED request
calls `fetch`, and rejects with the signal's reason if it aborted in that tick.
A request without a signal still dispatches synchronously; a request aborted
after dispatch is cancelled by `fetch` as before. The only signalled POSTs are
the relay-group preview and the org-text check (both read-only), so no write can
be dropped. `dashboard/src/api/client.abort.test.ts` pins the four cases; its
two same-tick cases fail without the change.

5.2 (HMR WebSocket off) was not done - see section 4. 5.3 (`TcpTimedWaitDelay`)
is a host registry setting and stays Cameron's call.

## 2. Runs

| Run | What | Tests | Result | Peak TIME_WAIT machine / lane ports |
|---|---|---|---|---|
| B (before) | full `npm run e2e` + hook + sampler | 365 | 364 passed, 1 white page, 20.9 min | 4,784 / 4,660 |
| E (after) | full `npm run e2e`, bare (gate 4) + sampler | 365 | **365 passed**, 19.3 min | **1,776 / 1,735** |
| F (after) | full `npm run e2e` + hook + sampler | 365 | **365 passed**, 19.3 min | **1,882 / 1,772** |
| C (before) | e2e:session subset, NO hook; NetLog + `E2E_TRACE=1`; 6 files x2 | 70 | 70 passed, 8.4 min | 3,124 / 3,008 |
| G (after) | same as C | 70 | **70 passed**, 7.2 min | **1,231 / 1,133** |

"Lane ports" counts only TIME_WAIT tuples on the lane's four ports plus
DynamoDB Local (:8000) and MinIO (:9000) (`tools/lanepeak.mjs`), which a busy
neighbour cannot inflate. Before run E an unrelated process on the machine was
holding a steady ~400 loopback TIME_WAIT of its own (adjacent-port socket
pairs); it had gone by the time E started (115 machine-wide).

B and F both carry the hook, so they are the like-for-like pair for the hook
columns below; E is the real-world (hook-free) number.

## 3. Before / after

### 3.1 Connections per hop, full suite

| Hop | B (hook) | F (hook) | change | E (OS, no hook) |
|---|---|---|---|---|
| browser -> Vite | 13,811 | **5,894** | -57% | 5,783 |
| Vite -> app | 9,020 | **2,426** | -73% | 2,363 |
| requests per Vite -> app connection | 3.5 | **11.6** | x3.3 | - |
| app -> DynamoDB Local | 865 | 832 | - | 839 |

E's column is the sampler's view (paired endpoints, `analyze.mjs`); run B's
sampler view was 13,727 / 8,781, so the hook-free drop is the same shape
(-58% / -73%). Per spec file (`osperfile.mjs`, B vs E) every file fell, the
heavy scenario specs most: approval-and-move-in 1,830 / 1,420 -> 440 / 260
browser -> Vite / Vite -> app over its tests, tours 1,179 / 927 -> 450 / 288,
post-tour-application 1,130 / 850 -> 325 / 200.

### 3.2 Cancelled proxied requests (hook, `pertest.mjs`)

| Cause | B | F | change |
|---|---|---|---|
| StrictMode signature (cancelled < 50 ms, same URL again within 100 ms) | 7,353 | **695** | -91% |
| SSE `GET /api/events` cut at navigation | 1,268 | 1,268 | 0 (expected) |
| other reads cut at navigation | 408 | 415 | 0 |
| **total** | **9,029** | **2,378** | **-74%** |

### 3.3 The NetLog subset (C vs G, both hook-free, same 70 tests)

| Measure | C (before) | G (after) | change |
|---|---|---|---|
| browser TCP connect attempts (NetLog) | 4,572 | **1,511** | -67% |
| connections toward Vite / app (sampler, `osperfile.mjs`) | 14,993 | **4,649** | -69% |
| HMR WebSocket upgrades (NetLog `ERR_WS_UPGRADE` on close) | 456 | 456 | 0 - one per page load |
| peak TIME_WAIT, machine / lane ports | 3,124 / 3,008 | **1,231 / 1,133** | -61% |
| approval-and-move-in, browser -> Vite / Vite -> app per test | 316 / 208 | 87 / 48 | -72% / -77% |
| post-tour-application, per test | 205 / 140 | 61 / 34 | |
| tours, per test | 123 / 89 | 42 / 24 | |

### 3.4 Connect failures

| Signal | Before | After |
|---|---|---|
| Vite proxy `connect EADDRINUSE` lines | B 0, C 0 (Cameron's 2026-10-20 clean run: 1) | E 0, F 0, G 0 |
| browser TCP connects failing WSAEADDRINUSE (NetLog) | C: 1 of 4,572 (at 2,890 machine TIME_WAIT) | G: **0 of 1,511** |
| white pages | A 1 (of 18), B 1 (of 365) | E 0, F 0 (of 365 each), G 0 (of 70) |

One failure before against none after is not significant on its own; the
measured drop in connects and in TIME_WAIT is the evidence, and this row only
shows nothing new appeared.

## 4. What is left, and 5.2

The residual browser -> Vite connections in F (5,894) are, by the hook:

- **1,578 that never carried a request** (27%) - mostly the HMR WebSocket,
  one per page load (G's NetLog: 456 upgrades in 70 tests, unchanged from C).
- **1,268 SSE streams** cut at navigation (each a socket on both hops) - inherent
  to a full page load.
- **695 StrictMode-signature cancels that are NOT StrictMode.** The fix drops
  every same-tick abort, so these are aborted in a LATER task and re-requested
  at the same URL. 585 of them are three slices of the contact file
  (`relay-groups` 209, `group-threads` 194, `listings-sent` 182):
  `ContactDetail.tsx:349` passes `{ contactType: contact?.type }` to
  `useContactFile`, whose fetch effect depends on `opts.contactType`
  (`useContactFile.ts:226`). The type is `undefined` until the contact header
  loads, so every contact page view runs the effect twice, aborting and
  re-sending its in-flight slice reads. That is a production double fetch, not
  an e2e artifact; it is a separate, small fix (proposed as a follow-up).
  Tour reminders (58) look the same and were not chased.
- the remainder: each test's fresh browser context opening its own sockets.

**5.2 is not worth doing now.** The HMR socket is the largest single slice, but
turning it off is unverified (the Vite client may poll or reload without it),
and it costs one connect per page load against a peak TIME_WAIT that is already
down 60%. The contact-file double fetch is the better next cut: smaller, a
real-user benefit, and ~1,200 fewer connections per run (585 cancels x 2 hops).

## 5. What this does and does not prove

- Shown: the churn the diagnosis attributed to StrictMode is gone (-91% of
  that signature, the rest explained in section 4); connections per run fell
  57% / 73% on the two churning hops; peak TIME_WAIT fell from 4,784 to ~1,800
  in both a hooked and a hook-free full run, and from 3,124 to 1,231 on the
  NetLog subset, whose browser connects fell 67% with none failing. Both full
  runs (365/365 each) and the subset (70/70) were green, and each ran faster
  than its before-run (19.3 vs 20.9 min, 7.2 vs 8.4 min).
- Not shown: that the white page cannot recur. The diagnosis found no safe
  TIME_WAIT threshold (a white page at ~2,000), and the full runs still peak at
  ~1,800. The failure rate scales with connects x TIME_WAIT occupancy and both
  fell, so a rough expectation is a sixth of the old rate (0.43 x 0.39), not
  zero. Keep the two issues open until the merged fix has a run of clean gate
  runs behind it.

## 6. Records

Raw data (gitignored): `W:\tmp\e2e-strictmode-aborts\.superpowers\churn-fix-2026-10-20\`
(`E-full`, `F-full-hook`, `G-session` - sampler tables, hook logs, the gzipped
2.5 GB NetLog and its scan, results, and `osperfile-B.txt` / `osperfile-C.txt` for the
before-runs). `tools/lanepeak.mjs` is new; the other tools are
unchanged except that `full-run.ps1` / `subset-run.ps1` now resolve the worktree
they are committed in.
