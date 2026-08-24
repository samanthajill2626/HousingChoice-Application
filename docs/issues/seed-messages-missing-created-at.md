---
id: seed-messages-missing-created-at
title: Lean seed messages omit created_at
type: bug
severity: low
status: resolved
area: e2e/seed
created: 2026-08-08
resolved: 2026-08-24
refs: app/src/lib/seed/lean.ts:192, app/src/repos/messagesRepo.ts:888
---

**Resolution (2026-08-24, `fix/test-suite-wave3`).** Every lean-seed message row
now stamps `created_at` from the same instant as its `ts`, matching the
production invariant (messagesRepo.append stamps every appended message).

The defect was quieter and worse than filed: `undefined` fails BOTH sides of
the 30-day comparison (`undefined >= cutoff` and `undefined < cutoff` are both
false), so seeded rows did not show as `age_30d` exclusions - they VANISHED
from the run window entirely, in neither `fresh` nor `excluded`. With real
timestamps they appear honestly as `age_30d` (the fixed 2026-06-01 dates are
permanently >30d behind any present wall clock, so that classification is
time-stable going forward).

Done as its own dedicated change per this issue's warning, with the full
shared-e2e sweep as the branch gate. Seed suites 19/19 at the change.


**Problem.** The lean seed's tenant-conversation messages carry `ts` but not `created_at`, while production stamps `created_at` on every appended message. Code comparing `created_at` sees `undefined` for those seed rows. The extraction window's 30-day comparison consequently excludes all seeded messages as `age_30d`.

**Suggested fix.** Change the byte-stable lean seed only in a dedicated change with the full shared-e2e regression sweep. This issue does not change the seed because it is shared by every E2E scenario.
