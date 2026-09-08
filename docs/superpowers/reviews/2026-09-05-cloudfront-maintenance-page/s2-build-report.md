# S2 build report: CloudFront maintenance infrastructure

## Contract and implementation

S2 adds one independent, private S3 REST origin for `maintenance/index.html`.
It has its own always-signed SigV4 OAC and a single `s3:GetObject` grant for
that exact object, conditioned on this distribution ARN. The bucket has owner
enforcement, all four public-access blocks, SSE-S3, and `force_destroy = false`.

The distribution retains the existing app and optional media origins, behaviors,
OAC, origin secret/header, cache settings, TLS, aliases, and security behavior.
It adds only the exact `GET`/`HEAD`, HTTPS redirect, compression, CachingDisabled
`/maintenance/index.html` behavior with no viewer forwarding and status-preserving,
zero-TTL mappings for 502 and 504. There is no 503 mapping or success remap.
The distribution has no dependency on the bucket policy; the policy depends on
the distribution ARN.

## RED then green configuration proof

RED command: `node scripts/check-maintenance-infra.mjs` exited 1 before the
checker existed, with `MODULE_NOT_FOUND` for that script. The mocked Terraform
contract test had already been added at that point.

GREEN command: `node scripts/check-maintenance-infra.mjs "W:\AI Projects\Housing Choice\HC Application\infra\envs\dev\.terraform\providers"` exited 0. It used the documented optional plugin mirror only as read-only input. The checker copied configuration into a disposable `hc-maintenance-infra-*` directory, set `TF_INPUT=0`, `TF_IN_AUTOMATION=1`, and `AWS_EC2_METADATA_DISABLED=true`, removed AWS/TF environment credentials, initialized with `-backend=false -lockfile=readonly`, and made no plan, live apply, state read, provisioner call, or AWS authentication.

Checker evidence is retained in `.superpowers/maintenance-infra/hc-maintenance-infra-LcAMKS/`:

- Module init and validate exited 0.
- Baseline and restored baseline each ran `maintenance_contract` and
  `media_stays_independent`: `Success! 2 passed, 0 failed.`
- `missing-504`, `extra-503`, and `false-success` each exited 1 with
  `HC_MAINTENANCE_MAPPINGS` and `Test assertion failed`.
- `wide-s3-read` exited 1 with `HC_MAINTENANCE_POLICY` and `Test assertion failed`.
- `media-oac-removed` exited 1 with `HC_MAINTENANCE_MEDIA_PARITY` and
  `Test assertion failed`; its app contract run passed and media run failed.
- `default-forwarding-removed` is an in-process anchored source assertion,
  because the AWS mock materializes the default origin-request policy even when
  the HCL sets it to `null`. Its log records `source assertion failed
  (in-process check): HC_MAINTENANCE_APP_PARITY`; the aggregate Node checker
  accepts that expected probe failure. This is not presented as a Terraform
  exit code.

The copied `dev` and `prod` roots compared byte-equal for `stack.tf` and
`outputs.tf`. Each retained its own full lockfile and completed backend-disabled,
readonly init and validate with exit 0.

## Feasibility corrections

The initial copied module lockfile included root-only `random`, while the module
declares AWS alone; readonly init correctly refused to prune it. The checker now
proves exactly one `random` provider stanza exists and removes it only from the
disposable module copy, preserving the locked AWS version/checksum. Copied roots
keep their independent complete lockfiles unchanged.

Terraform 1.15.6 selected zero tests for the plan sample's POSIX filter path on
Windows. The checker uses `path.join('tests', 'maintenance.tftest.hcl')` and
requires both named runs plus their exact two-pass baseline/restored summaries,
so zero-test success cannot pass. The provider mock limitation above is handled
by the narrow anchored source assertion; the other five probes remain mocked
Terraform assertions.

## Focused checks

- `terraform fmt infra/modules/cloudfront/main.tf infra/modules/cloudfront/maintenance.tf infra/modules/cloudfront/tests/maintenance.tftest.hcl`: exit 0.
- `terraform fmt -check infra/modules/cloudfront/main.tf infra/modules/cloudfront/maintenance.tf infra/modules/cloudfront/tests/maintenance.tftest.hcl`: exit 0.
- `node --check scripts/check-maintenance-infra.mjs`: exit 0.
- The originally requested workspace command exited 1 before running a test because DynamoDB Local at `http://localhost:8000` was unreachable; it also reported no matching test files for that workspace invocation. The shared local DynamoDB stack was not started or restarted during concurrent work.
- Corrected static-guard invocation from `app`: `ALLOW_SKIP_DYNAMO_TESTS=1 npx vitest run test/cloudfrontBehaviors.test.ts` exited 0 with `1 passed` file and `9 passed` tests. It explicitly skipped the unavailable DynamoDB integration lane (631 tests across 46 suites), which is sufficient for this source-only slice check and is not a completion-gate substitute.

This is local mocked/offline configuration proof only. It does not prove that a
hosted CloudFront distribution or S3 policy has propagated, substituted a 502 or
504 response, or served the maintenance document.
