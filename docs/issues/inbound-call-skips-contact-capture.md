---
id: inbound-call-skips-contact-capture
title: Inbound voice from an unknown number never runs contact auto-capture, so the caller is invisible to Today, the Unknown contacts list, and the inbox deep-link
type: bug
severity: high
status: resolved
resolved: 2026-07-20
area: app
created: 2026-07-20
refs: app/src/routes/webhooks/voice.ts:457, app/src/services/contactCapture.ts:110, app/src/routes/today.ts:566, app/src/routes/inbox.ts:375, dashboard/src/routes/inbox/InboxRow.tsx:36
---

**Problem.** The inbound SMS webhook runs `captureContact` (twilio.ts ~1016): an
unknown phone gets a stub contact (`type: 'unknown'`, `status: 'needs_review'`)
and the conversation's `participants` link is claimed. The inbound VOICE path
(voice.ts founder-triage handler) does neither - it calls `findByPhone`, creates
the `unknown_1to1` conversation via `createOrGetByParticipantPhone`, appends the
call entry, and bridges. An unknown caller therefore ends up with a conversation
but NO contact record and NO participants link. Verified live on dev 2026-07-20
(test call from a new number). Consequences:

- **Unknown contacts list empty:** `/contacts/unknown` lists contact records
  with `type=unknown`; none exists.
- **Missing from Today:** `/api/today` surfaces untriaged inbounds via (a) the
  conversation branch, which requires `unread_count > 0` AND a linked
  `participants[].contactId` (both absent - see below), and (b) the contacts
  triage pass over `(type=unknown, status=needs_review)` - no contact exists.
  A caller who "needs triage" never appears on the operator's action queue.
- **Inbox deep-link dead-ends:** the inbox's phone-keyed fallback row renders
  (needsTriage: true) but has no contactId, so the click-through falls back to
  `/contacts/unknown?phone=...` - an empty list. Staff can see the call
  happened but cannot open the caller's file.

Two contributing gaps found in the same investigation:

1. **Calls never increment unread.** `incrementUnread` is called only from the
   SMS paths in twilio.ts; voice.ts never touches it. Even with the
   participants link fixed, Today's conversation branch gates on unread. Product
   decision needed: does an inbound (esp. missed) call mark the thread unread?
2. **`?phone=` is write-only.** Three link sites emit
   `/contacts/unknown?phone=...` (InboxRow, ConversationDetail, buildToday) but
   ContactsList never reads searchParams - the param does not even prefill the
   search box.

Same class as [closed-intercept-skips-contact-capture](closed-intercept-skips-contact-capture.md)
(a non-standard inbound path skipping capture), but far more reachable: EVERY
first call from a new number hits it.

**Suggested fix.** Run `captureContact` in the inbound voice handler after
`createOrGetByParticipantPhone` (it is idempotent and race-safe by design).
Parameterize `capture_source` / consent stamping (the stub currently hardcodes
`inbound_sms` + `consent_method: 'inbound_text'`; a call should stamp
`inbound_call`, which the voice path already uses for existing contacts). Decide
the unread semantics for inbound calls. Make ContactsList read `?phone=` to
prefill its search filter so the deep-link actually deep-links.

**Resolution (2026-07-20).** Fixed on main. `captureContact` gained a
`source: 'inbound_sms' | 'inbound_call'` param (SMS behavior unchanged) driving
`capture_source`, the channel-matched automatic consent stamp, and the audit
`source`; the founder-triage inbound handler now runs it best-effort right
after conversation resolution (a capture failure never blocks the bridge);
ContactsList seeds its search box from `?phone=` (reactive to the param, since
the component stays mounted across filter routes). Covered by new unit tests
(contactCapture source stamps; founderTriage unknown-caller capture + known-
caller no-recapture; ContactsList deep-link seed) and an end-to-end spec,
e2e/tests/dashboard-next/unknown-caller-triage.spec.ts, exercising the missed-
call shape from the live bug report against the hermetic stack (Unknown list +
Today row + inbox contact deep-link + seeded search) - all green with
typecheck + full unit suites.

Deliberately unchanged (follow-up decisions, not defects):
- inbound calls still do NOT increment unread - Today surfaces the caller via
  the contacts triage pass, which does not gate on unread;
- the no-holder guard path (call rejected before any conversation exists)
  still captures nothing - the caller's later bridged call or text captures.
