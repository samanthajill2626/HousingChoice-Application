# Comms panel: calls as first-class directional items - design spec

Date: 2026-08-18
Branch: `feat/comms-panel-call-direction`  Worktree: `W:\tmp\comms-panel-call-direction`
Base: `main` @08ec365c
Design review: spec R1 complete (2 reviewers, 34 findings, 23 distinct, 4
blocking); adjudications at `.superpowers/design-review/adjudications.md`.

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
(`voice.ts:613`), the masked relay bridge (`voice.ts:918`), the masked-relay
REFUSAL append (`voice.ts:843-858`), the outbound originate
(`originateCall.ts:176`), the Quo importer (`apply.ts:439`), the demo seed
(`seed/cast.ts:1062-1067`), and the dev fixture seam (`dev.ts:749`) - but the
server projection never copies it onto the wire (`contactTimeline.ts:432-449`),
and neither `TimelineCall` declaration has a field for it
(`contactTimeline.ts:179-195`, `dashboard/src/api/types.ts:2222-2238`). The one
other identifying value on the card, `party_phone`, is
`conversation.participant_phone`, which is the other party's number in both
directions and therefore never disambiguates.

What the operator sees today is not two identical rows - it is two DIFFERENTLY
wrong ones. The card's chip and tone come from `call_outcome` alone
(`Timeline.tsx:711-716`, `:729-731`), so an outbound call that rang out renders
a GREEN "Answered" (because that is what got stored - defect 1 below) while an
inbound miss renders a RED "Missed". Neither states direction; one asserts the
opposite of what happened.

Three data defects sit underneath and become conspicuous the moment direction is
visible:

- **Outbound outcome is wrong.** The whisper gate stamps `answered_at` on the
  navigator's OWN leg at press-1, before the target is dialed, so the terminal
  `<Dial action>` summary classifies every outbound call that reached a `<Dial>`
  as `answered` - including one nobody picked up (`voice.ts:1361-1382`,
  `docs/issues/outbound-call-outcome-answered-before-target-rings.md`). The
  correct value is already computed at `voice.ts:1432` for the inbox preview and
  deliberately not persisted.
- **A never-accepted originate is projected as a miss.** If the navigator never
  presses 1, no `<Dial>` runs, no Dial summary arrives, and the row keeps
  `call_status: 'ringing'` with no `call_outcome`. The projection's
  `call_outcome: (m.call_outcome ?? 'missed')` default (`contactTimeline.ts:439`)
  then manufactures a terminal answer out of absent data, and the card reads
  "Missed" - asserting the contact did not pick up a call that was never placed
  to them.
- **Imported calls render as garbage.** The Quo importer writes
  `call_outcome: 'no_answer' | 'completed'` (`apply.ts:448`), outside the
  `CallOutcome` union `'answered' | 'missed' | 'voicemail'`
  (`messagesRepo.ts:57`), and writes its duration to `call_duration_seconds`
  (`apply.ts:445`) where the live path uses `call_duration`
  (`messagesRepo.ts:909` declaration, `:1876` append, `:2194` update). The
  projection casts the unknown string through `as CallOutcome`, so the card
  prints "No_answer" or "Completed", colors both with the red miss class, and
  shows no duration at all.

## 2. Goal

One alignment rule for the whole panel, with calls carrying honest direction and
an honest outcome.

- Every communication takes a side by direction: inbound left, outbound right,
  for SMS/MMS, email, and calls alike.
- The item stream then has exactly three kinds and one reading: a bubble or a
  card takes a SIDE and is something a person said; a milestone pin is
  FULL-WIDTH with rules either side and is something the system recorded. This
  describes the three item kinds only - it is not a claim about every centered
  node in the stream, several of which (the day divider, the fallback note, the
  empty state) are centered chrome and stay exactly as they are.
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
  layout where the two columns nearly touch. The glyph itself is decorative and
  is `aria-hidden` - an unhidden U+2197 is announced as "north east arrow",
  which is the noise this decision exists to avoid.
- **D3 - Outcome vocabulary.** Inbound: "Answered", "Missed", "Voicemail".
  Outbound: "Connected" and "No answer". Plus three states that belong to
  neither side's outcome: "Ringing..." and "In progress" while a call is live,
  "Not completed" for a call the system refused to place (D12), and "Outcome
  unknown" for an outbound call we know was accepted and placed but whose result
  never came back (7.1 clause 4). "Connected" rather
  than "Answered" on outbound is deliberate and load-bearing - see I2. Duration
  is NOT part of the outcome label; it renders beside it (D4).
- **D4 - Duration stays on the face; only the phone number moves behind a
  reveal.** The card's summary line is arrow, direction word, outcome chip,
  duration, time. The party phone moves into a click-to-reveal detail line,
  because on a 1:1 thread it is always the same person. Revised at spec review
  R1 (F6): the original wording put duration behind the click too, which would
  have hidden a value the card shows today (`Timeline.tsx:717-723`) and made
  6.1 step 5's imported-duration fix invisible by default on every card it was
  written for.
- **D5 - The outbound outcome write is folded into this mission.** It is a
  different file (`voice.ts`) from the rest of the work, accepted explicitly by
  the human on the grounds that the fix is small, self-contained, and nobody is
  working that area elsewhere.
