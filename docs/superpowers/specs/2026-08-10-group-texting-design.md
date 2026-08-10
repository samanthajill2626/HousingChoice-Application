# Native group texting - design spec

Status: DRAFT v2 (post adversarial review round 1; pre human gate)
Date: 2026-08-10. Cutover gate: 2026-08-17.
Branch: `feat/group-texting` (worktree `W:\tmp\group-texting`, cut from main
@2caeaba5).

Sources, in authority order (ALL present in this worktree/branch - do not go
looking in other worktrees):

1. Live spike report (empirical; supersedes doc-derived reasoning):
   [`2026-08-10-group-texting-spike-report.md`](2026-08-10-group-texting-spike-report.md)
2. Twilio documentation research (doc-derived facts the spike did not test):
   [`2026-08-10-twilio-group-texting-research.md`](2026-08-10-twilio-group-texting-research.md)
3. The two issues: `docs/issues/inbound-group-mms-detection.md`,
   `docs/issues/regular-group-texting-for-imported-groups.md`
4. Import design spec sections 2.4 / 3.6 / 10.1
   (`2026-08-05-quo-airtable-import-design.md`); importer code is on mainline
   (`app/src/lib/import/`).

Review artifacts: `.superpowers/design-review/` (r1 findings + adjudications).

## 1. Why

Carrier group texts to the business number are invisible as groups: the
webhook models every inbound as 1:1, so staff cannot see that a message
arrived on a group or who else is on it, and a staff reply silently forks the
thread for the other members. Separately, the founder's 132 imported group
chats must CONTINUE as normal carrier group texts from her real (ported)
number after cutover - one thread, everyone sees everyone. The relay product
(masked, pool-number-fronted) is a different product and stays.

## 2. Locked decisions

- One mission, both halves (detection + outbound), detection sliced first.
- Native group threads arise from exactly two paths: the import/migration
  seam and inbound detection. NO staff-initiated native group creation.
