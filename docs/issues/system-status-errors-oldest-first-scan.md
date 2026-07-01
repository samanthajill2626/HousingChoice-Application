---
id: system-status-errors-oldest-first-scan
title: System Status "recent errors" dropped the newest events on wide windows (oldest-first scan)
type: bug
severity: med
status: resolved
area: app
created: 2026-07-01
resolved: 2026-07-01
refs: app/src/adapters/cloudwatch.ts, app/src/services/systemStatus.ts, infra/modules/ec2/main.tf
---

**Problem.** The Settings → System Status "recent errors" panel read logs via
`FilterLogEvents` (`scanFiltered` in `app/src/adapters/cloudwatch.ts`), which pages
**oldest-first** from the window start with a bounded budget (5 pages / 500 events),
then sorts newest-first and slices. On any log group with history spanning the
window, the **newest matching events fall beyond the budget and are silently
dropped** — and *widening* the window makes it worse (the scan starts further back
and never reaches "now"). Discovered during OOM-visibility verification on dev: a V8
heap-OOM event showed on the **Last hour** window but vanished on **Last 24 hours /
Last 7 days**, while kernel OOM lines (in the brand-new `/hc/dev/system` group, which
only holds today's events) always showed. Confirmed empirically: the first page of a
7-day `FilterLogEvents` scan of `/hc/dev/app` returned 0 matches with a continuation
token, while the 1-hour scan returned the event on page 1. This also affected recent
**pino** errors on wide windows — not just OOM.

**Suggested fix.** Use CloudWatch Logs Insights (`StartQuery` → `GetQueryResults`)
with `sort @timestamp desc | limit N`, which returns the actual newest matches
regardless of window size.

**Resolution (2026-07-01).** `getErrors` now runs three CloudWatch Logs Insights
queries (`fields @timestamp, @message | filter <expr> | sort @timestamp desc | limit
N`) — pino errors on the app group, V8 heap-OOM across app+worker, kernel OOM on the
system group — via a new bounded `queryInsights` seam method (`StartQuery`, poll
`GetQueryResults`, best-effort `StopQuery` on timeout; epoch **seconds**; PII-safe
projection via the unchanged `projectErrorEvent`; source-synthesized OOM labels).
The oldest-first `scanFiltered` / `filterErrorEvents` / `filterEventsByPattern` and
their `FilterLogEvents` OOM patterns were removed. Insights needs IAM the role lacked
(`logs:StartQuery` scoped to `/hc/<env>/*`; `logs:GetQueryResults` + `logs:StopQuery`
on `*`, since those two are not resource-scopable) — added to the instance-role
policy in `infra/modules/ec2/main.tf`. The local short-circuit and degrade-safe
(`{ available:false }`) paths are preserved. Requires `terraform apply` (dev + prod)
to grant the IAM before the panel works, plus an app redeploy.
