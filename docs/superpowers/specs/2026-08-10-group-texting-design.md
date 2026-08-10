# Native group texting - design spec

Status: v8 - APPROVED. Gate rulings (Cameron, 2026-08-10): label Option
A; auto-convert backstop; EAGER rail creation; run-to-completion migration
guarantee; consent option (a) - the group_participation basis, carried in
a DISTINCT contact field (delta review), never consent_method. Review
trail: 4 adversarial spec rounds (hard cap) + human gate + 3 plan rounds +
external design review (8 findings, all accepted) + a delta round (12
findings, all accepted) - all folded. Key structural amendments:
status='group_open' partition (no new GSI/schema); one connect flag field,
conversion converts + reports it; parity at the bulk migration entry;
normalized identity inputs; transcript-level extraction filtering;
receipts through the forward-only guarded method with a targeted sid
write; rails carry UniqueName + an EXPIRING conditional claim.
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
- Architecture is the spike's, with one DELIBERATE deviation, flagged:
  Event Streams is NOT used - the reconciliation guardrail instead uses the
  account-global Conversations webhook, a mechanism the spike proved (F5).
  Rail creation is EAGER (Cameron's gate ruling, reversing the draft's lazy
  choice): the migration creates every converted group's Conversation
  (silent - spike F3), and detection creates a new thread's rail via an
  async job at thread creation; create-on-send remains as the backstop.
  This activates the guardrail cross-check for the whole imported
  population from day one and surfaces rail-ineligible members (50407-class
  numbers) in the migration report instead of at first staff reply.
- Guardrail ruling (Cameron): the undocumented `OtherRecipients{N}` webhook
  param is acceptable IFF failure is loud and self-explaining. Section 8.
- Naming: OPTION A RATIFIED (Cameron, 2026-08-10). Relay's staff copy
  renames to "Relay group"; the native type takes "Group text". The rename
  is BUILD SLICE S1 (it frees the vocabulary everything after it uses). See
  3 for the full enumerated blast radius.
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
confusion. DECISION: Option A, ratified by Cameron 2026-08-10.

Relay's copy renames to "Relay group"; the native type takes "Group text".
Full enumerated blast radius (r2 finding 6), delivered as BUILD SLICE S1:
GLOSSARY relay entries; InboxRow relay chip + its test; relay header
(ConversationDetail); GroupTextsCard title; inbox row label fallback
(inbox.ts:513-537); Today's relay label (buildToday); relay dialog copy
(RelayCloseAskDialog etc.); the MEMBER-FACING fan-out fragment "joined this
group text" (relayFanOut.ts:225, rides the relay.member_added catalog body -
an outbound-copy change through the catalog, explicitly approved); and the
~88 "group text" string assertions across e2e specs plus
e2e/support/selectors.md. S1 is copy + assertions only - zero relay
behavior - and lands before any group_text UI so the vocabulary is free.

GLOSSARY gains the new "Group text" (native) entry and the updated relay
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

**The exclusion set is part of the identity contract, fixed at DEPLOY (r2
finding 2: a migration-installed list leaves detection minting divergent ids
for every group the founder texts between deploy and cutover, with the
divergence alarm structurally blind in that exact window).** "Outside
participants" = the envelope's From + OtherRecipients minus the EXCLUDED set:

- the business number (config.businessPhoneNumber), plus
- all pool numbers (byPoolNumber GSI; cached read), plus
- `GROUP_IDENTITY_EXCLUDED_NUMBERS`: an env-config comma list of E.164
  numbers, shipped in every env file per the env-defaults rule (dev/prod
  values are the Quo export's `ownNumbers` minus the business number - the
  importer resolved threads against ALL org numbers,
  `app/src/lib/import/apply.ts:281`). Set BEFORE detection first deploys; an
  ops item in 14, values confirmed with Cameron from the import plan output.
  BOOT VALIDATION (r3 finding 4; the BUSINESS_PHONE_NUMBER three-tier idiom,
  config.ts:1137-1170): per-entry E.164 format throw; the literal value
  `none` asserts "no extra org numbers" deliberately; production THROWS when
  the var is unset (empty-by-omission is the dangerous default and must be
  impossible); non-production WARNs when unset on a twilio-driver stack.

NORMALIZATION IS PART OF THE CONTRACT (plan-r1): `conversationIdForGroup`
sorts and dedupes but does NOT normalize (its docstring puts that on the
caller, and the importer normalizes upstream via `normalizeToE164`). The
runtime identity function normalizes every envelope number with the SAME
`normalizeToE164` before exclusion and id derivation; parser tests cover
formatting variants.

