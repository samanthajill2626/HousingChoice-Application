# Record - relay 30003 retry lineage (`feat/relay-30003-retry-lineage`)

Reached `main` by fast-forward: `2cc8fd33`, the merge of
`codex/cloudfront-maintenance-page`, has this branch's tip `5dd45ceb` as its
first parent, so main already sat at the tip. No merge commit names this
branch. Branch and worktree retired 2026-09-24. The spec
[`2026-09-02-relay-30003-retry-lineage-design.md`](../../specs/2026-09-02-relay-30003-retry-lineage-design.md)
and the plan
[`2026-09-02-relay-30003-retry-lineage.md`](../../plans/2026-09-02-relay-30003-retry-lineage.md)
were frozen as historical records in the same change.

## Nothing new committed - by the mission's own split

The mission committed its record as it went (47 files before this README) and split
findings from reference when it wrote them: `research-*-findings.md` and
`research-adjudications.md` are tracked, while the byte-exact material stayed in
the worktree's gitignored `.superpowers/`. Its own merged index,
`.superpowers/sdd/worklist.md`, describes itself as gitignored reference. The
worktree's `sdd/handback.md` was byte-identical to [`handback.md`](handback.md).

## Cited paths moved when the worktree was deleted

Several records here cite `.superpowers/` paths: gate and e2e logs and exit
files (`sdd/gate-*.log`, `sdd/e2e-fixwave*-run*.log`, `sdd/revert-proof-*.log`,
`sdd/typecheck-fixwave4.log`, `sdd/vitest-fixwave4-final.log`), the fix-wave
diff packages under `review/`, and the per-area worklists (for example
`sdd/worklist-dashboard.md` and its Part C invariant table). Before deletion the
whole `.superpowers/` directory, the worktree's `e2e/.artifacts/`, and the
builder's worktree-local agent memory (`.claude/agent-memory/abt-build-orchestrator/`)
were copied out and SHA-256 verified (90 files, 142,656,987 bytes):

```
W:\tmp\_preserved-artifacts\relay-30003-retry-lineage-20260924\
```

A cited `.superpowers/<path>` now lives at `.superpowers\<path>` under that
directory, and `manifest.json` there lists every file, byte count and hash.
Logs, diff packages, the mission ledger (`sdd/progress.md`), the two
`research-*-reference.md` files and the per-area worklists are run output or
reference material, so they are deliberately not in git.

The record bodies were left byte-for-byte as written; this README is the only
note of the merge and the move.
