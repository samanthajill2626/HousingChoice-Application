# Group texting live spike - findings report

Date: 2026-08-10. Dev Twilio account, dev business number +14049824978, live
handsets (Cameron: +16174707727 "617", +16783837896 "678"). All control-plane
changes were snapshotted, applied, and restored to baseline the same session;
verification sweep at the end confirmed semantic identity with the pre-spike
snapshots. Raw captures and snapshots: `.superpowers/spike/` in the
`feat/group-texting` worktree (gitignored; summarized here).

This spike was the empirical gate for the group-texting feature mission
(`docs/issues/inbound-group-mms-detection.md`,
`docs/issues/regular-group-texting-for-imported-groups.md`, both on
`feat/quo-airtable-import` at the time of writing). Every design-gating
question was answered. The findings below supersede all doc-derived designs
discussed during brainstorming, including the Event Streams sidecar and the
autocreation-based router.

## Headline findings

### F1. The classic webhook carries the group envelope: `OtherRecipients{N}`

An inbound group MMS delivered to the Programmable Messaging inbound webhook
includes the other recipients as `OtherRecipients0`, `OtherRecipients1`, ...
form parameters (observed with one other recipient; multi-param shape inferred
from the `0` suffix). Observed on EVERY group-origin inbound across the spike:
autocreation on, autocreation off, conversation existing, conversation absent.

```
Body=Spike test with B2!
From=+16174707727
To=+14049824978
OtherRecipients0=+16783837896
MessageSid=MM02058042c42092870d515695f6cb68b4   <- MM prefix, NumMedia=0
```

- UNDOCUMENTED: Twilio's webhook-request reference does not list this
  parameter (verified by exhaustive enumeration twice on 2026-08-09/10).
  Treat as a monitored dependency: assert its presence on MM-prefixed
  text-only inbound and alarm if it disappears. Fallback if it ever vanishes:
  autocreation (proven, F4).
- Full roster at classification time = From + To + OtherRecipients{N}. The
  sender's own copy of To/roster ordering is irrelevant; identity is the
  sorted set (matches importer `conversationIdForGroup`).
- Text-only group MMS arrives with an `MM` MessageSid prefix and NumMedia=0.

### F2. Conversations capture NEVER suppresses the classic webhook (dup delivery)

On this account, for every tested shape - group matching an existing
Conversation, group autocreating, 1:1 autocreating - the classic Programmable
Messaging webhook STILL received the message alongside the Conversations-side
delivery. The docs' claim that conversation-bound traffic stops reaching the
ordinary webhook did not reproduce anywhere.

Consequence: the classic webhook is a complete, unchanged ingestion path for
ALL inbound. Conversations is additive. The only new obligation is suppressing
double-filing for group messages that also land in a Conversation we track.

### F3. Account eligibility CONFIRMED; group send works end to end

- Creating a group Conversation (projected business number + 2 external
  members) succeeded; no 50452. The 2022 "Group MMS limited to existing
  accounts" restriction does not bite this account via Conversations.
- Outbound posts to the Conversation deliver as ONE carrier group thread from
  the business number; both real handsets rendered a native group thread with
  correct membership (Android showed a first-contact "stay in this chat?"
  prompt because both numbers were strangers to the device).
- Silent pre-creation confirmed: creating the Conversation and adding
  participants transmitted nothing to handsets.
- An UNATTACHED projected address works: no chat identity needed. Post with
  `Author=+14049824978` (the projected address itself).
- Per-recipient delivery receipts, each carrying its own SMxx
  `channel_message_sid` (the join key to classic status machinery), stream via
  `onDeliveryUpdated` - which fires on the SERVICE-scoped webhook config.

### F4. Autocreation works (both 1:1 and group) but is NOT needed

- Group MMS to the number with per-address autocreation on and no matching
  Conversation autocreated a group Conversation in ~700ms: trace
  `onConversationAdded` (carrying the full receiver set in
  `MessagingBinding.Address` + `MessagingBinding.AuthorAddress`) -> 3x
  `onParticipantAdded` -> `onMessageAdded` -> `onConversationStateUpdated`
  (initializing -> active, Reason=EVENT).
- Autocreated group participants: business number as ProjectedAddress (no
  identity), members as plain Addresses; MessagingServiceSid inherited from
  the number's campaign-bearing service (MG8715...).
- 1:1 autocreation also works (Address+ProxyAddress pair binding) - and mints
  a Conversation for EVERY unknown 1:1 sender, which the chosen design avoids
  entirely by not using autocreation.
- Per-address autocreation config (Address Configuration API) never touches
  the messaging-service inbound setting; the service-level console toggle is
  NOT needed and must stay on "Send a Webhook".

### F5. Webhook scopes behave asymmetrically (undocumented)

- SERVICE-scoped webhook config received `onDeliveryUpdated` but NOT
  carrier-sourced `onMessageAdded` (2x reproduced).
- ACCOUNT-GLOBAL webhook config received carrier-sourced `onMessageAdded`
  (`Source: SMS`).
- API-sourced events fire only with the `X-Twilio-Webhook-Enabled: true`
  header (colon header, not `=`).
