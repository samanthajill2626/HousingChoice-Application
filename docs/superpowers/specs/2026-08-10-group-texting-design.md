# Native group texting - design spec

Status: DRAFT v3 (post adversarial review rounds 1-2; pre human gate)
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
- Naming: decision for Cameron at the spec gate, with honestly-costed
  options. See 3.
- Two VERIFY-BEFORE-BUILD spike addendum items (10 minutes on the dev
  account, needs one handset text): (a) do BOTH Conversations webhook scopes
  deliver when service-scoped (onDeliveryUpdated) and account-global
  (onMessageAdded) are configured simultaneously - the spike tested them
  separately, and if service scope supersedes global, guardrail 2 is
  silenced by the receipts config; (b) do classic Programmable Messaging
  status callbacks fire for Conversations-originated sends at all - decides
  the section 7 marker mechanism's residual race handling.

## 3. Vocabulary, type, and the label collision

New conversation type: **`group_text`** (code/data).

The staff-facing label "Group text" is ALREADY SHIPPED as the relay product's
label (GLOSSARY "Group text number"; InboxRow relay chip; relay header;
GroupTextsCard; inbox row label fallback; Today's "Group" label). Two products
under one chip - one masked, one deliberately unmasked - is a privacy-relevant
confusion. Decision (Cameron picks at the gate; costs stated honestly):

- Option A - rename relay to "Relay group", new type takes "Group text".
  Full blast radius (r2 finding 6): the staff surfaces above PLUS the
  MEMBER-FACING fan-out fragment "joined this group text"
  (relayFanOut.ts:225, rides the relay.member_added catalog body - an
  outbound-copy change through the catalog, not zero-behavior) PLUS ~88
  "group text" string assertions across e2e specs and selectors.md. Honest,
  durable naming; real sweep cost during cutover week.
- Option B (RECOMMENDED for this timeline) - relay copy untouched; the new
  type ships as "Direct group" (chip "Direct group", header "Direct group
  text - everyone sees everyone's number"). Zero relay/e2e churn now; a
  post-cutover rename mission is filed as a follow-up issue so the long-term
  naming lands later.

GLOSSARY gains the new entry either way (and, Option A only, updates the
relay entries in the same change).

## 4. Identity and data model

### 4.1 Identity

A group_text thread id is `conversationIdForGroup(sorted outside-participant
set)` - the importer's function at `app/src/lib/import/ids.ts:74` - imported
directly (NO file move: the uuidv5 NAMESPACE constant makes ids
relocation-sensitive in review terms; a golden-vector test pins known
roster -> uuid outputs so any refactor that changes outputs fails loudly).
Twilio's own group matching keys on the same sorted address set (research
report 1b, doc-derived).

**The exclusion set is part of the identity contract, fixed at DEPLOY (r2
finding 2: a migration-installed list leaves detection minting divergent ids
for every group the founder texts between deploy and cutover, with the
divergence alarm structurally blind in that exact window).** "Outside
participants" = the envelope's From + OtherRecipients minus the EXCLUDED set:

- the business number (config.businessPhoneNumber), plus
- all pool numbers (byPoolNumber GSI; cached read), plus
- `GROUP_IDENTITY_EXCLUDED_NUMBERS`: an env-config comma list of E.164
  numbers, shipped in every env file per the env-defaults rule (template
  carries it uncommented; dev/prod values are the Quo export's `ownNumbers`
  minus the business number - the importer resolved threads against ALL org
  numbers, `app/src/lib/import/apply.ts:281`). Set BEFORE detection first
  deploys; an ops item in 14, values confirmed with Cameron from the import
  plan output.

IMMUTABILITY RULE: changing this list re-keys every future detection against
every past one (same carrier thread, new uuid). The list is fixed at deploy;
any later change is a migration-grade decision with its own thread-merge
plan, not a config tweak. The env file documents this next to the var.

Conversion (section 9) verifies parity: it receives the importer's
`ownNumbers` and REFUSES to run if any of them (beyond the business number)
is missing from the runtime exclusion set - the loud failure replaces the
silently-blind WARN of v2. Detection additionally WARNs + counts if an
envelope contains a pool number or an excluded number in the outside-roster
position (a signal the exclusion config and reality disagree).

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
  without touching relay's GSI. Rollout (r2 finding 4: `ensureTable` is
  create-if-absent and reseed only clears rows - nothing upgrades a warm
  lane): dev/prod get the GSI via Terraform BEFORE deploy (14); every LOCAL
  lane and worktree must delete its `hc-local-<L>-*` tables once so the
  harness recreates them - a stated step in the branch setup notes and the
  plan. Readers of this GSI treat an index error as LOUD (ERROR log +
  surfaced UI failure state), never a best-effort empty list - "no groups"
  must not be reachable by misconfiguration.
- `participant_phone` / `participant_email`: ABSENT. Group threads are
  reached via byGroupStatus, conversationId, or the participants roster -
  never byParticipantPhone.
- `twilio_conversation_sid?: string` - CHxx of the lazily created rail
  (absent until first outbound).
