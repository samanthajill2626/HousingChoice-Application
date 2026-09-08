# Plan R1 adversarial review A

Reviewed 2026-09-07 against the approved maintenance-page spec, current
CloudFront module, dashboard API-client readers, the e2e harness and its
viewport contracts. No infrastructure, application suite, browser, or cloud
action was run.

## Findings

### HIGH - Planned narrow-layout assertions are prohibited and do not prove the requirement

Evidence: The planned maintenance spec performs two hand-written assertions
using `document.documentElement.scrollWidth` at plan:786-787 and plan:792-793.
The repository's viewport guard scans every e2e TypeScript source and fails any
such occurrence outside `e2e/support/viewport.ts` at
`e2e/support/viewport.guard.test.ts:55-70`. This is not advisory: a literal S3
implementation makes the e2e workspace test suite red. The reason is also
load-bearing: the dashboard shell moves horizontal overflow into the routed
`main`, so the document-only measurement is vacuous for routed pages at
`e2e/support/viewport.ts:35-85` and
`e2e/support/selectors.md:123-132`.

Consequence: The plan cannot pass the required full test gate as written, and
its stated 320px no-overflow proof is not accepted by the repository's enforced
test contract.

Suggested correction: In S3, import and use
`expectNoHorizontalOverflow(page, descriptiveName)` from
`e2e/support/viewport.js` before and after text enlargement. It measures both
the document and the actual main surface, works for this static document, and
avoids the guard violation. Retain the 320px case required by the approved spec.

### MEDIUM - S2's preservation guard does not cover the existing media OAC boundary or default forwarding/caching

Evidence: The approved spec requires the existing unit-media private-media
boundary and cache behavior to remain unchanged at design:19-20 and
design:60, and the plan repeats that preservation requirement at plan:28. The
current module attaches the media origin to its OAC and deliberately omits the
application header at `infra/modules/cloudfront/main.tf:124-133`; its default
behavior retains CachingDisabled and AllViewerExceptHostHeader at
`infra/modules/cloudfront/main.tf:187-195`. In contrast, S2's media assertion
only checks the media behavior's target, cache policy, response-headers policy,
and allowed methods at plan:394-415. It never checks that the media origin keeps
its OAC or remains free of an app header. The default assertion checks only its
target and allowed methods at plan:374-390, omitting its cache policy and origin
request policy. The four planned fault probes cover only the new mappings and
the maintenance bucket policy at plan:491-503.

Consequence: A regression that removes the media OAC, attaches the app secret
to media, or changes default forwarding/caching can pass every new mocked
contract and fault probe, despite violating an explicit feature preservation
boundary. A manual diff review at plan:668 is not an executable guard against
that drift.

Suggested correction: Extend the `media_stays_independent` assertion to require
the existing media origin's OAC, no custom header/custom-origin configuration,
and its current viewer and cached-method contract. Extend the default-behavior
assertion to require its current CachingDisabled and AllViewerExceptHostHeader
IDs, plus its current viewer/cached-method settings. Add at least one targeted
fault mutation for the media OAC or default policy so the preservation assertion
is shown to fail when its protected boundary is removed.
