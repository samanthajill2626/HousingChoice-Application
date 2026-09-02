# Spec review R4-B (adversarial, confirmation pass) - relay 30003 retry lineage, rev 4

Spec: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 4)
Adjudications read: `spec-r1-`, `spec-r2-`, `spec-r3-adjudications.md`.
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

**Headline: I found nothing that reopens an architectural decision, and I agree
with the convergence reading.** The proof is in the last section - I re-tested the
five load-bearing guarantees against revision 4's mechanisms and all five hold.
Every finding below is a seam, a stale sentence, or an instruction a builder
cannot execute as written. Three of them (1, 2, 3) would each produce a real
defect if built literally, so they are HIGH; none of them changes what the design
IS.

---

## 1. [HIGH] [WORDING] D8 tells the builder to call `getMessageConsistent`, which is not on the repo interface

**What is wrong.** D8's consistent-read bullet says "Use `getMessageConsistent`
(`:1885`), which exists for exactly this and which six sibling mutators already
establish the precedent for." The webhook cannot call it.

**Evidence.** `getMessageConsistent` is a plain closure declared inside the
`createMessagesRepo` factory at `app/src/repos/messagesRepo.ts:1885-1897`, above
the `return {` at `:2085`. It is not a property of the returned object, and the
`MessagesRepo` interface exposes only `getByProviderSid` (`:1201`),
`getByTsMsgId` (`:1339`, eventually consistent - `:2960-2965`) and
`getManyByTsMsgIds` (`:1345`). Its six existing uses (`:3017`, `:3085`, `:3136`,
`:3196`, `:3238`, `:3366`) are all INSIDE the factory. `twilio.ts` holds a
`MessagesRepo`.

**What it implies.** The fix for round 3's BLOCKING finding is not executable as
written. The builder has to add something - a new interface method
(`getByTsMsgIdConsistent`), an options argument on `getByTsMsgId`, or the
alternative round 3 offered (have `updateRecipientDeliveryStatus` return the
effective post-write `{status, errorCode}` instead of a boolean, which is
race-free without any read at all). Any of the three is fine and all are in scope
(`messagesRepo.ts` is on the In-list), but the spec must pick one, because "call
this private function" is the one option that does not exist. A builder who does
not notice will reach for `getByTsMsgId` and reintroduce exactly the
load-dependent dropped retry D8 was rewritten to prevent.

Recommendation: state the third option. It removes a read from the hot webhook
path, and the repo call already holds both the pre-write slot (`:3447-3451`) and
what it wrote, so the answer is exact rather than merely consistent.

## 2. [HIGH] [WORDING] D2 now contradicts itself about the retry row's transport schema, and one reading throws on the first send

**What is wrong.** Revision 4 added a fourth paragraph to D2 ("The retry row's
transport MODE follows the ORIGINAL's, and the original can be LEGACY") without
editing the first, which still states the row's schema unconditionally.

**Evidence.** D2 paragraph 1 (spec lines 129-132): "An inbound row carries
`transportSchemaVersion: 1` and NO `requestedTransport`". D2 paragraph 4 (lines
151-160): "versioned original, versioned slot with `planned`; legacy original,
legacy slot and no aggregation state." For a legacy inbound original those cannot
both hold, and the two mismatches are not symmetric:

- Row says schema 1, job runs LEGACY mode: `persistRelayRecipientResult` takes the
  `markRecipient` branch (`relayFanOut.ts:1436-1439`) and blind-writes the slot
  (`:1450-1463`), so no throw - but the row advertises schema 1 while its slot
  carries no transport facts, and the dashboard gates on exactly that flag
  (`Timeline.tsx:1118-1119`), so `presentRecipientTransport` falls to its
  `'Unknown'` tail (`dashboard/src/lib/messageTransport.ts:66-76`). The retry
  bubble's row reads `... - Unknown` where the original's reads nothing.