- `onMessageAdded` payload carries author + ConversationSid + IMxx SID but NO
  roster and NO underlying MMxx/SMxx SID - the classic copy (F2) is the
  richer ingestion record; Conversations events are best used only for
  delivery receipts under the chosen design.

### F6. Opt-out semantics are per (member <-> business number), symmetric, and sane

- Twilio's standard (non-Advanced) opt-out is ACTIVE on the messaging
  service: HELP and STOP and START each trigger Twilio's own auto-reply,
  delivered 1:1 ONLY - never broadcast to the group - even when the keyword
  was sent inside the group thread.
- STOP sent in a group: recognized; the raw "STOP" is visible to other group
  members carrier-side (unavoidable); the confirmation is not.
- After STOP (either surface): API 1:1 sends fail with 21610; group sends
  PARTIALLY deliver - the opted-out member's receipt reads error 21610, all
  other members deliver normally. No whole-send failure, no roster change.
- START (either surface) fully restores both rails; proof sends delivered.
- The STOP webhook params carried NO `OptOutType` field (standard opt-out
  mode). Body-keyword detection (existing shared detector) is the mechanism.
  A group STOP is distinguishable app-side by `OtherRecipients` presence.
- Compliance answer for the new architecture: the app SENDS NOTHING on
  STOP/HELP/START - Twilio's auto-replies cover it; an app-side confirmation
  would be blocked by 21610 anyway.

### F7. Coexistence proven live

With a group Conversation active for {617, 678, biz}: a plain 1:1 SMS from a
group member to the business number flowed classic-only - no Conversations
event, no conversation message, normal dev-stack handling. The number-pair
rule never interfered because group participants bind Address-only (no proxy).

### F8. Odds and ends

- A Twilio-owned number cannot be an Address participant (50407) - no
  fake-member tricks; also Guam +1671 rejected (participants must be US/CA);
  Lookup marks the attempted 671 number invalid.
- Conversation message posted via API with no explicit MessagingServiceSid,
  in a conversation created WITHOUT one: messages attributed to the
  Conversations DEFAULT messaging service (MGfde..., campaign-less) - A2P
  hazard. ALWAYS pin `MessagingServiceSid` (campaign-bearing MG8715.../prod
  equivalent) when creating conversations.
- Billing: usage records lag; per-recipient SMxx records strongly imply
  N-per-send billing. Re-check usage records post-spike. Conversations MAU
  pricing: free under 200 active users/month.
- Handset thread continuity: the carrier group thread on both handsets
  survived Twilio-side Conversation deletion and recreation (same participant
  set = same handset thread). Supports the cutover continuity story for the
  founder's ported number.
- Delivery receipts arrived within ~1-5s of send; state transitions produce
  multiple `onDeliveryUpdated` events per recipient.

## The architecture these findings select

1. Inbound (1:1 AND group) stays on the existing Programmable Messaging
   webhook. 1:1 pipeline unchanged. Group-origin inbound is recognized
   synchronously by `OtherRecipients{N}` and filed to a group thread keyed on
   the sorted outside-participant set (same identity as the importer).
2. Per group thread, the app lazily creates ONE Twilio Conversation
   (unattached projected business number + member addresses, pinned
   MessagingServiceSid, no timers) - at import (132 pre-creates), on first
   detected inbound, or on first outbound need. Its CHxx SID is stored on our
   conversation item.
3. Outbound group replies POST to that Conversation authored by the business
   number. Per-recipient receipts stream via the service-scoped
   `onDeliveryUpdated` webhook into a new receipts endpoint; SMxx
   channel_message_sids join to classic DLR bookkeeping.
4. Dup suppression: group messages arrive classic (filed by us) AND land in
   the Twilio Conversation (Twilio-side record; ignored by ingestion).
   Conversations `onMessageAdded` is NOT consumed for inbound.
5. No autocreation, no address configuration, no Event Streams, no global
   Conversations webhook, no changes to messaging-service inbound routing.
   STOP/HELP/START handling stays exactly where it is today.

## Residual risks / watch items

- `OtherRecipients{N}` is undocumented: assert-and-alarm in the webhook
  handler; autocreation is the proven fallback if Twilio removes it.
- Multi-recipient shape (`OtherRecipients1+`) inferred, not observed (2-4
  member production groups will exercise it; verify during build self-QA
  with the fake and during cutover with a 3-outside-member live group).
- Dup-delivery (F2) contradicts Twilio docs; if Twilio ever "fixes" classic
  suppression for conversation-bound traffic, group inbound would vanish from
  the classic webhook - the assert-and-alarm above catches this too, and the
  fallback is consuming the global-scope `onMessageAdded` (proven, F5).
- MMS-capable A2P campaign still required for production outbound (spike ran
  on the dev LOW_VOLUME campaign and delivered, but production traffic rides
  the new MMS campaign - Cameron owns this gate).
- Group MMS with media attachments not exercised (text-only spike). MediaUrl
  params on group-origin classic inbound assumed per standard MMS handling;
  verify during build.