- No A2P/MMS-campaign gating logic in this feature (campaign timeline is
  Cameron's).
- Architecture is the spike's, with two DELIBERATE deviations, both flagged:
  (a) the Twilio Conversations rail is created LAZILY (first outbound only),
  never at migration or detection; (b) Event Streams is NOT used - the
  reconciliation guardrail instead uses the account-global Conversations
  webhook, a mechanism the spike proved (F5).
- Guardrail ruling (Cameron): the undocumented `OtherRecipients{N}` webhook
  param is acceptable IFF failure is loud and self-explaining. Section 8.
- Naming (RECOMMENDED, needs Cameron's ratification at the spec gate):
  relay's shipped staff label "Group text" renames to "Relay group", and the
  new type takes "Group text". See 3.

## 3. Vocabulary, type, and the label collision

New conversation type: **`group_text`** (code/data).

The staff-facing label "Group text" is ALREADY SHIPPED as the relay product's
label (GLOSSARY "Group text number"; InboxRow relay chip; relay header;
GroupTextsCard; inbox row label fallback; Today's "Group" label). Two products
under one chip - one masked, one deliberately unmasked - is a privacy-relevant
confusion. Decision (Cameron ratifies):

- RECOMMENDED: rename relay's staff copy to "Relay group" (GLOSSARY, InboxRow
  chip, relay header, GroupTextsCard title, inbox label fallback, Today label,
  and the message-catalog/dialog copy that says "group text" for relay). The
  new type takes "Group text". This is an approved, enumerated exception to
  "relay untouched" - copy only, zero behavior.
- Fallback if relay copy must not change: the new type ships as "Direct
  group" everywhere instead.

GLOSSARY gains the new entry and (recommended path) updates the relay
entries in the same change.

## 4. Identity and data model

### 4.1 Identity

A group_text thread id is `conversationIdForGroup(sorted outside-participant
set)` - the importer's function at `app/src/lib/import/ids.ts:74` - imported
directly (NO file move: the uuidv5 NAMESPACE constant makes ids
relocation-sensitive in review terms; a golden-vector test pins known
roster -> uuid outputs so any refactor that changes outputs fails loudly).
Twilio's own group matching keys on the same sorted address set (research
report 1b, doc-derived).

**The exclusion set is part of the identity contract.** "Outside participants"
= the envelope's From + OtherRecipients minus the EXCLUDED set, defined as:

- the business number (config.businessPhoneNumber), plus
- all pool numbers (byPoolNumber GSI), plus
- `group_identity_excluded_numbers`: a persisted config list (settings-style
  record) installed by the migration from the Quo export's `ownNumbers` set
  (the importer resolved threads against ALL org numbers -
  `app/src/lib/import/apply.ts:281`; the runtime must subtract the same set or
  the same carrier thread mints a second id and orphans imported history).

Conversion (section 9) verifies parity: it receives the importer's
`ownNumbers`, writes the config list, and refuses to run if the list cannot be
persisted. Detection logs (WARN + metric) any envelope containing an excluded
number beyond the business number itself - that is the divergence signal.

Lookups: exclusion-set resolution runs ONLY on envelope-bearing inbound
(1:1s never reach it) and uses one cached read (pool list + config list
cached with a short TTL), not per-participant queries.

Roster changes are new identities by construction (carrier + Twilio + handset
semantics agree). No roster mutation exists in v1; a member "leaving" is
per-member suppression (4.4).

### 4.2 ConversationItem shape (additive)

- `type: 'group_text'` joins the union. That union is declared in THREE
  places, all updated: `app/src/repos/conversationsRepo.ts:39`,
  `dashboard/src/api/types.ts:408`, and the SSE payload type in
  `app/src/lib/events.ts:43`; `dashboard/src/routes/today/buildToday.ts:60`
  is an exhaustive Record and gets the new label.
- `participants: ConversationParticipant[]` - outside members (contactId +
  phone + optional name), written ONCE at creation (single conditional
  claim; see 5). The business number is implicit.
- **`group_status`: sparse GSI attribute, value `group_text#open`** - a NEW
  sparse GSI `byGroupStatus` (HASH `group_status`, RANGE `last_activity_at`)
  makes group threads listable without entering the 1:1 byLastActivity
  partition (the same dilution-proofing relay got via byRelayStatus) and
  without touching relay's GSI. Schema change: tables.ts + Terraform;
  lane tables recreate on stale-schema rules; dev/prod GSI apply is a
  merge-time op.
- `participant_phone` / `participant_email`: ABSENT. Group threads are
  reached via byGroupStatus, conversationId, or the participants roster -
  never byParticipantPhone.
- `twilio_conversation_sid?: string` - CHxx of the lazily created rail
  (absent until first outbound).
- `status: 'open'` (byLastActivity also lists it; the inbox third source
  reads byGroupStatus - readers that iterate byLastActivity and reject
  unknown shapes are enumerated in the plan).
- NO `pool_number`. `relay_status` NEVER carries a relay value; converted
  imported threads carry the inert sentinel `converted:group_text` (9).
- No stored display name: headers render a DERIVED name from the roster
  (member first names, else formatted numbers). `participant_display_name`
  stays 1:1-only.

### 4.3 Messages

Group messages persist under the group conversationId with existing shapes:

- inbound: sender attribution persists in the EXISTING `relay_sender_key`
  field using the same `relayMemberKey` convention (contactId else
  `phone#<E164>`) - documented as the generic multi-party sender key. No
  relay consumer reads it on non-relay threads (plan verifies). Renderers
  resolve the key against the roster for sender chips.
- outbound: per-member delivery uses the EXISTING `delivery_recipients` map +
  `setRecipientDelivery` (conditional, out-of-order-safe) keyed by
  relayMemberKey - NOT a new map. The parent map is seeded at send time
  (the documented DynamoDB parent-must-exist rule, api.ts:1447). Existing
  per-member chip renderers light up unchanged.
- The aggregate `delivery_status` derives as relay/broadcast conventions do.

### 4.4 Suppression and consent scope (group STOP)

- A group-origin STOP NEVER writes the GROUP conversation's `sms_opt_out`.
  Scope follows the relay closed-group precedent (twilio.ts:541-553): the
  contact-level flag plus the sender's OWN 1:1 thread flag
  (createOrGetByParticipantPhone), audit-logged with group context detail.
  `processInboundKeywords` gains an explicit target-conversation parameter
  (the sender's 1:1) + a context detail field rather than being passed the
  group thread.
- START symmetric. HELP: bookkeeping only.
- The app SENDS NOTHING on group keywords in v1. Observed (spike F6): Twilio's
  standard opt-out auto-replies 1:1 to the sender. The unresolved app-wide
  question of Twilio-standard-auto-reply vs our filed TwiML replies
  (double-confirmation on 1:1s today) is FILED as
  `docs/issues/twilio-standard-optout-double-reply.md`; if its resolution
  disables Twilio's standard replies, the group STOP confirmation must become
  an app send - that issue records the coupling.
- 1:1 keyword behavior (TwiML filed replies, twilio.ts:80-91) is
  byte-identical - this spec changes nothing there.
- Members with known suppression (21610 receipts or observed STOP) render as
  suppressed chips on the thread roster; sends do NOT exclude them app-side
  (Twilio filters per-recipient; receipts record it).

## 5. Inbound path (detection)

In the main-number branch of `app/src/routes/webhooks/twilio.ts`, AFTER the
echo/author and pool-number branches (consequence, documented: a carrier group
that includes a POOL number still hits the relay branch first and keeps
today's relay behavior with the envelope dropped -
`docs/issues/group-mms-including-pool-numbers.md`):

1. Collect `OtherRecipients{N}` (N=0.., tolerate gaps; parser also accepts a
   single unindexed `OtherRecipients` should the shape vary).
2. NONE present -> the existing 1:1 pipeline, unchanged. (Invariant: no new
   I/O and no new persisted side effects on this path; the only addition is
   param inspection.)
3. Present -> group-origin:
   - Roster per 4.1 (exclusion set applied; WARN metric on divergence
     signals).
   - conversationId = conversationIdForGroup(roster).
   - Find-or-create the group_text thread. Creation: resolve-or-create a
     contact per member by phone - creating STUBS WITHOUT any consent stamp
     (they never texted us; stamping inbound_text would fabricate A2P consent
     - adjudication #8); write `participants` once with the full roster
     (single conditional claim; on race, loser re-reads). The SENDER alone
     gets normal inbound consent semantics (contact-level, honest), and the
     sender's `touchPhoneLastSeen` second-number attribution runs exactly as
     on a 1:1 (it is sender attribution, not a 1:1-ism).
   - Persist the message (dedupe by MessageSid via the existing sid-pointer
     transaction) with `relay_sender_key` = sender's member key. It MUST NOT
     also file into the sender's 1:1 thread.
   - Keywords: shared detector on the body; consent per 4.4; no reply.
   - Media: `MediaUrl{N}` mirrored via the existing shared path under the
     group conversationId. (Group-with-media inbound was NOT spike-tested;
     build-time fake coverage + the pre-cutover live check in 12 verify it.)
   - last_activity + unread + SSE run with the group conversationId; the
     single SSE `conversation.updated` builder (events.ts:87) gains a
     group_text branch emitting roster + status (relay payloads
     byte-identical).
   - Fact extraction and other tenant-1:1-specific AI side effects do not
     run for group inbound in v1 (scope, not principle).
4. Tripwire (8.1) on the MM/no-envelope shape; file as 1:1 (fail open -
   never lose a message) + WARN.

First message of a never-seen group creates the thread synchronously in the
webhook - no misfile window exists (spike F1).

## 6. Outbound path (group replies)

### 6.1 The Conversations rail (lazy)

Created on FIRST outbound for a thread, via a new `groupConversationsPort`
adapter (vendor calls in `app/src/adapters`, services depend on the port):

- Conversation + participants (ConversationWithParticipants when the shape
  fits its documented 3-10 bound - research report 3c - else individual
  adds): members as `MessagingBinding.Address`, business number as
  `MessagingBinding.ProjectedAddress` with NO identity (spike F3/D1).
- ALWAYS pin `MessagingServiceSid` = the campaign-bearing service
  (TWILIO_MESSAGING_SERVICE_SID). Spike F8: omission attributes traffic to
  the campaign-less Conversations default service.
- No timers (account default null - spike snapshot
  conversations-global-config.json; assert, do not set).
- Store CHxx + the MBxx->member-key mapping (receipts need it).
- Idempotent/recreate-on-404; identity conflicts resolve through the
  sorted-set key.
- Cap (research report 4, doc-derived: 10 participants incl. our projected
  address -> max 9 outside): a >9-member thread is inbound-only; composer
  disabled with a banner naming the member 1:1 links as the explicit
  fallback affordance.

### 6.2 Sending

- Composer on group_text threads sends TEXT ONLY in v1 (outbound group media
  is a filed follow-up; inbound media handled per 5).
- A dedicated group send service (NOT `sendMessage`, which is structurally
  1:1: single participantPhone, whole-send opt-out refusal). Shared seams,
  named exactly: the SMS kill-switch predicate (`smsSendingEnabled` -
  enforced INSIDE the groupConversationsPort adapter, same
  SmsSendingDisabledError), the message catalog for any automated copy, and
  audit logging. Suppressed members are not excluded app-side (4.4).
- Send = POST Message to the Conversation, `Author=<business number>`; store
  IMxx as the message's provider sid.
- Delivery: receipts (7) update `delivery_recipients` per member; aggregate
  derives; UI renders existing chips.
- No automated senders target group_text threads in v1 (reminders,
  broadcasts, matching, relay fan-out) - the plan enumerates each sender's
  guard.

## 7. Receipts endpoint

New route `POST /webhooks/twilio/conversations/receipts` for the
SERVICE-scoped `onDeliveryUpdated` (spike F5: service scope receives delivery
events reliably).

- Auth: X-Twilio-Signature over the form body (the standard Twilio webhook
  scheme used by the messaging webhook - NOT the events route's shared-secret
  scheme, which belongs to the A2P sink at `/webhooks/twilio/events` and is
  not this route).
- Twilio-side config (ops, merge-time, per env): set the Conversations
  default service's webhook to this URL, filter onDeliveryUpdated only.
  RUNBOOK'd; Cameron-applied.
- Handler: IMxx -> message row; ParticipantSid -> member key via the stored
  mapping; `setRecipientDelivery` (existing conditional guard handles dups +
  out-of-order). On the FIRST receipt per member, also write the per-member
  SMxx sid-pointer to the group message row so the EXISTING status-callback
  route resolves those SIDs normally instead of burning its 2.5s
  unknown-SID retry + ERROR alarm per receipt (adjudication #10); the status
  route's retry window covers the callback-vs-receipt race. e2e asserts no
  unknown-SID ERROR from a group send.
- Unknown IMxx: log-and-drop with a counter; never 500.

## 8. Guardrails for the undocumented envelope

The failure that must be impossible: group detection silently stops and
nobody knows why. Three mechanisms, all on spike-proven or in-repo rails
(Event Streams is NOT used - the existing `/webhooks/twilio/events` route,
its shared-secret auth, and the Terraform twilio-events module belong to the
A2P sink and are not touched):

1. TRIPWIRE (inline, WARN + metric, deliberately not ERROR - the ERROR
   channel feeds the production alarm and a subject-only 1:1 MMS can
   legitimately match the shape): MM-prefixed, NumMedia=0, no
   OtherRecipients -> file as 1:1 (fail open) + structured WARN
   `group-envelope-missing` + counter metric. Known blind spot: media-bearing
   group MMS (NumMedia>0) - covered by mechanism 2.
2. CONVERSATION CROSS-CHECK (authoritative for the suppression failure
   mode): the ACCOUNT-GLOBAL Conversations webhook (config empty today;
   spike F5 proved carrier-sourced `onMessageAdded` arrives there) points at
   a new endpoint `POST /webhooks/twilio/conversations/events`
   (signature-validated). For every carrier-sourced message on a conversation
   we own, it verifies the classic webhook filed a matching message (by
   conversation + author + time window); a miss raises an ERROR alarm naming
   the ConversationSid/IMxx ("conversation-bound inbound missing from
   classic webhook"). This covers exactly the at-risk population: the
   "Twilio starts suppressing the classic copy" failure can only affect
   conversation-matched traffic. The endpoint is also the DORMANT STANDBY
   ingestion rail: the runbook procedure for that failure world switches
   group ingestion to it (payload already carries author/body; roster via
   one Participants read).
3. HEARTBEAT: a WARN metric when zero group-origin inbound has been seen for
   7 days while at least one group_text thread is active.

Plus, not built: runbook fallback to autocreation (spike F4) if the envelope
is removed outright, and an ops support ticket asking Twilio to confirm
`OtherRecipients{N}` as a supported contract.

## 9. Import/migration seam

The import lands 132 groups as `relay_group`/`connecting` (importer on
mainline; import mission owns the RUN). This feature ships:

- `convertConnectingRelayGroupToGroupText(conversationId, opts)`:
  - Preconditions: type relay_group, status connecting, no pool_number, and
    NOT `import_connect_requested` (the founder asked for a masked relay
    there; conversion REFUSES and reports - a human decides).
  - Rewrites to the 4.2 shape: type group_text, status open, group_status
    written, participants preserved, relay-only fields removed EXCEPT
    `relay_status`, which is set to the inert sentinel
    `converted:group_text` - because the importer re-run upserts
    `relay_status` via if_not_exists (apply.ts:712) and would resurrect
    `relay_group#connecting` on a converted thread (adjudication #6). The
    sentinel occupies a dead partition of the sparse GSI that no query reads
    (listRelayGroups queries `relay_group#<status>` partitions only).
  - Installs/extends `group_identity_excluded_numbers` from the caller's
    `ownNumbers` (4.1) and fails loudly if it cannot.
  - Idempotent; conversationId unchanged (identity parity), so history stays
    attached.
- A thin bulk entry point for the import mission to invoke; per-row results
  (converted / refused-with-reason).
- No Twilio Conversations at migration (lazy rail); nothing texts anyone.

## 10. Explicitly out of scope

- Relay behavior (one approved exception: the label rename in 3 if
  ratified). Staff-created native groups; roster editing; outbound group
  media; automated sends to groups; RCS; closing/archiving group threads;
  the migration RUN; prod Twilio ops (RUNBOOK'd, Cameron-applied);
  resolution of the double-reply issue (filed, coupled, not owned here).

## 11. Dashboard behavior (staff)

- Inbox: a THIRD row source reading byGroupStatus (merged like the relay
  source), row kind `group_text`, label per 3, member-derived title, unread
  badge. Group threads do NOT enter the contact unread SUM (consistent with
  relay's exclusion; enumerated readers in the plan).
- Thread view: `ConversationDetail` currently redirects every non-relay type
  to a contact page (ConversationDetail.tsx:134) - that branch becomes
  explicitly 1:1-only, and a new GroupTextView renders: member panel
  (suppression states), per-message sender chips (via relay_sender_key +
  roster), per-member delivery chips (existing renderers), composer per 6.2,
  an "everyone sees everyone's number" affordance in the header, and the
  >9-member banner when applicable.
- Contact page: a small "Group threads" card listing group_text threads whose
  roster contains the contact (participants scan via the byGroupStatus list;
  modest cardinality), linking into the thread view.
- Placement/Today/timeline surfaces: v1 treats group threads as
  inbox+thread-view only; the plan enumerates every `!== 'relay_group'`
  reader (the r1-b finding-15 list is the starting inventory) and states
  each one's group_text handling (mostly: exclude explicitly rather than
  fall through as 1:1).
- Accessibility-first selectors; UI quality bar applies.

## 12. Testing and verification

- Unit: golden-vector id tests; envelope parser shapes (indexed, gap,
  single, absent); exclusion-set application; conversion function incl.
  sentinel + refusal paths; receipts mapping/idempotency + sid-pointer
  write; group STOP consent scoping (sender 1:1 flagged, group thread NOT);
  stub-capture-without-consent.
- Fake Twilio: inbound group MMS injection with OtherRecipients (indexed,
  multi, media-bearing); minimal conversations surface (create/participants/
  post -> fan-out to fake phones + onDeliveryUpdated to the receipts route);
  21610 simulation for a STOPped fake phone; fake-phones UI can send a group
  text to the business number.
- e2e (hermetic lanes only): (1) group MMS -> group thread, members visible,
  no 1:1 filing, no contact-consent stamp for silent members; (2) dashboard
  reply -> all fake phones receive one group send, per-member delivered
  chips, NO unknown-SID ERROR in app logs; (3) group STOP -> suppressed
  chip + sender 1:1 flagged + group thread NOT suppressed; next send
  partial-delivers; START restores; (4) tripwire injection -> filed 1:1 +
  WARN line; (5) conversion fixture (lean gains one `connecting` relay_group
  + one group_text seed; full gains two demo group threads; plan enumerates
  affected byte-stable lean assertions); (6) cross-check endpoint: matched
  message -> quiet; injected conversation-only message -> ERROR alarm line.
- Live self-QA (dev, at handback): one detected group + one outbound reply
  on real handsets. DURING BUILD WEEK (pre-cutover, scheduled with Cameron):
  a 3-outside-member live group (needs a third US handset) to observe
  `OtherRecipients1+` and a media-bearing group inbound - the two shapes the
  spike could not exercise.
- Gates per AGENTS.md, bare, from the worktree.

## 13. Invariants (plan enumerates every surface per the standing rule)

1. A group-origin inbound is never filed as a 1:1 (sole exception: the
   fail-open tripwire path, which alarms).
2. The 1:1-classified inbound path gains no new I/O and no new persisted
   side effects; behavior is unchanged.
3. No inbound is ever lost: every webhook inbound persists somewhere even
   when classification fails.
4. 1:1 keyword handling (TwiML filed replies) is byte-identical; group
   keywords produce consent bookkeeping scoped to the sender (contact +
   sender's 1:1 thread), never the group thread, and no app-sent reply.
5. Imported and detected identity share one function AND one exclusion set;
   the same carrier roster never yields two threads.
6. Relay behavior is unchanged (sole approved exception: the 3 label rename
   if ratified). A group_text thread never carries pool_number and never
   carries a QUERYABLE relay_status (only the inert `converted:group_text`
   sentinel on converted imports). No relay consumer treats group_text as
   relay; no "not relay_group" reader silently treats group_text as a 1:1 -
   each one either handles or explicitly excludes it.
7. Group sends honor the SMS kill switch inside the adapter.
8. Every mutation surface of group state (detection create, conversion,
   lazy rail create, receipts, suppression, SEEDS - cast.ts, matrix.ts,
   live.ts - and dev seams) and every reader/renderer (inbox sources,
   unread rollups, contact card, thread view, SSE builder, Today,
   placement channels, timelines, api routes) is enumerated in the plan
   with its group_text handling stated.

## 14. Owed ops at merge/cutover (documented, not built)

- Dev + prod, in order: byGroupStatus GSI Terraform apply (SCHEMA FIRST),
  deploy, Conversations default-service webhook config (receipts URL),
  account-global Conversations webhook config (cross-check URL), support
  ticket (8), reseed where applicable.
- Migration run (import mission) invokes the conversion bulk entry point;
  refused rows (import_connect_requested) surfaced for founder decision.
- Cutover continuity: imported groups continue on the ported number because
  identity is the shared roster + exclusion set; handset threads merge by
  participant set (spike, odds-and-ends). First outbound per group lazily
  creates its rail.
- MMS-enabled campaign approval precedes real outbound (Cameron's gate).
- Follow-up issues filed by this spec: `twilio-standard-optout-double-reply`,
  `group-mms-including-pool-numbers`, outbound group media.
