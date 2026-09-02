---
id: outbound-mms-presign-ttl-one-hour
title: Outbound MMS presign TTL (1h) is SHORTER than Twilio's 10h queue window - a queued send can find a dead media URL
type: bug
severity: med
status: open
area: app
created: 2026-09-02
refs: app/src/routes/api.ts:1214, app/src/jobs/retrySend.ts:34, app/src/jobs/relayFanOut.ts:89, app/src/services/sendMessage.ts:406
---

**Problem.** Every outbound MMS attachment goes to Twilio as a presigned S3 GET
URL with a 3600-second TTL - the same value at all three presign sites (the 1:1
send route, the retry job, the relay fan-out). We set no `ValidityPeriod` on any
send, so we inherit Twilio's default queue TTL, which is **36,000 seconds (10
hours)** since May 2025 (raised from the older 4-hour default). A message may
therefore sit in Twilio's queue for up to 10 hours before it is sent.

Twilio does NOT publish when it fetches the media - at API-call time or when the
message leaves the queue - and it issues both GET and HEAD to the URL, so it is
at least two fetches. If any fetch happens after the message has been queued
longer than an hour, it lands on an EXPIRED presigned URL and the media fails.
The failure mode is a delivery bug, not a security one: an outbound MMS that
loses its attachment (or fails outright) precisely in the backlog conditions
where a queue builds up.

This is a MISMATCH, not a value to tune in isolation: the presign TTL and the
validity period are two ends of the same window, and today they disagree by 9
hours in the dangerous direction.

**Secondary (security, minor).** A presigned URL is a BEARER TOKEN: anyone
holding the string fetches the bytes over the open internet with no session. It
lives in our outbound request, in Twilio's request/debug logs, and - because
`sendMessage` persists it - in the message record in DynamoDB. Persisting it is
deliberate and documented (a historical record of exactly what was sent; it is
EXPECTED to expire and is never reused - a retry re-presigns fresh from
`media_attachments`, the durable truth). Presigned URLs are correctly never
logged. Recorded only because the durable `s3Key` is already persisted
alongside, so the signed string carries no information the record lacks.

**Suggested fix.** Set the two ends of the window together, in this order:

1. DECIDE the `ValidityPeriod` for our sends - a product call, not a technical
   one: how late is a tenant-facing message still worth delivering? Twilio
   accepts 1..36,000 seconds. Conversational messages argue for hours, not the
   full 10.
2. Set that `ValidityPeriod` explicitly on outbound sends (we set none today).
3. Make the presign TTL equal to the chosen validity period PLUS margin, at all
   three presign sites, so the URL cannot die before Twilio gives up on the
   message. Shortening the presign TTL toward "minutes" without step 2 makes
   the mismatch WORSE, not better.

**Do not start step 3 in `jobs/relayFanOut.ts` without checking worktree
ownership** - that file was owned by the live relay-30003 mission as of
2026-09-02.

**Worth checking first:** whether this has already bitten. It would surface as
an outbound MMS whose media failed to fetch after a queue delay, not as an
obvious error at send time.

Found during the sibling sweep for
[`authenticated-mms-media-browser-cache`](authenticated-mms-media-browser-cache.md).

Sources: Twilio's queueing/latency guide (10-hour default queue TTL) and the
Programmable Messaging docs (MediaUrl must be publicly reachable; GET and HEAD
issued to validate Content-Type).
