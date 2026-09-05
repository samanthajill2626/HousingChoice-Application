# CloudFront maintenance page

Date: 2026-09-05
Status: Design draft for independent review and human approval; not implemented or deployed.
Worktree: W:\tmp\cloudfront-maintenance-page
Branch: codex/cloudfront-maintenance-page
Base: main at f82c149cf8523cbdb2f6d6ff3bdedc6583951ab4

## 1. Outcome and scope

During an application outage, people opening or refreshing HousingChoice should see a small branded availability page instead of CloudFront's default gateway error screen. The page must remain reachable while the EC2 app is restarting.

This feature configures automatic fallback for HTTP 502, 503, and 504. It does not activate a planned-maintenance switch before a deployment. It does not change the container replacement process, introduce a proxy or second app, add an in-app connection banner, retry submissions, or promise zero downtime. Already-open dashboards keep their existing API error behavior.

The implementation is a full feature mission because it adds a new public response and an independent origin. Human approval is required for the written spec and build launch. Merge and live AWS changes remain separate operator steps.

## 2. Existing behavior verified in the repository

- `infra/modules/cloudfront/main.tf:9` explicitly disables custom error pages. The distribution sends the default behavior and `/api/*`, `/webhooks/*`, `/auth/*`, and `/public/*` to EC2; their caching policy is Managed-CachingDisabled.
- The separate `/unit-media/*` behavior reads only public unit photos from the media bucket through OAC. Its existing seven-day cache and the private-media boundary must remain unchanged.
- `scripts/deploy.mjs:548` pulls images and runs Docker Compose replacement before checking local health. `docker-compose.yml:14` publishes the one app container on port 8080.
- `dashboard/src/api/client.ts:56` only parses JSON when the content type says JSON; non-2xx responses still become ApiError when the body is HTML. Retaining the original status is sufficient for this wrapper to recognize a failed request, but the original JSON error detail will be replaced for the selected codes.
- `app/src/messages/catalog.ts:1` is the outbound SMS/voice/email catalog. Its channel contract at line 100 has no web-page channel. This design adds a separate static edge-copy catalog under the same messages directory, without widening outbound channel or operator-template contracts.
- Dev and prod consume the same CloudFront module. `infra/envs/dev/stack.tf` and `infra/envs/prod/stack.tf` are deliberately byte-identical.

These are source findings, not a measurement of live outage duration or current deployed infrastructure.

## 3. Page behavior and appearance

The page is a complete static HTML document, with `lang="en"`, viewport metadata, an informative title, one main landmark, one h1, and one visible action. It is usable at 320 CSS pixels and at desktop widths, supports keyboard focus and zoom, and has no horizontal overflow.

Canonical copy, held once in `app/src/messages/edgeMaintenance.json`:

| Key | Exact text |
| --- | --- |
| brand | HousingChoice |
| title | HousingChoice - Temporarily unavailable |
| heading | Temporarily unavailable |
| body | HousingChoice is temporarily unavailable. Please try again shortly. |
| action | Try again |

Use the existing dashboard's restrained appearance: background #f7f8fa, white content surface, text #1a1d23, muted text #5b6472, blue action #1f6feb, and the system font stack from `dashboard/src/ui/tokens.css`. Keep the layout simple and centered, with a readable card width, generous spacing, and a visible focus outline. A textual brand is enough; no generated logo or image is needed.

The action is a normal same-origin link with href `/`, styled as a button. It starts a GET navigation to the application home, even if the failed URL was an API, authentication callback, or form POST. It must not reload or resubmit the original request. It does not preserve a deep link. There is no JavaScript, auto-refresh, health polling, form submission, tracking, external font, external stylesheet, or app-served asset dependency.

The wording describes temporary unavailability without asserting a deployment is in progress, promising a recovery time, or claiming an earlier form or message was saved. It introduces no new domain vocabulary.

## 4. Independent origin and Terraform ownership

Keep the implementation within the existing CloudFront module, using `maintenance.tf` for dedicated resources and `templates/maintenance.html.tftpl` for markup. The module reads the JSON copy catalog and renders it with Terraform templatefile; both Terraform and test rendering consume the same copy source. No Node or dashboard build is needed to run Terraform.

