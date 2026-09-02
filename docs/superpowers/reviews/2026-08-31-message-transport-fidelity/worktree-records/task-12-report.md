# Task 12 - Hermetic message transport fidelity E2E

## Result

Committed Task 12 as `1cfc5d7091878e5776df7d80f29cd95f8a767f51` (`test: cover message transport fidelity end to end`). The focused hermetic Playwright spec passes and covers all twelve required browser-observable contracts using accessibility-first selectors and the documented message-parent locator.

## Red/green evidence

- Initial sandbox-only launch attempt: exit 1 before Playwright started because the managed sandbox denied `mkdir W:\tmp\message-transport-fidelity\e2e\.artifacts` (`EPERM`). This was environment setup evidence, not the intentional TDD red.
- Intentional TDD red: `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/message-transport-fidelity.spec.ts` exited 1 with 1 failed. Runtime was 29.8s for the test. The signed `/webhooks/twilio/status` request returned 200, the server logged `status callback for unknown provider SID after retry`, and the UI remained `RCS` instead of expected `RCS -> SMS`. This proved the missing callback-addressable dev fixture control. The emitted failure artifact path was `e2e/.artifacts/test-results/dashboard-next-message-tra-14a60-oss-dashboard-message-hosts-chromium/`; later focused runs replaced the default Playwright output directory.
- First implementation run: exit 1 with 1 failed. It reached the optimistic replacement assertion; the received bubble text already contained `SMS`, exposing an unnecessarily brittle regex assertion. No application change was needed for that failure.
- Final green: the same required targeted command exited 0 with `1 passed (41.4s)` and test runtime `14.0s`.
- Final Playwright artifacts are preserved at `e2e/.artifacts/html-report/index.html` (532,966 bytes) and `e2e/.artifacts/results.json` (4,451 bytes), both stamped 2026-09-01T23:59Z.

## Browser proof matrix

1. Direct outbound send reaches the fake provider and its replacement row shows `SMS`.
2. A requested-RCS row initially shows `RCS`, then changes through the signed callback/refetch path.
3. That signed SM callback resolves the row to `RCS -> SMS`.
4. A complete two-recipient attempted send shows `RCS -> Mixed` and one RCS plus one RCS-to-SMS leg.
5. An incomplete attempted recipient set stays conservatively `RCS`.
6. Signed inbound SM, MM, and RCS-evidenced callbacks show only actual `SMS`, `MMS`, and `RCS`.
7. The unresolved inbound lean fixture shows `Unknown`.
8. The text-only native group fixture shows `MMS`.
9. The schema-absent legacy fixture retains its legacy `SMS` chip.
10. An inbound Relay source stays `SMS`, while its outbound Gloria leg shows `RCS -> SMS`.
11. The intercepted optimistic row has no carrier chip until the real POST completes and the replacement arrives.
12. An excluded recipient without a suppression code is absent, while a state-absent recipient and an opted-out excluded recipient remain visible.

## Hermetic fixture controls

- Extended the already dev-only, triple-gated `POST /__dev/extraction/message-fixture` route. An optional realistic SM/MM `providerSid` uses `MessagesRepo.append()` to create the real SID pointer needed by a signed status callback. Optional `relaySenderKey` and validated per-recipient delivery/transport facts shape Relay and aggregation fixtures. The existing arbitrary-createdAt direct-write path remains unchanged for callers without `providerSid`.
- Added `postStatusCallback()` to `e2e/fixtures/fakeTwilio.ts`. It generates the real Twilio HMAC signature and posts to the actual app webhook. `ChannelPrefix` remains type- and runtime-restricted to `rcs`; the coverage never fabricates `ChannelPrefix: sms` or derives transport from body/media inference.
- The dev router remains structurally absent from deployed environments. No production route, runtime behavior, dashboard code, or unrestricted fake-provider behavior changed.

## Verification

- Focused E2E: exit 0, 1 test passed.
- `npm run typecheck -w @housingchoice/app`: exit 0.
- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- `npm run test -w @housingchoice/app -- test/devMessageTransportFixture.test.ts`: exit 0, 1 file passed, 9 tests passed.
- `npx eslint app/src/routes/dev.ts e2e/fixtures/fakeTwilio.ts e2e/tests/dashboard-next/message-transport-fidelity.spec.ts`: exit 0, no output.
- `git diff --check`: exit 0, no output.
- New E2E spec ASCII scan: no non-ASCII additions found.

## Exact files

- `app/src/routes/dev.ts`
- `e2e/fixtures/fakeTwilio.ts`
- `e2e/tests/dashboard-next/message-transport-fidelity.spec.ts`

Commit delta: 3 files changed, 570 insertions, 11 deletions. The ignored report is not part of the commit.

## Git state and divergence

- Commit: `1cfc5d7091878e5776df7d80f29cd95f8a767f51`
- Branch: `feat/message-transport-fidelity`
- Worktree: `W:\tmp\message-transport-fidelity`
- Post-commit status: clean.
- `MERGE_HEAD`: absent before commit.
- Against local `main` (`7be4013984a33f4823b5f47f240dfdd1f53a998d`): 94 behind, 65 ahead (`git rev-list --left-right --count main...HEAD`). Final mission sync remains parent-orchestrator work.
