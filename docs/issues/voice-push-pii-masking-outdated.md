---
id: voice-push-pii-masking-outdated
title: Voice pushes still mask caller PII the device should handle - align with the message-push posture
type: improvement
severity: low
status: resolved
area: app/voice
created: 2026-08-16
resolved: 2026-08-25
refs: app/src/routes/webhooks/voice.ts, app/src/lib/voiceMasking.ts
---

**Problem.** The voice push notifications (pre_ring, missed_call,
voicemail) deliberately mask the caller: the body carries the masked
call_party_label ("a role/name, NEVER a raw phone"), and an unknown
caller's raw number is surfaced only on the founder's own device
(voice.ts pushCallerLabel and the comments around the three send sites,
which cite the build plan's PII section).

That posture is now outdated. The operator ruled (2026-08-16, recorded
as D4 in the inbound-message push design spec and in
docs/issues/no-push-on-inbound-message.md): staff-facing pushes carry
FULL sender identity and content, like a native phone/SMS app - hiding
notification content on the lock screen is the DEVICE's job (a standard
OS setting), not something the app pre-censors. Message pushes ship
with full names, phone-number fallbacks, and message text; the voice
pushes are now the inconsistent ones.

**Suggested fix.** Align the three voice push payloads to carry the
caller's real name where known and the real number where not (drop the
founder-device-only special case), and rewrite the code comments that
assert the masked posture so they stop describing a rule the product no
longer has. Keep the LOG posture unchanged - pushService and the voice
routes must still never log payload contents; this change is about what
the push carries, not what the server logs.

**Scope note.** Voice <Say> prompts, SMS bodies, and the masked relay
identity system are unaffected - this is only about the three
staff-facing push notifications.

**Resolution (2026-08-25).** Aligned on `feat/log-hygiene` under D4 plus an
operator amendment of 2026-08-25: the ROLE WORD IS KEPT. The amendment matters
for reading this issue's text literally - D4's substance is full identity, not
role removal, the role is load-bearing context on an incoming call, and nothing
may carry LESS information than today's label. So the pushes gained the name and
number without losing the role.

`pushCallerLabel` (module-private, three readers) is deleted and replaced by the
exported `pushCallerIdentity(contact, conversation, phone)` in
`app/src/routes/webhooks/voice.ts`. The identity half resolves through the
message pushes' own naming chain: `contactDisplayName(contact)`, then an INLINED
non-empty-string check on `conversation?.participant_display_name` (a bare `??`
would select a STORED EMPTY STRING, which is why the check is inlined rather than
chained), then `formatPhoneForDisplay(phone)`, then a guarded terminal rung on
the raw phone that the message chain does not need - there the `From` is
webhook-guaranteed, here the phone is `conversation?.participant_phone` and can
be undefined, and today's code always yields a non-empty label. The label is
`<Role> - <identity>` when both halves exist, else the role, else the identity,
else `UNKNOWN_CALLER_LABEL`. Outcomes, none losing information against the old
behavior:

- known, named:    "Tenant - Jane Doe"        (was "Tenant (Jane D.)")
- known, nameless: "Tenant - (555) 017-7777"  (was "Tenant")
- unknown caller:  "(555) 017-7777"           (unchanged)

The founder-device-only special case is gone: an unknown caller's real number is
now the ordinary terminal fallback for every staff recipient, which is what the
issue asked for. `contactDisplayName` is IMPORTED from `app/src/lib/contactName.ts`,
never copied - its header forbids private copies (see
[consolidate-contact-display-name-helpers](./consolidate-contact-display-name-helpers.md),
still open; the voice pushes are now its second push-copy consumer).

All three sites updated. `pre_ring` needs no new reads - the handler already
holds `callerContact` and the conversation. `missed_call` and `voicemail` now
RE-DERIVE the identity at push time (the conversation they already fetch, plus
one best-effort `contacts.findByPhone(participant_phone)` in a try/catch that
falls through the chain on failure) instead of reading the `call_party_label`
stored at bridge time; the `messages.getByProviderSid(callSid)` read is gone from
both, trading one messages read for one contacts read. NAMED BEHAVIOR
CONSEQUENCE: those two pushes now reflect contact data as of PUSH time, not RING
time, so a contact renamed between the ring and the miss shows the newer
identity. Relay/masked calls cannot reach these pushes (they are gated
`masked !== true`), so `participant_phone` is the real caller.

UNCHANGED, deliberately: the STORED masked `call_party_label`, the spoken
whisper, thread rendering, and the outbound originate path -
`maskedCallerLabel` keeps every one of its other consumers, and its pins stayed
green untouched. The LOG posture is unchanged as the issue requires: neither
`pushService` nor the voice routes log payload contents. No change was made to
`dashboard/public/sw.js` or `dashboard/src/sw/*` - field names are identical and
only values moved. The comments that asserted the masked-push posture now cite
D4 and the 2026-08-25 role-word amendment instead.
