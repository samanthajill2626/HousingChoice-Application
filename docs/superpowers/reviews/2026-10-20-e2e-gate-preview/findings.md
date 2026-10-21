# e2e gate on a built dashboard - findings (2026-10-20)

Branch `feat/e2e-gate-preview`, worktree `W:\tmp\e2e-gate-preview`, from main
`3df43172`. The contact-file double-fetch fix is NOT on this branch (Cameron:
branch from plain main). Launcher change `f48d2f99`. How the mode works and what
`vite preview` honors: [`reference-launcher.md`](reference-launcher.md).
Baseline: run G in
[`../2026-10-20-e2e-connection-churn/fix-results.md`](../2026-10-20-e2e-connection-churn/fix-results.md)
section 3.3 (lane 3) and run E in section 2. Tools:
`../2026-10-20-e2e-connection-churn/tools/`, plus `netlog-connects.mjs`, added
on this branch.

## 1. Verdict

The build does what it was asked to do: **0 HMR upgrades** (was 456 in the
subset), **-18% browser TCP connects** in the subset and **-32% browser -> Vite
connections** in the full gate, and every test green (70/70, 365/365). The
suite also gets **faster**: subset 7.5 -> 4.1 min, full gate 19.3 -> 15.9 min.
The build itself adds about 2 s per launch.

**It does not reduce the churn behind the white pages; it makes the peak
worse.** The HMR socket closes by reset, so it never sat in TIME_WAIT. The
connections that do leave a TIME_WAIT are essentially unchanged (browser ->
Vite +4% in the subset, -8% in the full run; Vite -> app flat). Packing the
same TIME_WAIT-producing connections into less wall clock raises peak TIME_WAIT
by about half: full gate lane ports 1,735 -> **2,618**, machine 1,776 ->
**2,710**. The diagnosis saw a white page at about 2,000.

