# Small-fix handback

Date: 2026-09-08. Branch: `codex/a2p-consent-e2e-fix`.
Worktree: `W:\tmp\a2p-consent-e2e-fix`.
Implementation commit: `4fd63c90`; follow-up commit contains this record,
review R1's exact one-draft assertion, and the resolved issue.

## Outcome

The failing consent test exposed a broadcast-composer state race. A pending
default-prefill effect could overwrite a newer operator edit, causing the test
to wait for content that was never sent. Draft creation and fake delivery both
succeeded with the wrong text. No consent-fence, queue, timeout, or MMS-viewer
change is warranted for this signature.

Atomic message/edit ownership and functional prefill updates now preserve the
latest edit in both recipient modes. Confirmed property/audience resets still
clear it. The browser test checks its exact body after the draft settles, with
the original send/consent assertions and delivery budget intact.

Independent review of `ca4317c8..4fd63c90` found no blockers. Accepted its optional
R1: the deterministic race regression now also requires exactly one draft
creation. No runtime changes were needed after review. See `review-1.md`.

## Exact verification results

All commands ran from the fix worktree unless explicitly marked baseline.
Browser commands used `E2E_TRACE=1`, `E2E_CHILD_LOG_DIR` unset, one worker,
and zero retries. No aggregate `npm test` or full E2E run was launched for this fix.

| Check | Result |
| --- | --- |
| Deterministic pre-fix pending-prefill regression, both modes | 2 failed / 2, exit 1; default received instead of operator text |
| Original isolated consent test before fix | 1 passed, exit 0, 33.5s; not proof of a fix |
| Temporary browser-instrumented baseline repetition | 12 passed, exit 0, 184.267s; recorder subsequently removed |
| Post-fix exact consent test, three retained-trace repetitions | 3 passed, exit 0, 36.418s |
| Final consent-fence and matching entry-point browser cases | 5 passed, exit 0, 37.7s |
| Post-review focused unit checks | 44 passed in 3 files, exit 0, 14.46s |
| Post-review dashboard typecheck | exit 0 |
| Post-review E2E typecheck | exit 0 |
| Post-review touched-file ESLint | exit 1: four pre-existing composer errors, zero warnings, zero new errors |
| Base ESLint on the same existing paths at `ca4317c8` | exit 1: the same four composer errors |

Focused unit command:

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/broadcasts/BroadcastComposer.prefill.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/MessageEditor.test.tsx
```

Typechecks:

```powershell
npm run typecheck -w @housingchoice/dashboard
npm run typecheck -w @housingchoice/e2e
```

Exact consent proof:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/a2p-compliance.spec.ts --grep "a no-consent tenant" --trace=on --repeat-each=3 --global-timeout=180000
```

Related browser proof (two consent cases, three matching entry points):

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/a2p-compliance.spec.ts tests/dashboard-next/matching-entry-points.spec.ts --grep "a no-consent tenant|fan-out fence|tenant-file|property-page|Matching page" --trace=on --global-timeout=240000
```

Lint command:

```powershell
npx eslint dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.prefill.test.tsx e2e/tests/dashboard-next/a2p-compliance.spec.ts
```

The existing errors are `react-hooks/set-state-in-effect` at the unit-clear,
resolved prefill, multi-recipient prefill, and voucher-prefill effects. They
were compared with the clean base checkout in
`W:\tmp\outbound-mms-scroll-recheck`. New test and E2E file lint separately
exited 0; no errors/warnings came from those paths in the final combined run.

## Evidence and boundaries

- Original red full-suite trace and network/body adjudication are linked in
  `adjudication.md`; the full suite's historical 274/275 result is not replaced
  with a claim of aggregate green.
- Local browser results and traces are retained under
  `.superpowers/consent-evidence/green-focused` and `green-related`. The three
  exact-scenario traces submit custom `Open house` and `Re-include` drafts.
- The deterministic regression controls the editor callback/effect ordering.
  The original trace does not expose React's exact native event interleave.
- No dependency, backend, infrastructure configuration, message copy, or MMS
  viewer source changed. No sleeps, widened budgets, or weaker body comparisons.
- The E2E stack shut down normally; no listener remained on lane 11's four ports.
- `main` remained at `ca4317c8` during final checks; no incoming main commits.
- Branch is intentionally unmerged. Other worktrees and the original MMS
  artifacts were not modified or cleaned up.
