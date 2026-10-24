E1 swept the whole-app WRITE side for tracker #31, starting from the code (app/src and app/scripts on feat/today-checklist = main @970a29b9) and then comparing with spec r8 sections 7-8 and plan v4 sections 0-4 (slice text read only where a path landed): (1) every outbound send/persist path to a contact, against the stamp / no-stamp tables (last_reached_out_at, spec 7.2-7.3); (2) every path that re-sends, copies or adopts a message row, and every reader of the `automated` flag (system_copy, PR104/PR107/PR108); (3) every touchLastHeardFrom call site and the live event after it (spec 8, PR15/PR81); (4) every tour-create path (PR16); (5) every writer of a field Quiet shares reads that has no event Today hears.

Verdict: no BLOCKER. 1 MAJOR, 7 MINOR. Items 3 and 4 match the plan exactly (the S2 inbound-order table at plan ~7043-7056 and PR16 are complete). Line numbers are against main @970a29b9.

# Findings

## E1-1 - MINOR - masked relay calls and relayed member texts reach contacts and are in neither writer table

- Path: app/src/routes/webhooks/voice.ts:1243-1278 (handleMaskedInbound: `vr.dial` from the pool number, one `dial.number` per callee = every OTHER roster member); app/src/routes/webhooks/twilio.ts:1050 (a member's text relayed to the others: RELAY_FANOUT_JOB with the member's senderKey).
- What it does: a roster member calls or texts the pool number and the app dials / texts the other members, who are contacts.
- Classification: unlisted. Spec 7.3 lists only the originate/whisper-gate call (W6) and TEAM relay posts (W4). The plan handles only the INBOUND side of masked calls (PR15(b), S2.6). Real behavior is right: there is no stamp call site on the bridge, and W4's `payload.senderKey === TEAM_SENDER_KEY` gate (PR17) skips relayed member texts. Spec 7.2 says only calls "that staff send themselves" count.
- Residue: a `team_member`-typed contact on a relay roster, calling or texting from their own cell, is staff reaching contacts, and nothing stamps it. Rare.
- Correction: add one row to the spec 7.3 no-stamp table: "Member-to-member masked relay calls and relayed member texts - a member reached out, not staff; the caller's last_heard_from_at moves (PR15(b))". Add one PR21-style no-stamp case: a bridged masked call leaves `world.reachedOutTouches` empty for every callee. Record the team_member-on-roster case as accepted residue.

## E1-2 - MINOR - the W2 Retry gate reads a missing `automated` as a person's send; the three job readers read it as automated

- Path: the plan's W2 gate `original.automated !== true && original.system_copy !== true` (PR104) at app/src/routes/api.ts:1872. Compare jobs/retrySend.ts:556 `automated: retried.automated ?? true`, jobs/sendReconcile.ts:912 `retried.automated ?? true` and services/oneToOneRetryDecision.ts:119 `message.automated ?? true`.
- What it does: services/sendMessage.ts:684 has written `automated` on every row only since retry-send-window (spec dated 2026-09-24). An older row has no flag. A staff Retry made after this deploy of a failed pre-RSW automated text (a reminder, nudge, missed-call text or welcome text) passes W2's gate and stamps at the new send's time. PR104 marks only `automated === true` rows, so the new row also carries no `system_copy`, and a Retry of that Retry stamps too.
- Classification: spec 7.2 says a staff Retry of anything automated from its first send never counts. PR108 accepts only the pre-deploy `system_copy` gap, not this missing-flag gap.
- Correction: choose and record it explicitly. Recommended: keep `!== true`, because it matches spec 7.5's own backfill rule ("`automated` not true" counts), and add this case to PR108's accepted residue in the S2 report. It is rare: Retry is offered only on failed chain-newest rows, every such row is older than the RSW deploy, and the stamp ages out of Quiet shares within 14 days. The alternative (stamp only when `original.automated === false`, and mark `systemCopy` when `!== false`) would stop a pre-RSW staff text's Retry from stamping. That under-stamps, which is the safe direction, but it disagrees with 7.5.

## E1-3 - MAJOR - W3 stamps only the To contact; contacts on CC get the email too

