---
id: call-inbox-unread-detached-node-flake
title: call-inbox-unread.spec.ts clicks a Mark-unread button that the inbox row swaps out from under it
type: bug
severity: med
status: resolved
area: e2e
created: 2026-08-23
resolved: 2026-08-24
refs: e2e/tests/dashboard-next/call-inbox-unread.spec.ts:155, dashboard/src/routes/inbox/useInbox.ts
---

**Resolution (2026-08-24, `feat/inbox-unread-read-path` @52ebafc8). NOT the
read path, and not a spec bug: `useInbox` installed a page it fetched for a
filter the operator had already left.**

Reproduced deliberately - iteration 38 of a 150-repeat soak of this one test on
a QUIET machine, roughly 3 minutes - and diagnosed with server-side read
accounting added for the purpose (`360c5a6d`). The app served a FULL page on
every `filter=all` request in the failing iteration while the browser rendered
"No conversations yet":

```
-28553ms  ASSEMBLED all     count=4 rawScanned=2   <- All tab fetch; row visible
-28395ms  ASSEMBLED unread  count=0                <- lands INTO the All tab
   ...    28 seconds of silence, then the click times out
```

The request that emptied the list came from the BROWSER (Chrome user-agent),
not the test's API helper, and it was `?filter=unread`. `scheduleRefetch`
closes over the `fetchFirstPage` of whichever filter was active when the SSE
event arrived; nothing cancelled it on a filter change (the clearing effect had
EMPTY deps, so it ran only on unmount), and `fetchFirstPage` committed whatever
it fetched with no filter-identity check. Mark-read on Unread fires
`conversation.updated`, the operator switches to All inside the 300ms debounce,
the stale reconcile lands, and because mark-read has just emptied the unread
feed it installs ZERO rows. One bad page sticks until the next event arrives.

Operator-visible, not a test artifact: mark a row read on Unread and switch to
All within 300ms and the tab goes blank.

**One defect explains all three signatures.** Sighting 1's detached-node retry
and sightings 2 and 3's ready-and-empty snapshot are the same event seen at
different moments - the node detaches BECAUSE the list is replaced by an empty
one - and the reproduction exhibits both signatures simultaneously.

Stated precisely, because the distinction is the kind this file has already got
wrong once: that shows the mechanism is SUFFICIENT to produce all three, not
that sighting 1 - a different branch, under different load - provably WAS this
rather than the `thread-hooks-refetch-whole-page-per-event` churn it was
originally attributed to. Sightings 2 and 3 are matched by artifact; sighting 1
is attributed by inference. What actually carries the claim is the soak,
250/250 after the fix against 1-in-38 before, together with the observation
below that the defect fires on every iteration and only FAILS when the unread
feed happens to be empty.

**Why it is always this spec:** it is the only one that marks a row read on the
Unread tab and switches to All immediately afterwards. The defect fires on
every iteration - passing runs show the same stale `unread` fetch replacing the
All list - but it only FAILS when mark-read has just emptied that feed, so the
stale page has no rows.

Verified by re-soaking the same spec after the fix: **250/250 passed, 15.2m,
zero failures**, against a pre-fix rate of 1 in 38.

**FOUR claims below are now DISPROVEN**, left standing rather than edited out
because the reasoning that produced them is instructive - but marked here
because two of them route to a still-OPEN high and would otherwise read as live
evidence for it. Each is flagged inline at its own paragraph as well.

1. Sighting 3: "a whole open-partition read (byLastActivity, status='open')
   answered EMPTY". It did not. The server served full pages throughout.
2. Sighting 3: "This is the strongest single datum yet for C1's
   `mark-read-fanout-stale-gsi-skip`."
3. The routing note: "an empty-partition read moments after a mark-read write
   is exactly the stale-GSI-image family the first of those describes."
4. Sighting 2: the same empty-open-partition-read claim, in the sighting-2
   wording.

**2 and 3 matter most.** `mark-read-fanout-stale-gsi-skip` is still open and is
the anchor of the C1 mission's section 3.1. A planner reading this file for
evidence must not take a disproven premise as support for the high they are
about to build. That high is real on its own merits; it never had support from
here.

**What is NOT wrong, and was nearly mislabelled:** sighting 3's elimination of
the CONTAINER explanation was correct, and this branch's diagnosis vindicates
it - the cause was a client-side bug, so a healthy tmpfs container was never
implicated. Only the "app READ PATH" half of that sentence is wrong. Do not
re-open the container hypothesis on the strength of this correction.

The lesson the fix's own commit records: this repo's e2e runs discarded the app
log entirely (Playwright's webServer does not capture the launcher's stdout),
so three sightings produced no evidence capable of distinguishing a client bug
from a server one. `E2E_CHILD_LOG_DIR` now exists, and AGENTS.md's e2e section
documents it, so the next intermittent failure can be chased with a server-side
log instead of an inference.

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

> **[DISPROVEN 2026-08-24 - see the Resolution at the top.]** The
> open-partition read never answered empty; the server served full pages
> throughout, and the emptying came from the client. This paragraph is NOT
> evidence for `mark-read-fanout-stale-gsi-skip`. The container elimination in
> the same paragraph is correct and stands.


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

  > **[DISPROVEN 2026-08-24 - see the Resolution at the top.]** The READ was
  > never empty. "One bad page sticks until the next event" was exactly right
  > and the most useful sentence in this file - it just describes a page the
  > CLIENT installed, not one the server sent.
- Sighting 1's shape ("element was detached, retrying" continuously for 30s)
  is the whole-page-refetch churn already filed as
  [`thread-hooks-refetch-whole-page-per-event`](./thread-hooks-refetch-whole-page-per-event.md):
  every event replaces every row, so under load a click never lands.

  > **[CONTESTED 2026-08-24 - see the Resolution at the top.]** The stale-filter
  > page produces this identical signature, and the fix for it took the spec
  > from 1-in-38 to 250/250. Sighting 1 left no artifact that settles which
  > mechanism it was, so it is attributed by inference, not proven either way.

Both mechanisms live in the inbox READ PATH - the territory of C1's two open
highs ([`mark-read-fanout-stale-gsi-skip`](./mark-read-fanout-stale-gsi-skip.md),
[`unread-badge-request-round-trip-cost`](./unread-badge-request-round-trip-cost.md))
- and an empty-partition read moments after a mark-read write is exactly the
stale-GSI-image family the first of those describes. A spec that re-resolved
its locator would paper over rows vanishing and churning under a real user's
pointer.

> **[DISPROVEN 2026-08-24 - see the Resolution at the top.]** Neither mechanism
> was in the read path, and this paragraph is NOT support for
> `mark-read-fanout-stale-gsi-skip`, which remains open on its own separate
> evidence. The last sentence, though, was the right instinct and is why this
> was never papered over with a locator retry: rows really were vanishing under
> the pointer - in the client.

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
