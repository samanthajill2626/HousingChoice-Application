---
id: relay-30003-classified-transient-retrying
title: A relay leg that fails 30003 is still classified transient-retrying in the log taxonomy, on a justification that is now false
type: bug
severity: low
status: open
area: app
created: 2026-09-01
refs: app/src/routes/webhooks/twilio.ts:286, app/src/routes/webhooks/twilio.ts:295, app/src/routes/webhooks/twilio.ts:2377
---

**Problem.** `TRANSIENT_RETRYING_DELIVERY_CODES = new Set(['30003'])`
(`app/src/routes/webhooks/twilio.ts:286`) exists to hold codes "we're still
auto-retrying (not yet terminal)". `isTerminalDeliveryFailure` (`:295`) reads
it, and the relay-leg failure marker at `:2377-2388` uses that answer to log a
failed relay leg at **WARN rather than ERROR** - explicitly on the grounds that
the code is transient-retrying.

**For the relay path that justification is false, and M5 made the contradiction
visible.** No relay retry is scheduled for any code: the status webhook returns
on the relay-pointer branch (`twilio.ts:2433-2437`) BEFORE the 1:1 retry branch
that owns the 30003 arm. `feat/retry-counter-durable` therefore stopped the
dashboard promising one - a relay leg now reads `Undelivered - Phone unreachable
(error 30003)` with no "will retry" (spec D19). So the product tells an operator
the leg is done while the server still classifies the same leg as retrying.

The OPERATIONAL half is the part worth deciding rather than assuming: WARN keeps
that leg out of the `hc-<env>-error-logs` alarm and out of the Recent Errors
panel. The severity call may still be the right one - a single relay leg to an
unreachable handset is not obviously alarm-worthy, and 30003 at scale would be
noisy - but the REASON recorded in the code is now wrong for relay, and a wrong
reason is what the next person will reason from.

Note the set is shared with the 1:1 and native-group-text paths, where 30003
retries are REAL (the 30003 arm carries no `group_text` guard, so a group text
retries like a 1:1). A blanket change would mis-classify those, which is exactly
why this needs a decision rather than a one-line edit.

**Suggested fix.** Either:

- split the classification by product at the relay-leg marker - keep the shared
  set for 1:1 / group text and give the relay branch its own predicate, whether
  that lands on ERROR or on a WARN with an honest reason; or
- keep WARN and rewrite the comment and the predicate's name so the recorded
  justification is "relay legs are not alarm-worthy at this volume", not "we are
  retrying this".

Either way the copy in the dashboard and the taxonomy in the webhook should
state the same fact.

**Why it was filed, not fixed.** `app/src/routes/webhooks/twilio.ts` is fenced
in its ENTIRETY on `feat/retry-counter-durable` (spec Sec 2 - it belongs to M4,
M12 and T-PUSH), so no change to it was in scope. See also
[`relay-30003-retry-lineage`](./relay-30003-retry-lineage.md): if a relay retry
ever becomes real, this classification becomes true again and the chip copy M5
set must be revisited in the same change.