- Row says legacy, job runs VERSIONED mode: `applyRecipientSendResult` returns
  `legacy_noop` on the schema check (`messagesRepo.ts:3240`) and
  `persistRelayRecipientResult` THROWS (`relayFanOut.ts:1436-1439`). That is the
  same first-send throw round 3's finding 3 existed to close, arriving through the
  fix for finding 5.

**What it implies.** One sentence resolves it: paragraph 1's schema claim is a
description of TODAY's inbound relay source (`twilio.ts:636-650`), not a mandate
for the retry row, and paragraph 4 governs. Say so, and make paragraph 1's
`requestedTransport` prohibition explicitly conditional on the versioned branch.
As it stands a builder reading top-down implements paragraph 1 and hits the throw
on the first retry of any pre-2026-09-02 relay message - which D2's own new
paragraph calls "the ordinary case, not an edge one".

## 3. [HIGH] [WORDING] "The projection happens ONCE, at thread level" invites a memo that freezes the time-derived half, restoring both failures D18's ticker clause was added to prevent

**What is wrong.** D18 and D19 both say the join is computed ONCE at thread level
and passed down. The join's output includes `unconfirmed`, which is a function of
the CURRENT TIME. Nothing says what the computation depends on, and the natural
React shape freezes it.

**Evidence.**

- The two established memos in that component are `visible =
  useMemo(..., [items, commsOnly])` (`Timeline.tsx:1788-1800`) and `tickerArmed =
  useMemo(..., [visible, tickNow])` (`:1851-1854`). D20 puts its filter in the
  first. A thread-level join written as its sibling takes `[items]`.
- `unconfirmed` is defined against `STALE_SENT_AFTER_MS` from the retry row's `at`
  or its `sentAt` (D18), i.e. against a clock, and the only clock that advances in
  this component is `tickNow` (`:1844-1849`, `:1856-1875`).
- With the join memoized on `[items]`: `tickNow` advances, bubbles re-render, but
  the joined state stays `retrying`. The display never reaches `unconfirmed`, AND
  `hasTickableLeg`'s new retry clause keeps reading `retrying`, so `tickerArmed`
  never flips false and the interval runs for the life of the mount.

**What it implies.** Both failure modes D18 was rewritten to close come back
together, silently, from a memo dependency array. The spec must say that the join
has two parts with different lifetimes: the LINEAGE part (which member key has
which retry rows, and their stored outcomes) depends on `items`, and the
CLASSIFICATION into `retrying`/`unconfirmed` depends on `tickNow` as well. Either
thread `tickNow` into the join's deps, or keep the join lineage-only and classify
at the point of use where `tickNow` is already in scope. "ONCE" is precisely the
wrong word for the half that has to be recomputed on every tick.

## 4. [MEDIUM] [WORDING] D19's closing paragraph still points the builder back at the `status` overload the same decision forbids 40 lines earlier

**What is wrong.** Revision 4 inserted the `retryState`-is-a-separate-field
paragraph (spec lines 530-537) but left the paragraph that closes the row/recital
grammar table unedited.

**Evidence.** Spec line 567: "The projected `{status, errorCode}` of D19 is what
gives them an input they can express." The table immediately above it requires the
row to render `Retrying - Phone unreachable (error 30003)` and `Delivered on
retry`, and the new paragraph at `:530-537` establishes that `status` cannot carry
either - `DeliveryStatus` is closed (`messagesRepo.ts:120-126`) and
`presentDeliveryStatus` returns null outside it (`deliveryStatus.ts:139-141`).
The input that gives those two positions expressiveness is `retryState`, not
`{status, errorCode}`.

**What it implies.** The sentence a builder reads LAST, immediately after the
table it is implementing, names the exact mechanism the decision forbids. Change
`{status, errorCode}` to `retryState` there. (Related and cosmetic: the same edit
left "This is not a convenience:" dangling mid-line off the `retryState` sentence
at `:537`, where it originally introduced the five-sites argument.)

## 5. [MEDIUM] [WORDING] D19 specifies only single-state chip strings; a bubble with a failed leg AND a retrying leg has no specified copy

