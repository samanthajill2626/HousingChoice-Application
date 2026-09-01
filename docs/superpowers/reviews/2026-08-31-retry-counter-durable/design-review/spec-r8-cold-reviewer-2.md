# R8 cold review - retry-counter-durable design spec

Cold reviewer. No brainstorm, no prior review rounds, no adjudications. Every
factual claim below was checked against the working tree at
`W:\tmp\retry-counter-durable`; anything I could not check is marked UNVERIFIED.

## What I verified as TRUE (so the builder does not re-buy it)

These are the spec's load-bearing citations that hold up. I read every one.

- `broadcastFanOut.ts:456-459` / `relayFanOut.ts:531-535` - the unknown-error
  `throw` and its false "fresh jobId via the visibility timeout" comment. Both
  present, both worded as quoted.
- `jobs.ts:188` mints `jobId: randomUUID()` inside `buildEnvelope`; `jobs.ts:262`
  returns a complete envelope verbatim (`if (isCompleteEnvelope(e)) return {...}`);
  the docblock at `jobs.ts:286-288` does say "the stable jobId".
  `retrySend.ts:122-128` states the correct semantics. Obligation 0 is sound.
- `messagesRepo.ts:2779-2785` is exactly `SET delivery_recipients.#mk = :d`;
  `broadcastsRepo.ts:612-618` is exactly `SET recipients.#ck = :rec`. Sec 3.1's
  "written WHOLESALE on every pass" is correct, and a counter inside the slot
  really would read 1 forever.
- Every `PutCommand` in `messagesRepo.ts` (`:2600, 2664, 2892, 2943, 3015, 3041,
  3084, 3098, 3256, 3466`) writes a POINTER/MARKER item, never a message row.
  Sec 3.1's "writers that would erase it" survey is right.
- `api.ts:2152-2165` returns message items whole (`res.json({ messages: page })`,
  and `{ ...message, relay_external_caller_display_name }`), so `fanout_attempt`
  does ship to the browser. The broadcast side does NOT leak it -
  `broadcasts.ts:791` returns `toBroadcastResults(...)`, a field-by-field
  projection (`:279`). The asymmetry the spec implies is real.
- Both duplicate-delivery guards WARN and continue when `jobId` is absent
  (`broadcastFanOut.ts:229-234`, `relayFanOut.ts:350-355`).
- The existing cap branch really is nested inside `if (transientRemaining.length
  > 0)` and closes over a local list (`broadcastFanOut.ts:478-495`,
  `relayFanOut.ts:569-582`). Sec 3.6's "unreachable from the top of the handler"
  is correct, and `finalize()` (`broadcastFanOut.ts:549-583`) would indeed
  `markSent` with recipients still `queued`.
- `ensureGroupRail` has exactly FIVE production callers: `jobs/groupRail.ts:59`,
  `lib/import/convertGroups.ts:598`, `scripts/rail-verify.ts:198`,
  `services/groupSend.ts:381`, `services/groupSend.ts:425`. Enumeration correct.
  `api.ts:1360-1364` is the send route reaching `groupSend`. Correct.
- `buildParticipantMap` (`groupRail.ts:224-231`) does skip empty `address`; the
  authority quote is at `groupRail.ts:535-537` (spec cites 536-538, close
  enough); `authorRefusedOnCreate` is at `groupRail.ts:463`.
- `deliveryReason` has exactly SIX production call sites: `deliveryStatus.ts:416`,
  `Timeline.tsx:582`, `:849`, `:1045`, `:1390`, `DeliveryBadge.tsx:31`.
  Enumeration correct.
- `presentLegDelivery` already takes `rosterKind` (`deliveryStatus.ts:500-505`);
  `presentRelayDelivery` (`:387-390`) does not. `INTERNAL_CODE_REASONS` and its
  docblock are at `deliveryStatus.ts:591-611`; the no-tail early return is
  `:633-634`; the `(error <code>)` tail is `:638-640`. `contact_opted_out` is
  intercepted before `deliveryReason` on the per-leg path (`:512-531`).
