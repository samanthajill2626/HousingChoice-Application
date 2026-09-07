# Parent final handback: CloudFront maintenance page

Date: 2026-09-07
Branch: `codex/cloudfront-maintenance-page`
Worktree: `W:\tmp\cloudfront-maintenance-page`
Independently tested and reviewed revision:
`39647ace4c8f1ea094eaaaa66569b6dbfbf997dd`
Main at verification: `f82c149cf8523cbdb2f6d6ff3bdedc6583951ab4`

## Verdict

The implementation is complete and the two independent parent reviews found no
remaining implementation findings. It is UNMERGED and NOT ACTIVATED. The required
full browser gate is still red: 274 passed and one unchanged outbound-MMS test
failed with its documented main-reproduced signature. This is not an unconditional
merge-ready verdict. Native 200 percent browser zoom also remains manually owed.

The feature replaces eligible CloudFront 502/504 error bodies with a self-contained
HousingChoice maintenance page fetched from its own private S3 origin. It retains
the failure status and offers Try again as a new GET to the dashboard home. It
does not add a 503 mapping or turn failures into successful responses. The
fallback applies distribution-wide, including API/webhook requests, while those
requests retain their failure status. It cannot keep an unavailable app usable
or update an already-open dashboard into a banner.

## Spec and work-map disposition

| Approved spec item | Delivery and parent disposition |
| --- | --- |
| 1. Outcome and scope | CONFORMS. Edge fallback, local proof, and operator instructions are implemented. No live activation occurred. |
| 2. Existing behavior | CONFORMS. App method/forwarding behavior, origin secret, default caching, and optional media origin/OAC remain intact. |
| 3. Page behavior, S1 | CONFORMS. Canonical five-string catalog, escaped actual Terraform template, restrictive pre-content CSP, responsive layout, visible keyboard focus, and plain GET-home action. |
| 4. Origin and ownership, S2 | CONFORMS. Dedicated private per-environment bucket, SSE-S3, owner enforcement, public blocks, exact object/distribution policy, independent SigV4 OAC, and exact read-only caching-disabled behavior. |
| 5. Error responses | CONFORMS. Exactly 502 and 504, status preserved, exact page path, minimum error TTL 0. No 503 or 200 mapping. |
| 6. Surface inventory, S3 | CONFORMS. Actual-template GET/POST browser coverage passes; HTML 502/504 remains a status-bearing API error and typed JSON 503 behavior is preserved. |
| 7. Verification | LOCAL IMPLEMENTATION PROOF PASSES WITH A RED FULL GATE. All eight new browser scenarios pass; full-suite MMS failure and native zoom gap are disclosed below. Hosted checks remain owed. |
| 8. Rollout and rollback, S4 | CONFORMS. Runbook describes healthy initial provisioning, dev then prod rollout, propagation checks, authorized substitution evidence, and mapping-only rollback. |

`planner-review-spec.md` contains the independent item-by-item source evidence.
`planner-review-adversarial.md` records the separate plan-blind review.

## Independent validation

