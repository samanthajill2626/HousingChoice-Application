# Marker sweep - findings (design-phase research, 2026-09-24, main @31bccd98)

Read-only sweep of app/src for handlers that claim a run-once / dedupe marker and
then can throw in a way whose only recovery would be a redelivery (or, for poll
loops, the next tick). Excluded (this mission's own sites): relay.fanOut +
runRelayFanOutExecution + sendOneRelayLeg, broadcast.send, relay.retryLeg.
Produced by a code-explorer child (opus); planner has NOT yet re-verified every
citation - verify each before filing.

Correction to the anchor issue: its "retrySend.ts:122-128 ... does not rely on
redelivery" is WRONG - retrySend has the same claim-then-rethrow shape (F4).

Shared causes:
- sendRelayAnnouncement has two unguarded pre-send awaits
  (relayAnnouncements.ts:181 getById, :229 append); its docblock (:170-171) says
  such a failure "propagates (nothing was sent, the caller may retry)" but no
  marker-holding caller can retry. Drives F2, F3, group path of F6.
- sendMessage failures all look alike: pre-provider (sendMessage.ts:278, :307,
  :350), the Twilio create (:394, rethrows 429/30022 too, messaging.ts:692-707),
  and post-send (:398 append, :432, :433) all reach callers as plain errors.
  Drives F4-F7. (accepted-send-lost-when-append-fails piece 1 territory.)
- Hermetic lanes cannot see any of it: the in-process adapter swallows dispatch
  failures and never redelivers (app/src/adapters/scheduler.ts:197-201).

## SQS job handlers

F1 relay.numberReady - intro + queued messages lost (medium)
- Marker: status flip connecting->open (relayNumberReady.ts:149, read-check
  :97-125); per-message flip updateDeliveryStatus(...,'queued') at
  relayQueuedMessages.ts:89. Key is status, so a FRESH enqueue is also
  suppressed.
- Throws (after flip, before any text): relayNumberReady.ts:176
  enqueueImmediate(RELAY_INTRO_JOB); relayQueuedMessages.ts:93
  enqueueImmediate(RELAY_FANOUT_JOB).
- Lost: the group intro; any team message whose enqueue failed (never sent,
  neutral "Queued" forever). Nothing surfaces it (stuck-connecting
  reconciliation poolNumbers.ts:658-662 cannot fire once open). Contradicts
  relayNumberReady.ts:182 / relayQueuedMessages.ts:87-88. Siblings guard their
  enqueues (relayProvisioning.ts:198-205, poolNumbers.ts:663-675).

F2 relay.intro (medium)
- Marker relayFanOut.ts:830 (jobId). Nothing re-enqueues an intro.
- Throws (all pre-send): relayFanOut.ts:839 getById; relayAnnouncements.ts:181,
  :229. Per-member loop (:266-381) catches per member.
- Lost: intro to every member + its thread bubble; one `job failed` ERROR.

F3 relay.memberAdded (medium)
- Marker relayFanOut.ts:901 (jobId); enqueued once per add (relayMembers.ts:259-271).
- Throws (pre-send): relayFanOut.ts:908 getById, relayAnnouncements.ts:181, :229.
- Lost: new member's intro (their only context) + the group notice.

F4 messaging.retrySend (medium)
- Marker retrySend.ts:131 (jobId). Explicit rethrow retrySend.ts:218 for every
  non-refusal error.
- Pre-send: presign :164-166; sendMessage pre-provider sites; the Twilio create
  (4xx/5xx/429 = definite non-send; response timeout ambiguous).
- Post-send (suppression correct): sendMessage :398/:432/:433;
  retrySend.ts:226 annotateMessage (retry_attempt missing -> chain restarts at 1).
- Lost: the automated 30003 retry; the "exhausted retries" ERROR (twilio.ts:3358)
  never fires; staff cannot tell the retry never ran.

F5 call.missedAutoText (low)
- Marker :175 keyed on callSid (NOT jobId) - a fresh enqueue for the same call is
  suppressed forever, by design (:7-14).
- Pre-send: :184 getOrgSettings() unguarded + sendMessage pre-provider sites.
  Explicit rethrow :264. Documented tradeoff (:254-259) covers post-provider
  failures only; :184 and pre-provider sites carry no duplicate risk.

## Poll loops (next tick = redelivery analog)

F6 tour reminder poll (medium)
- claimSend stamps sentAt (tourReminders.ts:1421 1:1, :1601 group, :1968 Send now).
- Throws: 1:1 :1436 -> rethrow :1475 into per-row catch (:841-850); group :1612
  -> :1646 -> relayAnnouncements.ts:181/:229 (pre-send, no local catch); Send now
  rethrow :2031 (operator sees 500).
- Lost: the reminder rung, and the panel shows "Sent - <time>" (state from sentAt
  alone, routes/tourReminders.ts:193). 1:1 loss documented as accepted
  (:1433-1434, :1468-1470); group pre-send loss undocumented. Extends
  reminder-state-sent-overstates-delivery.md.

F7 placement nudge poll (low-medium)
- claimSend :660, Send now :844. Throws :672 (sendMessage pre-provider) ->
  rethrow :711 into per-row catch (:353-364); Send now :854 -> :888.
- Lost: the nudge; card shows "Sent" (routes/placementNudges.ts:175). Documented
  as accepted (:669-670, :705-706).

F8 pending roster-action poll (low-medium)
- claimApply rosterActions.ts:497; explicit rethrow :512 (ERRORs :508-511, :640).
- Pre-side-effect throws: rosterProvision.ts:335/:340 claimGroupThread, :603
  getById; relayMembers.ts:136, :164, :193 (burn), :219->:228.
- During/after provisioning: rosterProvision.ts :346->:385, :647->:681,
  :398->:412 (tour pointer), :716 audit.append.
- After member added: relayMembers.ts:230 audit.append unguarded - skips the join
  announcement (:259-271) and rosterActions.ts:510 then logs "the action did not
  happen", which is false.
- Lost: the operator-confirmed deferred open/add; banner disappears. Deliberate
  (:27-29, :500-504) but pre-side-effect failures could stay pending like the
  existing `wait` verdict (:474-480).

## Webhook consumer

F9 voice recording callback after a successful mirror (low-medium)
- Marker setCallRecording voice.ts:2013 + early return :1957.
- Throws after recording stored: :2065 upgradeCallOutcomeToVoicemail; :2109 ->
  :2216 setTranscriptPending then :2217 getByProviderSid; :2042
  releaseCallRecording inside the mirror-failure catch.
- Lost: voicemail upgrade (no re-flag, no push) + transcription; if :2216 lands
  and :2217 throws, "Transcribing..." forever. Distinct from
  recording-claim-redelivery-loss-window.md.

## Clean (checked)
inboundEmail object marker (:443-446, claims last before return); extraction
poll (extraction.ts:408; caveat :733); groupRail.ensure (groupRail.ts:427, claim
expires ~5min; caveat :720); groupGuardrails (:167); journalSweep (:137, :325);
1:1 inbound SMS webhook (twilio.ts:2449-2489); relay inbound webhook
(twilio.ts:967-975, :1012); closed-group late text + native group inbound
(twilio.ts:1277-1360, :1998-2155); /voice/status missed-call side effects
(voice.ts:2282-2298); onNumberRegistered (poolNumbers.ts:652, :663-675); relay
retry claim in status webhook (twilio.ts:2841-2870; crash window already filed
relay-retry-stranded-claim-window); Conversations webhook / recordClassicInbound
(groupCrossCheck.ts:289-292).

## No marker - a throw genuinely redelivers (out of scope)
media.mirror (mediaMirror.ts:121); voice.createTranscript (voiceTranscript.ts:162);
voice.reconcileTranscript (:252); relay.warmNumber (relayWarm.ts:87); inbound-mail
SES events (emailEvents.ts:203).

## Nearby silent losses (not claim-then-throw)
- Group-close announcement (relayGroups.ts:624-648): caught failure after
  claimCloseAnnounce loses the "group closed" message permanently.
- sqsJobConsumer.ts:177-181 logs a failed dispatch WARN without `err`; the
  inbound-mail path bypasses dispatchJob, so an ingest error object is never
  logged anywhere.
