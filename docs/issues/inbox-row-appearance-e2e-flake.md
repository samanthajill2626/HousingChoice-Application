---
id: inbox-row-appearance-e2e-flake
title: Two dashboard-next specs intermittently time out waiting for an Inbox row to appear
type: bug
severity: low
status: open
area: e2e
created: 2026-08-13
refs: e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts:95, e2e/tests/dashboard-next/inbox-markread.spec.ts:17
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


**Problem.** Two specs intermittently fail in the FULL suite while passing in
isolation, both on the same shape of assertion - waiting up to 10s for a contact's
row to appear in `/inbox` after an inbound arrives:

- `deleted-contact-resurfacing.spec.ts:95` (run position 54) -
  `getByRole('link', { name: /Tasha Nguyen/ })` not visible after `sendAsParty`
- `inbox-markread.spec.ts:17` (run position 67) - same locator, same shape

Observed on `feat/thread-history-paging` at 8ec26930, a frontend-only branch that
touches conversation-thread paging and cannot reach the Inbox feed:

| run | result |
| --- | --- |
| full suite, run 1 | 230 passed / **2 failed** (these two) |
| full suite, run 2, same commit | **232 passed**, exit 0 |
| the two specs alone | **3 passed**, exit 0 |
| full suite at 4c9a592f (same branch, earlier commit) | 232 passed - both green at the SAME positions 54 / 67 |

The run ORDER was byte-identical across both full runs (232 tests, same positions);
the only diff between the two logs is these two tests flipping ok -> x. Both failing
positions run BEFORE any spec this branch added (position 131), so nothing the
branch introduced can be queued ahead of them within a run.

Both assertions wait on the same causal chain: an inbound posted through the fake
must be processed by the app and surface in the inbox feed within 10s. That budget
appears to be marginal under machine load (DynamoDB Local + MinIO + Chromium +
worker all resident), which is what makes it order-independent but
load-dependent.

Not added to the AGENTS.md known-flake list yet - two sightings of the same shape
on one machine is thin evidence. If it recurs on another branch, promote it there
so future missions re-run once and report both runs rather than re-diagnosing it
from scratch, as happened here.

**Suggested fix.** Two options, cheapest first:

1. Raise the two 10s budgets, or replace the bare `toBeVisible` wait with a poll on
   the inbox API until the conversation appears, then assert the row - the same
   pattern other specs use to avoid depending on a fixed processing window.
2. If the inbound-to-inbox path really can exceed 10s under load, that is worth
   measuring on its own rather than papering over with a longer timeout; the
   `thread-hooks-refetch-whole-page-per-event` issue is the natural neighbour, since
   the inbox feed is reassembled on the same event traffic.
