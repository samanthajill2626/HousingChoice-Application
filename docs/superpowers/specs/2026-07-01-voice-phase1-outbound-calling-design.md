<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Voice — Phase 1: in-app masked outbound calling (per-navigator)

**Date:** 2026-07-01 · **Status:** design (ready for implementation plan)
**Related:** `docs/issues/voice-do-not-call.md`,
`docs/issues/call-recording-consent.md`, `docs/issues/contact-call-no-originate-route.md`.
Voice today is **inbound-only** (`app/src/routes/webhooks/voice.ts`); this spec adds
the **outbound** direction.

## 1. Why

The app cannot place a call today. The `initiateCall` adapter seam exists
(`app/src/adapters/messaging.ts:142`, Twilio driver → `client.calls.create`) but
**nothing calls it** — no route, no service. The dashboard "📞 Call" button is a
`tel:` link that dials from the navigator's **own** phone/number, unmasked and
unlogged (`dashboard/src/routes/contact/CallMenu.tsx`). GA needs staff to place
**masked** calls from the app: the contact sees the business number, the
navigator's personal cell stays private, and the call is logged + recorded.

This is largely a **generalization of the existing inbound founder-bridge to
originate outbound** — it reuses the whisper, press-1 gate, status, recording, and
transcription machinery already built for the founder-bridge.

## 2. Scope

**In (Phase 1):** per-navigator masked outbound calling; a per-user verified cell;
the single "Inbound voice line" designation replacing `FOUNDER_CELL`; a
`voice_opt_out` do-not-call flag; record + transcribe outbound calls.

**Out (Phase 2, built together later):** a browser **softphone** (WebRTC) for
outbound AND inbound ringing to it (the semi-native app). Also deferred:
pool-number caller-ID continuity, multiple inbound-line holders, ring-through
routing rules, automated National DNC-registry scrubbing (`voice-do-not-call.md`).

## 3. Compliance basis (documented)

Calls are **manual, human-dialed, live** — outside the TCPA autodialer/robocall
rules. The business operates in **Georgia (one-party consent)**, so recording is
legal **without disclosure** when parties are in-state (interstate is the only
caveat — see `call-recording-consent.md`). `voice_opt_out` is our **company
do-not-call** list (honored on every originate path). Cold calls remain permitted
(esp. landlords) — we do NOT blanket-block them; National DNC-registry scrubbing is
a later, separate slice.

## 4. Data model

**User record (`app/src/repos/usersRepo.ts`):**
- `cell` — the user's own phone (E.164), used ONLY as their outbound bridge leg.
  Nullable; a user with no verified cell cannot place calls (the UI prompts them).
- `cell_verified_at` — set when the cell passes verification (§7). An unverified
  cell is never dialed.
- `inbound_voice_line` — boolean; **exactly one** user holds it at a time (an admin
  assignment enforces single-holder). That user's verified cell is what inbound
  calls ring — replacing the `FOUNDER_CELL` env var.

**Contact record (`app/src/repos/contactsRepo.ts`):**
- `voice_opt_out` — boolean, staff-set "do not call". Independent of `sms_opt_out`
  (someone may allow texts but not calls, or vice-versa).

## 5. Outbound originate flow

**New route** (authenticated dashboard call): `POST /api/contacts/:contactId/call`
(or `/api/conversations/:conversationId/call`). The session identifies the **calling
navigator** → their verified cell.

**New service** (fills the `initiateCall` gap):
1. Resolve the calling user's `cell`; if absent or unverified → `409`
   (`cell_not_verified`) so the UI prompts them to set it. No call placed.
2. Resolve the target contact's phone. If `voice_opt_out === true` → `409`
   (`contact_voice_opted_out`). No call placed.
3. `initiateCall({ to: <navigator cell>, from: <business number>, twimlUrl:
   <outbound-bridge TwiML> })` — rings the **navigator's** cell first.
4. Persist a `call` timeline entry (CallSid-idempotent, `direction: 'outbound'`,
   author = the navigator (`teammate`), a masked party label — NEVER the raw
   target/navigator phone in the stored label or logs).

