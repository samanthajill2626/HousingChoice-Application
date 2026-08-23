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
