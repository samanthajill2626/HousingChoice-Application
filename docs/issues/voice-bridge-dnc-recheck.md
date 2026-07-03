---
id: voice-bridge-dnc-recheck
title: Outbound bridge does not re-check voice_opt_out at press-1 (short race window)
type: improvement
severity: low
status: resolved
area: app
created: 2026-07-01
resolved: 2026-07-02
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

**Resolution (2026-07-02).** Shipped (bundled with the per-user rate-limits
feature — design spec §3): `resolveOutboundTarget`
(`app/src/routes/webhooks/voice.ts`) now also returns the freshly-loaded
contact's `voice_opt_out` as an `optedOut` flag (it already re-read the contact
via `contacts.findByPhone` on every call), and the whisper-gate's OUTBOUND
press-1 branch re-checks it before emitting `<Dial>`: if the target was opted
out after originate, the gate answers `<Hangup>` instead of dialing, with an
IDs-only log (`'outbound whisper gate: target opted out mid-ring
(voice_opt_out) — hanging up, not dialing'` — never a phone). The
inbound/masked-relay gate branches are unchanged. `voice_opt_out` is now
honored on EVERY originate path (§8 invariant closed). Covered by a unit test
in `app/test/voiceOutbound.test.ts` (opt-out set between originate and press-1
→ hangup TwiML, no `<Dial>`, no raw phone in logs).