- `status: 'open'` (byLastActivity also lists it; the inbox third source
  reads byGroupStatus - readers that iterate byLastActivity and reject
  unknown shapes are enumerated in the plan).
- NO `pool_number`, NO `relay_status` ever (the v2 sentinel is DROPPED - the
  importer type-guard in 9 protects converted AND detected threads alike,
  which the sentinel could not; r2 finding 1).
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
- UNLIKE the relay precedent (which calls the shared seam only on keyword
  commands), the group path calls `processInboundKeywords` on EVERY group
  inbound - because the plain-inbound `inbound_text` consent stamp for the
  SENDER lives inside that function (twilio.ts:639-650), and skipping it
  strands first-contact group senders JIT-gated for proactive sends (r2
  finding 7). Only the reply usage is suppressed, never the call.
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
     - adjudication #8). Group stubs are minted with the IMPORTER'S id scheme
     `contactIdForPhone(e164)` (uuidv5), NOT `contact-<randomUUID>`, so the
     import's later contact upsert converges on the same row instead of
     duplicating every detected member at migration (r2 finding 11). Write
     `participants` once with the full roster (single conditional claim; on
     race, loser re-reads). The SENDER gets normal inbound consent semantics
     via the every-inbound `processInboundKeywords` call (4.4), and the
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
- Cap: 10 participants per group conversation is doc-derived (research
  report 4); that our projected address consumes one of the 10 (-> max 9
  outside members) is the research report's [INF], not doc text - the
  composer threshold stays at 9 as the SAFE direction (if wrong, a 10th
  member is unnecessarily blocked, never an API failure). A >9-member
  thread is inbound-only; composer disabled with a banner naming the member
  1:1 links as the explicit fallback affordance.

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
  out-of-order). Handler budget: Conversations webhooks time out at 5s
  (research 8d) - the receipts handler's work is two bounded writes and
  stays inline; anything heavier moves behind `jobs.enqueue()`.
