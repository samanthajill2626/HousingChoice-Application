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

## Task 6.3 - both fan-out mint sites

Task 6.2 commit: 7dbd4512. Dependency proof: conversationTypeFor is a leaf
with type-only imports and existing open-thread reuse remains in the repo.
Send pass and reconcile adoption now mint using the current contact's type.
No type re-fence or changes to deleted/consent/opt-out/unreachable/kill-switch
gates; existing open threads are reused without retyping. tenantCount stays.
RED: app npx vitest run test/broadcastFanOut.test.ts -t caseworkers exited 1:
two failed, one passed, 111 filtered (6.3-red). Both fresh partner mint sites
returned tenant_1to1; the existing unknown thread reuse pin passed.
GREEN: app npx vitest run test/broadcastFanOut.test.ts test/sendReconcile.test.ts test/broadcastApi.test.ts
exited 0: three files, 378 tests, zero skipped (6.3-green).
No contract deviation or import cycle. All existing fan-out gates passed.
Root npm run typecheck exited 0 across all five workspaces (6.3-typecheck).

## Task 6.4 - units recipients display facts

Task 6.3 commit: 94196178. Dependency proof: S2 real/fake recipient projection
and exported RecipientDisplay are present. Only units recipients switches to
that projection. The shared display projection and contact listings-sent stay
unchanged. Wire rows add optional type and nonblank trimmed role, omitting
both for missing or failed lookups. Persisted tenantName remains unchanged.
Both planned route pins and the comment-only api/lib seams moved together.
The role fixture includes spaces to prove trimming, and batch-failure absence
also explicitly checks role. Test headings/comments now describe the wire split.
RED: app npx vitest run test/listingSendsApi.test.ts test/contactsBatchReads.test.ts
exited 1: four failed, 24 passed (6.4-red). Shared-row/type assertions saw no
type; the new batch spy saw zero calls; the failed new projection stub was
unused and the old path still returned Tia. Later role checks were not reached.
GREEN: app npx vitest run test/listingSendsApi.test.ts test/contactsBatchReads.test.ts test/unitsApi.test.ts
exited 0: three files, 55 tests, zero skipped (6.4-green).
No production contract deviation, new dependency or shared projection widening.
Root npm run typecheck exited 0 across all five workspaces (6.4-typecheck).
