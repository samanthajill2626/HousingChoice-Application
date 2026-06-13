# Phase 1 — Change Order 1 (paste into the build agent mid-flight)

You are mid-execution on `PHASE1_KICKOFF_PROMPT.md`. The architecture doc has been updated **v2.13 → v2.15** and the kickoff prompt has been amended in place. This change order tells you exactly what changed, and how to reconcile it against whatever you have already built. Do not restart the phase; integrate.

## What changed

1. **NEW SCOPE — Masked tenant↔landlord calling on placement pool numbers** (doc §7.1, "Masked calling through the placement number", decision 2026-06-12). Requirement: tenants and landlords must be able to call each other directly without ever seeing each other's numbers, via the same pool number they text. Summary (the doc paragraph is authoritative — read it):
   - Inbound call to a pool number → resolve (caller, pool number) → conversation + caller role → `<Dial>` the counterpart's real number with **the pool number as caller ID**.
   - Routing: tenant → landlord-side primary contact (from the per-property process); landlord/PM → tenant; unknown caller → platform voicemail; optional press-0 for the caller to reach the team instead.
   - The **press-1 whisper gate** runs on the callee leg (same component as founder bridging — carrier voicemail must never capture these calls); genuine no-answer plays a masked no-answer message to the caller.
   - **No recording, no transcription on these calls** (explicit review decision — unlike founder-bridge calls, which keep both). Log metadata only — caller, callee, started, duration, outcome — as a message on the placement timeline so calls render inline in the hub thread.
2. **Informational, no Phase 1 work:** an RCS adoption note was added to §7.1 (upgrade layer at Phase 2, never a replacement; relay threads stay SMS permanently). Ignore for this phase, but don't build anything that would block per-channel upgrades on the main number later.
3. The kickoff prompt's M1.9 and the "Groups are masked relay threads" decision bullet were amended accordingly; doc reference bumped to v2.15.

## How to integrate (in order)

1. **Re-read** doc §7.1 (the new masked-calling paragraph and the relay paragraph above it) before touching code.
2. **Audit what's already built against the delta** and report at the next checkpoint:
   - **M1.7 pool-number manager** — the highest retrofit risk: pool numbers must be purchased **voice-capable (voice + SMS)**, and each pool number's **voice webhook** must point at the platform (a new voice route), not just its messaging webhook. If you already bought numbers or wrote the provisioning code, verify capabilities and webhook config; fix and note it.
   - **M1.9 voice** — if not yet started, just build per the amended milestone. If partially built, the masked-calling flow reuses the whisper/press-1/bridge components — extract them to be shared between founder-bridge and masked-call paths rather than duplicating.
   - **Conversations/messages model** — confirm a call-metadata-only message type renders correctly in the thread UI (no recording link, no transcript block).
3. **Required tests (add to the golden suite):** counterpart routing in both directions; unknown-caller → platform voicemail; press-0 → team; no-answer/no-keypress → masked no-answer message (assert the callee's personal voicemail can never capture the call); a metadata-only call message renders in the hub; pool number purchased without voice capability fails provisioning loudly.
4. **Intro message copy** for new placement threads gains the line: text this number to reach everyone; call it to reach the other party directly.
5. **Process discipline:** run your adversarial-review pass on this delta specifically (the reviewer reads the new §7.1 paragraph itself); update `README.md` (status table + a deviations row ONLY if you depart from the doc's design); reflect the new routes/behaviors in `RUNBOOK.md` (what a masked-call log line looks like, how to trace one by correlation ID).
6. **Cost note for the operator:** negligible — pool numbers are already budgeted; bridged calls ≈ $0.0225/min across both legs, and these calls skip transcription entirely.

## Unchanged

Everything else in `PHASE1_KICKOFF_PROMPT.md` stands: milestone order, checkpoints, 🖐 manual-step protocol, A2P gating for live traffic, binding guidelines, out-of-scope list (still no AI, no matching, no tour automation).