- **D6 - The never-accepted originate is handled READ-SIDE, by derivation, with
  no status-callback contract change.** The durable fix (a status callback on
  the navigator's leg) was scoped and rejected as disproportionate: it needs an
  `InitiateCallParams` contract change, a Twilio driver change, a fake-twilio
  change, a new arm in `/voice/status`, and a fourth `CallOutcome` value across
  both wire contracts. See section 8 and the follow-up in section 11. The
  derivation's soundness rests on I3 as REVISED - a bounded, self-correcting
  exposure, not an impossibility.
- **D7 - The `ringing` staleness threshold is 90 seconds.** Derived from the real
  bound, not chosen for roundness: `calls.create` passes no `timeout`
  (`adapters/messaging.ts:849-850`) so Twilio's 60-second default applies to
  ringing the navigator's cell, and the whisper `<Gather timeout: 8>`
  (`voice.ts:1063`) sits on top of it, for about 68 seconds before the outcome is
  genuinely settled. 90 clears that with slack for webhook latency. A 30-second
  threshold was considered and rejected for labelling a still-ringing phone as
  unanswered.
- **D8 - The label for a never-accepted originate is "No team answer".** It
  names whose line rang out, reuses "team" (already the product's word for our
  own side in the relay sender labels, `memberAttribution.ts:66`), and does not
  collide with "No answer", which on an outbound row describes the target. D12
  is what keeps this label true.
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
  handset call log does for a one-ring abandon. The convention runs out on the
  outbound side: a handset shows an unanswered outgoing call as an outgoing
  entry with no duration and no explanatory label, because the only person
  reading that log is the person who placed the call. A shared staff inbox has
  the opposite property - a teammate opening a tenant's timeline did not place
  the call and cannot infer what happened - so "No answer" (D3) and "No team
  answer" (D8) are a deliberate departure, covering a need the handset
  precedent never had.
- **D12 - The three gate refusal branches stamp a terminal status (human
  ruling, added at spec review R1).** Spec review found "No team answer"
  affirmatively FALSE on three shipped paths where the navigator answered and
  pressed 1 and the system then refused to dial: the DNC re-check
  (`voice.ts:1176-1184`, pinned by `voiceOutbound.test.ts:380-382`), the
  unresolved target/business number at the gate (`voice.ts:1161-1169`), and the
  unresolved target at the bridge TwiML (`voice.ts:1042-1051`). On the DNC path
  in particular the card would read as staff negligence when the truth is that
  the contact is opted out of voice. Rather than weaken the label to something
  non-attributive, each branch stamps a terminal `call_status` with NO
  `call_outcome`, which resolves to "Not completed" (D3) and never reaches the
  attributive clause. Chosen by the human over accepting and documenting the
  wrong attribution.

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

**I3 (REVISED at spec review R1) - a `ringing` mislabel is bounded to one call's
duration and self-corrects; it is NOT impossible.** The original spec asserted
that a live call is never in `ringing` because the whisper gate writes
`in-progress` + `answered_at` at press-1 before emitting the `<Dial>`. Review
found that write is explicitly BEST-EFFORT and swallows its own failure
(`voice.ts:1187-1199`, try/catch that logs a warn and continues; the `<Dial>` is
emitted regardless). So a connected outbound call CAN sit at `ringing` and be
labelled "No team answer" mid-conversation.

What is actually true, and what D6 now rests on:

- On the happy path the gate write lands and the row leaves `ringing` before the
  target is dialed, so the derivation never sees a live call.
- If that write fails, the mislabel lasts at most until the terminal Dial
  summary, which arrives seconds after the call ends and writes the CORRECT
  outcome - correct precisely because 6.2 derives it from `DialCallStatus`
  rather than from the `answered_at` that failed to write.
- The call-status machine is forward-only and nothing transitions INTO `ringing`
  (`ALLOWED_PRIOR_CALL_STATUS.ringing = []`, `messagesRepo.ts:71-73`), so a row
  that has left `ringing` can never re-enter the derived branch. A call that
  connects at second 40 and ends at second 70 is never relabelled at second 90.

The exposure is therefore one call's duration, self-correcting, never terminal,
and confined to a path that requires a DynamoDB write to have failed. That is a
sound basis for a derived label. "Cannot happen" was not.

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
enumerated in section 1, so every historical row already carries the field this
spec starts projecting. Checked against all seven writers, not asserted.

**I7 - Every masked call row is `direction: 'inbound'`.** The masked relay
bridge (`voice.ts:918`) and the masked refusal append (`voice.ts:847`) both
write inbound; there is no masked outbound writer. This is what makes 6.2's
outbound-only substitution inert on masked rows even where a guard is not
restated, and it is why `upgradeCallOutcomeToVoicemail` cannot be reached by the
new stored value (I8).

**I8 - The voicemail upgrade is direction-gated and stays that way.**
`upgradeCallOutcomeToVoicemail` writes conditionally on `call_outcome = 'missed'`
(`messagesRepo.ts:2406-2423`), and 6.2 introduces `'missed'` on outbound rows
where `'answered'` used to sit. The upgrade is gated `entry.call_outcome ===
'missed' && entry.direction !== 'outbound'` (`voice.ts:1607`), so the new value
is unreachable by it. The outbound bridge DOES record
(`voice.ts:1200-1209`), so the recording callback really does run on outbound
calls and this gate is what stands between them; it must not be relaxed.

## 5. Data model and wire contract

No DynamoDB schema change, no index change, no migration.

`TimelineCall` gains two fields and loses a lie. Both declarations change
identically and independently (`app/src/routes/contactTimeline.ts:179-195` and
`dashboard/src/api/types.ts:2222-2238` are hand-mirrored by convention, and
`Timeline.tsx` imports the dashboard one):

```
direction: MessageDirection;      // NEW - required; every stored row has it
call_status?: CallStatus;         // NEW - optional; absent on imported rows
call_outcome?: CallOutcome;       // WAS required; now optional
```

`call_outcome` becoming optional is the point: absent means "no terminal outcome
is known", which is a state the client must render honestly rather than a state
the server should invent. Dropping `?? 'missed'` is what makes D6 possible.

The dashboard has no `CallStatus` type today (`types.ts:1442` declares
`CallOutcome` only); add it mirroring `messagesRepo.ts:42-49`.

There is NO cross-package shape test pinning the two declarations together -
each side's own `tsc` is the only check, and it cannot see a divergence between
two independently declared types (R2 finding 6; none was found in the repo). This
matters more than usual here because `direction` becomes REQUIRED on both sides:
a projection that omits it type-checks clean on the server and fails only at
runtime in the browser. The plan must add an explicit assertion that the
projection's emitted shape carries every field the dashboard declares required.

`call_duration_seconds` (the importer's duration field, `apply.ts:445`) is NOT
declared on `MessageItem` - `messagesRepo.ts:909` declares `call_duration` only,
and the importer's value is reachable solely through the interface's index
signature (`messagesRepo.ts:981`). 6.1 step 5 therefore needs an explicit
runtime narrow, not a property read.

## 6. Server design

### 6.1 Projection (`app/src/routes/contactTimeline.ts`, `toTimelineCall`)

1. Copy `direction: m.direction` onto the wire.
2. Copy `call_status` when present and a member of the `CallStatus` union.
3. Delete the `?? 'missed'` default. Emit `call_outcome` only when the stored
   value is a MEMBER of the union - an unrecognized string is dropped, never
   cast through `as CallOutcome`.
4. Normalize the two imported outcome strings before that membership test
   (D10): `'no_answer' -> 'missed'`, `'completed' -> 'answered'`. Anything else
   unrecognized is dropped, which renders as a call with a direction and a time
   and no outcome chip - honest, and better than today's red "Completed".
5. Fall back to `call_duration_seconds` when `call_duration` is absent (D10), via
   an index-signature read with a `typeof === 'number'` narrow (section 5), so
   imported calls show their duration.

Steps 2-5 are a small shared helper next to the projection rather than inline
ternaries, so the normalization has one home and its own unit test.

Note the inbox's `deriveLatest` (`inbox.ts:518-527`) already implements step 3's
membership test on the same fields, but not steps 4-5. That divergence is
declared and scoped out - section 8.

### 6.2 Outbound outcome write (`app/src/routes/webhooks/voice.ts`, `/status`)

The correct outbound values are already computed at `voice.ts:1432-1433`, below
the `updateCallStatus` write at `:1384`, and used only for the inbox preview
string. Hoist that computation above the write.

**The hoist is gated, and the gate is the whole design** (spec review R1, F3):
the substitution applies ONLY when

```
isDialSummary && terminal && entry?.type === 'call'
  && entry?.masked !== true && entry?.direction === 'outbound'
```

Each conjunct is load-bearing - including `type === 'call'`, which the R1 draft
dropped from the guard it was copying (`voice.ts:1430`) in a passage whose whole
thesis is that every conjunct matters (R2 finding 9):

- `terminal` - without it the formula is evaluated on a non-terminal `in-progress`
  Dial summary, where `mapped !== 'completed'` yields `'missed'` for a call that
  just bridged. Today's code writes `'answered'` there (`voice.ts:1376-1377`).
  The forward-only ConditionExpression usually masks this, but NOT when the
  gate's best-effort write failed (I3) - the row is still `ringing`, the
  transition succeeds, and a live connected call is stored `'missed'`.
- `entry?.direction === 'outbound'` - `entry` is fetched only under
  `if (isDialSummary && terminal)` (`voice.ts:1361-1364`), which is exactly this
  gate, so NO new read is required; the original spec simply failed to say it.
  When `entry` is undefined (unknown CallSid) the write falls through to today's
  behavior unchanged.
- `masked !== true` - the computation's current site sits inside this guard
  (`voice.ts:1430`) and hoisting must carry it. Inert today by I7, restated so a
  future masked outbound writer does not silently inherit the new rule.

Under that gate, `updateCallStatus` persists `previewOutcome` / `previewDuration`
instead of the `bridgeAccepted`-derived pair. Inbound is byte-identical to today.

Deliberately unchanged, each with the reason it is safe:

- `bridgeAccepted` keeps its meaning and its inbound uses.
- `stampAnsweredAt` still stamps at the in-progress transition, so a live
  outbound call still reads in-progress mid-call.
- `isMissed` and the missed-founder-bridge trigger are untouched; that path is
  already gated `direction !== 'outbound'` (`voice.ts:1466`).
- The unread rule is untouched; already gated to inbound (`voice.ts:1444`).
- The inbox preview string keeps reading the same values it reads today.
- `upgradeCallOutcomeToVoicemail` (`messagesRepo.ts:2406-2423`) and the
  recording-callback voicemail gate (`voice.ts:1607`) both read the stored
  outcome and are unreachable by the new value - see I8.

**Named divergence** (spec review R1, F21): after this change a rung-out outbound
call stores `call_outcome: 'missed'` while the same handler invocation computes
`isMissed === false` (because `answered_at` is set). Both consumers of `isMissed`
are direction-gated so nothing changes behaviorally, but the two notions of
"missed" now disagree inside one function. A code comment at the divergence is
required so the next reader of `isMissed` on an outbound path does not inherit a
trap.

### 6.3 Gate refusal stamps (D12)

Three branches hang up without dialing and without writing anything, leaving the
row `ringing` forever. They are NOT all post-press-1, and the difference matters
for what the label may claim (R2 finding 10):

- `voice.ts:1176-1184` - DNC re-check (`target.optedOut`). After press-1.
- `voice.ts:1161-1169` - target or business caller ID unresolved at the gate.
  After press-1.
- `voice.ts:1042-1051` - target unresolved in the outbound-bridge TwiML. This
  runs when the navigator's leg ANSWERS, BEFORE the whisper is emitted and
  therefore before any press-1. "Answered" here is also not proof of a human -
  it may be the navigator's own carrier voicemail picking up. "Not completed"
  is the right label on all three precisely because it claims nothing about who
  answered what.

Each stamps a terminal `call_status: 'canceled'` with NO `call_outcome`, on the
parent CallSid, immediately before its `vr.hangup()`. `canceled` is already in
the union (`messagesRepo.ts:42-49`) and is reachable from `ringing` under the
forward-only machine. Requirements:

- BEST-EFFORT, in the same swallowing try/catch shape as the gate's existing
  write (`voice.ts:1187-1199`): a stamp failure must never break the hangup.
- Guarded on `parentCallSid.length > 0`, exactly as the write it is modeled on
  is (`voice.ts:1187`) - the gate reads that value off the query string and it
  can be empty (R2 finding 11).
- The `/outbound-bridge` branch must tolerate the row not existing yet: it is
  keyed by the ORIGINATE's CallSid, which `originateCall` appends best-effort
  and may have failed to write (`originateCall.ts:207-212`). A stamp against a
  missing row is a no-op, not an error, and must not be treated as one.
- No `call_outcome`, deliberately. We know the call did not complete; we do not
  know an outcome, and inventing one is the defect this whole spec exists to
  remove. Terminal-status-with-no-outcome is what 7.1 clause 2 renders as "Not
  completed".
- The DNC branch keeps logging IDs only (`voice.ts:1178-1181`); the stamp adds
  no PII.

### 6.4 Keeping the inbox row unchanged under D12 (R3 finding 1)

D12 is not derivation-only: it changes stored `call_status` from `ringing` to
`canceled`, and `deriveLatest` branches on that exact value. Its derive arm is
`channel === 'call' && callStatus !== undefined && (callStatus === 'ringing' ||
fallbackPreview === '')` (`inbox.ts:518-527`). Two cases, and the R2 analysis
only checked one of them:

- **No stored preview** (`fallbackPreview === ''`): the derive arm fires either
  way, and `callPreview` (`callPreview.ts:35-47`) returns the same "Outgoing
  call" base for `ringing` and for `canceled` - neither matches its voicemail,
  ringing, in-progress, missed or answered arms. Unchanged, as R2 concluded.
- **A stored preview exists** - the ordinary case, because any prior text on the
  thread leaves one. Today `callStatus === 'ringing'` satisfies the first
  disjunct, so the row derives "Outgoing call". After D12 stamps `canceled`,
  NEITHER disjunct holds, the derive arm stops firing, and the inbox row falls
  back to the previous TEXT's body - a stale, unrelated message presented as the
  thread's latest. That is a regression, and section 8's non-goal would have
  been false.

REQUIRED companion change: extend the derive arm's first disjunct to
`callStatus === 'ringing' || (callStatus === 'canceled' && callOutcome ===
undefined)`, so a D12-stamped row derives exactly as it does today.

The second conjunct is load-bearing, not decoration (R4 finding 1). A BARE
`canceled` disjunct would also capture `canceled` rows that DO carry an outcome -
a state reachable today when `stampCallActivity` fails and swallows it
(`voice.ts:389-406`, which logs "call row persisted, inbox stale"). Those rows
currently show their stored preview and would start deriving instead, which is a
behavior change to calls this mission has nothing to do with. Pairing
status-with-no-outcome is the same signature clause 2 uses, and for the same
reason: it is what identifies a D12 stamp specifically.

This preserves behavior rather than changing it - the resulting string is
identical - and it matches the arm's evident intent, which is to derive whenever
the row has no terminal outcome of its own to describe. It is the one inbox-side
edit this mission makes, and it exists solely to keep section 8's promise true.

Masked rows are out of scope for this change entirely: `deriveLatest`'s contact
row source excludes `relay_group` and `group_text` (`inbox.ts:777-784`), so no
masked call can reach it. Checked, not assumed.

Both cases get a test (section 9). The no-stored-preview equivalence in
particular holds by base-case fallthrough in `callPreview`, not by design, so it
is pinned rather than inherited.

## 7. Client design

### 7.1 A pure presenter, extracted

The label decision is a pure function in its own module, not logic buried in
JSX - it has the most cases of anything here and must be unit-testable without
rendering:

```
presentCallState({ direction, callStatus, callOutcome, at, now })
  -> { label?: string, tone?: 'success' | 'danger' | 'warning' | 'neutral', staleAt?: number }
```

The presenter's inputs are named in camelCase and the wire contract is
snake_case (section 5); the CallCard does that mapping at the call site, which
is the only place the two vocabularies meet (R2 finding 13).

`staleAt` replaces the original `live: boolean` (spec review R1, F1). It is the
epoch instant at which THIS label stops being the right one, and it is set only
by the two age-bounded clauses. A clause that returns no `staleAt` gets no timer
at all. The original `live` flag meant two different things in two clauses and
would have produced a negative-delay timer that re-fired forever on any call
past 90 seconds; keying the timer on an explicit instant makes that spin
unrepresentable rather than merely avoided.

The flip needs a re-render, and R1's rewrite dropped it (R2 finding 5). The
mechanism, stated so it cannot be improvised: the card holds `now` in state,
seeded from `Date.now()` at mount. When the presenter returns a `staleAt`, the
card sets exactly one `setTimeout` whose callback writes a fresh `Date.now()`
into that state; the re-render re-runs the presenter, which now takes the stale
branch and returns no `staleAt`, so no further timer is scheduled. The timeout is
cleared on unmount and re-established only when `staleAt` changes.

Three constraints on that timer, each closing a way the spin comes back:

- The DELAY is computed from a fresh `Date.now()` read at SCHEDULE time, never
  from the `now` held in state (R3 finding 7). State `now` only advances at
  mount and on its own timeout, so a props-driven re-render in between would
  otherwise schedule against a stale clock and fire early.
- The delay is CLAMPED to `setTimeout`'s 32-bit range (R3 finding 8): a delay
  above 2^31-1 ms fires immediately rather than late, so "strictly in the
  future" is not on its own a sufficient spin guard. Above the ceiling, schedule
  nothing - the label is not going to change within 24 days of anyone looking.
- When `staleAt` is at or before the fresh read, the effect does NOT simply
  schedule nothing - it advances state `now` to the fresh read immediately (R4
  finding 4). Skipping the schedule would strand the card on the fresh label
  with no correction path, because state `now` otherwise only advances when a
  timer fires. The immediate advance re-renders into the stale branch, which
  returns no `staleAt`, and the effect settles.

Every clause must still return either no `staleAt` or one strictly in the
future; section 9 asserts it directly.

Note the card is keyed by `item.id` (`Timeline.tsx:1371`), so a different row
remounts rather than reusing state - the mount-seeded `now` is safe against a
prop swap, and R3 checked this negative explicitly. Paging older history in does
remount a cluster of cards, which is harmless but is what the mount seeding
relies on.

`age` is `now - at` when `at` parses to an instant, and UNDEFINED otherwise -
`atOf` can return a non-instant (`contactTimeline.ts:362-365`) and the codebase
already treats an empty `at` as a real case (`buildTimelineFallback.ts:100-106`,
`useRelayThread.ts:41`). Clauses 3 and 4 require a DEFINED age; an undefined age
falls through them to the outcome clauses, which for a row with no outcome means
no chip. Explicitly no age-based claim from an unparseable timestamp.

Resolution order, each clause the ELSE of the one before:

1. `callOutcome === 'voicemail'` -> "Voicemail" (warning). Wins over any status.
2. `callStatus === 'canceled'` AND `callOutcome` is absent -> "Not completed"
   (neutral). Keyed to `canceled` SPECIFICALLY, not to terminality in general
   (R2 finding 4): the dev transcript seam appends a call with terminal
   `callStatus: 'completed'` and no outcome (`dev.ts:745-757`) before attaching a
   full transcript, so a terminality-keyed clause would have rendered a fully
   transcribed call "Not completed" and failed the transcription e2e.

   The reason this is SAFE is not that 6.3 is the only writer of `canceled` -
   it is not. `mapCallStatus` maps Twilio's own `canceled`
   (`voice.ts:199-200`) and `/status` can write it (R3 finding 4). The clause is
   safe because every `/status` terminal write pairs a status WITH an outcome
   (`voice.ts:1376-1392`), so a Twilio-originated `canceled` never satisfies the
   second conjunct. 6.3 is precisely the code that breaks that pairing, on
   purpose, which is what makes status-plus-no-outcome a reliable signature for
   it. Anything that later writes a terminal status without an outcome will land
   in this clause, and that coupling is stated here so it is not rediscovered.
3. `callStatus === 'ringing'` and age is defined:
   - `age < 90s` -> "Ringing..." (neutral), `staleAt = at + 90s`
   - else -> outbound "No team answer" (danger); inbound "Missed" (danger)
4. `callStatus === 'in-progress'` and age is defined:
   - `age < 15min` -> "In progress" (neutral), `staleAt = at + 15min`
   - else, INBOUND -> "Answered" (success), no duration rendered
   - else, OUTBOUND -> "Outcome unknown" (neutral), no duration. See below; the
     asymmetry is I1. NOT "no chip" (R3 finding 6): an accepted, placed call
     whose result we never learned is a different thing from a row carrying no
     information at all, and collapsing it into clause 7 would render the two
     identically. "Outcome unknown" claims nothing about the target while still
     telling the operator the call went out.
5. `callOutcome === 'answered'` -> outbound "Connected" (success); inbound
   "Answered" (success)
6. `callOutcome === 'missed'` -> outbound "No answer" (danger); inbound "Missed"
   (danger)
7. Nothing known -> no label, no chip (the card still renders direction and
   time).

Clause 4 is where R1's sharpest finding and R2's blocking finding meet, and the
history matters because the obvious answer is wrong twice over.

R1 (F2) killed the original clause, which returned a live "In progress" forever.
The inbox had already refused to derive that state, in writing: "nothing but a
Dial summary moves a call off it, so a call that ends without one would assert a
LIVE call forever" (`inbox.ts:508-517`, mapping in-progress down to ringing at
`:523`). Extending the 90-second rule was not the answer either - a real call can
legitimately run an hour.

The R1 remedy was to lean on press-1 as proof the bridge connected, and R2 found
that this is FALSE ON OUTBOUND and reinstated section 1's defect 1 on the read
side. On the inbound founder bridge the gate runs on the DIALED callee leg, so
press-1 means a human accepted and, with `answerOnBridge`, that the caller is
connected. On the outbound originate the gate runs on the NAVIGATOR's own leg
and press-1 is what CAUSES the target to be dialed (`voice.ts:1187-1212`) - it
proves only that Sam picked up her own phone. Deriving "Connected" from it is
exactly the inference I1 forbids, and unlike the stored-outcome version it would
never self-correct, because this clause exists precisely for rows whose Dial
summary never arrives.

So the asymmetry is not a special case, it is I1 applied to the read side:

- INBOUND stale in-progress: the bridge is proven, the ending is not. "Answered"
  with no duration is the true terminal claim.
- OUTBOUND stale in-progress: only the navigator's acceptance is proven. We do
  not know whether the target ever answered, so the chip claims nothing about
  them - "Outcome unknown". That is everything the data supports, and it stays
  distinguishable from a row we know nothing about at all.

Clause 3's inbound arm changes today's behavior for the first 90 seconds and
this is deliberate (F9): today's `?? 'missed'` fires on read, so an abandoned
inbound call says "Missed" immediately; it will now say "Ringing..." for 90
seconds first. It genuinely was ringing. D11's handset argument is about the
TERMINAL label and is unaffected.

Clause 3's outbound arm covers two sub-cases that are not distinguished, on
purpose: the navigator's cell was never answered, and the navigator answered but
never pressed 1 (a timeout or any non-accept key, `voice.ts:1252`). "No team
answer" is true of both. The three paths where it would have been FALSE are
removed by D12/6.3, not by the label.

### 7.2 CallCard

- Aligned by direction with an alignment-ONLY class (7.5), sized
  `max-width: 84%` with a `min-width` floor. This reverses the R1 remedy after
  R2 contested it (R1 F13 vs R2 finding 3), and the contest is worth recording
  because both remedies are individually correct. `.day` is a flex column
  (`Timeline.module.css:164-168`), so an aligned child loses `stretch` and sizes
  to content: R1 objected that a two-line call card becomes a narrow stub that
  resizes when the recording player or a disclosure mounts. R2 objected that the
  fixed-width alternative reduces the entire direction signal to a 16% offset
  while the bubbles beside it shrink to content - which does not deliver section
  2's "every communication takes a side" for the two item kinds this spec exists
  to change. The guarantee outranks the cosmetic defect: content sizing wins,
  the `min-width` floor removes the sliver case, and disclosure-driven resize is
  accepted (a bubble already grows the same way when media loads). The floor is
  `min-width: 40%`, chosen so the shortest possible summary line - arrow,
  "Outgoing call", a two-word chip, a time - still reads as a card rather than a
  chip, and so the two directions remain visibly offset from each other. Named
  with a value because 7.5's stated job is to leave no CSS to improvisation (R3
  finding 10).
