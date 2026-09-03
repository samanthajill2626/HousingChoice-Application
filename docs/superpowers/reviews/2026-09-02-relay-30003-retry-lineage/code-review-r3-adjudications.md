# Code review R3 - adjudications

R3 (scoped, fresh) found nothing above LOW in wave 2 and verified all nine
corrections real; its verdict - merge-ready from a code-review standpoint -
is accepted. Its three LOWs form a final, small wave 3; its two NOTEs are
recorded.

## Wave 3 (three items)

- **X1 (R3 LOW 1) one ERROR line per thrown claim.** W2's rethrow reaches
  Express's generic handler, which logs its own `unhandled error while
  handling request` at ERROR beside our marker - two datapoints on the
  `ErrorLogs` alarm for one throttle, and a comment that claims one. The
  route catches the rethrown claim error itself and answers
  `res.status(500).end()` (Twilio still redelivers on any 5xx), so the marker
  is the only ERROR line; comment and report corrected. Test: a rejected
  `append` yields exactly one ERROR line and a 500 response.
- **X2 (R3 LOW 2, comment) redelivery re-emits `delivery_failed`.** Inherent
  to any redelivery, before and after this branch; Q4's multiplier note gains
  the clause. Comment-only, in the W9c comment.
- **X3 (R3 LOW 3) the chip's not-confirmed reason is fenced to retry-aware
  legs.** W5's chip reason read the whole not-confirmed union, so a plain
  stale leg carrying a transient code (30022) could print
  `Delivery failed (error 30022)` beside `isFailure: false`. The reason list
  on that branch is built only from legs whose `retryState` is `retrying` or
  `unconfirmed`. Test: a stale non-retry leg with a transient code yields no
  chip reason; an `unconfirmed` retry leg still yields its carrier reason.

## Recorded

- R3's two NOTEs, as written in its file.
- R3 challenged W2's "one ERROR line" clause (X1 closes it) and W5's chip
  half (kept: D21's spirit is that the positions agree, and the chip's reason
  is now fenced by X3); everything else upheld, including Q4 with the
  redelivery multiplier added.
