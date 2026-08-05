---
id: automated-sms-length-guard
title: No length guard on automated SMS; catalog maxChars is declared but never enforced
type: improvement
severity: med
status: open
area: app/messages
created: 2026-08-05
refs: app/src/messages/catalog.ts:87, app/src/services/sendMessage.ts, app/src/lib/address.ts:33
---

**Problem.** Nothing anywhere checks how long an automated SMS actually is before
it goes out. `MessageDef` declares `maxChars` ("Segment cap for future
validation (default 320 for sms)") and NOTHING reads it. There is no runtime
check, no test, and no log line, so a message that interpolates into three or
four segments sends silently at 3-4x the intended cost.

Static catalog defaults are safe by inspection - a human wrote them and they are
short. The exposure is INTERPOLATED bodies, where a code-controlled template is
joined to user-controlled data of unbounded length. Concrete example: unit
addresses are capped at `line1` 200 + `line2` 100 chars (`lib/address.ts`
FIELD_CAPS), so a LEGAL address is about 300 characters. Interpolated into a
tour reminder that is roughly 3 segments per rung, across a 4-rung ladder. The
same shape applies to `{members}` in the relay intro (a large roster), to
`{firstName}` in an operator-overridden welcome, and to any future token.

The catalog's own `maxChars` field is the intended guard. It was written as
"future validation" and the future never arrived.

Cameron's ruling (2026-08-05, while specing tour-reminder-details): a length
guard belongs at the automated-send layer where it protects EVERY message, NOT
bolted onto one feature's composer. The tour-reminder spec therefore adds no
tour-local cap and accepts unbounded interpolation until this lands.

**Why not just truncate.** Truncating the interpolated value mangles user data -
a street that reads "1234 Northwest Somethingvi" is worse than a long text, and
truncating a person's name is worse still. The guard should OBSERVE and FLAG, and
let a human fix the data. Any truncation policy needs its own decision.

**Suggested fix.**

1. Reuse `analyzeSms()` from `lib/smsEncoding.ts` (added by the
   tour-reminder-details branch; see [[sms-copy-non-gsm7-characters]]) as the
   single length/segment authority - it prices GSM-7 vs UCS-2 correctly, which a
   naive `body.length` check does not.
2. Thread the resolved `MessageId` down to the automated send path. This is the
   real work: `sendMessage` today receives a `body` string with no idea which
   catalog entry produced it, so it cannot look up `maxChars`. Options are an
   optional `messageId` on the send input, or a resolved-message wrapper object
   carrying both.
3. On an automated send whose body exceeds its entry's `maxChars` (default 320),
   log at warn with the message id, the segment count, and the entity id - never
   the body or any PII. Do NOT block the send: a long text is better than no
   text, and this is a cost problem, not a correctness one.
4. Add a test asserting every `channel: 'sms'` default is within its own
   `maxChars`, so the declared field finally means something.

**Out of scope.** Manual/composed 1:1 messages a human typed - they can see what
they wrote. This is about AUTOMATED copy where nobody reviews the final string.
