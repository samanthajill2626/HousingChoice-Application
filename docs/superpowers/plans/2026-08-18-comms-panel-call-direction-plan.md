<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-21).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Comms panel: calls as first-class directional items - implementation plan

Date: 2026-08-18
Spec: `docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md` @6397b829
Branch: `feat/comms-panel-call-direction`  Worktree: `W:\tmp\comms-panel-call-direction`
Base: `main` @08ec365c
Spec review: R1-R4, terminal at R4. Plan review: R1 (2 reviewers, 24 findings,
2 blocking) folded in. Adjudications at
`.superpowers/design-review/adjudications.md`.

Read the spec first. This plan does not restate its reasoning; it says what to
do, in what order, and how each step is proved. Decision ids (D1-D12) and
invariant ids (I1-I8) cite the spec - if a step looks pointless, that citation
is where to look before dropping it.

## 0. Ground rules for the builder

- TDD throughout: write the failing test, watch it fail for the RIGHT reason,
  then make it pass. Where a step genuinely cannot have a red state, this plan
  says so and calls it a characterization test instead of pretending.
- Commit per slice, explicit paths only, never `git add -A`. Bare `git status`
  before every commit. `Co-Authored-By` trailer naming the authoring model.
- New/touched lines in tests, comments and strings are ASCII-only. **The two
  direction glyphs are the one place this bites**: write them as the escapes
  `'\u2199'` (inbound, down-left) and `'\u2197'` (outbound, up-right), never as
  literal characters. The ASCII rule and D2 are both satisfied that way; a
  builder who "fixes" the ASCII violation by dropping the glyph has broken D2
  (plan review A4).
- Gates run BARE from this worktree, never piped: `npm run typecheck`,
  `npm test`, `npm run e2e`.
- Do not run a full e2e suite and an interactive e2e session from this worktree
  at the same time.
- Known flakes get one re-run before being blamed on this change, both runs
  reported: `tour-reminders-panel-e2e-flake`,
  `conversationdetail-members-mock-suite-flake`.

## 1. Slice order, and why it is this order

Every slice must leave the tree GREEN and the app CORRECT. The first version of
this plan satisfied the first and failed the second, and plan review killed it:
the derived labels went live several slices before the writes that make them
true, so a refusal-path call would have read "No team answer" - the exact false
attribution D12 exists to prevent - for three commits (plan review B3, A1).

The fix is to land every SERVER-side truth first, while the old card is still
rendering, and to flip the read side in ONE commit at the end.

| # | Slice | Side | Correct alone because |
|---|---|---|---|
| S1 | Project `direction` + `call_status`, keep `?? 'missed'` | server | Purely additive; today's card ignores unknown fields |
| S2 | Outbound outcome write (spec 6.2) | server | Stored truth improves; old card renders it as a red "Missed" instead of a green "Answered" - strictly better |
| S3 | Gate stamps + inbox derive arm (spec 6.3, 6.4) | server | Stamps are masked by the `?? 'missed'` default still in place, so the card is unchanged; inbox row provably identical |
| S4 | `CallStatus`/`CallTone` types + presenter, unwired | client | Pure module, no consumer |
| S5 | CallCard + EmailCard + CSS + fixtures + **drop `?? 'missed'`** | both | The one commit that flips the read side, with every write already true |
| S6 | E2E, existing-spec precondition, issue bookkeeping | both | Behavior already complete |

**S5 is deliberately a cross-package commit.** Splitting it reintroduces the
window: with the client live and the server still defaulting, a D12-stamped row
arrives as `call_outcome: 'missed'`, clause 2 never fires, and the card reads
"No answer" - all three gates green, decision broken, no test spanning the seam
(plan review A1). The seam test in S5 exists precisely to catch that.

**S3's two halves are one commit.** 6.3 alone changes stored `call_status` to
`canceled`, which stops `deriveLatest` firing on any row with a stored preview,
and the inbox row falls back to an unrelated old text body (spec 6.4).