**What is wrong.** D19's table gives one chip string per retry state, as if a
bubble had one non-delivered leg. A relay message can easily have several members
in different states, and the presenter already composes two categories.

**Evidence.** `presentRelayDelivery` composes today at
`deliveryStatus.ts:433-436`: `delivered N/M - K failed, J not confirmed` when
`stale > 0`, else `delivered N/M - K failed`. D19 adds a third non-delivered
category (`retrying`) and a fourth counting rule, so up to three can co-occur.
A reachable case: four members, A and D delivered, B failed 30003 with a live
retry, C failed 30005 (which claims nothing - D8 gates on 30003). That is
`delivered 2/4`, `failed 1`, `retrying 1`, and the spec says nothing about the
order of the clauses, the separator, which reason is appended, or the tone.

**What it implies.** A builder invents the composition, and the accessible-name
recital derives from the same string via `chipText` + `speakDeliveryText`
(`Timeline.tsx:536-540`, `:544-546`), so an invented ordering propagates to the
screen-reader surface too. One sentence fixing the clause order and the reason
attribution is enough; without it, test intention 12 ("all four states of D19 at
EVERY position") has no defined answer for the mixed case.

## 6. [MEDIUM] [WORDING] D15 is titled "The close codes are enumerated" and enumerates none

**What is wrong.** D15 promises that every close code this design introduces gets
an `INTERNAL_CODE_REASONS` entry with its copy. It names no tokens and writes no
copy.

**Evidence.** D9 names four distinct gates ("the group is still open; the member
is still on the roster and the digest ... matches; the member is not suppressed or
opted out") and requires "a close code naming the gate that refused" - so four new
tokens. `INTERNAL_CODE_REASONS` (`deliveryStatus.ts:688-692`) currently holds
`contact_opted_out`, `transient_cap` and `enqueue_failed`; anything unmapped falls
to `Delivery failed (error <token>)` (`:731-733`), the defect D15 exists to
prevent.

**What it implies.** Two things a builder must invent. First the tokens. Second -
and this is the part that should not be invented - four strings of
OPERATOR-FACING copy, which is the same class of decision as the D19 grammar
table the spec does write out. Worth noting alongside it: D14 needs NO new code at
all, because `enqueue_failed` and `transient_cap` are already distinct in that map
and already carry the exact rationale D14 restates ("reusing the cap's wording for
a scheduling failure would tell an operator retries ran when none did",
`deliveryStatus.ts:671-681`). So the enumeration owed is exactly four rows.

## 7. [MEDIUM] [WORDING] D23's founder-facing sign-off sentence contradicts the middle-case paragraph revision 4 added above it

**What is wrong.** Revision 4 added "A fan-out or team leg that ends terminally
logs ERROR whether or not a ladder ran" (spec lines 619-624) and left the sign-off
paragraph unedited.

**Evidence.** Spec line 653-654: "Announcement legs and 21610 opt-outs are
excluded, so the increase is bounded to the legs a retry ladder actually ran for."
The new paragraph explicitly widens the set to legs where no ladder ran - a claim
declined for a missing `To` (D5) or an unreadable source row (D7). Both sentences
are in the same section and only one can be true.

**What it implies.** This is the sentence the founder reads when approving the
alarm-volume increase, and it now understates the set the paragraph above it just
widened. Replace "the legs a retry ladder actually ran for" with the set the new
paragraph defines: every terminally undelivered fan-out or team leg, ladder or no
ladder, excluding announcements and 21610.

## 8. [MEDIUM] [WORDING] Three decisions added in revision 4 have no test intention

**What is wrong.** Sec 7 was renumbered in revision 4 but not extended, so the
three mechanisms revision 4 introduced are unproven by the list.

**Evidence and what each needs.**

- **D8's "slot code 30003 or ABSENT" clause.** This is the whole repair for round
  3's finding 6 and it is reachable in production: `mapTwilioStatus` maps
  `canceled` to `failed` (`app/src/adapters/messaging.ts:567-569`) and such a
  callback carries no `ErrorCode` (the handler says so at `twilio.ts:2693-2698`),
  which makes the slot terminal and then blocks the 30003 callback's write
  (`messagesRepo.ts:3459-3466`, `:3477-3481`). No test intention covers a
  code-less terminal callback arriving first. Red looks like: no claim.
- **D2's legacy-mode mirroring.** Every pre-2026-09-02 relay source is legacy and
  D2 calls this the ordinary case, but no test intention drives a retry off a
  legacy original. Red looks like the throw in finding 2.
- **The ticker's TERMINATION.** Test 15 proves `unconfirmed` APPEARS; nothing
  proves the interval STOPS. `hasTickableLeg`'s docblock is the record of four
  shipped non-terminations and states that the flip to false IS the proof
  (`Timeline.tsx:788-812`, `:1801-1815`). A test that asserts the state and not
  the disarm leaves the fifth undetected.

**What it implies.** Three intentions, one line each. Without them a build can
satisfy every listed test and still ship all three defects.

## 9. [LOW] [WORDING] D19 says "five places" and lists four

Revision 4 correctly removed the message-level chip from the consumer list (it is
excluded by Sec 5 and unreachable for any retry state - it needs every leg
`contact_opted_out`, and an opted-out leg has no `relaysid#` pointer, so it can
carry no retry). The count in the preceding sentence was not updated: spec lines
538-541 say "derived INDEPENDENTLY in five places" and then name four - the rollup
chip's reason, the rollup's accessible name, the inbound recital, and the
per-recipient row. The "three of which read `row.slot.errorCode` directly" that
follows is correct for four.

## 10. [LOW] [WORDING] Test intention 4 still calls the source-read miss "the fail-open case"

Spec line 673: "AND a callback whose source row cannot be read claims nothing (the
fail-open case)." D7 makes the fence POSITIVE, so that case now fails CLOSED - the
label is inherited from revision 1, when the defect was that the fence let such a
callback through. The test is right; the parenthetical describes the bug rather
than the behaviour, which is how a later reader concludes the test is asserting
the wrong thing.

## 11. [LOW] [WORDING] The E2E paragraph renders inside test intention 16

The renumbering edit removed the blank line between spec line 712 (the last line
of item 16) and line 713 (`**E2E (hermetic).**`). Under Markdown's lazy
continuation the whole E2E block, including the backoff-injection paragraph, is
absorbed into list item 16. Cosmetic in a text editor, invisible-and-wrong
everywhere the spec is rendered.

## 12. [LOW] [WORDING] Sec 8's "no environment work" contradicts Sec 2 and Sec 7

Sec 8 opens "No infrastructure, dependency, environment or migration work" (spec
line 731). Sec 2's In-list includes "`app/src/routes/dev.ts` and the e2e lane env
- the backoff injection seam" (line 66) and Sec 7 has the lane supplying the
backoff value (lines 722-727). Sec 8 is an unedited paragraph from revision 1,
before the backoff seam existed. It is the paragraph a handback checklist reads,
so it should say "no PRODUCTION environment work; the e2e lane supplies a backoff
override".

---

## Buildability assessment

Could someone who has never seen this conversation build it? **Yes, with the
twelve corrections above and one caveat.** I walked the document as a builder
would and these are the only places I would have to stop and ask:

- Finding 1 (which read), finding 2 (which schema), finding 3 (what the join
  depends on), finding 5 (multi-state chip copy) and finding 6 (four close-code
  tokens and their copy) are the five real stops. The rest I could work around
  from context.
- Everything else a builder needs is now present and specific: the SID shape and
  digest width (D3), the seeded slot (D2), the two guards and which duplicate each
  defeats (D3/D4), the gate's three parts (D8), the four transient-ladder parts
  (D10), the five stored and four wire fields (D11), the media-pointer suppression
  (D13), the four live-surface effects decided one at a time (D16), the two halves
  of `unconfirmed` (D18), the arithmetic and both grammar tables (D19), where the
  filter lives (D20), and the severity split by product (D23).
- Plan-level things left open are appropriately left open: the job name, the repo
  method names, the field names on the row. Those are the plan's job and the spec
  says so.

On Sec 7 specifically: with finding 8's three additions, every intention has a
statable red. Intentions 15 and 16 are unusually good - both name the failure mode
explicitly ("Freezing the ticker is the failure mode; a test that lets another leg
age proves nothing"; "A transition gate would fail this test, which is why it
exists"), which is exactly what makes a test intention buildable rather than
decorative.

## Guarantees re-tested against revision 4's mechanisms

| Guarantee | Verdict |
|---|---|
| A duplicate CALLBACK cannot produce a duplicate send | HOLDS. `append`'s index-1 `sid#` pointer (`messagesRepo.ts:2295-2306`) loses the create; the same root, destination and attempt give the same digest. |
| A duplicate QUEUE DELIVERY cannot produce a duplicate send | HOLDS. D4's marker, plus the extracted body's terminal-slot skip (`relayFanOut.ts:1120-1121`, `isTerminal` at `:188-190`). |
| Announcements and tour-reminder rungs cannot be reached | HOLDS. D7's positive fence; every relay source that can carry a pointer carries a `relay_sender_key` (`twilio.ts:646`, `api.ts:1726`/`:1818`, `relayAnnouncements.ts:239`). |
| A late callback cannot regress a delivered retry | HOLDS. Each rung owns its own row and slot; an older attempt's SID resolves to its own `relaysid#` pointer. |
| The display can never promise a retry indefinitely | HOLDS ON PAPER, conditional on finding 3. Both halves of `unconfirmed` are now specified and bound the ticker clause; a `[items]`-only memo undoes both. |
| The state gate claims exactly the reachable 30003 failures | HOLDS. I re-attacked it with the `canceled`-first case now that `mapTwilioStatus` confirms `canceled -> failed` (`messaging.ts:567-569`): the ABSENT clause admits it, and the 30007 case stays closed because that slot's code is neither 30003 nor absent. I found no path to a wrong claim. |
| The retry never texts a member the fan-out already closed | HOLDS. Those legs write no `relaysid#` pointer (`relayFanOut.ts:1263-1267` is the only pointer write on the fan-out path), so no callback can resolve to them. |

## On the convergence call

**I agree with it, and nothing in this round argues otherwise.** Rounds 1 and 2
changed what the design IS - a new row rather than a promoted slot, two guards
rather than one, a contract that exists on the inbound case at all. Round 3
changed which function to call and which field to put a value in. Round 4 found no
mechanism that is wrong, no invariant with an unenumerated writer or reader, and
no guarantee whose mechanism cannot deliver it. What it found is a document that
was edited seven times in four days: three paragraphs that now disagree with the
neighbours they were inserted beside (findings 2, 4, 7), one instruction naming a
symbol that is not in scope (finding 1), one word ("ONCE") that misdescribes a
computation with two lifetimes (finding 3), and five gaps a careful builder would
otherwise have to fill by guessing (findings 5, 6, 8, 10, 12).

**No finding in this round changes a decision.** Stated plainly, as asked: the
design does not need to go to the founder as an open decision on my account. It
needs a copy-edit pass against this list, and the alarm-volume sign-off D23 has
been asking for since revision 1 - with finding 7's sentence corrected first, so
the founder is approving the set the design actually produces.

## Disagreements with the adjudications

None remaining. I accepted every round-3 adjudication as applied, including the
two where the remedy differed from mine - the transport mode mirroring the
ORIGINAL rather than the retry row (adjudication 5, which is the better call: it
keeps the row and the mode in agreement instead of forcing every legacy original
through a versioned path), and the decision that declined claims log ERROR
(adjudication 8, which follows from D23's own "real dead end for a real tenant"
argument more cleanly than my hedge did).