The copy catalog accepts exactly the five keys above, with nonempty ASCII string values. Interpolate copy only into HTML text/title contexts and HTML-escape it before rendering. A focused test must prove escaping for ampersand, angle brackets, and quotes; do not rely on the present English wording remaining harmless forever. No copy value controls a URL, CSS, script, or HTML attribute.

Create one dedicated private S3 bucket per environment, named from `name_prefix`, `maintenance`, and the current account ID. Do not reuse the media bucket. Configure bucket-owner-enforced ownership, all four public-access blocks, and explicit SSE-S3 encryption. No CORS, public ACL, website hosting endpoint, app IAM grant, or upload API is needed. Keep force_destroy false; no bucket versioning or object-retention subsystem is added for this replaceable static artifact.

Terraform owns exactly one object with key `maintenance/index.html`, content type `text/html; charset=utf-8`, Cache-Control `no-store, max-age=0`, and a content hash so copy/template changes update it. The object must be created after ownership/encryption/public-access resources and before the distribution references it. Content must contain no secret, environment data, request detail, or user data.

Add a separate S3 REST origin and OAC with signing_behavior always and signing_protocol sigv4. The bucket policy grants only s3:GetObject on this exact object to the CloudFront service principal, conditioned on this environment's exact distribution ARN. It grants no list, write, or wildcard-object access. The app's x-origin-verify header must never be attached to this S3 origin.

Use an exact ordered path pattern `/maintenance/index.html` with GET/HEAD only, HTTPS redirection, compression, and Managed-CachingDisabled. Do not forward viewer cookies, query strings, Authorization, or the app's origin-request policy to the maintenance origin. Other paths retain their existing targets and methods, including the read-only default. Do not change media caching, distribution aliases, TLS, origin timeouts, WAF/security-group behavior, or environment composition.

Terraform's resource graph must avoid a dependency cycle: the distribution can depend on the object/OAC/bucket, and the bucket policy can depend on the distribution ARN, but the distribution cannot depend on that policy. On initial rollout, keep the app healthy and do not deploy concurrently; fallback access is not proven until apply finishes, distribution propagation completes, and the exact CloudFront page URL has been verified. A brief initial policy-propagation interval is not claimed to be protected.

## 5. Error response contract

Add exactly three custom_error_response entries:

| Origin/edge error | Viewer status | Response page | Error minimum TTL |
| --- | --- | --- | --- |
| 502 | 502 | /maintenance/index.html | 0 |
| 503 | 503 | /maintenance/index.html | 0 |
| 504 | 504 | /maintenance/index.html | 0 |

Never remap to 200, never change all errors to 503, and leave 400/401/403/404/405/500 and all other codes alone. Retaining 504 also keeps the existing deploy `/health` check failing while the application is unavailable. A direct GET of the maintenance object is expected to return 200; it is not a health signal.

CloudFront custom error configuration is distribution-wide, not scoped to page navigation or the default behavior. For the selected statuses, API, auth, public POST, webhooks, scripts, and unit-photo requests can also receive the HTML body with the original failure status. Existing successful bodies, 4xx responses, and 500 JSON detail are unchanged. No claim is made that API/webhook JSON or TwiML bodies survive a selected error. The application fetch wrapper must continue throwing a status-bearing ApiError for each selected HTML error; a focused regression test covers this. Provider retry behavior is not newly implemented or guaranteed.

The maintenance document is self-contained so it cannot recursively request failed app assets. Security policy for the document should be delivered in a meta CSP before content: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'. There is no executable content. Do not depend on a response-headers policy on the error-object behavior being copied onto every substituted response; enforce no external dependency in the actual document and test it.

Set the maintenance object's cache policy to disabled and all three error minimum TTLs to zero. The existing app behaviors already use Managed-CachingDisabled, which AWS documents as not caching error statuses/custom pages. Do not alter the existing unit-photo cache semantics: CloudFront can still serve an already cached photo during a 5xx failure. The zero TTL is not a promise of instant recovery from all caches, S3 error behavior, or CloudFront propagation.

