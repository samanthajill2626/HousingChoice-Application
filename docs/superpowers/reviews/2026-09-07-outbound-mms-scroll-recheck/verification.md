# Final small-fix verification

Branch: `codex/outbound-mms-scroll-recheck` at
`W:\tmp\outbound-mms-scroll-recheck`. Core fix: `f8d72a2e`. Main `2cc8fd33`
was merged once at `c8ed0348`, before final checks. No conflicts or dependency
changes. Only the E2E test and durable issue/review records are branch changes.

## Exact final checks

All commands run from the fix worktree, without a pipeline hiding their exits.

```powershell
npm run typecheck -w @housingchoice/e2e
```

Exit 0 after the review assertion fix.

```powershell
npm run test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewer.test.tsx src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/scroll.test.ts src/ui/imageViewer/history.test.ts src/ui/imageViewer/fitImage.test.ts src/routes/contact/Timeline.mms.test.tsx
```

Exit 0, 6 files / 68 tests after main sync. Review changed only E2E assertions,
not the unit-covered source; no additional unit rerun was necessary.

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/mms-transcode.spec.ts tests/dashboard-next/outbound-mms.spec.ts
```

Exit 0, 8 passed, 51.8s after the review assertion fix, with `E2E_TRACE=1` and
`E2E_CHILD_LOG_DIR` unset. No retries, skips, or unexpected results.
This executes the original three-test order-dependent sequence, then mobile
pinch/pan/Back, narrow composer, and relay MMS send/forward cases.
The desktop case covers authenticated media, real send/render, focus restore,
ordinary wheel, Ctrl-wheel, bounded panning, Escape, and exact owner equality.

Before the fix, the unmodified three-test sequence failed 2 passed / 1 failed.
The permanent long-history fixture also failed the exact case alone against
old setup. After the fix, the exact command passed 1/1 and the sequence 3/3.
See `diagnosis.md` and `focused-proof.md` for those commands and evidence.

```powershell
npx eslint e2e/tests/dashboard-next/outbound-mms.spec.ts
```

Raw exit 1: only `DIANA_ID` at line 50, unused variable. ESLint on the baseline
`f82c149c` file, using the same config/path, emits the identical diagnostic.
Final lint after review emits that same single error. No new lint errors.

`git diff --check`: exit 0. Added-line ASCII check: zero violations.

## Review and issue state

Independent review raised one P2: missing scroll assertions for the separate
Ctrl-wheel session. Accepted, fixed, and independently re-reviewed with no
remaining findings. Affected E2E typecheck, lint, and browser checks reran after
the change.

`e2e-outbound-mms-viewer-trigger-not-visible` is resolved for this demonstrated
setup mechanism. The distinct 512-to-500 delivery checkpoint issue remains
resolved, with its original duplicate pointer intact. No claim is made about
unrelated scenario failures or any different, untraced scroll signature.

## Artifacts and handoff

Passing final report and recorder attachment:
`.superpowers/scroll-recheck/final-eight-green/results.json`.
Earlier RED traces remain preserved at the paths in `diagnosis.md`.
Final recorder phases retain AppFrame 20 and Timeline 2335 through Escape.
The Ctrl-wheel session now asserts that same exact baseline too.

No aggregate `npm test`, full E2E suite, deployment, infrastructure mutation,
main checkout change, push, or cleanup. Branch and worktree remain unmerged
for human integration. The hermetic lane is stopped after the browser run.