IMMUTABILITY RULE, ENFORCED IN DEPLOYED ENVS ONLY (r4 finding 4: the
settings table is wiped by local reseeds, where a fingerprint protects
nothing): in deployed environments, boot compares a hash of the sorted list
against a persisted settings fingerprint (first boot writes it) and a
mismatch THROWS - un-misconfigurable, same tier as the unset case - with an
operator message naming the deliberate-change procedure (migration-grade
decision, thread-merge plan, fingerprint reset step). Local/hermetic stacks
skip the fingerprint check.

Conversion (section 9) verifies SET EQUALITY (modulo the business number and
pool numbers) between the importer's `ownNumbers` and the runtime exclusion
set, and REFUSES on a mismatch in EITHER direction - a missing number mints
divergent ids, and an extra (typo'd/stale) number silently subtracts a real
member from every roster containing them (r3 finding 8). Detection WARNs +
counts only when a POOL number appears in the outside-roster position
(genuinely anomalous); an excluded number appearing there is the
correctly-configured steady state, not a signal (r3 finding 9).

Lookups: exclusion-set resolution runs ONLY on envelope-bearing inbound
(1:1s never reach it) and uses one cached read (pool list + config list
cached with a short TTL), not per-participant queries.

Roster changes are new identities by construction (carrier + Twilio + handset
semantics agree). No roster mutation exists in v1; a member "leaving" is
per-member suppression (4.4).

### 4.2 ConversationItem shape (additive)

- `type: 'group_text'` joins the union, declared in TWO places
  (`app/src/repos/conversationsRepo.ts:39`, `dashboard/src/api/types.ts:408`
  - events.ts imports it); every ConversationType-keyed structure gets an
  explicit ruling, INCLUDING the silent non-Record ones the compiler cannot
  catch (buildToday's ONE_TO_ONE Set, participantContactId, is1to1; the
  today.ts unreplied allowlist) - enumerated in the plan.
- `participants: ConversationParticipant[]` - outside members (contactId +
  phone + optional name), written ONCE at creation (single conditional
  claim; see 5). The business number is implicit.
- **`status: 'group_open'`** - group threads live in their OWN partition of
  the EXISTING byLastActivity GSI (HASH is `status`), which is the entire
  listing mechanism: `listGroupTexts` queries the `group_open` partition
  directly. NO new GSI, NO schema change, NO Terraform, NO lane-table
  resets (plan-r1 amendment: the earlier byGroupStatus design would have
  ALSO left `status: 'open'` diluting Today's hard-capped 100-row
  byLastActivity read and the inbox pager batches with 132+ group rows -
  the exact `relay-inbox-open-groups-truncation` bug class). Consequences,
  all deliberate: today.ts, the inbox contact pager, and
  `GET /api/conversations?status=open` (api.ts:1562 - the 50-row page four
  dashboard hooks consume) never see group threads by construction; and
  inboundEmail's `status !== 'open'` not-1:1 check excludes groups for
  free. Unread contract (external review finding 7): unread state is not
  in the partition key, so group unread reads are an ACCEPTED FULL
  PARTITION WALK at the known scale (132 threads, ~one query page) - the
  explicit contract replacing any bounded-work claim; a growth threshold
  (>500 threads) files a follow-up for an unread materialization.
  PARTITION SAFETY IS A REPO-LEVEL GUARANTEE (plan-r2): every writer
  that would set `status='open'` blindly (touchLastActivity - called from
  inbound AND the outbound send path api.ts:1501 - and any future caller)
  is guarded IN THE REPO: the status write carries ConditionExpression
  `#type <> :group_text`, retrying without the status clause on failure, so
  NO call site can ever flip a group thread out of its partition (silent
  unrecoverable loss otherwise). The 1:1 path is the same single write plus
  a condition that always passes - behavior unchanged. Because `status` is
  a bare string in both type declarations, the plan carries a full
  enumeration of status-literal comparisons with per-site rulings. Readers
  of the group partition treat a query error as LOUD (ERROR + surfaced
  failure state), never best-effort-empty. Unread visibility: under the
  inbox unread filter the group source returns ALL unread group threads
  (no top-50 cap), and the nav unread badge includes group unread.
- `participant_phone` / `participant_email`: ABSENT. Group threads are
  reached via the group_open partition, conversationId, or the participants roster -
  never byParticipantPhone.
- `twilio_conversation_sid?: string` - CHxx of the eagerly created rail
  (6.1; absent only pre-rail or when rail creation failed).
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
- outbound: per-member delivery uses the EXISTING `delivery_recipients`
  map keyed by relayMemberKey - NOT a new map. CORRECTED MECHANISM
  (external review finding 1, code-verified): `setRecipientDelivery`
  (messagesRepo.ts:1554) is an UNCONDITIONAL child SET - it is used ONLY to
  seed the parent map with 'queued' slots at send time (the documented
  parent-must-exist rule, api.ts:1447). Every RECEIPT applies through the
  forward-only guarded method `updateRecipientDeliveryStatus`
  (messagesRepo.ts:1577: allowedPriorStatuses + optimistic condition),
  extended so the slot also records the per-member channel SMxx and error
  code. Required tests: delivered->sent rejected, failed->sent rejected,
  duplicate receipts idempotent. Existing per-member chip renderers light
  up unchanged.
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
  commands), the group path runs the shared consent/keyword seam on EVERY
  group inbound - because the plain-inbound `inbound_text` consent stamp for
  the SENDER lives there (twilio.ts:639-650), and skipping it strands
  first-contact group senders JIT-gated for proactive sends (r2 finding 7).
  BUT the seam's target conversation becomes LAZY (r3 finding 1: eagerly
  resolving via createOrGetByParticipantPhone mints an EMPTY 1:1 thread per
  group sender - a blank needs-triage inbox row per member, a product
  regression): the plain-inbound consent stamp is CONTACT-level and needs no
  conversation; the sender's 1:1 thread is materialized ONLY on an OPT-OUT
  or OPT-IN keyword, where `setSmsOptOut` needs a target - NOT on HELP,
  which has no conversation-level effect and would re-create the phantom
  thread (r4 finding 6). Mechanism: a lazy thunk parameter or an extracted
  contact-level stamp function - either way, NO conversation row is created
  for a plain group inbound. Only the reply usage is suppressed, never the
  consent call.
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
   single unindexed `OtherRecipients` should the shape vary). MINIMUM
   ROSTER (external review finding 8): after exclusions, a group_text
   thread requires >= 2 outside members; a roster that collapses to one
   (e.g. the other recipient was a pool/org number) files into the
   sender's 1:1 + WARN metric - which is also semantically correct, since
   a carrier group of us-plus-one-person IS a 1:1.