- The relay-pointer branch DOES return before the retry switch:
  `twilio.ts:2432-2436` (`if (relayPtr) { ...; return; }`) vs `case '30003'` at
  `:2553`. And the 30003 arm carries NO `group_text` guard while the 30005/30006
  arm has one at `:2633` and the 21610 arm at `:2691`. Sec 5.1's "native group
  text is not included, because its retry is real" is correct on the facts.
- `twilio.ts:2726-2731` is the catch that swallows a failed `enqueueSendRetry`
  and logs ERROR. `message.retry_attempt` is read at `:2555`. Sec 1's table rows
  for `retrySend` are correct.
- `grep "!== 'success'"` over `app/src` returns ZERO hits. Sec 6 is honest.
- `transient_cap` has NO reader anywhere today - only the two writers
  (`broadcastFanOut.ts:482`, `relayFanOut.ts:575`). Sec 5.2's "renders as
  `Delivery failed (error transient_cap)`" is correct.
- `ALLOWED_PRIOR.delivered === ['queued','sent']` (`messagesRepo.ts:126`);
  `relayAnnouncements.ts:289` writes a relaysid pointer;
  `conversationsRepo.ts:2189-2214` is the child-SET-then-seed-parent pattern.
  All three Sec 8.3 forward-carries check out.
- Sec 1's `groupRail` row: `jobs/groupRail.ts:104-119` wraps the enqueue in
  try/catch and returns `{status:'failed'}`; `twilio.ts:1271-1294` acts on it.
  TRUE.
- Broadcasts are not re-sendable (`broadcasts.ts:595` "Only a draft may be sent"),
  so a per-broadcast scalar cannot be poisoned by a second send. The spec never
  says this, but it is what makes the scalar safe. Worth a sentence.

That is an unusually high hit rate. The problems below are not in the citations;
they are in the INSTRUCTIONS.

---

## 1. [BLOCKING] Close A's new trigger is never stated, and Sec 3.5's literal instruction collapses the ladder to a single pass

**What is wrong.** Sec 3.5 says, of each continuation block: "delete the
`const nextAttempt = ... + 1` computation and the `if (nextAttempt > MAX_*)`
branch condition. The BODY of that branch survives as close A." Sec 3.6's table
then says close A is an "(existing body, NEW TRIGGER)" firing when "the send loop
ran and deferred recipients hit the cap".

**The new trigger is never written down anywhere in the document.** A builder
following Sec 3.5 literally deletes the condition, leaving the body to run
unconditionally inside `if (transientRemaining.length > 0)` - which means NO
continuation is ever enqueued and the ladder is one pass deep. That silently
halves-to-thirds the delivery rate for every transiently-failing recipient, and
`fanout_attempt` never exceeds 1, making the durable counter pointless.

The two self-consistent readings the builder must choose between produce
different systems:

- **A live:** close A fires when `claim.attempt >= cap`. Three send passes, close
  A ends the last one, no continuation. Then `capped` is never returned in normal
  operation and **close B is dead code** - contradicting Sec 3.6, which lists B
  as a live close, and Test 7, which calls B "the discriminating case".
- **A dead:** always enqueue the continuation; pass 4 claims, gets `capped`, and
  close B closes. Three send passes, same send count - but close A never fires,
  contradicting Sec 3.6's table, and the broadcast finalizes one backoff step
  (20s) later than on `main`.

**Evidence.** Spec Sec 3.5 vs Sec 3.6 table; `broadcastFanOut.ts:478-495`,
`relayFanOut.ts:569-582`.

