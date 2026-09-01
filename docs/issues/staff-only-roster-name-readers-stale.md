---
id: staff-only-roster-name-readers-stale
title: Three staff-only strings still render the stored roster name instead of the contact's
type: debt
severity: low
status: open
area: app
created: 2026-09-01
refs: app/src/services/groupSend.ts:252, app/src/services/relayGroupDuplicates.ts:128, app/src/routes/poolNumbersAdmin.ts:108
---

**Problem.** `feat/participant-snapshot-refresh` moved every operator-facing
roster surface onto read-time name resolution (`app/src/lib/participantNames.ts`,
one `getDisplaysByIds` batch per page). Three readers were deliberately left on
the stored `participants[].name` snapshot, so a contact renamed after the group
was built still reads under their OLD name - or their phone number - in:

- `app/src/services/groupSend.ts:252` `memberLabel`, the label inside the group-send
  REFUSAL strings a navigator sees (`GroupMemberDeletedError` at `:123`,
  `GroupMemberNoConsentError` at `:132`; thrown at `:329` and `:344`). Falls back
  to the raw `member.phone`, never a formatted one.
- `app/src/services/relayGroupDuplicates.ts:128`, the `memberNames` on the
  duplicate-open-group warning, built by walking `rosterMembers` (`:68`) - the
  same walk the duplicate match was made on. Its fallback IS formatted
  (`formatPhoneForDisplay(m.phone) ?? m.phone`).
- `app/src/routes/poolNumbersAdmin.ts:108` `serverLabel`, the pool-numbers admin
  row label. It reaches the snapshot through `relayMemberLabels`
  (`app/src/lib/groupTitle.ts:89`) with `trimNames` off, which is a deliberate
  difference from the inbox/push chain - see that function's SCOPE GUARD
  docblock before touching it.

All three are staff-only strings on non-hot paths (a refusal, an admin list, a
duplicate-group warning), which is why they were scoped out rather than
forgotten. See the "NOT covered" list in
[`group-roster-name-snapshot-never-refreshed`](./group-roster-name-snapshot-never-refreshed.md).

Severity is `low` because none of it reaches a tenant or a landlord: the worst
case is a navigator reading a stale name in a refusal or an admin row while the
inbox, the contact page and the group header beside it show the current one.
That inconsistency is the actual cost.

**Suggested fix.** `withLiveNames` over the roster with one `getDisplaysByIds`,
per `app/src/lib/participantNames.ts` - the same shape the in-scope surfaces
use. Two things to preserve, both load-bearing:

1. The chain stays live contact name -> stored snapshot -> phone. A short batch
   (a throttled `getDisplaysByIds` returns a SHORT map, never an error) must
   degrade to today's stored name, not to a phone number.
2. Each site's FALLBACK is its own and must not be homogenized: `groupSend`
   deliberately uses the raw number, `relayGroupDuplicates` a formatted one, and
   `serverLabel` does not trim member names. They are pinned by their own tests.

The three are not equally cheap, and only the first is obviously worth doing:

- **`groupSend` costs NOTHING and needs no batch.** The refusal loops at
  `:322` and `:331` already destructure `{ member, contact }` from `resolved`
  (`:319-321`, one `findByPhone` per member on that path anyway), so the contact
  is IN HAND at both throw sites. Give `memberLabel` the contact and prefer
  `contactDisplayName(contact)` over `member.name`. No new read, no new
  dependency.
- **`relayGroupDuplicates` needs a new dependency.** `findOpenGroupWithSamePhones`
  takes `{ conversations, log }` only - no contacts repo - and its contract is
  NEVER THROWS (see the docblock at `:160-168`), so any read added inside it has
  to sit within that boundary and degrade to the stored names rather than
  escape. It walks up to two partitions of groups, so batch across the whole
  walk, not per group.
- **`poolNumbersAdmin` buys the least.** `serverLabel` is synchronous over one
  conversation; hydrating the admin list means a batch on a route nobody reads
  under load. Do it last, or not at all.
