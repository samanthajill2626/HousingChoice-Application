---
id: voice-caller-abandon-no-dial-summary
title: A caller who hangs up during the founder-bridge ring may never produce a Dial summary - the call row stays ringing, no miss/unread/push/auto-text
type: bug
severity: med
status: open
area: app
created: 2026-08-17
refs: app/src/routes/webhooks/voice.ts, app/src/adapters/messaging.ts, docs/issues/inbound-calls-invisible-in-inbox.md
---

**Problem.** Every terminal decision for a founder-bridge call (answered vs
missed, the missed push, the auto-text, and since call-inbox-unread the inbox
stamp + unread) is driven by the `<Dial action>` summary at
`POST /webhooks/twilio/voice/status`. A per-leg (non-Dial) terminal callback is
dropped by design (voice.ts, the FIX-1 carrier-voicemail guard), and the inbound
number has no number-level status callback wired. Open question raised by the
call-inbox-unread adversarial review (r1 Q1): when the CALLER hangs up while
the founder's cell is still ringing (the most common real-world miss), does
Twilio still request the `<Dial action>` URL? If it does not, that call's row
stays `call_status: 'ringing'` forever, is never classified missed, never marks
the thread unread, never fires the missed push, and never auto-texts - and the
inbox shows nothing for it. The behaviour is pre-existing for the push/auto-text;
call-inbox-unread deliberately does NOT stamp the thread at ring time so that a
never-closed ring cannot pin a stale "Incoming call" preview at the top of the
inbox (the same class as its outbound never-accepted originate finding).

**To verify.** Place a real call to the dev business number and hang up during
the ring, then check whether `/voice/status` received a request carrying
`DialCallStatus` for that CallSid (the fake-twilio engine models hangup as a
`no-answer` Dial summary, so the hermetic stack cannot answer this).

**Suggested fix (if confirmed).** Wire a status callback for the parent inbound
call (Twilio number-level "call status changes" or a `<Dial>`-independent
callback) and let a terminal PARENT-leg status close out a still-`ringing`
inbound founder-bridge entry as a miss - scoped to the parent sid + `ringing`
prior only, so it cannot re-introduce the carrier-voicemail misclassification the
per-leg drop exists for. The same closing rule should also cover an outbound
originate the navigator never accepts (its `calls.create()` sets no
`statusCallback`).
