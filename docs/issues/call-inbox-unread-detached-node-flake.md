---
id: call-inbox-unread-detached-node-flake
title: call-inbox-unread.spec.ts clicks a Mark-unread button that the inbox row swaps out from under it
type: bug
severity: low
status: open
area: e2e
created: 2026-08-23
refs: e2e/tests/dashboard-next/call-inbox-unread.spec.ts:155
---

**Sighting 3 (2026-08-24, soak R3, lane B) - AND IT ELIMINATES THE CONTAINER
EXPLANATION.** Same test, same signature verbatim: the All tab in its
READY-AND-EMPTY state ("No conversations yet") at the Mark-unread click, after
earlier steps proved the row present. This time the shared container was the
NEW tmpfs shape and demonstrably healthy - ~1GiB RSS, no stalls, and BOTH
sibling lanes (a full e2e and a full npm test) were green at that moment. So
the empty-partition read after a mark-read write is not GC-stall collateral:
it is a real app read-path behaviour, now THREE sightings, always this spec,
roughly 3 in the last 12 full runs. This is the strongest single datum yet for
C1's `mark-read-fanout-stale-gsi-skip` - a whole open-partition read answering
empty moments after the mark-read write path ran. Artifact preserved.


**ADJUDICATED 2026-08-24: this is C1 evidence, not a spec bug - the spec-side
"re-resolve the locator" remedy is WITHDRAWN.** Reading sighting 2's preserved
page snapshot changed the diagnosis:

- Sighting 2 is not a detached node. The failing click's page shows the All
  tab in its READY-AND-EMPTY state ("No conversations yet" - the UI renders
  errors as an alert, so this was a clean zero-row answer) AFTER earlier steps
  in the same test proved the row visible on that tab. The LEAN SEED'S OTHER
  CONVERSATIONS ARE MISSING TOO: a whole open-partition read (byLastActivity,
  status='open') answered empty right after a mark-read write, and with no
  further SSE event to trigger a refetch the list STAYED empty for the full
  30s budget. One bad read sticks until the next event.
- Sighting 1's shape ("element was detached, retrying" continuously for 30s)
  is the whole-page-refetch churn already filed as
  [`thread-hooks-refetch-whole-page-per-event`](./thread-hooks-refetch-whole-page-per-event.md):
  every event replaces every row, so under load a click never lands.

Both mechanisms live in the inbox READ PATH - the territory of C1's two open
highs ([`mark-read-fanout-stale-gsi-skip`](./mark-read-fanout-stale-gsi-skip.md),
[`unread-badge-request-round-trip-cost`](./unread-badge-request-round-trip-cost.md))
- and an empty-partition read moments after a mark-read write is exactly the
stale-GSI-image family the first of those describes. A spec that re-resolved
its locator would paper over rows vanishing and churning under a real user's
pointer.

ROUTED: stays open as C1 evidence for the inbox mission, with both preserved
artifacts named. Expected to close as a side effect of the C1 fixes; if it
recurs AFTER C1 lands, that is a new fact worth its own diagnosis.


**Sighting 2 (2026-08-24, `fix/test-suite-wave3` gate RE-run, 250/3, 27.4m).**
First recurrence since the 2026-08-23 measurement stamps: the Mark-read click timed out in the re-run. One occurrence in six full runs since filing, and only under the heaviest machine load yet observed.
IMPORTANT CONTEXT for both runs that day: the re-run raced a LIVE concurrent
feature mission on the same machine (a dozen Playwright MCP browser processes,
a live test-server, Codex runtimes), and the suite ran 27.4m against a healthy
21m baseline. All three failures in that run were already-filed load-sensitive
issues; treat sightings from it as heavy-load data points, not baselines.


**Measurement (2026-08-23, `fix/test-hardening-wave2`).** Did NOT reproduce.
Two full `npm run e2e` runs on the same commit: 251 passed / 2 failed (21.5m)
then 253 passed (19.0m). This spec passed in BOTH, as did every other issue on
the C6/C11 flake list. The two failures in run 1 were different specs, both new
and both filed separately.

Deliberately NOT closed on that. Two green runs cannot prove an intermittent
failure absent, and this issue's own history is of a spec that passes repeatedly
and then does not. Recorded so the next person has a dated data point rather
than a re-measurement to redo - and note the DynamoDB Local contention that
several of these were filed under has since been fixed, so a recurrence now
means something different than it did before.


**Problem.** Found by an adversarial review of `fix/test-suite-hardening`
(2026-08-23), in e2e run 1 of 2 on a branch that does not touch this spec:

```
locator.click: Test timeout of 30000ms exceeded.
  - waiting for getByRole('button', { name: 'Mark Caller Tester as unread' })
  - locator resolved to <button ...>Mark unread</button>
  - attempting click action
  - element was detached from the DOM, retrying
```

The inbox row re-renders and replaces the button node between the locator
resolving and the click landing, so Playwright retries against a detached
element until the 30s budget dies.

**This is a KNOWN mechanism with prior art in this repo.** It is the same
detached-node failure diagnosed and fixed in
`dashboard/src/routes/tours/ScheduleTourForm.test.tsx` on 2026-08-21
([`schedule-tour-form-test-flake`](./schedule-tour-form-test-flake.md)): a node
captured or resolved before an async re-render is stale by the time it is used,
and the symptom reads as "the thing never appeared" rather than "I was holding
the wrong node". Worth reading that resolution first - it cost a wrong
root-cause guess ("a mount-ordering race") before the real one was found.

**Not on the AGENTS.md known-flake list**, so anyone who hits it has no
sanctioned re-run and will likely mis-blame their own branch.

**Suggested fix.** Re-resolve inside the retry rather than clicking a
pre-resolved locator - Playwright auto-retries the locator if the click is
driven from `page.getByRole(...)` directly at click time, or wrap in
`expect.poll` / a `waitFor` that re-queries. If the row's re-render is itself
avoidable (an SSE-driven refetch that could apply a delta instead of replacing
the row), that is the better fix and belongs with
[`thread-hooks-refetch-whole-page-per-event`](./thread-hooks-refetch-whole-page-per-event.md).

One sighting so far. Re-run before blaming a change.
