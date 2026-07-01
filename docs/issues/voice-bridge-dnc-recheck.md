---
id: voice-bridge-dnc-recheck
title: Outbound bridge does not re-check voice_opt_out at press-1 (short race window)
type: improvement
severity: low
status: open
area: app
created: 2026-07-01
refs: app/src/routes/webhooks/voice.ts:901
---

**Problem.** The outbound masked-call originate service enforces `voice_opt_out`
(company do-not-call) pre-dial (`originateCall.ts:117`, before the navigator's leg is
even rung). But the outbound-bridge webhook that runs when the navigator answers and
presses 1 (`resolveOutboundTarget`, `voice.ts:901`) resolves the target from the
conversation and dials it WITHOUT re-checking `voice_opt_out`. If staff mark a contact
do-not-call in the few-second window between originate and press-1, the bridge would
still connect that one in-flight call. The pre-dial guard covers the normal path; this
is only a narrow race. Flagged by the Voice Phase 1 final review (D-3) as the remaining
gap in "honored on EVERY originate path".

**Suggested fix.** In the outbound gate branch, before emitting `<Dial>` to the target,
re-load the contact (or `contacts.findByPhone(target)`) and refuse (safe masked hangup)
if `voice_opt_out === true`. That closes the window and fully satisfies the §8 invariant.
