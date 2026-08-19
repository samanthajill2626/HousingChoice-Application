# Comms panel: calls as first-class directional items - implementation plan

Date: 2026-08-18
Spec: `docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md` @6397b829
Branch: `feat/comms-panel-call-direction`  Worktree: `W:\tmp\comms-panel-call-direction`
Base: `main` @08ec365c
Spec review: R1-R4 complete, terminal at R4; adjudications at
`.superpowers/design-review/adjudications.md`.

Read the spec first. This plan does not restate its reasoning; it says what to
do, in what order, and how each step is proved. Where a step exists because of a
specific spec decision, the decision id is cited - if a step seems pointless,
the citation is where to look before dropping it.

## 0. Ground rules for the builder

- TDD throughout: write the failing test, see it fail for the RIGHT reason, then
  make it pass. A test that passes before the change is not a test of the change.
- Commit per slice, explicit paths only, never `git add -A`. Bare `git status`
  before every commit. `Co-Authored-By` trailer naming the authoring model.
- New/touched lines in tests, comments and strings are ASCII-only.
- Gates run BARE from this worktree, never piped: `npm run typecheck`,
  `npm test`, `npm run e2e`.
- Do not run a full e2e suite and an interactive e2e session from this worktree
  at the same time.
- Two known flakes must be re-run once before being blamed on this change, with
  both runs reported: `tour-reminders-panel-e2e-flake`,
  `conversationdetail-members-mock-suite-flake`.

## 1. Slice order, and why it is this order

Every slice leaves the tree GREEN and the app CORRECT. That constraint dictates
the sequence, because the naive order breaks the running app between two of its
own steps.

The hazard: `TimelineCall.call_outcome` becomes optional and `direction` becomes
required. If the server stops sending an outcome before the card tolerates its
absence, `Timeline.tsx:730` does `call.call_outcome.charAt(0)` on `undefined` and
throws at runtime. If the dashboard declares `direction` required before the
server sends it, every real payload is a lie the compiler cannot see.

