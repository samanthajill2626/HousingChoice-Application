---
id: masked-relay-calls-invisible
title: A masked relay call is persisted on the relay thread but rendered nowhere - the dashboard shows no sign the call happened
type: bug
severity: med
status: resolved
area: dashboard
created: 2026-08-18
resolved: 2026-08-24
refs: app/src/routes/webhooks/voice.ts, app/src/routes/relayGroups.ts, dashboard/src/routes/conversation/useRelayThread.ts, dashboard/src/routes/contact/Timeline.tsx
---

**Problem.** A masked relay call (a member dials the group's pool number and we
bridge them to the counterpart) IS persisted. `/webhooks/twilio/voice` appends a
metadata-only `type:'call'` message - `masked: true`, `call_party_label` set to
the counterpart's role/name, no recording and no transcript by design - onto
`relay.conversationId`, the relay group conversation itself
(`app/src/routes/webhooks/voice.ts:913`). Nothing ever renders it:

- The relay thread view drops it client-side. `toTimelineMessage` returns null
  for every `type:'call'` row (`dashboard/src/routes/conversation/useRelayThread.ts:49`).
  Its comment asserts "Relay threads never carry email or 1:1 call content: ...
  calls thread into 1:1 conversations server-side, so a relay-group fetch never
  sees them". That is true of founder-bridge calls and inbound email. It is NOT
  true of masked relay calls, which are written to exactly this conversation.
  The comment should be corrected as part of any fix.
- The contact timeline never sees it either. `conversationsForContact` results
  are filtered by conversation type and `relay_group` is skipped outright
  (`app/src/routes/contactTimeline.ts:850`), so a masked call cannot reach the
  contact's merged timeline the way a 1:1 call does.

Net effect: a relay call leaves a durable record in DynamoDB that no dashboard
surface reads. Staff reviewing a relay group see texts only and have no way to
know a call took place between two members, or when, or whether it connected.
The write path's masking work (role labels, do-not-record, no transcript) was
built precisely so this could be shown safely, and it is not being shown.

Note the same gap keeps `toTimelineCall`'s `masked` branch
(`app/src/routes/contactTimeline.ts:425-448`, which strips `party_phone`,
`recording_s3_key`, `transcript`, and `call_sid` on a masked row) unreachable
from the relay path today.

**Scope note.** NATIVE group texts are a separate, non-goal case: those threads
are imported carrier conversations and carry no call functionality at all. This
issue is only about relay groups, where the masked-call bridge exists.

**Desired behavior.** Show that the call happened, with the masking intact:
who called whom using the current roster display name, falling back to the
current formatted phone when a member is unnamed, plus when, duration, and the
outcome. Never a recording and never a transcript - masked calls are dialed
`record="do-not-record"` and are never sent to Voice Intelligence, so there is
nothing to expose even if we wanted to.

**Suggested fix.** Two independent halves; the first is small.

1. Read side, relay thread. Stop discarding `type:'call'` rows in
   `useRelayThread`, and render them with the same card the 1:1 comms panel
   uses, sourced from `call_party_label` + `author` rather than a participant
   phone. Depends on the relay thread's own message fetch already returning the
   row (it does - the drop is client-side).
2. Decide whether a masked call should ALSO surface on each participant's
   contact timeline. That is a policy question, not a mechanical one: the
   contact timeline deliberately excludes relay_group conversations so relay
   content is never inlined into a person's 1:1 history, and relay activity
   appears there as milestones instead. A masked call could follow the same
   rule (a milestone pin linking to the relay thread) rather than being
   inlined.

Related: `docs/issues/inbound-calls-invisible-in-inbox.md` (resolved) explicitly
listed masked/pool-number relay calls as a non-goal, so the inbox side of this
is also untouched - a masked call does not stamp the relay thread's last
activity, does not re-sort it, and does not bump unread.

**Resolution (2026-08-24).** The voice writer now stores the caller's stable
Relay member key on metadata-only call rows. The Relay roster read resolves
contact-backed names from the current contact record, and the dashboard maps
Relay calls into a media-free call shape before rendering a current-roster
"caller called recipient" summary. If a current name is absent, the current
formatted phone is shown; no name or phone snapshot is added to the call row.
The mapper and Relay card both suppress recording/transcript fields. Focused
unit coverage protects the writer, live roster hydration, safe mapper, and call
card; a hermetic browser regression places a real masked call and proves the
Timeline row appears without recording or transcript controls.
