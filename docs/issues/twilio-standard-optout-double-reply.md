---
id: twilio-standard-optout-double-reply
title: Twilio standard opt-out auto-replies are live while the app also files TwiML keyword replies - 1:1 STOP/HELP may double-confirm
type: bug
severity: high
status: open
area: app/messaging
created: 2026-08-10
refs: app/src/routes/webhooks/twilio.ts, app/src/lib/smsCompliance.ts, docs/superpowers/specs/2026-08-10-group-texting-spike-report.md
---

**Problem.** The app owns keyword replies (twilio.ts:80-91: "Twilio Advanced
Opt-Out auto-reply is OFF (operator step), so a matched keyword's filed reply
is returned HERE" as TwiML). The 2026-08-10 group-texting live spike proved
that Twilio's STANDARD (non-Advanced) opt-out is nonetheless ACTIVE on the dev
messaging service: with the app bypassed entirely, HELP/STOP/START each drew
Twilio's own auto-reply, and STOP enforced a provider-side block (21610). If
the standard auto-reply also fires in normal operation, every 1:1 STOP/HELP
today produces TWO confirmations - Twilio's and ours - which is sloppy at
best and a compliance-copy inconsistency at worst. The A2P campaign filing
(docs/a2p/campaign-resubmission.md) describes opt-out as self-managed.

**Verify first.** On a dev number in normal routing, send STOP from a real
handset and count the replies. Check whether "Advanced Opt-Out OFF" leaves
standard filtering's auto-respond active by definition (Twilio docs are
ambiguous) and whether any messaging-service setting disables the standard
reply without enabling Advanced Opt-Out.

**Resolution options (decide, then align copy):** (a) keep Twilio's standard
replies and DROP ours; (b) enable Advanced Opt-Out configured to suppress
auto-replies and keep ours; (c) confirm standard replies do not actually fire
in normal routing (spike artifact) and change nothing.

**Coupling.** The group-texting feature relies on Twilio's auto-reply as the
ONLY STOP confirmation on group-origin keywords (the app deliberately sends
nothing there; an app send to a just-STOPped member would 21610). If this
issue resolves by disabling Twilio's standard replies, the group STOP
confirmation must become an app-side send at that time.
