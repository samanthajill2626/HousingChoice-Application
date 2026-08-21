---
id: pending-roster-actions-uncapped-walker
title: pendingRosterActionsRepo has its own uncapped queryAll - the one walker that can spin forever
type: debt
severity: med
status: open
area: app
created: 2026-08-21
refs: app/src/repos/pendingRosterActionsRepo.ts:321, app/src/lib/dynamoPaging.ts
---

**Problem.** `pendingRosterActionsRepo.ts:321` defines a private `queryAll` that
walks `LastEvaluatedKey` in an unbounded `do…while (exclusiveStartKey !==
undefined)` - **no page cap**. A cursor that never nulls out (a DynamoDB fault, a
pathological key, a bug in a future index change) loops until the process dies or
the request times out.

Found by adversarial review of `fix/pagination-sweep` (2026-08-20). Pre-existing
and deliberately left out of that branch's scope.

Two things make it worth filing rather than shrugging at:

1. **Name collision with different guarantees.** `app/src/lib/dynamoPaging.ts`
   now exports a shared `queryAll` that IS capped (100 pages) and warns on a cap
   hit. Two functions, one name, opposite safety properties - a reader who has
   met the shared one will assume this one is bounded.
2. **It is the exception to a claim the codebase now makes.** That branch folded
   `toursRepo`, `listingSendsRepo` and `conversationsRepo`'s participant finders
   into the capped shared helper and its comments describe a single walker. This
   is the fourth, and the only one that can actually spin without limit.

Not known to have caused an incident. The realistic trigger is an unbounded loop
under a fault, not silent truncation - the opposite failure mode from the one the
pagination sweep was about, which is partly why it was missed.

**Suggested fix.** Replace the private helper with `queryAll` from
`lib/dynamoPaging.ts` (same signature shape; it takes a `QueryCommandInput` and
returns `T[]`), so the cap and the cap-hit warning come along with it. Check
whether any caller relies on getting genuinely everything past 100 pages before
adopting the cap - if one does, that caller wants a bounded contract of its own,
not an uncapped walk.

Related: the shared walkers introduced on `fix/pagination-sweep`
(`dashboard/src/api/paging.ts`, `app/src/lib/dynamoPaging.ts`).
