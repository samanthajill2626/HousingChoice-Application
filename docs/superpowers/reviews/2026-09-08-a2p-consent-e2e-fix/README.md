# Record - consent E2E failure / broadcast prefill race (`codex/a2p-consent-e2e-fix`)

Fast-forwarded into `main`: the branch tip `8e193c94` sits on main's
first-parent line directly after `4fd63c90`, with no merge commit. Branch and
worktree retired 2026-09-24. This was an authorized SMALL-FIX lane branched from
`ca4317c8` (the `codex/outbound-mms-scroll-recheck` tip): no spec, no
implementation plan, nothing to stamp historical.

## What it fixed

A full E2E run at `ca4317c8` failed one case, `a2p-compliance.spec.ts:323`. The
cause was not the consent fence: a pending default-prefill effect in
`BroadcastComposer.tsx` could overwrite a newer operator edit, so the test's
custom body was never sent. Tracked as
[`broadcast-composer-prefill-overwrites-edit`](../../../issues/broadcast-composer-prefill-overwrites-edit.md),
resolved.

## The cited evidence moved when the worktree was deleted

[`adjudication.md`](adjudication.md) and [`handback.md`](handback.md) cite
`.superpowers/consent-evidence/` (`baseline`, `instrumented-baseline`,
`green-focused`, `green-related`) as their local proof. That directory was
gitignored inside the worktree and would not have survived its removal. Before
deletion the whole `.superpowers/` directory - Playwright `results.json` for all
four runs, eight `trace.zip` files, and the three `*.ps1` trace-reading scripts -
was copied out and SHA-256 verified (18 files, 18,860,062 bytes):

```
W:\tmp\_preserved-artifacts\a2p-consent-e2e-fix-20260924\
```

`manifest.json` there records every relative path, byte count and hash. These are
binaries and run output, not reasoning, so they are deliberately NOT in git.
The worktree's `e2e/.artifacts/` was not copied: its `results.json` and all five
traces were byte-identical to `green-related`, and the rest was the HTML report
for that same run.

The record bodies were left byte-for-byte as written, including their
point-in-time `.superpowers/consent-evidence/` paths and the handback's
"Branch is intentionally unmerged"; this README is the only note of the merge
and the move.

## The ORIGINAL red evidence lives in another worktree

`adjudication.md` also cites
`W:\tmp\outbound-mms-scroll-recheck\.superpowers\scroll-recheck\full-suite-ca4317c8` -
the full-suite run that produced the failure, with its trace. That worktree
(`codex/outbound-mms-scroll-recheck`) was NOT part of this retirement and still
exists. Preserve that directory before retiring it, or the adjudication loses its
primary evidence.

## Scope guard, as recorded

No aggregate `npm test` and no full E2E run, by design for this lane.
Touched-file ESLint reports four pre-existing `react-hooks/set-state-in-effect`
errors in `BroadcastComposer.tsx` that fire identically at `ca4317c8` - not this
branch's.
