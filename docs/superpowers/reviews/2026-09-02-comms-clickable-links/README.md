# Record - clickable links in communications (`feat/comms-clickable-links`)

Merged to `main` as `3834164b` (tip `ec84f19b`). Branch and worktree retired
2026-09-24. The spec
[`2026-09-02-comms-clickable-links-design.md`](../../specs/2026-09-02-comms-clickable-links-design.md)
and the plan
[`2026-09-02-comms-clickable-links.md`](../../plans/2026-09-02-comms-clickable-links.md)
were frozen as historical records in the same change.

## Nine records added at retirement

Most of this record was committed during the mission. Nine files that the
build left only in the worktree's gitignored `.superpowers/sdd/` were added
here, byte-for-byte, when the worktree was retired:

- `worklist.md` - the phase 1 live-tree worklist. Earlier records cite it as
  `.superpowers/sdd/worklist.md` with line numbers; it is now
  [`worklist.md`](worklist.md) in this directory and those line numbers still
  match. Per the mission ledger, it holds the merged findings of the three
  research scopes.
- Slice and fix-wave reports: `s1-implementer-report.md`,
  `s1-autolinker-implementer-report.md`, `s1-plaintext-node-fix-report.md`,
  `s2-timeline-implementer-report.md`, `s2-untruncated-whitespace-fix-report.md`,
  `s3-unmatched-email-implementer-report.md`, `e1-browser-implementer-report.md`
  and `phase4-fix-wave-report.md`.

## Kept out of git, preserved outside it

Everything else in `.superpowers/`, plus the worktree's `e2e/.artifacts/`, was
copied out and SHA-256 verified (282 files, 43,162,509 bytes):

```
W:\tmp\_preserved-artifacts\comms-clickable-links-20260924\
```

`manifest.json` there lists every file, byte count and hash. It covers the
mission ledger (`sdd/progress.md`), the three `research-*-reference.md` files
(the reference half of the research - their findings went into `worklist.md`),
gate logs and exit files (including `final-e2e.log` and the npm test, eslint and
outbound-MMS isolation runs), the two review diffs, and the dependency probes for
`anchorme`, `autolinker` and `linkifyjs`. These are run output, raw diffs and
reference material, so they are deliberately not in git.
