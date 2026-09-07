# Adversarial Review: CloudFront Maintenance Page

## Findings

No must-fix findings.

The changed distribution keeps the existing app, media, and default cache
behaviors separate while adding one exact maintenance behavior. The new S3
bucket policy grants only CloudFront, conditioned on this distribution ARN,
read access to only `maintenance/index.html`. The 502 and 504 mappings retain
their original status and use that exact behavior. See
`infra/modules/cloudfront/main.tf:101-224` and
`infra/modules/cloudfront/maintenance.tf:13-101`.

The application client continues to turn non-JSON 502 and 504 bodies into
status-bearing `ApiError` values without replaying a request
(`dashboard/src/api/client.ts:96-121`); its focused regression covers both
statuses and a POST (`dashboard/src/api/client.maintenance.test.ts:7-23`).
The page itself has no executable or external asset dependency and escapes the
catalogued values in every insertion site
(`infra/modules/cloudfront/templates/maintenance.html.tftpl:1-47`).

I swept the app's CloudFront mount classification, all existing distribution
behaviors, API error parsing, application 502/504 consumers, the maintenance
renderer, the local browser proof, the Terraform mock contracts, and the
operator command path. No additional mutator or consumer requires a change.
No test suite or live/cloud operation was run for this review.

Residual risk: the local browser test deliberately fulfills a response and the
Terraform test uses a mocked provider, so neither can prove hosted CloudFront
substitution. The operator procedure correctly leaves that as a separately
authorized dev observation after apply and propagation (`RUNBOOK.md:51-55`).
