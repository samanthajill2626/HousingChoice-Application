---
id: performance-config-npm-cmd-enomem
title: Windows perf config subprocess can fail from uv_os_get_passwd ENOMEM
type: bug
severity: med
status: resolved
area: e2e
created: 2026-08-21
resolved: 2026-08-23
refs: e2e/performance/config.test.ts:431
---

**Resolution (2026-08-23, `fix/test-suite-wave3`): environmental, with the
suggested diagnosability fix applied.** Does not reproduce on current main:
40/40 solo, including `real npm argv forwarding`. `uv_os_get_passwd` returning
ENOMEM is the OS refusing a user-info lookup for lack of memory - machine
state, not code, and the same 2026-08-21 machine state explains the sibling
[`otel-child-boot-stdout-missing`](./otel-child-boot-stdout-missing.md).

The issue's own remedy was the durable part and is done: the exit-code
assertion now carries the bounded child stderr the test was already capturing
but never showing. Probed both stderr paths: npm's own errors are suppressed by
`--silent` (reported honestly as `(empty)`), while the child SCRIPT's stderr -
the path an ENOMEM crash takes - surfaces in the failure message
(`configuration_invalid` in the probe).

REOPEN IF it recurs with memory to spare - the failure will now name its cause.


**Problem.** The `real npm argv forwarding` test invokes npm through `cmd.exe` and currently exits 1 on Windows in the feature worktree and the untouched base commit. The equivalent direct `npm run --silent perf:pages -- hermetic --scale=7 --print-config` command reports `ERR_SYSTEM_ERROR` from `uv_os_get_passwd` with `ENOMEM`, before the performance script can parse or print its configuration. The test assertion records only the nonzero child exit, so the environment failure is not visible in its standard failure output. This blocks the aggregate `npm test` gate even though the feature does not touch the performance runner.

**Suggested fix.** Preserve the argv-forwarding coverage, but surface bounded child stderr when the child exits nonzero and investigate why the Node or tsx temporary-directory lookup exhausts its Windows user-info call. Confirm the repaired test at a detached base before treating it as feature work.
