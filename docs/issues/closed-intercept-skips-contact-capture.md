---
id: closed-intercept-skips-contact-capture
title: Closed-group late-text intercept skips contact auto-capture, so a contact-less sender's 1:1 thread is unreachable from the inbox
type: debt
severity: low
area: app
created: 2026-07-17
refs: app/src/routes/webhooks/twilio.ts:456, app/src/routes/webhooks/twilio.ts:885
---

## What

The relay-number-lifecycle branch routes a late text from a CLOSED group's
roster member into the sender's 1:1 thread with `via_closed_group` provenance
(handleClosedGroupInbound). Unlike the normal 1:1 inbound path, the intercept
does NOT run contact auto-capture (the (3.5) `captureContact` step that mints a
stub contact for unknown phones and links the conversation).

Consequence for a sender with NO contact record: the message persists in an
unknown-1:1 conversation, the Inbox row shows the preview, but its
click-through target (`/contacts/unknown?phone=...`) degrades to the filtered
contacts LIST - staff can see that a message arrived but cannot open the
thread from there. Verified live during self-QA (lane session, 2026-07-17).

## Reachability

Low in product flows: relay groups built via the tour/placement paths always
carry contact-backed members, and `captureContact` on the normal path already
covered them at intake. Reachable via:

- the standalone POST /api/relay-groups scaffold route (members may be created
  with phone+name only), and
- a roster member whose contact record is later DELETED, then texting the
  closed group's number.

The same gap slightly weakens the fix-wave STOP parity for contact-less
senders (conversation-level opt-out records; there is no contact record to
flag - same as any contact-less 1:1 before capture runs).

## Fix direction

Run the same `captureContact` step in handleClosedGroupInbound (idempotent,
race-safe by design per services/contactCapture.ts) so the 1:1 delivery path
is byte-parity with normal intake.