- Summary line, in order: arrow glyph (`aria-hidden`, D2), "Incoming call" /
  "Outgoing call", the outcome chip from 7.1, the duration whenever one is
  present, then the time. No permission signal is needed from the presenter (R4
  finding 5): the only clauses that would want duration suppressed - the stale
  in-progress arms - describe rows that never carried one in the first place.
  Note both `.status` (`:311-314`) and
  `.callTime` (`:459-463`) currently claim `margin-left: auto`; the new line
  needs its own layout rather than inheriting that fight.
- The card carries `role="group"` and an `aria-label` built from the direction
  word and the time ONLY - never the outcome label (R2 finding 12). An outcome
  in the accessible name would flip with clauses 3 and 4, so the e2e handle
  would inherit exactly the staleness race it was introduced to escape. The
  outcome stays assertable as the chip's own text, separately.
- Outbound call cards carry the same faint tint the outbound email card already
  uses (`.emailOut`), so the two card kinds encode direction identically. Stated
  here rather than left in the stylesheet (R2 finding 7): it is a third
  reinforcement of direction alongside position and the word, and it belongs to
  D1's cohesion goal, not to a builder's discretion.
- Party phone moves to a click-to-reveal detail line reading "to/from <formatted
  number> - <time>". On a MASKED row there is no counterpart identity to show -
  `party_phone` is stripped (`contactTimeline.ts:431`) and `call_party_label` is
  not on the wire contract - so the line degrades to the time alone (F18).
