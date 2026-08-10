---
id: ai-run-log-no-e2e-light-window-rows
title: AI run log E2E cannot produce populated light windows
type: debt
severity: low
status: open
area: e2e/ai-run-log
created: 2026-08-08
refs: app/src/repos/extractionRepo.ts:231, e2e/tests/dashboard-next/ai-run-log.spec.ts:1
---

**Problem.** A populated LIGHT window needs the `no_new_client` skip, but it is not E2E-reachable: `claim()` removes `_duePartition` and `dueAt`, so a second extraction tick finds no due row. The scheduler paths either contain freshness-gate-satisfying content or bypass that gate.

**Deviation.** The E2E covers `empty_window`, the reachable LIGHT shape with no message rows. The extraction-job unit test covers the populated `no_new_client` case.
