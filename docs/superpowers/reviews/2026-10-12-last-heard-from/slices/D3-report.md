# D3 - S2 Tasks 2.1-2.2: decisions record

Dispatch D3 of the feat/last-heard-from build (implementer, 2026-10-13). Scope:
the one-off `last_heard_from_at` backfill script, its lane rehearsal, and its
RUNBOOK section. Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md`
(S2 Tasks 2.1-2.2). Binding correction applied: IB6 (2.1 Half 1 case 6).

## Commits

- e7d89d65 Task 2.1 - `app/scripts/backfill-last-heard-from.ts` and
  `app/test/backfillLastHeardFrom.test.ts`.
- 90d9318e Task 2.1 - the lane rehearsal record
  (`backfill-rehearsal.md` in this folder).
- 106e6025 Task 2.2 - the RUNBOOK section (`RUNBOOK.md:500-522`).

RED: the new test file failed to load because the module did not exist.
GREEN: 16/16 in `app/test/backfillLastHeardFrom.test.ts`. Root
`npm run typecheck` exit 0 (the app's scripts and test configs included).
eslint on the two new files: clean.

## Rehearsal (summary; full record in backfill-rehearsal.md)

Hermetic lane 10 from this worktree, reseeded lean. Dry run `planned` 2;
apply `written` 0, `skipped` 2 (`contact-landlord-0001`,
`contact-tenant-0001`) - exactly the plan's expectation. Lane stopped with
`npm run e2e:stop`; no listener on its four ports afterwards.

## Decisions and divergences

1. IB6: the group-thread planner case asserts four distinct contacts and two
   unattributed rows, and pins each contact's instant
   (`app/test/backfillLastHeardFrom.test.ts:165-205`).
2. Task 2.1 is two commits, not one: the dispatch requires the green code
   committed before the lane starts (the lane serves source live), so the
   rehearsal record follows in its own commit.
3. The apply rehearsal ran with `LOG_LEVEL=debug` against the same target:
   the report lines carry counts only, and the repo's per-contact debug line
   is the script's only output naming the touched ids. A read-only GetItem
   then confirmed both stored values were the seed's, unchanged.
4. The direct-invocation check uses the `SCRIPT_NAME` template
   (`app/scripts/backfill-last-heard-from.ts:269-270`), the
   `backfill-join-housing-authority.ts` precedent; same behavior as the
   plan's literal.
5. Extra test assertions beyond the plan (an `isPointerConversation` case,
   the Query table name, `apply` on the PARTIAL and done lines); the
   group_text roster case uses a phone the lookup cannot resolve, so only the
   roster can name it.
6. RUNBOOK exit codes: the plan's text named only a failed write for exit 1,
   but a Scan or Query failing mid-run also aborts through the same PARTIAL
   path (`app/scripts/backfill-last-heard-from.ts:175-185`). The line now says
   "a write failed, or a read failed mid-run (either way a `PARTIAL result`
   report)" (`RUNBOOK.md:520`).

## Open for the orchestrator

- The RUNBOOK section is a post-deploy op owed on dev AND prod; the S10
  handback should name it.
- The lean world has no claim rows, group threads or unattributed rows, so the
  rehearsal exercises only the 1:1 path; the rest is unit-tested.
