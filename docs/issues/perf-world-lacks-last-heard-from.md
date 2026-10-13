---
id: perf-world-lacks-last-heard-from
title: The performance seed never derives last_heard_from_at, so perf:pages times degenerate sorts
type: improvement
severity: low
status: open
area: e2e
created: 2026-10-13
refs: app/src/lib/seed/performance.ts:930, app/src/lib/seed/index.ts:151, app/src/lib/seed/heardFrom.ts
---

**Problem.** The performance world writes inbound messages but does not run
`deriveSeedHeardFrom` (the last-heard-from spec D13 excludes it on purpose: "a
load fixture, not a demo world"). So `npm run perf:pages` measures the Tenants
list (now sorted by last heard from by default), the contact header and the
Follow up surfaces in a world where every contact is "Never" and nothing is
waiting - representative of nothing (code review round 1, ADV-5).

**Suggested fix.** Run `deriveSeedHeardFrom` over the performance seed's tables
before its Put loop, and give the world a few planted listed sends, if timing
those surfaces matters.
