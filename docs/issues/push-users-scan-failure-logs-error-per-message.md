---
id: push-users-scan-failure-logs-error-per-message
title: A permanently failing users-table Scan logs one ERROR per inbound message with no backoff
type: improvement
severity: low
status: resolved
area: app/push
created: 2026-08-17
resolved: 2026-08-25
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

**Resolution (2026-08-25).** The suggested floor shipped on `feat/log-hygiene`,
at the upper end of the proposed range. `services/pushService.ts` `sendToAll`
gains `REFRESH_RETRY_FLOOR_MS = 30_000`, a `lastRefreshAttemptAt` closure
variable beside `usersCache`, and a `refreshInFlight` promise beside that. A
`listAll()` refresh is attempted only when
`now() - lastRefreshAttemptAt >= REFRESH_RETRY_FLOOR_MS`, and the stamp is
written on EVERY attempt, success or failure, immediately BEFORE the attempt
starts. Inside the floor the call serves the cached list when it is still inside
the 5-minute stale bound (that stale-serve line drops to `debug`); past the bound
the broadcast is dropped with a `debug` line. The first failure in each window
keeps its original WARN/ERROR, so the give-up class still reaches the error-log
alarm exactly as the 436c0388 precedent requires. `fetchedAt` is still never
advanced on failure, so the refresh is retried and the cached list keeps ageing
toward the stale bound. Nothing clears the stamp on a success and nothing needs
to: the 60s cache TTL is longer than the 30s floor, so by the time a
post-success refresh is due the stamp is always older than the floor and the
Scan runs immediately. KEEP THAT ORDERING - a TTL below the floor, or a floor
above the TTL, would let a stale stamp fence a refresh that follows a success.
The floored branch early-returns or falls through like the existing catch arms,
so the `usersCache` narrowing below it still holds, and the existing injectable
`now` seam drives the tests.

STAMPING BEFORE THE AWAIT FENCES IN-FLIGHT ATTEMPTS, SO THE FLOORED CALLER JOINS
RATHER THAN GUESSES. A first cut stamped only on failure, to stop a cold-start
caller from being dropped while the very first Scan was still running. A
re-review reproduced what that cost: five calls arriving during ONE slow FAILING
`listAll` each started their own Scan and logged their own ERROR, inside one
instance inside one 30s window - the flood this issue is named for, handed back
for the whole latency of every failing attempt, and a slow failure (throttle,
timeout) is the realistic shape of a users-table outage. The shipped design keeps
the pre-await stamp and makes the fence safe instead of removing it: the attempt
is published as `refreshInFlight` before it is awaited, and a floored caller that
can see one awaits it and re-reads the cache. The attempter's own continuation -
the line that assigns `usersCache` - is scheduled ahead of the join, so the join
wakes to the settled cache state. A concurrent caller therefore never starts a
second Scan, never logs a second line, and is never dropped: it fans out to
whatever the shared attempt fetched, or takes the same zeroed drop the attempter
took.

HONEST BOUND, because the issue's complaint was volume: ONE Scan attempt and ONE
ERROR/WARN per 30-second window PER SERVICE INSTANCE, with concurrent callers
joining rather than adding to either count. There are roughly six
`createPushService` sites per process, so a users-table outage produces up to
about six lines per 30-second window per process instead of one line per inbound
message - a large reduction, not a guarantee of one. Hoisting the state to module
scope would give the exact one-per-window guarantee and was REJECTED: it breaks
per-test cache isolation.

Two existing pushService cases needed their fake clocks advanced past the new
floor (to t=91_000 and t=330_000) before they could observe the behavior they
pin; both are clock corrections, not weakened assertions, and the red run before
the fix failed on exactly those two. One follow-up is owed to whoever next owns
the refresh catch arms: the stale-serve arm's comment still says "the very next
send retries the refresh", which the floor makes up to 30s late. The correction
was written into the new `REFRESH_RETRY_FLOOR_MS` doc comment directly above the
block rather than inside the arm, to keep the arm byte-identical; it should be
folded into the arm and the pointer dropped.
