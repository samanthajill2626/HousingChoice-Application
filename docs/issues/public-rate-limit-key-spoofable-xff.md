---
id: public-rate-limit-key-spoofable-xff
title: Per-IP rate limits key on the client-chosen first X-Forwarded-For entry, so one viewer gets unlimited buckets
type: security
severity: high
status: resolved
area: app/middleware
created: 2026-10-12
resolved: 2026-10-12
refs: app/src/middleware/rateLimit.ts:28-34, app/src/middleware/rateLimit.ts:67-74, app/src/app.ts:161, app/src/app.ts:172, app/src/routes/public.ts:31, app/src/routes/public.ts:480, app/src/services/publicOrgList.ts:17, infra/modules/cloudfront/main.tf:22, app/src/middleware/requestLogger.ts:41
---

**Problem.** `clientIpOf` (`app/src/middleware/rateLimit.ts:67-74`) keys every per-IP
limiter on the FIRST `X-Forwarded-For` entry. CloudFront APPENDS the viewer address to
any `X-Forwarded-For` the viewer already sent (the origin request policy is
AllViewerExceptHostHeader, `infra/modules/cloudfront/main.tf:22`, and no CloudFront
Function or WAF strips the header), so at the origin the header reads
`<whatever the client sent>, <real viewer IP>` and the first entry is chosen by the
client. The comment at `rateLimit.ts:28-34` says CloudFront appends the viewer IP and
then reads the other end. The request logger already labels the header
`xffTrust: 'untrusted-until-validated'` (`requestLogger.ts:41`).

Consequence (pre-existing, found by the join-housing-authority R1 adversarial review,
2026-10-12): every per-IP limiter is per-request for a client that rotates a fake first
hop. Most important is the shared `/public` limiter (`PUBLIC_RATE_LIMIT_MAX`, default 5
per minute), the documented SMS-spend fence on `POST /public/housing-fair`: one client
can sign up unlimited phone numbers, each sent the welcome text from the business number
(cost, and carrier/A2P complaint risk on the campaign). The new
`GET /public/housing-authorities` 60-per-minute limit inherits the same key. Reproduced
in a throwaway test against the default resolver: 200 list reads from one true viewer
with a rotating prefix, 0 refused; 20 sign-ups (PUBLIC_RATE_LIMIT_MAX=5), 0 refused, 20
welcome texts. Control: the same viewer with no spoofed prefix is refused at read 61.

Per-USER limiters (`createUserRateLimit`, keyed on the session) are not affected.

**Suggested fix.** Its own small change with its own review (shared middleware): first
confirm the production hop chain (CloudFront -> the EC2 origin on HTTP, no reverse proxy
found in infra/), then key on the LAST `X-Forwarded-For` entry (the one CloudFront
appended; the origin is reachable only through CloudFront because of the origin-secret
check), or add `CloudFront-Viewer-Address` to the origin request policy and key on it.
Add a `clientIpOf` test with a multi-entry header, and correct the "per-IP" comments.

When this lands, also correct the "per-IP" comments that describe the limits as if the key
were trustworthy, including those added by join-housing-authority for the list read:
`app/src/routes/public.ts:31` and `:480`, `app/src/app.ts:161` and `:172`,
`app/src/services/publicOrgList.ts:17` (join-housing-authority R2-N3, 2026-10-12).

**Added 2026-10-12 (join-housing-authority planner review, adversarial A3/A7).** With
that branch, a `/join` sign-up starts as Onboarding with Atlanta Housing Authority
preselected, so a client rotating a fake first hop can also inject arbitrary phone
numbers into Atlanta-filtered property blasts (each number already gets the welcome
text today), and can drive unbounded consistent reads of the org-list item through
`GET /public/housing-authorities`. Both ride on this key; fixing the key closes both.

**Resolution (2026-10-12, fix/public-rate-limit-key).** Cameron chose the
`CloudFront-Viewer-Address` key over the last X-Forwarded-For entry, plus IPv6 grouping.
`clientIpOf` (`app/src/middleware/rateLimit.ts`) now keys on that header and NEVER reads
X-Forwarded-For; with no readable header (local dev, the e2e lanes, tests) it falls back
to the socket address. An IPv6 client is keyed by its /64, and an IPv4-mapped address by
its IPv4. A joined (comma) or unparseable header value also falls back to the socket,
never to a value it cannot read.

Proven on two throwaway CloudFront distributions in the HousingChoice
account with the same `Managed-AllViewerExceptHostHeader` policy and an echo origin
(httpbin.org over HTTP, like ours), created and deleted 2026-10-12:

- CloudFront sets the header itself (`<viewer IPv4>:<port>`), so no origin request policy
  change and no Terraform is needed. The AWS docs disagreed on this: the user guide says
  the policy includes "all viewer location headers", while the API's `allExcept` wording
  mentions only viewer headers. Only the live test settled it.
- Every forged value was REPLACED by the real viewer address: a single forged line, two
  forged lines in mixed case, an IPv6-shaped value, and a forged value sent together with
  a forged `X-Forwarded-For` (3 of 3). One empty reply on the first distribution's
  combined case did not recur in 3 tries on the second.
- The original mechanism, live: with `X-Forwarded-For: 9.9.9.9` sent, the origin received
  `9.9.9.9, <real viewer>, <edge>` - the first entry is the client's.

Read-only `aws cloudfront list-distributions` (2026-10-12): hc-dev-app and hc-prod-app
both attach that policy to `/public/*`, with no CloudFront Function, Lambda@Edge or WAF,
so nothing rewrites headers between CloudFront and the app. NOT verified: CloudFront's
IPv6 spelling of the header (no IPv6 test client was available); one public report says
unbracketed with the port after the last colon, and the parser accepts that and the
bracketed form.

The request logger now also records `cloudfront-viewer-address`, so a deployed request
shows the key. Tests: `app/test/rateLimitClientKey.test.ts` (4 of its cases fail against
the old first-entry resolver). The "per-IP" comments listed above, including
join-housing-authority's, are accurate once the key is trustworthy, so none needed
changing; that branch's list-read limiter inherits the fix through the default resolver.
The residual - a caller with many REAL addresses - is
[`public-welcome-text-global-cap`](public-welcome-text-global-cap.md).
