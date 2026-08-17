---
id: voice-push-pii-masking-outdated
title: Voice pushes still mask caller PII the device should handle - align with the message-push posture
type: improvement
severity: low
status: open
area: app/voice
created: 2026-08-16
refs: app/src/routes/webhooks/voice.ts, app/src/lib/voiceMasking.ts
---

**Problem.** The voice push notifications (pre_ring, missed_call,
voicemail) deliberately mask the caller: the body carries the masked
call_party_label ("a role/name, NEVER a raw phone"), and an unknown
caller's raw number is surfaced only on the founder's own device
(voice.ts pushCallerLabel and the comments around the three send sites,
which cite the build plan's PII section).

That posture is now outdated. The operator ruled (2026-08-16, recorded
as D4 in the inbound-message push design spec and in
docs/issues/no-push-on-inbound-message.md): staff-facing pushes carry
FULL sender identity and content, like a native phone/SMS app - hiding
notification content on the lock screen is the DEVICE's job (a standard
OS setting), not something the app pre-censors. Message pushes ship
with full names, phone-number fallbacks, and message text; the voice
pushes are now the inconsistent ones.

**Suggested fix.** Align the three voice push payloads to carry the
caller's real name where known and the real number where not (drop the
founder-device-only special case), and rewrite the code comments that
assert the masked posture so they stop describing a rule the product no
longer has. Keep the LOG posture unchanged - pushService and the voice
routes must still never log payload contents; this change is about what
the push carries, not what the server logs.

**Scope note.** Voice <Say> prompts, SMS bodies, and the masked relay
identity system are unaffected - this is only about the three
staff-facing push notifications.
