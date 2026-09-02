# R9 final cold pass - retry-counter-durable design spec

Third rewrite of Sec 3, second of Sec 4. Read both cold and in full, then traced
against the two handlers line by line. I did not re-verify the ~25 citations
confirmed in R8 unless the surrounding text changed.

Answering the coordinator's three priorities up front, because two of them are
SOUND and saying so plainly is more useful than hedging.

---

## Priority 2 - the arithmetic. SOUND. Traced both files, both metrics.

Sec 3.5's four-row table produces EXACTLY `main`'s pass count and `main`'s
delays. I walked it rung by rung.

**broadcastFanOut.** `main` (`:479-507`): pass 1 `payload.attempt=1`,
`nextAttempt=2`, `2>3` false, `enqueue(attempt:2, runAt=broadcastBackoffMs(2)=10s)`;
pass 2 -> `attempt:3, 20s`; pass 3 `nextAttempt=4>3` -> cap branch. Three send
passes, delays 10s/20s.
After: `claim.attempt` = 1,2,3; `nextAttempt = claim.attempt+1` = 2,3,4;
`broadcastBackoffMs(nextAttempt)` = 10s, 20s; close A at `claim.attempt>=3` on
pass 3. **Identical.**

**relayFanOut.** `main` (`:570-596`): pass 1 `fanOutBackoffMs(payload.attempt ?? 1)`
= `fanOutBackoffMs(1)` = 5s; pass 2 = 10s; pass 3 `nextAttempt=4>3` -> cap
branch. Three send passes, delays 5s/10s.
After: `fanOutBackoffMs(claim.attempt)` = 5s, 10s; close A on pass 3.
**Identical.**

The table's premise - `claim.attempt` is the current pass number, "identical to
today's `payload.attempt ?? 1`" - holds because the counter is fresh per item and
every pass claims exactly once. The one exception is named honestly in Sec 3.2
(an envelope crossing the deploy), and I flag its interaction with Test 6a as
finding 12.

Sec 3.5 correctly identifies that the two files pass deliberately different
arguments and that collapsing them to one form is the likely error. Test 6a is
the right test. This section is now correct, and it is the part I was most
worried about.

## Priority 3 - "the guards load what close B needs". TRUE for the ROW in both files. FALSE for the RECIPIENT SET in relayFanOut. See finding 2.

- `broadcastFanOut.ts:236-240` loads the broadcast before anything else. Close B's
  row, recipient map, stats and `finalize()` target are all available. **True.**
- `relayFanOut.ts:357, 382-390` load the conversation and the source message
  before the send loop. The ROW is available. **True.**
- But close B's fallback set - "every recipient on the loaded row still in a
  non-terminal state" - is derived from `delivery_recipients`, and on the relay
  INBOUND path that map is seeded **empty**. The recipient identities live on the
  CONVERSATION roster (`relayFanOut.ts:400`), filtered at `:434-438` - **below
  every one of the five guards**. Finding 2.

## Priority 1 - did this rewrite introduce a new blocking defect? Yes, two.

---

## 1. [BLOCKING] Sec 3.5's replacement snippet drops broadcastFanOut's `return` after a successful enqueue - the broadcast is marked Sent while a continuation is still pending

**What is wrong.** Sec 3.5 presents this as the continuation block, i.e. as the
code that replaces the deleted `if`:

```
if (transientRemaining.length > 0) {
  if (claim.attempt >= CAP) { await closeA(transientRemaining); return; }
  await enqueue(... nextAttempt ... backoff as above ...);   // may throw -> close C
}
```

There is no `return` after the enqueue and none at the end of the block. In
`broadcastFanOut` the very next statement is `await finalize(...)`
(`broadcastFanOut.ts:513`). `main` prevents exactly this with an explicit
`return` at `:508-509`, carrying the comment **"A continuation is still pending
- do NOT finalize yet."** The snippet deletes it.

Applied literally, every broadcast with a transient failure is finalized on pass
1: `finalize()` (`:549-583`) reads the row, computes
`allFailed = fresh.stats.failed >= total` (false - the deferred recipients are
still `queued`, not failed), and calls `markSent()`. The dashboard shows the
broadcast **Sent** while its deferred recipients sit `queued` and a continuation
is in flight - and then the continuation sends to them anyway, after the row
already said it was done. It also fires the `broadcast_sent` unit audit
(`:565-571`) and the terminal SSE emit a pass early.

