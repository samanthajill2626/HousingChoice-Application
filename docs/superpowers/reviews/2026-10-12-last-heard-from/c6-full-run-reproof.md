# C6 re-proof - the populated hand-pick case passes in the full e2e run

Plan Task 8.5 (spec 8 (5), 5.8, 14.5 F17). Run by the build orchestrator as the
Phase 3 gate-4 run.

- Date: 2026-10-13
- Branch: feat/last-heard-from, HEAD 1f298e64 (0 behind main @16ca96cc)
- Command (bare, from the worktree root, background, output captured):
  `timeout 2400 npm run e2e`
- Exit code: 0
- Totals line: `359 passed (20.9m)` (`Running 359 tests using 1 worker`)
- The C6 case:
  `ok 129 [chromium] > tests\dashboard-next\matching-entry-points.spec.ts:192:3 > Matching entry points - tenant file + property page > property-page + Send: hand-picked single recipient (2.8s)`
  (the log's separator glyph is rendered here as `>`).
- The C6 patch commit: 3509ad35 (its tree is byte-identical to
  `docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch`
  applied to its parent - proven by tree-hash equality on a scratch index).
- `git grep -n "force: true" -- e2e/tests/dashboard-next/matching-entry-points.spec.ts`:
  empty (exit 1) - the option click at `:228` is an ordinary pointer click.

S10's gate-4 run on the final (post-fix, post-sync) commit re-confirms.
