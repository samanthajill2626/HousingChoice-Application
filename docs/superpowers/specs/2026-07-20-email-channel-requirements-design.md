# Email Channel - Use Cases and v1 Requirements

Date: 2026-07-20
Status: requirements design (pre-implementation-plan). This doc scopes WHAT
email v1 is; the technical design (schemas, endpoints, adapters) comes with the
implementation plan when the feature is picked up.

Related issues: [email-as-first-class-channel](../../issues/email-as-first-class-channel.md),
[ses-sandbox-exit](../../issues/ses-sandbox-exit.md),
[rta-documents-mms-unmodeled](../../issues/rta-documents-mms-unmodeled.md),
[inbound-media-attach-to-unit](../../issues/inbound-media-attach-to-unit.md),
[caseworker-contact-type](../../issues/caseworker-contact-type.md).

## Why

The platform's core promise is that every conversation in a placement lives in
one place. Today email is the leak: the landlord welcome + DocuSign contract
flow runs from an external mailbox (the one documented exception to
"everything routes through the app"), all Housing Authority correspondence in
the Approval & Move-in phase happens out-of-band, and LIF eligibility /
denial-letter legwork is explicitly email done outside the app. Provider
decision already made: AWS SES (send + receipt rules), not SendGrid. An SES
Terraform module exists (sandboxed, sender-identity only).

## Decisions (made 2026-07-20 with Cameron)

1. **Audience: all contact types, including tenants.** Email is a full peer
   channel for everyone we talk to, not a landlord-only or third-party-only
   wedge. (Tenants remain SMS-first in practice; email is expected to matter
   most for document exchange.)
2. **Composer: plain text + attachments.** Staff write plain text; the app
   wraps it in a clean branded HTML template (logo, org signature block,
   reply-to routing address). No rich-text editor in v1.
3. **Threading: one interleaved thread per contact.** A contact has ONE
   conversation; email, SMS, and calls interleave chronologically in the
   existing timeline, each visually distinct (as calls are today). No separate
   email inbox. This requires generalizing the phone-keyed conversation
   resolver - the one structural data-model change.

## Use cases (mapped to the placement lifecycle)

Email-worthiness tracks the AUDIENCE more than the stage; the document-heavy
later stages are where volume concentrates, but the first flow to pull
in-platform is early (landlord onboarding).

- **Landlord onboarding (early).** Welcome email + DocuSign contract link,
  today sent from an external mailbox with zero platform history. DocuSign
  itself stays external; the email carrying it moves in-platform.
- **Application phase.** Per-property application processes (portals, PDFs,
  PM systems). Team sends the application to the tenant, tenant completes,
  team forwards the package to the landlord. PDF/form artifacts exceed MMS
  practicality (5 MB cap, narrow type allowlist).
- **RTA packet phase.** Tenant submits RTA documents; team reviews and
  packages; landlord submits to the housing authority within 48h. Multi-page
  formal packets. The inbound-documents flow is already flagged as unmodeled
  (rta-documents-mms-unmodeled), including the open question of a
  placement-level document surface.
- **Approval & Move-in - the PHA.** RTA approval, inspection scheduling and
  results, rent determination, HAP contract: all out-of-band today; staff
  merely record milestones. PHAs and caseworkers are email-only third
  parties. Prerequisite: the housing authority is a free-text string today
  and caseworkers have no ContactType (see Open questions).
- **LIF eligibility / denial letters.** Documented today as email legwork
  outside the app.
- **Later/ongoing.** Leases, move-in details, landlord invoicing (Track 7,
  deferred), W-9s.

## Requirements

### A. Core channel plumbing

- **Email addresses on contacts** (net-new; contacts have NO email field
  today). Multi-address with label + primary, mirroring the phones[] design;
  normalize/validate; byEmail resolver GSI + findByEmail.
- **Unknown-sender capture parity.** Inbound email from an unknown address
  creates a conversation AND a stub contact (needs_review triage), same as
  inbound SMS.
- **Thread resolution beyond phones.** Conversations are resolved by
  participant_phone today; email needs an email participant key on the SAME
  conversation so one contact = one interleaved thread across channels.
- **MessageType 'email'** on the existing append-only messages table, with
  the RFC Message-ID / SES message id as the provider id so the existing
  sid-pointer idempotency and status-callback machinery is reused.
- **Inbound pipeline.** SES receipt rules -> S3 raw MIME -> queue/worker ->
  MIME parse -> append message + attachments. Attachments go into the
  existing S3 MediaStore and are served only through the authed endpoint
  (same as MMS media). Email-scale limits (SES inbound allows ~40 MB),
  distinct from MMS carrier limits.
