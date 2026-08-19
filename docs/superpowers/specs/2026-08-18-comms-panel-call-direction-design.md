# Comms panel: calls as first-class directional items - design spec

Date: 2026-08-18
Branch: `feat/comms-panel-call-direction`  Worktree: `W:\tmp\comms-panel-call-direction`
Base: `main` @8c4eac85

## 1. Problem

The 1:1 comms panel renders three transports in three different visual
languages, and one of them carries no direction at all.

- An SMS/MMS bubble takes a side: `align-self: flex-start` for inbound,
  `flex-end` for outbound (`Timeline.module.css:222-232`).
- An email card is centered at 84% width and encodes direction only as a faint
  background tint (`Timeline.module.css:938-956`).
- A call card is centered at 84% width and encodes direction NOWHERE
  (`Timeline.tsx:710-760`).

For calls this is not a styling preference, it is missing data. The stored
message row carries `direction` on every writer - the founder bridge
(`voice.ts:613`), the outbound originate (`originateCall.ts:176`), the masked
relay bridge (`voice.ts:918`), and the Quo importer (`apply.ts:439`) - but the
server projection never copies it onto the wire (`contactTimeline.ts:432-449`),
and neither `TimelineCall` declaration has a field for it
(`contactTimeline.ts:179-195`, `dashboard/src/api/types.ts:2222-2238`). The one
other identifying value on the card, `party_phone`, is
`conversation.participant_phone`, which is the other party's number in both
directions and therefore never disambiguates.

An inbound miss and an outbound call that rang out are pixel-identical today.

Three defects sit underneath that and become conspicuous the moment direction is
visible:

- **Outbound outcome is wrong.** The whisper gate stamps `answered_at` on the
  navigator's OWN leg at press-1, before the target is dialed, so the terminal
  `<Dial action>` summary classifies every outbound call that reached a `<Dial>`
  as `answered` - including one nobody picked up (`voice.ts:1361-1382`,
  `docs/issues/outbound-call-outcome-answered-before-target-rings.md`). The
  correct value is already computed three lines later at `voice.ts:1432` for the
  inbox preview and deliberately not persisted.
- **A never-accepted originate is projected as a miss.** If the navigator never
  presses 1, no `<Dial>` runs, no Dial summary arrives, and the row keeps
  `call_status: 'ringing'` with no `call_outcome`. The projection's
  `call_outcome: (m.call_outcome ?? 'missed')` default (`contactTimeline.ts:439`)
  then manufactures a terminal answer out of absent data, and the card reads
  "Missed" - asserting the contact did not pick up a call that was never placed
  to them.
