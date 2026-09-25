# Record - Unknown-tab paging small fix (`feat/inbox-unknown-tab-paging`)

Reached `main` by fast-forward: the branch tip `ad8143ff` sits on main's
first-parent line with no merge commit. Branch and worktree retired 2026-09-24.
This was the small-fix lane that mission M6 was rescoped into on 2026-09-02,
after M6's premise (the Unknown tab walking the whole open partition) proved
already closed by `66989d6f` (merged in `1467832b`). It had no spec or plan of
its own: the two 2026-08-25 unknown-tab docs belong to
`feat/inbox-unread-cluster` and were frozen on 2026-08-31.

It resolved
[`unknown-queue-page-head-drop-after-filled-page`](../../../issues/unknown-queue-page-head-drop-after-filled-page.md)
(a provenance-carrying unknown cursor) and
[`inbox-parselimit-empty-one-row`](../../../issues/inbox-parselimit-empty-one-row.md).
The three adversarial review rounds and their adjudications are in this
directory.

## Gate results, recovered from the worktree's logs

No handback or verification record was committed for this branch. Its gate
outcomes lived only in root `.artifacts-*.log` files inside the worktree, all
dated 2026-09-02, and were read from those logs before deletion:

| Gate | Log(s) | Result |
| --- | --- | --- |
| `npm run typecheck` | `typecheck.log` to `typecheck4.log` | no diagnostics in any of the four runs |
| `npm test` | `npmtest.log`, `npmtest2.log` | green both runs: four workspace suites of 185, 20, 34 and 13 test files, all passed |
| `npm run smoke` | `smoke.log`, `smoke2.log` | `smoke-dist: OK - 1396 import specifier(s) across 246 emitted file(s)` both runs |
| `npm run e2e` | `e2e.log` | exit 1: 263 passed, 3 failed (26.9m) |
| e2e rerun of the three failing files | `e2e-rerun.log` | 13 passed, 0 failed (3.7m) |
| targeted unit runs | `tests2.log` to `tests5.log` | `tests3` had 1 failure (`inboxUnknownTab.test.ts`, requirement 4: a thrown thread read stops the page at that row); `tests4` and `tests5` passed, 4 files |
| lint, branch and main | `lint-branch.log`, `lint-main.log` | both logs are empty (0 bytes) - consistent with a clean run, but not proof of one |

The three full-suite failures were `dashboard-next/outbound-mms.spec.ts:517`
(the `trigger is not visible` setup failure, later resolved as
[`e2e-outbound-mms-viewer-trigger-not-visible`](../../../issues/e2e-outbound-mms-viewer-trigger-not-visible.md)),
`roster-quiet-hours.spec.ts:307` and
`scenarios/approval-and-move-in.spec.ts:279`. All three files passed on the
rerun. The full suite was not green in a single run on this branch; that is
recorded here as it happened, not relabelled.

## Where the logs went

The 16 root logs and `e2e/.artifacts/` (the rerun's HTML report and
`results.json`) were copied out and SHA-256 verified (22 files, 42,782,207
bytes):

```
W:\tmp\_preserved-artifacts\inbox-unknown-tab-paging-20260924\
```

`manifest.json` there lists every file, byte count and hash. Logs are run
output, so they are deliberately not in git.
