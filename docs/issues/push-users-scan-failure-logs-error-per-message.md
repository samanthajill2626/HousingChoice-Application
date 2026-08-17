---
id: push-users-scan-failure-logs-error-per-message
title: A permanently failing users-table Scan logs one ERROR per inbound message with no backoff
type: improvement
severity: low
status: open
area: app/push
created: 2026-08-17
refs: app/src/services/pushService.ts, app/src/repos/usersRepo.ts
---

Found by the planner's plan-blind adversarial review of inbound-message-push
(2026-08-17); adjudicated FILE. It is the flip side of a deliberate choice:
a permanently broken Scan MUST reach the error-log alarm (the 436c0388
"give-up class" precedent), so pushService.sendToAll logs ERROR when listAll
fails with no cache, or when the cached list is past its 5-minute stale
bound. What is missing is a floor between attempts.

**The behavior.** During a users-table outage every inbound message calls
sendToAll, which retries `listAll()` on every call once the 60s TTL has
lapsed (the cache's `fetchedAt` is deliberately left unchanged on failure so
the next send retries). Inside the 5-minute bound that is a WARN per message
("fanning out to the cached list (stale)"); past it, an ERROR per message.
At team-scale inbound rates this is tens of lines per minute for as long as
the table is down - loud, but noisy rather than informative, and each retry
is a Scan attempt against a struggling table.

**Suggested fix.** A `lastAttemptAt` floor on the refresh (e.g. do not
re-attempt listAll more than once every 15-30s while the previous attempt
failed), keeping exactly ONE error line per failure window rather than one
per message. The alarm still fires (the first ERROR reaches it); the
subsequent noise and the retry pressure on the table go away. Not urgent:
the users table shares the same DynamoDB as everything else, so if it is
down the whole app is already alarming.