- The reveal is a dedicated `<button>` control, NOT a click handler on the card
  surface (F17). The existing bubble precedent is a bare `<div onClick>` with no
  role, tabIndex, or key handler (`Timeline.tsx:566-575`); copying it would
  double an a11y gap on a change that argues from a11y. Making the CARD a button
  is also refused - it contains an audio player and a `<details>`, and a button
  may not contain interactive descendants.
- Recording player and transcript disclosure are unchanged in behavior; the
  `call_sid`-not-`id` rule for the recording URL is unchanged
  (`Timeline.tsx:734-745`).
- Timer: exactly as specified by 7.1's three constraints - delay from a FRESH
  `Date.now()` read at schedule time (never from state `now`), clamped to the
  32-bit range, and an immediate state advance instead of a schedule when
  `staleAt` has already passed. Cleared on unmount. No polling interval, and no
  timer on a settled card. This bullet previously restated the formula as
  `staleAt - now`, which is the stale-clock bug 7.1 forbids (R4 finding 2);
  there is ONE timer rule and it lives in 7.1.

### 7.3 EmailCard

Alignment only: the same alignment-only class by direction, and the SAME sizing
change as the call card - `max-width: 84%` with the `min-width` floor, replacing
`width: 84%` (R3 finding 2; the R2 sizing reversal updated 7.2 and 7.5 and
missed this section, leaving a contradiction that would have restored the 16%
offset for emails and re-created exactly the two-rules defect D1 exists to
remove). The outbound tint already exists (`.emailOut`) and stays; the
brand left-border, tag, subject, snippet, disclosures, and delivery chip are
untouched.