- **Outbound pipeline.** SES send from a dedicated subdomain with
  DKIM/SPF/DMARC; per-conversation plus-addressed reply-to token
  (relay+<token>@...) for deterministic reply routing; SES production-access
  request (ses-sandbox-exit).
- **Delivery status.** SES send/delivery/bounce/complaint events mapped onto
  the existing forward-only delivery-status machine and dashboard chips.
- **Subject lines.** New concept for the timeline; stored on the message and
  rendered on email items.

### B. Build-ourselves list (what Gmail gives for free)

1. **Threading/grouping.** Group replies via In-Reply-To/References plus the
   reply-to token; fallback heuristic (subject + participants) because real
   clients mangle headers.
2. **Safe HTML rendering.** Inbound email is hostile HTML: sanitize (strip
   scripts/trackers), block or proxy remote images, render sandboxed,
   plain-text fallback. Security-critical; the largest UI lift vs SMS bubbles.
3. **Quoted-reply trimming.** Collapse quoted history in replies (reply-
   delimiter parsing). Also required so fact extraction ingests only the new
   text, not the re-quoted thread every reply.
4. **Composer.** Plain text; subject; To (CC deferred unless trivially
   cheap); attachments via the existing presigned-POST upload; sender
   signature convention ("<Staff name> at Housing Choice"); reply-vs-new-
   thread semantics.
5. **Bounce/complaint handling.** Hard bounces auto-suppress the address
   (email_unreachable flag alongside sms_opt_out etc.); complaints set
   email_opt_out; failures surfaced like SMS delivery failures.
6. **Spam posture.** Use SES inbound spam/virus verdicts; policy + a staff
   review surface for quarantined mail so real mail cannot die silently.
7. **Search.** No cross-message search exists platform-wide today; email
   (subjects, bodies, attachment names) makes it acute. Scope: platform-wide
   message search delivered with or alongside email v1 (Cameron's original
   ask named search explicitly).
8. **Shared-mailbox semantics.** One org sending identity; outbound records
   which teammate sent it (existing author model extends); unread/SSE reuse;
   no per-conversation assignment (matches the removed-assignment decision).
9. **Identity collisions.** One address mapping to multiple contacts (PM
   office, PHA front desk) is common. v1 rule can be simple (most recent
   contact + triage flag) but must exist.
10. **Attachment-to-record linking.** Use cases are document-shaped (RTA
    packet -> placement, lease -> placement, photos -> unit) while threads
    are contact-shaped. v1 must not preclude promoting an email attachment
    onto a placement/unit; ideally ships a minimal "attach to
    placement/unit" action (extends inbound-media-attach-to-unit).
11. **Compliance and PII.** Transactional/relationship mail is largely
    CAN-SPAM-exempt, but honor opt-outs anyway. Inbound attachments will
    contain IDs and possibly SSNs: encrypted at rest, auth-gated serving,
    kept out of logs (existing patterns).
12. **Automated email hooks.** Message catalog gains channel 'email' so
    automated/templated sends are possible later; v1 sends are
    human-initiated only.
13. **Extraction integration.** TranscriptUtterance channel 'email'; adapter
    maps email messages (trimmed text only) into the extraction pipeline.
14. **Test infrastructure.** A fake-SES service mirroring the fake-twilio
    pattern (REST impersonation + control/mailbox API + e2e seams) so the
    channel is hermetically testable, plus dev outbox parity.

### C. Non-goals for v1

Labels/folders/archive; read/open tracking; marketing campaigns; calendar
invites; per-staff personal inboxes; rich-text composition; replacing
DocuSign; automated/scheduled email sends (hooks only, see B12).

## Open questions (to resolve at implementation-plan time)

- **PHA/caseworker contact modeling.** Emailing authority staff requires them
  to be contacts. Minimal path: a caseworker/partner ContactType (issue
  already filed) and optionally linking a contact to the housingAuthority
  string. Decide whether this lands inside email v1 or immediately before it.
- **CC support.** Cheap enough for v1, or defer? (Multi-party email that CCs
  a second contact strains the 1:1 conversation model the way group MMS
  would.)
- **Search delivery.** Same branch as email or a parallel platform-wide
  search feature that email v1 depends on.
- **Spam quarantine UX.** Where the review surface lives (triage queue vs a
  dedicated view).
- **Which flows adopt email first operationally** (landlord welcome likely),
  and whether any get catalog templates as a fast-follow.
