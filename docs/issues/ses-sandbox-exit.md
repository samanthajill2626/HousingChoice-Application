---
id: ses-sandbox-exit
title: SES identities are sandboxed — request production access for real outbound mail
type: improvement
severity: low
status: resolved
area: infra/email
created: 2026-06-11
resolved: 2026-08-03
---

**Resolution (2026-08-03).** SES production access was REQUESTED and APPROVED - the account
is out of the sandbox, so real outbound mail can reach unverified recipients. Done as part of
activating the email channel (`email-as-first-class-channel`), alongside the `inbound_mail`
terraform apply, the Netlify DNS records (DKIM x3 / MX / SPF), receipt-rule-set activation,
and the `EMAIL_SENDING_ENABLED` flip.

**Problem.** Both SES identities are in the sandbox (verified recipients only).

**Action.** File the SES production-access request when real outbound mail is needed.
Deferred until that point.

Migrated from the RUNBOOK "Security / hardening backlog".