Sec 3.6 names this exact outcome as the thing the design exists to avoid:
"would mark the broadcast **sent while its recipients are still `queued`** - a
silent false success, worse than the hang."

`relayFanOut` is unaffected - the block is the last statement in its handler
(`:597-598`) - which is precisely why a snippet written to cover both files hides
the bug.

**Evidence.** Spec Sec 3.5 snippet; `broadcastFanOut.ts:496-513` (note `:508-509`);
`relayFanOut.ts:583-598`.

**Implies.** Not caught by any stated test. Test 6 counts sends (unchanged),
Test 6a checks `runAt` (unchanged), Test 5 walks `fanout_attempt` 1/2/3
(unchanged), Test 4 asserts the row leaves "Sending" on the close-C path (it
does - just early). Add the `return` to the snippet, and state that in
`broadcastFanOut` every one of A, B, C and the enqueue path returns before the
tail `finalize()`.

## 2. [BLOCKING] Close B's fallback recipient set is EMPTY on a relay inbound source message

**What is wrong.** Sec 3.6: "Close B marks: `payload.recipientKeys` when present,
otherwise **every recipient on the loaded row still in a non-terminal state**."
Test 7a pins it.

For `relayFanOut` the "loaded row" is the source message, and the recipient set
would have to come from `sourceMessage.delivery_recipients`. On the relay INBOUND
path that map is seeded **empty**. `messagesRepo.ts:2768-2771` says so directly:

> "The parent `delivery_recipients` map is always pre-seeded on the source
> message at append time (team-send seeds per-member 'queued'; **the relay
> inbound path seeds an empty map**)"

and the append confirms it - `messagesRepo.ts:1925-1929`, "Seed the per-recipient
delivery map (**possibly empty**) so the fan-out's child-only
setRecipientDelivery has a parent map to write into."