- Path: app/src/services/sendEmailMessage.ts:282-287 (CC addresses accepted and validated), :407 (`email_cc` persisted), :450 (CC on the SES mail). The composer offers Cc as a normal field (dashboard/src/routes/contact/EmailComposer.tsx:147-253). The plan's PR12 stamps `{ contactId: input.contactId }` only.
- What it does: staff email a tenant and CC a caseworker. Caseworkers are in Quiet shares scope (spec 6.1). A CC'd contact with a quiet share is not stamped, so after staff emailed them they still show on Quiet shares, a missing stamp a user would see.
- Classification: spec 7.2 counts "emails ... that staff send themselves". The W3 row names only "the addressed contact" and never mentions CC, so this case was never decided.
- Correction (recommended): in W3, after SES accepts, resolve each CC address with `contacts.findByEmail` (one point read each; skip unresolved and deleted contacts). Stamp the To contact and the CC contacts in ONE `recordStaffOutreach` call at the same `nowIso` (the helper already dedupes by contactId). Emit one `contact.updated` per written contactId, bounded by the CC list. Then extend the spec W3 row ("the To contact and every CC address that resolves to a contact") and the W3 test (a CC'd contact is stamped; an unknown CC is skipped). If Cameron would rather not, record "CC'd contacts are not stamped" in the W3 row as accepted residue. The backfill (7.5) would then need the same choice for `email_cc`.

## E1-4 - MINOR - W6 stamps the contact found by phone, not the contact staff called

- Path: app/src/services/originateCall.ts:108 resolves the contact by `input.contactId`, but the thread is keyed only by the phone (:142-145) and the call row stores no contact id (:171-191). Plan PR13 / S2.4 step 3d stamps `findByPhone(targetPhone)`'s contact (voice.ts:1315). app/src/repos/contactsRepo.ts:1291-1296 documents findByPhone as first-match on duplicate phones (an accepted risk).
- What it does: when two live contacts hold one number (duplicates, or a shared office line), the stamp can land on the other contact, and the called person's quiet share stays.
- Classification: spec W6 says "the called contact". W1 has the same per-phone ambiguity and cannot avoid it (it stamps the phone contact). W6 is the one writer where the intended contact is known.
- Correction: have originateCall append the call row with `recipientContactId: contact.contactId` (NewMessage already carries it, messagesRepo.ts:776 / :2642). The press-1 post-response work then uses `stamp.row?.recipient_contact_id ?? target.contactId`. `stamp.row` is the row `updateCallStatus` already returns at press-1 (CallStatusUpdate.row, messagesRepo.ts:1337-1342), so nothing new is awaited before the `<Dial>` and WI3 still holds. This also lets the backfill name the call's contact (PR71). Otherwise, record it as accepted residue beside findByPhone's documented risk.

## E1-5 - MINOR - a contact can become ineligible with no event Today hears

- Paths:
  - app/src/routes/contacts.ts:2344-2386: the staff Do Not Contact toggle (`setFlag`/`clearFlag` sms_opt_out) emits nothing.
  - app/src/routes/contacts.ts:2779-2968: phone add, update and remove emit nothing. Removing the last or primary number gives "no phone".
  - app/src/routes/webhooks/twilio.ts:3925 (30005/30006 -> sms_unreachable) and :3984 (21610 -> sms_opt_out): the /status handler emits only `message.persisted`.
  - app/src/jobs/broadcastFanOut.ts:727 and :1519: the share fan-out sets sms_unreachable.
- What it does: each write makes a quiet-share person ineligible (isEligibleRecipient, lib/listingSendOutcome.ts:108-122). Today subscribes only to placement, conversation, suggestion, tour and contact `.updated` events (dashboard/src/routes/today/useToday.ts:142-157), so the row stays on an open Today until an unrelated refetch or a remount. No wrong action can follow from it: a text to that person is refused by the send gates.
- Classification: spec 6.1 lists opted out, unreachable and no phone as drop-offs. Spec 8 accepts staleness only for Not interested and for time-driven rows.
- Correction (recommended): emit one `contact.updated { contactId }` after the flag write in the opt-out route and in the three phone routes. It is cheap, already bridged, and every consumer already refetches on it. Then accept the /status and fan-out flags in spec 8 as residue: they are rare and follow a failed send. Or put all of them in spec 8's accepted list under the same reasoning as Not interested.

## E1-6 - MINOR - re-sharing the same property updates the pair's sentAt after the events Today hears

- Path: app/src/jobs/broadcastFanOut.ts:1232-1283 (recordPropertySent -> applyShareLedgerEntry -> putShareMemory) runs AFTER the share text's own send. That send's `conversation.updated` (services/sendMessage.ts:738) is the only event Today hears. `broadcast.updated` (broadcastFanOut.ts:229) is not heard.
- What it does: a re-share of a property to someone already listed under it restarts that pair's clock (a new sentAt), so the row should drop off. Today's 300 ms debounced refetch, bridged from the worker, can read the listing-sends row before the ledger write commits. The Follow up core's listing-sends Query is not a consistent read (PR90). The row then waits for the next refetch.
- Classification: unlisted. A re-share is not time-driven, so spec 8 does not accept it.
- Correction: record it as accepted residue (narrow race; re-share of the same property is unchecked by default, lib/blastAudienceRules.ts:178-182 `alreadySent`). Do not add a per-recipient event: a blast to 50 people would mean 50 events, against spec 6.5's cost note.

## E1-7 - MINOR - a multi-batch relay MMS is N fan-out jobs, so W4 emits N events

- Path: app/src/routes/api.ts:1439-1482 calls `sendRelayTeamMessage` once per carrier batch. Each call writes its own hub row (:2042) and enqueues its own RELAY_FANOUT_JOB (:2069).
- What it does: a photo drop split into N batches gives N stamps per member (forward-only, harmless) and N after-loop `conversation.updated` events. W1 emits once for N batches (PR10, first batch only).
- Classification: spec 7.3 allows "one live event per send operation". PR88 accepts one event per fan-out PASS for continuations, not per batch.
- Correction: no code change. Record it in the S3 report and the WI4 table as "W4 multi-batch relay MMS: N events for N batches" (bounded by planMmsBatches; Today debounces at 300 ms).

## E1-8 - MINOR - on the four "touch first" inbound paths, the live event depends on two other conditions

- Path: app/src/routes/webhooks/twilio.ts: 1:1 /sms :2748-2768, relay :1063-1076, group :2205-2225, closed group :1402-1421. `conversation.updated` fires only on a FRESH append AND when touchLastActivity succeeded. The heard-from touch (:2695, :961, :2192, :1388) runs on fresh and deduped deliveries alike.
- What it does: if touchLastActivity throws, or a redelivery repairs a crash between the append and the touch, `last_heard_from_at` moves and no event Today hears fires. The quiet row stays until the next refetch.
- Classification: the plan's S2 inbound-order table (~7046-7049) marks these "touch first, none", which is right for the normal path.
- Correction: record it as accepted residue in that table. It is pre-existing, and the Inbox goes stale the same way. Optionally apply PR15's rule there too (one `contact.updated` after a written touch when no `conversation.updated` will follow).

# Sweep record (every path enumerated; file:line on main @970a29b9 -> class)

## Item 1 - outbound send / persist paths to a contact (38)

| # | Path | Class |
|---|---|---|
| 1 | routes/api.ts:1564 POST /conversations/:id/messages, 1:1 (also the quick-reply sheet, dashboard QuickReply.tsx:153) -> services/sendMessage.ts:689 | W1 stamp (PR9/PR10) |
| 2 | routes/api.ts:1872 POST .../messages/:sid/retry -> sendMessage | W2 stamp, except share / automated / system copy (PR11/PR104); E1-2 |
| 3 | routes/api.ts:1667 -> services/sendEmailMessage.ts:395 persist, :469 SES | W3 stamp, To only; E1-3 |
| 4 | routes/api.ts:1455 -> sendRelayTeamMessage :2042 + :2069 -> jobs/relayFanOut.ts:1535 team legs | W4 stamp in the loop (PR17); E1-7 |
| 5 | routes/api.ts:1950 queued_pending team post -> services/relayQueuedMessages.ts:93 flush -> fan-out loop | W4 stamp at the leg's send (PR17) |
| 6 | jobs/sendReconcile.ts:1721 relay-leg re-drive -> fan-out loop | W4 stamp (PR17, WI6) |
| 7 | jobs/sendReconcile.ts:1022 adoptRelay (leg / rung adoption) | no stamp (spec W4 row) |
| 8 | routes/webhooks/twilio.ts:1050 member text relayed (member senderKey) | no stamp (senderKey gate); unlisted, E1-1 |
| 9 | routes/webhooks/twilio.ts:3077 relay 30003 rung row + jobs/relayRetryLeg.ts:836 | no stamp (listed) |
| 10 | routes/api.ts:1504 -> services/groupSend.ts:651 group-text post | W5 stamp (PR19) |
| 11 | routes/voiceApi.ts:140 -> services/originateCall.ts:157 (rings the staff cell), :171 call row | no stamp at originate (W6 rule) |
| 12 | routes/webhooks/voice.ts:1710 whisper-gate outbound `<Dial>` | W6 stamp after the TwiML (PR13/PR87); E1-4 |
| 13 | routes/webhooks/voice.ts:910 founder-bridge `<Dial>` (holder's staff cell) | n/a, not a contact (inbound triage) |
| 14 | routes/webhooks/voice.ts:1243 masked relay bridge `<Dial>` to other members | no stamp; unlisted, E1-1 |
| 15 | jobs/relayFanOut.ts:1126 relay intro -> services/relayAnnouncements.ts:229 row, :320 legs | W7 stamp when `intro_body` was edited (PR20); default intro no stamp |
| 16 | jobs/relayFanOut.ts:1190 member added | no stamp (listed) |
| 17 | routes/relayGroups.ts:635 group closed | no stamp (listed) |
| 18 | jobs/tourReminders.ts:1646 group tour reminder (poll and Send now) | no stamp (listed) |
| 19 | routes/dev.ts:1513 /__dev/relay/replay-intros (persist:false) | no stamp (PR20) |
| 20 | jobs/tourReminders.ts:1436 reminder poll, 1:1, automated:true | no stamp (listed) |
| 21 | jobs/tourReminders.ts:1998 forceSendReminder, automated:false | no stamp, writes system_copy (PR104) |
| 22 | jobs/placementNudges.ts:672 nudge poll, automated:true | no stamp (listed) |
| 23 | jobs/placementNudges.ts:854 forceSendNudge | no stamp, writes system_copy (PR104) |
| 24 | jobs/missedCallAutoText.ts:249, automated:true | no stamp (listed) |
| 25 | routes/public.ts:652 housing-fair welcome, automated:true | no stamp (listed) |
| 26 | jobs/retrySend.ts:551 automatic 30003 retry | no stamp (listed; PR107(a) marker) |
| 27 | jobs/sendReconcile.ts:923 adoptRetry | no stamp (listed; PR107(b) marker) |
| 28 | jobs/broadcastFanOut.ts:389 share sends through sendMessage | no stamp (listed) |
| 29 | jobs/broadcastFanOut.ts:1409 adoptBroadcastRecipient (carries broadcastId :1421) | no stamp (listed) |
| 30 | routes/dev.ts:904 transcript fixture, outbound | W8 stamp (PR14/PR46) |
| 31 | routes/dev.ts:1112 message fixture, providerSid branch | W8 stamp, outbound 1:1 only (PR14/PR47) |
| 32 | routes/dev.ts:1177 message fixture, direct-put branch | W8 stamp, outbound 1:1 only (PR14/PR47) |
| 33 | routes/dev.ts:427 and :535 reminder / nudge tick seams -> the polls | no stamp (automated) |
| 34 | routes/dev.ts:1433 listing-send fixture (ledger row only, no message) | no stamp (share) |
| 35 | routes/voiceApi.ts:251 cell verify-start SMS | n/a, staff user's own cell, not a contact |
| 36 | lib/import/apply.ts:357-804 importer message rows | no stamp (listed) |
| 37 | lib/seed/*, lib/performanceSeed.ts | no stamp (listed) |
| 38 | keyword replies (twilio.ts:1256-1258: the app composes none; Twilio Advanced Opt-Out sends them) | n/a, no app writer |

TEAM_SENDER_KEY is written only by staff paths (api.ts:1964, :2056, :2072; groupSend.ts:676; relayQueuedMessages.ts:96), so no automated send can reach W4's stamp. `staffOutreach` is opt-in, so no other sendMessage caller can reach W1/W2's stamp. No script in app/scripts sends to a contact.

## Item 2 - re-send / copy / adopt paths and `automated` readers (9 paths + 6 readers)

| # | Path | Class |
|---|---|---|
| 1 | routes/api.ts:1872 manual Retry | PR104 gate + marker inheritance; E1-2 (missing flag) |
| 2 | jobs/retrySend.ts:551 automatic 30003 retry | PR107(a) carries the marker |
| 3 | jobs/sendReconcile.ts:923 adoptRetry | PR107(b) carries the marker |
| 4 | jobs/tourReminders.ts:1998, jobs/placementNudges.ts:854 Send now | PR104 writes the marker |
| 5 | jobs/tourReminders.ts:1646 group Send now (relay announcement, author system) | marker cannot matter: W7 is gated on staffAuthored, not on a row flag |
| 6 | twilio.ts:3077 + relayRetryLeg.ts:836 relay rung; sendReconcile.ts:1022, :1721, :1730 relay adoption and re-drives | marker cannot matter: relay stamping keys on senderKey / staffAuthored; system_copy rows are 1:1 only |
| 7 | services/relayQueuedMessages.ts:93 queued flush | team posts; marker n/a |
| 8 | broadcastFanOut redrives, :1409 adoption; sendReconcile.ts:1503 adoptedShareRetry | broadcast_id excludes them; marker n/a |
| 9 | forward / duplicate / user-scheduled send | none exists (GET /conversations/:id/scheduled is read-only) |

`automated` readers: jobs/retrySend.ts:556 (pass-through), jobs/sendReconcile.ts:912 (copy), services/oneToOneRetryDecision.ts:119 (refusal preview), services/sendMessage.ts:551 and :561 (input-flag gating), repos/messagesRepo.ts:2641 (append mapping). None reads system_copy. A system_copy row stays automated:false, exactly as a Send-now row is today, so no gating changes. No dashboard file reads either flag. There is no "last staff message", auto-reply suppression or quiet-hours reader of a row's author / automated.

## Item 3 - inbound touchLastHeardFrom paths (14)

| # | Path | Event Today hears after the touch | Class |
|---|---|---|---|
| 1 | twilio.ts:2695 1:1 /sms | conversation.updated :2768 | touch first (E1-8 residue) |
| 2 | twilio.ts:961 relay member | :1076 | touch first (E1-8) |
| 3 | twilio.ts:1388 closed group | :1421 | touch first (E1-8) |
| 4 | twilio.ts:2192 group text | :2225 | touch first (E1-8) |
| 5 | voice.ts:834 founder triage | none (message.persisted :809) | PR81 adds contact.updated |
| 6 | voice.ts:1122 masked refused | none | PR15(b) |
| 7 | voice.ts:1220 masked bridged | none | PR15(b) |
| 8 | services/inboundEmail.ts:833 | emitted BEFORE, at :770 | PR15(a) |
| 9 | routes/unmatchedEmail.ts:206, :334 re-ingest -> ingestInboundEmail | as 8 | inherits PR15(a) |
| 10 | routes/webhooks/ses.ts:147 -> ingestInboundEmail | as 8 | PR15(a) |
| 11 | voice /status, /recording, /voicemail-done, /intelligence; jobs/voiceTranscript.ts | no touch (the touch is at ring time) | n/a |
| 12 | routes/dev.ts:836 (call sites :917, :1141, :1178) | none | plan: no change |
| 13 | lib/import/apply.ts:535 | none (batch) | n/a |
| 14 | scripts/backfill-last-heard-from.ts:252 | none (offline) | n/a |

attributeInbound (lib/heardFrom.ts:62) returns undefined for every outbound row, so no outbound path can move `last_heard_from_at` (spec 7.1 holds).

## Item 4 - tour creates (3)

| # | Path | Class |
|---|---|---|
| 1 | routes/tours.ts:367 POST /api/tours (requested and scheduled) | PR16(a) emits tour.updated |
| 2 | routes/units.ts:1654 Interested outcome (requested) | PR16(b) emits tour.updated |
| 3 | lib/seed/* and lib/performanceSeed.ts | seeds; no event needed |

There is no other `tours.create` or tours-table put in app/src or app/scripts. 'requested' is a create-only state (tours.ts:1218). Auto-close never touches requested tours (lib/toursModel.ts:166). Every status change already emits tour.updated (tours.ts:1656, :1719; placements.ts:904; rosterActions.ts:161; rosterProvision.ts:511; tourAutoClose.ts:138).

## Item 5 - writers of fields Quiet shares reads

- Outcome: units.ts:1694 setDeclined / clearDeclined emit nothing (accepted, spec 8 Not interested). Tour create is PR16. Tour cancel emits (tours.ts:1656). A re-share is E1-6.
- Unit availability (statusTransition.ts:342, the units PATCH and delete): accepted by spec 8.
- Eligibility: Inactive emits contact.updated (contacts.ts:2227). Placed emits (services/statusTransition.ts:620, :678). Deleted emits (contacts.ts:2451, :2465). A STOP keyword is fine: the inbound touch that restarts the clock comes before its event. The staff opt-out toggle, phone edits, the /status flags and the fan-out flag are E1-5.
