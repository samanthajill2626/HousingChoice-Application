---
id: ai-run-log-no-e2e-age-30d-exclusion
title: AI run log E2E does not assert age_30d exclusion
type: debt
severity: low
status: open
area: e2e/ai-run-log
created: 2026-08-08
refs: e2e/tests/dashboard-next/ai-run-log.spec.ts:1, app/test/extractionRunWindow.test.ts:1
---

**Problem.** The AI run-log E2E asserts the real `char_budget` exclusion and `noContent`, but deliberately does not assert `age_30d`. Producing `age_30d` with the seeded conversation would assert the missing-`created_at` seed defect instead of the feature's intended behavior.

**Deviation.** Unit coverage in the extraction run-window suite separates the two exclusion causes. Fresh E2E fixtures all carry real `created_at` values, so the browser test remains a feature check rather than a fixture-artifact check.