So on the dominant relay case (a member's inbound text, producer
`twilio.ts:693-698`), a first-pass envelope carries no `recipientKeys` AND the row
carries no recipient keys either. Close B's fallback iterates an empty map and
**marks nothing** - the precise stuck-row failure Sec 3.6's own paragraph says it
exists to prevent ("A close that marked nothing on a first-pass envelope would
leave the exact stuck row this branch exists to prevent").

The correct relay set is the CONVERSATION roster minus the sender -
`roster = conversation.participants` (`relayFanOut.ts:400`), filtered to
non-sender and then by `recipientKeys` (`:434-438`) - intersected with
non-terminal slots. That derivation sits BELOW all five guards, so Sec 3.4's
"the guards have already loaded it" does not cover it.

Note the asymmetry that makes this easy to miss: for `broadcastFanOut` the
fallback IS correct, because `broadcast.recipients` is pre-seeded with every
contactKey by `markSending` (`broadcastsRepo.ts:586-588` records the invariant),
and `keys` is derived from it at `:252-256`. One file's fallback works; the
other's does not.

**Evidence.** Spec Sec 3.6 close-B paragraph and Test 7a;
`messagesRepo.ts:1925-1929, 2768-2771`; `relayFanOut.ts:400, 434-438`;
`twilio.ts:693-698`; `broadcastFanOut.ts:252-256`.

**Implies.** Test 7a as written will pass against a TEAM-SEND fixture (map
pre-seeded per member) and prove nothing about the inbound path. Specify close
B's set per file: broadcast = non-terminal entries of `broadcast.recipients`;
relay = the resolved `recipients` list whose slot is non-terminal. And pin Test
7a on a relay INBOUND fixture specifically.

## 3. [HIGH] Sec 4 now contradicts itself three ways about which read-back ladders, and Test 11 asserts both sides

**What is wrong.** Three statements that cannot all hold:

- Sec 4.2 para 1: the ladder applies "On a rail created in THIS call whose map is
  short".
- Sec 4.2 para 4 (new): "The ladder applies to BOTH read-backs" - the create read
  and the POST-REPAIR read - "Both get it, with the same bounds."
- Sec 4.4 (new): "**The adopt path faces the same propagation window and does NOT
  get the ladder.**"

The post-repair read is `groupRail.ts:538-540`, inside the repair block
`:517-550`. That block is **not gated on `wasAdopted`** - it runs for an adopted
rail exactly as for a created one. So laddering the post-repair read either
(a) ladders adopted rails too, falsifying Sec 4.4, or (b) is gated on
`wasAdopted`, in which case an adopted rail that enters repair keeps producing
the false `rail_failed` at `:552-559` that Sec 4.2 calls "the headline symptom".

Test 11 asserts both halves in one line: "**the POST-REPAIR read also ladders**
... the adopt path is unchanged."

**Evidence.** Spec Sec 4.2, 4.4, Test 11; `groupRail.ts:452-464` (`wasAdopted`
set), `:517-550` (repair block, ungated), `:552-559` (`rail_failed`).

**Implies.** Pick one and say it as a predicate the builder can write:
e.g. "ladder both reads when `!wasAdopted`", or "ladder the create read when
`!wasAdopted` and the post-repair read unconditionally". As written the builder
must guess, and Test 11 will contradict whichever guess they make.

## 4. [HIGH] 50386/50437 handling was removed in Sec 4.2 but Sec 4.3 and Test 12 still require it

**What is wrong.** Sec 4.2 now says, correctly and for the reasons I gave in R8:
"**50386/50437 handling is deliberately NOT added.**" Two other places were not
updated:

- Sec 4.3: "with the flag absent, the ladder, **the 50386/50437 handling** and
  the re-read scoping are all skipped."
- Test 12: "assert they pass no ladder flag and that with the flag absent the
  ladder **and the 50386/50437 handling** are skipped."

A builder implementing to the TEST LIST will build the removed feature, because
Test 12 cannot assert that a thing is "skipped" unless the thing exists. This is
the document's own named failure mode - "two sections disagreeing after one of
them was edited" (Sec 0) - reintroduced by the fix for R8 finding 6.

**Evidence.** Spec Sec 4.2 para 5 vs Sec 4.3 last para vs Test 12.

## 5. [HIGH] Close C's control flow is never specified: no try/catch, no return, and in broadcastFanOut it double-finalizes

**What is wrong.** Sec 3.6 defines close C's trigger as "`enqueue` threw" and
Sec 3.5 marks it with a trailing comment (`// may throw -> close C`), but neither
section shows the `try`/`catch`, and neither says what happens after close C runs.

In `broadcastFanOut`, close C "marks recipients, bumps stats, emits progress and
calls `finalize()`" (Sec 3.6). With no `return` after it - same root cause as
finding 1 - control falls through to `finalize()` at `:513`, so the broadcast is
finalized twice: two `markFailed` calls, two terminal SSE emits, and two
`broadcast_sent` rows appended to the unit audit (`:565-571`, best-effort and
un-deduplicated).

There is also no statement of whether the catch is narrow (around the `enqueue`
call only) or wide. A wide catch would swallow errors from close A, which is
inside the same block.

**Evidence.** Spec Sec 3.5 snippet, Sec 3.6 close-C row and helper paragraph;
`broadcastFanOut.ts:496-513, 549-583`.

## 6. [MEDIUM] Sec 3.4's relayFanOut guard list is wrong on two of five entries and omits a real one

**What is wrong.** The pseudocode comment says:

> `relayFanOut` - source message missing, conversation missing/closed, no
> recipients, empty body-and-media, sender unresolved
> (five early returns in relayFanOut; none of them attempts a send)

The five early returns that actually exist, in order:

1. `:357-361` conversation not found
2. `:368-374` `conversation.status !== 'open'`
3. `:376-379` **no pool number** - not in the spec's list
4. `:386-390` source message not found
5. `:418-424` neither text nor media

"**no recipients**" does not exist: `recipients` is built at `:434-438` and the
`for` at `:443` simply does not iterate on an empty list. "**sender
unresolved**" does not exist either: `senderName` falls back to
`ANONYMOUS_SENDER_LABEL` (`:410-411`) and the job proceeds.

**Implies.** Two consequences, one of them load-bearing:

- The non-existent "no recipients" guard is what makes finding 2 invisible. A
  builder reading this list believes the recipient set has already been resolved
  and returned on above the claim; it has not.
- Sec 3.4's rule "the claim goes immediately before the first line that can cause
  a provider send" is the right rule, but with two of the named guards imaginary a
  builder may place the claim right after `:424` instead of after `:438`, which is
  where `recipients` first exists.

Correct the list, and pin the claim's position as "after the recipient filter at
`relayFanOut.ts:434-438`, before the `for`".

## 7. [MEDIUM] Sec 3.4 asserts a broadcastFanOut "not sending" guard that does not exist

**What is wrong.** The pseudocode comment names two broadcast guards -
"broadcast row missing / **not sending**". There is exactly one:
`if (!broadcast)` at `broadcastFanOut.ts:237-240`. A grep for a status / `sending`
/ `draft` check anywhere in the handler returns nothing; the handler goes
straight from `getById` to the unit merge context and the recipient keys.

Sec 3.4's other claim about the same guards ("Close B needs the row, which the
guards have already loaded") is nevertheless TRUE for this file - `getById` is the
guard. Only the enumeration is wrong.

**Implies.** Close B can therefore run against a `draft`, `sent` or `failed`
broadcast, re-running `finalize()` on a terminal row. Low consequence given
finding 8, but a builder may "restore" the guard the spec names, which is an
un-scoped behavior change. Either delete the phrase or say explicitly that no
status guard exists and none is added.

## 8. [MEDIUM] Close B's stated reachability is refuted by Sec 3.4 and Test 8

**What is wrong.** Sec 3.5: "**Close B is still reachable** and is not redundant:
a **duplicate** or stale envelope can arrive when the counter is already at the
cap, having never gone through close A."

A duplicate envelope cannot reach the claim. Sec 3.4 says so itself ("a
redelivered envelope returns at the marker") and Test 8 asserts it ("A duplicate
delivery claims nothing and sends nothing ... `fanout_attempt` unchanged"). The
claim is below the marker by design.

"Stale" has no demonstrated producer either. Continuations are the only source of
extra envelopes; with close A firing at `claim.attempt >= CAP` none is enqueued
past the cap. A broadcast cannot be re-sent (`broadcasts.ts:595`, "Only a draft
may be sent"), and each relay source message gets exactly one fan-out enqueue
(`api.ts:1805`, `twilio.ts:695`, `relayQueuedMessages.ts:93` - each on a distinct
`sourceTsMsgId`).

**Implies.** Close B is defense-in-depth with no reachable trigger I can
construct, which is a fine thing to build - but Test 7 calls it "the
discriminating case" and Test 7a demands a first-pass close-B fixture, so the
builder must force it. Say that plainly ("close B is unreachable in normal
operation and is driven directly in tests") instead of offering a justification
the document elsewhere refutes. Finding 2 is what makes close B worth getting
right regardless.

## 9. [MEDIUM] Sec 5.1 says Test 10 covers the broadcast badge; Sec 5.2 and Test 10 still say two positions

**What is wrong.** Sec 5.1's new paragraph is correct and closes R8 finding 7 -
"For a broadcast, `transient_cap` and `enqueue_failed` render ONLY through
`DeliveryBadge.tsx:31` ... **Test 10 covers it.**" But Sec 5.2 was not updated:
"These two codes ... render in **BOTH** positions from one string, so each must
read correctly as a rollup summary and on a single recipient's row. **Test 10
asserts both positions.**" And Test 10 itself: "rollup and per-recipient row".

Three positions, not two - and the third has its own syntactic context: the badge
renders `{label} - {reason}` (`DeliveryBadge.tsx:33-36`), so the string is read
immediately after a status label like "Failed", not standing alone.

**Implies.** One clause in Sec 5.2 and one in Test 10. Left as is, the builder
satisfies Test 10 with two assertions and Sec 5.1's promise is unmet.

## 10. [MEDIUM] "`ensureGroupRail` reads participants twice: once after create" is false on the create path

**What is wrong.** Sec 4.2 para 4 states the mechanism as "`ensureGroupRail` reads
participants twice: once after create, and once after repair". On the CREATE path
`ensureGroupRail` never calls `fetchParticipants`: `participants` is assigned from
`created.participants` at `groupRail.ts:462`, and `:492` is
`participants ??= await port.fetchParticipants(...)`, which is therefore skipped.
The post-create read happens INSIDE the adapter -
`groupConversations.ts:480` (bulk path) and `:540` (individual-add path).

So "ladder the create read" means adding a NEW `port.fetchParticipants` call in
`groupRail.ts` after `:506`, not re-running an existing one. Only the post-repair
read at `:538` is a read `ensureGroupRail` itself performs.

**Evidence.** `groupRail.ts:452-464, 491-492, 506-507, 538-540`;
`groupConversations.ts:474-486, 539-541`.

**Implies.** Minor for a builder who reads the code, but this is the same
sentence R8 flagged and the rewrite kept the inaccuracy. Say "add a re-read
ladder around the map build at `:506` and around the post-repair build at `:539`".

## 11. [LOW] "A ladder on the create read alone would leave the headline symptom intact" is overstated

Sec 4.2 justifies the post-repair ladder that way. But the create-read ladder
resolves the propagation case BEFORE `missing.length > 0` opens the repair block
(`groupRail.ts:517`) - which is exactly what Test 11's first clause asserts
("resolves via the ladder **without repair**"). For the measured 2026-08-13
population the post-repair read would never be reached. Both ladders are still
the right call as belt-and-braces for a genuinely-missing member whose fresh add
has not bound; the stated justification is not the reason.

## 12. [LOW] Test 6a and the in-flight envelope case can contradict each other

Sec 3.2 accepts that an envelope crossing the deploy has `payload.attempt = N`
while `claim.attempt = 1`. Relay's backoff argument changes from
`payload.attempt ?? 1` to `claim.attempt` (Sec 3.5), so for that one envelope the
delay legitimately differs from `main`'s. Test 6a asserts "the backoff DELAYS
equal `main`'s". Add one clause: Test 6a drives a fresh ladder, not an envelope
carrying a pre-set `attempt`.

---

## Checked and sound (changed text only)

- Sec 3.6's "`relayFanOut` has **no** `finalize()`, **no** `bumpStats` and **no**
  progress emit (zero occurrences in the file)" - verified, zero matches for
  `finalize|bumpStats|emit\(|events\.` in `relayFanOut.ts`. The "one helper PER
  FILE, not one shared" instruction is correct and non-obvious.
- Sec 5.1's em-dash note - `deliveryStatus.ts:544` byte-checked: the separator is
  **U+2014**, exactly as described. Quoting it rather than reproducing it is the
  right call for an ASCII document.
- Sec 8 obligation 1b - `_CLUSTERS.md:191-193` reads verbatim "the 30003 issue
  has a dashboard half in `deliveryStatus.ts` - land the backend lineage here and
  let T-DELIVERY-CHIPS render it". The quote and the contradiction are both real.
- Sec 2's In-list now names all three flag-passing callers, matching the five
  verified call sites. Closes R8 finding 3.
- Sec 5.1's `rosterKind`-is-a-DEFAULT paragraph and Test 13's explicit
  group-text pin - correct against `Timeline.tsx:796` and
  `GroupTextView.tsx:461`. Closes R8 finding 8.
- Test 3's `vi.mock` seam note - correct: `enqueue` is a module import
  (`broadcastFanOut.ts:74`, `relayFanOut.ts:47`) and is absent from both deps
  bags. Closes R8 finding 10.
- The header's `partly - three of five callers` and Sec 3.2's in-flight paragraph
  are accurate.

## UNVERIFIED

- The 2026-08-13 migration counts (81 / 178 / 2). Event names are real; the counts
  are from logs I do not have.
- Twilio's semantics for 50386/50437 - moot now that Sec 4.2 removes the handling.
- Whether `flushQueuedMessages` can be invoked twice for one conversation and
  double-enqueue a fan-out for the same `sourceTsMsgId`. The forward-only
  `queued_pending -> queued` transition at `relayQueuedMessages.ts:89` makes a
  second pass find nothing pending, so it looks safe; I did not read the
  `pending` query itself. If it CAN double-enqueue, two ladders would share one
  `fanout_attempt` and the second would be short. Worth one grep during build.
