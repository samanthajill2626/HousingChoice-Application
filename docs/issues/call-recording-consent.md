---
id: call-recording-consent
title: Founder-bridge records the caller with no recording disclosure (all-party-consent exposure)
type: security
severity: med
status: open
area: app
created: 2026-06-30
refs: app/src/routes/webhooks/voice.ts:590, app/src/routes/webhooks/voice.ts:950, app/src/routes/webhooks/voice.ts:1245
---

**Problem.** The **founder-bridge** call path records AND transcribes the caller:
`record='record-from-answer-dual'`, media streamed to S3, a verbatim transcript
persisted (voice.ts:590, /voice/recording callback voice.ts:1245). The caller
(a tenant) is **never told the call is recorded** — the whisper + press-1 accept
plays on the FOUNDER leg only (voice.ts:950); the caller hears ringing then a live
person. ~12 states require **all-party (two-party) consent** to record (CA, FL, IL,
PA, WA, MA, MD, …); on interstate calls the stricter state's law usually governs,
and tenants can be anywhere. Recording without notice is real legal exposure.

The masked relay path is already `do-not-record` (voice.ts:864) — this is ONLY the
founder-bridge.

**Operating context (2026-06-30):** the business operates in **Georgia — a
one-party-consent state**. Under one-party consent, the navigator/founder (a party
to the call) consenting to the recording is sufficient; **no disclosure to the
other party is legally required**. So both the inbound founder-bridge and the new
outbound path may record. This resolves the exposure for calls where all parties
are in Georgia — which is why severity is med, not high.

**⚠ FOUNDER to confirm (low-effort, not an engineering blocker):** (1) operation
stays effectively Georgia / one-party, and (2) an **interstate policy** — if you
ever call (or are called by) someone physically in a two-party state (CA, FL, PA,
WA, MA, MD, …), that state's law can attach and a recording disclosure would be
needed. Practical risk is low for a local Georgia market.

**Suggested fix.** No change required for Georgia-only operation. If interstate
calling becomes common, add an all-party "This call may be recorded" disclosure on
the caller leg before `<Dial>`. Separately: stored recordings/transcripts in S3 are
sensitive PII and still need a retention/access policy.
