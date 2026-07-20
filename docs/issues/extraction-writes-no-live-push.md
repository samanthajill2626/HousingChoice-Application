---
id: extraction-writes-no-live-push
title: Worker-side extraction results need a page refresh - no live SSE push
type: improvement
severity: low
status: open
area: app
created: 2026-07-20
refs: app/src/lib/events.ts:5, app/src/jobs/extraction.ts:10
---

**Problem.** AI-extraction results written by the WORKER process (the normal
production path - the poller claims a due row and applies writes/suggestions)
do not appear on an open dashboard page until the user refreshes. Observed
live on dev 2026-07-20 during the first successful end-to-end smoke test:
the housingAuthority write landed in DynamoDB with ai provenance, but the
open contact page did not update.

Root cause is the documented single-instance SSE seam (events.ts header):
the event bus is in-process, so a `suggestion.updated` emitted in the worker
never reaches app-process SSE clients. The live-update paths that DO work are
the in-app ones (accept/dismiss responses applied in place; the dev tick).
This was a declared v1 limitation of conversation-fact-extraction (spec +
handback both note it); this issue exists because the gap is now OBSERVED
user-facing behavior, not just a code comment.

**Suggested fix.** The events.ts header names the upgrade: a cross-process
event bridge (DynamoDB Streams on the touched tables -> app-process re-emit,
or a lightweight worker->app HTTP notify). Scope it as its own small slice;
it would also un-gap every other worker-side emit (tour reminders, placement
nudges, voice transcript persistence via the reconcile job leg).
