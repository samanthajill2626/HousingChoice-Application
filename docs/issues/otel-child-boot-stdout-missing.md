---
id: otel-child-boot-stdout-missing
title: Windows OpenTelemetry child boot test receives no stdout
type: bug
severity: med
status: open
area: app
created: 2026-08-21
refs: app/test/otel.test.ts:126
---

**Problem.** `app/test/otel.test.ts` expects the unpatched child process to print `OTEL_BOOT_OK` in endpoint-set and endpoint-unset modes. On Windows, both tests currently receive empty stdout while the child exits successfully. The exact isolated failure reproduces at the recorded feature base commit, so it predates the environment-identity changes. It makes the root `npm test` gate fail with two tests despite the other eight OpenTelemetry tests passing.

**Suggested fix.** Inspect the child-process command and Windows stdout capture path, then prove the repair against the detached base and the aggregate app suite. Keep the test's unpatched-child coverage intact.
