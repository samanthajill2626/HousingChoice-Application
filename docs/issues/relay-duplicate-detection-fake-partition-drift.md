---
id: relay-duplicate-detection-fake-partition-drift
title: The in-memory listRelayGroups double filters on status, the real repo queries relay_status
type: debt
severity: low
status: resolved
area: app
created: 2026-08-18
resolved: 2026-08-21
refs: app/test/helpers/twilioWebhookHarness.ts, app/test/relayPartitionFidelity.test.ts, app/test/contactRelayGroups.test.ts, app/src/repos/conversationsRepo.ts:1954
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** The double now filters
on `relay_status === 'relay_group#<status>'` - the field the real `byRelayStatus`
GSI hashes on, and the only field the real read consults.

**The predicted fallout arrived immediately, and was the point.** This issue was
filed rather than fixed because "correcting the fake means re-pointing a read
that every relay-group test in the suite goes through, and any row whose two
fields disagree today would change which tests see it". Re-pointing it turned
**8 tests in `contactRelayGroups.test.ts`** red at once.

Every one was the same cause: that file's relay fixture wrote `status` and
`type: 'relay_group'` but **never `relay_status`** - a row shape production
cannot produce, because the real writer stamps both in lockstep
(`conversationsRepo.ts:1875`). Those eight assertions had been made against a
row the service could never return. Fixed the FIXTURE (stamp `relay_status` in
lockstep) rather than loosening the double back.

**New guard: `app/test/relayPartitionFidelity.test.ts`.** Correcting the double
is a one-time event; nothing stopped the next person re-pointing either side at
`conv.status`. Three cases pin the two shapes the drift made
indistinguishable, plus a positive control so they cannot all pass against a
double that returns nothing:

- a CLOSED group that activity re-stamped `status: 'open'` (the exact
  `touchLastActivity` skew) must not appear in the open partition, and must
  appear in the closed one;
- a relay row with no `relay_status` at all is invisible to every relay read;
- a correctly-stamped group appears in its own partition, and only there.

Probed: reverting the double to the old `type`+`status` filter fails 2 of the 3
with `expected [ 'conv-skewed' ] to not include 'conv-skewed'`. Restored, and
the full app suite is **322 files / 5693 tests green**.

**Problem.** The two implementations of `listRelayGroups` answer the partition
question from DIFFERENT fields.

- The real repo Queries the sparse `byRelayStatus` GSI whose HASH is
  `relay_status`, bound to `relay_group#<status>`
  (`conversationsRepo.ts:1928-1958`). Nothing else is consulted.
- The in-memory double filters `c.type === 'relay_group' && c.status === status`
  (`twilioWebhookHarness.ts:731-738`), and its comment claims it "Mirrors the
  real repo".

Those two fields genuinely skew, and the detector's own header comment already
names the skew: `touchLastActivity` writes `status = 'open'` onto any non-
`group_text` conversation that receives activity and never touches
`relay_status` (`conversationsRepo.ts:1506-1534`; the fake reproduces this
faithfully at `:499-508`). So a CLOSED relay group that gets an inbound message
sits at `status: 'open'` with `relay_status: 'relay_group#closed'`. Every other
relay-group writer in the fake stamps `relay_status` in lockstep (`:783`,
`:810`), so it is the READ that drifts, not the rows.

The fake is therefore strictly MORE PERMISSIVE than production: it can return a
row the real GSI would never surface, and it can never return one the GSI would.

**Why it matters more now than it did.** Before duplicate detection, `partition`
was an internal detail. It is now user-visible copy - the confirm dialog picks
between "already have an open relay group" and "already have a relay group being
connected" from that value, and the whole rule "closed groups are NOT
duplicates" rests on which partition a row is in. Server-integration coverage of
that value runs against the fake, so the assertions are being made against
`status` rather than against the field production would have queried. A change
that broke the closed-groups rule in application code - re-pointing the detector
at `conv.status`, say - could stay green.

Concretely: a fixture with `status: 'open'`, `relay_status: 'relay_group#closed'`
and a matching roster renders a duplicate warning under the harness and returns
nothing in production.

**Not introduced by the duplicate-warning branch.** The drift pre-dates it; that
branch only made the drifting value load-bearing. Filed rather than fixed because
correcting the fake means re-pointing a read that every relay-group test in the
suite goes through, and any row whose two fields disagree today would change
which tests see it - unrelated failures on a change that is not what the branch
was for.

**Suggested fix.** Filter the fake on `c.relay_status === relayStatusKey(status)`
(the same helper the repo uses), then run the whole app suite and fix whatever
fixture only ever set `status`. Keep the lockstep writes the fake already has, so
the double cannot answer a question the real index would refuse.