So: ADD fields server-side first (purely additive, invisible to today's card),
then teach the client, then REMOVE the server's manufactured default once the
client can cope. Readers before writers, in both directions.

| Slice | What lands | Safe alone because |
|---|---|---|
| S1 | Server projects `direction` + `call_status`; keeps `?? 'missed'` | Additive; today's card ignores unknown fields |
| S2 | `presentCallState` module + tests, unwired | Pure function, no consumer yet |
| S3 | Dashboard types, CallCard, CSS, fixture sweep | `direction` now arrives (S1); card tolerates a missing outcome before one can occur |
| S4 | Server drops `?? 'missed'`, adds import normalization + duration fallback | Card already tolerates absence (S3) |
| S5 | `voice.ts` outbound outcome write (6.2) | Pure write-side correction; read side already honest |
| S6 | `voice.ts` gate stamps (6.3) + inbox derive arm (6.4) | 6.4 must land in the SAME commit as 6.3 - see S6 |
| S7 | E2E, existing-spec precondition, issue bookkeeping | Behavior already complete |

S6's two halves are NOT independently shippable. 6.3 alone changes stored
`call_status` to `canceled`, which stops `deriveLatest`'s derive arm firing on
any row with a stored preview, and the inbox row silently falls back to an
unrelated old text body (spec 6.4, R3 finding 1). One commit, both halves.

## 2. S1 - Server projection, additive half

File: `app/src/routes/contactTimeline.ts`

1. Extend the local `TimelineCall` interface (`:179-195`) with
   `direction: MessageDirection` and `call_status?: CallStatus`. Import both
   types from `../repos/messagesRepo.js` if not already in scope.
2. In `toTimelineCall` (`:425-449`) emit `direction: m.direction`, and
   `call_status` when `m.call_status` is a member of the `CallStatus` union.
   Leave `call_outcome: (m.call_outcome ?? 'missed')` ALONE in this slice.
3. Do NOT relax any masked stripping (spec I4). The masked guards at `:431`,
   `:441-448` stay exactly as they are; `direction` and `call_status` are
   metadata and are emitted for masked rows too.

TDD:

- RED: extend `app/test/contactTimeline.test.ts` - assert a projected inbound
  call carries `direction: 'inbound'`, an outbound one `direction: 'outbound'`,
  and that a row with `call_status: 'ringing'` projects it. Fails: fields absent.
- GREEN: implement.
- The existing masked-row test (`:315-362`) must pass UNMODIFIED except for any
  new fields it now legitimately carries. If it needs a semantic change, stop -
  that means I4 moved.

Gate: `npm run typecheck`, `npm test`.

## 3. S2 - The presenter, unwired

New file: `dashboard/src/routes/contact/presentCallState.ts` (module lives beside
its only consumer; it is not shared UI).

Implement exactly spec 7.1. Signature:

```
presentCallState(input: {
  direction: MessageDirection;
  callStatus?: CallStatus;
  callOutcome?: CallOutcome;
  at: string;
  now: number;
}): { label?: string; tone?: CallTone; staleAt?: number }
```

Rules that are easy to get wrong, all from spec 7.1:

- `age` is UNDEFINED when `at` does not parse to an instant. Clauses 3 and 4
  require a defined age; an undefined age falls THROUGH them to clause 5.
- Clause 2 keys on `callStatus === 'canceled' && callOutcome === undefined` -
  not on terminality in general. `completed` with no outcome is the dev
  transcript seam (`dev.ts:745-757`) and must NOT read "Not completed".
- Clause 4's stale arm is direction-split: inbound "Answered", outbound
  "Outcome unknown". Outbound must NOT say "Connected" - on an originate,
  press-1 is the navigator's own leg (spec I1, R2 finding 1).
- `staleAt` is returned ONLY by the fresh arms of clauses 3 and 4, and only in
  the future.
- Constants: `RINGING_STALE_MS = 90_000` (D7) and `IN_PROGRESS_STALE_MS =
  900_000`. The 90s constant carries a comment naming its derivation - Twilio's
  60s default ring (`adapters/messaging.ts:849-850`, no `timeout` passed) plus
  the whisper `<Gather timeout: 8>` (`voice.ts:1063`) - so a future reader knows
  what invalidates it.

TDD: `dashboard/src/routes/contact/presentCallState.test.ts`, written BEFORE the
module. Cover the full matrix from spec 9 - both directions x every
`callStatus` x every `callOutcome` x fresh/stale - plus these named cases:

- Unparseable `at` on a `ringing` row: no label, no chip, no `staleAt`.
- A row that reached `answered` at 30s, evaluated at 200s: still "Connected"
  (outbound) / "Answered" (inbound). This is the human's own stated concern and
  the read-side expression of spec I3.
- `completed` + no outcome: NOT "Not completed" (the dev-seam regression).
- `canceled` + an outcome present: NOT "Not completed" (falls to clause 5/6).
- Outbound stale in-progress: "Outcome unknown", never "Connected".
- Every returned `staleAt` is strictly greater than the `now` passed in.

Gate: `npm run typecheck`, `npm test`.

## 4. S3 - Dashboard types, CallCard, CSS

This slice is one commit because its parts break each other in between (spec 9,
F16).

### 4.1 Types

`dashboard/src/api/types.ts`:

- Add `export type CallStatus = ...` mirroring `messagesRepo.ts:42-49`.
- `TimelineCall` (`:2222-2238`): add `direction: MessageDirection` (REQUIRED),
  add `call_status?: CallStatus`, make `call_outcome?: CallOutcome`.

### 4.2 Fixture sweep

Making `direction` required breaks every existing call fixture. Fix all of them,
choosing the direction each test actually means (do not blanket-default to
inbound - a test asserting outbound behavior with an inbound fixture passes for
the wrong reason):

`dashboard/src/routes/contact/Timeline.test.tsx:55, 122, 132, 143, 164, 198, 229`
`dashboard/src/routes/contact/resolveConversation.test.ts:34-38`
`dashboard/src/routes/contact/media.test.ts:55`

### 4.3 CSS - `Timeline.module.css`

NONE of `.bubble`, `.in`, `.out`, `.revealed`, `.metaText` may be reused (spec
7.5). Reusing `.in`/`.out` repaints the card as a chat bubble; reusing
`.metaText` without `.bubble` renders the detail line `display: none` forever,
and the unit test would still pass.

New:

- `.itemIn { align-self: flex-start; }` and `.itemOut { align-self: flex-end; }`
  - alignment and nothing else.
- `.callOut` - the outbound tint for the call card, mirroring `.emailOut`
  (`:949-952`).
- A card-scoped reveal: `.cardMeta { display: none; }` and
  `.cardRevealed .cardMeta { display: block; }`.
- Summary-line layout that does not inherit the `margin-left: auto` fight
  between `.status` (`:311-314`) and `.callTime` (`:459-463`).

Changed:

- `.callcard` (`:426-433`) and `.emailCard` (`:938-946`): drop
  `align-self: center`, replace `width: 84%` with `max-width: 84%` and
  `min-width: 40%`.

### 4.4 CallCard - `Timeline.tsx:710-760`

Rewrite per spec 7.2. Points a builder gets wrong:

- Map the snake_case wire fields to the presenter's camelCase inputs AT the call
  site; that is the only place the two vocabularies meet.
- Summary line order: arrow glyph (`aria-hidden="true"`), direction word, the
  chip, duration whenever present, time.
- `role="group"` with `aria-label` from the DIRECTION WORD AND TIME ONLY. Never
  the outcome - it flips with clauses 3/4 and would make the e2e handle race
  (R2 finding 12).
- Reveal is a dedicated `<button>`, not a click handler on the card surface and
  not the card itself as a button (the card contains an audio player and a
  `<details>`; a button may not contain interactive descendants).
- Masked row: the reveal line degrades to the time alone - `party_phone` is
  stripped and `call_party_label` is not on the wire (spec 7.2, F18).
- Timer: implement spec 7.1's THREE constraints, which live in 7.1 and are not
  restated anywhere else. Delay from a FRESH `Date.now()` at schedule time (not
  from state `now`); clamp to the 32-bit `setTimeout` range and schedule nothing
  above it; when `staleAt` has already passed, advance state `now` IMMEDIATELY
  rather than skipping the schedule (skipping strands the card on the fresh
  label - R4 finding 4).

### 4.5 EmailCard - `Timeline.tsx:772-838`

Alignment and sizing only: the same `.itemIn`/`.itemOut` and the same
`max-width`/`min-width` change. Everything else untouched.

TDD (`Timeline.test.tsx`):

- RED then GREEN for: inbound call card carries `.itemIn`, outbound `.itemOut`;
  the direction word renders; the arrow is `aria-hidden`; duration renders on
  the face; the accessible name contains the direction word and NOT the outcome.
- The reveal line asserted with `toBeVisible()` AFTER clicking the button -
  never `getByText` alone, which matches `display: none` nodes and would pass on
  the dead-feature build (spec 7.5, B4 trap 3).
- Card-level timer tests with fake timers (spec 9): the scheduled delay is
  computed from a clock read AFTER a props-driven re-render; a `staleAt` beyond
  the 32-bit ceiling schedules nothing; a past `staleAt` settles on the stale
  label. A settled card schedules NO timer.
- Email cards align by direction on both the server-timeline path and the
  `buildTimelineFallback` path (`buildTimelineFallback.ts:44, 70` carries
  `direction`).

Gate: `npm run typecheck`, `npm test`.

## 5. S4 - Server projection, honest half

File: `app/src/routes/contactTimeline.ts`

1. Add a normalization helper beside the projection (spec 6.1) - one home, its
   own test:
   - `'no_answer' -> 'missed'`, `'completed' -> 'answered'` (the importer's
     out-of-union values, `apply.ts:448`).
   - Then a MEMBERSHIP test against `CallOutcome`. An unrecognized string is
     DROPPED, never cast through `as CallOutcome`.
2. Delete the `?? 'missed'` default (`:439`).
3. Duration fallback: when `m.call_duration` is absent, read
   `call_duration_seconds` through the `MessageItem` index signature
   (`messagesRepo.ts:981`) with a `typeof === 'number'` narrow. It is NOT a
   declared field (`:909` declares `call_duration` only), so a plain property
   read will not compile.
4. Add the shape assertion the spec requires (section 5): a test proving the
   projection's emitted object carries every field
   `dashboard/src/api/types.ts` declares REQUIRED on `TimelineCall`. There is no
   cross-package type check; `direction` being required on the client and
   omitted by the server would type-check clean on both sides and fail only in
   the browser.

TDD: extend `app/test/contactTimeline.test.ts` - an imported row
(`call_outcome: 'completed'`, `call_duration_seconds: 252`) projects
`call_outcome: 'answered'` and `call_duration: 252`; a row with an unrecognized
outcome projects NO `call_outcome`; a `ringing` row with no outcome projects no
`call_outcome` (not `'missed'`).

Gate: `npm run typecheck`, `npm test`.

## 6. S5 - Outbound outcome write

File: `app/src/routes/webhooks/voice.ts`, the `/status` handler.

Hoist the `previewOutcome` / `previewDuration` computation from `:1432-1433` to
above the `updateCallStatus` write at `:1384`, and use it for the stored outcome
under this gate and no other (spec 6.2):

```
isDialSummary && terminal && entry?.type === 'call'
  && entry?.masked !== true && entry?.direction === 'outbound'
```

- `entry` is ALREADY fetched under `if (isDialSummary && terminal)`
  (`:1361-1364`). No new read.
- `entry === undefined` (unknown CallSid) falls through to today's behavior.
- Add the code comment spec 6.2 requires at the divergence: stored
  `call_outcome: 'missed'` will now coexist with `isMissed === false` in the
  same invocation. Both consumers are direction-gated (`:1444`, `:1466`), so
  nothing changes behaviorally - but the next reader of `isMissed` on an
  outbound path must not inherit the trap.

Do NOT touch: `bridgeAccepted`, `stampAnsweredAt`, `isMissed`, the
missed-founder-bridge trigger, the unread rule, or the preview string.

TDD (`app/test/voiceOutbound.test.ts`):

- RED: press-1 THEN a terminal Dial summary with `DialCallStatus: 'no-answer'`
  stores `call_outcome: 'missed'` and no duration. Today it stores `'answered'`.
  This is the I1 regression test and the bug's own reproduction.
- A NON-terminal (`in-progress`) outbound Dial summary must NOT write
  `'missed'` - including when the gate's best-effort write failed and the row is
  still `ringing`, which is the case where the forward-only condition does not
  save it (R2 finding 7).
- `:391-409` (press-1 + `completed` -> `answered`) and `:428-455` (no press-1 +
  `no-answer` -> `missed`) must pass UNMODIFIED.

Gate: `npm run typecheck`, `npm test`.

## 7. S6 - Gate stamps and the inbox derive arm (ONE commit)

### 7.1 The three stamps - `voice.ts` (spec 6.3)

Stamp `call_status: 'canceled'` with NO `call_outcome` on the parent CallSid,
immediately before the `vr.hangup()` in each of:

- `:1176-1184` - DNC re-check (`target.optedOut`). After press-1.
- `:1161-1169` - target or business caller ID unresolved at the gate. After
  press-1.
- `:1042-1051` - target unresolved in `/outbound-bridge`. This runs on the
  navigator's ANSWER, before any whisper or press-1.

Requirements, each from spec 6.3:

- BEST-EFFORT, in the same swallowing try/catch shape as `:1187-1199`. A stamp
  failure must never break the hangup.
- Guarded on `parentCallSid.length > 0`, as `:1187` is.
- The `/outbound-bridge` branch must tolerate the row not existing yet -
  `originateCall` appends best-effort and may have failed (`:207-212`). A stamp
  against a missing row is a no-op, not an error.
- No new PII in logs; the DNC branch keeps logging IDs only.

### 7.2 The inbox derive arm - `app/src/routes/inbox.ts` (spec 6.4)

Extend `deriveLatest`'s derive condition (`:518-527`) from
`callStatus === 'ringing'` to
`callStatus === 'ringing' || (callStatus === 'canceled' && callOutcome === undefined)`.

The second conjunct is load-bearing (R4 finding 1): a bare `canceled` disjunct
would also capture `canceled` rows that CARRY an outcome - reachable when
`stampCallActivity` fails and swallows it (`:389-406`) - and start deriving for
calls this mission has nothing to do with.

This is the ONLY inbox-side edit in the mission. Its entire purpose is to keep
the inbox row byte-identical: without it, a D12-stamped row with a stored
preview stops deriving and the row falls back to an unrelated old text body.

TDD:

- `app/test/voiceOutbound.test.ts`: each of the three branches leaves a terminal
  `call_status: 'canceled'` and NO `call_outcome`; a stamp failure does not
  break the hangup response. `:380-382` currently asserts
  `call_status === 'ringing'` after the DNC path and must be RE-PINNED to
  `'canceled'` - that re-pin is the test proving the fix, not collateral damage.
- `app/test/inboxApi.test.ts` (or wherever `deriveLatest` is covered): a
  D12-stamped row WITH a stored preview derives "Outgoing call" exactly as the
  `ringing` row did; the same row with no stored preview is unchanged; a
  `canceled` row that DOES carry an outcome still shows its stored preview and
  does NOT derive.

Gate: `npm run typecheck`, `npm test`.

## 8. S7 - E2E, existing-spec precondition, bookkeeping

### 8.1 New coverage

Extend `e2e/tests/dashboard-next/call-inbox-unread.spec.ts` or add a sibling: an
inbound and an outbound call in one thread land on opposite sides and announce
different outcomes. Assert in TWO parts (spec 9): locate each card by role and
accessible name, which carry the DIRECTION and are stable; then assert the
outcome as the chip's text WITHIN that located card. Accessibility-first
selectors per `e2e/support/selectors.md`.

### 8.2 Existing spec, now conditional

`call-inbox-unread.spec.ts:256` asserts `'Missed'` on an inbound row with no
precondition tying it to the Dial summary having landed. Under clause 3 that row
reads "Ringing..." for its first 90 seconds, so the assertion becomes a timing
race. Give it an explicit precondition - drive the terminal summary, then assert.

`voice-transcription.spec.ts:189` ('Voicemail') is unaffected: clause 1 wins over
any status. Do not touch it.

### 8.3 Issue bookkeeping (spec 11)

- Resolve `docs/issues/outbound-call-outcome-answered-before-target-rings.md`,
  recording that `bridgeAccepted` was left intact, only the stored outbound
  outcome changed, and the substitution is gated to a terminal outbound Dial
  summary.
- Note on `docs/issues/voice-bridge-dnc-recheck.md` that the DNC branch now
  stamps a terminal status; the re-check behavior itself is unchanged.
- File three new issues: a status callback on the navigator's originate leg (the
  durable fix D6 deferred, with D6's scoping so nobody re-derives it); AMD for
  outbound human-vs-voicemail (D9, with the cost and latency question); and the
  inbox's `deriveLatest` not normalizing imported call outcomes or reading
  `call_duration_seconds` (F22).
- Leave `docs/issues/masked-relay-calls-invisible.md` open and untouched.
- Run `npm run issues` to regenerate the gitignored index. Never hand-edit it.

Gate: all three, bare, from this worktree.

## 9. Invariant surface map (required by the mission rules)

This change moves WHERE the call outcome is decided - from a read-time default
to the stored value plus a derivation. Every mutation surface of
`call_status` / `call_outcome`, and every reader of them, enumerated so an
omission is visible rather than silent.

WRITERS of `call_status` / `call_outcome`:

| Site | Touched? |
|---|---|
| `voice.ts:608-627` founder-bridge append | No |
| `voice.ts:843-858` masked refusal append | No |
| `voice.ts:913-925` masked relay append | No |
| `voice.ts:1189-1192` outbound gate in-progress | No |
| `voice.ts:1234-1237` inbound gate in-progress | No |
| `voice.ts:1384-1392` `/status` terminal write | YES - S5 |
| `voice.ts:1042, 1161, 1176` gate refusals | YES - S6 (new writers) |
| `messagesRepo.ts:2406-2423` voicemail upgrade | No - spec I8 |
| `originateCall.ts:171-191` originate append | No |
| `apply.ts:434-453` Quo importer | No - normalized on READ |
| `seed/cast.ts:1062-1067` demo seed | No |
| `dev.ts:745-757` dev transcript seam | No - but see clause 2 |

READERS:

| Site | Touched? |
|---|---|
| `contactTimeline.ts:425-449` projection | YES - S1, S4 |
| `inbox.ts:518-527` `deriveLatest` | YES - S6 (behavior-preserving) |
| `voice.ts:1607` recording voicemail gate | No - direction-gated, spec I8 |
| `voice.ts:1444, 1466` unread + miss trigger | No - direction-gated |
| `callPreview.ts:35-47` preview strings | No - spec section 8 |
| `Timeline.tsx:710-760` CallCard | YES - S3 |
| `useRelayThread.ts:49` | No - drops calls entirely |
| `buildTimelineFallback.ts:36` | No - drops calls entirely |

## 10. Definition of done

- All three gates green, bare, from this worktree, with exit codes quoted.
- Every spec decision D1-D12 traceable to a slice; every invariant I1-I8 either
  untouched or explicitly re-established.
- `main` synced into the branch ONCE, at the final pre-handback step.
- Handback report at `.superpowers/sdd/handback.md`: per-spec-item table, quoted
  exit codes on the final commit, what was NOT done and why, owed post-merge ops
  (expected: none infra), and current `main` drift.
- UNMERGED. The human merges.
