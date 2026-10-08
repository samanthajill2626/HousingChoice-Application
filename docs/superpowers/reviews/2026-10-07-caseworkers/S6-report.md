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
