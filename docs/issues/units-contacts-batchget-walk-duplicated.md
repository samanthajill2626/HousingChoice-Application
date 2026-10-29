---
id: units-contacts-batchget-walk-duplicated
title: unitsRepo.getDisplaysByIds copies contactsRepo's private BatchGet walk, so the two will drift
type: debt
severity: low
status: open
area: app
created: 2026-10-07
updated: 2026-10-29
refs: app/src/repos/unitsRepo.ts, app/src/repos/contactsRepo.ts, docs/superpowers/reviews/2026-10-06-tour-list/planner-review/adjudications.md
---

**Problem.** Two repos carry the same by-primary-key BatchGetItem walk:

- `contactsRepo`'s private `batchGetByIds` (`app/src/repos/contactsRepo.ts`),
  behind `getDisplaysByIds` and `getManyByIds`;
- `unitsRepo.getDisplaysByIds` (`app/src/repos/unitsRepo.ts`), added by
  feat/tour-list for the Tours page All tab's property names (spec
  `docs/superpowers/specs/2026-10-06-tour-list-design.md` section 5.6, which
  modeled it on the contacts walk).

Both de-duplicate the ids (BatchGetItem rejects a request with a repeated
key), read in 100-key chunks, retry `UnprocessedKeys` up to four attempts
with the same 25 ms doubling backoff, keep the chunks that succeeded, drop
what is still unread (or a chunk whose request threw) and log a WARN that
carries counts, never an id (plus the error, for a chunk that threw). Only
the key name, the projection and the log prefix differ; the
contacts walk also has the `requireComplete` mode (throw
`IncompleteBatchReadError` instead of dropping) that the units walk lacks.

A copy drifts: a fix to one walk (the backoff, the attempt count, a
`requireComplete` caller for units, a log field) will not reach the other.

A shared helper was deferred during the mission, on the premise that the
parallel branch feat/clean-org-names edits `contactsRepo.ts`. Its edits are
far from `batchGetByIds`, so the refactor can follow either branch (planner
review round 2, ADV-F5 - REJECT became DEFER; record:
`docs/superpowers/reviews/2026-10-06-tour-list/planner-review/adjudications.md`).
A `TODO(units-contacts-batchget-walk-duplicated)` marker sits at
`unitsRepo.getDisplaysByIds`.

**Suggested fix.** One helper in `app/src/lib/` (beside `dynamoPaging.ts`)
taking the document client, the table, the key attribute, an optional
projection, the logger and `requireComplete`, returning a `Map` keyed on the
key attribute. `contactsRepo.batchGetByIds` and `unitsRepo.getDisplaysByIds`
call it; their existing tests (`app/test/contactsBatchReads.test.ts`,
`app/test/unitsRepoDisplays.test.ts` and the two repos' DynamoDB Local
integration files) pin the behavior through the move. Land it after feat/clean-org-names merges, or rebase it
over that branch's `contactsRepo.ts` edits.

**Update (WP1 B2a, 2026-10-29): a third copy, and two more walks.**
`unitsRepo.getManyByIds(ids, { requireComplete: true })`
(`app/src/repos/unitsRepo.ts`) - the full-item units read the ranking's
properties-seen cards use - carries the same walk again, this time WITH the
`requireComplete` mode (a failed chunk rethrows; an unprocessed key after
its retries throws `IncompleteBatchReadError`), and is marked
`TODO(units-contacts-batchget-walk-duplicated)`. The suggested shared helper
now has three callers. (The units walk is no longer without that mode
either: since WP1 B1 `getDisplaysByIds` takes an optional `requireComplete`
too.) B2a also added two by-key BatchGet walks of other tables that the
helper should cover or explicitly leave out; neither carries the TODO
marker:
- `matchesRepo.getPairs(keys, { requireComplete: true })`
  (`app/src/repos/matchesRepo.ts`) - a COMPOSITE key (`tenantId` +
  `unitId`), a consistent read, complete-only (`IncompleteBatchReadError`
  with table `matches`), so the helper would need a key builder, not one
  key attribute;
- the ranking run listing's private `batchGetRuns`
  (`app/src/repos/rankingRunsRepo.ts`, behind `listRuns`) - a projected
  read that REPORTS the run ids still unread after its retries (the page
  shows them as unavailable and says `incomplete: true`) instead of
  dropping or throwing: a third mode, copied from the extraction run log's
  `batchGetRuns` (`app/src/repos/aiRunsRepo.ts`), which this issue did not
  list either.