## 2. S1 - Server projection, additive half

File: `app/src/routes/contactTimeline.ts`

1. Extend the local `TimelineCall` interface (`:179-195`) with
   `direction: MessageDirection` and `call_status?: CallStatus`, importing both
   from `../repos/messagesRepo.js`.
2. In `toTimelineCall` (`:425-449`) emit `direction: m.direction`, and
   `call_status` when `m.call_status` is a member of the `CallStatus` union.
   Leave `call_outcome: (m.call_outcome ?? 'missed')` ALONE - it goes in S5.
3. Do not relax any masked stripping (I4). The guards at `:431`, `:441-448` are
   untouched; direction and status are metadata and are emitted for masked rows.

TDD (`app/test/contactTimeline.test.ts`): a projected inbound call carries
`direction: 'inbound'`, an outbound one `'outbound'`, a `ringing` row projects
`call_status`. Red first (fields absent). The masked-row test (`:315-362`) must
pass unmodified apart from the new metadata; if it needs a semantic change,
STOP - that means I4 moved.

Gate: `npm run typecheck`, `npm test`.

## 3. S2 - Outbound outcome write (spec 6.2)

File: `app/src/routes/webhooks/voice.ts`, `/status` handler.

Hoist the `previewOutcome` / `previewDuration` computation from `:1432-1433` to
above the `updateCallStatus` write at `:1384`, and use it for the stored outcome
under this gate and no other:

```
isDialSummary && terminal && entry?.type === 'call'
  && entry?.masked !== true && entry?.direction === 'outbound'
```

- Read `entry`, NOT `fresh` (plan review B6). `entry` is the pre-write fetch at
  `:1361-1364`, already guarded by exactly `isDialSummary && terminal`, so no new
  read is needed. `fresh` (`:1403`) is fetched AFTER the write and falls back to
  a second read; the two diverge on a non-terminal summary, and relying on that
  divergence being harmless is relying on a `callPreview` fallthrough.
- `entry === undefined` (unknown CallSid) falls through to today's behavior.
- Add the code comment spec 6.2 requires at the divergence: stored
  `call_outcome: 'missed'` now coexists with `isMissed === false` in the same
  invocation. Both consumers are direction-gated (`:1444`, `:1466`), so nothing
  changes behaviorally - but the next reader of `isMissed` on an outbound path
  must not inherit the trap.

Do NOT touch `bridgeAccepted`, `stampAnsweredAt`, `isMissed`, the
missed-founder-bridge trigger, the unread rule, or the preview string.

TDD (`app/test/voiceOutbound.test.ts`):

- RED: press-1, then a terminal Dial summary with `DialCallStatus: 'no-answer'`,
  stores `call_outcome: 'missed'` and no duration. Today it stores `'answered'`.
  This is the I1 regression test and the bug's own reproduction.
- A NON-terminal (`in-progress`) outbound Dial summary must not write `'missed'`,
  including when the gate's best-effort write failed and the row is still
  `ringing`. HONEST NOTE (plan review B7): this one cannot be red against the
  current code, which also does not write `'missed'` there. It is a
  characterization test guarding the S2 gate, and it goes red only if a builder
  drops the `terminal` conjunct - which is the failure it exists to catch.
- `:391-409` and `:428-455` must pass UNMODIFIED.
- Also inspect `app/test/voiceInboxActivity.test.ts:534-575` (R2 finding 3): it
  drives press-1 + `DialCallStatus: 'no-answer'`, the exact S2 scenario, and its
  comment asserts the bug still exists - while section 7.3 of this plan closes
  that issue in the same change. The test itself SURVIVES because it asserts the
  preview, not the stored outcome; update its comment so the repo does not carry
  a note claiming a bug it has just fixed.

Gate: `npm run typecheck`, `npm test`.

## 4. S3 - Gate stamps and inbox derive arm, ONE commit (spec 6.3, 6.4)

