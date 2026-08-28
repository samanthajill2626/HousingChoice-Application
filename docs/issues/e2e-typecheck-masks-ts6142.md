---
id: e2e-typecheck-masks-ts6142
title: E2E workspace typecheck masks a TS6142 failure
type: bug
severity: med
status: open
area: build/typecheck
created: 2026-08-28
refs: e2e/tsconfig.json, dashboard/src/api/index.ts:8, dashboard/src/api/useEventStream.ts:13
---

**Problem.** The root `npm run typecheck` command can exit zero after its
`@housingchoice/e2e` workspace script exits two. The e2e compiler reaches
`dashboard/src/api/EventStreamProvider.tsx` through dashboard API imports while
the e2e TypeScript configuration has no JSX setting, producing TS6142. That
makes a red child typecheck easy to miss in an otherwise successful-looking
root command.

This was reproduced on 2026-08-28 from a branch whose e2e configuration and
referenced dashboard API files are unchanged from `main`.

**Suggested fix.** Decide whether the e2e workspace should typecheck the
dashboard source transitively. Then either give that intentional compile graph
the correct JSX configuration or narrow the graph, and make the root typecheck
script propagate every workspace failure.
