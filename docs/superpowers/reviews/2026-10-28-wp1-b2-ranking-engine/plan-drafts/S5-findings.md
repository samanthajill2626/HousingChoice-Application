# S5 plan-draft findings - the ranking job

Drafter: S5/S6 section drafter, 2026-10-28. Draft:
`.superpowers/sdd/plan-draft-S5.md` (plan section 9).

## S5-F1. Candidates that get no match outside a failed batch must be listed in `failedBatches`

- Spec D7 lists `failedBatches[]` (each `{ index, candidateIds, failure }`)
  for batches whose call failed. Spec D9 decides `notScored` (and the
  `failedBatch` out-of-date reason) from the anchor's last job's
  `failedBatches` alone.
- Two other kinds of candidate get no new match and must read "not scored -
  retry": a candidate the model did not return (charter 7.4, spec D5
  parsing) and a candidate whose card needed an incomplete units read
  (spec D2.3: "left out of the call and reads not scored - retry, with the
  count in the job's message").
- Nothing in the tree decides this (the job record is new, S2's
  `rankingRunsRepo`), but the record shape S6 reads and S7 renders depends
  on it.
- Draft's choice: record both as `failedBatches` entries - an omitted
  candidate as `{ index: <its batch>, candidateIds: [...], failure:
  'omitted' }` (the index is ALSO in `batchesDone`, the batch scored), the
  unreadable candidates as one `{ index: -1, candidateIds: [...], failure:
  'unreadable' }` (not a model batch; never counted in `batchCount` nor in
  the event's finished-batch count). The read then needs one rule.
- Ruling needed: accept the two entry kinds (S6 and S7 then treat `index:
  -1` as "not a batch" and a batch index present in both lists as "scored
  with omissions"), or add a separate record field (for example
  `notScoredIds`) that S2 types and S6 reads alongside `failedBatches`.

## S5-F2. What "anchor not found" (404) means

- Spec D12: `POST .../rank` answers "404 anchor not found"; D1: "Any record
  can be the anchor ... Ranking is never refused for the anchor's state."
  S3's `computePool` returns `anchor_not_found` (PR3) with no definition.
- The tree: `contactsRepo.getById` returns soft-deleted contacts and any
  type (`app/src/repos/contactsRepo.ts:780`, `isDeleted` at :433);
  `unitsRepo.getById` returns soft-deleted units (`app/src/repos/unitsRepo.ts:671`,
  `isDeleted` at :598).
- Draft's choice (`rankingAnchorExists` in `job.ts`, used by the claim): a
  tenant anchor exists when the contact is present, not soft-deleted and
  typed `tenant`; a unit anchor exists when the unit is present and not
  soft-deleted, any status. A landlord or partner contact pressed as a
  "tenant" anchor is 404, not a ranking of nothing.
- Ruling needed: confirm the rule, and that S3's `anchor_not_found` uses
  the same one (otherwise the claim accepts a press whose job then fails
  "not found", or refuses one the read would show).
