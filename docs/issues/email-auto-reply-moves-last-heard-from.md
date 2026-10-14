---
id: email-auto-reply-moves-last-heard-from
title: An email auto-reply (out-of-office) moves a contact's last heard from and marks earlier sends Replied
type: bug
severity: med
status: open
area: app
created: 2026-10-13
refs: app/src/services/inboundEmail.ts:815, app/src/repos/contactsRepo.ts:225, app/src/lib/heardFrom.ts
---

**Problem.** `last_heard_from_at` is bumped by every attributed inbound email,
including an automatic reply from the contact's mail server (an out-of-office
or vacation responder). The inbound email path has no auto-reply detection
(`app/src/services/inboundEmail.ts:815-843`). An auto-reply therefore:

- makes every earlier property send to that contact read "Replied";
- resets the Follow up list's 24-hour quiet window for those sends;
- moves the contact to the top of the Tenants tab's "Last heard from" sort.

The backfill (`app/scripts/backfill-last-heard-from.ts`) counts historical
auto-replies the same way. The attribute's comment ("outbound and automated
traffic never moves it", `contactsRepo.ts:225-229`) means OUR automated sends;
a contact-side auto-reply is not covered by it.

**Reach.** Only when staff email a tenant (or partner) whose mailbox
auto-replies. Sam reaches tenants by text, so this is rare today; it grows if
email outreach grows. Found by the planner's plan-blind adversarial review of
`feat/last-heard-from` (2026-10-13), deferred there.

**Suggested fix.** Skip the touch (keep persisting the message) when the
inbound email carries `Auto-Submitted` with any value other than `no`
(RFC 3834), `X-Autoreply` / `X-Autorespond`, or `Precedence: auto_reply`
(also `bulk` / `list`). The ingest stores only a capped header subset
(`capStoredHeaders`), so the check belongs where the raw headers are parsed,
and the email row should record the flag (for example `email_auto_reply:
true`) so `attributeInbound` and the backfill skip it under the one rule.