The selected lane was a full feature mission. The parent ran the complete bare
gates independently on the tested revision, with no competing suite in this
worktree. Logs were redirected without piping the gate commands; their actual
exit statuses were retained. Only documentation changed afterward.

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run typecheck` | 0 | `.superpowers/sdd/planner-typecheck.log` and `.exit` |
| `npm test` | 0 | `.superpowers/sdd/planner-test.log` and `.exit`; 10,640 passed and 1 skipped across five workspaces |
| `npm run smoke` | 0 | `.superpowers/sdd/planner-smoke.log` and `.exit`; 1,396 imports across 246 emitted files resolve under plain Node |
| `npm run e2e` | 1 | `.superpowers/sdd/planner-e2e.log` and `.exit`; 274 passed, 1 failed in 19.7 minutes; all 8 maintenance scenarios passed |
| Explicit changed-file ESLint ratchet | 0 | Four touched TypeScript paths plus the checker script were supplied as explicit arguments; no new lint errors |
| `node --check scripts/check-maintenance-infra.mjs` | 0 | Separate syntax proof for the script |
| `terraform fmt -check infra/modules/cloudfront/main.tf infra/modules/cloudfront/maintenance.tf infra/modules/cloudfront/tests/maintenance.tftest.hcl` | 0 | All touched HCL formatted |
| `node scripts/check-maintenance-infra.mjs <locked-provider-mirror>` | 0 | `.superpowers/sdd/planner-infra.log` and `.exit`; baseline/restored mock contracts, fault probes, source fixtures, and copied dev/prod backend-disabled init/validate passed |
| `git diff --check main...HEAD` | 0 | Parent corrected the two branch-added trailing blank lines before independent gates |

The existing ESLint configuration does not apply style rules to `.mjs`. Its exit
0 is not a style-rule assertion for the checker script; the syntax and behavioral
checks are separate proof. The explicit TypeScript paths were
`dashboard/src/api/client.maintenance.test.ts`,
`e2e/support/maintenancePage.test.ts`, `e2e/support/maintenancePage.ts`, and
`e2e/tests/dashboard-next/maintenance-page.spec.ts`.

The unit workspace totals were app 359 files / 6,749 passed / 1 skipped;
dashboard 189 / 3,036; e2e 21 / 499; fake Twilio 34 / 245; and fake Twilio web
13 / 111. No actual `[dynamoAdmin]` fault line was present in the parent run.

The provider mirror was the existing read-only cache at
`W:\AI Projects\Housing Choice\HC Application\infra\envs\dev\.terraform\providers`.
The checker used disposable copies and locked providers, not live state. Its raw
scratch evidence is `.superpowers/maintenance-infra/hc-maintenance-infra-42c6My/`.
Both named mock runs had to execute and pass in the baseline and restored copies;
zero selected tests cannot pass the checker. Five negative cases run through
mocked Terraform; default-forwarding checks are explicitly labeled in-process
source checks with negative comment/expression fixtures and a positive quoted
string fixture. They are not claimed as six Terraform fault cases.

## Full browser gate adjudication

The parent failure was
`e2e/tests/dashboard-next/outbound-mms.spec.ts:591:42`,
`locator.evaluate: Error: trigger is not visible`. The failing specification is
unchanged relative to current main. The same signature has prior full-suite main
control evidence at `d4298abe`, recorded in
`docs/issues/e2e-outbound-mms-viewer-trigger-not-visible.md` and
`docs/issues/outbound-mms-viewer-trigger-visibility-full-suite.md`.

The builder also reproduced that exact full-suite failure and obtained an
isolated six-test pass. The isolated pass is not a root-cause diagnosis and does
not turn the required full-suite exit 1 into green. No unrelated MMS code or test
was changed. The existing issue remains unresolved.

The parent enabled `E2E_TRACE=1` and left `E2E_CHILD_LOG_DIR` unset to avoid
changing the timing regime. Before later QA could overwrite the failure, the
parent preserved `trace.zip`, `test-failed-1.png`, `video.webm`, and
`error-context.md` in
`.superpowers/sdd/planner-e2e-outbound-mms-20260907T1956/`.

## Review fixes and live QA

Parent cold review confirmed F1: the original default-forwarding source guard
could count policy text inside a comment or an expression that always yielded
null. Commit `9ce87b85` fixed that with quoted-string-aware comment removal,
complete assignment matching, and permanent negative/positive fixtures. The
independent fix review and both final parent reviews found no remaining concrete
implementation defect.

The builder handback called two trailing blank lines pre-existing. They were
branch-added review-record whitespace; parent commit `39647ace` removed them.
This correction changed documentation only.

`planner-live-qa.md` records the parent's real hermetic dashboard recovery proof:
502 GET and 504 POST both recovered to the unmocked sign-in page through one new
GET to `/`, without query/body replay. Desktop and narrow layouts, keyboard
focus, dependency absence, and 200 percent text enlargement passed. Screenshots
are `.playwright-mcp/planner-maintenance-desktop.png` and
`.playwright-mcp/planner-maintenance-narrow.png`.

Native 200 percent browser zoom could not be exercised: the computer-use tool
failed window ownership inspection twice before any input. Root-font enlargement
is explicitly not native zoom evidence. The owned hermetic lane was stopped
successfully; shared DynamoDB Local was left running.

## Mainline and human handoff

The builder's required main sync was a no-op at `f82c149c`; the parent independently
confirmed the branch was 0 commits behind that unchanged main. No second sync or
merge into main was performed. Final record commits do not alter implementation.

After the human resolves or explicitly accepts the disclosed verification gaps,
the copy-pasteable merge command is:

```powershell
git -C "W:\AI Projects\Housing Choice\HC Application" merge --ff-only codex/cloudfront-maintenance-page
```

This command was not run. If main advances, assess the new drift before merging.

Activation remains human-owned. Follow `RUNBOOK.md`'s CloudFront maintenance
section: review the guarded dev plan, apply while the app is healthy, allow
distribution/policy propagation, and verify the object, application, and health
responses; repeat the approved rollout in prod. A separately authorized dev
observation must verify that an application URL returns a selected 502/504 with
the expected HTML marker and later recovers at the same URL. Until then, hosted
substitution is unverified. No app redeploy is required for this edge change.
Rollback removes the two mappings while retaining the maintenance resources.

No AWS writes, live Terraform plan/apply, deployment, secret pushes, real
environment edits, branch cleanup, or worktree cleanup occurred. The AUTO
15-minute supervision ends at this final independent handback; its heartbeat is
paused and the parent-owned transcript mirror is stopped as part of handoff.
