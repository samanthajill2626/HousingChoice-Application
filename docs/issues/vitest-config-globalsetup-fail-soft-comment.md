---
id: vitest-config-globalsetup-fail-soft-comment
title: app/vitest.config.ts still calls the DynamoDB Local globalSetup fail-soft; it has been fail-loud since 2026-08-21
type: debt
severity: low
status: open
area: app/test
created: 2026-09-25
refs: app/vitest.config.ts:121-123, app/test/globalSetup.ts:14-17, app/test/globalSetup.ts:69-88
---

**Problem.** The comment above the `globalSetup` option in `app/vitest.config.ts`
(lines 121-123) says the setup is "Fail-soft: if Docker is down the setup warns
and returns; pure-unit runs are unaffected." That stopped being true on
2026-08-21: `app/test/globalSetup.ts` now FAILS every app vitest run when DynamoDB
Local is unreachable - pure unit files included - unless
`ALLOW_SKIP_DYNAMO_TESTS=1` (its lines 14-17 and 69-88). The stale comment misled
a plan draft for `feat/retry-send-window` into telling a builder that some suites
need no DynamoDB Local (caught in that branch's plan review round 1).

**Suggested fix.** Rewrite the comment to match `globalSetup.ts`: fail-loud unless
`ALLOW_SKIP_DYNAMO_TESTS=1`, which is a deliberate unit-only pass and not a
completion gate (AGENTS.md).