### 7.4 MilestonePin

Unchanged. It is `align-self: stretch` with rules either side
(`Timeline.module.css:355-372`) - full-width, not centered - which is what makes
section 2's three-item-kind reading legible rather than a fourth style.

`ScheduledCard` is also unchanged: scheduled rows live in the pinned `upcoming`
bucket and never enter the main stream (`Timeline.tsx:868-871`).

### 7.5 CSS: what is new and what is NOT reused

This is called out because the obvious reuse is a trap (F7). NONE of
`.bubble`, `.in`, `.out`, `.revealed`, or `.metaText` may be reused:

- `.in` / `.out` (`Timeline.module.css:222-232`) carry `background` and `border`
  alongside `align-self`. Applying them to a card repaints it as a chat bubble
  and fights `.emailIn`/`.emailOut`.
- The reveal is a DESCENDANT selector rooted on `.bubble`:
  `.bubble.revealed .metaText` (`:296-305`). A card applying `.metaText` without
  `.bubble` renders the detail line `display: none` FOREVER - a silently dead
  feature. Adding `.bubble` to fix it drags in `max-width: 80%`, the bubble
  padding, `cursor: pointer`, and the hover lift.

New work, named so the builder does not improvise: two alignment-only classes
(`align-self` and nothing else), a card-scoped reveal selector, an outbound tint
for the call card mirroring `.emailOut` (7.2), and the summary-line layout.
`.callcard` and `.emailCard` each drop `align-self: center` and replace
`width: 84%` with `max-width: 84%` plus a `min-width` floor (7.2).

