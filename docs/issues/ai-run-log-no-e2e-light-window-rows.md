---
id: ai-run-log-no-e2e-light-window-rows
title: AI run log E2E cannot produce populated light windows
type: debt
severity: low
status: wontfix
area: e2e/ai-run-log
created: 2026-08-08
resolved: 2026-08-24
refs: app/src/repos/extractionRepo.ts:231, e2e/tests/dashboard-next/ai-run-log.spec.ts:1
---

**Wontfix (2026-08-24), with the reasoning on record.** The populated LIGHT
window requires the `no_new_client` skip, and that state is STRUCTURALLY
unreachable end-to-end: a due row only arms on an inbound client message -
which satisfies the freshness gate, so the tick that claims it runs FULL - and
`claim()` removes `_duePartition`/`dueAt`, so a second tick finds nothing due.
Manual triggers bypass the gate by design. Reaching the state would mean
building a new dev seam whose only purpose is to fabricate a due row without
client content - test scaffolding for a UI table whose populated shape is
already pinned by the extraction-job unit suite.

The e2e keeps the reachable LIGHT shape (`empty_window`). REOPEN IF a real
scheduler path ever starts producing `no_new_client` rows (e.g. a re-arm
without fresh content) - at that point the state is reachable for free and the
assertion should ride the path that made it so.


**Problem.** A populated LIGHT window needs the `no_new_client` skip, but it is not E2E-reachable: `claim()` removes `_duePartition` and `dueAt`, so a second extraction tick finds no due row. The scheduler paths either contain freshness-gate-satisfying content or bypass that gate.

**Deviation.** The E2E covers `empty_window`, the reachable LIGHT shape with no message rows. The extraction-job unit test covers the populated `no_new_client` case.
