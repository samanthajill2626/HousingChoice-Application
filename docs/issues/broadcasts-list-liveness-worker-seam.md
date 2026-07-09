---
id: broadcasts-list-liveness-worker-seam
title: "Broadcasts LIST page has no polling fallback - deployed rows can sit at 'Sending' until a DLR emit or manual refresh"
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-09
refs: dashboard/src/routes/broadcasts/useBroadcastsList.ts:118, app/src/lib/events.ts:5
---

**Problem (review note, 2026-07-09 - pre-existing, surfaced by the live-progress
feature).** The broadcast DETAIL page now polls while a broadcast is 'sending'
(the deployed-worker liveness fallback), but the LIST page relies purely on
broadcast.updated SSE. In DEPLOYED envs the fan-out - including finalize's
markSent emit - runs in the worker process, whose events never reach the app's
SSE clients (the documented single-instance seam in lib/events.ts). So a list
row can keep showing "Sending" after the broadcast finished, until a DLR-rollup
emit (webhook = app process) or a manual refresh flips it. Locally everything
is in-process, so the gap is invisible in dev.

This predates the live-progress feature (not a regression); filing because the
detail page is now demonstrably live while the list is not, which reads as a
bug to an operator with both open.

**Suggested fix.** Mirror the detail page's S3 pattern: while any visible row
has status 'sending', poll the list endpoint on a modest interval (say 5-10s),
stopping when no row is sending. Alternatively (broader fix, same seam): bridge
worker-process events to the app's SSE bus (the lib/events.ts seam note - e.g.
DynamoDB streams), which would fix every worker-emitted event class at once.