- Status-callback interplay (r2 finding 5 replaced v2's sid-pointer design,
  which would have routed group DLRs into `handleRelayRecipientStatus` -
  relay logging, placement attention flags - violating invariant 6, and
  mis-sized the race): on learning each member's SMxx from a receipt, the
  handler writes a `syssid#` SYSTEM MARKER (the existing ack-quietly kind,
  twilio.ts:1306-1316) so classic status callbacks for that SID are
  INFO-acked with no relay dispatch. Delivery state comes SOLELY from
  onDeliveryUpdated. Whether classic callbacks fire at all for
  Conversations-originated sends is spike-addendum item (b): if they do not,
  the marker write is dropped from the plan; if they do, the residual race
  (callback arriving before the first receipt writes the marker; receipts
  observed at ~1-5s vs the status route's single 2.5s retry) is measured in
  e2e/live-QA, and the plan either adds a bounded second retry to the
  unknown-SID terminus or documents the rare alarm string. e2e asserts no
  unknown-SID ERROR from a group send in the fake harness either way.
- Recreate-on-404 staleness (r2 finding 10): recreating a Conversation mints
  new ParticipantSids - the stored MBxx map is refreshed from a Participants
  read on every recreate, and a KNOWN IMxx with an UNKNOWN ParticipantSid is
  WARN + counter, never a silent drop.
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
   (signature-validated; ack fast, compare async behind `jobs.enqueue()` -
   the 5s webhook budget). It reconciles BOTH DIRECTIONS (r2 finding 3 - a
   miss-only alarm cannot tell healthy from dead):
   - Event without a matching classic-filed message (conversation + author +
     time window) -> ERROR "conversation-bound inbound missing from classic
     webhook" - the suppression alarm.
   - Classic-filed group inbound on a thread WITH a `twilio_conversation_sid`
     but NO corresponding event within the window -> WARN "cross-check
     channel quiet" - the monitor-is-dead alarm. This is the liveness signal;
     it runs from the ingestion side, so the cross-check cannot silently rot.
   Honest coverage statement: the cross-check observes only threads whose
   rail exists (lazy creation = post-first-outbound). During the
   detection-only slice, mechanisms 1 and 3 are the guards. Scope precedence
   (does configuring the service-scoped receipts webhook silence the global
   scope?) is spike-addendum item (a) and MUST pass before this mechanism is
   called authoritative. The endpoint is also the DORMANT STANDBY ingestion
   rail: the runbook procedure for the suppression world switches group
   ingestion to it (payload carries author/body; roster via one
   Participants read).
3. HEARTBEAT: a WARN metric when zero group-origin inbound has been seen for
   7 days while at least one group_text thread is active.

Plus, not built: runbook fallback to autocreation (spike F4) if the envelope
is removed outright, and an ops support ticket asking Twilio to confirm
`OtherRecipients{N}` as a supported contract.

## 9. Import/migration seam

The import lands 132 groups as `relay_group`/`connecting` (importer on
mainline; import mission owns the RUN). This feature ships:

- IMPORTER TYPE-GUARD (in this branch - the importer code is on mainline and
  in-repo; only the RUN is the import mission's): `upsertConversation`
  (apply.ts:672-720) learns to protect `group_text` rows. When the existing
  row's type is `group_text`, the group upsert SKIPS `relay_status` and the
  unconditional `participants` overwrite (which would re-key detection's
  contactId-bearing roster and every relay_sender_key chip). This replaces
  v2's `converted:group_text` sentinel - which protected only CONVERTED
  threads, while the identity contract guarantees DETECTED threads collide
  with importer ids too (r2 finding 1). Messages/history import unchanged
  (separately keyed).
- `convertConnectingRelayGroupToGroupText(conversationId, opts)`:
  - Preconditions: type relay_group, status connecting, no pool_number, and
    NOT `import_connect_requested` (the founder asked for a masked relay
    there; conversion REFUSES and reports - a human decides).
  - Rewrites to the 4.2 shape: type group_text, status open, group_status
    written, participants preserved, ALL relay-only fields removed
    (relay_status included - the importer type-guard makes a sentinel
    unnecessary).
  - Verifies exclusion-set parity against the caller's `ownNumbers` (4.1)
    and REFUSES loudly on a mismatch.
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

- Inbox: a THIRD row source reading byGroupStatus, row kind `group_text`,
  label per 3, member-derived title, unread badge. NOT "merged like the
  relay source" unqualified - relay's additive first-page merge is sized for
  a handful of rows and the founder has 132 group threads on day one (r2
  finding 8). The group source merges the TOP 50 by last-activity into page
  one with a surfaced "showing 50 of N group texts" affordance linking to an
  inbox groups filter (`?filter=groups`) that pages the FULL list via the
  byGroupStatus cursor. Group threads do NOT enter the contact unread SUM
  (consistent with relay's exclusion; enumerated readers in the plan).
- Thread view: `ConversationDetail` currently redirects every non-relay type
  to a contact page (ConversationDetail.tsx:134) - that branch becomes
  explicitly 1:1-only, and a new GroupTextView renders: member panel
  (suppression states), per-message sender chips (via relay_sender_key +
  roster), per-member delivery chips (existing renderers), composer per 6.2,
  an "everyone sees everyone's number" affordance in the header, and the
  >9-member banner when applicable.
- Contact page: a small "Group threads" card listing group_text threads whose
  roster contains the contact - read through a BOUNDED byGroupStatus pager
  with a `truncated` flag the card MUST surface (relay's bounded-reader
  discipline, conversationsRepo.ts:552-561; there is no member->thread
  index and this spec does not add one), linking into the thread view.
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
  on real handsets, AND - the one observation no automated test can make
  (the fake never emits Twilio's auto-replies) - a group STOP counted to
  exactly ONE confirmation on the sender's handset (zero would be an A2P
  defect; two feeds the double-reply issue). DURING BUILD WEEK
  (pre-cutover, scheduled with Cameron): the spike addendum items (a)+(b)
  from section 2, plus a 3-outside-member live group (needs a third US
  handset) to observe `OtherRecipients1+` and a media-bearing group inbound
  - the shapes the spike could not exercise.
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
5. Imported and detected identity share one function AND one exclusion set,
   and the exclusion set exists from the first deployed detection onward;
   the same carrier roster never yields two threads.
6. Relay behavior is unchanged (sole potential exception: the 3 label
   decision, if Option A is ratified). A group_text thread never carries
   pool_number or relay_status - including across import re-runs (the
   importer type-guard). No relay consumer treats group_text as relay; no
   "not relay_group" reader silently treats group_text as a 1:1 - each one
   either handles or explicitly excludes it. Group delivery outcomes never
   dispatch through relay status handlers or relay metrics.
7. Group sends honor the SMS kill switch inside the adapter.
8. Every mutation surface of group state (detection create, conversion,
   lazy rail create, receipts, suppression, SEEDS - cast.ts, matrix.ts,
   live.ts - and dev seams) and every reader/renderer (inbox sources,
   unread rollups, contact card, thread view, SSE builder, Today,
   placement channels, timelines, api routes) is enumerated in the plan
   with its group_text handling stated.

## 14. Owed ops at merge/cutover (documented, not built)

- Dev + prod, in order: byGroupStatus GSI Terraform apply (SCHEMA FIRST),
  `GROUP_IDENTITY_EXCLUDED_NUMBERS` env values set (from the import plan's
  `ownNumbers`; BEFORE detection deploys - identity depends on it), deploy,
  Conversations default-service webhook config (receipts URL),
  account-global Conversations webhook config (cross-check URL), support
  ticket (8), reseed where applicable. Local lanes: one-time
  `hc-local-<L>-*` table deletion for the new GSI (4.2).
- Migration run (import mission) invokes the conversion bulk entry point;
  refused rows (import_connect_requested) surfaced for founder decision.
- Cutover continuity: imported groups continue on the ported number because
  identity is the shared roster + exclusion set; handset threads merge by
  participant set (spike, odds-and-ends). First outbound per group lazily
  creates its rail.
- MMS-enabled campaign approval precedes real outbound (Cameron's gate).
- Follow-up issues filed by this spec: `twilio-standard-optout-double-reply`,
  `group-mms-including-pool-numbers`, outbound group media, and (if naming
  Option B is chosen) the post-cutover relay-label rename.
