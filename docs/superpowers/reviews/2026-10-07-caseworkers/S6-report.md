# S6 report - direct property shares to partners

Date: 2026-10-08. Lane: authorized Caseworkers feature mission, S6 only.
Worktree W:/tmp/caseworkers, branch feat/caseworkers; clean start 355fa4de.
Dependency proof: S2's RecipientDisplay and separate real/fake projection are
present; S3-S5 contracts and closed assembly/live-tree rulings were read.
Task tests precede production edits; focused GREEN and root typecheck precede
each task commit. Parent owns aggregate checkpoints and S10 owns e2e execution.
Raw logs, command/cwd metadata and real exits are ignored under
.superpowers/sdd/S6/. run.mjs enforces a 600-second owned-child timeout.

## Task 6.1 - direct-recipient type admission

One predicate admits tenant or partner for seed and explicit selection. Other
admission/fan-out gates are unchanged. Filter resolution stays tenant-only;
its planned GSI comment correction is included. No persisted key was renamed.

Initial 6.1-red exited 0 with all 96 tests skipped: the runner's cmd quoting
prevented the spaced pattern from matching. This is not RED evidence. Using
-t caseworkers (same intended five cases), 6.1-red-final exited 1: four failed,
one passed, 91 filtered. Observed failures were estimate 0, send 400, explicit
count 1, and empty candidates. Later assertions were not reached.
GREEN from W:/tmp/caseworkers/app:
npx vitest run test/broadcastApi.test.ts test/contactsBatchReads.test.ts test/audienceResolution.test.ts
Exit 0: three files, 116 tests, zero skipped (6.1-green).
Root npm run typecheck exited 0 across all five workspaces (6.1-typecheck).
No contract deviation or unexpected importer/cycle.

## Task 6.2 - tenant-only preview voucher facts

Task 6.1 commit: a667df2b. Dependency proof: partner seeds now resolve; the
lean Renee Carter fixture is partner-typed with leftover housingAuthority.
Seed resolution omits voucherSize/housingAuthority unless type is tenant.
RED: app npx vitest run test/broadcastApi.test.ts -t WITHOUT exited 1,
one failed / 96 filtered (6.2-red). The first omission assertion observed
voucherSize 2; the subsequent housingAuthority assertion was not reached.
GREEN: app npx vitest run test/broadcastApi.test.ts exited 0, 97 tests,
zero skipped (6.2-green), including the existing tenant facts pin.
Initial root npm run typecheck exited 2 (6.2-typecheck): the drafted test
assumed SEED.contacts was required, but SeedDoc declares it optional. The
fixture access now uses optional chaining; its runtime type/authority pins
remain. This is a test-typing correction, not a production contract change.
No contract deviation; no dashboard or seed edits.

After the typing correction, the affected -t WITHOUT case passed (1 passed,
96 filtered; 6.2-green-final) and root npm run typecheck exited 0 across all
five workspaces (6.2-typecheck-final).
