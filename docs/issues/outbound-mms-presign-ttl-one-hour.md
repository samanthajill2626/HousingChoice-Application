---
id: outbound-mms-presign-ttl-one-hour
title: Outbound MMS presigned GET URLs are 1-hour bearer tokens, and the signed URL is persisted
type: security
severity: med
status: open
area: app
created: 2026-09-02
refs: app/src/routes/api.ts:1214, app/src/jobs/retrySend.ts:34, app/src/jobs/relayFanOut.ts:89, app/src/services/sendMessage.ts:406
---

**Problem.** Every outbound MMS attachment is handed to the provider as a
presigned S3 GET URL with a 3600-second TTL - the same value at all three
presign sites (the 1:1 send route, the retry job, the relay fan-out). A
presigned URL is a BEARER TOKEN: anyone who holds the string can fetch the
bytes over the open internet with no session, no cookie, and no login. This is
the one media flow an unauthenticated party genuinely and routinely fetches.

The provider fetches within seconds of the send, so the token is live roughly
three orders of magnitude longer than it is needed. During that hour the string
exists in our outbound request, in the provider's own request/debug logs, and -
because `sendMessage` persists it - in the message record in DynamoDB.

Persisting the signed URL is deliberate and documented (a historical record of
exactly what was sent; it is EXPECTED to expire and is never reused - a retry
re-presigns fresh from `media_attachments`, the durable truth). It is recorded
here not as a defect but because it widens where a live token can be read from
during its window, and because the durable `s3Key` is already persisted
alongside it, so the signed string carries no information the record lacks.

Presigned URLs are correctly never logged (s3Key and counts only).

**Suggested fix.** Two independent, cheap steps:

1. Shorten the TTL to the smallest value the provider's fetch actually needs
   (minutes, not an hour). VERIFY FIRST that no path presigns materially before
   the send: the relay fan-out presigns per leg at fan-out time and retry
   re-presigns fresh, so both look safe, but a queued/scheduled or
   `queued_pending` send must be checked rather than assumed.
2. Consider persisting a redacted form (or only the `s3Key`, already present) in
   place of the full signed string, keeping the historical record without
   keeping a live token at rest.

**Do not start step 1 in `jobs/relayFanOut.ts` without checking worktree
ownership** - that file was owned by the live relay-30003 mission as of
2026-09-02.

Found during the sibling sweep for
[`authenticated-mms-media-browser-cache`](authenticated-mms-media-browser-cache.md).
