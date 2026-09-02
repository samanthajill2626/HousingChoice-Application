# R8 - cold review of the REWRITTEN retry-counter-durable design spec

Follow-up pass by the R7 cold reviewer, read fresh against the rewritten
document rather than diffed against my own report. Same discipline: file:line
proof, UNVERIFIED where I could not check, no scope past Sec 2.

---

## Enumerations: both are now COMPLETE

Verified exhaustively, not by confirming the ones I already named.

**`deliveryReason` call sites - exactly SIX, all non-test, all in the table.**
`grep -rn "deliveryReason(" dashboard/src app/src e2e` excluding tests returns
`DeliveryBadge.tsx:31`, `deliveryStatus.ts:416`, `Timeline.tsx:582`, `:849`,
`:1045`, `:1390` (plus the declaration at `deliveryStatus.ts:628`). No seventh.
Each surface label in the Sec 5.1 table is correct: `:1390` is inside
`EmailCard` (declared `:1385`), `:849` is the message-level bubble reason,
`:582` is the accessible-name recital, `:1045` is the disclosed recipient row.

**`ensureGroupRail` callers - exactly FIVE in production, all in the Sec 4.3
table.** `app/scripts/rail-verify.ts:198`, `app/src/jobs/groupRail.ts:59`,
`app/src/lib/import/convertGroups.ts:598`, `app/src/services/groupSend.ts:381`,
`app/src/services/groupSend.ts:425`. Every other hit is a comment, the interface
declaration (`services/groupRail.ts:154`), the default no-op (`:163`), the
implementation (`:291`), or a test. Note for the builder, not a finding: three
test files drive the REAL service - `app/test/groupRailService.test.ts` (~25
calls, `:188-744`), `app/test/groupSend.test.ts:946-1140`, and
`app/test/groupGuardrailWiring.test.ts:172` - so the flag's default-off has to
hold across all of them, which test 12 covers.

**`presentRelayDelivery` has exactly ONE non-test caller** - `Timeline.tsx:894`
- so Sec 5.1's "passed by its caller" (singular) is right.

## Mechanisms I traced and found SOUND

- **Claim after the marker is correct, and for the reason Sec 3.4 gives.**
  Each `enqueue` mints a fresh `jobId` (`jobs.ts:188`), so every continuation
  passes the marker and claims. Test 8 pins it.
- **`rosterKind === 'relay'` is a SAFE discriminator here**, despite defaulting
  to `'relay'` (`Timeline.tsx:796`, `:1519`). I traced all four production
  `<Timeline>`/`relayRoster=` sites: `ContactCommsPane.tsx:319` (no rosterKind,
  but `contacts.ts:1362` skips `relay_group` and `group_text` conversations
  entirely, so no leg rows exist there); `ConversationDetail.tsx:488`,
  `PlacementConversation.tsx:328` and `TourConversation.tsx:475` are all
  `useRelayThread` views where the default is CORRECT; and
  `GroupTextView.tsx:461` passes `rosterKind="group_text"` explicitly.
  `ConversationDetail.tsx:141`/`:145` is the router that keeps those apart. The
  trap I flagged in R7 does not fire on any live path.
- **Registering both internal codes breaks no existing test.**
  `deliveryStatus.test.ts:614-619` pins only `contact_opted_out`; `:628-634`
  pins prototype keys. Nothing asserts `transient_cap`'s current rendering.
- **Sec 8 obligation 3's cite is real**: `conversationsRepo.ts:2189-2214` is
  exactly the conditional-child-write-then-seed-the-parent-map pattern.
- **Sec 4.2's quotation is verbatim** (`groupRail.ts:536-538`), and
  `created.failures` really is collapsed to `authorRefusedOnCreate` at
  `groupRail.ts:463`.
- **`presentLegDelivery` really does already take `rosterKind`**
  (`deliveryStatus.ts:500-505`).

---

## BLOCKING

### 1. Close A's replacement trigger is never stated, and the two candidates behave differently

**What is wrong.** Sec 3.5 says: delete the `nextAttempt` computation and the
`if (nextAttempt > MAX_*)` branch condition; "The BODY of that branch survives as
close A". Sec 3.6's table says A fires when "the send loop ran and deferred
recipients hit the cap". Nowhere does the spec say what the new condition IS.
The two natural readings are not equivalent:

