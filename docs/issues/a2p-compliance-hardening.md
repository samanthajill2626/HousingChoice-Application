---
id: a2p-compliance-hardening
title: A2P/CTIA compliance hardening — opt-in consent capture, first-message disclosures, STOP/HELP replies
type: security
severity: high
status: in-progress
area: app
created: 2026-06-30
refs: app/src/routes/public.ts:50, app/src/repos/settingsRepo.ts:59, app/src/routes/webhooks/twilio.ts:66, app/src/services/sendMessage.ts:209, app/src/routes/contacts.ts:609, app/src/lib/mergeFields.ts:25, dashboard/src/routes/public/IntakeForm.tsx, docs/a2p/campaign-resubmission.md
---

**Problem.** A2P is approved; before flipping live SMS we audited the messaging
surface against A2P/CTIA/TCPA rules (4-way audit, 2026-06-30). The control that
prevents carrier blocks — never texting an opted-out number — is solid
(dual-layer suppression + pre-send guard on every path: 1:1, broadcast, relay;
provider 21610/30005-6 handled). The exposure is at the *front* of the lifecycle:

- **No opt-in consent disclosure on the public intake form** — `IntakeForm.tsx`
  has zero "you agree to receive texts / msg & data rates / reply STOP" language,
  and we don't record what/when a person consented to. A2P campaigns are approved
  against a described web opt-in; ours doesn't match. (highest risk)
- **First business-initiated messages lack identity + opt-out.** Missed-call
  auto-text (`settingsRepo.ts:59`) has neither business name nor opt-out; the
  housing-fair welcome (`public.ts:50`) has the name but no "Reply STOP".
- **Editable templates have no compliance floor** — an admin can strip opt-out
  language from the first-contact templates; no validation.
- **Consent provenance is partial.** `capture_source`/`captured_at` exist for
  form (`housing_fair`/`flyer`) and inbound (`inbound_sms`, strongest basis), but
  manual staff adds record nothing on the contact; no `consent_method` /
  `consent_timestamp` / consent-version fields; no audit-export for carriers.
- **STOP/HELP/START auto-replies** are currently delegated to Twilio Advanced
  Opt-Out (assumed, not verified). Decision pending: self-manage vs provider —
  leaning self-managed (we already own the suppression list + relay pool numbers).

**Suggested fix.** Scoped as one "A2P compliance hardening" design (brainstorm →
spec → build). Prioritized:

- **P0 (before go-live):** consent disclosure + checkbox on the public intake form
  and record consent (`consent_method` + `consent_timestamp` + version); add
  business name + "Reply STOP" to the two first-contact template defaults; decide
  + implement STOP-confirmation + HELP handler (self-managed) OR verify Twilio
  Advanced Opt-Out.
- **P1:** just-in-time consent gate — manual-add is fast; the FIRST outbound to a
  contact with no recorded consent basis is blocked with a modal that captures
  consent method (enum) + when + optional note, then sends. Template validation
  floor. Relay intro identity + opt-out.
- **P2:** first-class `consent_method`/`consent_timestamp`/`consent_version`
  everywhere + `/api/contacts/consent-report` export for carrier audits.

**Decisions (2026-06-30).**
- Reconciled the design against the *approved* A2P campaign (brand "Tenant Place
  LLC", tenant.place, opt-in # (404) 982-4978). Several mismatches → we RE-FILE the
  campaign to match the app rather than degrade the app. Founder hand-off doc:
  `docs/a2p/campaign-resubmission.md`.
- **Consent model:** inbound stays a consent trigger — NO forced "reply YES" double
  opt-in (keeps 1:1 UX). The campaign's double-opt-in flow gets rewritten in the
  re-file. Residual risk (recurring-alert enrollment off a bare inbound) mitigated
  by disclosing the program + STOP/HELP in the first outbound reply; flagged for the
  founder to accept or override.
- **Embedded links:** app sends `[FlyerLink]` (tenant.place/p/<id>); campaign
  declared links=No → re-file to links=Yes (may trigger re-vetting; gates go-live).
- **Keywords:** app to add opt-out OPTOUT + REVOKE and opt-in JOIN + HOME to match
  the filing. Self-managed STOP/HELP/START replies use the filed copy verbatim.
- **Voice/outbound calling:** separate track (A2P is SMS-only). Manual click-to-dial
  + inbound bridge = lighter regime than SMS; obligations are DNC-style (honor
  "don't call me"), calling hours, recording disclosure. See design session.

Full audit findings + calibrated scorecard captured in the design session
(2026-06-30). Filed to record good-faith, documented progress toward compliance.
