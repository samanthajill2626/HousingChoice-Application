---
id: voice-relay-multiplexing-ambiguity
title: Masked-voice routing is ambiguous on a multi-group pool number
type: debt
severity: high
status: resolved
resolved: 2026-08-24
area: app
created: 2026-07-17
refs: app/src/services/relayInboundResolution.ts, app/src/routes/webhooks/voice.ts
---

**Resolution (2026-08-24).** Fixed on `fix/voice-pool-multiplex` after the
deferred risk landed in production: 2026-08-22/23, five legitimate inbound
calls to pool +14704107371 (five open groups) were refused as non-members and
their refusal rows filed into an unrelated group's thread (severity raised
from low accordingly; the five prod rows were moved to the callers' real
threads by hand on 2026-08-24). The suggested fix below shipped, one level
up from the suggestion: the (To, From) ladder now lives ONCE in
`app/src/services/relayInboundResolution.ts` and BOTH webhooks consume it, so
the channels cannot drift again. Voice additionally adopts the SMS AF-5 rule
the suggestion did not cover: when every group on the number is closed and
the caller is on no roster, the call falls through to founder call-triage
instead of being buried in a dead transcript. getByPoolNumber survives only
as ourNumberKind's yes/no membership test and its contract doc now says so.
Known residuals shared with (and matching) the SMS path are filed in
[relay-inbound-resolution-residuals](relay-inbound-resolution-residuals.md).

**Problem.** Under burn-multiplexing (relay-number-lifecycle), one pool number
can front several relay groups over its lifetime, participant-disjoint. Inbound
SMS resolves correctly on (To, From): the webhook fetches ALL groups on the To
number and picks the one whose roster contains the sender From. The masked-VOICE
path does not. In app/src/routes/webhooks/voice.ts the To-number bridge resolves
the group through the legacy getByPoolNumber single-collapse (voice.ts:370, "the
open group, else the first"), then hands off to handleMaskedInbound (voice.ts:372,
which already receives From). On a number that has hosted more than one group the
masked call can therefore bridge to the wrong group. It never crashes -
getByPoolNumber always returns exactly one group - but it is not per-caller
correct the way SMS now is. (The From echo guard at voice.ts:356 is unaffected:
any pool-number match there correctly drops our own projected-back leg. It now
runs through the `ourNumberKind` predicate - business-number-config, 2026-08-06 -
whose `pool` arm is the same getByPoolNumber membership test as before.)

Voice was explicitly OUT OF SCOPE for the relay-number-lifecycle feature (spec
section 7: no change to relay voice behavior, STOP/opt-out, RCS seams, or
fan-out). getByPoolNumber was therefore KEPT as a thin voice-only seam rather
than deleted with the SMS caller.

**Suggested fix.** Mirror the SMS (To, From) resolution ladder for voice. The
inbound call already carries From, so handleMaskedInbound can call
getAllByPoolNumber(To) and select the OPEN group whose roster contains From
(newest wins on the should-never-happen tie) instead of collapsing to a single
group on the To number alone.