### 7.6 Timeline consumers reached by this change

`Timeline` has five consumers: `ContactCommsPane.tsx:319-321`,
`ConversationDetail.tsx:482`, `GroupTextView.tsx:450`,
`PlacementConversation.tsx:322`, `TourConversation.tsx:469`. The four non-contact
consumers feed items through `useRelayThread`/`useGroupThread`, whose mapper
drops BOTH calls and emails (`useRelayThread.ts:49`), so the visual change lands
on the contact comms pane only - including where that pane is embedded in the
tour and placement hubs.

`buildTimelineFallback` is a SECOND email-card producer on the same page (the
server-timeline-down path). It drops calls (`:36`) and keeps emails (`:40-62`),
and it DOES carry `direction` (`:44`, `:70`), so email alignment behaves
identically on both paths. Verified rather than assumed.

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
  (`originateCall.ts:193-199`). This holds ONLY because of the companion change
  in 6.4; without it D12 would silently change the inbox row. See 6.4.
- **Reconciling the inbox's call vocabulary with the timeline's.** `callPreview`
  (`callPreview.ts:34-48`) says "Outgoing call - no answer" and "Outgoing call -
  42s" where the timeline will say "No answer" and "Connected" beside a
  duration. The surfaces differ on purpose: the inbox row is one line of prose
  with no chip and no card, the timeline has both. Declared here so the
  divergence is not read later as an accident (F8).
