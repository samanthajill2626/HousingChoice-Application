# Record - outbound MMS viewer scroll flake (`fix/outbound-mms-scroll-flake`)

Merged to `main` as `82a2212f` (tip `e06b133c`). Branch and worktree retired
2026-09-02. This was an authorized SMALL-FIX lane, not a full mission: no spec,
no implementation plan, and no product source file was changed - the fix is
entirely in `e2e/tests/dashboard-next/outbound-mms.spec.ts`.

## The record spans TWO dated directories

- [`2026-09-01-outbound-mms-scroll-flake/`](../2026-09-01-outbound-mms-scroll-flake/) -
  the first diagnostic pass: plan, run report, and adversarial review.
- `2026-09-02-outbound-mms-scroll-flake/` (this one) - the diagnosis that
  landed, its adversarial review and re-review, the adjudication, and the
  verification.

Read the 09-01 directory first; the 09-02 diagnosis builds on it.

## What it fixed

The 1:1 outbound MMS spec asserted a Timeline scroll checkpoint that a
concurrent Timeline text mutation plus a `toneSuccess` status-class change could
move from `top=512` to `top=500` while `maximumTop` stayed `512`, with a native
Timeline scroll event following. The spec's checkpoint was stabilized. Both
tracked issues -
[`outbound-mms-viewer-scroll-capture-flake`](../../../issues/outbound-mms-viewer-scroll-capture-flake.md)
and [`e2e-image-viewer-scroll-flake`](../../../issues/e2e-image-viewer-scroll-flake.md) -
are resolved.

## The cited artifacts moved when the worktree was deleted

[`verification.md`](verification.md) and [`adversarial-review.md`](adversarial-review.md)
cite `.artifacts/red-scroll-512-to-500-20260902` - the preserved before-fix red
run - as their proof. That path lived in the worktree's UNTRACKED root
`.artifacts/` directory, which does not survive worktree removal. It was copied
out intact before deletion (60 files, 29.6MB: traces, videos, screenshots and
`results.json` for both that red run and the earlier full-suite trace
`full-trace-20260901-1239-86db0010`):

```
W:\tmp\_preserved-artifacts\outbound-mms-scroll-flake-20260902\
```

Those are Playwright binaries, not reasoning, so they are deliberately NOT in
git. Nothing else references them - delete the directory once the fix has held.
The record bodies were left byte-for-byte as written; this README is the only
note of the move.

## Scope guard, as recorded

No aggregate `npm test` and no full E2E suite was run - by design for this lane.
The branch synced main once at `a2602e32`; the later `b45e6fdc` and `bb54fdaa`
drift had no path intersection and was reported rather than merged again.
`npx eslint` on the touched spec reports one pre-existing `DIANA_ID` unused
variable that fires identically on main - not this branch's.
