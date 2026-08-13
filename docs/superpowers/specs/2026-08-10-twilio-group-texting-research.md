# Twilio Group Texting (Conversations) - Research Report

Researched 2026-08-09 via twilio.com docs, changelog, and pricing pages.
All quotes verbatim from the cited page as fetched on that date.

Confidence legend:
- [DOC] stated explicitly in Twilio documentation
- [INF] inference from documented behavior, not stated directly
- [GAP] not documented; needs live-account verification

---

## 0. PRODUCT TIER: which "Conversations" hosts group texting today

**Finding: Group Texting lives in Conversations (classic), NOT the new Conversations
product. New group-texting integrations must target Conversations (classic).**

Twilio has split the docs tree into two distinct products:

| Product | Doc root | What it is |
|---|---|---|
| Conversations (classic) | `/docs/conversations-classic/...` | The omni-channel messaging API (Conversations v1 REST API, `IS`/`CH` SIDs). Hosts Group Texting. |
| Conversations (new) | `/docs/conversations/...` | An agentic AI platform - Conversation Intelligence, Memory, Orchestrator. |

Evidence:

- `https://www.twilio.com/docs/conversations-classic/group-texting` - EXISTS
  (last modified 2026-06-25). Titled "Group Texting in Conversations (classic)".
- `https://www.twilio.com/docs/conversations/group-texting` - **HTTP 404**.
  There is no group texting page in the new Conversations tree.
- `https://www.twilio.com/docs/conversations` (last modified 2026-05-06) describes
  an "agentic platform for building conversational AI and human-assisted customer
  engagement". It does **not** mention group texting or group MMS at all. It says:
  "The Conversations layer is for developers with an active Twilio communications
  implementation. You should have at least one channel (Voice, SMS, WhatsApp, RCS,
  or Chat) deployed in production before adding Conversation Intelligence, Memory,
  or Orchestrator capabilities."
- The original launch blog was retitled "Introducing Group Texting with Twilio
  Conversations (classic)" - Twilio retro-renamed it during the split.

Caution on URLs: several `/docs/conversations/...` paths still resolve (e.g.
`/docs/conversations/api/address-configuration-resource` appears in search results)
but others 404. Search-engine snippets frequently cite the OLD `/docs/conversations/`
paths for classic content. **Treat `/docs/conversations-classic/` as canonical for
anything group-texting related.** Confidence: [DOC] for the 404s and the page
contents; [INF] that the classic tree is the durable home (Twilio has published no
deprecation notice for classic).

No deprecation or end-of-life statement for Conversations (classic) was found. [DOC]

Sources:
- https://www.twilio.com/docs/conversations-classic/group-texting
- https://www.twilio.com/docs/conversations
- https://www.twilio.com/en-us/blog/group-texting-in-conversations

---

## 1. AUTOCREATION SCOPE (most important question)

### 1a. The exact inbound decision flow

From `https://www.twilio.com/docs/conversations-classic/inbound-autocreation`
(last modified 2026-06-25):

**Step 1 - existing Conversation match wins first.**
> "If the number-pair matches a Participant in an active Conversation, that Message
> is delivered to the Conversation."

and, on the same page:

> "the Conversation captures it first."

**Step 2 - if and only if no match, exactly one of two paths:**
> "If the Message does not belong to a Conversation, one of two things could happen.
> Either: 1. The ordinary Programmable Messaging webhooks are invoked ... or
> 2. Conversation Autocreation is invoked"

**Step 3 - the two paths are mutually exclusive.**
> "You can select either the Programmable Messaging webhook or the Conversations
> (classic) Autocreation feature, as shown in the flowchart above, but not both."

So the flow is:

```
inbound message
  -> does the To/From pair (1:1) or the sorted address set (group) match an
     ACTIVE Conversation?
       YES -> delivered into that Conversation (regardless of autocreation setting)
       NO  -> EITHER Conversations Autocreation
              OR    Programmable Messaging webhook
              (never both; configured per Messaging Service or per address)
```

### 1b. Matching rules

1:1 matching is by number pair:
> "only one Conversation can bind a number pair together" and "a Participant's
> to/from number pair can only be in one active Conversation at the same time."

Group MMS matching is by the full sorted address set:
> "the sorted set of all senders (`From`=) and receivers (`To`=) on the Message
> *must* match the sorted set of Addresses and ProjectedAddresses on some existing
> Conversation."

This confirms the context you supplied. [DOC]

### 1c. Can autocreation be scoped to group MMS only?

**No. There is no supported configuration that scopes autocreation to group MMS
while leaving 1:1 inbound SMS on the Programmable Messaging webhook for the same
number.** [DOC, by absence + explicit breadth statement]

Two independent confirmations:

1. Breadth statement on the autocreation page - autocreation
   > "takes effect for any Message to any numbers in that Messaging Service."
   The page applies this to SMS, MMS and WhatsApp equally. There is no
   message-type qualifier anywhere on the page.

2. The Address Configuration resource has **no field that discriminates message
   type**. Full field list from
   `https://www.twilio.com/docs/conversations-classic/api/address-configuration-resource`
   (last modified 2026-05-05):

   | Field | Description (verbatim where quoted) |
   |---|---|
   | `sid` | "A 34 character string that uniquely identifies this resource." |
   | `account_sid` | "The unique ID of the Account the address belongs to" |
   | `type` | "Type of Address, value can be `whatsapp` or `sms`." |
   | `address` | "The unique address to be configured. The address can be a whatsapp address or phone number" |
   | `friendly_name` | "The human-readable name of this configuration, limited to 256 characters. Optional." |
   | `auto_creation.enabled` | "Enable/Disable auto-creating conversations for messages to this address" |
   | `auto_creation.type` | one of `webhook`, `studio`, `default` |
   | `auto_creation.conversation_service_sid` | "Conversation Service for the auto-created conversation. If not set, the conversation is created in the default service." |
   | `auto_creation.webhook_url` | "For type `webhook`, the url for the webhook request." |
   | `auto_creation.webhook_method` | HTTP method (GET/POST) |
   | `auto_creation.webhook_filters` | "The list of events, firing webhook event for this Conversation" |
   | `auto_creation.studio_flow_sid` | "For type `studio`, the studio flow SID where the webhook should be sent to." |
   | `auto_creation.studio_retry_count` | "For type `studio`, number of times to retry the webhook request" |
   | `address_country` | "An ISO 3166-1 alpha-2n country code which the address belongs to." |
   | `date_created` / `date_updated` | timestamps |

   `type` distinguishes **channel** (`sms` vs `whatsapp`), not **message shape**
   (1:1 vs group). `webhook_filters` selects which Conversations *events* fire a
   webhook AFTER a conversation exists - it does not gate whether autocreation
   happens. Valid `webhook_filters` values: `onMessageAdded`, `onMessageUpdated`,
   `onMessageRemoved`, `onConversationUpdated`, `onConversationStateUpdated`,
   `onConversationRemoved`, `onParticipantAdded`, `onParticipantUpdated`,
   `onParticipantRemoved`, `onDeliveryUpdated`.

   Explicit confirmation from the fetch: no parameter distinguishing group from
   one-to-one messaging exists on this resource.

**Consequence for your architecture:** turning on `auto_creation.enabled` for your
number means *every* non-matching inbound - including ordinary 1:1 SMS from a
brand-new contact - autocreates a Conversation and stops hitting your plain
Programmable Messaging webhook. There is no half-measure at the platform level.

The Address Configuration API does give you **per-number** granularity, which is the
one real scoping lever:
> "to specify which unique address should enable the Conversations (classic)
> Autocreation feature upon receiving an inbound message, independent of the usage
> of the Messaging Service."

So you can put group texting on a *dedicated* number with autocreation on, and keep
your existing number on the Programmable Messaging webhook. That is number-level
scoping, not message-type scoping. [DOC for the mechanism, [INF] for it being the
recommended workaround]

