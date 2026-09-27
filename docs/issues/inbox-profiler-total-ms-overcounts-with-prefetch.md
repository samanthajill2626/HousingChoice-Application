---
id: inbox-profiler-total-ms-overcounts-with-prefetch
title: The manual inbox profiler's totalMs sums overlapping reads since the all-tab prefetch, so it can exceed wall time
type: debt
severity: low
status: open
area: app/inbox
created: 2026-09-25
refs: app/scripts/profile-inbox.ts, app/src/lib/inboxDiagnostics.ts, app/src/routes/inbox.ts
---

**Problem.** `npm run perf:inbox` (`app/scripts/profile-inbox.ts`) calls
`aggregateInbox` (`:117`) without the `inboxPrefetch` deps seam, so since
`feat/inbox-rows-timestamps` (spec
`docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`, section
5.10) its `all-page` case runs the prefetch pass
(`app/src/routes/inbox.ts:2424`): up to `HYDRATE_CONCURRENCY` (8) per-row
read chains in flight at once, plus read-ahead the decision loop never
consumes. The other three page cases and the badge case never reach the
pager and are unaffected.

Every one of those reads goes through the timing proxies, and
`summarizeInboxTrace` (`app/src/lib/inboxDiagnostics.ts:144`) reports each
operation's `totalMs` as the SUM of its per-read durations (`:161`). Once
reads overlap, that sum can exceed the case's wall time (`durationMs`,
`profile-inbox.ts:147`), so the all-page totals no longer read as time the
request spent, and they are not comparable with a profile taken before the
prefetch. A chain still in flight when `aggregateInbox` returns also settles
after `durationMs` is taken: its events land in `trace.jsonl` and in the
summary under the finished case, but not in that case's printed "timed
calls" count.

**Suggested fix.** Pass `inboxPrefetch: false` in the profiler's deps for a
sequential profile, or keep the prefetch (it is what production runs) and
report wall time alongside the sum, naming `totalMs` as summed read time.