2. NONE present -> the existing 1:1 pipeline, unchanged. (Invariant: no new
   I/O and no new persisted side effects on this path; the only addition is
   param inspection.)
3. Present -> group-origin:
   - Roster per 4.1 (exclusion set applied; WARN metric on divergence
     signals).
   - conversationId = conversationIdForGroup(roster).
   - Resolve the thread at the group id. THREE cases, all specified:
     (a) NOT FOUND -> create the group_text thread (below).
     (b) FOUND, type group_text -> file into it.
     (c) FOUND, type relay_group with status connecting and no pool_number
         (an imported row not yet converted) -> AUTO-CONVERT (Cameron's gate
         ruling): run the conversion function inline (idempotent; its
         preconditions are exactly this state; called WITHOUT ownNumbers -
         parity checking belongs to the bulk migration entry, which has the
         import context) and file the message as a group message, with a
         WARN + metric recording the self-heal. NOTE (plan-r1): the
         workbook's `connect_day_one` column persists as the single
         attribute `import_connect_requested` - ONE field, not two. Rows
         carrying it auto-convert exactly the same way (observed
         carrier-group activity implements the standing "all groups
         continue" ruling; the flag is REPORTED, never a runtime refusal).
         OPERATIONAL NOTE: this branch is a
         backstop expected never to fire - the migration guarantee (14) is
         that every imported group reaches converted-or-deleted BEFORE
         go-live; the reachable trigger is a post-cutover import re-run
         introducing brand-new connecting rows.
         Any OTHER shape at the id (open/connected relay_group with a pool
         number - not creatable by the importer, indicates corruption) ->
         file to the sender's 1:1 + ERROR; never guess.
   - Creation: resolve-or-create a contact per member by phone. CONSENT
     BASIS (Cameron's ruling, external review finding 4, option (a)):
     member stubs record the basis in a DISTINCT CONTACT FIELD
     `group_participation_at` (ISO timestamp) - NEVER in `consent_method`
     (delta review finding 2: consent_method flows through the shared
     hasSmsConsent predicate into broadcasts, nudges, reminders and both
     staff has-consent displays, which would make silent members
     PROACTIVELY sendable - the opposite of the ruling; and never-
     overwrite semantics on consent_method would mask a later genuine
     basis, finding 3. A separate field has neither problem: consent_method
     stays absent until a real basis arrives, and every existing consumer
     is untouched by construction). The same stamp is applied to
     imported-group members at conversion (9). GATING RULE: group sends
     require every member to hold consent_method OR group_participation_at;
     proactive 1:1 paths read hasSmsConsent exactly as today and therefore
     still refuse silent members - no per-call-site patching (the
     smsCompliance.ts single-predicate rule holds). The A2P compliance
     docs gain a paragraph documenting this basis. Group stubs are minted
     with the IMPORTER'S id scheme `contactIdForPhone(e164)` (uuidv5) so the
     import's later contact upsert converges on the same row (r2 finding
     11), AND carry an origin marker (`origin: 'group_detection'`-style
     field) that the import's `retractImported` MUST refuse to delete
     through (r3 finding 3: id convergence made detection stubs reachable by
     the import's unconditional contact DeleteCommand, apply.ts:467-470 -
     the retract gains a guard symmetric with its existing foreign-message
     guard: contact carries the origin marker OR appears on any group_text
     roster -> report, do not delete). Write `participants` once with the
     full roster (single conditional claim; on race, loser re-reads). The
     SENDER gets normal inbound consent semantics via the lazy-seam call
     (4.4), and the sender's `touchPhoneLastSeen` second-number attribution
     runs exactly as on a 1:1 (it is sender attribution, not a 1:1-ism).
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
   never lose a message) + WARN. Tripwire-filed messages carry a marker and
   AI fact extraction EXCLUDES THEM AT THE TRANSCRIPT LEVEL (plan-r1:
   extraction reads whole-thread windows, so guarding only the trigger
   suppresses nothing - the extraction job filters marked messages out of
   every transcript it builds; r4 finding 2's intent: possibly-group
   content must not be attributed to the sender as 1:1 facts).

