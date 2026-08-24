---
id: otel-child-boot-stdout-missing
title: Windows OpenTelemetry child boot test receives no stdout
type: bug
severity: med
status: resolved
area: app
created: 2026-08-21
resolved: 2026-08-23
refs: app/test/otel.test.ts:126
---

**Resolution (2026-08-23, `fix/test-suite-wave3`): environmental, with the
diagnosability half fixed.** Does not reproduce on current main: 10/10 solo,
including both named child-process tests, and the app suite has been green
through every full run since 2026-08-22. The 2026-08-21 sighting shares a gate
run with [`performance-config-npm-cmd-enomem`](./performance-config-npm-cmd-enomem.md),
whose child died in `uv_os_get_passwd` with ENOMEM - an OS resource error. One
machine out of memory explains both: a child that cannot fully spawn produces
empty stdout here and ERR_SYSTEM_ERROR there. Neither failure was a code defect.

What WAS a defect is that the test hid the evidence: on failure it reported
only `expected '' to contain 'OTEL_BOOT_OK'`, discarding spawnSync's status,
signal, error, and stderr - which is why the sighting cost a by-hand rerun and
still landed here as a mystery. Both assertions now carry all four fields.
Probed: pointing the spawn at a missing child fails with the module-not-found
stderr in the report.

REOPEN IF it recurs on a machine that is not under memory pressure - and note
the failure will now carry its own diagnosis.


**Problem.** `app/test/otel.test.ts` expects the unpatched child process to print `OTEL_BOOT_OK` in endpoint-set and endpoint-unset modes. On Windows, both tests currently receive empty stdout while the child exits successfully. The exact isolated failure reproduces at the recorded feature base commit, so it predates the environment-identity changes. It makes the root `npm test` gate fail with two tests despite the other eight OpenTelemetry tests passing.

**Suggested fix.** Inspect the child-process command and Windows stdout capture path, then prove the repair against the detached base and the aggregate app suite. Keep the test's unpatched-child coverage intact.
