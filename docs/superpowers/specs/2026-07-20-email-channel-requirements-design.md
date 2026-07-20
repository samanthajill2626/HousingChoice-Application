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
   email inbox for KNOWN contacts. This requires generalizing the phone-keyed
   conversation resolver - the one structural data-model change.
4. **Unknown-sender email does NOT auto-create contacts.** Unlike inbound SMS,
   inbound email from unknown addresses lands in a separate "unmatched email"
   surface (see "Inbound routing / capture" in section A), never in the
   general inbox or Today notifications. The general inbox stays contacts +
   unknown call/SMS.
5. **CC is in scope for v1.**
6. **Attachment size cap: 25 MB** (mainstream-provider interop limit, e.g.
   Gmail), not the SES ceiling.
7. **Search ships separately.** Product-wide search is its own effort
   ([total-product-search](../../issues/total-product-search.md)); email v1's
   obligation is to store content search-ready (see B7).
8. **Minimal 'partner' ContactType in v1** covering housing-authority staff
   and caseworkers, so emailing the authority works with honest author
   labeling. No deeper authority modeling (the housingAuthority string field
   stays as-is).
9. **The unmatched-email surface is its own nav item** (with an unread
   badge), holding unmatched mail plus the spam-quarantine sub-view. The
   general inbox is untouched.
10. **CC lands in the primary (To) contact's thread only.** CC'd addresses
    are recorded and displayed on the message; no mirroring into a known
    CC'd contact's timeline in v1 - a follow-up registry issue for mirroring
    is filed as part of delivering the feature.

## Use cases (mapped to the placement lifecycle)

**These use cases are illustrative, not exhaustive.** They motivate and
sanity-check the requirements, but v1 is a general-purpose email channel:
do not build or test ONLY for the flows listed here - there are certainly
more we have not enumerated, and staff will use email in ways we have not
predicted. Any inbound/outbound correspondence with any contact must work.

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
- **Approval & Move-in - the housing authority.** RTA approval, inspection
  scheduling and results, rent determination, HAP contract: all out-of-band
  today; staff merely record milestones. Housing authorities (PHAs) and
  caseworkers are email-only third parties. Prerequisite: the housing
  authority is a free-text string today and caseworkers have no ContactType
  (see Open questions).
- **LIF eligibility / denial letters.** Documented today as email legwork
  outside the app.
- **Later/ongoing.** Leases, move-in details, landlord invoicing (Track 7,
  deferred), W-9s.

## Requirements

### A. Core channel plumbing

- **Email addresses on contacts** (net-new; contacts have NO email field
  today). Multi-address with label + primary, mirroring the phones[] design;
  normalize/validate; byEmail resolver GSI + findByEmail.
- **Inbound routing / capture (the side-door model).** Three tiers:
  1. *Known sender* (address on an existing contact): append to their
     interleaved thread; normal inbox and notification behavior.
  2. *Token-routed reply from an unknown address*: a reply to a
     per-conversation relay+token address arriving from an address we do not
     have on file (e.g. landlord replies from an office address) routes into
     that conversation via the token, flagged "new address - add to contact?".
  3. *Unknown sender, no token*: NO contact, NO conversation, NO Today
     notification. The message lands in a dedicated "unmatched email" surface
     with its own new-mail badge - visible enough that real mail cannot die
     silently, but outside the general inbox (which stays contacts + unknown
     call/SMS only). Staff actions there: link to an existing contact (adds
     the address and moves the message into their timeline), create a
     contact, mark spam / block sender (persistent sender blocklist), delete.
  Rationale: an email domain WILL accumulate spam/newsletters/cold email;
  auto-creating needs_review contacts (the SMS pattern) would flood triage
  and Today and hide real contacts.
- **Thread resolution beyond phones.** Conversations are resolved by
  participant_phone today; email needs an email participant key on the SAME
  conversation so one contact = one interleaved thread across channels.
- **MessageType 'email'** on the existing append-only messages table, with
  the RFC Message-ID / SES message id as the provider id so the existing
  sid-pointer idempotency and status-callback machinery is reused.
- **Inbound pipeline.** SES receipt rules -> S3 raw MIME -> queue/worker ->
  MIME parse -> append message + attachments. Attachments go into the
  existing S3 MediaStore and are served only through the authed endpoint
  (same as MMS media). Size cap 25 MB per message both directions (the
  mainstream-provider interop limit; SES allows more but recipients on
  Gmail-class providers do not), distinct from MMS carrier limits.
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
4. **Composer.** Plain text; subject; To + CC (CC is in scope for v1 -
   CC'd addresses are recorded and displayed on the message; exact
   cross-thread semantics when a CC is itself a known contact are an
   implementation-plan decision); attachments via the existing
   presigned-POST upload; sender signature convention ("<Staff name> at
   Housing Choice"); reply-vs-new-thread semantics.
5. **Bounce/complaint handling.** Hard bounces auto-suppress the address
   (email_unreachable flag alongside sms_opt_out etc.); complaints set
   email_opt_out; failures surfaced like SMS delivery failures.
6. **Spam posture.** SES inbound spam/virus verdicts route mail to a
   quarantine sub-view of the unmatched-email surface (one click deeper than
   unmatched mail), so real mail cannot die silently; sender blocklist for
   recurring spam.
7. **Search-ready storage (search itself ships separately).** Product-wide
   search is deferred to [total-product-search](../../issues/total-product-search.md).
   Email v1's obligation: persist content so future indexing is a backfill,
   not a re-parse - extracted plain-text body, subject, and attachment
   filenames stored as queryable attributes on the message.
8. **Shared-mailbox semantics.** One org sending identity; outbound records
   which teammate sent it (existing author model extends); unread/SSE reuse;
   no per-conversation assignment (matches the removed-assignment decision).
9. **Identity collisions.** One address mapping to multiple contacts (PM
   office, housing-authority front desk) is common. v1 rule can be simple
   (most recent contact + triage flag) but must exist - and if v1 ships the
   simple rule, a follow-up registry issue for proper multi-contact address
   handling MUST be filed as part of delivering the feature.
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

## Open questions

All plan-blocking questions were resolved 2026-07-20 (Decisions 8-10). Still
open, operational only: which flows adopt email first (landlord welcome
likely), and whether any get catalog templates as a fast-follow.
