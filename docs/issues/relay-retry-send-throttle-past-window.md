---
id: relay-retry-send-throttle-past-window
title: A relay 30003 retry can go out past the 15-minute send window while it waits on the send throttle
type: bug
severity: low
status: open
area: app/messaging-relay
created: 2026-09-24
refs: app/src/jobs/relayRetryLeg.ts:575, app/src/jobs/relayFanOut.ts:1360, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
---

**Problem.** `feat/retry-send-window` stops automatic 30003 retries once the
original message is more than 15 minutes old. The relay job checks the window as
its last gate and then calls `sendOneRelayLeg`, which waits on an unbounded
`tokenBucket.acquire(1)` before sending (`app/src/jobs/relayFanOut.ts:1360`). A
long throttle - a busy pool number, or a burst of fan-out traffic - can therefore
push a retry that passed the gate past the window, which the invariant forbids.
The wait is normally seconds, so a real overrun needs a heavily throttled send
path.

Also recorded here, the one late case the relay claim still logs at ERROR where a
human-action WARN would fit: a late 30003 for a member who has opted out, or whose
number changed, is declined as `window_closed` (ERROR), because those two gates
are not visible at the claim without extra reads. A closed group and a removed
member are checked there and log WARN.

**Suggested fix.** Bound the acquire (a deadline equal to the window's end), or
re-check the window after the acquire and close the rung with
`retry_window_closed` instead of sending.
