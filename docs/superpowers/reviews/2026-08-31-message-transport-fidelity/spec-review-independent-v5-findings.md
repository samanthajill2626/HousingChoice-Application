# Independent adversarial review - message transport fidelity spec v5

Date: 2026-09-01
Spec reviewed: `docs/superpowers/specs/2026-08-31-message-transport-fidelity-design.md`
at `051a4442` (v5). Spec base: `5ce9912f`. Live code cited from the worktree
at `051a4442`, which is docs-only over that base; where `main` (`f27aabbf`)
has since moved a cited file, the drift is called out (finding L2).
Method: read the spec cold, inventoried writers/readers with rg, verified
claims against code and current Twilio documentation, constructed
counterexamples, and only then read the four prior review rounds and their
adjudications.

Assessment lane: no spec, code, test, or prior artifact was changed.

## Verdict

FAIL. Not safe to approve for implementation planning as written.

Counts: 2 BLOCKING, 1 HIGH, 6 MEDIUM, 3 LOW (12 findings).

The four prior rounds converged the internal storage/aggregation model to a
consistent state. None of them tested the spec's provider-evidence premise
against Twilio's documented webhook contracts, nor the interaction between
"writes are conditioned on `transport_schema_version = 1`" and "a preflight
failure aborts before any send" on rows that pre-date the deploy. Both fail.

## Findings

### B1. [BLOCKING] The actual-transport evidence source does not exist for SMS/MMS

What is wrong: the spec makes `ChannelPrefix` the evidence for SMS, MMS and
RCS on both the status callback and the inbound webhook (4.1:104-121,
7.4:410-414, 13.1 item 3, 11:622-626). Twilio documents `ChannelPrefix` only
for channel messages, and does not list it on the inbound webhook at all.

Provider evidence (current official docs):

