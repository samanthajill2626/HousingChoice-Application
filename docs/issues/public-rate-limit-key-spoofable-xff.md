---
id: public-rate-limit-key-spoofable-xff
title: Per-IP rate limits key on the client-chosen first X-Forwarded-For entry, so one viewer gets unlimited buckets
type: security
severity: high
status: open
area: app/middleware
created: 2026-10-12
refs: app/src/middleware/rateLimit.ts:28-34, app/src/middleware/rateLimit.ts:67-74, app/src/app.ts, app/src/routes/public.ts, infra/modules/cloudfront/main.tf:22, app/src/middleware/requestLogger.ts:41
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