Sources:
- https://www.twilio.com/docs/conversations-classic/inbound-autocreation
- https://www.twilio.com/docs/conversations-classic/api/address-configuration-resource

---

## 2. Does a group MMS matching an EXISTING Conversation deliver, with autocreation OFF?

**Yes. Pre-creating conversations for known groups IS a viable way to receive group
inbound without enabling autocreation.** [DOC]

The decision flow is strictly ordered: the existing-Conversation match is evaluated
**before** the autocreation-vs-Programmable-Messaging branch. The autocreation page
is explicit that the Conversation "captures it first," and the either/or sentence
applies only to the "does not belong to a Conversation" case:

> "If the Message does not belong to a Conversation, one of two things could
> happen."

Therefore, for a number whose Messaging Service still points inbound at the plain
Programmable Messaging webhook and which has `auto_creation.enabled = false`:

- Inbound 1:1 SMS -> no Conversation match -> plain Programmable Messaging webhook.
  Unchanged behavior. [DOC]
- Inbound group MMS whose sorted From+To set matches a pre-created Conversation's
  Addresses + ProjectedAddresses -> delivered into that Conversation, surfaced via
  Conversations webhooks (`onMessageAdded`). [DOC]
- Inbound group MMS with NO matching Conversation -> falls through to the plain
  Programmable Messaging webhook as an individual message, with no parameter
  exposing the other recipients. [INF - the autocreation page does not state this
  explicitly for the group case; the fetch noted "The document does not explicitly
  state what happens to group MMS messages that fail to match this sorted set
  criterion, though the parallel structure suggests they follow the same path as
  unmatched 1:1 messages." This matches the context you supplied.]

**This is the key architectural finding for a migration seam:** pre-creating the
132 conversations gives you group inbound capture on known rosters while leaving
1:1 SMS routing completely untouched. The cost is that any group thread you have not
pre-created (e.g. a tenant adds a third party, or the handset reorders/changes the
recipient set) silently degrades to an individual message on the old webhook.

Caveat: matching requires the Conversation be **active**. The doc says "matches a
Participant in an active Conversation" and "can only be in one active Conversation
at the same time." Conversations have `state` (`initializing`, `active`, `inactive`,
`closed`) and inactivity/closed timers. A pre-created conversation that has timed out
to `inactive` or `closed` may stop matching. [DOC for the state model and the word
"active"; [GAP] on exact matching behavior against `inactive` state]

Sources:
- https://www.twilio.com/docs/conversations-classic/inbound-autocreation

---

## 3. OUTBOUND: sending one carrier group MMS from our number

### 3a. How our number participates

Our Twilio number participates as a **projected address** attached to a Chat
participant. From the group-texting doc:

> "The projected address 'sticks' to the Chat participant, so in the group text,
> every Participant can see who said what by way of the attached phone number."

> "You can think of the projected address as the 'avatar' of a Chat participant in
> the MMS conversation."

> "A proxy address routes all messages to a single SMS Participant, while a
> projected address represents a non-native (such as Chat) Participant so every
> member of a group text can see who sent each message."

Three participant shapes are supported:
1. Native SMS participants - their own mobile number as `messaging_binding.address`.
2. Chat participants - a Chat `identity` PLUS `messaging_binding.projected_address`
   (our Twilio number).
3. Unattached projected addresses - a Twilio number with no backing Chat identity,
   acting as a "gateway" number; send/receive via REST API only.

Critically, **no proxy address is used**:
> "You only have to specify the SMS participant's own personal phone number in
> MessagingBinding.Address. When using group texting, you won't need to specify
> proxy addresses."

Twilio picks the protocol automatically:
> "Twilio Conversations will automatically choose whether to send an SMS (for 2-way
> conversations) or a group MMS (for 3-way or larger conversations)"

So a Conversation with our projected address + 1 SMS participant sends 1:1 SMS; add a
second SMS participant and the same Conversation starts sending group MMS. [DOC]

### 3b. API calls (documented worked example, verbatim shape)

Step 1 - create the Conversation:
```
POST /v1/Conversations
friendlyName: "Home-buying journey"
```

Step 2 - add the Chat participant carrying OUR number as its projected address:
```
POST /v1/Conversations/{ConversationSid}/Participants
identity: "realEstateAgent"
messagingBinding.projectedAddress: "+15017122661"
```

Step 3..N - add each SMS participant (personal mobile, no proxy):
```
POST /v1/Conversations/{ConversationSid}/Participants
messagingBinding.address: "+15558675310"
```

Step N+1 - post a message, authored by the chat identity:
```
POST /v1/Conversations/{ConversationSid}/Messages
author: "realEstateAgent"
body: "Glad you could join us..."
```

The doc's example deliberately shows a 1:1 send after two participants, then adds a
third participant and sends again - the second send is the group MMS. [DOC]

### 3c. One-shot creation: ConversationWithParticipants

`POST /v1/ConversationWithParticipants` (last modified 2026-07-23) creates the
conversation and all participants in a single request - explicitly built for group
texting:

- Requires **3 to 10 participants** per request. For a 2-participant conversation you
  must use the ordinary Conversation resource and add participants individually.
- Conversation params: `FriendlyName`, `UniqueName`, `MessagingServiceSid`,
  `Attributes`, `State`, `Timers.Inactive`, `Timers.Closed`.
- `Participant` is repeated JSON strings:
  - `{"identity": "CHAT_USER_IDENTITY"}`
  - `{"messaging_binding": {"address": "PHONE_NUMBER"}}`
  - `{"messaging_binding": {"projected_address": "YOUR_TWILIO_PHONE_NUMBER"}}` - noted
    in the docs as the GMMS form
  - `{"messaging_binding": {"address": "...", "proxy_address": "..."}}`
- Creation is synchronous but participant attachment is async: "conversations are
  created synchronously and if the request is valid, a conversation will be created
  and returned in the response. The conversation will be in the state `initializing`
  while the participants are added. Once all participants are added, the conversation
  state will be set to `active`."
- Stated rationale: "It helps prevent issues that might occur with existing
  conversations when you add participants individually."

That last point matters for a bulk pre-create: adding participants one at a time to
a conversation that is momentarily a 2-party set can trip the number-pair uniqueness
rule against another active conversation. Prefer ConversationWithParticipants. [DOC]

### 3d. Silent creation (the migration seam question)

**Creating a Conversation and adding participants does NOT send anything to the
members.** Nothing is transmitted until you POST a Message. [INF - high confidence]

Basis:
- No Twilio doc anywhere states that participant addition emits a message, an
  invitation, or any carrier traffic. The Participant resource describes creation as
  joining them so "the connected person will receive all subsequent messages" -
  forward-looking only.
- The group-texting worked example shows an explicit `POST .../Messages` as the step
  that produces visible traffic; participants added in prior steps produce none.
- The `onParticipantAdded` webhook exists precisely because participant addition is
  an API-plane event, not a messaging-plane one.

This is [INF] rather than [DOC] because Twilio never affirmatively states "no message
is sent." **Verify with one live pre-create against a test number before running the
132-conversation backfill.**

Second-order caveat for a backfill: because a number pair can only be in one active
Conversation at a time, pre-creating 132 conversations will fail (error 50416/50417
family) for any participant pair already bound to an active conversation. Plan for
conflict handling. [INF]

Sources:
- https://www.twilio.com/docs/conversations-classic/group-texting
- https://www.twilio.com/docs/conversations-classic/api/conversation-with-participants-resource
- https://www.twilio.com/docs/conversations-classic/api/conversation-participant-resource

---

## 4. PARTICIPANT CAP: reconciling 10 vs 20

**The binding cap is 10 Participants per Group MMS Conversation.** [DOC]

Three independent current sources agree on 10:

