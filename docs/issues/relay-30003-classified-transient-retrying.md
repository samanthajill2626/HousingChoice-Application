---
id: relay-30003-classified-transient-retrying
title: A relay leg that fails 30003 is still classified transient-retrying in the log taxonomy, on a justification that is now false
type: bug
severity: low
status: resolved
area: app
created: 2026-09-01
resolved: 2026-09-02
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

**Resolution (2026-09-02, feat/relay-30003-retry-lineage).** The first of the
two suggested fixes: the relay branch now has its OWN predicate rather than
reading the shared set for severity. `isTerminalRelayLegFailure(errorCode,
outcome)` is attempt-aware ON TOP of the existing carve-out - a relay leg logs
at WARN while a retry is actually claimed (`claimed`, `already_claimed`) and at
ERROR once the chain is terminal, while 21610 keeps its provider-side opt-out
carve-out and announcement legs (`fenced_announcement`, the relay intro,
member-added, group-closed and every tour-reminder rung) stay WARN. So the
recorded justification is now true for every path that carries it.

Every relay delivery-failure line additionally carries a `retryClaim` field
naming WHY no retry is running, which is what makes the new alarm
self-describing - an ERROR reading `source_unreadable` is an internal fault and
says so, one reading `cap_exhausted` is a genuine unreachable handset. The
eleven values are `claimed`, `already_claimed`, `cap_exhausted`, `gate_refused`,
`fenced_announcement`, `to_missing`, `to_malformed`, `source_unreadable`,
`slot_ineligible`, `code_not_retryable` and `enqueue_failed`, unioned as
`RelayRetryClaimOutcome` in `app/src/lib/relayRetryClaim.ts` so the webhook and
the retry job cannot disagree. `source_unreadable` also takes its own message
string rather than the shared carrier-shaped one.

`TRANSIENT_RETRYING_DELIVERY_CODES` keeps its values for the 1:1 path it now
solely governs, but its comment was rewritten to stop implying the set is
correct everywhere: it names `GroupTextSendNotSupportedError`
(`app/src/services/sendMessage.ts`), which makes a native group-text 30003 retry
enqueue and never send, says explicitly not to fix that by widening the set, and
points at
[`group-text-30003-leg-retry-promise-unverified`](./group-text-30003-leg-retry-promise-unverified.md)
as where that fix belongs.

APPROVED by the founder 2026-09-02 (spec D23): a terminally undelivered relay
FAN-OUT or TEAM leg now reaches `hc-<env>-error-logs` and the Recent Errors
panel, where it was silent before - whether the ladder ran to its cap, was
refused at a gate, or was never claimed at all. Announcement legs and 21610
opt-outs are excluded. Plan Task 13, commit `c05a25d7`; the predicate itself
landed one commit earlier with the claim (`71181d79`) because Task 12's own
tests assert ERROR on `source_unreadable`, which the shared rule cannot produce.
Proof: the severity battery in `app/test/twilioStatusWebhook.test.ts` (40 -> 47
tests), which also pins that the 1:1 and native-group-text lines still read the
shared set and carry no `retryClaim` at all.
