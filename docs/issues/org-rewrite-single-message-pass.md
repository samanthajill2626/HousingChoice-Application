---
id: org-rewrite-single-message-pass
title: An organization-name rewrite runs its whole pass inside ONE queue message - seconds today, but it holds the worker and can outlast the visibility timeout as the data grows
type: improvement
severity: low
status: open
area: app/jobs
created: 2026-10-07
refs: app/src/jobs/orgRewrite.ts:94-101, app/src/adapters/sqsJobConsumer.ts:129, infra/modules/jobs/main.tf:36
---

**Problem.** The `org.rewrite` job (rename, merge and the Settings "Not on the list"
actions) runs every pass of a rewrite in one handler call (`app/src/jobs/orgRewrite.ts:94-101`):
each pass reads every contact of every type and every unit, with a conditional write and an
audit event per record it rewrites. The SQS consumer awaits the whole batch before it polls
again (`app/src/adapters/sqsJobConsumer.ts:129`), so on the single worker every other job -
sends included - waits for the pass, and a pass longer than the queue's 120-second
visibility timeout (`infra/modules/jobs/main.tf:36`) is delivered again. That is safe by
design (each record write is conditional, and the job checks the rewrite id), but the counts
then split between two runs. At today's volume a pass takes seconds. Code review R1-ADV-BE-5
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R1-ADV-BE.md`), ruled to
file rather than fix. Filed during the clean-org-names build (`feat/clean-org-names`).

**Suggested fix.** When the data grows, run the pass in chunks: a page (or a time budget) per
message, then enqueue a continuation carrying the rewrite id, the field and the cursor - the
relay and broadcast fan-out precedent - and keep heartbeating `lastRewrite` across the
continuations.
