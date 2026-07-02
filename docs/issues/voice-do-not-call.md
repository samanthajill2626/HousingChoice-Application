---
id: voice-do-not-call
title: Voice do-not-call opt-out + in-app masked outbound calling (GA) — DNC scrubbing later
type: security
severity: high
status: resolved
resolved: 2026-07-02
area: app
created: 2026-06-30
refs: app/src/services/originateCall.ts, dashboard/src/routes/contact/CallMenu.tsx, app/src/routes/voiceApi.ts
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

**Resolution (2026-07-02).** The GA scope shipped in Voice Phase 1 (merged 33bfab2):
- `voice_opt_out` is on the contact model, staff-settable, and honored by BOTH the
  originate service (`services/originateCall.ts` — 409 `contact_voice_opted_out`,
  pre-dial, checked before phone resolution) and the CallMenu (disabled + "Do not
  call" note). Independent of `sms_opt_out`.
- In-app masked outbound calling is built end-to-end: `POST /api/contacts/:id/call`
  rings the navigator's verified cell (whisper + press-1), bridges to the target
  with the business number as caller ID, records + transcribes (Georgia one-party).
  CallMenu's `tel:` link is gone.
- Known narrow gap (already filed): `voice-bridge-dnc-recheck` (a contact marked
  do-not-call mid-call isn't re-checked at press-1; seconds-wide, low).
- Item 3 (National DNC Registry scrubbing) was NOT built — deliberately deferred;
  spun out to its own tracked issue: `dnc-registry-scrubbing` (low, deferred). The
  `dnc_status` stub field was also skipped (nothing consumes it yet; the scrubbing
  issue owns adding it when built).
