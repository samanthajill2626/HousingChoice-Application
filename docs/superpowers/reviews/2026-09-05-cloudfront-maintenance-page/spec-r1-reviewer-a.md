# Spec R1 adversarial review A

Reviewed 2026-09-05. Scope: the CloudFront maintenance-page design, current
CloudFront module and its behavior guard, current S3/OAC media pattern, env
composition, deploy replacement and health check, dashboard API client, and
the hermetic Playwright harness. I also checked the AWS CloudFront custom-error,
error-caching, and managed-cache-policy documentation cited by the design.

## Result

No actionable findings.

## Evidence checked

- The current distribution deliberately has no custom responses, uses a
  read-only default behavior, all-method app-prefix behaviors, and a separate
  OAC-backed S3 behavior for unit media at
  `infra/modules/cloudfront/main.tf:9-24`, `infra/modules/cloudfront/main.tf:92-195`.
  An exact maintenance path cannot overlap the current wildcard media path or
  the app-prefix behavior set.
- The existing media design demonstrates the intended non-cyclic graph: the
  distribution consumes an S3 origin while only the bucket-policy resource
  consumes the distribution ARN at `infra/envs/dev/stack.tf:27-40` and
  `infra/modules/s3_media/main.tf:61-96`. The proposed object-before-
  distribution and policy-after-distribution ordering preserves that shape.
- The current behavior guard requires exactly one all-methods behavior and a
  read-only default, so a read-only maintenance behavior is compatible with it
  at `app/test/cloudfrontBehaviors.test.ts:65-132`. Its source parser will need
  an intentional extension only if implementation changes the dynamic-block
  structure; the design already calls that guard out at design:92.
- The dashboard client throws an ApiError from every non-2xx response after
  declining to parse non-JSON content at `dashboard/src/api/client.ts:55-75`
  and `dashboard/src/api/client.ts:104-122`. Preserving each selected status
  therefore satisfies the stated API contract.
- The proposed isolated local proof is realistic: the hermetic harness supports
  Playwright request fulfillment at
  `e2e/tests/dashboard-next/comms-clickable-links.spec.ts:51-56`, uses its own
  loopback lane at `e2e/playwright.config.ts:70-90`, and has no CloudFront
  dependency. It cannot prove an edge deployment, which the spec correctly
  reserves for an authorized hosted check at design:106-108.
- AWS documents that CloudFront selects the first cache behavior matching the
  response-page path and fetches the page from that behavior's origin. It also
  documents that a configured page behavior uses that behavior's TTL. The
  design's exact path, separate S3 REST/OAC origin, CachingDisabled behavior,
  preserved response codes, and zero error minimum TTL are coherent with those
  semantics. AWS further documents the 503 Capacity Exceeded and Limit Exceeded
  exception, which the design expressly excludes at design:82.

No repository claim in this report relies on uninspected source. No cloud,
stack, browser, or test action was performed.