First message of a never-seen group creates the thread synchronously in the
webhook - no misfile window exists (spike F1).

## 6. Outbound path (group replies)

### 6.1 The Conversations rail (EAGER; Cameron's gate ruling)

Created via a new `groupConversationsPort` adapter (vendor calls in
`app/src/adapters`, services depend on the port), at three moments:

- MIGRATION: the conversion bulk run creates each converted group's
  Conversation SYNCHRONOUSLY per row (plan-r2: an async enqueue could not
  put 50407-class outcomes in the migration report, which is the point of
  eager rails). Silent - spike F3; nothing is posted. Failures (a member
  Twilio rejects, or a >9 roster) do NOT fail the conversion: the thread
  converts rail-less, the failure lands in the per-row report, and the
  thread view shows the inbound-only banner.
- DETECTION: an async job enqueued at group-thread creation creates the rail
  (keeps the webhook fast; the rail exists before any human could reply).
- SEND-TIME BACKSTOP: if the rail is missing at composer send, create it
  then (the original lazy path, retained as fallback).

Rail creation mechanics:

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
- LIFECYCLE + IDEMPOTENCY (external review finding 2 + delta finding 6):
  creation sets a deterministic, non-PII `UniqueName` = our
  conversationId. Before any Twilio call the creator takes a conditional
  local claim (`rail_creating` attribute CARRYING ITS TIMESTAMP,
  conditional write; loser re-reads; a claim older than the expiry window
  is RE-CLAIMABLE, so a crashed claimant can never strand a thread
  rail-less against the hardened cutover gate) - detection-job, migration,
  and send-backstop can never double-create. A crash between Twilio
  create and local persist is recovered by fetch-by-UniqueName
  adopt-or-create on retry. After `active`, participants are fetched
  and the MB map VALIDATED against the roster before compose enables; a
  conversation that fails/closes during attach is recorded rail-failed.
  Recreate-on-404 re-runs the same claimed sequence. Tests: concurrent
  double-create, crash-retry recovery, closed-rail, recreation race.
