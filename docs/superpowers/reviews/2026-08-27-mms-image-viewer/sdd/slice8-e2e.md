# Slice 8 - browser regression evidence

## Scope

- Source ownership: `e2e/tests/dashboard-next/outbound-mms.spec.ts` only.
- Production code was not edited by this slice.
- Browser validation used only the Task 8 command:
  `npm run e2e -w @housingchoice/e2e -- --grep "Outbound MMS"`.

## Shipped coverage

- Added a diagnostic viewer-scale reader and MutationObserver recorder that rejects every transient scale outside the hard `1..8` range.
- Desktop `1280x900`: proves same-tab/no-popup opening; only Close and Download actions; media modal/canvas/action geometry; fitted and centered image; discrete wheel intermediate levels, pointer anchoring, hard bounds and four-direction high-zoom pan; exact AppFrame and Timeline scroll preservation; Escape dismissal and exact-trigger focus restoration; Ctrl-wheel intermediate levels and bounds; close/reopen reset; and MediaGallery parity with the shared viewer.
- Mobile `360x800`: proves exact visual-viewport coverage, no horizontal overflow, usable action/canvas geometry under a hostile 2,048-character heading, CDP pinch intermediates and bounds, touch pan and four boundary drags, browser Back dismissal without route loss, exact-trigger focus restoration, and reopen reset.
- Relay group: proves a real shared-host attachment opens the same dialog/canvas/image viewer while preserving Conversation context.

## Red evidence

- Pre-Task-1 behavior was a raw media link/new browsing context, so the new no-popup, in-app dialog, geometry, gesture, history, focus, reset, MediaGallery, and relay-host assertions are regression tests that conceptually fail against that baseline. The slice could not execute against the old tree because the focused file also depends on production work from Tasks 1-7.
- Initial focused browser run after the E2E expansion: EXIT 1; `6 passed, 2 failed (1.5m)`. Desktop Escape and mobile Back both failed only at exact focus restoration; every earlier layout, zoom, bound, pan, history, and relay assertion reached green.
- After production commit `4178276e82ba9dbc10db7b8ca34978b356a940d7`: EXIT 1; `6 passed, 2 failed (1.3m)`, the same two focus assertions.
- After production commit `de6a6535685119b761f76491298cd6d27bb4c817`: EXIT 1; `6 passed, 2 failed (1.3m)`, the same two focus assertions.
- Diagnostic rerun: EXIT 1; `6 passed, 2 failed (1.3m)`. A temporary identity/focus recorder showed the production behavior was correct and the test locator was unstable:
  - Desktop and mobile original clicked buttons were connected, outside inert trees, and were `document.activeElement` after dismissal.
  - Each focus event sequence ended on the original marked button.
  - The dynamic `getByRole(...).last()` resolved a different connected, same-named thumbnail after the Timeline updated (`sameNode=false`).
  - The permanent test now marks the actual clicked node and asserts/reopens that exact node. Debug-only logging and recorder code were removed.
- Failure screenshots/videos/error contexts were created under the two Playwright test-result directories during red runs; the final Playwright run cleaned/replaced transient browser artifacts. The durable diagnostic conclusion is recorded here.

## Green evidence

- `npm run e2e -w @housingchoice/e2e -- --grep "Outbound MMS"`: EXIT 0; `8 passed (45.2s)`.
- `git diff --check -- e2e/tests/dashboard-next/outbound-mms.spec.ts`: EXIT 0.
- `npx eslint e2e/tests/dashboard-next/outbound-mms.spec.ts`: EXIT 1 only for pre-existing line 48 `DIANA_ID` unused. Baseline `HEAD` already contains the same unused declaration at its prior line 41 and no use, so this is not a new lint error from the slice.
- The first sandboxed E2E attempt exited before tests because Docker API access was denied. All reported browser counts above are from the same exact workspace-qualified command with the required Docker permission.

## Divergence and residual risk

- Plan behavior did not change. The only test adjustment was strengthening exact-trigger focus assertions from a dynamic `.last()` locator to the uniquely marked node actually handed to the provider.
- Benign pre-existing React/console and `NO_COLOR` warnings did not cause assertion failures.
- The real-browser proof is bundled Chromium. CDP gesture synthesis exercises Chromium's touch pipeline but is not a physical iOS/Safari device run.
- Commit: `4ca47f50` (`test: verify image viewer on desktop and mobile`).
