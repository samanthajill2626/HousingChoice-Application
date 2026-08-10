---
id: seed-messages-missing-created-at
title: Lean seed messages omit created_at
type: bug
severity: low
status: open
area: e2e/seed
created: 2026-08-08
refs: app/src/lib/seed/lean.ts:192, app/src/repos/messagesRepo.ts:888
---

**Problem.** The lean seed's tenant-conversation messages carry `ts` but not `created_at`, while production stamps `created_at` on every appended message. Code comparing `created_at` sees `undefined` for those seed rows. The extraction window's 30-day comparison consequently excludes all seeded messages as `age_30d`.

**Suggested fix.** Change the byte-stable lean seed only in a dedicated change with the full shared-e2e regression sweep. This issue does not change the seed because it is shared by every E2E scenario.
