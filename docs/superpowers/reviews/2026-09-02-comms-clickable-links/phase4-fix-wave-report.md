# Phase 4 fix-wave report

Date: 2026-09-02
Scope: confirmed implementation-review findings C1, C2, P1, and P2 only.

## Changes

- `LinkifiedText` now permits Autolinker `scheme` matches through the final
  `safeHttpUrl` boundary only when the original source has explicit `http://` or
  `https://` authority. Bare TLD and protocol-relative normalization remain
  parser-owned and unchanged.
- Added regressions for `http:example.com/a`, `https:example.com/a`, and
  `http:///example.com/a`; each preserves exact text and creates no anchor.
- The E1 spec now uses a shared lean reseed helper before its mutation and in
  `test.afterEach`. Playwright runs that hook after an assertion failure as well
  as after a passing test; a failed restore makes the test fail rather than
  silently leaving residue.
- Replaced the new Timeline em dash with ASCII `-`.
- Corrected S1 evidence: Autolinker is MIT; `tslib@2.8.1` is 0BSD. The existing
  no-hook, no-optional-dependency, no-native-path, Windows, Linux ARM64, and
  audit attribution evidence is retained.

## TDD and focused proof

1. Before the parser change, `npm test --workspace @housingchoice/dashboard --
   src/ui/LinkifiedText.test.tsx` exited 1: the three new malformed-scheme cases
   failed by receiving anchors normalized to `http://example.com/a`.
2. After the narrow source-authority guard, the same command exited 0: `1 passed`,
   `23 passed`.
3. `npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts` exited 0:
   `1 passed (17.0s)`. Its terminal log includes the post-test lean reseed after
   the planted fixture request.
4. The representative later, mutation-bearing, no-self-reseed dashboard spec
   `npm run e2e -- tests/dashboard-next/inbox-comms.spec.ts` exited 0: `1 passed
   (20.9s)`. This runs after E1's cleanup against the restored lean lane.
5. `npm run typecheck --workspace @housingchoice/dashboard` exited 0.
6. `npm run build --workspace @housingchoice/dashboard` exited 0 (Vite emitted
   its existing chunk-size advisory only).
7. `node -p "require('./node_modules/autolinker/package.json').license + ' / ' +
   require('./node_modules/tslib/package.json').license"` printed `MIT / 0BSD`.
8. The added-line ASCII scan against the base and the final working tree printed
   no non-ASCII additions. `git diff --check` exited 0.

## Divergence

None. This wave used `afterEach` rather than `afterAll` because it is the
unconditional assertion-failure boundary requested by the review; its single
fixture-mutating test remains limited to the hermetic local lane.
