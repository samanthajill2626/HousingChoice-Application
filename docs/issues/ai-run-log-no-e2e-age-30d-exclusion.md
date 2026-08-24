---
id: ai-run-log-no-e2e-age-30d-exclusion
title: AI run log E2E does not assert age_30d exclusion
type: debt
severity: low
status: resolved
area: e2e/ai-run-log
created: 2026-08-08
resolved: 2026-08-24
refs: e2e/tests/dashboard-next/ai-run-log.spec.ts:1, app/test/extractionRunWindow.test.ts:1
---

**Resolution (2026-08-24): superseded, and the blocking hazard removed.** The
`age_30d` exclusion IS e2e-asserted - `manual-extraction-trigger.spec.ts`
plants a message with an aged `created_at` via the dev fixture seam and
asserts `<plantedTsMsgId>: age_30d` in the run detail's Excluded region,
alongside the negative half (the automatic run RAN and could not see the
plant). That spec postdates this issue and covers exactly what it asked for,
on a conversation the test owns rather than the shared seed.

The deviation's underlying hazard is also gone:
[`seed-messages-missing-created-at`](./seed-messages-missing-created-at.md)
was fixed the same day, so a seeded-conversation age_30d is now the feature's
intended behaviour, not a fixture artifact.


**Problem.** The AI run-log E2E asserts the real `char_budget` exclusion and `noContent`, but deliberately does not assert `age_30d`. Producing `age_30d` with the seeded conversation would assert the missing-`created_at` seed defect instead of the feature's intended behavior.

**Deviation.** Unit coverage in the extraction run-window suite separates the two exclusion causes. Fresh E2E fixtures all carry real `created_at` values, so the browser test remains a feature check rather than a fixture-artifact check.