- **Extending 6.1's import normalization to the inbox.** `deriveLatest`
  (`inbox.ts:518-527`) implements the membership test but not steps 4-5, so an
  imported Quo call will read "Connected - 4m 12s" on the timeline and stay
  blank-or-stored in the inbox. Sharing the helper would change inbox previews
  for every historical imported row - a second read surface with its own
  precedence rules and tests, none of it needed to deliver this panel. Declared
  and filed (section 11) rather than folded in (F22).
- **Native group texts.** No call functionality exists there at all.
- **Any backfill** (I6).

## 9. Verification

Unit (app):

- `toTimelineCall` projects `direction` and `call_status`; drops an unknown
  `call_outcome` instead of casting it; normalizes `'no_answer'`/`'completed'`;
  falls back to `call_duration_seconds` through the narrow; still strips
  everything I4 requires on a masked row
  (`app/test/contactTimeline.test.ts:315-362` already drives a masked row
  through the mapper).
- `/voice/status` stores "no answer" for an outbound TERMINAL Dial summary whose
  `DialCallStatus` is not `completed` EVEN THOUGH `answered_at` is set - the
  regression test for I1, and the one that would have caught the original bug.
  No existing test covers press-1 + `no-answer`; this is that gap.
- `/voice/status` does NOT write an outcome on a non-terminal in-progress Dial
  summary for an outbound row - the F3 regression, including the case where the
  gate's best-effort write failed and the row is still `ringing`.
- The three D12 stamps: each refusal branch leaves a terminal `call_status` and
  no `call_outcome`, and a stamp failure does not break the hangup.
  `voiceOutbound.test.ts:380-382` currently asserts `call_status === 'ringing'`
  after the DNC path and must be re-pinned to the new terminal value.
- 6.4's derive arm (R4 finding 6 - the mission's only inbox-side edit, and the
  subject of a finding that was wrong three rounds running, so it gets explicit
  coverage rather than a design-section promise): a D12-stamped row WITH a
  stored preview derives "Outgoing call" exactly as the `ringing` row did
  before; the same row with no stored preview is unchanged; and a `canceled` row
  that DOES carry an outcome still shows its stored preview and does NOT derive.
  That last case is the one the bare disjunct would have broken.
- Inbound classification, the missed-bridge trigger, and the unread rule are
  byte-identical: assert on the existing tests, unmodified.
  `voiceOutbound.test.ts:391-409` (press-1 + `completed` -> `answered`) and
  `:428-455` (no press-1 + `no-answer` -> `missed`) both survive 6.2 unchanged.

Unit (dashboard):

- `presentCallState` over the full matrix - both directions x every
  `callStatus` x every `callOutcome` x fresh/stale - plus the two cases the
  matrix axes do not cover: an unparseable `at` (falls through clauses 3-4), and
  the human's own case, a row that reached `answered` at 30 seconds and is
  evaluated at 200 seconds (still "Connected", never relabelled - I3).
- Every returned `staleAt` is in the future or absent; no clause returns a
  `staleAt` in the past.
- The three timer constraints, at the CARD level, because the presenter-level
  assertion above is satisfied by construction and would pass on a card that
  schedules against a stale clock (R4 finding 3): the scheduled delay is
  computed from a clock read AFTER a props-driven re-render, not from the mount
  seed; a `staleAt` beyond the 32-bit ceiling schedules nothing rather than
  firing immediately; and a `staleAt` already in the past advances state
  immediately and settles on the stale label rather than stranding the fresh
  one. Fake timers, asserting the scheduled delay and the settled label.
- CallCard: alignment class by direction, arrow plus word, duration on the face,
  role and accessible name, and the reveal asserted with `toBeVisible()` AFTER a
  click - not `getByText`, which matches `display: none` nodes and would pass on
  the dead-feature build 7.5 describes.