- **A fires on `claim.attempt >= CAP`.** Passes 1..3 send, pass 3 closes at its
  own end. Pass count matches `main`, so Sec 3.5's "Same number of passes" holds.
  But then no continuation is ever enqueued at cap, so **close B is unreachable
  in production** - the table presents it as one of three live triggers.
- **A has no trigger (always enqueue, let B catch it).** Then close A is the
  dead one, a fourth no-send pass runs, and it waits a backoff step `main` never
  used - `broadcastBackoffMs(4)` = 40s (`broadcastFanOut.ts:82-84`) - so a
  capped broadcast sits in "Sending" ~40s longer than today, contradicting
  Sec 3.5.

**Evidence.** Spec Sec 3.5 lines 215-219, Sec 3.6 table row A;
`broadcastFanOut.ts:478-495`, `relayFanOut.ts:569-582`.

**Implies.** This is the same ambiguity R7 flagged as C5, re-created in a new
shape: the guard is now explicitly removed, but nothing replaces it in writing.
Test 6 (send counts) passes under both readings and test 5 ("walks 1, 2, 3 and
closes at the cap") is worded compatibly with both. State A's condition, and if
it is `claim.attempt >= CAP`, say plainly that B is a defensive backstop rather
than a normal path - otherwise a builder will reasonably choose the reading that
makes B live.

### 2. "The enqueued payload's `attempt` field is set from `claim.attempt`" changes BOTH ladders' backoff, and Sec 3.7 forbids one of them

**What is wrong.** On pass N, `claim.attempt` is N. `main` enqueues the
continuation with `attempt: nextAttempt` = N+1. Setting it to `claim.attempt`
shifts the whole schedule by one step, in both loops and in different ways:

- **`broadcastFanOut`** computes its delay as
  `broadcastBackoffMs(nextAttempt)` (`:506`) - the very variable Sec 3.5 orders
  deleted, so the instruction also orphans that call and does not say what
  replaces it. With `claim.attempt` the delays become 5s, 10s where `main` has
  10s, 20s: **halved at every step**. That directly contradicts the deliberate
  comment two lines above it (`:503-505`: "Using the current attempt's delay
  here would under-wait by one step").
- **`relayFanOut`** computes its delay from the INCOMING payload
  (`fanOutBackoffMs(payload.attempt ?? 1)`, `:595`). Enqueuing N instead of N+1
  leaves the first delay at 5s but turns the second from 10s into 5s. That is a
  change to exactly the backoff Sec 3.7 says in bold **"Do not change it."**

**Evidence.** Spec Sec 3.5 lines 215-219 vs Sec 3.7;
`broadcastFanOut.ts:82-84`, `:496-507`; `relayFanOut.ts:68-70`, `:583-596`.

**Implies.** Two sections of the spec give opposite instructions about
`relayFanOut`'s timing, and the broadcast side silently halves a production
backoff. The fix is one word - `attempt: claim.attempt + 1` - plus an explicit
statement of what the `runAt` expression becomes once `nextAttempt` is gone.
Nothing in Sec 7 would catch this: no test asserts a delay.

---

## HIGH

### 3. The rail ladder does not cover the post-repair re-read, where the failure it cites as evidence actually occurred

**What is wrong.** Sec 4.2 puts the ladder "before entering repair" only. Trace
what happens when propagation outlasts the ladder's 500ms + 1500ms:

1. ladder exhausts, `missing.length > 0` (`groupRail.ts:506-507`, `:515`);
2. repair runs `addParticipants` (`:521`), which returns 50386 "already exists"
   - now not counted a failure, but see finding 6;
3. the authoritative re-read fires **immediately, with no delay**
   (`:538-540`) - subject to the identical propagation lag;
4. `missing.length > 0` at `:546` records `rail_failed` at `:552`.

That is precisely the "2 `rail_failed` records for rails a direct read minutes
later showed fully bound" the spec cites in Sec 4.1 as its own evidence, and the
issue's own note that "the convergent re-run healed both"
(`rail-binding-propagation-retry.md:22`) says the propagation there outlasted
the run, not 2 seconds.

**Evidence.** Spec Sec 4.2 ("before entering repair", "the authoritative re-read
that follows repair decides the outcome either way");
`groupRail.ts:506-507`, `:515-535`, `:536-546`, `:546-553`;
`docs/issues/rail-binding-propagation-retry.md:16-24`.

**Implies.** The ladder converts the fast-propagating cases (which is most of
the 81 warnings and 178 refusals) and leaves the slow ones behaving exactly as
today. If the ladder is the whole fix, apply it to the post-repair re-read too -
one delayed re-read before `:546` is enough - or state explicitly that a
propagation window longer than 2s still records a false `rail_failed` and that
this is accepted.

### 4. Sec 2's "In" list still omits the three rail caller files Sec 4.3 requires editing

**What is wrong.** Sec 4.3's table sets the ladder **on** for
`jobs/groupRail.ts:59`, `lib/import/convertGroups.ts:598` and
`app/scripts/rail-verify.ts:198`. Each of those files must be edited to pass the
new flag - and for the import path the flag has to be set where the request is
BUILT (`convertGroups.ts:429`), not only where it is forwarded (`:598`). Sec 2's
"In" list contains none of the three; it lists only
`app/src/services/groupRail.ts`.

**Evidence.** Spec Sec 2 lines 54-64 vs Sec 4.3 table;
`app/src/jobs/groupRail.ts:59`; `app/src/lib/import/convertGroups.ts:429`,
`:598`; `app/scripts/rail-verify.ts:192`, `:198`.

**Implies.** Sec 2 is the document's fence, and the rewrite fixed this for
`Timeline.tsx` (now listed with its authorization) but not for the rail callers.
A builder treating Sec 2 as authoritative ships the flag with nobody passing it,
and every test in Sec 7 test 11 still passes because it drives the service
directly.

---

## MEDIUM

### 5. Close B needs a read the pseudo-code's placement precludes, and is empty on a first pass

**What is wrong.** Close B's recipient set is "the envelope's `recipientKeys`
still non-terminal", which requires reading the item's slots. Sec 3.4 places the
claim immediately after the marker - in `broadcastFanOut` that is BEFORE
`broadcasts.getById` (`:236`), and in `relayFanOut` before the conversation read
(`:357`), the open-status gate (`:368`) and the source-message read
(`:382-390`). So close B has to perform its own read, which the spec never says.
Separately, `recipientKeys` is optional (`BroadcastSendPayload.recipientKeys?`,
`broadcastFanOut.ts:96-98`; `RelayFanOutPayload.recipientKeys?`,
`relayFanOut.ts:113-118`) and is absent on a first pass, so a close B that fires
without it marks nothing - the same silent-false-success shape Sec 3.6 warns
about one paragraph earlier.

**Evidence.** Spec Sec 3.4 block, Sec 3.6 table row B;
`broadcastFanOut.ts:96-98`, `:236`; `relayFanOut.ts:113-118`, `:357-390`.

**Implies.** Say that close B reads the item, and say what it does when
`recipientKeys` is absent (close over every non-terminal slot, or refuse to
close and log). Under finding 1's first reading B is unreachable anyway, which
is a further reason to say so out loud.

### 6. The 50386/50437 change has no effect on any outcome - `addParticipants` failures are already discarded

**What is wrong.** Sec 4.2 says these codes "must not count as a repair
failure". Nothing counts them today. `ensureGroupRail` takes the repair's
`failures` list, logs `group_rail_repair_partial` if it is non-empty
(`groupRail.ts:522-533`), and then **discards it** - the outcome is decided
solely by the re-read and `missingFromMap` at `:536-546`. So the only observable
change is that one warn line stops firing.

**Evidence.** Spec Sec 4.2 third bullet; `groupRail.ts:521-535`, `:536-546`.

**Implies.** Quieting the warn is what the issue actually asked for
(`rail-binding-propagation-retry.md:30-32`), so the outcome is fine - but the
spec's phrasing describes a behavior change that does not exist, and a builder
will go looking for a refusal-counting path to modify and find none. Say
"suppress the `group_rail_repair_partial` warn for these two codes; the outcome
is already decided by the re-read."

### 7. Sec 5.1's table marks `DeliveryBadge.tsx:31` "unchanged" while Sec 5.2 changes what it renders

**What is wrong.** The six-site table is scoped to the 30003 override, where
"unchanged" is right. But Sec 5.2 registers `transient_cap` in
`INTERNAL_CODE_REASONS`, and `DeliveryBadge` renders a broadcast recipient's
reason through `deliveryReason(errorCode)` (`DeliveryBadge.tsx:31`, shown as
both a `title` and appended text at `:32-36`). `transient_cap` is written onto
broadcast slots today (`broadcastFanOut.ts:482`), so the badge's copy on
EXISTING rows changes from `Delivery failed (error transient_cap)` to the new
prose, with the tail dropped.

**Evidence.** Spec Sec 5.1 table vs Sec 5.2; `DeliveryBadge.tsx:19-37`;
`broadcastFanOut.ts:482`.

**Implies.** The change is desirable - it is the same defect being fixed - but
the table says the opposite, and test 13 asserts "the broadcast badge [is]
unchanged". Scope the table row explicitly to the 30003 override, and have test
10 cover the badge as a third position rather than letting test 13's wording
contradict it.

### 8. `_CLUSTERS.md`'s routing directive is still unreconciled, and no obligation updates it

**What is wrong.** Sec 2 now records Cameron's authorization for
`Timeline.tsx`, which answers the ownership half. It does not answer the
routing half: `docs/issues/_CLUSTERS.md` M5's conflicts paragraph still reads
"the 30003 issue has a dashboard half in `deliveryStatus.ts` - land the backend
lineage here and let T-DELIVERY-CHIPS render it", which is the reverse of what
this branch does. Sec 8's obligations do not include amending it.

**Evidence.** `docs/issues/_CLUSTERS.md`, M5 conflicts paragraph; spec Sec 2,
Sec 2.1, Sec 8.

**Implies.** After this merges, the cluster file instructs the next mission to
do what has already been done, and to expect a backend lineage that was
deferred. One line in Sec 8 fixes it.

---

## LOW

### 9. Sec 3.6 attributes stats and progress emits to all three closes; `relayFanOut` has neither

"All three mark their recipients failed, bump stats, emit progress, and (in
`broadcastFanOut`) call `finalize()`." The parenthetical excludes only
`finalize`. `relayFanOut`'s cap branch calls `markRecipient` and nothing else
(`relayFanOut.ts:574-576`); it has no stats counters and emits no progress
events. Move `relayFanOut` outside the whole clause, not just the `finalize`
half - the "factor one helper" instruction immediately after it will otherwise
be written to an interface relay cannot satisfy.

### 10. The header table still says the rail issue "closes"

Sec 4.3 says "the issue is closed only for the three that opt in" and Sec 8
obligation 2 says update it rather than close it. The summary table at the top
of the document still reads **closes**, and that table is what a reader sees
first. Make it "closes for 3 of 5 callers - Sec 4.3".

### 11. Three cites drift by a few lines

`buildParticipantMap` is declared at `groupRail.ts:223` (the spec says
`:224-231`; the address skip is at `:227`). Sec 5.2 cites
`deliveryStatus.ts:505-516` for the `contact_opted_out` interception; `:506-518`
is the explaining comment and the interception itself is at `:519-525`. Sec 3.1's
`api.ts ~:2152-2165` is hedged and fine (the spread is at `:2162`, the return at
`:2165`). The underlying claims are all TRUE - I checked each - but a document
whose stated method is "trace X from the NEW call site" should land its own
line numbers.

### 12. `fanout_attempt` is per-item and never resets - unstated

The counter lives on the broadcast row / source message forever, so it caps the
LIFETIME passes of that item rather than the passes of one continuation chain.
Any future path that re-drives a fan-out for an existing item inherits an
exhausted ladder and (per finding 1's second reading) would close immediately.
UNVERIFIED that such a path exists today: the three `RELAY_FANOUT_JOB` producers
(`api.ts:1805`, `webhooks/twilio.ts:695`,
`services/relayQueuedMessages.ts:93`) each fan out a message that has never been
fanned out before, and `markSending`'s `status = 'draft'` condition blocks
re-sending a broadcast. One sentence in Sec 3.2 stating the property would keep
a later mission from tripping over it.
