# Parent adversarial code review

Reviewed `39647ace4c8f1ea094eaaaa66569b6dbfbf997dd` against
`f82c149cf8523cbdb2f6d6ff3bdedc6583951ab4` without reading the feature
specification, plan, builder handback, or previous review and adjudication records.

## Findings

No concrete reachable findings.

## Sweep summary

- Traced both custom 502 and 504 mappings in
  `infra/modules/cloudfront/main.tf` through the exact
  `/maintenance/index.html` behavior, separate S3 REST origin, OAC, and the
  source-ARN-constrained single-object bucket policy in
  `infra/modules/cloudfront/maintenance.tf`.
- Checked precedence and preservation of the app's mutating prefixes, default
  behavior, and optional unit-media S3 origin. The new exact path does not
  overlap an existing behavior, and the app origin still retains its request
  policy and origin-secret header.
- Checked response consumers: dashboard API calls use the shared client, which
  treats a substituted HTML 502/504 as an `ApiError` without parsing or replaying
  the mutation. Direct browser navigation keeps the error status and the page's
  retry action issues a new GET to `/`.
- Checked cache behavior and the application response headers. The maintenance
  object and behavior are no-store/caching-disabled, while the mappings set a
  zero error minimum TTL. Existing application 5xx responses are JSON 500/503
  paths, so this change does not replace their typed refusal bodies.
- Reviewed the renderer, browser coverage, Terraform assertions, and the
  isolated infrastructure-check script for path handling, template escaping,
  secret forwarding, and disposable-file cleanup.

No tests, processes, AWS actions, or live environments were started by this review,
per the review charter.
