---
id: voice-relay-multiplexing-ambiguity
title: Masked-voice routing is ambiguous on a multi-group pool number
type: debt
severity: low
status: open
area: app
created: 2026-07-17
refs: app/src/routes/webhooks/voice.ts:339, app/src/routes/webhooks/voice.ts:347
---

**Problem.** Under burn-multiplexing (relay-number-lifecycle), one pool number
can front several relay groups over its lifetime, participant-disjoint. Inbound
SMS resolves correctly on (To, From): the webhook fetches ALL groups on the To
number and picks the one whose roster contains the sender From. The masked-VOICE
path does not. In app/src/routes/webhooks/voice.ts the To-number bridge resolves
the group through the legacy getByPoolNumber single-collapse (voice.ts:347, "the
open group, else the first"), then hands off to handleMaskedInbound (voice.ts:349,
which already receives From). On a number that has hosted more than one group the
masked call can therefore bridge to the wrong group. It never crashes -
getByPoolNumber always returns exactly one group - but it is not per-caller
correct the way SMS now is. (The From echo guard at voice.ts:339 is unaffected:
any pool-number match there correctly drops our own projected-back leg.)

Voice was explicitly OUT OF SCOPE for the relay-number-lifecycle feature (spec
section 7: no change to relay voice behavior, STOP/opt-out, RCS seams, or
fan-out). getByPoolNumber was therefore KEPT as a thin voice-only seam rather
than deleted with the SMS caller.

**Suggested fix.** Mirror the SMS (To, From) resolution ladder for voice. The
inbound call already carries From, so handleMaskedInbound can call
getAllByPoolNumber(To) and select the OPEN group whose roster contains From
(newest wins on the should-never-happen tie) instead of collapsing to a single
group on the To number alone.
