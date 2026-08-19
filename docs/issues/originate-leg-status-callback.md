---
id: originate-leg-status-callback
title: A never-accepted outbound originate has no durable terminal status - the timeline label is derived from the row's age instead
type: improvement
severity: med
status: open
area: app/voice
created: 2026-08-18
refs: app/src/services/originateCall.ts, app/src/adapters/messaging.ts, app/src/routes/webhooks/voice.ts, dashboard/src/routes/contact/presentCallState.ts
---

**Problem.** When a navigator originates a masked call and never picks up their
own ringing cell, nothing terminal is ever written for that call. The originate
appends a `call` row with `call_status: 'ringing'`, the navigator's leg rings out
or is declined, and no `<Dial action>` summary is ever produced - the Dial never
happened, because press-1 is what causes the target to be dialed at all. The row
stays `ringing` forever.

The comms-panel call-direction work (spec
`docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md`,
decision D6) handles this READ-SIDE, by derivation: `presentCallState` shows
"Ringing..." while the row is younger than 90 seconds and "No team answer"
after that. The derivation is honest and self-correcting - the moment any real
terminal status is written, `call_status` stops being `ringing` and the age
clause is never reached, with nothing wrong ever persisted - but it is a label
computed from a clock, not a fact recorded from the carrier. Consequences:

- The stored row is indistinguishable from a genuinely still-ringing call, for
  every consumer other than the timeline card. The inbox derives its own row from
  the same `ringing` status and says nothing about the outcome.
- The threshold (90 seconds) is coupled to Twilio's 60-second default ring plus
  the whisper `<Gather timeout: 8>`. If either changes, the derived label is
  wrong until someone notices the coupling.
- Clock skew on the viewer's machine flips the label early or late.

**Suggested fix - the scope, recorded so the next person does not re-derive it.**
This was scoped and deliberately rejected as disproportionate for that mission;
it is five coordinated changes, not one:

1. **`InitiateCallParams` contract change** - the originate must be able to ask
   for a per-call status callback URL (and the status events it wants) on the
   navigator's own leg, which the params type does not carry today.
2. **Twilio driver change** - `adapters/messaging.ts` must pass that callback
   through to `calls.create` (`statusCallback` / `statusCallbackEvent`), and keep
   the URL free of PII the same way the whisper URLs already are.
3. **fake-twilio change** - the fake `CallEngine` must POST the leg-status
   callback on the paths that produce no Dial summary at all, notably `hangup()`
   (which today resolves the pre-dial gate locally and posts nothing), so the
   behavior is drivable in the hermetic e2e stack instead of only in production.
4. **A new arm in `/voice/status`** - the handler currently reasons about
   `<Dial action>` summaries; a bare leg-status callback for the PARENT CallSid
   is a different shape and must not be mistaken for a Dial summary, must be
   idempotent against a later real summary, and must not fire the missed-call
   auto-text or the founder push (both are direction-gated today and must stay
   so).
5. **A fourth `CallOutcome` value across BOTH wire contracts** - the honest
   stored value for "our own side never answered" is not `missed` (which on an
   outbound row describes the TARGET) and not `answered`. It needs its own
   member in `messagesRepo.ts`'s union and in
   `dashboard/src/api/types.ts`, plus the projection's normalization helper, plus
   the presenter clause that renders it, plus the inbox's `callPreview`.

Once (5) lands, `presentCallState`'s age-based ringing clause becomes dead code
for outbound rows and the 90-second constant can be deleted along with its
derivation comment.