- **Imported calls render as garbage.** The Quo importer writes
  `call_outcome: 'no_answer' | 'completed'` (`apply.ts:448`), which is outside
  the `CallOutcome` union `'answered' | 'missed' | 'voicemail'`
  (`messagesRepo.ts:57`), and writes the duration to `call_duration_seconds`
  (`apply.ts:445`) where the live path and the projection both use
  `call_duration` (`messagesRepo.ts:1779`, `contactTimeline.ts:440`). The
  projection casts the unknown string through `as CallOutcome`, so the card
  prints "No_answer" or "Completed", colors both with the red miss class (the
  ternary's else arm), and shows no duration at all.

## 2. Goal

One alignment rule for the whole panel, with calls carrying honest direction and
an honest outcome.

- Every communication takes a side by direction: inbound left, outbound right,
  for SMS/MMS, email, and calls alike.
- Every milestone pin stays centered. This becomes the panel's readable rule
  rather than an accident of which component shipped when: **centered means a
  system event, a side means somebody communicated.**
- A call states its direction in words and in position, and states an outcome
  the data can actually support.

## 3. Locked decisions (human rulings, 2026-08-18)

- **D1 - Full directional flow.** Calls AND emails align by direction alongside
  the existing bubbles. Chosen over two alternatives shown side by side: aligning
  calls only (leaves email the lone centered item) and giving calls email's
  current centered-plus-tint treatment (direction carried by a word only). The
  human's reason: the centered email card was itself unintended, and one rule
  reads as cohesive where two do not.
- **D2 - Arrow AND word.** A call card leads with a direction arrow glyph
  (U+2199 down-left for inbound, U+2197 up-right for outbound) followed by
  "Incoming call" / "Outgoing call". Position alone is insufficient: the word is
  what a screen reader announces and what survives the stacked single-column
  layout where the two columns nearly touch.
- **D3 - Outcome vocabulary.** Inbound: "Answered", "Missed", "Voicemail".
  Outbound: "Connected" (plus duration) and "No answer". "Connected" rather than
  "Answered" on outbound is deliberate and load-bearing - see invariant I2.
- **D4 - The party phone moves behind the existing click-to-reveal.** A call
  card gains the same tap-to-reveal meta line a message bubble already has
  (`Timeline.tsx:563-569`), carrying "to/from <number> - <duration> - <time>".
  On a 1:1 thread the number is always the same person, so it is
  detail-on-demand, not summary.
- **D5 - The outbound outcome write is folded into this mission.** It is a
  different file (`voice.ts`) from the rest of the work, accepted explicitly by
  the human on the grounds that the fix is small, self-contained, and nobody is
  working that area elsewhere.
- **D6 - The never-accepted originate is handled READ-SIDE, by derivation, with
  no new write path.** The durable fix (a status callback on the navigator's
  leg) was scoped and rejected as disproportionate: it needs an
  `InitiateCallParams` contract change, a Twilio driver change, a fake-twilio
  change, a new arm in `/voice/status`, and a fourth `CallOutcome` value across
  both wire contracts. See section 8 and the follow-up in section 11.
- **D7 - The staleness threshold is 90 seconds.** Derived from the real bound,
  not chosen for roundness: `calls.create` passes no `timeout`
  (`messaging.ts:850`) so Twilio's 60-second default applies to ringing the
  navigator's cell, and the whisper `<Gather timeout: 8>` (`voice.ts:1063`) sits
  on top of it, for about 68 seconds before the outcome is genuinely settled. 90
  clears that with slack for webhook latency. A 30-second threshold was
  considered and rejected for labelling a still-ringing phone as unanswered.
- **D8 - The label for a never-accepted originate is "No team answer".** It
  names whose line rang out, reuses "team" (already the product's word for our
  own side in the relay sender labels, `resolveSenderLabel`), and does not
  collide with "No answer", which on an outbound row describes the target.
- **D9 - Answering Machine Detection is out of scope.** Distinguishing a human
  from the target's carrier voicemail on an outbound call requires Twilio AMD on
  the dialed leg, at a per-call fee and added pre-bridge latency. Deferred as its
  own decision with its own cost question (section 11).
- **D10 - Imported-call normalization is folded in.** Historical Quo calls are a
  large share of what this panel renders; shipping a first-class call card that
  prints "Completed" in miss-red with no duration is not shipping the feature.
- **D11 - Follow handset convention where one exists, depart from it only where
  it has nothing to say.** An inbound call that rang briefly and was abandoned
  reads "Missed", with no minimum ring duration - which is exactly what a
  handset call log does for a one-ring abandon, and the reason 7.1 clause 3's
  inbound arm is preserved rather than given a softer phrase of its own.
  The convention runs out on the outbound side: a handset shows an unanswered
  outgoing call as an outgoing entry with no duration and no explanatory label,
  because the only person reading that log is the person who placed the call.
  A shared staff inbox has the opposite property - a teammate opening a
  tenant's timeline did not place the call and cannot infer what happened - so
  "No answer" (D3) and "No team answer" (D8) are a deliberate departure,
  covering a need the handset precedent never had.

## 4. The load-bearing invariants

**I1 - The outbound connected/no-answer signal comes from the TARGET leg, never
from the navigator's press-1.** These are two distinct values in the same
handler and must not be conflated:

- `rawStatus = DialCallStatus ?? CallStatus` (`voice.ts:1309`). On a `<Dial
  action>` summary this is `DialCallStatus`, and on the originate the `<Dial>` is
  the leg dialing the target, so `completed` means the target picked up.
- `bridgeAccepted = entry.answered_at` (`voice.ts:1363`) is the navigator's
  press-1, stamped on their own leg.

Outbound rows read the first and must not read the second. Inbound rows keep
reading the second, where it is genuinely authoritative: the press-1 whisper gate
exists specifically to block carrier voicemail (`voice.ts:16`), and a voicemail
cannot press 1.

**I2 - "Connected" is the strongest honest claim available on outbound.**
`DialCallStatus: 'completed'` with a duration is produced identically by a human
answering and by the target's carrier voicemail answering. Twilio gives us no
way to tell them apart without AMD (D9), and neither does a consumer phone's
call log. Labelling this "Answered" would assert something we cannot support.

**I3 - A live call is never in `ringing`, so the staleness derivation cannot
mislabel one.** The outbound whisper gate writes `call_status: 'in-progress'`
plus `answered_at` at press-1, BEFORE it emits the `<Dial>`
(`voice.ts:1187-1199`). The call-status machine is forward-only and nothing
transitions INTO `ringing` (`ALLOWED_PRIOR_CALL_STATUS.ringing = []`,
`messagesRepo.ts:71-73`). Therefore a row that was ever accepted can never
re-enter the derived branch, and a call that connects at second 40 and ends at
second 70 is never relabelled at second 90. This property is what makes D6 a
sound derivation rather than a guess; any change to it invalidates D6.

**I4 - A masked call never exposes content.** Masked rows are dialed
`record="do-not-record"` and are never transcribed, and the projection already
strips `party_phone`, `recording_s3_key`, `transcript`, `transcript_status`, and
`call_sid` from them (`contactTimeline.ts:425-448`). Direction and the derived
outcome label are metadata and are safe to add; nothing in this spec loosens
that stripping. PII rule (doc section 9) is unchanged: no raw counterpart phone
in logs, and none rendered for a masked row.

**I5 - Relay and native-group threads are untouched.** A relay-group fetch is
mapped by `useRelayThread`, which drops every `type:'call'` row
(`useRelayThread.ts:49`), and the contact timeline skips `relay_group` and
`group_text` conversations outright (`contactTimeline.ts:850`). Masked relay
calls are consequently invisible everywhere; that is a real gap, filed
separately as `docs/issues/masked-relay-calls-invisible.md`, and is NOT in this
mission. Note this means I4's masked branch stays unreachable from the relay
path even after this change.

**I6 - No backfill is required.** `direction` is written by every call writer
including the importer, so every historical row already carries the field this
spec starts projecting.

## 5. Data model and wire contract

No DynamoDB schema change, no index change, no migration.

`TimelineCall` gains two fields and loses a lie. Both declarations change
identically and independently (`app/src/routes/contactTimeline.ts:179-195` and
`dashboard/src/api/types.ts:2222-2238` are hand-mirrored by convention; each
side's own `tsc` plus the payload-shape route test is the lockstep pin):

```
direction: MessageDirection;      // NEW - required; every stored row has it
call_status?: CallStatus;         // NEW - optional; absent on imported rows
call_outcome?: CallOutcome;       // WAS required; now optional
```

`call_outcome` becoming optional is the point: absent means "no terminal outcome
is known", which is a state the client must render honestly rather than a state
the server should invent. Dropping `?? 'missed'` is what makes D6 possible.

The dashboard has no `CallStatus` type today (`types.ts` declares `CallOutcome`
at 1442 and no status union); add it mirroring `messagesRepo.ts:42-49`.

## 6. Server design

### 6.1 Projection (`app/src/routes/contactTimeline.ts`, `toTimelineCall`)

1. Copy `direction: m.direction` onto the wire.
2. Copy `call_status` when present and known.
3. Delete the `?? 'missed'` default. Emit `call_outcome` only when the stored
   value is a MEMBER of the union - an unrecognized string is dropped, never
   cast through `as CallOutcome`.
4. Normalize the two imported outcome strings before that membership test
   (D10): `'no_answer' -> 'missed'`, `'completed' -> 'answered'`. Anything else
   unrecognized is dropped, which renders as a call with a direction and a time
   and no outcome chip - honest, and better than today's red "Completed".
5. Fall back to `call_duration_seconds` when `call_duration` is absent (D10), so
   imported calls show their duration.

Steps 3 and 4 are a small shared helper next to the projection rather than
inline ternaries, so the normalization has one home and its own unit test.

### 6.2 Outbound outcome write (`app/src/routes/webhooks/voice.ts`, `/status`)

The correct outbound values are already computed at `voice.ts:1432-1433`, below
the `updateCallStatus` write at 1384, and used only for the inbox preview
string. Hoist that computation above the write and use it for outbound rows:

- `previewOutcome = outbound ? (mapped === 'completed' ? 'answered' : 'missed') : outcome`
- `previewDuration = (outbound ? mapped === 'completed' : bridgeAccepted) ? callDuration : undefined`

Then `updateCallStatus` persists those for an outbound Dial summary instead of
the `bridgeAccepted`-derived pair. Inbound is byte-identical to today.

Deliberately unchanged, to keep the blast radius at "what gets stored":

- `bridgeAccepted` keeps its meaning and its inbound uses.
- `stampAnsweredAt` still stamps at the in-progress transition, so a live
  outbound call still reads in-progress mid-call.
- `isMissed` and the missed-founder-bridge trigger are untouched; that path is
  already gated `direction !== 'outbound'` (`voice.ts:1466`).
- The unread rule is untouched; it is already gated to inbound
  (`voice.ts:1444`).
- The inbox preview string keeps reading the same values it reads today.

## 7. Client design

### 7.1 A pure presenter, extracted

The label/tone decision is a pure function in its own module, not logic buried
in JSX - it has the most cases of anything here and must be unit-testable
without rendering:

```
presentCallState({ direction, call_status, call_outcome, at, now })
  -> { label: string, tone: 'success' | 'danger' | 'warning' | 'neutral', live: boolean }
```

Resolution order:

1. `call_outcome === 'voicemail'` -> "Voicemail" (warning). Wins over status.
2. `call_status === 'ringing'` and `now - at < 90s` -> "Ringing..." (neutral,
   `live: true`).
3. `call_status === 'ringing'` and `now - at >= 90s` -> outbound: "No team
   answer" (danger); inbound: "Missed" (danger).
4. `call_status === 'in-progress'` -> "In progress" (neutral, `live: true`).
5. `call_outcome === 'answered'` -> outbound: "Connected" (success); inbound:
   "Answered" (success).
6. `call_outcome === 'missed'` -> outbound: "No answer" (danger); inbound:
   "Missed" (danger).
7. Nothing known -> no chip at all (the card still renders direction and time).

Clause 2 uses the viewer's clock against the row's `at` (which is `provider_ts`,
the ring start). Clause 3's inbound arm is the pre-existing behavior for an
inbound row that never resolved, preserved deliberately per D11: a caller who
abandoned during the ring produced a missed call, and a handset would say so
regardless of how briefly it rang.

Clause 3's outbound arm covers two sub-cases that are not distinguished, on
purpose: the navigator's cell was never answered, and the navigator answered but
never pressed 1 (a timeout or any non-accept key, `voice.ts:1252`). "No team
answer" is true of both. Stamping a terminal status from the gate's decline
branch would resolve the second durably, but it would need an outcome value that
does not read as "the target did not answer" - the same fourth-value problem D6
declined - so both stay derived.

### 7.2 CallCard

- Wrapped in the direction alignment class; `max-width: 84%` replacing
  `align-self: center; width: 84%`.
- Summary line: arrow glyph, then "Incoming call" / "Outgoing call", then the
  outcome chip from 7.1, then the time.
- Click-to-reveal meta line (D4) carrying "to/from <formatted number> -
  <duration> - <time>", reusing the bubble's existing reveal interaction and its
  text-selection guard.
- Recording player and transcript disclosure are unchanged in behavior; the
  `call_sid`-not-`id` rule for the recording URL is unchanged
  (`Timeline.tsx:734-745`).
- A `live: true` card schedules ONE `setTimeout` for exactly its flip moment
  (`90s - age`), then re-renders - no polling interval, and no timer at all on a
  settled card. Cleared on unmount.

### 7.3 EmailCard

Alignment only: `align-self` by direction, `max-width: 84%`. The outbound tint
already exists (`.emailOut`) and stays; the brand left-border, tag, subject,
snippet, disclosures, and delivery chip are untouched.

### 7.4 MilestonePin

Unchanged. It is `align-self: stretch` with rules either side
(`Timeline.module.css:355-372`), which is what makes "centered = system event"
legible against the new rule rather than looking like a fourth style.

`ScheduledCard` is also unchanged: scheduled rows live in the pinned `upcoming`
bucket and never enter the main stream (`Timeline.tsx:868-871`).

## 8. Non-goals

- **A status callback on the navigator's originate leg.** The durable fix for a
  never-accepted originate. Rejected for this mission (D6); filed as a follow-up
  (section 11). This spec's derivation is forward-compatible with it: once a real
  terminal status is written, `call_status` is no longer `ringing` and clause 3
  simply stops being reached, with nothing wrong ever having been persisted.
- **Answering Machine Detection** (D9).
- **Masked relay calls anywhere** (I5) - `docs/issues/masked-relay-calls-invisible.md`.
- **The inbox row preview for a never-accepted originate.** The preview is a
  stored string and the originate deliberately stamps nothing
  (`originateCall.ts:193-199`); a derivation-only change cannot and does not
  alter it. Unchanged from today.
- **Native group texts.** No call functionality exists there at all.
- **Any backfill** (I6).

## 9. Verification

Unit (app):

- `toTimelineCall` projects `direction` and `call_status`; drops an unknown
  `call_outcome` instead of casting it; normalizes `'no_answer'`/`'completed'`;
  falls back to `call_duration_seconds`; still strips everything I4 requires on
  a masked row.
- `/voice/status` stores "no answer" for an outbound Dial summary whose
  `DialCallStatus` is not `completed` EVEN THOUGH `answered_at` is set - the
  regression test for I1, and the one that would have caught the original bug.
- Inbound classification, the missed-bridge trigger, and the unread rule are
  byte-identical: assert on the existing tests, unmodified.

Unit (dashboard):

- `presentCallState` over the full matrix - both directions x every
  `call_status` x every `call_outcome` x fresh/stale - including the case the
  human raised explicitly: a row that reached `completed`/`answered` at 30
  seconds is still labelled Connected when evaluated at 200 seconds (I3).
- CallCard: alignment class by direction, arrow plus word, reveal line, no timer
  on a settled card.

E2E: extend `e2e/tests/dashboard-next/call-inbox-unread.spec.ts` or add a
sibling - an inbound and an outbound call in one thread land on opposite sides
and announce different labels, asserted with accessibility-first selectors per
`e2e/support/selectors.md`.

Gates, run bare from the feature worktree per AGENTS.md: `npm run typecheck`,
`npm test`, `npm run e2e`.

## 10. Accepted boundaries and risks

- **The 90-second threshold is coupled to Twilio's 60-second default ring.** If
  that default changes, or if a `timeout` is ever passed on the originate, the
  threshold must be revisited. D7 records the derivation so the coupling is
  visible; the constant carries a comment pointing at it.
- **The staleness flip uses the viewer's clock** against a server timestamp. A
  badly skewed client flips early or late. Cosmetic, self-correcting on the next
  real status, and bounded to rows with no terminal outcome.
- **"Connected" cannot distinguish a human from the target's voicemail** (I2,
  D9). This is a real limit on what the panel can tell an operator, and it is
  the same limit every consumer call log has.
- **Aligning emails moves every email card in the app.** Intended (D1), but it
  is the widest visual change here and the one most likely to draw comment.
- **A never-accepted originate reads correctly on the timeline and stays absent
  from the inbox row.** Two surfaces, two different truths, neither wrong.

## 11. Post-merge obligations

No infrastructure, no deploy-order dependency, no backfill, no index work.

Issue bookkeeping, in the same change:

- `docs/issues/outbound-call-outcome-answered-before-target-rings.md` -> resolved
  by 6.2, with a resolution note recording that `bridgeAccepted` was left intact
  and only the stored outbound outcome changed.
- New issue: a status callback on the navigator's originate leg, so a
  never-accepted originate resolves durably instead of by derivation. Record
  the scope from D6 so the next person does not re-derive it.
- New issue: Answering Machine Detection for outbound human-vs-voicemail (D9),
  carrying the per-call cost and latency question.
- `docs/issues/masked-relay-calls-invisible.md` stays open and untouched.
- Correct the inaccurate comment at `useRelayThread.ts:44-47` only if that file
  is touched; otherwise leave it to the masked-relay-calls issue.