**New TwiML webhook** `POST /webhooks/twilio/voice/outbound-bridge` — runs on the
navigator leg when they answer. Resolves the target by an opaque `callId`/
`conversationId` in the query (NEVER the raw target phone in the URL). Returns:
- a whisper + press-1 gate ("Calling <masked contact label> — press 1 to connect")
  — reuse `/voice/whisper` + `/voice/whisper-gate` (block the navigator's carrier
  voicemail from auto-answering);
- on press-1, `<Dial callerId=<business number> record="record-from-answer-dual"
  recordingStatusCallback=/webhooks/twilio/voice/recording answerOnBridge=true
  action=/webhooks/twilio/voice/status>` the **target** phone.

**Caller ID = the main business number** (`config.ourPhoneNumbers[0]`) — always,
Phase 1 (no pool-number continuity). **Recording + transcription** reuse the
existing `/voice/recording` (→ S3) and transcription callbacks unchanged — outbound
records exactly like the founder-bridge (legal in GA). The `/voice/status` handler
stamps answered/missed/duration on the `call` entry.

**CallMenu (`dashboard/src/routes/contact/CallMenu.tsx`):** the `tel:` link becomes
a POST to the originate route. When the contact is `voice_opt_out`, the control is
disabled with a "do not call" note. When the navigator has no verified cell, it
prompts them to set one (Settings deep-link) instead of dialing.

## 6. Inbound voice line (replaces FOUNDER_CELL)

Inbound routing is otherwise **unchanged** (`handleFounderTriage` in
`app/src/routes/webhooks/voice.ts`), except the dialed cell + pre-ring push target
come from the **`inbound_voice_line` holder's** verified cell instead of
`config.founderCell`. If no holder is set (or their cell is unverified), inbound
degrades to today's "text us" fallback (never a leak, never a 5xx).

**Team page (`dashboard/src/routes/settings/…`):** each user shows their cell +
verification state; the inbound-voice-line holder shows an **"Inbound voice line"**
badge. An admin assigns the holder in Settings (reassigning clears the prior
holder — single-holder invariant). `FOUNDER_CELL` env becomes a deprecated
fallback (seed the founder user's cell + the flag from it on migration).

## 7. Cell verification

A user attaches their own cell in Settings; it is **verified before use** — a code
sent by SMS (reuse the messaging adapter) OR a test call — and `cell_verified_at`
is stamped on success. An unverified cell is never dialed (guards a typo silently
bridging a stranger into a call). Self-service: a user sets/verifies their own cell;
an admin sets the inbound-voice-line assignment.

## 8. voice_opt_out (company do-not-call)

A staff-set toggle on the contact (contact detail / actions). Honored by the
originate route (§5 step 2) AND the CallMenu (disabled + noted). Independent of
`sms_opt_out`. `dnc_status` stub field is NOT required here — automated
DNC-registry scrubbing is deferred (`voice-do-not-call.md`).

## 9. Testing (e2e + unit)

- Originate: a navigator with a verified cell placing a call rings their cell,
  and on accept bridges to the target with the business caller ID; a `call` entry
  is persisted; recording + transcription callbacks stamp the entry.
- Guards: no verified cell → `409 cell_not_verified` (no call); `voice_opt_out`
  contact → `409 contact_voice_opted_out` (no call); CallMenu disabled for a
  do-not-call contact.
- Verification: an unverified cell is never dialed; the verify flow stamps
  `cell_verified_at`.
- Inbound: rings the inbound-voice-line holder's cell (not `FOUNDER_CELL`); no
  holder → "text us" fallback.
- Team page: cell + verification shown; single inbound-voice-line badge; reassigning
  moves it (single-holder invariant).
- PII: no raw navigator/target phone in stored labels, TwiML URLs, or logs.

## 10. Rollout / dependencies

1. Operator: each staff user sets + verifies their cell; an admin assigns the
   inbound-voice-line holder (migrate from `FOUNDER_CELL`).
2. Twilio number's **Voice** webhooks pointed at the app; `MEDIA_BUCKET` set (S3
   recordings); relay pool provisioning unaffected.
3. `voice_opt_out` needs no infra. No new A2P dependency (voice is not A2P).