**Implies.** This is the single most important behavioral decision in the branch
and it is underdetermined. Test 5 ("the chain walks 1, 2, 3 and closes at the
cap") would eventually catch the one-pass collapse, but a spec that needs a test
to disambiguate its own core loop is not buildable. State close A's trigger
condition as code, and say explicitly whether close B is reachable outside a
stray envelope.

## 2. [BLOCKING] `attempt: claim.attempt` shifts BOTH backoff ladders down one step - defeating Sec 3.7's own guarantee, and Test 6 cannot see it

**What is wrong.** Sec 3.5: "The enqueued payload's `attempt` field is set from
`claim.attempt` and is advisory - logged, and used to select the backoff step."
`claim.attempt` is defined in Sec 3.3 as the value returned by
`ReturnValues: 'UPDATED_NEW'` - i.e. THIS pass's number. Today the enqueued
`attempt` is `nextAttempt` = this pass + 1.

Consequences, tracing the mechanism rather than the intent:

- **relayFanOut.** Sec 3.7 says "Preserve relayFanOut's existing backoff exactly.
  **Do not change it.**" The LINE is unchanged - `fanOutBackoffMs(payload.attempt
  ?? 1)` (`relayFanOut.ts:595`) - but its INPUT is now one lower on every
  continuation. Today: 5s then 10s. After: 5s then 5s. Sec 3.7's guarantee is
  defeated by Sec 3.5's instruction; the two sections cannot both hold.
- **broadcastFanOut.** Sec 3.5 orders `nextAttempt` deleted but never says what
  `runAt` uses instead. `broadcastFanOut.ts:506` is
  `broadcastBackoffMs(nextAttempt)`, and the comment at `:503-506` is an explicit
  deliberate choice: "The continuation runs AS nextAttempt, so it waits ITS OWN
  backoff (attempt 1->2 waits the 2nd-step delay = 10s, 2->3 = 20s). Using the
  current attempt's delay here would under-wait by one step." Substituting
  `claim.attempt` does exactly what that comment forbids: 5s/10s instead of
  10s/20s. The spec reverses a documented decision without naming it.
- The payload field also stops meaning what
  `parseBroadcastSendPayload`/`parseRelayFanOutPayload` document it to mean
  ("1-based continuation attempt", `broadcastFanOut.ts:97-98`,
  `relayFanOut.ts:111`): a continuation about to run as pass 2 would declare
  `attempt: 1`.

**Evidence.** Spec Sec 3.5 vs Sec 3.7; `broadcastFanOut.ts:479, 496-507`,
`relayFanOut.ts:570, 583-596`.

**Implies.** Test 6 pins the total provider-send COUNT, not the delays, so this
regression ships green through the entire stated suite. Either write
`attempt: claim.attempt + 1` explicitly, or state that the backoff ladder is
deliberately being shortened and price it. Do not leave "set from `claim.attempt`"
standing beside "preserve the backoff exactly".

## 3. [BLOCKING] Sec 2's In-list omits all three files Sec 4.3 requires editing

**What is wrong.** Sec 2 "In" lists `services/groupRail.ts` as the only
rail-side file. Sec 4.3 then requires the ladder to be turned **on** at three
call sites, every one of which lives in a file Sec 2 does not name:

- `app/src/jobs/groupRail.ts:59`
- `app/src/lib/import/convertGroups.ts:598`
- `app/scripts/rail-verify.ts:198`

These are not incidental. Sec 4.3's whole design ("opt-in via a flag on
`GroupRailRequest`, default off, so caller identity is explicit") is unbuildable
without editing them. `convertGroups.ts` additionally RE-EXPORTS the request
type (`groupRail.ts:111-116` records the move and says convertGroups re-exports
it unchanged), so the interface change has a second file to land in.

**Evidence.** Spec Sec 2 "In" vs Sec 4.3 table; the five call sites verified by
grep.

**Implies.** A builder honouring Sec 2's fence cannot deliver Sec 4. Add the
three files to the In-list, or the reviewer at handback will read three
out-of-scope edits.

## 4. [HIGH] Sec 3.4's placement pseudocode is not implementable as drawn - close B needs an item the claim runs before

**What is wrong.** The pseudocode puts `claimFanoutPass` immediately after the
marker. In both handlers the item the close needs is loaded LATER:

- `broadcastFanOut.ts:236` - `broadcasts.getById` runs after the marker; close B
  must mark recipients, `bumpStats`, emit progress and `finalize()`, all of which
  need the broadcast.
- `relayFanOut.ts:357-390` - between the marker and the send loop sit FIVE
  early returns the spec never mentions: conversation not found (`:358`), group
  not open (`:368`), no pool number (`:376`), source message not found (`:386`),
  and nothing to relay (`:418-423`). The source message read at `:382-390` is
  what close B needs to decide which slots are still non-terminal.

"After the duplicate-delivery guard, before the send loop" spans ~200 lines and
six exits. The spec pins the two ENDS of that window with strong arguments and
says nothing about the interior, where the actual decision lives.

**Evidence.** Spec Sec 3.4 pseudocode vs `broadcastFanOut.ts:222-262`,
`relayFanOut.ts:343-443`.

**Implies.** Two builders will place it differently and both will believe they
followed the spec. Pin it: e.g. immediately after the item load and before the
recipient loop, with `missing` folded into the existing not-found return.

## 5. [HIGH] Close B's recipient set is undefined on a first-pass envelope

**What is wrong.** Sec 3.6 defines close B's recipient set as "the envelope's
`recipientKeys` still non-terminal". `recipientKeys` is OPTIONAL and ABSENT on a
first pass - it is documented as "Remaining contactKeys (continuation); absent =
all from the snapshot" (`broadcastFanOut.ts:95-96`) and "Absent = all non-sender
members" (`relayFanOut.ts:113-118`). On such an envelope close B has no set to
mark and would finalize with recipients still `queued` - precisely the "silent
false success" Sec 3.6 exists to prevent.

Reachable today: an envelope enqueued before this branch deployed, or any stray
first-pass envelope for an item whose counter is already at the cap. Sec 3.2
explicitly contemplates in-flight envelopes surviving the deploy.

**Evidence.** Spec Sec 3.6 table row B; `broadcastFanOut.ts:95-98, 252-257`,
`relayFanOut.ts:113-118, 434-438`.

**Implies.** Define close B's set as the resolved recipient list the handler
would have looped over (`keys` / `recipients`), not the raw envelope field.

## 6. [HIGH] The 50386/50437 "new handling" is a behavioral no-op, and the file that actually emits the measured noise is out of scope

**What is wrong.** Sec 4.2: "Repair refusals 50386/50437 are treated as
success-pending-re-read... An 'already exists' refusal is positive evidence the
member is attached, so it must not count as a repair failure; the authoritative
re-read that follows repair decides the outcome either way."

Read the repair path. `groupRail.ts:522-540`: the `failures` returned by
`addParticipants` are ONLY logged as `group_rail_repair_partial`; they do not
gate anything. The outcome is decided by the re-read at `:538-540` and the check
at `:552`. So "must not count as a repair failure" is **already how the code
behaves**, and "the re-read decides either way" is a restatement of the existing
mechanism. Implemented literally, the change is a log-level edit.

Worse, the 178 refusals Sec 4.1 offers as measured evidence are logged as
`group_rail_participant_add_failed`, which is emitted at
`adapters/groupConversations.ts:563-566`, inside the shared `attach()` helper
used by BOTH `createWithIndividualAdds` and `addParticipants`. Sec 2's In-list
does not contain `app/src/adapters/groupConversations.ts`. The noise the spec
cites cannot be quieted from any file the spec puts in scope.

**Evidence.** Spec Sec 4.1-4.2; `groupRail.ts:522-540, 552-560`;
`groupConversations.ts:545-570, 572-583`.

**Implies.** Either say what OBSERVABLE changes (a downgraded/annotated log line
in `groupRail.ts`, and nothing else), or bring the adapter into scope. As
written, Test 11's "50386/50437 during repair is not counted a failure" asserts
behavior that already passes on `main`, which makes it a test that proves
nothing.

## 7. [HIGH] Unenumerated reader: for BROADCASTS, `transient_cap` / `enqueue_failed` render only through `DeliveryBadge`, which Sec 5 marks "unchanged"

**What is wrong.** Sec 5.2 says the two internal codes "render in BOTH positions
from one string, so each must read correctly as a rollup summary and on a single
recipient's row", and Test 10 asserts exactly those two positions. Both are
RELAY surfaces (`presentRelayDelivery` at `deliveryStatus.ts:416`, the per-row
call at `Timeline.tsx:1045`).

A BROADCAST recipient slot never reaches either. Broadcast recipients render
through `BroadcastResults.tsx:58` -> `DeliveryBadge.tsx:29-37` ->
`deliveryReason(errorCode)`. That is a THIRD position, and for broadcasts it is
the ONLY position. Sec 5's call-site table lists `DeliveryBadge.tsx:31` as
"**unchanged**" - true of the 30003 override, misleading about the internal
codes, whose output there changes from `Delivery failed (error transient_cap)` to
the new prose.

This is the headline surface for close C: the dead-queue scenario Sec 3.6
invents `enqueue_failed` for is a BROADCAST scenario (`broadcastFanOut` is the
one with `finalize()` and a results page). Test 10 does not cover it.

**Evidence.** Spec Sec 5 table, Sec 5.2, Test 10; `DeliveryBadge.tsx:29-37`,
`BroadcastResults.tsx:58`; `broadcastFanOut.ts:482` (`transient_cap` on a
broadcast slot).

**Implies.** The copy constraint is a THREE-position constraint. Note also that
`DeliveryBadge` renders `{label} - {reason}` with its own separator (`:35`), so
the string has to read after a status label as well as standing alone. Extend
Test 10 to the badge.

## 8. [MEDIUM] `rosterKind === 'relay'` is a DEFAULT, not a discriminator

**What is wrong.** Sec 5.1 keys the 30003 override on `rosterKind === 'relay'`
and states firmly that native group text is excluded. But `rosterKind` is
optional with a `'relay'` default: `MessageBubble` declares
`rosterKind = 'relay'` (`Timeline.tsx:796`) and `TimelineProps.rosterKind` is
optional (`:310`). Of the five production `<Timeline>` render sites -
`ContactCommsPane.tsx:319`, `ConversationDetail.tsx:480`,
`GroupTextView.tsx:448`, `PlacementConversation.tsx:320`,
`TourConversation.tsx:467` - exactly ONE passes it
(`GroupTextView.tsx:461`, `rosterKind="group_text"`).

So the guarantee "group text is not included" is delivered by "exactly one caller
opts out today", not by a discriminator. Any new group-text render site inherits
the false `Phone unreachable` copy silently, for a product whose 30003 retry is
real (`twilio.ts:2553-2572`). Test 13 as written checks the 1:1 bubble, the
EmailCard and the broadcast badge - it never renders a group-text 30003 leg, so
nothing pins the exclusion the section spends a paragraph justifying.

**Evidence.** Spec Sec 5.1 and Test 13; `Timeline.tsx:310, 796`;
`GroupTextView.tsx:461`; the five render sites above.

**Implies.** Add a group-text 30003 leg to Test 13. Consider whether the safer
key is `rosterKind !== 'group_text'` inverted, i.e. make the override require an
explicitly-passed `'relay'`.

## 9. [MEDIUM] Sec 4.2's ladder is scoped to "created in THIS call" while the same propagation window is live on the adopt path and on the author check

**What is wrong.** Three related gaps:

1. On the create path the participant list is already a READ-BACK done inside the
   adapter (`groupConversations.ts:480` and `:540` both call
   `fetchParticipants` immediately after create). So "re-read up to 2 more times"
   means the adapter's read plus two more - fine, but the spec's framing implies
   an initial read that groupRail itself performs, and it does not (`groupRail.ts:492`
   is `participants ??= ...`, skipped entirely on the create path).
2. The ADOPT path reads at `groupRail.ts:492` and is equally exposed to a rail
   created seconds earlier by a crashed claimant. Sec 4.2 excludes it with no
   argument.
3. The spec never says whether the ladder's re-read also replaces `participants`
   for the AUTHOR verification at `groupRail.ts:578-584`. That block's own
   comment (`:573-577`) says it deliberately compensates for the SAME propagation
   window ("the async binding propagation that makes fresh reads roster-incomplete
   (rail-binding-propagation-retry) applies to the projected one too"). Two
   mechanisms now compensate for one window, and their interaction is
   unspecified. Sec 4.4's "Unchanged" list does not mention the author check
   either way.

**Evidence.** Spec Sec 4.2, 4.4; `groupConversations.ts:474-486, 539-541`;
`groupRail.ts:491-501, 506-507, 562-584`.

**Implies.** Say which variable the ladder writes back into, and whether the
author check reads the laddered value.

## 10. [MEDIUM] Test 3's "Must fail on `main`" is asserted but the seam it needs is not identified

**What is wrong.** Test 3 stubs `enqueue` to throw. `enqueue` is a module import
in both handlers (`broadcastFanOut.ts:74`, `relayFanOut.ts:47`) - it is not on
`BroadcastSendJobDeps` / `RelayFanOutJobDeps`, so there is no injection seam. The
test needs `vi.mock` of `./jobs.js`, which also mocks `defineJobHandler` in the
same module and therefore has to be built carefully. The spec asserts the test's
verdict against `main` without naming how it is armed - while going to
considerable trouble, correctly, to explain why the E2E version is impossible.

**Evidence.** Spec Test 3 and Test 14's note; `broadcastFanOut.ts:74, 184-195`,
`relayFanOut.ts:47, 316-328`.

**Implies.** One sentence naming the mocking approach saves a builder an hour and
prevents a "cannot stub enqueue, skipping" outcome on the test that is the whole
point of close C.

## 11. [LOW] Sec 3.2 understates the in-flight case: a surviving envelope EXTENDS its ladder

**What is wrong.** "In-flight envelopes carrying `attempt: N` still parse; N
selects the backoff step only." True, but the consequence is unstated: a
pre-deploy envelope that had already burned two rungs claims at 1 against a fresh
`fanout_attempt`, so that work gets up to three MORE passes. Harmless
(bounded, no duplicate sends - terminal slots are skipped) but it is the one
window where close B is genuinely reachable, which bears on finding 1.

**Evidence.** Spec Sec 3.2; `broadcastFanOut.ts:109-110`, `relayFanOut.ts:139-142`.

## 12. [LOW] Two small accuracy slips

- Sec 5.1 quotes `ERROR_CODE_REASONS['30003']` as `'Phone unreachable - will
  retry'` with an ASCII hyphen. The live string uses an EM DASH
  (`deliveryStatus.ts:544`). Irrelevant to the fix (the replacement copy is
  ASCII) but a builder grepping the literal will miss it.
- Sec 2 carries "Cameron authorized this file on 2026-09-01" inside a document
  named `2026-08-31-...` and cut from `main@5ce9912f`. Not wrong today, but a
  spec that dates an authorization AFTER its own filename invites the question
  of which sections were edited later - and this document's stated failure mode
  (Sec 0) is "two sections disagreeing after one of them was edited". Findings 1
  and 2 are exactly that shape.

---

## What I could NOT verify

- The 2026-08-13 migration numbers (81 / 178 / 2) in Sec 4.1. The event names are
  real (`group_rail_participants_incomplete` at `groupRail.ts:519`,
  `group_rail_participant_add_failed` at `groupConversations.ts:564`,
  `rail_failed` via `recordRailFailure`), but the counts are from logs I do not
  have. UNVERIFIED.
- Twilio's actual semantics for 50386/50437. Neither code appears anywhere in the
  tree, as Sec 4.2 says. UNVERIFIED.
- Whether `ADD` under an SDK transport retry can double-increment in practice
  (Sec 3.3's accepted risk). UNVERIFIED - but the reasoning is sound and the
  stated consequence (a shortened ladder, never a duplicate send) is right given
  the terminal-slot skip.
