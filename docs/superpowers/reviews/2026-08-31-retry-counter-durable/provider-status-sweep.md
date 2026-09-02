# Provider-status sweep - FINAL RECORD (spec Sec 9)

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Finalized at `8cebbebf` (slice 6), with slices 0+1, 2, 3, 4, 5a and 5b landed.
Main was merged at `8c8b7100` and has not been re-synced.

This file is the RECORD spec Sec 9 asks for: the verified table, a disposition
for every site, and the rulings. The DRAFT enumeration
(`research/provider-status-enumeration.md`, written at `8c8b7100` before slices
2/3/4 landed) stays where it is as committed history; it is the raw pass, this
is the decision. Where the two disagree on a line number, THIS FILE is current.

## 1. The shape being hunted

A branch on a status string a provider gave us whose UNENUMERATED default is
NON-TERMINAL - "not finished yet, keep waiting" or "nothing to change here" -
rather than terminal. That is the 2026-08-16 prod incident: Twilio returned a VI
transcript status of `error`, the code enumerated `failed` but not `error`, the
unknown value took the keep-waiting arm, and a 1-second voicemail sat on
"Transcribing..." forever. `a755c6f8` fixed that instance;
`retry-counter-in-envelope-makes-caps-unreachable`'s "Also worth auditing"
paragraph asked for the sweep, and spec Sec 9 bounded it.

`EXPOSED` = that polarity. `NOTE` = an unenumerated default that is terminal (or
a deliberate drop) but still worth a reader's attention. `SAFE` = the default is
terminal, or the value set is a closed TypeScript union the compiler makes
exhaustive, or the non-terminal arm is bounded by a cap or an alarm.

## 2. Methodology

**The draft did the sweep; slice 6 verified it and decided disposition.** The
draft searched `app/src` only (`dashboard/` excluded by instruction as
presentation rather than provider branching; `*.test.ts` and `__tests__`
excluded), ran the grep set recorded in its "What was searched" section, and
read `adapters/*`, `routes/webhooks/*`, `jobs/*`, the voice/email/ses/group/relay
services and both repos line by line. That work was NOT redone.

What slice 6 did instead:

1. **Re-derived every IN-REGION site by NAME**, not by line. All five in-region
   files were edited after the draft was written, so every in-region line number
   in the draft is stale by construction. Section 4 carries the current lines.