The page is reactive: CloudFront must first receive a selected error or declare a timeout. It cannot remove the wait before timeout. AWS can bypass a custom page for its own 503 Capacity Exceeded or Limit Exceeded errors; an unavailable fallback S3 origin also prevents delivery.

## 6. Surface inventory and implementation boundary

- CloudFront distribution default, dynamic app, unit-media, and new exact maintenance behavior: route precedence, method allowlists, origin security, and caching remain coherent.
- Dedicated bucket/OAC/policy/object: create, content update, read scope, and safe retained-resource rollback.
- Static copy catalog and template: one copy source, HTML escaping, no app/runtime dependency.
- Browser top-level navigation: 502/503/504 document, keyboard action, narrow/desktop layout, safe GET recovery, and successful app navigation once available.
- Dashboard API client: selected HTML failures retain ApiError status; no product banner or new retry behavior.
- Public/auth/webhook callers, deploy health probe, assets, and media: selected failures retain status; nonselected codes and success responses are unaffected.
- Existing CloudFront behavior parser guard: the added read-only behavior must not disturb the exactly-one all-method behavior check or hide a missing public mutating prefix.
- Dev/prod shared module, documented plan/apply, and rollback: no new environment secret, parameter, runtime dependency, SSM command, app image build, or normal deploy-script step.

No data repository, seed, mutation endpoint, background job, session store, or schema is changed by this feature.

## 7. Verification and acceptance

Design-stage checks are limited to source investigation, ASCII/doc consistency, and independent document review. No completion gate or local stack is required before the human approves the spec.

Implementation must demonstrate:

1. Terraform source/config checks prove exact mappings/statuses/TTLs, independent object origin, restrictive policy, exact read-only route, and unchanged existing route/method contracts. Include fault fixtures that remove a mapping, rewrite a response to 200, or widen S3 access so a broken guard cannot pass silently.
2. Offline Terraform formatting and backend-disabled validation prove valid configuration without cloud mutation. Verify both environment compositions still match. Provider installation may need permitted network access; document any unavailable validation honestly.
3. Render the actual Terraform template with the actual JSON catalog for page QA; browser tests must not substitute a separately hand-authored approximation. Exercise HTML escaping and the self-contained document contract.
4. Use the e2e workspace harness with a focused maintenance-page spec. Serve/fulfill the actual rendered document as 502, 503, and 504 at a hermetic navigation URL, verify visible copy/layout/keyboard action, then verify the action performs GET `/` with no original query/body replay. Cover an error document originating from a form POST as well as a page GET. Do not induce a live outage. Prove that an API HTML 5xx still throws with its status.
5. Run the full bare feature gates before final independent handback review: npm run typecheck; npm test; npm run smoke; npm run e2e; and touched-file ESLint with the existing baseline ratchet. Sync main once before final gates, following concurrency rules. Focused local browser proof and source checks do not claim to emulate the AWS edge.
6. Record human-run hosted activation separately: successful Terraform apply and distribution propagation; direct page 200 with expected Content-Type/content; normal `/health` and application responses; original-status fallback and recovery observed during a separately authorized dev deployment or outage exercise. Production outage induction is not authorized. No hosted fallback claim without corresponding evidence.

## 8. Rollout and rollback

After the branch is built, independently reviewed, and human-merged, an operator uses the repository's account-guarded `npm run plan -- dev` and `npm run apply -- dev`, then verifies dev before repeating plan/apply for prod. This feature itself requires no app redeploy. Review each plan for unrelated drift; do not approve unrelated changes on behalf of this feature. Keep ordinary deployments separate from first-time fallback provisioning.

A rollback removes only the three custom error mappings and applies that change; keep the dedicated origin, object, OAC, and bucket resources in place. This restores CloudFront's normal error screen without deleting resources or attempting to destroy a nonempty bucket. Full feature/resource removal is separately authorized cleanup. Keep these operator instructions in RUNBOOK.md when implemented; do not edit historical design documents.

## 9. References

- AWS separate-origin recommendation: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-procedure.html
- AWS error mapping contract: https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CustomErrorResponse.html
- AWS error processing and CachingDisabled: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
- AWS supported errors and service exceptions: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/creating-custom-error-pages.html
- AWS error TTL limits: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html

