# Fix-wave cold re-review - clickable communications links

Date: 2026-09-02
Reviewer: Phase 4 fresh re-review
Scope: fix-wave commit `7df3c13d` over `52c1209d`

## Verdict: PASS

No new must-fix finding was found. The four confirmed findings are fixed by
the current code and the repair remains within the stated review scope. This
review inspected the fix diff, all current `LinkifiedText` consumers, the E1
test's local-lane cleanup, and the live parser/safety boundary.

## New-findings sweep

### None - no severity

The fix changes only `LinkifiedText`, its focused tests, the one E1 spec, a
comment character, and license evidence. All live renderer consumers remain
the Timeline message body, collapsed and expanded plain-text email body, and
opened unmatched-email detail at
`dashboard/src/routes/contact/Timeline.tsx:1035-1038,1506-1518` and
`dashboard/src/routes/email/UnmatchedRow.tsx:182-184`. The unmatched preview
is still a button child and is not linkified. No new mutation, route, parser
renderer, or nested-interactive surface was introduced by the fix.

## Cold review of the fix code

### None - no severity

`normalizedHref` at `dashboard/src/ui/LinkifiedText.tsx:30-39` now requires a
scheme-classified source to begin with an explicit `http://` or `https://`
authority before the final `safeHttpUrl` boundary. The tld and protocol-relative
branches remain unchanged. A direct installed-package probe confirmed that
Autolinker recognizes all three repaired malformed inputs as scheme matches,
while their source strings fail this authority predicate:

```
http:example.com/a
https:example.com/a
http:///example.com/a
```

They therefore become exact source text instead of anchors. The focused
regressions at `dashboard/src/ui/LinkifiedText.test.tsx:93-101` assert both
properties. The guard is applied before `safeHttpUrl`, so WHATWG URL repair
cannot silently turn any of those malformed labels into a different
destination. Existing explicit HTTP(S), bare tld, and protocol-relative paths
still pass through their established final safety check.

The source range, same-length angle-bracket masking, direct text-node output,
and stopped anchor click propagation are untouched. I found no new HTML,
event-lifecycle, key, parser-offset, or test-isolation regression in the fix
diff.

## Prior findings and adjudication

### P1 - fixed

`e2e/tests/dashboard-next/comms-clickable-links.spec.ts:30-37` defines one
lean reseed helper and registers `test.afterEach` before the mutating test.
The test first reseeds at `:44`, plants the fixture at `:49`, and the cleanup
runs after both a passing test and an assertion failure. Because Playwright is
configured for one worker at `e2e/playwright.config.ts:140-141`, this restores
the hermetic lane before the next test gets it. A failed cleanup is asserted
with `response.ok()` and fails the test, rather than leaving a passing but
dirty focused run. The fix-wave report records both E1 and the later
`inbox-comms.spec.ts` run as passing after this boundary was added.

### P2 - fixed

The original concern was concrete URL-parser repair after a scheme match. The
new source-authority predicate at
`dashboard/src/ui/LinkifiedText.tsx:31-33`, paired with the three regression
cases at `LinkifiedText.test.tsx:93-101`, closes that path. The fix-wave report
records the pre-fix test failure and post-fix `23 passed` focused result. The
adjudication's required condition is met without expanding allowed schemes.

### C1 - fixed

The changed Timeline comment at
`dashboard/src/routes/contact/Timeline.tsx:9` now uses ASCII `-`. The
fix-wave report records a no-output added-line ASCII scan and a passing
`git diff --check`.

### C2 - fixed

`docs/superpowers/reviews/2026-09-02-comms-clickable-links/s1-dependency-proof-adjudication.md:11-14`
now distinguishes Autolinker's MIT license from tslib's 0BSD license. The
recorded installed-manifest probe printed `MIT / 0BSD`; that agrees with the
corrected evidence.

## Resolution guidance

No additional fix wave is indicated. Re-run the affected focused checks only
if a subsequent change touches the parser guard or E1 cleanup; continue with
the required final full gates and live self-QA before handback.