### 4.1 The three stamps - `voice.ts`

Stamp `call_status: 'canceled'` with NO `call_outcome` on the parent CallSid,
immediately before the `vr.hangup()` in each of:

- `:1176-1184` - DNC re-check (`target.optedOut`). After press-1.
- `:1161-1169` - target or business caller ID unresolved at the gate. After
  press-1.
- `:1042-1051` - target unresolved in `/outbound-bridge`. Runs on the
  navigator's ANSWER, before any whisper or press-1.

Requirements (spec 6.3): best-effort in the same swallowing try/catch shape as
`:1187-1199` - a stamp failure must never break the hangup; guarded on
`parentCallSid.length > 0` as `:1187` is; tolerant of the row not existing yet
on the `/outbound-bridge` branch (`originateCall` appends best-effort and may
have failed, `:207-212`) - a stamp against a missing row is a no-op, not an
error; no new PII in logs.

### 4.2 The inbox derive arm - `app/src/routes/inbox.ts` (spec 6.4)

`deriveLatest`'s derive condition (`:518-527`) currently reads
`channel === 'call' && callStatus !== undefined && (callStatus === 'ringing' || fallbackPreview === '')`.

There is no `callOutcome` binding in scope there (plan review A5) - only
`latest.call_outcome`, raw and possibly out-of-union. Extend the first disjunct
to:

```
callStatus === 'ringing'
  || (callStatus === 'canceled' && latest.call_outcome === undefined)
```

Use RAW ABSENCE (`=== undefined`), not `!isCallOutcome(...)`. The two differ on
an out-of-union importer value, and only raw absence identifies a D12 stamp;
`isCallOutcome` would also capture an imported row that carries `'completed'`.
The second conjunct is load-bearing: a bare `canceled` disjunct would capture
`canceled` rows that DO carry an outcome, reachable when `stampCallActivity`
fails and swallows it (`:389-406`), and start deriving for calls this mission has
nothing to do with.

This is the ONLY inbox-side edit in the mission, and its entire purpose is to
keep the inbox row byte-identical.

TDD:

- `app/test/voiceOutbound.test.ts`: each of the three branches leaves terminal
  `call_status: 'canceled'` and NO `call_outcome`. `:380-382` currently asserts
  `call_status === 'ringing'` after the DNC path and must be RE-PINNED to
  `'canceled'` - that re-pin IS the proof of the fix.
- Stamp-failure test: inject by making the repo's `updateCallStatus` REJECT
  (plan review B8). Do not use the missing-row case as the injection - a stamp
  against a missing row is a no-op and does not throw, so that test would pass
  without exercising the catch. Assert the TwiML hangup response is still
  returned.
- `app/test/inboxApi.test.ts`: a D12-stamped row WITH a stored preview derives
  "Outgoing call" exactly as the `ringing` row did; the same row with no stored
  preview is unchanged; a `canceled` row that DOES carry an outcome still shows
  its stored preview and does NOT derive. HONEST NOTE (B7): the second and third
  cases cannot be red - they assert preserved behavior. They are the regression
  net for the bare-disjunct mistake, and that is their stated job.

Gate: `npm run typecheck`, `npm test`.

## 5. S4 - Types and the presenter, unwired

### 5.1 Types - `dashboard/src/api/types.ts`