- No timer is scheduled on a settled card.

Fixture sweep (named as work, F16): making `direction` required and
`call_outcome` optional breaks seven existing call fixtures
(`Timeline.test.tsx:55, 122, 132, 143, 164, 198, 229`;
`resolveConversation.test.ts:34-38`), and `Timeline.tsx:730`'s
`call.call_outcome.charAt(0)` becomes a runtime TypeError on any row without an
outcome. The projection and card changes must land in ONE commit.

E2E: extend `e2e/tests/dashboard-next/call-inbox-unread.spec.ts` or add a
sibling - an inbound and an outbound call in one thread, asserted in two parts
because the accessible name deliberately no longer carries the outcome (R3
finding 5, following from 7.2): locate each card by role and accessible name,
which carry the DIRECTION and are stable; then assert the outcome as the chip's
own text WITHIN that located card. Selector discipline per
`e2e/support/selectors.md`.

Existing e2e text assertions survive only CONDITIONALLY, and the condition is
new (R2 finding 8). `call-inbox-unread.spec.ts:256` asserts 'Missed' on an
inbound row with no precondition tying it to the Dial summary having landed;
under clause 3 that row now reads "Ringing..." for its first 90 seconds, so the
assertion becomes a race that passes or fails on harness timing. It must be
given an explicit precondition - drive the terminal summary, then assert - which
is a change to an existing spec, not a survival. `voice-transcription.spec.ts:189`
('Voicemail', inbound) is unaffected: clause 1 wins over any status.

Gates, run bare from the feature worktree per AGENTS.md: `npm run typecheck`,
`npm test`, `npm run e2e`.

## 10. Accepted boundaries and risks

- **The 90-second threshold is coupled to Twilio's 60-second default ring.** If
  that default changes, or if a `timeout` is ever passed on the originate, the
  threshold must be revisited. D7 records the derivation so the coupling is
  visible; the constant carries a comment pointing at it. The 15-minute
  in-progress bound is not coupled to anything external; what it degrades to is
  covered separately below.
- **The staleness flip uses the viewer's clock** against a server timestamp. A
  badly skewed client flips early or late. Cosmetic, self-correcting on the next
  real status, and bounded to rows with no terminal outcome.
- **A gate-write failure can mislabel a live outbound call** for the duration of
  that call (I3). Requires a DynamoDB write to have failed; self-corrects at the
  terminal summary.
- **A failed D12 stamp is PERMANENT, unlike a failed gate write** (R3 finding
  3). 6.3's stamps are best-effort by necessity - they must never break the
  hangup - but the three paths they cover are exactly the paths where no Dial
  summary ever arrives, so there is no later write to correct them. A dropped
  stamp leaves the row at `ringing` and the card reads "No team answer" forever,
  which is the false attribution D12 exists to prevent. Accepted rather than
  fixed: making the stamp blocking would trade a rare wrong label for a broken
  call, and the derived label is still no worse than what ships today. The
  stamps log their own failure, so the condition is at least visible.
- **The 15-minute in-progress bound degrades differently by direction.**
  Inbound degrades to "Answered", true whether or not the call is still running.
  Outbound degrades to "Outcome unknown", which is also true either way but
  carries less information than the live label it replaces (R3 finding 6). Both
  are honest; neither is a claim about the target.
- **"Connected" cannot distinguish a human from the target's voicemail** (I2,
  D9). This is a real limit on what the panel can tell an operator, and it is
  the same limit every consumer call log has.
- **Imported outcomes inherit Quo's own guess** (F23). `apply.ts:448` derives the
  outcome purely from `durationSeconds === 0`, which is the same
  duration-implies-answered inference the codebase documents as the 2026-06-15
  carrier-voicemail bug (`voice.ts:1348-1358`) and which I2 refuses on the live
  path. Carried through as PROVENANCE, not re-derived by us. Outbound imported
  rows land on "Connected", already the weaker claim; inbound imported rows
  inherit the guess, and that is accepted.
- **Aligning emails touches one surface, not the app.** Corrected at R1 (F14):
  four of the five `Timeline` consumers cannot render an email at all (7.6). The
  original spec ranked this the widest visual change; it is not.
- **Two declared timeline/inbox divergences, each with a reason** (section 8):
  the two surfaces use different call vocabularies on purpose, and an imported
  call reads richer on the timeline than in the inbox. The never-accepted
  originate is NOT a third - 6.4 keeps the inbox row exactly as it is today, so
  that one is preserved behavior rather than a divergence (R4 finding 7).

## 11. Post-merge obligations

No infrastructure, no deploy-order dependency, no backfill, no index work.

Issue bookkeeping, in the same change:

- `docs/issues/outbound-call-outcome-answered-before-target-rings.md` -> resolved
  by 6.2, with a resolution note recording that `bridgeAccepted` was left intact,
  only the stored outbound outcome changed, and the substitution is gated to a
  terminal outbound Dial summary.
- New issue: a status callback on the navigator's originate leg, so a
  never-accepted originate resolves durably instead of by derivation. Record
  the scope from D6 so the next person does not re-derive it.
- New issue: Answering Machine Detection for outbound human-vs-voicemail (D9),
  carrying the per-call cost and latency question.
- New issue: the inbox's `deriveLatest` does not normalize imported call
  outcomes or read `call_duration_seconds`, so imported calls read richer on the
  timeline than in the inbox (F22).
- `docs/issues/voice-bridge-dnc-recheck.md` - note that the DNC branch now
  stamps a terminal status (D12/6.3); the underlying re-check behavior is
  unchanged.
- `docs/issues/masked-relay-calls-invisible.md` stays open and untouched.
- Correct the inaccurate comment at `useRelayThread.ts:44-47` only if that file
  is touched; otherwise leave it to the masked-relay-calls issue.
