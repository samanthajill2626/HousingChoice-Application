# Consent E2E failure adjudication

Date: 2026-09-08. Authorized small fix; branch `codex/a2p-consent-e2e-fix`,
worktree `W:\tmp\a2p-consent-e2e-fix`, base `ca4317c844515f598439f9cd25b9c56b601773e8`.
The user requested adjudication and a fix for the failure from the preceding
full E2E run. No merge, deployment, aggregate unit suite, or new full E2E run.

## Evidence and attribution

The preceding full run had 274 passed / 1 failed, exit 1, 21.2 minutes. All six
outbound-MMS tests passed. The failure was the consent-preview/send/re-inclusion
scenario at `e2e/tests/dashboard-next/a2p-compliance.spec.ts:323`, then-line 415.

Original evidence is preserved, untouched, under
`W:\tmp\outbound-mms-scroll-recheck\.superpowers\scroll-recheck\full-suite-ca4317c8`.
The relevant trace is
`test-results/dashboard-next-a2p-complia-c1dbd-ng-consent-re-includes-them-chromium/trace.zip`.
The following are browser trace timestamps, not wall-clock milliseconds:

| Event | Timestamp | Observed state |
| --- | ---: | --- |
| Composer heading assertion snapshot | 23081.958 | Message empty, Preview disabled |
| Fill action starts | 23083.246 | Requested `Open house 236177` custom body |
| Fill input snapshot | 23095.756 | Message still empty |
| Fill completion snapshot | 23117.498 | Default property template, count 192 |
| Next checkpoint | 23120.032 | Still default, before draft creation/Preview |

Only one initial `POST /api/broadcasts` draft was created. Its body was the
default template, using the same-origin flyer fallback. The selected-recipient
send returned 200. The fake provider recorded the consented recipient's
personalized default at 02:07:17.664Z and marked it delivered at 02:07:17.964Z.
The test spent its 30-second poll waiting for different content, which no amount
of additional waiting could produce. The results screenshot shows three
delivered recipients. No send/back-end fix or increased timeout is justified.

The exact native event/React effect interleave is not recorded in the original
trace. Code inspection identifies a reachable overwrite: the two prefill
effects check a render-captured flag, then write text independently of the flag.
The deterministic component test injects the editor's edit callback before the
pending parent prefill effect, reproducing the exact default-over-edit state in
both recipient modes. This is a product state-update defect, not grounds to
weaken or wait around the E2E assertion.

An unmodified isolated baseline passed 1/1 (33.5s, exit 0). Twelve browser-only
instrumented repetitions also passed (184.267s, exit 0); these passing retries
are explicitly not treated as proof of a fix or proof of resource pressure.
The temporary input/setter recorder was removed before implementation proof.

## Change and focused proof

Message body and edit ownership now share one state value. Prefill uses a
functional updater that checks the current ownership when applied. Manual edits
win over an already-pending default; confirmed property/audience resets still
reset both fields. Existing pristine/resumable-draft behavior is retained.

The deterministic regression uses the real composer and editor, with an editor
wrapper that emits an edit at the pending-prefill boundary. It deliberately
controls the callback ordering instead of sleeping or depending on a rare native
race. Before the implementation it failed 2/2 (exit 1): received the default
template rather than the custom edit, in both modes. Afterward those cases pass
and assert the created draft body and editor value after Preview becomes enabled.

Initial proof:

- `npm run test -w @housingchoice/dashboard -- src/routes/broadcasts/BroadcastComposer.prefill.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/MessageEditor.test.tsx`:
  44/44, three files, exit 0 (15.41s).
- `npm run typecheck -w @housingchoice/dashboard`: exit 0.
- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/a2p-compliance.spec.ts --grep "a no-consent tenant" --trace=on --repeat-each=3 --global-timeout=180000`:
  3/3, exit 0 (36.418s), no retries. Each retained trace submits the custom
  `Open house` body and subsequent `Re-include` body, not the default template.

`E2E_TRACE=1` was set throughout; `E2E_CHILD_LOG_DIR` was unset. The passing-trace
override retains network proof. No shared infrastructure was restarted.
New-worktree artifacts are retained under `.superpowers/consent-evidence/`:
`baseline`, `instrumented-baseline`, and `green-focused`.

Touched-file ESLint initially returned four composer errors and one new test
dependency warning. The warning was corrected. The four errors are the same
`react-hooks/set-state-in-effect` diagnostics at the base: clearing the unit,
the two prefill effects, and voucher-size prefill. The base comparison ran the
same file paths in the clean `outbound-mms-scroll-recheck` checkout at
`ca4317c8`, exit 1, four errors. The new regression and changed E2E file alone
lint clean, exit 0. Do not describe the raw composer lint as green.

Independent adversarial review follows focused proof. Final results and any
review corrections will be recorded separately; this is not a merge verdict.
