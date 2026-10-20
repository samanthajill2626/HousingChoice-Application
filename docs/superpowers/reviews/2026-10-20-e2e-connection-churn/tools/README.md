# Connection-churn measurement tools (2026-10-20)

Diagnostic instruments behind `../diagnosis.md`, kept so the fix's proof run
can repeat the measurement. None is part of the suite. Windows only for the
sampler; hermetic lanes only (never the live :5174 / :8080 stack).

| File | What it does |
|---|---|
| `TcpChurnSampler.cs` + `run-sampler.ps1` | Passive TCP-table sampler. `run-sampler.ps1 -OutDir <dir> -Ports 9401,9411,... -StopFile <dir>\STOP`; writes `series.tsv` (per-second TIME_WAIT per port and side), `conns.tsv` (one row per endpoint lifetime), `pids.tsv`. |
| `churn-hook.mjs` | Optional in-process hook: `NODE_OPTIONS=--import=file:///<path>/churn-hook.mjs` + `CHURN_HOOK_DIR=<dir>`. Per-process JSONL of connections, requests and finished/unfinished responses. Inert without `CHURN_HOOK_DIR`. |
| `full-run.ps1` | Full `npm run e2e` under the sampler (`-Hook` adds the hook). Waits 135 s after the run so every TIME_WAIT tuple is recorded. |
| `subset-run.ps1` | A filtered run against the worktree's live `e2e:session`; `-NetLog` adds a Chromium NetLog, `-Trace` sets `E2E_TRACE=1`. |
| `netlog.playwright.config.ts` | The suite's config plus `--log-net-log`. Copied into `e2e/` by `subset-run.ps1 -NetLog` for one run and deleted afterwards. A full-suite NetLog is several GB. |
| `netlog-scan.mjs` | Counts TCP connect attempts and every socket-level error in a NetLog. |
| `netlog-trace.mjs` | Prints the events (and URL) of the NetLog sources that hit a given net error. |
| `analyze.mjs` | Per-hop table from the sampler, joined with the hook when present. |
| `pertest.mjs` | Hook: cancelled proxied requests split by cause (StrictMode / SSE / other), per spec file. |
| `osperfile.mjs`, `oswindow.mjs` | Sampler only: connections per spec file / per time window. |
| `aborts.mjs`, `sse.mjs`, `window.mjs`, `portalloc.mjs` | Narrow follow-ups used in the diagnosis (abort lifetimes, SSE lifetimes, one window's requests, ephemeral-port order). |
| `ab-tour.js` | The fix A/B, as a Playwright MCP `browser_run_code_unsafe` body. |
| `selftest.mjs` | Known workload (50 close + 50 keep-alive requests) to validate the sampler and the hook. |

`full-run.ps1` and `subset-run.ps1` name the worktree they ran in
(`$wt = ...`); point that at the worktree under test.
