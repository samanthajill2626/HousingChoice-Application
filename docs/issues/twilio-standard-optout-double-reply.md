---
id: twilio-standard-optout-double-reply
title: Twilio standard opt-out auto-replies are live while the app also files TwiML keyword replies - 1:1 STOP/HELP may double-confirm
type: bug
severity: high
status: resolved
area: app/messaging
created: 2026-08-10
resolved: 2026-08-12
refs: app/src/routes/webhooks/twilio.ts, app/src/lib/smsCompliance.ts, app/src/messages/catalog.ts, RUNBOOK.md, docs/a2p/campaign-resubmission.md
---

**Problem.** The app owned keyword replies (twilio.ts: "Twilio Advanced Opt-Out
auto-reply is OFF (operator step), so a matched keyword's filed reply is
returned HERE" as TwiML). The 2026-08-10 group-texting live spike proved that
Twilio's STANDARD (non-Advanced) opt-out was nonetheless ACTIVE on the dev
messaging service: with the app bypassed entirely, HELP/STOP/START each drew
Twilio's own auto-reply, and STOP enforced a provider-side block (21610). If
the standard auto-reply also fired in normal operation, every 1:1 STOP/HELP
produced TWO confirmations - Twilio's and ours.

## 2026-08-12 live test - the verification, in normal routing

Sent from a real handset to a dev number in NORMAL routing (app in the path),
which is what the 2026-08-10 spike could not answer:

| keyword | did our webhook see it? | what the sender received | our app's reply |
| --- | --- | --- | --- |
| `HELP` | NO - Twilio consumed the message; the webhook was never called | Twilio's HELP reply, once | none possible (never invoked) |
| `STOP` | yes | Twilio's STOP confirmation, once | FAILED with error **21610** (send to an opted-out number) - Twilio had already applied the block. This confirmation has NEVER been delivered, on any message, ever |
| `START` | yes | Twilio's opt-in confirmation AND our `welcome.sms` - a DOUBLE message | delivered (the doubling) |

Three findings, each fatal to the old premise:

1. "Advanced Opt-Out is OFF so we own the replies" was false in both halves.
   Twilio's platform handling was live regardless of the Advanced setting.
2. Our STOP confirmation was never a real behavior. The reasoning that it must
   ride the TwiML response rather than the opt-out-gated send wrapper was right
   about the gate and wrong about the outcome: Twilio blocks the TwiML message
   too, because it opted the number out before handing us the webhook.
3. Only START actually doubled, because it is the only keyword where the
   recipient is not blocked at the moment we answer.

## Resolution (Cameron's ruling, 2026-08-12) - RESOLVED

**Twilio owns the keyword REPLIES; the app keeps the keyword MACHINERY.**

- Advanced Opt-Out is turned **ON** on the messaging service and configured with
  **our** copy: opt-out confirmation = `STOP_CONFIRMATION`, help =
  `HELP_REPLY`, opt-in confirmation = `WELCOME_SMS`. It is a console-only
  feature - there is no Terraform/API step in this repo, so the procedure is
  documented rather than automated: RUNBOOK, "Keyword auto-replies (Advanced
  Opt-Out)".
- `app/src/messages/catalog.ts` (via `app/src/lib/smsCompliance.ts`) remains the
  SOURCE OF TRUTH for that copy. It is authored, reviewed and version-controlled
  here; the console is configured FROM it. Copy change = edit the constant,
  update the console, run the canary.
- The app REMOVED reply emission for STOP, HELP and START on every path (1:1,
  group-origin, collapsed roster, group-reason decline, closed-group relay
  intercept, open relay path). Classification (`classifyInboundKeyword`),
  `applyNumberSuppression`, contact/conversation flag writes, consent stamping,
  audit rows and relay member annotations are UNCHANGED. Every inbound now acks
  with the empty TwiML.
- The `suppressReply` parameter and the `semantically1to1` decline flag are
  deleted: both existed only to decide which paths withheld a reply that no
  longer exists.

**Deliberate relay-visible change.** The open relay path and the closed-group
intercept used to answer STOP/HELP/START themselves. They no longer do. This is
a change to relay behavior, made knowingly: leaving those replies in place would
preserve exactly the double-confirmation this issue is about.

**OptOutType is now the live classification path.** With Advanced Opt-Out ON,
Twilio stamps `OptOutType` on the inbound, and `classifyInboundKeyword` already
prefers it over the body. Twilio matches the EXACT keyword message, the same
rule the body branch applies, so a sentence such as "please stop sending tour
reminders" is neither stamped nor classified and still fans out on the open
relay path. Only our half is unit-asserted: `app/test/smsCompliance.test.ts`
pins that such a sentence carrying NO `OptOutType` classifies as undefined.
Whether Twilio stamps it is Twilio-side behavior we cannot assert in a unit
test, and is covered ONLY by the keyword canary's live sentence probe.

## Coupling (now discharged)

The group-texting feature relied on Twilio's auto-reply as the ONLY STOP
confirmation on group-origin keywords, and the same dependency covered a
GROUP-REASON DECLINE (corrupt/truncated envelope, unparseable address,
exclusion-set cold start) which files 1:1 and also suppressed our reply. The two
paths that regained the app reply in fix wave 4 (envelope on a non-business
number; `BUSINESS_PHONE_NUMBER` unset) would have double-confirmed. All of that
collapses into one rule now: no path replies, every path records, and Twilio
sends exactly one branded confirmation per keyword.

## Ops still owed

Enabling + configuring Advanced Opt-Out is a console action on each messaging
service: dev now, prod at the go-live preflight. See RUNBOOK, "Keyword
auto-replies (Advanced Opt-Out)". Until it is done on a given service, that
service falls back to Twilio's DEFAULT (unbranded) standard keyword copy - the
compliance floor is still met, the copy is just not ours.
