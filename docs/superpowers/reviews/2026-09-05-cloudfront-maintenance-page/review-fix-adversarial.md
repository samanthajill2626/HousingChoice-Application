# Adversarial re-review: maintenance source guard

## MUST-FIX

None.

## PLAUSIBLE

None.

## NO-FINDING

The fix closes the confirmed comment and expression bypasses. The scanner removes
`#`, `//`, and block comments only while outside a double-quoted HCL string,
including escaped quotes (`scripts/check-maintenance-infra.mjs:55-112`). The
source contract then requires exactly one whole, active
`origin_request_policy_id` assignment in the sole default behavior rather than
counting an expected substring (`scripts/check-maintenance-infra.mjs:115-133`).
The hash-comment, block-comment, null-expression, and quoted/escaped-string
fixtures exercise the relevant parser branches (`scripts/check-maintenance-infra.mjs:136-159`), and the failed source assertion has a distinct marker and log
record (`scripts/check-maintenance-infra.mjs:120-130`).

I also swept the active configuration source and its consumers. The default app
behavior still forwards the managed all-viewer-except-host policy
(`infra/modules/cloudfront/main.tf:203-211`); the maintenance behavior remains
read-only and uses its separate S3 OAC origin (`infra/modules/cloudfront/main.tf:124-128`, `infra/modules/cloudfront/main.tf:189-197`); and only 502/504 map to
that document while preserving their statuses (`infra/modules/cloudfront/main.tf:213-225`). The mocked module contract independently asserts the app default
behavior and its forwarding policy (`infra/modules/cloudfront/tests/maintenance.tftest.hcl:113-151`). The two environment module calls are equivalent in
their CloudFront inputs (`infra/envs/dev/stack.tf:134-149`,
`infra/envs/prod/stack.tf:134-149`).

Browser and API recovery remain coherent with the distribution-wide HTML
fallback: non-JSON failures become status-bearing `ApiError` values without a
retry (`dashboard/src/api/client.ts:55-75`, `dashboard/src/api/client.ts:104-121`),
and the browser proof checks that the document's action performs a fresh GET
home navigation after both GET and POST failures (`e2e/tests/dashboard-next/maintenance-page.spec.ts:19-97`). The only application-specific 502/504
consumer found treats them as ambiguous outcomes, so retaining the status and
avoiding replay is required and remains intact
(`dashboard/src/routes/contact/CreateRelayGroupModal.tsx:144-162`).

Verdict: fixes are real. The checker is deliberately a narrow structural guard
over its owned, formatted module source; it is not a general HCL parser. That
is sufficient here because Terraform validates the copied baseline before the
guard, and the guard's purpose is the provider-mock gap for this exact
assignment (`scripts/check-maintenance-infra.mjs:196-221`). I did not run tests,
servers, Terraform, or cloud operations.