1. Group texting doc (2026-06-25), a NOTE box:
   > "There is a limit of 10 total Participants in a Group MMS Conversation."
2. Conversations (classic) Limits (2026-08-04):
   > "A Conversation can have up to 1000 Participants, including up to 50 non-chat
   > Participants" ... "Group MMS can have up to 10 Participants."
3. ConversationWithParticipants (2026-07-23): 3 to 10 participants per request.

**On the "20 total Addresses and ProjectedAddresses" claim:** I could not verify it in
any current Twilio page. I fetched the group-texting page twice (once via
`www.twilio.com`, once via the `static1.twilio.com` mirror) with an explicit
verbatim-quote request for "twenty"/"20" - result **ABSENT** both times. The
participant-conversation resource page (2026-06-25) also does not contain it; its only
"20" is a pagination `limit: 20` in code samples.

The phrase does surface in search-engine snippets attributed to the group-texting page
("you may have up to twenty (20) total Addresses and ProjectedAddresses in a Group MMS
Conversation"), which indicates it existed in an **earlier revision** of that page,
most likely from the public-beta era, and has since been removed. [INF]

Reconciliation: treat 10 as the hard cap. If the 20 figure was ever real, it described
addressing slots (an Address for each SMS participant + a ProjectedAddress for each
chat participant, which can exceed the participant count when a participant carries
both) rather than participants. Do not design against 20.

Per-request cap: 10 (ConversationWithParticipants). Adding participants individually,
the per-conversation cap of 10 still applies; exceeding it yields error **50436**
"Participant limit exceeded for group conversation" - cause: "There is a limit to how
many participants can be active in the same conversation at once"; solution: "Drop
another participant from the conversation before adding new one." The error page does
not restate the numeric limit. [DOC]

Practical note for a 10-cap: our projected address consumes one of the 10 slots, so
a group thread supports at most **9 external members**. [INF from the wording "10
total Participants"]

Sources:
- https://www.twilio.com/docs/conversations-classic/group-texting
- https://www.twilio.com/docs/conversations-classic/conversations-limits
- https://www.twilio.com/docs/conversations-classic/api/conversation-with-participants-resource
- https://www.twilio.com/docs/api/errors/50436

---

## 5. A2P 10DLC and opt-out

### 5a. What the docs actually say

**There is no group-texting-specific A2P 10DLC documentation.** The group-texting
page contains **no occurrence of "A2P" or "10DLC"** (verified by verbatim-quote
request: ABSENT). [DOC by absence]

The only group-texting A2P statement Twilio has made is in the public-beta changelog
(2023-06-16), which lists as improvements:
1. "Fully compliant A2P routing"
2. Opt-out filtering
3. Per-recipient delivery receipts
4. Larger file sizes

"Fully compliant A2P routing" is marketing shorthand with no accompanying technical
definition. Read concretely, it means group MMS sent through Conversations now
traverses registered A2P 10DLC carrier routes rather than the unregistered/legacy path
that the 2022 restriction froze - i.e. your Brand/Campaign registration governs the
send, and per-campaign throughput and filtering apply. [INF - Twilio never defines it]

### 5b. Is MMS capability required on the campaign?

**[GAP].** No Twilio page states this. What is documented:

- The number itself must be MMS-capable: the group-texting quickstart instructs you to
  "search for and purchase an available phone number capable of sending MMS". [DOC]
- Group texting is MMS protocol even when the content is text-only: "Group MMS uses the
  Multimedia Messaging Service (MMS) protocol to exchange ordinary text messages among
  a group of three or more people". [DOC]
- General A2P 10DLC docs cover "high volume SMS and MMS over trusted, compliant carrier
  routes" without a group-specific carve-out. [DOC]

Given that a group text is always an MMS at the protocol level, an MMS-capable
registered campaign is almost certainly required, and campaign use-case/content
attributes should reflect MMS. But no page says so. **Verify with Twilio support or a
live send before the cutover.** [INF -> [GAP]]

Also note the general A2P timeline risk: "Due to an increase in campaign submissions,
campaign reviews take 10-15 days."

### 5c. Opt-out / STOP handling in a group

**[GAP] for the group case specifically.** The group-texting page contains **no
occurrence of "STOP", "opt-out", or "opted out"** (verified: ABSENT).

What is documented generally:
- The public-beta changelog names "Opt-out filtering" as a group-texting feature -
  implying Twilio filters an opted-out member out of the group send rather than failing
  the whole message. [INF from the word "filtering"]
- Standard Twilio STOP filtering applies at the Sender/Messaging Service level: replies
  of STOP, QUIT, CANCEL, END, UNSUBSCRIBE, STOPALL, ARRET etc. block future traffic from
  that Sender or Messaging Service to that number. Advanced Opt-Out on a Messaging
  Service lets you customize keywords and replies.
- Twilio Messaging Policy explicitly covers Conversations: "The Messaging Policy applies
  to SMS, MMS, RCS, Conversations, and third-party messaging platform channels."
- Unified opt-outs across RCS/SMS/MMS took effect 2026-03-16: an opt-out on one channel
  blocks the others from the same Sender or Messaging Service.

**Unanswered by any doc:** whether a STOP from one group member (a) is delivered into
the Conversation as a message, (b) removes/suppresses that Participant while the group
send continues to the rest, (c) fails the whole group MMS, or (d) closes the
Conversation. The most likely behavior given "opt-out filtering" is (b) - suppress that
recipient, deliver to the rest - but this is unverified and is a compliance-relevant
unknown. **Must be verified live.**

Sources:
- https://www.twilio.com/en-us/changelog/Group-Texting-is-now-in-Public-Beta
- https://www.twilio.com/docs/messaging/compliance/a2p-10dlc
- https://www.twilio.com/en-us/legal/messaging-policy
- https://www.twilio.com/en-us/changelog/twilio-now-supports-unified-opt-outs-across-rcs--sms--and-mms-ch
- https://help.twilio.com/articles/223134027-Twilio-support-for-opt-out-keywords-SMS-STOP-filtering-

---

## 6. PRICING

### 6a. Conversations API - per monthly active user

From https://www.twilio.com/en-us/messaging/pricing/conversations-api :

- "Starting at $0.05 Per active user per month"
- **Free tier: users 0-200 are free.**
- Volume tiers: 201-5,000 = $0.05/user; 5,001-10,000 = $0.0475/user;
  10,001-20,000 = $0.045/user. Custom pricing above 20,000.
- Media storage: "Starting at $0.25 per GB per month"
- Active user definition: "An active user is counted when a user logs in to a
  front-end SDK, is assigned to or contributes to a conversation, or when edits are
  made to their user record." Elsewhere Twilio adds that this includes "new messages
  or message edits from APIs, or sending and receiving SMS and WhatsApp messages."
- Users are counted once per month by unique address or identity. [DOC]

Cost implication for a 132-conversation roster: MAU is billed per **unique
address/identity**, not per conversation. If the same contacts appear across many
conversations they are counted once. If total distinct participants stay under 200 in
a month, the Conversations layer is free. [INF from the free-tier and counting rules]

### 6b. Message pricing

> "Standard SMS/MMS and WhatsApp rates apply."

Conversations does not bundle message cost; MMS is billed at the standard US MMS rate
(roughly $0.02 outbound / $0.01 inbound per message plus carrier fees; check
current-rates for the live number). [DOC]

**Whether a group MMS to N recipients is billed as 1 message or N messages is NOT
documented anywhere I could find.** [GAP]

Reasoning for the likely answer: a group MMS is delivered as one carrier transaction
per recipient handset, and Twilio bills at the message-record level. Twilio's
Conversations model creates a delivery receipt **per participant** (see section 9),
which strongly suggests N billable outbound MMS records per group send. Budget for
N-per-send until verified. [INF]

Sources:
- https://www.twilio.com/en-us/messaging/pricing/conversations-api
- https://www.twilio.com/en-us/pricing/messaging
- https://www.twilio.com/en-us/pricing/current-rates

---

## 7. ELIGIBILITY / ENABLEMENT

**This is the single largest unresolved risk. [GAP]**

The two authoritative statements are in unresolved tension and Twilio has never
publicly reconciled them:

- **2022-03-15 changelog, "Limitation to Group MMS":**
  > "As of March 15, 2022, Twilio Group MMS is limited to existing accounts until
  > further notice."
  Accounts that had created Group MMS before that date could continue; new accounts
  attempting Group MMS receive an error that the service is unavailable.

- **2024-10-31 changelog, "Group Texting is now generally available in Conversations":**
  GA announcement; enables "MMS conversations between multiple U.S. or Canada long code
  phone numbers and chat users"; introduces the ConversationWithParticipants API for up
  to 10 participants in one request. **It says nothing about account eligibility** and
  does not reference or rescind the 2022 limitation.

- The launch blog says the feature is "available to all Conversations API users
  deploying in the US or Canada (Group MMS only works on +1 numbers)" - but that blog is
  dated **2020-09-16**, i.e. it predates the 2022 restriction and cannot be relied on.

Best reading: the 2022 restriction targeted **legacy Programmable Messaging Group MMS**
(sending a group message by putting multiple `To` numbers on a Message), and the 2024 GA
covers **Conversations-mediated group texting**, which is a different path Twilio
deliberately re-opened with compliant A2P routing. Under that reading a post-2022 account
can use Conversations group texting. [INF - plausible but NOT stated by Twilio]

No console toggle, feature flag, or support-ticket process for enabling group texting is
documented anywhere. The docs present it as simply working once you have an MMS-capable
+1 long code. [DOC by absence]

**Action required:** confirm with Twilio support, in writing, that group texting is
enabled on this specific account SID before committing to the design. This is a
yes/no that can invalidate the whole approach and it cannot be settled from docs.

Sources:
- https://www.twilio.com/en-us/changelog/limitation-to-group-mms
- https://www.twilio.com/en-us/changelog/group-texting-is-now-generally-available-in-conversations
- https://www.twilio.com/en-us/blog/group-texting-in-conversations

---

## 8. WEBHOOKS

From https://www.twilio.com/docs/conversations-classic/conversations-webhooks
(last modified 2026-07-15):

### 8a. Three configuration scopes
1. **Global / account-level** - applies across all conversations in the account.
2. **Service-level** - scoped to a specific Conversation Service.
3. **Conversation-scoped** - per individual conversation (pre-action webhooks are REST
   API only). Address Configuration can attach a conversation-scoped webhook
   automatically to each autocreated conversation via `auto_creation.webhook_url` +
   `webhook_filters`.

### 8b. Events

Pre-action (blocking) / post-action pairs: `onMessageAdd`/`onMessageAdded`,
`onMessageRemove`/`onMessageRemoved`, `onMessageUpdate`/`onMessageUpdated`,
`onConversationAdd`/`onConversationAdded`, `onConversationRemove`/`onConversationRemoved`,
`onConversationUpdate`/`onConversationUpdated`, `onParticipantAdd`/`onParticipantAdded`,
`onParticipantRemove`/`onParticipantRemoved`, `onParticipantUpdate`/`onParticipantUpdated`,
`onUserUpdate`/`onUserUpdated`.

Post-action only: `onConversationStateUpdated`, `onDeliveryUpdated`, `onUserAdded`.

### 8c. Inbound group message payload

`onMessageAdded` carries: `ConversationSid`, `MessageSid`, `Index`, `DateCreated`,
`Body`, `Author`, `ParticipantSid` (optional), `Attributes`, `Media` (optional), and
`Source` (`SDK` or `API`).

**The participant list is NOT in the payload** - only the author's `ParticipantSid`.
To learn who else is in the group you must call
`GET /v1/Conversations/{sid}/Participants`. [DOC]

For an inbound group MMS, `Author` is the sending participant's address (the member's
mobile number) rather than a chat identity. [INF - follows from SMS participants having
no identity; not stated explicitly]

### 8d. Side effects on non-Conversations traffic

Conversations webhooks are scoped to Conversations services and do not themselves alter
Programmable Messaging behavior. **However**, the real side effect is the one in
section 1: enabling Conversations *autocreation* on a Messaging Service diverts ALL
non-matching inbound away from the Programmable Messaging webhook. Configuring
Conversations *webhooks* alone is safe; configuring *autocreation* is not. [DOC for
scoping; [INF] for the framing]

Operational constraint: "Conversations (classic) webhooks have a maximum timeout of
5 seconds." Pre-action webhooks that time out will affect message flow. [DOC]

Sources:
- https://www.twilio.com/docs/conversations-classic/conversations-webhooks
- https://www.twilio.com/docs/conversations-classic/api/address-configuration-resource

---

## 9. DELIVERY RECEIPTS

From https://www.twilio.com/docs/conversations-classic/delivery-receipts
(last modified 2026-06-25) and the public-beta changelog ("Per-recipient delivery
receipts" is an explicitly named group-texting feature).

### 9a. Aggregated view - on the Message resource

`delivery` object fields: `total`, `sent`, `delivered`, `read`, `failed`, `undelivered`.
Each of the latter five is an `all` / `some` / `none` indicator.

```json
"delivery": {
  "total": 5, "sent": "all", "delivered": "some",
  "read": "some", "failed": "none", "undelivered": "none"
}
```

### 9b. Per-recipient view - DeliveryReceipt resource

Fields: `sid`, `account_sid`, `conversation_sid`, `message_sid`, `channel_message_sid`,
`participant_sid`, `status`, `error_code`, `date_created`, `date_updated`.

- `channel_message_sid` is the underlying `SMxxx`/`MMxxx` - the join back to
  Programmable Messaging records.
- `participant_sid` gives you per-member attribution. Twilio: "delivery_receipts is a
  list of individual statuses for each Message that was sent to an individual recipient
  or Participant in the Conversation."
- `status` values: `sent`, `delivered`, `read`, `failed`, `undelivered`, `null`.
  - `sent` - "Twilio has sent the message"
  - `delivered` - "Twilio has received confirmation" (for SMS this means the carrier
    accepted it; "the last possible status is delivered")
  - `read` - OTT channels only, not SMS/MMS
  - `failed` - "The message could not be sent"
  - `undelivered` - carrier rejection
  - `null` - "The message has been created, but it's still within Twilio"
- `error_code` is populated for `failed` / `undelivered`.

Retrieval: `GET /v1/Conversations/{ConversationSid}/Messages/{MessageSid}/Receipts`
(the "Conversation Message Receipt" resource).

### 9c. Webhook

> "A post-webhook event called onDeliveryUpdated is executed for every delivery receipt"

One event per receipt per status change - so a 5-member group send produces a stream of
`onDeliveryUpdated` events, not one. [DOC]

Constraint: "Delivery Receipts information is only available for messages sent to
non-Chat (SMS or WhatsApp) Participants." Our own chat participant produces no receipt.

### 9d. Landline / undeliverable member

**[GAP].** No doc states what happens when one group member's number is a landline or
otherwise undeliverable. Expected behavior: that participant's DeliveryReceipt gets
`undelivered` or `failed` with an `error_code`, the aggregated `delivery.undelivered`
becomes `some`, and the other members still receive the message. Whether the carrier
group thread still forms correctly for the remaining members, and whether a bad number
can fail the entire group MMS at the carrier, is not documented. **Verify live.** [INF]

Sources:
- https://www.twilio.com/docs/conversations-classic/delivery-receipts
- https://www.twilio.com/docs/conversations-classic/delivery-receipts-overview
- https://www.twilio.com/docs/conversations-classic/api/receipt-resource
- https://support.twilio.com/hc/en-us/articles/14752633457691-Undelivered-Messages-in-Conversations-API

---

## 10. LIMITS AND QUIRKS

From https://www.twilio.com/docs/conversations-classic/conversations-limits
(last modified 2026-08-04) unless noted.

### 10a. Numeric limits

| Limit | Value |
|---|---|
| Participants, Group MMS | **10** |
| Participants, general Conversation | 1000, of which up to 50 non-chat (SMS/WhatsApp) |
| Participants per ConversationWithParticipants request | 3 to 10 |
| Conversations per identity | 1000 active or inactive |
| Outbound message body to SMS participants | **1600 characters** |
| Media files per MMS | no more than **10** |
| Total media size per MMS | **5 MB** |
| Single media file size | **2 MB** |
| Actions per second (APS) | **30 APS** default; participant operations limited per Conversation |
| New SDK connections | up to 110/s per subaccount |

Conversation *creation* has no separately documented rate limit beyond the 30 APS
default. For a 132-conversation backfill at 30 APS the wall-clock cost is trivial, but
throttle to be safe and handle 429s. [DOC for 30 APS; [INF] for the backfill guidance]

### 10b. Number requirements

- **+1 (US + Canada) long codes only.** Warning box: "Group Texting is **only**
  supported on +1 (US+Canada) **long code numbers.**"
- "Toll-free numbers and short codes cannot exchange group texts from Twilio."
- The number must be MMS-capable: "search for and purchase an available phone number
  capable of sending MMS".
- A Messaging Service is **not** documented as required for group texting itself
  (though `MessagingServiceSid` is an accepted parameter and a Messaging Service is
  where A2P campaign association and Advanced Opt-Out live). [DOC by absence]

### 10c. The sender's own number in the group roster

Our number is a first-class member of the roster - that is the entire point of the
projected address. Every recipient's handset sees our Twilio number as one of the
participants in the thread, and Twilio's inbound matching depends on it being part of
the sorted address set. There is no "hidden sender" mode; a group MMS necessarily
exposes the full recipient list to every member. [DOC]

This has a privacy consequence worth flagging: **every member of a group text sees
every other member's mobile number.** For a housing context where tenants,
landlords, and staff might share a thread, that is a deliberate disclosure, not an
implementation detail.

### 10d. Carrier / handset quirks

**[GAP] - Twilio documents none of this.** The group-texting page has no "known
limitations" section beyond the long-code and 10-participant boxes.

The following are well-understood properties of group MMS as a protocol rather than
Twilio-documented facts, and each is a real risk:

- **Thread identity is the recipient set as the handset sees it.** iOS and Android
  match an incoming group MMS to an existing thread by the participant set. Adding or
  removing a member changes the set and typically spawns a NEW thread on the handset,
  while Twilio may still consider it the same Conversation. Roster edits are not
  cosmetic. [INF]
- Twilio's own matching is symmetrical about this: the sorted From+To set "must match"
  - any drift breaks capture (section 1b). [DOC]
- Group MMS behavior varies by carrier and by handset; some carriers/devices degrade a
  group MMS into individual messages. Not documented by Twilio. [INF]
- RCS interop with group MMS is not addressed in the group-texting docs. [GAP]

### 10e. Relevant error codes

- **50436** - "Participant limit exceeded for group conversation". "There is a limit to
  how many participants can be active in the same conversation at once." Solution:
  "Drop another participant from the conversation before adding new one."
- **50417** - "Participants limit exceeded" (general conversation cap).
- Number-pair uniqueness violations surface when a to/from pair is already bound to
  another active Conversation. [DOC for the rule; [GAP] on the exact error code]

Sources:
- https://www.twilio.com/docs/conversations-classic/conversations-limits
- https://www.twilio.com/docs/conversations-classic/group-texting
- https://www.twilio.com/docs/api/errors/50436
- https://www.twilio.com/docs/api/errors/50417

---

## CORRECTIONS TO THE SUPPLIED CONTEXT

Everything you supplied checked out, with these refinements:

1. **CONFIRMED** - GA 2024-10-31, public beta 2023-06-16, US/CA +1 long codes only, no
   toll-free/short codes, MMS protocol.
2. **CONFIRMED** - sorted From+To set must match Addresses + ProjectedAddresses.
3. **CONFIRMED** - Messaging Service inbound is Programmable Messaging OR Conversations
   autocreation, "but not both"; Address Configuration gives per-address control.
4. **CONFIRMED** - 2022-03-15 limited legacy Group MMS to existing accounts. Twilio has
   never reconciled this with the 2024 GA. Unresolved.
5. **REFINED** - the "20 total Addresses and ProjectedAddresses" figure is **not present
   in current Twilio docs** (verified twice including the static mirror). It appears
   only in stale search-index snippets. Design against 10.
6. **REFINED (important)** - the product tier: group texting is **Conversations
   (classic)** only. `/docs/conversations/group-texting` returns 404 and the new
   Conversations product is an unrelated agentic-AI layer. Target classic.
7. **ADDED** - the existing-Conversation match is evaluated BEFORE the
   autocreation/Programmable-Messaging branch ("the Conversation captures it first"),
   which makes pre-creating conversations a genuinely viable seam (section 2).

---

## GAPS REQUIRING LIVE-ACCOUNT VERIFICATION

Ordered by how badly a wrong assumption would hurt.

1. **Account eligibility.** Is Conversations group texting actually enabled on this
   account SID, given the 2022 "existing accounts only" Group MMS restriction? Twilio
   has never published a reconciliation. Get this in writing from Twilio support before
   any design commitment. Blocks everything.
2. **Silent pre-creation.** Confirm that creating a Conversation and adding SMS
   participants sends NO carrier traffic. Test with one throwaway conversation and a
   real handset before backfilling 132. Docs imply silence but never state it.
3. **STOP semantics inside a group.** When one member replies STOP: is it delivered
   into the Conversation, is that member filtered from subsequent group sends, does the
   whole group send fail, or is the Conversation closed? Compliance-relevant and
   completely undocumented.
4. **A2P campaign MMS requirement.** Does the registered campaign need MMS capability
   / MMS-inclusive use case for group sends to pass? Undocumented. Confirm with support;
   campaign review takes 10-15 days, so surface this early.
5. **Billing per group send.** Is one group MMS to N recipients billed as 1 outbound MMS
   or N? Not documented. Per-participant delivery receipts suggest N. Verify on a test
   send and read the usage records.
6. **Fall-through behavior for non-matching group MMS.** Confirm that a group MMS with
   no matching Conversation and autocreation disabled lands on the Programmable
   Messaging webhook as an individual message with no other-recipient parameter. The
   docs only imply this by parallel structure.
7. **Conversation state and matching.** Does a pre-created Conversation that has aged
   into `inactive` (or `closed`) still capture inbound group MMS? Docs say "active"
   Conversation. If inactive breaks matching, the 132 pre-created conversations need
   timers disabled or a keep-alive strategy.
8. **Number-pair conflicts during backfill.** How many of the 132 rosters contain a
   to/from pair already bound to an active 1:1 Conversation, and what error is returned?
   Determines whether the backfill needs a conflict-resolution pass.
9. **Landline / undeliverable member in a group.** Does one bad number fail the whole
   group MMS at the carrier, or only that recipient's receipt?
10. **Handset thread matching on roster change.** Verify on real iOS and Android devices
    what happens to the visible thread when a participant is added to or removed from an
    existing group Conversation.
11. **Inbound `Author` format for group MMS.** Confirm whether `Author` on
    `onMessageAdded` is the E.164 address for SMS participants (assumed) and how a
    chat-authored message differs.
12. **MAU billing shape.** Confirm whether each SMS participant across 132 conversations
    counts once (by unique address) or more, and whether the 200-user free tier
    realistically covers the deployment.

---
---

# ROUND 2 - Coexistence of group texting and 1:1 webhook handling on one number

Charge: find the SUPPORTED way to have both native group texting and ordinary 1:1
Programmable Messaging webhook handling on the SAME number, or prove none exists.

**Headline: the human's instinct was right on both counts.** The onConversationAdd
rejection trick is not just an antipattern - it is actively destructive (it drops the
message on the floor, with no fall-through). And a supported coexistence pattern does
exist: it is exactly the pre-created-Conversation seam, and Twilio documents it as its
own recommended migration path. A second, independent discovery (Event Streams
`recipients`) closes the remaining gap around discovering unknown group rosters.

---

## 13. onConversationAdd REJECTION SEMANTICS - the antipattern is confirmed dead

### 13a. What happens on rejection during autocreation

From `https://www.twilio.com/docs/conversations-classic/inbound-autocreation`, the
autocreation flow fires a pre-action hook:

> "onConversationAdd (pre-action webhook) will fire, containing the Message body and
> the complete number pair."

> "You can either accept this Conversation (triggering the remaining webhooks) or
> reject this request to prevent Conversation autocreation."

And the decisive sentence:

> **"If you reject this, the Message will be dropped, as specified for this webhook."**

**Answer: (a) the message is dropped/lost entirely.** It is NOT delivered to the
Programmable Messaging webhook as fall-through, and no error is returned to the
carrier. [DOC]

The success path, for contrast:
> "If your server code responds with `200 OK`: **onConversationAdded** will fire,
> indicating the successful creation of a new Conversation."

### 13b. General pre-action webhook rejection semantics

From `https://www.twilio.com/docs/conversations-classic/conversations-webhooks`
(2026-07-15), pre-action webhooks are a veto, not a router:

> "Conversations (classic) will reject the change and no publication will be made."

Three documented outcomes:

| Your response | Result |
|---|---|
| `200 OK` (with or without body) | Change proceeds, optionally modified by your response |
| `40x` or `50x` | "the change is rejected and never published to the conversation" |
| No response / timeout (>5s) | **The change is published UNMODIFIED**, after a delay |

That third row is its own footgun: if your rejection endpoint is slow or down, the
5-second timeout causes Twilio to **accept** the autocreation anyway. So a
rejection-based design fails open into exactly the state it was trying to prevent,
while a working rejection destroys the message. There is no configuration in which
rejection produces fall-through. [DOC]

### 13c. Verdict

The onConversationAdd-bounce design is disqualified. It cannot work:
- Rejection drops 1:1 messages permanently (silent data loss on every first inbound
  from a new contact).
- Timeouts invert the behavior.
- Nothing in the docs suggests fall-through is possible; the either/or in section 1 is
  evaluated once, and rejection happens downstream of that choice.

Confidence: [DOC]. This is stated in plain language on two separate pages.

Sources:
- https://www.twilio.com/docs/conversations-classic/inbound-autocreation
- https://www.twilio.com/docs/conversations-classic/conversations-webhooks

---

## 14. TWILIO EVENT STREAMS - the group envelope IS exposed here

**This is the round-2 discovery. The full group recipient list is available on a
parallel, observe-only channel that does not touch message routing at all.**

### 14a. The event and its schema

Event type: `com.twilio.messaging.inbound-message.received`
Latest schema version: **v8**. Doc last modified 2026-07-13.
Source: https://www.twilio.com/docs/events/event-types/messaging/inbound-message

Full v8 field list, verbatim:

| Field | Type |
|---|---|
| `messageSid` | string (required) |
| `timestamp` | string (required) |
| `accountSid` | string (required) |
| `eventName` | string (required) |
| `from` | string (required) |
| `to` | string (required) |
| `numSegments` | integer |
| `numMedia` | integer |
| `body` | string |
| `toCountry`, `toState`, `toCity`, `toZip` | string |
| `fromCountry`, `fromState`, `fromCity`, `fromZip` | string |
| `mnc`, `mcc` | string |
| `messagingServiceSid` | string |
| `referralCtwaClid` | string |
| **`recipients`** | **string[]** |
| `optOutType` | string |
| `externalUserId`, `parentExternalUserId`, `username` | string |

The load-bearing field:

> **`recipients` - "List of recipients for Group MMS."**

Example payload shape from the docs/changelog:
```json
"recipients": ["+15558675309", "+14155555555"]
```
For an ordinary 1:1 SMS, `recipients` is an **empty array**. That gives a clean,
zero-ambiguity discriminator: `recipients.length > 0` means group MMS. [DOC]

### 14b. Provenance and versioning

From the changelog "Inbound Messaging Event Streams Now Include Additional Data",
**dated 2024-10-17** (two weeks before group texting GA - clearly shipped as part of
the same effort):

> Added `optOutType` ("information about opt-out types, e.g. STOP") and `recipients`,
> "the list of the recipients for Group MMS".

The `recipients` field was introduced in **schema v5**; v6 changed only schema
metadata; current latest is v8. **You must explicitly select the latest schema version
in the Console** - subscriptions pinned to an older version will not receive
`recipients`. [DOC]

No account-specific restriction is mentioned; the change is universal for anyone who
opts into the newer schema. [DOC]

### 14c. Does it fire on a non-Conversations number?

**Yes.** This is a *Programmable Messaging* event, not a Conversations event. It
describes inbound messages arriving at the messaging layer, which is precisely the
path a number takes when its inbound handling is the plain webhook. The changelog
frames it as applying to "all inbound messages going forward." [DOC for the event's
product placement and universality; [INF] that a group MMS landing on the plain
webhook emits it with `recipients` populated - the docs do not walk through that exact
case, but the field would be meaningless otherwise, since Conversations-bound messages
already expose their roster via the Participants API]

**This is verification item #13 below - test it before designing on it.**

### 14d. Delivery characteristics

From https://www.twilio.com/docs/events (last modified 2026-06-23):

- **Observe-only.** Event Streams "doesn't alter routing"; it is "purely informational
  events versus webhooks, which can respond with TwiML to influence communication
  flow." Nothing you do (or fail to do) with an event affects the message. [DOC]
- **Sinks:** Webhook, Amazon Kinesis, Twilio Segment. ("some sinks include" implies
  more.)
- **Delivery guarantee:** "at-least-once delivery guarantee and will queue or retry
  your events for up to four hours."
- **Ordering:** events "may arrive out of order"; timestamps are embedded so you can
  reconcile duplicates and sequence.
- **Latency:** "Events are typically delivered to your sink within seconds of the
  triggering action. However, Twilio doesn't maintain any SLAs for Event Streams
  latency."
- **Cost:** "Available at no additional cost. You pay only for the underlying Twilio
  products that generate the events."
- **Limits:** "Up to 100 Sink resources and 100 Subscription resources" per account.
- Subscriptions can carry multiple event types.

### 14e. What this buys, and what it does not

**Buys:** you can keep 1:1 inbound on the plain Programmable Messaging webhook,
unchanged, forever - and still *learn the full roster* of any inbound group MMS from a
parallel sink. That solves group **detection** with zero routing risk.

**Does not buy:** the ability to *reply* as a group. Event Streams is read-only. To
send a group MMS you still need a Conversation containing that roster (section 3).

So the natural architecture is **learn-then-bind**:
1. Group MMS arrives, no matching Conversation -> plain webhook gets it as an
   individual message (no roster); Event Streams simultaneously delivers the same
   message WITH `recipients`.
2. Your backend joins the two on `messageSid` (present in both the webhook as
   `MessageSid` and the event as `messageSid`), reconstructs the roster, and
   pre-creates a Conversation for that sorted address set via REST.
3. Every subsequent message in that thread matches the Conversation and is captured
   natively, with full group send/receive.

Cost of this design: the **first** message of any previously unseen group thread is
handled without group context (you have the roster within seconds, but the message
itself arrived on the 1:1 path). Whether that is acceptable is a product call. The
`messageSid` join is [INF] - both surfaces carry the SID, but Twilio does not document
the join explicitly.

Sources:
- https://www.twilio.com/docs/events/event-types/messaging/inbound-message
- https://www.twilio.com/docs/events
- https://www.twilio.com/docs/events/event-streams
- https://www.twilio.com/en-us/changelog/inbound-messaging-event-streams-now-include-additional-data

---

## 15. A "Recipients" PARAMETER ON INBOUND - where it does and does not exist

**Verdict: `recipients` exists ONLY on Event Streams. It does NOT exist on the
Programmable Messaging inbound webhook.** [DOC]

I re-pulled the full inbound webhook parameter list from
https://www.twilio.com/docs/messaging/guides/webhook-request (last modified
2026-03-09). Complete list as documented:

- Core: `MessageSid`, `SmsSid` (deprecated), `SmsMessageSid` (deprecated),
  `AccountSid`, `MessagingServiceSid`, `From`, `To`, `Body`, `NumMedia`, `NumSegments`
- Media: `MediaContentType{N}`, `MediaUrl{N}`
- Rich messaging: `ButtonPayload`, `ButtonText`, `ButtonType`, `InteractiveData`,
  `FlowData`, `ChannelMetadata`
- Location: `Latitude`, `Longitude`, `Address`, `Label`
- Geo: `FromCity`, `FromState`, `FromZip`, `FromCountry`, `ToCity`, `ToState`,
  `ToZip`, `ToCountry`
- WhatsApp: `ProfileName`, `WaId`, `Forwarded`, `FrequentlyForwarded`, `Referral*`
  (Body, Headline, SourceId, SourceType, Url, MediaId, MediaContentType, MediaUrl,
  NumMedia), `ReferralCtwaClid`, `OriginalRepliedMessageSender`,
  `OriginalRepliedMessageSid`

**No `Recipients` parameter. No mention of group MMS or group texting anywhere on the
page.** This confirms the round-1 context: a group MMS that falls through to the plain
webhook arrives as an individual message with no parameter exposing the other
recipients. [DOC by exhaustive enumeration + explicit absence]

Third surface (Conversations): the roster is available, but only *after* the message is
bound to a Conversation, and only via `GET /v1/Conversations/{sid}/Participants` - the
`onMessageAdded` webhook payload itself carries no participant list (section 8c). [DOC]

Summary of where the group envelope is visible:

| Surface | Roster exposed? | Notes |
|---|---|---|
| Programmable Messaging inbound webhook | **No** | No such parameter exists |
| Conversations `onMessageAdded` | No (author only) | Roster via separate Participants API call |
| Conversations Participants API | Yes | Requires the Conversation to exist first |
| **Event Streams `inbound-message.received` v5+** | **Yes - `recipients[]`** | Observe-only, no routing impact |

Sources:
- https://www.twilio.com/docs/messaging/guides/webhook-request
- https://www.twilio.com/docs/events/event-types/messaging/inbound-message

---

## 16. THE OFFICIALLY RECOMMENDED COEXISTENCE PATTERN

**A supported coexistence pattern exists, and it is the pre-created-Conversation seam
from round 1. Twilio documents it as its own recommended migration path.** [DOC]

### 16a. The blessed pattern, verbatim

From the inbound-autocreation page:

> "With Twilio Conversations (classic), you can automatically create new Conversations
> (classic) for inbound messages. If you are already using Programmable Messaging to
> process inbound messages, we recommend that your switch to Conversations (classic)
> follow the following pattern."

> **"Initially, you should leave Autocreate disabled and migrate one Conversation at a
> time, creating those Conversations (classic) using the Conversations (classic) REST
> API."**

And the sentence that settles the whole question:

> **"[your existing SMS logic] will hold for all inbound Messages *except* those for
> which you create a Conversation Participant that binds to that number pair."**

This is an explicit, documented guarantee that the two systems coexist on the same
number: Conversations captures exactly what you have bound, and **everything else keeps
hitting your Programmable Messaging webhook**. It is precisely the mechanism identified
in round-1 section 2, now confirmed as intentional design rather than an exploitable
ordering quirk.

### 16b. The safe rollout procedure Twilio prescribes

> "we recommend starting from an empty **Messaging Service**, i.e. remove all
> **Senders** from the Conversations (classic) Messaging Service."

> "begin moving over Phone Numbers to your Conversations (classic) Messaging Service
> slowly"

> **"Autocreate will immediately take hold for those numbers that you add to the sender
> pool - and *only* those numbers."**

So there are two independent scoping levers, both per-number:
1. Messaging Service sender-pool membership (autocreation applies only to numbers in
   the Conversations Messaging Service's pool).
2. Address Configuration `auto_creation.enabled` per address (section 1c).

### 16c. Is there a third console option beyond webhook / autocreate?

**No.** The either/or stands:
> "You can select either the Programmable Messaging webhook or the Conversations
> (classic) Autocreation feature, as shown in the flowchart above, but not both."

A search snippet suggested "A Console redesign is planned to allow selecting both."
**I could not verify this** - I fetched the page specifically hunting that sentence and
the result was **ABSENT**. Treat it as stale or hallucinated snippet text; there is no
current or announced dual-mode option. [GAP / likely false]

### 16d. Studio routing (auto_creation.type = studio)

**Not a viable escape hatch.** [INF, high confidence]

The inbound-autocreation page contains **no discussion of Studio at all** (verified:
ABSENT). What `auto_creation.type = studio` does, per the Address Configuration
resource, is send the webhook to `studio_flow_sid` - but this fires *as part of
autocreation*, meaning **the Conversation has already been created and the message is
already conversation-bound** by the time Studio sees it. Studio cannot inspect
participants and "hand a 1:1 back" to the plain Programmable Messaging webhook,
because the fall-through decision was made upstream and is not re-enterable. A Studio
flow could of course HTTP-POST to your own endpoint, but that is your code re-emitting
the message, not Twilio restoring the original webhook path - and the Conversation
still exists and will capture that number pair from then on.

### 16e. Why Conversations cannot simply emulate the old webhook

> "Conversations (classic) has one significant difference: it does **not** send
> *incoming SMS* webhooks like Programmable Messaging does."

So "just autocreate everything and adapt your webhook handler" means rewriting your
inbound handling against `onMessageAdded` semantics, not receiving your existing
payload shape. That is a real migration, not a config change. [DOC]

### 16f. The answer to the charge

**Supported coexistence on one number: YES, via pre-created Conversations with
autocreation DISABLED.** Twilio explicitly recommends this configuration. Its one
inherent limitation is that a group thread you have not pre-created is not captured -
and section 14 supplies the missing piece by exposing that thread's roster on Event
Streams so you can bind it going forward.

**Supported coexistence with autocreation ENABLED: NO.** No message-type scoping
exists (section 1c), and rejection-based filtering destroys messages (section 13).

Sources:
- https://www.twilio.com/docs/conversations-classic/inbound-autocreation
- https://www.twilio.com/docs/conversations-classic/api/address-configuration-resource

---

## 17. BRIDGE PATTERN (accept autocreation, then close/delete the 1:1) - not viable

Proposal: let 1:1 messages autocreate, process `onMessageAdded`, then immediately
close or delete the conversation so the next message autocreates again.

**Verdict: not documented, not blessed, and it does not achieve the goal.** [INF -
no doc endorses or describes it; assessment is derived from documented mechanics]

Problems, in order of severity:

1. **It does not restore the plain webhook.** With autocreation enabled, the
   Programmable Messaging webhook is disabled for that Messaging Service - "but not
   both" (section 1). Closing a conversation does not resurrect the old path; the next
   message simply autocreates *another* conversation. You have not achieved
   coexistence, you have achieved churn. Your 1:1 handling is on `onMessageAdded`
   either way, so the close/delete step buys nothing.
2. **Race window.** Conversation creation is asynchronous (`initializing` -> `active`,
   section 3c). A second inbound arriving during teardown can match a
   closing/half-torn-down conversation, or fail matching and create a duplicate. Twilio
   documents no atomic "consume and destroy" primitive.
3. **Churn against the number-pair uniqueness rule.** "a Participant's to/from number
   pair can only be in one active Conversation at the same time." Rapid create/close
   cycles on the same pair invite 50416/50417-class conflicts under concurrency.
4. **MAU billing.** Active users are counted when a user "is assigned to or contributes
   to a conversation" (section 6a). Constantly recreating conversations does not reduce
   the unique-address count for the month, but it does guarantee every contact is
   counted. No saving, possible surprise.
5. **STOP handling is the real hazard.** Opt-out enforcement lives at the Messaging
   Service / Sender layer (Advanced Opt-Out), not at the Conversation layer, so
   deleting conversations should not erase opt-out state - **but Twilio does not
   document how STOP interacts with Conversations at all** (section 5c). Deleting the
   conversation that carried a STOP could plausibly destroy your only application-side
   record of it while Twilio's platform-side block persists invisibly. Building
   compliance-relevant behavior on an undocumented interaction is not defensible.
6. **A2P compliance layers.** Message content still traverses the same Messaging
   Service and registered campaign regardless of conversation lifecycle, so A2P
   filtering/throughput should be unaffected. [INF] But this is inference, and item 5
   makes the whole pattern unattractive regardless.

Recommendation: discard. Section 16's pattern achieves the actual goal without any of
this.

Sources:
- https://www.twilio.com/docs/conversations-classic/inbound-autocreation
- https://www.twilio.com/docs/conversations-classic/conversations-limits
- https://www.twilio.com/en-us/messaging/pricing/conversations-api

---

## 18. CHANGELOG SWEEP 2025-2026

**Nothing has changed for group texting or autocreation since the 2024-10-31 GA.**
[DOC by absence - searched the changelog for group texting, autocreation, inbound
webhook, and RCS group entries]

Relevant entries found, in date order:

| Date | Entry | Relevance |
|---|---|---|
| 2024-10-17 | Inbound Messaging Event Streams Now Include Additional Data | **Added `recipients` (group MMS) + `optOutType`.** The key enabler. |
| 2024-10-31 | Group Texting is now generally available in Conversations | GA + ConversationWithParticipants API |
| 2025-08-26 | RCS Messaging is now GA | RCS to "all 349k+ active customer accounts" via Programmable Messaging and Verify; "existing customers are able to upgrade with no code changes". **No RCS group threading.** |
| 2026-03-16 | Unified opt-outs across RCS, SMS, MMS | Opt-out on one channel blocks the others from the same Sender/Messaging Service |
| 2026-07-01 | Updates to optimize RCS delivery and fallback | Delivery-confirmation timing no longer depends on Twilio queue time |
| 2026-04-08 | REST API certificate rotation | Operational only |

Specifically **NOT** found:
- No new `webhook_filters` values or autocreation filters
- No group-scoped autocreation
- No inbound group MMS support added to Programmable Messaging webhooks
- No RCS group threads
- No dual-mode (webhook + autocreate) console option
- No change to the 10-participant cap
- No reconciliation of the 2022 Group MMS account restriction (still open, round-1
  item 1)

Sources:
- https://www.twilio.com/en-us/changelog
- https://www.twilio.com/en-us/changelog/rcs-messaging-is-now-generally-available
- https://www.twilio.com/en-us/changelog/updates-to-optimize-rcs-delivery-and-fallback
- https://www.twilio.com/en-us/changelog/twilio-now-supports-unified-opt-outs-across-rcs--sms--and-mms-ch

---

## 19. WHAT CHANGED VS ROUND 1

**Reversed / newly disqualified:**

1. **The onConversationAdd bounce is dead.** Round 1 did not evaluate it; the human's
   suspicion is correct and the mechanism is worse than "antipattern" - rejection
   causes permanent silent message loss, and a slow endpoint fails open into accepting
   the autocreation. Never build on it. [DOC]

**Strengthened / upgraded confidence:**

2. **The pre-created-Conversation seam is upgraded from "clever ordering exploit" to
   "Twilio's own documented recommendation."** Round 1 inferred it from the flow
   ordering ("the Conversation captures it first"). Round 2 found Twilio stating it
   directly as the recommended path for exactly our situation - an existing
   Programmable Messaging application adopting Conversations: "leave Autocreate
   disabled and migrate one Conversation at a time," and existing logic "will hold for
   all inbound Messages except those for which you create a Conversation Participant
   that binds to that number pair." This is now the recommended architecture, not a
   workaround. [DOC]

3. **Round-1 gap #6 (fall-through behavior for non-matching group MMS) is now
   partially closed.** The Programmable Messaging webhook parameter list was
   exhaustively enumerated and contains no `Recipients` and no group concept at all -
   confirming a fallen-through group MMS is indistinguishable from a 1:1 on that
   surface. [DOC]

**New material:**

4. **Event Streams `recipients[]` is a genuine second channel** that closes the
   "unknown group roster" hole without touching routing. Not mentioned in round 1.
   Free, observe-only, at-least-once with 4-hour retry, seconds of latency, no SLA.
   Requires selecting schema v5+ (current v8) in the Console. This converts the
   pre-create design from "only works for rosters you knew in advance" to
   "self-healing: learns any new roster on first contact." [DOC for the field and
   characteristics; [INF] for the `messageSid` join and for it firing on the plain-
   webhook path]

5. **Recommended architecture, consolidated:**
   - Autocreation: **disabled** on our number.
   - Inbound 1:1 SMS: plain Programmable Messaging webhook, **completely unchanged**.
   - Known group rosters (the 132): pre-created Conversations via
     `ConversationWithParticipants`, with our number as a chat participant's
     `projected_address`. Captured natively, both directions.
   - Unknown group rosters: first message lands on the plain webhook without context;
     a parallel Event Streams webhook sink supplies `recipients[]`; backend
     pre-creates the Conversation so the thread is native from message two onward.
   - Outbound group sends: post to the Conversation.

**Unchanged from round 1:** the 10-participant cap, +1 long-code-only requirement,
classic-vs-new product tier, per-recipient delivery receipts, MAU pricing, and - most
importantly - **the account-eligibility question (round-1 gap #1) remains completely
unresolved and still blocks everything.**

---

## ADDITIONAL GAPS REQUIRING LIVE-ACCOUNT VERIFICATION (round 2)

Continuing the round-1 numbering.

13. **Does `inbound-message.received` fire with `recipients` populated for a group MMS
    arriving at a number whose inbound handling is the plain Programmable Messaging
    webhook?** This is the load-bearing assumption of the whole learn-then-bind design.
    Highest-priority new verification. Subscribe a test sink at schema v8 and send a
    real group MMS to a test number.
14. **Does `MessageSid` (webhook) equal `messageSid` (event) for the same inbound
    message?** Needed to join the two surfaces. Almost certainly yes, undocumented.
15. **Does a Conversation created AFTER a group thread already exists retroactively
    capture that thread's subsequent messages?** The sorted-set match should make this
    work, but confirm the handset keeps sending the identical recipient set.
16. **Event Streams duplicate handling.** At-least-once means your pre-create logic
    must be idempotent against duplicate events. Confirm dedup key (`messageSid`).
17. **Does the Event Streams webhook sink have its own retry/failure semantics that
    could stall the pipeline?** 4-hour retry window is documented; behavior of a
    persistently failing sink is not.
18. **Confirm no dual-mode console option exists** (the unverified "Console redesign"
    snippet). Check the current Messaging Service Integration tab directly.
19. **Confirm Conversation `state` timers do not expire pre-created conversations out
    of matching** (also round-1 item 7) - now more urgent, since the learn-then-bind
    design creates conversations that may sit idle indefinitely.
