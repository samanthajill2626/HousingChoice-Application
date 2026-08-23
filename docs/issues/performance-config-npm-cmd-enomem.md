---
id: performance-config-npm-cmd-enomem
title: Windows perf config subprocess can fail from uv_os_get_passwd ENOMEM
type: bug
severity: med
status: open
area: e2e
created: 2026-08-21
refs: e2e/performance/config.test.ts:431
---

**Problem.** The `real npm argv forwarding` test invokes npm through `cmd.exe` and currently exits 1 on Windows in the feature worktree and the untouched base commit. The equivalent direct `npm run --silent perf:pages -- hermetic --scale=7 --print-config` command reports `ERR_SYSTEM_ERROR` from `uv_os_get_passwd` with `ENOMEM`, before the performance script can parse or print its configuration. The test assertion records only the nonzero child exit, so the environment failure is not visible in its standard failure output. This blocks the aggregate `npm test` gate even though the feature does not touch the performance runner.

**Suggested fix.** Preserve the argv-forwarding coverage, but surface bounded child stderr when the child exits nonzero and investigate why the Node or tsx temporary-directory lookup exhausts its Windows user-info call. Confirm the repaired test at a detached base before treating it as feature work.
