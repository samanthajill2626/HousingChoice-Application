# Phase 1 — Change Order 2 (paste into the build agent mid-flight)

Doc updated **v2.15 → v2.16**. New operational fact: the founder receives **many calls daily** — the original founder-bridge design (every business call shows the business number, context only via whisper after answering) fails her triage needs. She must (a) glance at her ringing phone and know whether to safely ignore, and (b) have a "decline and send a canned text" capability. Integrate the following into M1.9 (and M1.4 for push); doc §7.1 "Call triage at volume" is authoritative — read it first.

## Design (summary)

1. **Pre-ring context push — timing is load-bearing.** Inbound founder-bridge flow becomes: voice webhook → send rich web push ("📞 Keisha Jones — tenant, 123 Main St, in inspection") → **~2s pause** → dial the founder's cell. The push must consistently land before/with the call banner; make the pause configurable and verify ordering in live tests.
2. **Decline = no press-1 (unchanged mechanically).** Caller rolls to platform voicemail as already designed. Additionally fire a **missed-call push** with quick actions: "Please text me" / "I'll call you back soon" / open thread for custom. Action taps send **from the business number** and log to the timeline. Platform note: Android web push supports action buttons on the notification; iOS does not — tapping the push must deep-link the PWA directly onto a canned-reply sheet (two taps total). Build both paths.
3. **Zero-tap default:** configurable auto-text on every missed business call ("Sorry I missed you — I'll call back soon; you can also text me here."), founder-editable template, ON by default; quick-reply buttons act as overrides/additions. Auto-text must be idempotent per call (one text per missed call, never per retry/callback event) and must route through the throttled outbound queue.
4. **Ring-through rules — DEFERRED (operator decision 2026-06-12, doc v2.17):** do NOT build the rule engine or config. Everyone rings; missed calls take the voicemail + auto-text path. (Parked in doc §14 — it is pure configuration on this flow if ever wanted; just don't hard-code assumptions that would prevent adding a routing decision point before the dial.)
5. **Hard guardrails — do NOT implement:** caller-ID passthrough of the real caller's number on the founder leg, and any reliance on the native "decline with message" feature — both leak the founder's personal number. Caller ID on her leg stays the business number. Document this in code comments at the dial site.

## Integration notes

- The whisper + press-1 gate, platform voicemail, and recording/transcription tail are **unchanged** — this change adds a push before, and actions after, the existing flow.
- The missed-call quick-reply sheet belongs to the PWA work (M1.4): a `/quick-reply/:callId` deep-link view, canned templates from config, plus the notification-action handler for Android.
- Idempotency: tie auto-text and quick-reply state to the call's correlation context (callId) — a quick-reply tap after the auto-text already sent should append, not duplicate; two taps on the same action must send once.
- **Tests to add:** push-before-ring ordering (assert pause); missed-call → exactly one auto-text; quick-reply taps idempotent per callId; iOS path (deep link renders canned sheet) and Android path (notification action) both send from the business number; declined-while-DND still lands in platform voicemail (the keypress gate already covers carrier voicemail — assert the auto-text fires in that path too).
- **Process:** adversarial review reads doc §7.1 v2.16 itself; README deviations row only if you depart from this design; RUNBOOK gains the founder-facing behavior description (what she sees on Android vs iPhone, how to edit templates).
- 🖐 Live verification with the founder's actual phone before sign-off: ring + ignore → voicemail + auto-text; decline → quick reply; airplane mode → carrier voicemail never captures; push consistently precedes ring on her device/OS.

## Unchanged

Everything in `PHASE1_KICKOFF_PROMPT.md` and Change Order 1 stands. A2P approval is still pending — live-traffic milestones remain gated.
