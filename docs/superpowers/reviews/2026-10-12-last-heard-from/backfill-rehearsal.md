# backfill-last-heard-from - lane rehearsal (plan Task 2.1)

Date: 2026-10-13. Branch `feat/last-heard-from` @e7d89d65 (the script's commit;
no app or dashboard source changed while the lane ran). Implementer dispatch D3.

## Target

- Hermetic e2e lane started from this worktree with `npm run e2e:session`:
  lane 10, table prefix `hc-local-10-`, DynamoDB Local database `hclane10`,
  ports 10001 / 10011 / 10021 / 10031.
- Reseeded LEAN with `npm run e2e:reseed` (the `/__dev/reseed` default profile)
  immediately before the runs.
- Commands, from the worktree root:
  - dry run: `npx tsx app/scripts/backfill-last-heard-from.ts --env local --lane 10`
  - apply: `npx tsx app/scripts/backfill-last-heard-from.ts --env local --lane 10 --apply`
    (run with `LOG_LEVEL=debug` so the repo's per-contact `skipped` line names
    each touched contactId; the target and arguments are unchanged).
- Start line (both runs): endpoint `DynamoDB Local http://localhost:8000
  database hclane10 (e2e lane 10)`, prefix `hc-local-10-`.

## Report lines (counts and ids only)

Dry run, exit 0, `backfill-last-heard-from - done (DRY RUN - nothing written)`:

    conversationsWalked 4, pointerRows 0, messagesRead 4, unattributed 0,
    unattributedSample [], unparseableInstants 0, planned 2, written 0,
    skipped 0, failed 0, apply false

Apply, exit 0, `backfill-last-heard-from - done`:

    conversationsWalked 4, pointerRows 0, messagesRead 4, unattributed 0,
    unattributedSample [], unparseableInstants 0, planned 2, written 0,
    skipped 2, failed 0, apply true

The two touched (and skipped) contactIds, from the apply's debug lines
`contacts: last_heard_from_at not moved (no row, or already as late)`, in the
runner's contactId order: `contact-landlord-0001`, `contact-tenant-0001`.

## Result

Matches the plan's expectation exactly: dry run `planned` 2
(`contact-tenant-0001`, `contact-landlord-0001`); apply `written` 0,
`skipped` 2. The lean seed's derivation (Task 1.13) had already stored the
same values the backfill computes, so the forward-only writer moved nothing:
invariant I4 holds end to end.

Read-only cross-check after the apply (GetItem on `hc-local-10-contacts`,
lane key): `contact-tenant-0001` holds `2026-06-01T14:02:10.000Z`,
`contact-landlord-0001` holds `2026-06-01T13:45:00.000Z` - the D2 seed
values, unchanged.

Observation (no action): `pointerRows` is 0 because the lean seed writes no
`phone#` / `email#` / `token#` claim rows into the conversations table; the
claim-row skip is covered by the unit test instead
(`app/test/backfillLastHeardFrom.test.ts`, runner dry-run case).

## Teardown

`npm run e2e:stop` exit 0: launcher 14544 and children stopped, an orphan app
process on :10001 reaped, lane 10 tables (`hc-local-10-*`) dropped, lane lease
released. Afterwards `Get-NetTCPConnection -State Listen` filtered to ports
10001 / 10011 / 10021 / 10031 found no listener, and the launcher, app and
worker processes (14544, 62820, 40912) were gone. DynamoDB Local was not
restarted or stopped.