- Message resource, "Twilio's request to the StatusCallback URL"
  (<https://www.twilio.com/docs/messaging/api/message-resource#twilios-request-to-the-statuscallback-url>):
  "If the Message resource uses RCS, WhatsApp, or another messaging channel,
  Twilio's request to the StatusCallback URL contains additional properties":
  `ChannelInstallSid`, `ChannelStatusMessage`, `ChannelPrefix` ("The
  channel-specific prefix identifying the messaging channel associated with
  this Message"), `EventType`. The SMS/MMS-specific addition is only
  `RawDlrDoneDate`. Same table on
  <https://www.twilio.com/docs/messaging/guides/track-outbound-message-status>,
  which also lists `From` among the standard callback parameters.
- Inbound webhook parameter list
  (<https://www.twilio.com/docs/messaging/guides/webhook-request>): standard
  (`MessageSid`, `From`, `To`, `Body`, `NumMedia`, `NumSegments`, ...), media,
  rich-messaging, location, geographic, WhatsApp-specific. No `ChannelPrefix`,
  no `ChannelInstallSid`.
- RCS send page (<https://www.twilio.com/docs/rcs/send-an-rcs-message>): "If
  Twilio successfully delivers the message over RCS, the `From` field contains
  `rcs:<SenderId>`", visible in "outbound message status callbacks" and in a
  fetched Message resource. That page names no `ChannelPrefix` and does not say
  what a fallback callback carries.

Live code: the status handler reads only `MessageSid`, `MessageStatus`,
`ErrorCode` (`app/src/routes/webhooks/twilio.ts:2338`); the four inbound
branches append `type` from media count (`twilio.ts:593`, `:965`, `:1701`,
`:2112`); the fake status callback carries `MessageSid`, `MessageStatus`,
`ApiVersion`, optional `ErrorCode` and no `From`
(`fake-twilio/src/engine/signer.ts:188-197`). `ChannelPrefix` appears nowhere
in `app/`, `fake-twilio/` or `e2e/` (rg).

Concrete failure scenarios:

1. Every new inbound 1:1, unknown-sender and relay-member SMS/MMS row is
   written schema version 1 with no evidence (7.4:416-418) and renders
   `Unknown` (9.2:544). That is the majority of bubbles on every contact
   timeline and relay thread; today they read `SMS`/`MMS`. Decision 9 was
   locked on the belief that evidence normally exists; it does not, for any
   SMS/MMS inbound.
2. An RCS-requested send that falls back: the fallback is an SMS/MMS message,
   so by the documented table its callbacks carry no `ChannelPrefix`; actual
   stays absent and the chip reads `RCS` forever (9.3 rule 1). `RCS -> SMS`,
   `RCS -> MMS` and `RCS -> Mixed` (1:20-23, 13.2:736-737) are unreachable
   from the spec's own evidence rule. If Twilio instead keeps `ChannelPrefix:
   rcs` on a message that "uses RCS" but fell back (undocumented either way),
   the normalizer would record actual `rcs` for an SMS delivery - worse.
3. A multi-recipient RCS send with one carrier-filtered fallback leg: 9.4:581-582
   keeps the failed leg in the expected set with no evidence, so the aggregate is
   pending forever and the main chip asserts `RCS` for a send whose successful
   legs went by SMS.
4. The browser proof (13.2:736-738) passes on a synthetic `ChannelPrefix=sms`
   callback that the real provider never emits, so the mission can be declared
   verified while production shows none of the headline states. This is the
   "verify what you shipped, not what you tested" failure shape.

Impact: the feature's primary product outcome (requested vs actual, fallback
visibility) is not deliverable from the named evidence, and the visible
result of shipping it is a chip regression (`SMS`/`MMS` -> `Unknown`) on the
most common bubble type.

Minimum correction: rewrite 4.1 and 7.4 to the documented signals. State that
(a) SMS-vs-MMS actual transport is not observable from any Twilio message
callback or inbound webhook; (b) the only documented RCS-vs-fallback signal is
the `From` address prefix (`rcs:` vs E.164) on outbound status callbacks and on
the fetched Message resource; (c) whether a fallback callback carries any
`Channel*` field is undocumented and must be probed against live Twilio before
the normalizer is designed. Then re-open the human decision behind locked
decision 9 with the true consequence spelled out (every inbound SMS/MMS reads
`Unknown`), and choose one of: accept it explicitly; render no chip on inbound
rows without evidence; or admit a bounded adapter-boundary observation for
SMS/MMS (the spec currently forbids SID prefix and `NumMedia` at 4.1:119-121 -
if that stays, say plainly that inbound SMS/MMS will never have actual
transport). Fake Twilio and the browser proof must mirror the documented
payload (`From`), not `ChannelPrefix=sms`.

### B2. [BLOCKING] Legacy relay sources stop delivering after the deploy

What is wrong: 5.4:246-248 conditions every repository transport write on
`transport_schema_version = 1`; 7.2:346-362 and 8.5:506-510 require the
all-current-member preflight before the first provider send and say a preflight
that cannot be completed aborts the execution; 14:780-781 routes that abort to
the job's current retry/error path. A relay source row written before the
deploy has no `transport_schema_version`, so every conditional preflight write
on it fails, every execution aborts, and no member is ever sent.

Reachable paths, all live:

- A fan-out job in SQS at deploy time (`app/src/jobs/relayFanOut.ts:328-345`;
  enqueued at `app/src/routes/api.ts:1805-1810`).
- Backed-off continuations, `runAt` 5/10/20 s (`relayFanOut.ts:583-596`) and
  SQS redeliveries of a job that threw (`relayFanOut.ts:532-535`).
- `queued_pending` holds on a connecting group (`api.ts:1689-1749`), released
  later by `app/src/services/relayQueuedMessages.ts:86-99`, which enqueues the
  ordinary fan-out for rows that can be days old (a group waiting on number
  purchase/A2P). Those rows are schema-absent by construction.
- The per-leg `planned -> attempted` transition (7.2:371-372) is likewise a
  conditioned write with no stated behaviour on a legacy row.

Impact: relayed messages silently never reach members after the deploy; the
job either loops through SQS redelivery or lands in the DLQ; the thread shows
`queued` slots forever. This directly contradicts 1:36-37 and 15:797-798 ("does
not ... alter delivery behavior"), and 14:775 ("cannot expose a falsely
complete subset") is satisfied only because nothing is sent.

Minimum correction: define that on a schema-absent source row every transport
write (initializer, preflight, `attempted`, result op, callback) is a
recorded no-op and the send path proceeds exactly as today; the abort rule in
7.2/8.5/14 applies only to a version-1 row whose preflight fails for a real
error. Add to 13.1 item 9: a pre-feature (schema-absent) team source and a
`queued_pending` hold flushed after the feature both still fan out and record
nothing.

### H1. [HIGH] The result operation cannot record the common success outcome under the forward-status machine

What is wrong: 8.5:512-517 says `applyRecipientSendResult` writes status, SID,
sent timestamp, error and actual "under the existing forward-status ... state
machine". That machine forbids same-status transitions
(`app/src/repos/messagesRepo.ts:120-129`: `queued` allows only
`queued_pending` as prior). The relay and announcement success paths write
status `queued` when the provider result maps to `queued`
(`relayFanOut.ts:539-544`, `app/src/services/relayAnnouncements.ts:281-286`),
and `mapTwilioStatus` maps `accepted`, `queued`, `sending` and anything unknown
to `queued` (`app/src/adapters/messaging.ts:533-548`) - i.e. the normal
Messaging Service create response. The slot was seeded `queued` (api.ts:1770,
relayAnnouncements.ts:193) or created `planned` with whatever status the
preflight assigns (see M1). Today `setRecipientDelivery` is an unconditional
whole-slot SET (`messagesRepo.ts:2766-2786`), so this never mattered.

Failure scenario: team relay send, three members. Each leg returns `accepted`.
The result op computes `queued -> queued`, the forward-only condition refuses,
and `sid`, `sentAt` and any `actualTransport` are never written. The relaysid
pointer still points at a slot with no SID; the transient path
(`relayFanOut.ts:527`, `queued` with an error code) is refused the same way and
the error code is lost.

Impact: SID-less slots, missing `sentAt` (the staleness presenter keys on it,
`dashboard/src/routes/contact/Timeline.tsx:778-790`), lost transient error
codes, and no actual transport on exactly the legs that succeeded.

Minimum correction: specify that the result operation conditions only the
`status` child on the forward machine and treats same-status as an allowed
write for the non-status children (SID absent-only as `setRecipientDeliverySid`
already does at `messagesRepo.ts:2865-2887`, `sentAt`, `errorCode`, actual
under 8.3). State it in 8.5 and add the `accepted -> queued` success case to
13.1 item 6.

### M1. [MEDIUM] Preflight-created slots have a required `status` the spec never assigns

`RelayRecipientDelivery.status` is required (`messagesRepo.ts:142-149`). An
inbound source seeds `{}` (`twilio.ts:598`) and slots exist today only after a
send result. 7.2:346-349 creates "every missing current-member slot" and
5.3:201-209 adds only optional fields, so the builder must invent the initial
status. Whatever value is chosen changes a reader: `queued` makes an excluded
(removed-before-attempt) member a permanent "Queued" row in the inbound relay
disclosure that 9.4:587-591 now exposes, and puts non-terminal slots in front of
the callback path (`messagesRepo.ts:2789-2812`) where previously no slot
existed. Specify the initial status of a preflight-created slot and how an
`excluded` never-attempted slot is presented in the recipient rows
(`Timeline.tsx:1028-1064`, `presentLegDelivery` at
`dashboard/src/routes/contact/deliveryStatus.ts:500`).

### M2. [MEDIUM] Persisted announcements are not assigned aggregation states

7.2:386-389 gives announcements the intent/result contract; 7.2:349-351 mentions
a "persisted-announcement source" only inside the worker preflight paragraph;
5.3:229-231 makes the state optional on "source-time relay slots that have not
yet been reconciled by a worker". `sendRelayAnnouncement` is not a worker
execution: it seeds every slot `queued` at append and sends in-process
(`relayAnnouncements.ts:190-207`, `:230-316`; on `main` the same shape with
per-recipient bodies, `bodyFor` at `main:relayAnnouncements.ts:140,279`). If no
state is written, every announcement slot is state-absent, "no slot
participates" (9.4:585) and the announcement chip can never show actual or
`Mixed` even with complete evidence; if state is written, the spec does not say
which operation marks `planned`/`attempted`/`excluded` or when. Tour-reminder
group rungs (`app/src/jobs/tourReminders.ts:1267`) and the intro/member-added
jobs (`relayFanOut.ts:641`, `:687`) all ride this path. Say explicitly that a
persisted announcement is an execution: preflight every roster slot `planned`,
`attempted` immediately before each `adapter.sendMessage`, `excluded` on
suppression.

### M3. [MEDIUM] Refused-transition warnings will log member phone numbers

8.3:469-472 logs "message key or recipient key" and 14:783-784 promises "no
bodies or phone numbers". The recipient key is `phone#<E164>` for any member
without a contact (`messagesRepo.ts:157-161`); `relayAnnouncements.ts:127-136`
(`logSafeMemberKey`) exists precisely because logging that key leaks a phone.
Specify that transport warnings log `logSafeMemberKey`, never the raw member
key, on every relay/announcement path.

### M4. [MEDIUM] Imported history flips from `SMS` to `Unknown` at the next import

5.2:194-197 and 11:641-643 write version 1 with no evidence for imported rows,
which therefore render `Unknown` (9.2, 9.3 rule 5) - inbound and outbound
alike (`app/src/lib/import/apply.ts:409-431` writes both directions). Rows from
the pre-feature import keep `SMS`. A later import of the same export source
(the post-port sweep is still owed per project notes) produces one contact
timeline whose older history says `SMS` and newer history says `Unknown` for
messages of identical provenance. This is a spec-author choice, not a locked
decision (decision 7 is no migration; decision 8 is pre-contract rows; decision
9 is runtime inbound). Minimum: the importer writes schema-absent rows (legacy
label) unless the source carries explicit transport, or the human accepts the
inconsistency in writing.

### M5. [MEDIUM] Seeded worlds become `Unknown`-dominated unless seeds author evidence

11:630-631 requires every seeded/generated message to carry version 1; seeds
write items directly (`app/src/lib/seed/index.ts:153`, `cast.ts` and `lean.ts`
`type: 'sms'` rows, `performance.ts:932`). 11:632-639 lists six scenarios but
says nothing about the ordinary inbound rows, which are the bulk of the demo
(`full`) world the founder is shown and the byte-stable `lean` e2e world.
Under B1 those rows have no runtime evidence either, so the seed must either
author `actual_transport` (acceptable: the seed is the fake provider) or the
demo reads `Unknown` on nearly every inbound bubble. State which, and note
that `lean` byte-stability means the choice is a one-time reseed contract.

### M6. [MEDIUM] Relay classification input is unspecified where `type` and what is sent already disagree

6:276-278 classifies from "durable message facts" without naming them.
`sendRelayTeamMessage` sets `type: 'mms'` when either `mediaUrls` or
`attachments` is present (`api.ts:1784-1788`), but the fan-out forwards only
`mediaAttachmentsOf(sourceMessage)` (`relayFanOut.ts:395-396`, `:494-500`);
raw `mediaUrls` without attachments (the internal/e2e seam, `api.ts:1239-1245`)
and the no-`MEDIA_BUCKET` case (`relayFanOut.ts:425-432`) both send text-only
legs. A classifier keyed on the same predicate as `type` records requested
`mms` for legs that go out as SMS; since SMS callbacks carry no evidence (B1),
the chip says `MMS` permanently. Name the durable fact for a relay source as
the attachment set the fan-out will actually forward, and say what the
classifier returns when the leg cannot carry media.

### L1. [LOW] Duplicate stale callbacks after RCS fallback emit a warning each

8.3:469-472 warns on every refused transition. Twilio redelivers and can
reorder callbacks; after `rcs -> sms` is stored, each late or duplicate `rcs`
observation is "refused" and warns. Treat a refused transition whose attempted
value equals a value already superseded by the allowed fallback path as an
idempotent no-op at info level, so the prod warn sweep is not polluted.

### L2. [LOW] Cited line numbers are stale against `main`

`main` at `f27aabbf` has merged Phase B since the spec base: `relayFanOut.ts`
is +523 lines (the fan-out loop is intact but shifted ~370 lines; `defineJobHandler`
at `main:relayFanOut.ts:697`, `adapter.sendMessage` at `:873`),
`relayAnnouncements.ts` gained per-recipient bodies, and `contactTimeline.ts`,
`api.ts`, `dev.ts`, `seed/lean.ts` moved. Not a spec defect; 12:695-697 already
demands a fresh inventory, but the plan must inventory against the synced
branch, not this spec's citations.

### L3. [LOW] Section 1 under-states the chip vocabulary that 9.3/9.4 produce

1:15-27 lists only `RCS -> *` arrows and `RCS -> Mixed`; 9.3 rule 3 and 9.4
produce all nine pairs plus `SMS -> Mixed` / `MMS -> Mixed`. Harmless for the
builder, misleading at the human gate.

## Prior-round remedies: do they hold?

Read after the findings above.

- R1 A1 (optimistic marker): holds. The three writers are exactly
  `useGroupThread.ts:107-132`, `useRelayThread.ts:239-271`,
  `useContactTimeline.ts:262-310`; the marker precedes the legacy rule (9.1).
- R1 A2/B2, R2 3/4, R4 1 (expected set, capture, routing): the v5 aggregation
  state machine is a genuine resolution, not a rename. It keeps
  membership-at-execution (`relayFanOut.ts:398-438`) and gives added/removed
  members a truthful state. It does, however, introduce B2 (legacy rows) and
  M1 (initial status), which no round examined.
- R1 A4/A5, B3, R2 1 (suppressed slots): holds. Requested intent survives
  suppression; actual never written; the `contact_opted_out` code drives
  presentation, matching `Timeline.tsx:858-860` and `deliveryStatus.ts:387-399`.
- R1 B1 (pre-send row): holds; send-then-append retained.
- R2 2 (whole-slot writes): the remedy names the operation but under-specifies
  it - H1 shows the "existing forward-status machine" wording makes the op
  refuse the common success case.
- R2 5 (fresh media): holds; the two-stage contract puts presign after the
  slot/suppression checks and before late preparation (7.2:369-372).
- R2 6 (no refusal on drift): holds.
- R3 1 (continuation reuses the slot): holds; `recipientKeys` continuation
  and `putRelaySidPointer` model unchanged (`relayFanOut.ts:435-438`,
  `:545-549`).
- R3 2 (post-append member): holds via the absent-only initializer.

None of the four rounds checked 4.1 against Twilio; B1 stands alone.

## Attacked but not broken

- Requested transport is adapter-owned and RCS-safe: 6:290-300 localizes the
  text/media policy in `adapters/messaging.ts` and the MMS rail fact in
  `adapters/groupConversations.ts`; services persist but do not construct it;
  the optimistic `type: 'sms'` claims (`useGroupThread.ts:124`,
  `useRelayThread.ts:255`, `useContactTimeline.ts:301`) are removed from
  presentation by the marker. `type` stays for media/failure copy
  (`Timeline.tsx:848-849`, `contactTimeline.ts:410`).
- Native group: one `postGroupMessage` (`groupSend.ts:394-395`, port at
  `groupConversations.ts:81-107`), rail-only MMS evidence, receipts carry no
  channel (`groupReceipts.ts:422-432` writes status/sid only), suppressed
  slots keep `undelivered`/`contact_opted_out` (`groupSend.ts:595-617`). The
  legacy `type: 'sms'` at `groupSend.ts:630` is fully isolated from the chip
  by the version-1 rule.
- Callback races: the relaysid pointer is written after the result
  (`relayFanOut.ts:544-549`), the status handler retries the lookup once
  (`twilio.ts:2406-2432`), and the group path parks early receipts
  (`groupSend.ts:663-670`). Transport evidence rides every callback, so a
  dropped early callback is recovered by the next one.
- Out-of-order actual observations: `absent -> x`, `rcs -> sms|mms`, refuse
  the rest, condition on the stored value - expressible as one conditional
  `UpdateExpression`; a late `rcs` after a stored `sms` is correctly refused.
- Independent state machines and SSE: the two existing emit sites
  (`twilio.ts:2389-2397`, `:2496-2505`; `groupReceipts.ts:455-460`) are the
  right places; 8.4 keeps them silent on double no-ops.
- Crash windows: between preflight and `attempted`, and between `attempted`
  and the provider call, SQS redelivery re-resolves the roster and resends a
  non-terminal slot exactly as today (`relayFanOut.ts:446-448`).
- Continuation roster filtering (`relayFanOut.ts:435-438`): no `planned`
  never-attempted slot can survive a completed execution, so the
  `recipientKeys` subset cannot strand an `excluded` decision.
- API readers: `GET /conversations/:id/messages` returns raw items
  (`api.ts:2134-2147`, `:2153-2165` spreads); the explicit mappers that must
  add the fields are `contactTimeline.ts:397-446`,
  `useRelayThread.ts:69-126` (shared by the group thread via
  `buildRelayItems`) and `buildTimelineFallback.ts:64-99`; dashboard `Message`
  (`dashboard/src/api/types.ts:2124`) and `RelayRecipientDelivery` (`:1614`)
  are additive-safe. Section 10 covers them without naming them; the plan
  should.
- Kill-switch refusal inside the adapter (`messaging.ts:620-628`) marks a leg
  `attempted` with no provider call; harmless while requested is SMS/MMS
  (label unchanged), noted only because it is a permanent-pending source in
  an RCS world.
- Meta line with no chip: `Timeline.tsx:818-824` already filters a null first
  fragment.

## Explicit unknowns (not resolvable from the repository)

1. Whether a Messaging Service RCS message that falls back to SMS/MMS keeps
   the same `MessageSid` and whether its callbacks carry `ChannelPrefix`
   (and with what value) or only a bare E.164 `From`. Twilio documents the
   `From` signal only. Needs a live probe or Twilio support answer before B1
   can be corrected.
2. Whether `From` on a fallback callback is the `FallbackFrom`/pool number
   (E.164) in every case, including sender-pool selection.
3. Whether the human accepts `Unknown` as the chip on all inbound SMS/MMS
   (the true consequence of decision 9 under B1).
4. Whether the raw-`mediaUrls` relay seam (`api.ts:1239-1245`) is still
   exercised by any e2e; if not, M6 narrows to the no-bucket dev case.

## Safe to approve for implementation planning?

No. B1 invalidates the evidence model the presentation contract, the fake
provider work and the browser proof are built on; B2 makes the mission change
delivery behaviour on every relay source that pre-dates it. H1 would be caught
in build but is cheap to fix in the spec. The MEDIUM items are unowned
decisions a builder will otherwise make silently. Correct B1, B2 and H1 and
put M4/M5 (the `Unknown` product outcome) in front of the human at the gate,
then re-review.