- The inline (5.3c) and bulk conversions use one conditional type
  transition with loser-reread (same discipline).
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
  1:1: single participantPhone, whole-send opt-out refusal). CONSENT GATE
  (Cameron's option-(a) ruling): the service refuses when any member lacks
  consent_method OR group_participation_at (the UI surfaces which member
  blocks). Defense-in-depth: creation paths stamp every member, so the
  refusal should be unreachable - its test constructs the gap via a direct
  repo write and says so. Shared seams, named exactly: the SMS kill-switch
  predicate (`smsSendingEnabled` -
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
  mapping; `updateRecipientDeliveryStatus` (forward-only guarded; 4.3 -
  never the unconditional seeder). Handler budget: Conversations webhooks time out at 5s
  (research 8d) - the receipts handler's work is two bounded writes and
  stays inline; anything heavier moves behind `jobs.enqueue()`.
- Status-callback interplay (r2 finding 5 replaced v2's sid-pointer design,
  which would have routed group DLRs into `handleRelayRecipientStatus` -
  relay logging, placement attention flags - violating invariant 6, and
  mis-sized the race): on learning each member's SMxx from a receipt, the
  handler writes a `syssid#` SYSTEM MARKER (the existing ack-quietly kind,
  twilio.ts:1306-1316) so classic status callbacks for that SID are
  INFO-acked with no relay dispatch. Group markers SET `expires_at` (~30d
  TTL): `putSystemSidMarker` gains an optional TTL parameter and the
  messages-table "sole expires_at writer" comment is updated in the same
  change (r3 finding 13, r4 finding 7). Delivery state comes
  SOLELY from onDeliveryUpdated - which makes a dead/misconfigured receipts
  webhook SILENT, so it gets its own alarm (r3 finding 6): each group send
  enqueues ONE delayed staleness check (`jobs.enqueue` runAt ~+10min) that
  ERRORs if the message's `delivery_recipients` is still empty/queued -
  "group delivery receipts silent - check Conversations service webhook
  config". Whether classic callbacks fire at all for Conversations sends is
  spike-addendum item (b): if not, the marker write is dropped from the
  plan; if so, unknown group-send SIDs get DURABLE PARKING (external
  review finding 6: a longer sleep is not sufficient) - a short-TTL parked
  record written by the status route's unknown-SID path, reconciled when
  the receipt writes the marker; a parked record that expires unreconciled
  alarms. e2e asserts no unknown-SID ERROR from a group send either way.
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
2. CONVERSATION CROSS-CHECK (a LIVENESS HEURISTIC for the suppression
   failure mode - external review finding 5: onMessageAdded carries no
   SM/MM identifier, so no deterministic join exists unless the addendum
   finds one): the ACCOUNT-GLOBAL Conversations webhook (config empty today;
   spike F5 proved carrier-sourced `onMessageAdded` arrives there) points at
   a new endpoint `POST /webhooks/twilio/conversations/events`
   (signature-validated; ack fast, compare async behind `jobs.enqueue()` -
   the 5s webhook budget). It reconciles BOTH DIRECTIONS (r2 finding 3 - a
   miss-only alarm cannot tell healthy from dead):
   - Events are PERSISTED and DEDUPED by IM SID; matching runs at a
     GRACE DEADLINE (single reconciliation sweep, not immediate compare -
     event-first delivery and redelivery must not false-alarm), and an
     event still unmatched at the deadline alarms ONCE: ERROR
     "conversation-bound inbound missing from classic webhook". Tests:
     both delivery orders, duplicates, rapid same-author messages, genuine
     miss.
   - Liveness (the monitor-is-dead signal), as a SINGLE SCHEDULED SWEEP, not
     per-message state (r3 finding 7: absence of an event is not computable
     inline at ingestion; a per-inbound delayed job would be a permanent tax):
     the cross-check endpoint records a last-event-received timestamp and
     ingestion records a last-railed-classic-inbound timestamp - both as
     NAMED settings-table records (`group_crosscheck_last_event_at`,
     `group_railed_inbound_last_at`; r4 finding 9); a daily job WARNs when
     railed-thread classic inbound occurred in the last 24h while the
     cross-check recorded zero events - "cross-check channel quiet".
   Honest coverage statement: the cross-check observes only threads whose
   rail exists - which under EAGER creation (6.1) is every converted group
   from migration day and every detected group within seconds of creation;
   only the brief pre-rail window and rail-ineligible threads fall back to
   mechanisms 1 and 3. Scope precedence
   (does configuring the service-scoped receipts webhook silence the global
   scope?) is spike-addendum item (a) and MUST pass before this mechanism
   counts as coverage. The endpoint is also the DORMANT STANDBY ingestion
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
  (apply.ts:672-720) learns to protect `group_text` rows. Mechanism is the
  CONDITIONAL-WRITE form, not read-then-write (r3 finding 5: a Get-then-
  Update races with live detection during the import's own supported
  re-run-under-traffic scenario): attempt the full group upsert with
  `ConditionExpression: attribute_not_exists(#type) OR #type <> :groupText`;
  on ConditionalCheckFailedException, retry with a REDUCED expression that
  skips `relay_status`, the `participants` overwrite (which would re-key
  detection's contactId roster and every relay_sender_key chip), AND
  `imported_from`/`imported_at` (stamping those would expose the thread to
  retract paths). This replaces v2's sentinel - which protected only
  CONVERTED threads while the identity contract guarantees DETECTED threads
  collide with importer ids too (r2 finding 1). Messages/history import
  unchanged (separately keyed). COORDINATION NOTE for 14: this edits
  mainline `apply.ts`, which the unmerged import branch also touches -
  Cameron sequences the merges.
- IMPORT RETRACT GUARD (same file): `retractImported`'s contact delete
  (apply.ts:467-470, currently unconditional) gains the guard from 5: a
  contact carrying the detection origin marker, or present on any group_text
  roster, is reported and NOT deleted.
- `convertConnectingRelayGroupToGroupText(conversationId, opts)`:
  - Preconditions: type relay_group, status connecting, no pool_number.
    `import_connect_requested` does NOT refuse (plan-r1 established it is
    the same single field as the workbook's connect column; Cameron's
    auto-convert ruling governs): the flag is included in the result for
    reporting.
  - Rewrites to the 4.2 shape: type group_text, status 'group_open',
    members stamped `group_participation_at` (the distinct-field basis;
    consent_method untouched), participants preserved WITH contactId
    BACKFILL (imported rosters carry
    `contactId: ''` - apply.ts:216-220; conversion fills each empty
    contactId with `contactIdForPhone(phone)`, converging with both the
    import's and detection's contact id schemes so member keying and
    suppression chips work), ALL relay-only fields removed.
  - Parity (4.1) is verified by the BULK entry point, which receives
    `ownNumbers` from the import context and refuses on either-direction
    mismatch BEFORE converting anything; the conversion core skips parity
    when called without ownNumbers (the runtime inline path - boot
    validation + fingerprint guard that caller).
  - Idempotent; conversationId unchanged (identity parity), so history stays
    attached.
- A thin bulk entry point for the import mission to invoke; per-row results
  (converted / refused-with-reason).
- The bulk conversion run ALSO creates each converted group's Conversations
  rail (6.1, eager; silent - nothing texts anyone) and reports per-row rail
  outcomes (created / failed-with-reason) alongside conversion outcomes.
- MIGRATION GUARANTEE (Cameron, 2026-08-10, recorded in 14): every imported
  group reaches converted-or-deleted BEFORE go-live; 5.3(c) is a backstop
  for post-cutover re-runs, not a planned state.

## 10. Explicitly out of scope

- Relay behavior (one approved exception: the S1 label rename, ratified).
  Staff-created native groups; roster editing; outbound group media;
  automated sends to groups; RCS; closing/archiving group threads;
  attaching group_text threads to tours/placements (relay's owner_ref
  pattern extends naturally later - filed as
  `docs/issues/group-text-tour-placement-attachment.md` per Cameron's gate
  question); the migration RUN; prod Twilio ops (RUNBOOK'd,
  Cameron-applied); resolution of the double-reply issue (filed, coupled,
  not owned here).

## 11. Dashboard behavior (staff)

- Inbox: a THIRD row source reading the group_open partition, row kind `group_text`,
  label per 3, member-derived title, unread badge. NOT "merged like the
  relay source" unqualified - relay's additive first-page merge is sized for
  a handful of rows and the founder has 132 group threads on day one (r2
  finding 8). The group source merges the TOP 50 by last-activity into page
  one with a relay-style `truncated` surfacing ("Showing latest 50 group
  texts - view all"; NO exact total, which the partition cannot produce without
  walking the partition - r3 finding 11), linking to an inbox groups filter
  (`?filter=groups`) that pages the FULL list via the group_open-partition cursor.
  The filter joins the InboxFilter union + route allowlist (both declaration
  sites); its cursor is NAMESPACED/tagged (a group_open-partition LEK is not an 'open'-partition
  byLastActivity LEK - replaying one into the other is a 500; switching
  filters drops the cursor client-side AND the server 400s a cursor whose
  tag mismatches the filter - defense in depth, r4 finding 10), and the
  contact pager does NOT run under `filter=groups` (r3 finding 10). Group threads do NOT enter the contact
  unread SUM (consistent with relay's exclusion; enumerated readers in the
  plan).
- Thread view: `ConversationDetail` currently redirects every non-relay type
  to a contact page (ConversationDetail.tsx:134) - that branch becomes
  explicitly 1:1-only, and a new GroupTextView renders: member panel
  (suppression states), per-message sender chips (via relay_sender_key +
  roster), per-member delivery chips (existing renderers), composer per 6.2,
  an "everyone sees everyone's number" affordance in the header, and the
  >9-member banner when applicable.
- Contact page: a small "Group threads" card listing group_text threads whose
  roster contains the contact - read through a BOUNDED group_open-partition pager
  with a `truncated` flag the card MUST surface (relay's bounded-reader
  discipline, conversationsRepo.ts:552-561; there is no member->thread
  index and this spec does not add one), linking into the thread view.
- Placement/Today/timeline surfaces: v1 treats group threads as
  inbox+thread-view only; the plan enumerates every `!== 'relay_group'`
  reader (the r1-b finding-15 list is the starting inventory) and states
  each one's group_text handling. For PARTICIPANTS-MATCHING readers
  (usePlacementChannels-style: they match a contact against
  `participants[]`, and a group roster matches up to nine contacts at once)
  explicit exclusion is the ONLY correct handling, not a preference (r4
  finding 8).
- Accessibility-first selectors; UI quality bar applies.

## 12. Testing and verification

- Unit: golden-vector id tests for BOTH `conversationIdForGroup` AND
  `contactIdForPhone` (runtime code now depends on the uuidv5 NAMESPACE
  through both - r3 finding 14); envelope parser shapes (indexed, gap,
  single, absent); exclusion-set application + boot validation +
  fingerprint; importer type-guard INCLUDING the concurrent
  conditional-write case; retract guard; conversion refusal paths (both
  parity directions, import_connect_requested); the case-(c)
  unconverted-thread branch; receipts mapping/idempotency + system-marker
  write + staleness-check job; group STOP consent scoping (sender 1:1
  flagged lazily, group thread NOT, no phantom 1:1 on plain inbound or
  HELP); stub-capture-without-consent + origin marker; extraction
  suppression on tripwire-filed messages; 5.3(c) auto-convert (files as
  group, WARN not ERROR, alarm cardinality bounded) + corrupt-shape branch.
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

1. A group-origin inbound is never filed as a 1:1. Exactly THREE
   exceptions, all alarmed/marked and extraction-suppressed: the fail-open
   tripwire path, the corrupt-shape branch of 5.3(c), and the
   collapsed-roster (<2 outside members) rule of section 5 - which files
   1:1 because it semantically IS 1:1, but still carries the extraction
   marker since the body may reference other parties.
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

- Dev + prod, in order: `GROUP_IDENTITY_EXCLUDED_NUMBERS` env values set (from the import plan's
  `ownNumbers`; BEFORE detection deploys - identity depends on it), deploy,
  Conversations default-service webhook config (receipts URL),
  account-global Conversations webhook config (cross-check URL), support
  ticket (8), reseed where applicable. (No schema change: v6 removed the
  GSI - group threads use the existing byLastActivity 'group_open'
  partition.)
- Migration run (import mission) invokes the conversion bulk entry point
  (converts + creates rails + reports; connect_day_one-flagged rows
  surfaced in the report). CUTOVER INVARIANT (hardened per external review
  finding 3): every retained imported group is converted AND has an ACTIVE
  Twilio rail with a VERIFIED full participant/MB map - or is explicitly
  deleted/adjudicated (documented inbound-only with founder awareness).
  Zero UNRESOLVED rail failures is a hard gate; the runbook checklist also
  verifies zero remaining `relay_group#connecting` rows. PREFLIGHT: before
  the migration window, a production capability check (create+delete one
  test group conversation on the prod account) and a SIGNED WEBHOOK CANARY
  against the exact configured receipts + cross-check URLs. COST NOTE:
  Twilio counts users assigned to conversations as active - the imported
  rosters plausibly exceed the 200-user free tier (order $10-20/month;
  budgeted, not discovered). ROLLBACK CONTRACT (RUNBOOK): conversion is
  forward-only; a code rollback leaves group_text rows UI-orphaned until
  redeploy - remedy is roll-forward, documented.
- Cutover continuity: imported groups continue on the ported number because
  identity is the shared roster + exclusion set; handset threads merge by
  participant set (spike, odds-and-ends). ensureGroupRail covers any group
  still rail-less at cutover per the hardened invariant; historically-worded
  creates its rail.
- MMS-enabled campaign approval precedes real outbound (Cameron's gate).
- Follow-up issues filed by this spec: `twilio-standard-optout-double-reply`,
  `group-mms-including-pool-numbers`, outbound group media, and (if naming
  Option B is chosen) the post-cutover relay-label rename.


## 15. Delta-2 amendments (external review round 2 - AUTHORITATIVE over
earlier sections where they conflict)

1. Cross-check input filter: the events endpoint processes ONLY
   carrier-sourced inbound (`Source === 'SMS'` AND author is an external
   member address); API/SDK-sourced events are counted and ignored. Our
   outbound posts do NOT set X-Twilio-Webhook-Enabled (spike A3/F3:
   delivery receipts flow without it; the header would only add our own
   onMessageAdded echoes).
2. Receipts pipeline: (a) an unknown IMxx is parked briefly and re-tried
   (bounded) before the drop+counter - a receipt can beat the message
   append; (b) status transitions write CHILD FIELDS (status, errorCode,
   deliveredAt) under the prior-status condition, never a whole-slot
   replace, so the targeted sid write cannot be clobbered (concurrent
   same-member test required); (c) each outbound message row SNAPSHOTS the
   CHxx + MB->member map at send time, so late receipts stay mappable
   across rail recreation; (d) send-intent semantics are PARITY with
   existing 1:1/relay sends (no exactly-once guarantee exists anywhere in
   the app; a lost response + staff re-click can duplicate on every path)
   - follow-up issue `exactly-once-send-intent` filed, out of scope.
3. Rail creation: ONE authoritative `ensureGroupRail` service used by
   detection, migration, and send-time recovery. The claim carries an
   OWNER TOKEN + generation; finalize (writing CHxx/map) is CONDITIONAL on
   still owning the claim, so an expired claimant cannot overwrite a new
   claimant's rail. Additionally, ANY group inbound filed onto a thread
   with no active rail (re-)enqueues ensureGroupRail (idempotent) -
   closing the create->enqueue crash window. Tests: fencing takeover,
   crash-after-create/before-enqueue.
4. Migration convergence: the bulk runner CONVERGES every expected
   imported id to the full end-state (type group_text + every member
   `group_participation_at` stamp + active CH + verified MB map) on EVERY
   run - "already-converted" never skips the remaining steps. Conversion's
   type transition is the conditional-write + loser-reread form with a
   concurrent test (bulk vs inbound auto-convert race). The retract
   contact delete is CONDITIONED on
   `attribute_not_exists(group_participation_at)` (atomic guard replacing
   read-then-delete).
5. Due-discovery without a GSI: cross-check pending events and (if
   addendum (b) requires it) parked classic DLRs live in ONE queryable
   synthetic partition with deadline-prefixed sort keys, plus the
   point-readable per-IM dedupe marker; the T6.3 poller Queries the
   deadline range - never a table scan. TTL is cleanup only, NEVER the
   alarm mechanism; expiry-overdue items alarm from the sweep.
6. Member keys for group_text delivery/attribution are PHONE-SCOPED
   (`phone#<E164>`), with contactId carried as metadata for display -
   `relayMemberKey`'s contactId preference would collapse two numbers of
   one contact into one slot (test: one contact, two member numbers).
7. Group sends refuse when any member's contact is soft-DELETED (parity
   with sendMessage's fence), naming the member; the thread view surfaces
   the state.
8. A 21610 receipt performs idempotent, number-scoped suppression
   bookkeeping + audit (the spec 4.4 promise; the syssid marker suppresses
   the classic path that would otherwise have done it). Test: receipt-only
   suppression then START restoration.
9. The per-send staleness alarm fires when ANY slot is non-terminal past
   the deadline (the seeded map is never empty, so an empty-map condition
   would be dead code).
10. The nav badge group read follows the SAME accepted full-partition-walk
    contract as section 4.2 (no O(BADGE_LIMIT) claim).