2. **Bounded the out-of-region and fenced re-verification by proof rather than
   by re-reading.** `git diff --name-only 8c8b7100..HEAD -- app/src` returns
   exactly eight files: `jobs/broadcastFanOut.ts`, `jobs/relayFanOut.ts`,
   `jobs/groupRail.ts`, `services/groupRail.ts`, `repos/messagesRepo.ts`,
   `repos/broadcastsRepo.ts`, `repos/fanoutClaim.ts` (new) and
   `lib/import/convertGroups.ts`. No fenced file and no out-of-region file
   carrying a sweep site is in that list EXCEPT `jobs/groupRail.ts` (site #45),
   which slice 4 edited and which is re-derived below. Every other out-of-region
   and fenced line number therefore cannot have moved.
3. **Spot-checked five out-of-region sites anyway**, to catch a wrong line in
   the draft rather than a moved one - a class the file list cannot rule out.
   Section 3 records the five and their result.
4. **Re-ran the two zero-hit confirmations** and the two `jobs.ts` /
   `retrySend.ts` facts the false comments turn on. Section 6.

## 3. Re-verification delta

**In-region: every line moved, no site changed meaning, no site appeared or
disappeared.** 16 in-region sites before, 16 after. The shifts are large
(`relayFanOut.ts`'s error arms moved ~90 lines) because slices 2 and 3 inserted
a close helper and a claim block above them.

**Out-of-region and fenced: NIL DELTA.** Five sites were re-read in full and all
five hold exactly as the draft recorded them:

| draft # | site | re-verified |
|---|---|---|
| 24 | `adapters/messaging.ts:533-549`, default `:545-547` | HOLDS, byte for byte including the "anything new Twilio adds" comment |
| 28 | `routes/webhooks/voice.ts:216-236` + `:1630-1637` | HOLDS; `mapCallStatus` `default: return undefined` at `:233-234`, the ack-and-no-change consumer at `:1631-1637` |
| 30 | `services/voiceTranscripts.ts:116-120`, `:198-213` | HOLDS; `VI_TERMINAL_FAILURE_STATUSES` is at `:116-120` and the `not-completed` return at `:212` |
| 32 | `services/groupReceipts.ts:125-144`, `:545` | HOLDS; the mapping table is `:125-140`, `conversationsStatusRuling` `:143-145`, the consumer `:545` |
| 42 | `services/sesNotifications.ts:90-93`, `:95-98` | HOLDS; both verdict mappers, both returning `undefined` |

The sixth re-derivation, forced by the file list rather than chosen: **#45
`jobs/groupRail.ts` moved from `:60-84` to `:67-91`** (slice 4 expanded the
request literal at `:59` to a multi-line object). Verdict unchanged: SAFE - it
branches on `ensureGroupRail`'s own result union, not on a provider status.

A nil delta is a result and is written down here rather than left implicit.

## 4. The verified table - IN-REGION (current lines)

| # | file:line (CURRENT) | branched on | default when unenumerated | verdict | disposition |
|---|---|---|---|---|---|
| 1 | `jobs/broadcastFanOut.ts:124-128` | `BroadcastRecipient['status']` | non-terminal (`false` = re-send) | SAFE - closed TS union | none |
| 2 | `jobs/broadcastFanOut.ts:487-497` | send-error `code` = `30007` | falls through to 3/4/5 | SAFE | none |
| 3 | `jobs/broadcastFanOut.ts:498-526` | `UNREACHABLE_CODES` (`:92`) | falls through to 4/5 | SAFE | none |
| 4 | `jobs/broadcastFanOut.ts:527-533` | `TRANSIENT_CODES` (`:88`) | falls through to 5 | SAFE | none |
| 5 | `jobs/broadcastFanOut.ts:534-545` (comment), throw `:545` | same `code`, catch-all arm | `throw err` - recipient left `queued`, loop exits, the rest of the audience stranded | **EXPOSED** | **FILED** `throw-for-redelivery-defeated-by-job-marker`; comment **FIXED-HERE** @ `8cebbebf` (D12: the throw is untouched) |
| 6 | `jobs/relayFanOut.ts:175-177` | `RelayRecipientDelivery['status']` | non-terminal (`false`) | SAFE - closed union | none |
| 7 | `jobs/relayFanOut.ts:977-981` | send-error `code` = `30007` | falls through | SAFE | none |
| 8 | `jobs/relayFanOut.ts:982-989` | `TRANSIENT_CODES` (`:90`) | falls through | SAFE | none |
| 9 | `jobs/relayFanOut.ts:990-1002` (comment), throw `:1002` | same `code`, catch-all arm | same shape as #5 | **EXPOSED** | **FILED** same slug; comment **FIXED-HERE** @ `8cebbebf` |
| 10 | `jobs/relayFanOut.ts:1007` | `result.status` (already-mapped `DeliveryStatus`, itself `mapTwilioStatus` output) | terminal-success: everything but `queued` is written `sent` | NOTE | folded into `provider-status-unenumerated-defaults` as a caller of the root site |
| 11 | `services/groupRail.ts:290-293`, consumers `:493` and `:544` | raw Conversations `state` | non-terminal - anything but `closed`/`failed` is "a rail that still works" | **EXPOSED** | **FILED** `provider-status-unenumerated-defaults` sec 3. NOT fixed - ruling in section 5 |
| 12 | `repos/broadcastsRepo.ts:216-262` (switch `:231-253`) | `slot.status` in `deriveBroadcastStats` | counted in NO bucket | SAFE by type - closed union, no `default` arm | none |
| 13 | `repos/messagesRepo.ts:121-133` | `ALLOWED_PRIOR` forward-only map | n/a - total `Record` over a closed union | SAFE | none |
| 14 | `repos/messagesRepo.ts:73-88` | `ALLOWED_PRIOR_CALL_STATUS` | n/a - total `Record` | SAFE | none |
| 15 | `repos/messagesRepo.ts:2875-2882` | `slot.status` vs `allowedPriorStatuses(status)` | skip the write, log "would regress" | SAFE | none |
| 16 | `repos/messagesRepo.ts:2897-2901` | mapped `status` === `delivered` | no `deliveredAt` stamp | SAFE | none |

Sites 1-4, 6-8 and 12-16 were re-read in the post-slice tree; none of the
slices' edits changed what they branch on or what their default does. The claim
primitive slices 0+1 added to both repos introduced NO new provider-status
branch (it branches on a DynamoDB conditional-check outcome, not a vendor
string), so the in-region count is unchanged at 16.

## 5. The `isDeadRailState` ruling (site #11)

**Verdict: DO NOT FIX. Filed, with a per-consumer reason.** Spec Sec 9 says
in-region findings are fixed rather than filed; this is a second in-region
exception, and unlike D12's it was not named in advance, so the reasoning is
recorded in full.

### The predicate and its state space

`services/groupRail.ts:290-293` treats `closed` and `failed` as dead and
`undefined` as `active`. The port types `state` as a raw vendor string
(`adapters/groupConversations.ts:36-43`), documented as
`initializing | active | inactive | closed`; the adapter only populates the
field when Twilio sends a non-empty string (`:366`), so `undefined` is a real,
reachable input from a response that omits it and from every test fake that does
not set it. `failed` is not in the vendor enumeration at all - it is defensive.

So for the four states Twilio can send today: `initializing`, `active`,
`inactive` -> alive; `closed` -> dead. An allowlist rewrite (alive =
`{initializing, active, inactive}` + `undefined`, everything else dead) would
change NOTHING for those four. On the letter of the sweep's remit, that fix
qualifies. It is still wrong, for reasons the state space does not show.

### Consumer A - adopt-keep, `:493`

An unknown state means the adoptee is KEPT. **That default is correct**, and not
merely tolerable.

The action gated by `true` is `port.removeConversation` - a DELETE of a Twilio
resource. The code's own justification for deleting is at `:483-486`: it is safe
"precisely because the resource is CLOSED: it can carry no further traffic, and
it holds no history we need ... We are reclaiming a name, not discarding data."
That argument is entirely load-bearing and it does not survive a state we do not
understand. A vendor enum addition would make this line delete live rails.

Nothing is lost by being conservative here either: an adoptee that passes `:493`
is immediately re-checked at `:544` with the SAME value and the SAME predicate.

### Consumer B - post-create finalize, `:544`

An unknown state means the rail is FINALIZED and stored, and every later staff
send posts into a Conversation that may carry no traffic - a silent
no-delivery, which is exactly what `:535-536` warns about. **This is the exposed
polarity, and it is real.**

It is also unfixable at this call site alone. Flipping only consumer B splits
the predicate, and the two consumers' AGREEMENT is load-bearing: today an
adopted rail cannot reach `:544` in a dead state, because `:493` deleted it
first - which is why the comment at `:538-539` can say "Only a FRESHLY CREATED
conversation can reach this now". Under a split, an adopted rail in an unknown
state passes `:493` undeleted, fails at `:544`, records `rail_failed`, and
`groupSend`'s `healRail` (`services/groupSend.ts:412-424`, called at `:548`)
clears the stored sid and calls straight back into `ensureGroupRail`, which
adopts the same Conversation and fails again. That is the permanent-refusal loop
fix wave 4's H1 removed; the code documents its exact mechanism at `:466-474`.

Flipping BOTH consumers avoids the loop and lands on consumer A's problem
instead: deleting a rail on a state nobody has seen.

### Why that is a stop, not a smaller fix

Either direction changes behavior on a reachable path - not for a value Twilio
sends today, but for the first one it adds, which is the only scenario this
sweep exists to protect against. Getting it right means deciding what the
adopt/heal pair should do with an UNKNOWN rail (probably: keep it, refuse to
delete it, and raise a signal), which is a design decision about a subsystem
this branch touched for an unrelated reason. A sweep may correct a comment and
may make a fix that is provably inert; it may not redesign the closed-rail
recovery.

A cheap inert mitigation exists and belongs to whoever takes the issue: WARN
once on a state outside the known set, at the predicate, changing no decision.
It is written into the issue's "What a fix must preserve" rather than shipped
here, because even a log line in this function is a change to a path slice 4
just finished pinning with eight tests, for a value no test can currently
produce.

## 6. Confirmations

**The zero-hit claim holds, re-run at `8cebbebf`.** From `app/src`:
`grep -rn "!== 'success'" .` exits 1 with no output, and so does
`grep -rn "'success'" .`. There is no `'success'` STRING LITERAL anywhere in
`app/src` - the anchor issue's suggested grep could never have found anything,
which is why spec Sec 9 re-based the sweep on the polarity of the default.

**`jobs.ts` mints `jobId` once, at enqueue.** `jobs/jobs.ts:188`
(`jobId: randomUUID()` inside `buildEnvelope`). The second `randomUUID()` at
`:269` is in `dispatchJob`'s repair path and fires only for a legacy or
incomplete envelope; a COMPLETE envelope is used verbatim. A redelivery
therefore carries the SAME `jobId` and the per-`jobId` execution marker
suppresses it.

**`retrySend.ts:122-128` states the semantics correctly** - "The envelope's
jobId (stable across redeliveries; dispatchJob stamps it into the context)". It
is the in-repo counter-example to the two false comments.

**The two false comments are corrected** (@ `8cebbebf`, comment-only). Both
claimed the redelivery arrives with "a fresh jobId via the visibility timeout".
Both now state that the redelivery carries the same `jobId`, is suppressed by
the execution marker, returns successfully so the message is DELETED rather than
DLQ-cycled, and therefore retries nothing - and both carry a
`TODO(throw-for-redelivery-defeated-by-job-marker):` marker per the tier-1
convention. The `throw` statements themselves are untouched (D12).

## 7. Disposition summary - all 52 sites

Verdicts, which partition the 52: **EXPOSED 6** (#5, #9, #11, #18, #24, #28),
**NOTE 9** (#10, #21, #22, #29, #32, #36, #37, #38, #42), **SAFE 37**.

- **FIXED-HERE: 2** - the false comments at `broadcastFanOut.ts:534-545` and
  `relayFanOut.ts:990-1002`, commit `8cebbebf`. Comment-only; no behavior
  changed anywhere in this slice.
- **FILED: all 6 EXPOSED, across 2 issues.**
  `throw-for-redelivery-defeated-by-job-marker` (already open, high) covers #5
  and #9. `provider-status-unenumerated-defaults` (NEW, med) covers #24 (the
  root), its fenced inheritors #18 (`twilio.ts:2359`, `:2470`), #28
  (`voice.ts`), and #11 (`isDeadRailState`, in-region, ruled above). The two
  NOTE rows #10 and #36 are named INSIDE that issue as blast radius of #24 -
  they are not separate findings.
- **NOTE: 9** - recorded, not filed: each is a deliberate, logged or
  backstopped drop. Two are worth a reader's eye anyway and are named in
  section 8.
- **SAFE: 37** - terminal default, closed union, or bounded by a cap/alarm.

### FENCED - `routes/webhooks/twilio.ts` (audit only, lines unchanged)

| # | file:line | verdict | disposition |
|---|---|---|---|
| 17 | `:295-299` `isTerminalDeliveryFailure` | SAFE | none - this is the explicit COUNTER-example: an unrecognized code is treated as terminal, "fail loud, not silent" |
| 18 | `:2359`, `:2470` | **EXPOSED (inherited from #24)** | FILED in `provider-status-unenumerated-defaults` |
| 19 | `:2377`, `:2484`, `:2541` | SAFE | none |
| 20 | `:2552-2726` `switch (ErrorCode)` | SAFE - status already stamped terminal | none |
| 21 | `:2779-2785` `rollIntoBroadcast` | NOTE - deliberate; the fan-out owns the pre-carrier slot | none |
| 22 | `:2415-2463` SID resolution | NOTE - loud drop, the loop-closing backstop | none |
| 23 | `:2747` `broadcastSlotMayTransition` | SAFE | none |

### OUT-OF-REGION (lines unchanged unless noted)

| # | file:line | verdict | disposition |
|---|---|---|---|
| 24 | `adapters/messaging.ts:533-549` (default `:545-547`) | **EXPOSED - the ROOT of the class** | FILED (new issue, sec 1) |
| 25 | `adapters/messaging.ts:520-530` | SAFE - extractor | none |
| 26 | `adapters/messaging.ts:826-841` | SAFE | none |
| 27 | `adapters/messaging.ts:955-961` | SAFE | none |
| 28 | `routes/webhooks/voice.ts:216-236` + `:1630-1637` | **EXPOSED** | FILED (new issue, sec 2) |
| 29 | `routes/webhooks/voice.ts:1916-1920` | NOTE - `absent`/`failed` recorded nowhere | none |
| 30 | `services/voiceTranscripts.ts:116-120`, `:198-213` | SAFE-BY-CAP | none - this is the `a755c6f8` patch, the reference shape |
| 31 | `jobs/voiceTranscript.ts:116-142`, `:204-226`, `:278-303` | SAFE | none - the in-repo precedent for D9 |
| 32 | `services/groupReceipts.ts:125-144`, `:545-559` | NOTE (near-EXPOSED) | none - deliberate, ERROR-logged, backstopped by #35 |
| 33 | `services/groupReceipts.ts:157-161` | SAFE | none |
| 34 | `services/groupDelivery.ts:98-120` | SAFE | none |
| 35 | `services/groupSendStaleness.ts:53-61`, `:79-81`, `:119-125` | SAFE - non-terminal here means "alarm" | none |
| 36 | `services/relayAnnouncements.ts:308` | NOTE - identical to #10 | folded into the new issue as a caller of #24 |
| 37 | `routes/webhooks/twilioConversations.ts:165-215` | NOTE | none - #35 is the backstop |
| 38 | `routes/webhooks/twilioEvents.ts:152`, `:179`, `:185-190` | NOTE | none - backstopped by the stuck-warming sweep, `services/poolNumbers.ts:459-478` |
| 39 | `services/emailEvents.ts:175-196` | SAFE | none |
| 40 | `services/emailEvents.ts:187-189` | SAFE | none |
| 41 | `services/sesNotifications.ts:100-102`, `:166-190` | SAFE | none |
| 42 | `services/sesNotifications.ts:90-93`, `:95-98` | NOTE - fail-open on a verdict | none; see section 8 |
| 43 | `adapters/groupConversations.ts:494-497`, `:715-733` | SAFE | none |
| 44 | `adapters/groupConversations.ts:589-591`, `:609-611`, `:642-644` | SAFE | none |
| 45 | `jobs/groupRail.ts:67-91` (**moved** from `:60-84`) | SAFE - branches on our own union | none |
| 46 | `adapters/webPush.ts:60-61`, `:156-161` | SAFE | none |
| 47 | `adapters/cloudwatch.ts:473-478` | SAFE | none |
| 48 | `adapters/cloudwatch.ts:749-762` | SAFE-BY-CAP | none |
| 49 | `services/mediaMirror.ts:78-85` | SAFE | none |
| 50 | `adapters/mediaStore.ts:62-63`, `:217`, `:262` | SAFE | none |
| 51 | `adapters/extraction.ts:282-313` | SAFE | none |
| 52 | `adapters/messaging.ts:1020-1026`, `:1085-1091`, `:1105-1110` | SAFE | none |

## 8. Two NOTEs a later reader should not have to rediscover

Neither is in scope for this branch and neither is filed, because both are
deliberate and both are documented at the site. Recorded so the next sweep does
not spend the analysis again.

- **#42, `sesNotifications`'s verdict mappers are FAIL-OPEN.** An unmapped spam
  or virus verdict returns `undefined`, and `services/inboundEmail.ts:603` /
  `:642` then do NOT quarantine - the mail is threaded. SES also emits
  `PROCESSING_FAILED`, on which a message whose virus scan did not complete is
  delivered. This is the only site in the whole table where the non-terminal
  default has a SECURITY rather than a liveness consequence, which is why it is
  singled out here despite being a NOTE.
- **#37, `onDeliveryUpdated` is the ONLY receipt channel for group sends.** A
  renamed or filtered Conversations event type is WARNed and 200'd, and the
  symptom is total silence rather than an error. `groupSendStaleness` (#35) is
  the backstop and it fires at ERROR, so the failure is detectable - but only
  as "nothing arrived", never as "the event type changed".

## 9. What slice 7 must know

1. The new issue slug is **`provider-status-unenumerated-defaults`** (med, open,
   area `app`). Slice 7 runs `npm run issues`; this file does not.
2. `retry-counter-in-envelope-makes-caps-unreachable`'s "Also worth auditing
   (not yet done)" paragraph is now DONE and should be updated to point at the
   new issue and at this record. Its proposed `!== 'success'` grep is recorded
   here as having zero hits - do not let a future reader re-run it and conclude
   the sweep found nothing.
3. `throw-for-redelivery-defeated-by-job-marker` cites `broadcastFanOut.ts:456`
   and `relayFanOut.ts:531` in its front-matter `refs` and quotes the OLD false
   comment in its body. Both line numbers and the quote are now stale: the
   comment is corrected and the throws sit at `broadcastFanOut.ts:545` and
   `relayFanOut.ts:1002`. Slice 7 should refresh those refs; the issue's
   ARGUMENT is unaffected.
4. The sweep found **no reason to change any behavior**. Slice 6 shipped exactly
   two corrected comments and two documents. Anyone reading the branch diff
   should see no functional change attributable to Sec 9.