Recommendation: do **not** make the build the gate default on its own. It is
worth having for the speed and for testing the bundle that ships, but only
together with something that cuts TIME_WAIT occupancy itself. The obvious
candidate is the host `TcpTimedWaitDelay` (diagnosis 5.3; Cameron's call, not
an agent's). Without that, flip the webServer default to `dev` and keep
`preview` opt-in. That is a one-line change in `e2e/playwright.config.ts`; I
did not make it, because the task asked for the gate to use the build.

## 2. The 70-test subset (6 files x2, `subset-run.ps1 -NetLog -Trace`)

D is a same-day control: the dev server, this branch, lane 13, the same tools
and specs. It reproduces G within 1%, so the G baseline holds on this machine
today.

| Measure | G (baseline, dev) | D (control, dev) | P (preview build) | P vs D |
|---|---|---|---|---|
| tests | 70 passed | 70 passed | **70 passed** | |
| wall clock | 7.2 min | 7.5 min | **4.1 min** | -45% |
| dashboard build added | - | - | 2.1 s | |
| browser TCP connect attempts (NetLog) | 1,511 | 1,507 | **1,240** | -18% |
| HMR WebSocket upgrades (NetLog `ERR_WS_UPGRADE`) | 456 | 456 | **0** | -100% |
| chromium -> Vite connections (sampler) | 3,012 | 3,009 | 2,206 | -27% |
| - closed by the browser (each leaves a TIME_WAIT) | 2,027 | 2,022 | 2,100 | +4% |
| - closed with no TIME_WAIT (reset) | 984 | 983 | 106 | -89% |
| Vite -> app connections | 1,621 | 1,602 | 1,793 | +12% |
| - closed by Vite (TIME_WAIT) | 1,461 | 1,439 | 1,655 | +15% |
| all connections toward Vite / app (`osperfile.mjs`) | 4,649 | 4,646 | 4,243 | -9% |
| peak TIME_WAIT, machine / lane ports | 1,231 / 1,133 | 1,194 / 1,094 | **2,160 / 2,062** | +81% / +88% |
| browser connects failing (NetLog socket errors) | 0 | 0 | 0 | |

Per test (`osperfile.mjs`, browser -> Vite / Vite -> app, D -> P):
approval-and-move-in 87/50 -> 60/52, post-tour-application 61/35 -> 46/40,
tours 41/24 -> 36/28, landlord-onboarding 40/23 -> 38/28, maintenance-page 7/0
-> 3/0. Seconds per test roughly halved in every file.

### What opens the browser's sockets (`netlog-connects.mjs`)

| First request on the new socket | D (dev) | P (preview) |
|---|---|---|
| dev module (`/src`, `/@vite`, `/node_modules`) | 683 | - |
| HMR WebSocket | 456 | - |
| proxied `/api` | 327 | 1,016 |
| SSE `/api/events` | 5 | 112 |
| built asset (`/assets/*`) | - | 61 |
| document | 36 | 35 |
| `/app-identity` | - | 16 |
| **total** | **1,507** | **1,240** |

Under the dev server, each page load's module fan-out opens the connection pool
and the API calls that follow reuse it. Under the bundle there are only two
assets, so the API burst at boot opens those same sockets itself. The count is
set by how wide Chromium's per-host pool gets for each fresh browser context
(up to 6, plus the long-lived SSE stream), not by how many files the page
fetches. Bundling therefore removes the socket that exists only for HMR, and
not much else. (The script's requests-per-socket histogram is not comparable
between the two runs, because Chromium logs a reused idle socket differently,
so it is left out here.)

## 3. The full gate (`npm run e2e`, bare, under the sampler - gate 4)

Q is this branch's gate run (`full-run.ps1`, no hook, lane 13). E is the
hook-free full run from fix-results (lane 3, `fix/e2e-strictmode-aborts`,
whose code is what main `3df43172` carries; this branch adds only the launcher
mode on top).

| Measure | E (dev server) | Q (preview build) | change |
|---|---|---|---|
| tests | 365 passed | **365 passed** | |
| wall clock | 19.3 min | **15.9 min** | -18% |
| chromium -> Vite connections | 5,771 | **3,909** | -32% |
| - closed by the browser (TIME_WAIT) | 4,161 | 3,836 | -8% |
| - closed with no TIME_WAIT | 1,605 | 70 | -96% |
| Vite -> app connections | 2,234 | 2,220 | -1% |
| app -> DynamoDB Local | 839 | 822 | - |
| all toward Vite / app (`osperfile.mjs`) | 8,173 | 6,455 | -21% |
| peak TIME_WAIT, machine / lane ports | 1,776 / 1,735 | **2,710 / 2,618** | +53% / +51% |
| when the peak falls | 18.4 of 19.3 min | 15.7 of 15.9 min | the same tail specs |
| `[preflight] dashboard:` | (line did not exist) | built bundle (vite preview) | |

Most of the time saved comes from the heavy scenario specs (summed test
seconds): approval-and-move-in 53 -> 28 s, tours 53 -> 39 s,
post-tour-application 33 -> 22 s, landlord-onboarding 21 -> 14 s.

## 4. Specs that behave differently under the bundle

None failed or flaked: 70/70 in the subset and 365/365 in the full gate, each
run once. The one behavioral difference is that React StrictMode's double
effect run is gone (it exists only in a development build). Every spec that
mentions it is written to tolerate a single run (`inbox-rows-timestamps`
counts finished requests, `matching-blast-rules` uses a flag rather than a
one-shot, `public-pages` asserts no growth after the first read). The cost is
coverage: under the bundle the gate no longer replays mount / cleanup / mount
in a real browser, so a StrictMode-only regression would be caught only by the
unit tests that render under `<StrictMode>` themselves, or by `e2e:session`.
One run of each is not proof that no new flake exists; it shows none appeared.

## 5. What was not done, and options

- **A development-mode bundle** (build under `NODE_ENV=development`: React's dev
  build, StrictMode replays kept, still no HMR and only a few assets) was not
  measured. Section 2 says it would not cut the TIME_WAIT-producing
  connections either, so its only use would be keeping StrictMode coverage
  while losing HMR. It is not worth a run unless the gate moves to a build for
  other reasons.
- **The real lever is per-context sockets.** Every test gets a fresh browser
  context, and its pool closes gracefully at teardown, which puts a client-side
  TIME_WAIT on every socket. Cutting that means reusing contexts across tests
  (an isolation change, its own mission) or shortening TIME_WAIT on the host.
- **The Vite -> app +12% in the subset** is not explained. The full run's hop
  is flat (2,234 -> 2,220), so it may be the subset's per-test attribution
  under a compressed timeline; no hooked run was made to split it by cause.
- `vite build` warns about a 1.16 MB chunk. This is a pre-existing
  production-build property, not new here.

## 6. Gates (AGENTS.md 1-5, bare, from the worktree)

Main had not moved past `3df43172`, so there was nothing to sync.

| Gate | Result |
|---|---|
| 1 `npm run typecheck` | exit 0 (run on `f48d2f99`, re-run after the comment-only edits) |
| 2 `npm test` | exit 0 - 251 + 22 + 34 + 13 files, 4,835 + 508 + 275 + 111 tests; no `[dynamoAdmin]` line |
| 3 `npm run smoke` | exit 0 (1,708 specifiers / 297 files; re-run after the comment edits) |
| 4 `npm run e2e` | exit 0, 365 passed (run Q above, under the passive sampler, on `f48d2f99`) |
| 5 `npx eslint <branch .ts/.tsx/.mjs>` | exit 0, no errors. The two `.mjs` files are not actually linted (the known hole), so only `vite.config.ts`, `playwright.config.ts` and `preflight.ts` were checked |

The commit after `f48d2f99` changes only comments in `scripts/e2e-session.mjs` and
`e2e/playwright.config.ts`, plus these records. Gate 4 was not re-run for it.

## 7. Records

Raw data (gitignored): `W:\tmp\e2e-gate-preview\.superpowers\gate-preview-2026-10-20\`
- `P-session` (preview subset), `D-session` (dev control), `Q-full` (gate 4)
- each holds the sampler tables, `results.json`, `osperfile.txt`, `lanepeak.txt`,
  `analyze.txt`, and for P / D the NetLog plus `netlog-scan.txt` and
  `netlog-connects.txt`

G and E are under `W:\tmp\e2e-strictmode-aborts\.superpowers\churn-fix-2026-10-20\`
and were only read.
