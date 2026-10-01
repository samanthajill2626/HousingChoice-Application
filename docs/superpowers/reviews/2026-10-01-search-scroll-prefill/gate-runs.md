# Completion gates - fix/search-scroll-prefill (2026-10-01)

Branch head at gate time: 917edf28 (two commits on main @8c7921ea; main had
not moved, so no sync was needed). All gates run bare from
W:\tmp\search-scroll-prefill, output redirected to a file, never piped.
DynamoDB Local freshly started this session. New PC (24 cores).

| # | Gate | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` | exit 0 |
| 2 | `npm test` | exit 0 - app 399 files (76.0s), dashboard 211 (29.3s), e2e 22, fake-twilio 34, fake-twilio-web 13; 0 failures; 0 `[dynamoAdmin]` lines |
| 3 | `npm run smoke` | exit 0 - 1544 specifiers across 268 emitted files resolve |
| 4 | `npm run e2e` | exit 0 - 305 passed, 0 failed, 17.2m; contact-create.spec.ts:157 ok (#51), a2p-compliance.spec.ts:323 ok (#5) |
| 5 | `npx eslint` on the 5 branch .ts/.tsx files | exit 0 |

No lane listener survived the e2e run.

## Round 2 - globalSetupEnsure fixed keys (after the first merge)

main was fast-forwarded to ac9307ad (the branch head), so the branch
continued from main with nothing to sync. Commits: 659dc49a (fixed keys),
e4c1a24f (guard marker). DynamoDB Local had been restarted earlier that day
and held 131-133 databases during these runs.

| # | Gate | Head | Result |
| --- | --- | --- | --- |
| 1 | `npm run typecheck` | e4c1a24f | exit 0 |
| 2 | `npm test` | 659dc49a | **exit 1** - `dynamoAccessKeyGuard.test.ts` "every unmarked suite that CREATES container tables mints per-run random names" flagged `globalSetupEnsure.test.ts`: removing `Math.random` removed what the guard accepted. Correct catch; fixed in e4c1a24f by declaring the keys `hc:dynamo-lane worktree-derived-keys` and deriving them from `testAccessKeyId()` |
| 2 | `npm test` | e4c1a24f | exit 0 - app 399 files (60.9s), dashboard 211, e2e 22, fake-twilio 34, fake-twilio-web 13; 0 `Timeout calling`, 0 `[dynamoAdmin]` |
| 3 | `npm run smoke` | 659dc49a | exit 0 |
| 4 | `npm run e2e` | 659dc49a | exit 0 - 305 passed, 17.2m |
| 5 | `npx eslint` on the branch's .ts files (app/test/globalSetupEnsure.test.ts) | e4c1a24f | exit 0 |

Gates 3 and 4 were not re-run at e4c1a24f: that commit changes only
`app/test/globalSetupEnsure.test.ts`, which neither the compiled app (smoke)
nor the e2e harness loads.

The app suite's 60.9s (vs 38-40s on a fresh container at the same 10
workers) is the database-count creep described in
`docs/issues/dynamodb-local-slows-after-sustained-concurrent-load.md`, not
this change.
