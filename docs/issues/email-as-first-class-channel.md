---
id: email-as-first-class-channel
title: Email is not an in-scope conversation channel (needed for landlord onboarding later)
type: improvement
severity: med
status: open
area: app
created: 2026-06-30
refs: app/src/repos/messagesRepo.ts:31, infra/modules/ses/main.tf, docs/issues/ses-sandbox-exit.md, documentation/landlord-onboarding-sequence.mermaid
---

**Problem.** The messaging model is SMS/MMS/voice only — `messagesRepo` `MessageType =
'sms' | 'mms' | 'call'`, keyed on Twilio provider SIDs — and there is no email-sending code in
`app/src`. Email is therefore NOT a first-class conversation channel the way texts are. The
**Landlord & Unit Onboarding** sequence (`documentation/landlord-onboarding-sequence.mermaid`)
relies on a welcome email (and a DocuSign contract), which Phase 1 keeps as a SEPARATE channel
run by the team with external tools, outside the app. The founder expects email to need to come
in-scope — handled by the app like texts — as landlord onboarding matures.

**Current state (evidence).**
- `app/src/repos/messagesRepo.ts:31` — `MessageType` has no `email`.
- No outbound email code in the app (the only "email" in `app/src` is user auth/session).
- `infra/modules/ses/main.tf` provisions a single verified SES *sender identity*, still in the
  SES **sandbox**; `docs/issues/ses-sandbox-exit.md` (deferred) says request production access
  "when real outbound mail is needed." So SES is a latent capability for transactional mail, not
  wired in and not modeled as a conversation channel.
- The next channel on the roadmap is RCS (`docs/RCS-integration-contract.md`), not email.

**Why it matters.** Landlord onboarding's welcome email — and possibly ongoing landlord comms —
would benefit from living in the same conversation hub as texts (one thread, one history, AI/
human handoff), rather than a side channel the app can't see or record.

**Suggested fix (when prioritized).** Introduce email as a first-class channel:
- Add an `email` message type + an outbound email adapter (SES → request production access,
  templated welcome/transactional mail first).
- Decide two-way vs one-way: if inbound email is in scope, add inbound email ingestion +
  threading into the existing conversation model (a channel dimension on conversations/messages),
  mirroring how SMS/MMS thread today.
- Keep DocuSign external for now (separate concern).

Filed while drafting the landlord-onboarding sequence diagram; NOT a blocker for building that
sequence's e2e suite at Phase-1 altitude (email/DocuSign are modeled as external there).
