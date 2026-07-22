---
id: email-apex-from-address
title: Optional polish - send From an apex address (team@housingchoice.org) instead of the mail subdomain
type: improvement
severity: low
status: deferred
area: infra
created: 2026-07-21
refs: infra/modules/inbound_mail/main.tf, infra/modules/ec2/main.tf
---

**Problem.** Outbound platform email sends From `team@mail.<env-domain>`
(Cameron's 2026-07-21 decision: keep the subdomain for now). The apex
(`housingchoice.org`) would look more polished to landlords/authorities.
Apex INBOUND is impossible forever (staff mailboxes own the apex MX), but
apex FROM is doable because replies route via the relay+token Reply-To,
not the From.

**Suggested fix (the full recipe, so nothing is re-derived).**
1. Terraform: second SES domain identity + DKIM for the APEX (classic
   family, alongside the mail-subdomain identity in inbound_mail or a tiny
   sibling module). No receipt rules, no MX changes.
2. Netlify DNS: 3 apex DKIM CNAMEs (coexist with the mailbox provider's
   records) + MERGE `include:amazonses.com` into the EXISTING apex SPF TXT
   (one SPF record per host - never add a second).
3. IAM: widen the ec2 SesSend `ses:FromAddress` condition to include
   `*@housingchoice.org` (currently pinned to the mail domain).
4. Params: point `EMAIL_FROM_ADDRESS` at the apex address.
5. Pick an address that EXISTS as a mailbox/alias on the mailbox provider
   (team@/hello@) - clients that ignore Reply-To reply there; it must not
   bounce. Confirm DMARC alignment if an apex DMARC policy exists.
Prod-only; dev stays on mail.dev regardless.
