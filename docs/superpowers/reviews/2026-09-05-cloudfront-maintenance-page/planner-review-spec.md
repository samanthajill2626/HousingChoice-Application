# Parent spec-conformance review: CloudFront maintenance page

Date: 2026-09-07

Scope: Independent read-only comparison of approved spec
`docs/superpowers/specs/2026-09-05-cloudfront-maintenance-page-design.md`
against `39647ace4c8f1ea094eaaaa66569b6dbfbf997dd`. No test, process, AWS,
or infrastructure action was started for this review.

## Per-spec-item verdict

| Spec item | Verdict | Independent evidence |
| --- | --- | --- |
| 1. Outcome and scope | CONFORMS | The diff adds the fallback resources, document, offline checks, focused browser/API characterization, and operator documentation only. It does not change deploy code, data, jobs, schemas, outbound catalog behavior, or environment composition. The intended no-live-activation boundary is stated in `RUNBOOK.md:47-57`. |
| 2. Existing-behavior preservation | CONFORMS | Existing dynamic routes retain the all-method app origin behavior at `infra/modules/cloudfront/main.tf:157-169`; the read-only default stays on the app origin with its origin-request policy at `infra/modules/cloudfront/main.tf:203-211`; media remains independently conditional and seven-day cached at `infra/modules/cloudfront/main.tf:175-187`. The Terraform contracts assert those invariants at `infra/modules/cloudfront/tests/maintenance.tftest.hcl:113-190`. |
| 3. Page behavior and appearance (S1) | CONFORMS | One JSON catalog contains exactly the approved five strings at `app/src/messages/edgeMaintenance.json:1-7`. The actual Terraform template supplies lang, viewport, pre-content meta CSP, one main/h1/link, system styling, responsive layout, visible focus, and a plain `/` link at `infra/modules/cloudfront/templates/maintenance.html.tftpl:1-47`. Every copy interpolation is escaped in a text or title context at lines 7 and 41-44. `e2e/support/maintenancePage.ts:8-72` renders that exact template/catalog through Terraform rather than maintaining a second HTML copy; focused tests exercise escaped ampersands, brackets, and quotes at `e2e/support/maintenancePage.test.ts:29-49`. |
| 4. Independent origin and Terraform ownership (S2) | CONFORMS | The dedicated account-scoped bucket, owner enforcement, four public-access blocks, SSE-S3, exact object metadata/hash, and copy precondition are at `infra/modules/cloudfront/maintenance.tf:11-76`. The S3 REST origin has its own always-SigV4 OAC and no custom app header at `infra/modules/cloudfront/main.tf:124-128` and `maintenance.tf:78-84`. The exact-object, exact-distribution-ARN GetObject policy is at `maintenance.tf:86-100`; `maintenance_path` depends on the object while the policy depends on the distribution, avoiding the described graph cycle at lines 15 and 95-98. The exact read-only CachingDisabled behavior is at `main.tf:189-197`. |
| 5. Error-response contract | CONFORMS | The distribution contains exactly two mappings, 502 and 504, each preserving its status, using the exact page path, and setting a zero minimum TTL at `infra/modules/cloudfront/main.tf:213-225`. The mock contract rejects a missing mapping, extra 503, response-code 200, widened S3 object scope, and lost media OAC through the fixtures invoked at `scripts/check-maintenance-infra.mjs:205-233`; the Terraform assertions state the corresponding contract at `infra/modules/cloudfront/tests/maintenance.tftest.hcl:28-151`. No 503 mapping or deploy-health-script change is in the feature diff. |
| 6. Surface inventory (S3) | CONFORMS | The dashboard client remains status-bearing for HTML 502/504 and preserves typed JSON 503 behavior in `dashboard/src/api/client.maintenance.test.ts:6-43`, against unchanged request logic at `dashboard/src/api/client.ts:118-130`. The focused hermetic browser spec renders the actual template and covers 502/504, GET/form-POST origin, 320/1280 widths, text enlargement, dependencies, keyboard focus, and fresh GET-root recovery without query/body replay at `e2e/tests/dashboard-next/maintenance-page.spec.ts:12-101`. |
| 7. Verification and acceptance | CONFORMS WITH HOSTED CHECKS OWED | Recorded parent logs show typecheck, unit tests, smoke, Terraform formatting/source checks, backend-disabled validations, and the changed-file lint ratchet passed. `planner-e2e.log` records the raw full-suite exit 1 with 274 passed and the unchanged outbound-MMS visibility failure outside this feature. The implementation's offline checker documents and executes baseline/restored contracts, five fault probes, and copied dev/prod backend-disabled validation at `scripts/check-maintenance-infra.mjs:179-260`. I did not rerun any check in this review. |
| 8. Rollout and rollback (S4) | CONFORMS | `RUNBOOK.md:43-59` requires human-owned dev then prod plan/apply, initial healthy provisioning, propagation, direct-object checks, separately authorized selected-status substitution evidence, and mapping-only rollback retaining the resources. `e2e/README.md:61-73` distinguishes hermetic renderer/browser evidence and offline mock/source checks from AWS proof. |

## Findings

No implementation defect, missing spec item, or contradictory contract was found.

## Unverified hosted and operator checks

These are intentionally not implementation findings. The branch cannot prove them
without the human-owned post-merge operations described by the approved spec:

- successful guarded plan/apply and CloudFront/S3-policy propagation in dev, then prod;
- direct `/maintenance/index.html` 200 with the expected content type, cache control,
  and marker, plus healthy `/health` and application responses;
- separately authorized dev observation of an application URL other than the object
  path returning either 502 or 504 with `text/html` and `data-hc-maintenance="1"`,
  followed by the healthy response for that same URL after recovery.

The current state is: implemented in the branch; not activated; hosted
substitution unverified. After a successful apply and propagation, but before
the separately authorized substitution observation, the runbook state becomes:
configured; hosted substitution unverified.
