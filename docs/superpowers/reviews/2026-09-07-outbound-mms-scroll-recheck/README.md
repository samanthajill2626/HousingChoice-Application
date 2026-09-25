# Record - populated-history MMS viewer setup (`codex/outbound-mms-scroll-recheck`)

Reached `main` by fast-forward: the branch tip `ca4317c8` sits on main's
first-parent line, and no merge commit names the branch (`c8ed0348` is the one
main sync INTO it). Branch and worktree retired 2026-09-24. This was an
authorized SMALL-FIX lane branched from `f82c149c`: no spec, no implementation
plan, nothing to stamp historical. The only code change is
`e2e/tests/dashboard-next/outbound-mms.spec.ts`.

## What it fixed

The outbound-MMS viewer test hid its own trigger when the Timeline already held
populated history: the arranged 180px cap was skipped, and centering scrolled the
document as well as AppFrame. Tracked as
[`e2e-outbound-mms-viewer-trigger-not-visible`](../../../issues/e2e-outbound-mms-viewer-trigger-not-visible.md),
resolved. The distinct 512-to-500 delivery-checkpoint issue,
[`e2e-image-viewer-scroll-flake`](../../../issues/e2e-image-viewer-scroll-flake.md),
stays resolved under its own record.

## The cited evidence moved when the worktree was deleted

[`diagnosis.md`](diagnosis.md), [`focused-proof.md`](focused-proof.md) and
[`verification.md`](verification.md) cite runs under `.superpowers/scroll-recheck/`
as their proof: `failing-sequence`, `diagnostic-red`, `history-fixture-red`,
`focused-run`, `outbound-file-run`, `focused-green`, `sequence-green` and
`final-eight-green`. The same directory also held `full-suite-ca4317c8`, the full
E2E run whose one failure is adjudicated in
[`../2026-09-08-a2p-consent-e2e-fix/adjudication.md`](../2026-09-08-a2p-consent-e2e-fix/adjudication.md).
All of it was gitignored inside the worktree. Before deletion the whole
`.superpowers/` directory was copied out and SHA-256 verified (51 files,
15,910,614 bytes):

```
W:\tmp\_preserved-artifacts\outbound-mms-scroll-recheck-20260924\
```

`manifest.json` there records every relative path, byte count and hash. These are
Playwright traces, videos, screenshots and `results.json` reports, not reasoning,
so they are deliberately NOT in git. The worktree's `e2e/.artifacts/` was not
copied: apart from lane runtime files it was byte-identical to
`full-suite-ca4317c8`.

The record bodies were left byte-for-byte as written, including their
point-in-time `.superpowers/` paths and `verification.md`'s "Branch and worktree
remain unmerged for human integration"; this README is the only note of the
merge and the move.

## Scope guard, as recorded

No aggregate `npm test` and no full E2E suite in this lane; the final check ran
both MMS files together, 8 passed. The branch synced main once, at `c8ed0348`.
Touched-file ESLint reports one pre-existing unused `DIANA_ID` in
`outbound-mms.spec.ts` that fires identically at `f82c149c` - not this branch's.