Add `export type CallStatus` mirroring `messagesRepo.ts:42-49`. This lands HERE,
not in the card slice, because the presenter imports it and THIS slice must pass
its own typecheck gate (plan review A2/B1 - in the first draft the type landed
in a LATER slice than the presenter, so the presenter slice could not compile.
The slice numbers have changed since; the defect was positional, not S4's).

### 5.2 The presenter - new `dashboard/src/routes/contact/presentCallState.ts`

Declare the tone union in this module - it does not exist in the repo and the
first plan draft simply used it (A2, B5):

```
export type CallTone = 'success' | 'danger' | 'warning' | 'neutral';
```

Signature and rules are spec 7.1 verbatim. The ones a builder gets wrong:

- `age` is UNDEFINED when `at` does not parse. Clauses 3 and 4 require a defined
  age; an undefined age falls THROUGH them to clause 5.
- Clause 2 keys on `callStatus === 'canceled' && callOutcome === undefined` -
  NOT terminality in general. `completed` with no outcome is the dev transcript
  seam (`dev.ts:745-757`) and must not read "Not completed".
- Clause 4's stale arm is direction-split: inbound "Answered", outbound
  "Outcome unknown". Outbound must NOT say "Connected" - on an originate,
  press-1 is the navigator's own leg (I1). This is the single most hard-won line
  in the spec; it survived two rounds of being got wrong.
- `staleAt` is returned only by the fresh arms of clauses 3 and 4, and only in
  the future.
- Constants `RINGING_STALE_MS = 90_000` (D7) and `IN_PROGRESS_STALE_MS =
  900_000`. The 90s constant carries a comment naming its derivation - Twilio's
  60s default ring (`adapters/messaging.ts:849-850`, no `timeout` passed) plus
  the whisper `<Gather timeout: 8>` (`voice.ts:1063`) - so a reader knows what
  invalidates it.

TDD (`presentCallState.test.ts`, written first): the full matrix from spec 9 -
both directions x every `callStatus` x every `callOutcome` x fresh/stale - plus:

- Unparseable `at` on a `ringing` row: no label, no chip, no `staleAt`.
- Reached `answered` at 30s, evaluated at 200s: still "Connected"/"Answered".
- `completed` + no outcome: NOT "Not completed" (dev-seam regression).
- `canceled` + an outcome present: NOT "Not completed".
- Outbound stale in-progress: "Outcome unknown", never "Connected".
- Every returned `staleAt` strictly greater than the `now` passed in.

Gate: `npm run typecheck`, `npm test`.

## 6. S5 - The read side, in one commit

### 6.1 Wire types

- `app/src/routes/contactTimeline.ts:179-195`: make `call_outcome` OPTIONAL on
  the server-side `TimelineCall`. Without this, step 6.4 below does not compile
  and spec section 5 is half-delivered (plan review A3/B2).
- `dashboard/src/api/types.ts:2222-2238`: add `direction: MessageDirection`
  (required), add `call_status?: CallStatus`, make `call_outcome?: CallOutcome`.

### 6.2 Fixture sweep

Making `direction` required breaks the existing call fixtures. Let `tsc`
enumerate them rather than trusting a list - the first draft of this plan cited
a file that has no call fixture (plan review B9). Known at time of writing:
`Timeline.test.tsx` (several), `resolveConversation.test.ts:34-38`. For each,
choose the direction the test actually means; a test asserting outbound behavior
against an inbound fixture passes for the wrong reason.

### 6.3 CSS - `Timeline.module.css`

NONE of `.bubble`, `.in`, `.out`, `.revealed`, `.metaText` may be reused (spec
7.5). Reusing `.in`/`.out` repaints the card as a chat bubble; reusing
`.metaText` without `.bubble` renders the detail line `display: none` forever
while the unit test still passes.

New: `.itemIn { align-self: flex-start; }`, `.itemOut { align-self: flex-end; }`
(alignment and nothing else); `.callOut` - the outbound call-card tint
mirroring `.emailOut` (`:949-952`); a card-scoped reveal
(`.cardMeta { display: none; }` + `.cardRevealed .cardMeta { display: block; }`);
and a summary-line layout that does not inherit the `margin-left: auto` fight
between `.status` (`:311-314`) and `.callTime` (`:459-463`).

**The tone mapping, spelled out, because the obvious execution silently
recolors every call chip** (plan review R2 finding 1). The card today uses a
call-specific palette - `.answered` is `--c-resp-yes` (#15803d), `.missed` is
`--c-resp-no` (#b91c1c), `.voicemail` is `--c-resp-wait` (#a16207), at
`Timeline.module.css:447-457`. The DELIVERY tone classes are a different palette
- `.toneSuccess` is `--c-success` (#1a7f4b), `.toneDanger` is `--c-danger`
(#c23934). A builder told only "map the tones to classes" reaches for
`TONE_CLASS` and mixes two greens and two reds on one row.

So: introduce a SEPARATE `CALL_TONE_CLASS` map - do not extend `TONE_CLASS`,
which is typed `Record<DeliveryTone, ...>` and cannot hold `warning` anyway -
and point it at the EXISTING call classes, keeping today's colors exactly:

| tone | class | token |
|---|---|---|
| `success` | `.answered` | `--c-resp-yes` |
| `danger` | `.missed` | `--c-resp-no` |
| `warning` | `.voicemail` | `--c-resp-wait` |
| `neutral` | NEW `.callNeutral` | `--c-text-subtle` |

`.answered` / `.missed` / `.voicemail` keep their names and definitions rather
than being orphaned by the rewrite; only `.callNeutral` is new. If a rename
feels tidier, it is out of scope - the chips must not change color in this
change.

Changed: `.callcard` (`:426-433`) and `.emailCard` (`:938-946`) drop
`align-self: center` and replace `width: 84%` with `max-width: 84%` plus
`min-width: 40%`.

### 6.4 Projection, honest half - `contactTimeline.ts`

1. Normalization helper beside the projection, with its own test:
   `'no_answer' -> 'missed'`, `'completed' -> 'answered'` (the importer's
   out-of-union values, `apply.ts:448`), THEN a membership test against
   `CallOutcome`. An unrecognized string is DROPPED, never cast.
2. Delete the `?? 'missed'` default (`:439`).
3. Duration fallback: when `m.call_duration` is absent, read
   `call_duration_seconds` through the `MessageItem` index signature
   (`messagesRepo.ts:981`) with a `typeof === 'number'` narrow. It is not a
   declared field (`:909` declares `call_duration` only), so a plain property
   read will not compile.

### 6.5 CallCard - `Timeline.tsx:710-760`

Per spec 7.2. What a builder gets wrong:

- Map snake_case wire fields to the presenter's camelCase inputs at the call
  site; that is the only place the two vocabularies meet.
- Summary line: arrow glyph (`'\u2199'`/`'\u2197'`, `aria-hidden="true"`),
  direction word, chip, duration whenever present, time.
- **Apply `.callOut` on outbound** (plan review A7 - the first draft created the
  class and never used it) and assert it.
- `role="group"` with `aria-label` from the DIRECTION WORD AND TIME ONLY - never
  the outcome, which flips with clauses 3/4 and would make the e2e handle race.
- Reveal is a dedicated `<button>`, not a handler on the card surface, and not
  the card itself as a button (it contains an audio player and a `<details>`;
  a button may not contain interactive descendants).
- Reveal line content: `to <number> - <time>` on outbound, `from <number> -
  <time>` on inbound (plan review A9 - only the masked degradation was stated).
  On a MASKED row it degrades to the time alone: `party_phone` is stripped
  (`contactTimeline.ts:431`) and `call_party_label` is not on the wire.
- Timer: spec 7.1's three constraints, which live in 7.1 and are restated
  nowhere. Fresh `Date.now()` at SCHEDULE time (not state `now`); clamp to the
  32-bit `setTimeout` range and schedule nothing above it; when `staleAt` has
  already passed, advance state `now` IMMEDIATELY rather than skipping. Do not
  build the timer on any assumption about remounting: the list key is
  `${kind}:${id}:${ii}` (`Timeline.tsx:1373`), not the bare id, so paging can
  remount a cluster (plan review B12 corrects the first draft's citation).

### 6.6 EmailCard - `Timeline.tsx:772-838`

Alignment and sizing only: `.itemIn`/`.itemOut` and the same
`max-width`/`min-width`. Everything else untouched.

### 6.7 The seam test - the reason this slice is one commit

A test that a D12-stamped row goes end to end - stored `call_status: 'canceled'`
with no outcome, through the real projection, into `presentCallState` - and
produces "Not completed". Nothing else in the plan crosses the projection /
presenter boundary, and without it every gate passes green while D12 is defeated
(plan review A1).

Mechanics, because `toTimelineCall` is module-private (`contactTimeline.ts:421`)
and cannot simply be called (R2 finding 2): drive the projection through its
ROUTE, as every existing app test does, and feed the resulting payload into
`presentCallState`. Importing dashboard source from an app test is already
established practice (`app/test/consentDrift.test.ts:34`), so the cross-package
half needs no new machinery. Exporting `toTimelineCall` purely for the test is
acceptable if the route path proves unwieldy - say which was chosen in the
handback. It lands in THIS slice (S5); section 9's "S5 seam test" is the
binding statement.

### 6.8 Required-field shape assertion (spec section 5)

There is no cross-package type check. `direction` required on the client and
omitted by the server type-checks clean on both sides and fails only in the
browser. Mechanism, since "add an assertion" is not implementable as written
(plan review B4): an app-side test that runs `toTimelineCall` over a
representative row and asserts the returned object has every key the dashboard
declares REQUIRED on `TimelineCall`, with the key list written literally in the
test beside a comment naming
`dashboard/src/api/types.ts:2222-2238` as its source of truth. It is a manual
mirror, not an automatic one; say so in the comment so nobody trusts it further
than it goes.

TDD for the whole slice (`Timeline.test.tsx`): inbound card carries `.itemIn`,
outbound `.itemOut` and `.callOut`; direction word renders; arrow is
`aria-hidden`; duration renders on the face; accessible name contains the
direction word and NOT the outcome; reveal line asserted with `toBeVisible()`
AFTER clicking the button, never `getByText` alone (which matches
`display: none` nodes and passes on the dead-feature build); card-level timer
tests with fake timers - delay computed from a clock read after a props-driven
re-render, a beyond-ceiling `staleAt` schedules nothing, a past `staleAt` settles
on the stale label, a settled card schedules no timer; email cards align on both
the server-timeline path and `buildTimelineFallback` (`:44`, `:70` carry
`direction`).

Gate: `npm run typecheck`, `npm test`.

## 7. S6 - E2E, existing-spec precondition, bookkeeping

### 7.1 New coverage

An inbound and an outbound call in one thread land on opposite sides and
announce different outcomes. Assert in TWO parts: locate each card by role and
accessible name (which carry DIRECTION and are stable), then assert the outcome
as the chip's text WITHIN that card.

The outbound half needs the verified-cell + originate + `driveBridge` machinery,
which `call-inbox-unread.spec.ts` does not have; the working recipe is
`e2e/tests/dashboard-next/voice-outbound.spec.ts:169-190` (plan review A8/B14).
Extend THAT spec, or lift its helpers - do not attempt the outbound half from
the inbox spec.

### 7.2 Existing spec, now conditional

`call-inbox-unread.spec.ts:256` asserts `'Missed'` on an inbound row with no
precondition tying it to the Dial summary having landed. Under clause 3 that row
reads "Ringing..." for its first 90 seconds, so the assertion becomes a timing
race. Give it an explicit precondition - drive the terminal summary, then assert.

Two further e2e readers assert on outbound `call_outcome` and were checked
against S2's new stored value: `e2e/scenarios/steps.ts:1176` (note the path -
there is no `e2e/support/steps.ts`, R2 finding 4) and
`voice-outbound.spec.ts:204`. BOTH SURVIVE, and the reason is recorded here so
it is not re-derived at the most expensive gate (R2 finding 7): each drives the
bridge through `driveBridge`, which takes the Dial to `completed`, so S2's gate
yields `'answered'` exactly as before. Confirm rather than re-investigate.

`voice-transcription.spec.ts:189` ('Voicemail') is unaffected: clause 1 wins over
any status. Do not touch it.

### 7.3 Issue bookkeeping (spec 11)

- Resolve `docs/issues/outbound-call-outcome-answered-before-target-rings.md`,
  recording that `bridgeAccepted` was left intact, only the stored outbound
  outcome changed, and the substitution is gated to a terminal outbound Dial
  summary.
- Note on `docs/issues/voice-bridge-dnc-recheck.md` that the DNC branch now
  stamps a terminal status; the re-check behavior is unchanged.
- File three new issues: a status callback on the navigator's originate leg (the
  durable fix D6 deferred, carrying D6's scoping); AMD for outbound
  human-vs-voicemail (D9, with the cost and latency question); and the inbox's
  `deriveLatest` not normalizing imported outcomes or reading
  `call_duration_seconds` (spec section 8).
- Leave `docs/issues/masked-relay-calls-invisible.md` open and untouched.
- Run `npm run issues`. Never hand-edit the index.

Gate: all three, bare.

## 8. Invariant surface map

Every writer and reader of `call_status` / `call_outcome`. Verified against the
code, including the four rows plan review added.

WRITERS:

| Site | Touched? |
|---|---|
| `voice.ts:608-627` founder-bridge append | No |
| `voice.ts:843-858` masked refusal append | No |
| `voice.ts:913-925` masked relay append | No |
| `voice.ts:1189-1192` outbound gate in-progress | No |
| `voice.ts:1234-1237` inbound gate in-progress | No |
| `voice.ts:1384-1392` `/status` terminal write | YES - S2 |
| `voice.ts:1042, 1161, 1176` gate refusals | YES - S3 (new writers) |
| `messagesRepo.ts:2406-2423` voicemail upgrade | No - I8 |
| `originateCall.ts:171-191` originate append | No |
| `apply.ts:434-453` Quo importer | No - normalized on READ |
| `seed/cast.ts:1062-1067` demo seed | No |
| `dev.ts:745-757` dev transcript seam | No - but drives clause 2 |

READERS:

| Site | Touched? |
|---|---|
| `contactTimeline.ts:425-449` projection | YES - S1, S5 |
| `inbox.ts:518-527` `deriveLatest` | YES - S3 (behavior-preserving) |
| `voice.ts:1607` recording voicemail gate | No - direction-gated, I8 |
| `voice.ts:1693-1699` voicemail re-stamp | No - reads `call_status` + `direction`, writes the same conversation preview field the SPEC's section 6.4 governs; inbound-gated at `:1607` (plan review A6/B11) |
| `voice.ts:1444, 1466` unread + miss trigger | No - direction-gated |
| `callPreview.ts:35-47` preview strings | No - spec section 8 |
| `Timeline.tsx:710-760` CallCard | YES - S5 |
| `e2e/scenarios/steps.ts:1176` | CONFIRM - S6 (survives; `driveBridge` reaches `completed`) |
| `voice-outbound.spec.ts:204` | CHECK - S6 |
| `useRelayThread.ts:49` | No - drops calls entirely |
| `buildTimelineFallback.ts:36` | No - drops calls entirely |

## 9. Definition of done

- All three gates green, bare, from this worktree, exit codes quoted.
- Every decision D1-D12 traceable to a slice; every invariant I1-I8 untouched or
  explicitly re-established. D2 is delivered only if the glyph escapes survive -
  check them in the diff.
- The S5 seam test exists and fails when the `?? 'missed'` default is restored.
- `main` synced into the branch ONCE, at the final pre-handback step.
- Handback at `.superpowers/sdd/handback.md`: per-spec-item table, quoted exit
  codes on the final commit, what was NOT done and why, owed post-merge ops
  (expected: none infra), current `main` drift.
- UNMERGED. The human merges.
