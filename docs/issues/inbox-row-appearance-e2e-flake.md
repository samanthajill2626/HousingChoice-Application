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

**UPDATE 2026-08-24 - the C1 premise this was routed on is DISPROVEN, and this
issue is deliberately NOT closed with its sibling.**

[`call-inbox-unread-detached-node-flake`](./call-inbox-unread-detached-node-flake.md)
was resolved the same day, and the cause was not the read path at all: it was
`useInbox` installing a page fetched for a filter the operator had already left
(`feat/inbox-unread-read-path` @52ebafc8). "A whole open-partition read
answered empty" never happened - the server served full pages throughout.

The two halves of THIS issue now sit differently, and neither is verifiable
today:

- `inbox-markread.spec.ts` is PLAUSIBLY the same defect. It clicks Unread, then
  All, with inbound traffic in flight. A stale ALL page installed while the
  Unread tab is showing gets narrowed CLIENT-SIDE to unread rows only
  (`useInbox` applies `filter === 'unread' ? patched.filter(r => r.unreadCount > 0)`),
  so a page fetched before the inbound landed renders as no row at all - which
  is exactly this issue's symptom, and it sticks until the next event.
- `deleted-contact-resurfacing.spec.ts` is NOT explained by it. That spec
  reaches the inbox by `page.goto`, a fresh mount, where no timer survives to
  go stale.

It has not reproduced in 8+ full runs, including two heavily contended ones, so
neither half can be confirmed or refuted by re-running today. Closing it on the
resemblance would be guessing. It stays open with the mechanism named, and a
recurrence AFTER @52ebafc8 is now a much sharper datum than it was: if it is
the markread half, it should be gone; if it recurs there anyway, the stale-page
explanation is wrong and something else is live.

The original routing note is left below for the record.

**ROUTED TO C1 (2026-08-24) - stays open as inbox read-path evidence, not as a
spec flake.** "An inbound arrived and the row did not appear within 10s" is the
same read path as `call-inbox-unread-detached-node-flake`'s adjudicated
sighting (a whole open-partition read answering empty after a write) and sits
squarely under C1's two open highs. Both filed sightings predate the 2026-08
contention fixes and it has not reproduced in the 8+ full runs since,
INCLUDING two heavily contended ones - so there is nothing spec-side to fix
and nothing currently reproducing to chase. Expected to close with the C1
mission; a recurrence before then is fresh evidence for it.


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
