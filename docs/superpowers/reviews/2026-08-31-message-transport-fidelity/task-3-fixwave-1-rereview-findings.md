# Task 3 fix wave 1 cold re-review finding

Reviewed commit: `5296694a fix: preserve concurrent transport evidence`

## P1: queued successful acceptance retains a stale transient error

`app/src/repos/messagesRepo.ts:3271` limits error cleanup to `sent`, which
protects terminal diagnostics but excludes the normal successful Twilio
`accepted` result. `mapTwilioStatus()` maps `accepted` to internal `queued`, and
source recipient slots begin queued. A retried successful queued result can add a
SID/time yet leave an earlier transient provider error forever.

Add a focused DynamoDB Local case for a queued slot with a transient error followed
by same-status successful acceptance. Clear that transient error without weakening
the protection for duplicate terminal failure results. Keep the shared webhook fake
aligned.

The re-review also confirmed that the prior terminal-diagnostic, final-race, and
stale-RCS observability findings are closed at `5296694a`.
