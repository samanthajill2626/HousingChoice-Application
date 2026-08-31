---
id: backfill-scan-pulls-message-bodies
title: The media content-type backfill Scans whole message rows, pulling bodies to the operator's machine
type: security
severity: low
status: open
area: app/scripts
created: 2026-08-27
refs: app/scripts/backfill-media-content-types.ts:432-442
---

**Problem.** The backfill's `ScanCommand` carries a `FilterExpression` but no
`ProjectionExpression`, so DynamoDB returns EVERY attribute of every matching
message row - including `body`, the message text
(`app/scripts/backfill-media-content-types.ts:432-442`). The script needs only
`conversationId`, `tsMsgId`, `direction`, `provider_sid`, `mediaUrls`,
`media_attachments` and `media_s3_keys`.

A DynamoDB FilterExpression runs AFTER the read, so this is not a performance
nit: the full text of every media-bearing message in the table crosses the
network to whichever machine the operator ran the script on, which for an ops
script is a laptop rather than a server. The module header states the script
logs "counts and IDs only", which is true of its LOGGING and reads as though it
were true of its data handling.

Nothing is written anywhere - the rows live in memory for the duration of a
page - so the exposure is transit and process memory, not storage. That is why
this is low rather than medium.

**Suggested fix.** Add a `ProjectionExpression` naming exactly the seven
attributes above, with `ExpressionAttributeNames` for any reserved words. Verify
against the code that reads each row before changing it - a missing attribute
would silently make rows look unrepairable rather than erroring, which is the
failure mode to avoid. The existing test suite covers the row-shape paths and
should catch an omission.

Found by the planner's plan-blind adversarial review, run retroactively after
`feat/media-content-type-fidelity` had already merged.
