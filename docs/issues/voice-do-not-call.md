---
id: voice-do-not-call
title: Voice do-not-call opt-out + in-app masked outbound calling (GA) — DNC scrubbing later
type: security
severity: high
status: open
area: app
created: 2026-06-30
refs: app/src/adapters/messaging.ts:142, dashboard/src/routes/contact/CallMenu.tsx:5, app/src/routes/webhooks/voice.ts
---

**Problem.** GA needs **in-app masked outbound calling** (the originate route the
`initiateCall` adapter seam is waiting on — messaging.ts:142; CallMenu.tsx:5 today
is a `tel:` link that dials from the navigator's own device). Once the app
originates calls from the business/A2P number, voice-contact compliance applies.

Legal read (confirmed 2026-06-30): manual, human-dialed calls are outside the
TCPA autodialer/robocall rules. **Cold calls are permitted** (esp. landlords
responding to their own public rental ads — often exempt as prior invitation /
non-solicitation) **unless the number is on the National DNC Registry** for a
solicitation call. We therefore do **NOT** blanket-block cold outbound calls.

**Scope for GA:**
1. **Company do-not-call flag** (`voice_opt_out` on the contact) — honored by the
   new originate route AND today's click-to-dial CallMenu (disable/warn when set).
   Absolute and permanent, independent of the federal registry. **Build.**
2. **In-app masked outbound calling** — originate route/service that bridges the
   initiator (founder/navigator) to the target with the business/pool number as
   caller ID; CallMenu swaps its `tel:` link for a POST. **Build (own feature —
   completes the M1.9 voice bridge).** The outbound path MAY RECORD — the business
   operates in **Georgia (one-party consent)**, so recording is permitted without
   disclosure when the parties are in-state; see `call-recording-consent` for the
   interstate caveat.
3. **National DNC Registry scrubbing → deferred (Phase 2).** Leave a `dnc_status`
   stub field for the future automated scrubber; nothing blocks on it for GA.

**Suggested fix.** Add `voice_opt_out` (+ `dnc_status` stub) to the contact model;
gate origination + CallMenu on it; build the originate route (recording OK under
Georgia one-party consent). Automated DNC-list scrubbing is a later, separate slice.
