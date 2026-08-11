# Native group texting - implementation plan (v7)

Spec: `../specs/2026-08-10-group-texting-design.md` (v8 + inline
amendments). Branch `feat/group-texting`, worktree `W:\tmp\group-texting`.
Cutover 2026-08-17. Review trail (3 internal plan rounds + 3 external
review rounds, all adjudicated and folded INLINE here - no override
sections): `.superpowers/design-review/adjudications.md`.

RULES OF THE BUILD (AGENTS.md + spec; for a zero-context builder):

- TDD per slice: red test first. Every task names its tests.
- Gates after each slice, bare, from the worktree: `npm run typecheck`,
  `npm test`; FULL `npm run e2e` at the S1 and S8 checkpoints and at the
  end (hard outer `timeout 1500`). Never pipe gates.
- ASCII-only added lines. Commit per slice, explicit pathspecs,
  Co-Authored-By trailer, bare `git status` first (separate command).
- Vendor SDK calls only in `app/src/adapters`. Jobs via `jobs.enqueue()` /
  `defineJobHandler()`. Middleware order preserved. Message catalog rules.
- All paths repo-relative. NO schema changes anywhere in this plan.
- SLICE ORDER IS LOAD-BEARING: S1 rename, S2 identity+config, S7 import
  guards + conversion, S3 detection, S4 dashboard, S5-PRE spike addendum,
  S5 outbound, S6 guardrail jobs + wiring, S8 fake+seeds+e2e, S9 live QA +
  docs. The S3->S4 boundary is NOT a safe stopping point (threads persist
  with no UI until S4) - note in ledger, do not pause there.
- Execute tasks within a slice in dependency order, not numeric order.

## S1 - Relay label rename (spec 3) [FULL-E2E CHECKPOINT]

T1.1 ENUMERATED staff-surface rename to "Relay group" (authoritative
  inventory; T1.5's audit catches strays):
  - dashboard/src/routes/inbox/InboxRow.tsx:47-49 chip + InboxRow.test.tsx:88
  - dashboard/src/routes/conversation/ConversationDetail.tsx:374,384 header
    + :379 identityFacts fallback
  - dashboard/src/routes/contact/GroupTextsCard.tsx (title + :33 fallback)
  - dashboard/src/routes/conversation/RelayCloseAskDialog.tsx copy
  - app/src/routes/inbox.ts:512-557 relayRowFor label precedence chain
  - dashboard/src/routes/today/buildToday.ts:61-67 relay label; Today.tsx
    :126-127,187-188 close-nag rows + h2/aria-label
  - dashboard/src/routes/shared/PeopleCard.tsx :89-90,102,373,444,578
  - dashboard/src/routes/placements/PlacementConversation.tsx :124 tab +
    :206-243
  - dashboard/src/routes/tours/TourDetail.tsx :274,356,398,747,749
  - dashboard/src/routes/settings/NumbersSection.tsx :226,244,273
    ("Group text numbers" -> "Relay group numbers")
  - dashboard/src/routes/contact/Timeline.tsx relay copy (:303-314 + any
    relay-labeled affordances)
  - fake-twilio/web/src/ui/RosterRail.tsx:4 + its .test.tsx
  Component tests updated red-first.
T1.2 Member-facing fragment app/src/jobs/relayFanOut.ts:224-227: the
  `{joined}` VAR becomes EXACTLY `` `${who} joined this group chat.` ``
  ("group chat" matches catalog.ts:253-260 member-facing vocabulary).
  This is an interpolated VAR, not catalog body - operator overrides of
  relay.member_added keep working; record in the slice report.
T1.3 documentation/GLOSSARY.md: relay entries updated; ADD the native
  "Group text" entry (unmasked, business-number, everyone-sees-everyone).
T1.4 e2e sweep: all "group text" assertions under e2e/ (~88) +
  e2e/support/selectors.md.
T1.5 EXIT AUDIT: `grep -rni "group text" app/src dashboard/src fake-twilio
  e2e` -> adjudication table in the slice report (GENERIC / new-native /
  defect); zero unadjudicated hits is the exit criterion.
CHECKPOINT: typecheck + npm test + FULL npm run e2e. Commit.

## S2 - Identity, type, config (spec 4.1, 4.2)

T2.1 app/src/repos/conversationsRepo.ts: `'group_text'` in ConversationType
  (:39); fields `twilio_conversation_sid?`, `twilio_participant_map?`
  (MBxx->memberKey), `rail_creating?` (claim {token, at} - consumed by
  T6.1). `touchLastActivity` REPO-LEVEL PARTITION GUARD: the status write
  carries ConditionExpression `attribute_exists(conversationId) AND
  (attribute_not_exists(#type) OR #type <> :groupText)`; on
  ConditionalCheckFailedException retry WITHOUT the status clause but WITH
  `attribute_exists(conversationId)` and the same ReturnValues 'ALL_NEW'.
  Every call site - including the outbound send path api.ts:1501 - is safe
  automatically. Tests: group thread's status survives any touch; typed
  and legacy type-less 1:1 rows keep today's semantics; missing-row CCFE
  surfaces (no phantom upsert). WRITER-SWEEP note (verified in review):
  the other three status writers are self-guarded by preconditions a
  group_open row cannot meet - record in the T2.6 table. New methods:
  `createGroupTextThread(...)` (conditional create; status 'group_open'),
  `listGroupTexts({cursor,limit})` (byLastActivity Query on the
  'group_open' partition, newest-first; query error -> ERROR + THROW,
  never best-effort empty; tagged cursor + truncated flag),
  `setTwilioConversation(convId, chxx, map, claimToken)` (CONDITIONAL on
  still owning the rail_creating claim - T6.1 fencing). Unit tests incl.
  loud-error, pagination, conditional finalize.
T2.2 Type mirrors: dashboard/src/api/types.ts:408 union + :2558 inbox row
  kind union + server row-kind union app/src/routes/inbox.ts:73 gain
  'group_text'. Compile-visible sites; SILENT sites ruled in T4.5.
T2.3 app/src/services/groupIdentity.ts: `groupIdentity(from, others)` ->
  {roster, conversationId}: normalizes EVERY input via the importer's
  `normalizeToE164`, applies the exclusion set (business number + cached
  pool list + env list), derives id via `conversationIdForGroup`. Golden
  vectors for `conversationIdForGroup` AND `contactIdForPhone`;
  normalization-variant parser tests.
T2.4 app/src/lib/config.ts: `GROUP_IDENTITY_EXCLUDED_NUMBERS` three-tier
  validation + `none` sentinel (spec 4.1); env templates updated with the
  immutability warning. Unit tests per tier.
T2.5 Fingerprint (deployed envs only): settings record
  `group_identity_fingerprint`. FIRST-WRITE RACE: creation is a
  CONDITIONAL create (attribute_not_exists) - the existing settings
  writer is an unconditional upsert (settingsRepo.ts:172), do NOT use it
  here; the conditional loser re-reads and COMPARES; mismatch THROWS.
  Tests: unit with fake settings AND a DynamoDB Local test with two
  concurrent unequal fingerprints (exactly one wins; the other throws).
T2.6 STATUS-LITERAL SWEEP: grep app/src + dashboard/src for status
  comparisons vs 'open'/'connecting'/'closed' -> per-site ruling table in
  the slice report (+ the T2.1 writer-sweep result); tests where behavior
  changes. Known intended effects to confirm: inboundEmail not1to1 (group
  excluded), api.ts:1562 'open' page (excluded), today.ts:514 (excluded),
  relay displays (unaffected), passesFilter (inbox.ts:355-366): explicit
  'groups' case + rulings for group rows under 'unknown'/needsTriage
  (groups EXCLUDED from unknown-triage).
Gates; commit.

## S7 - Import guards + conversion core (spec 9) [BEFORE S3 - no stubs]

T7.1 app/src/lib/import/apply.ts `upsertConversation` group path:
  conditional-write + reduced-retry (ConditionExpression
  `attribute_not_exists(#type) OR #type <> :groupText`; on CCFE retry with
  a reduced expression skipping relay_status, participants,
  import_connect_requested, imported_from, imported_at). The function's
  SECOND write (:736-750 guarded last_activity_at advance) touches ONLY
  last_activity_at - safe; note the re-run partition-reorder effect in the
  slice report. Tests: simulated-CCFE concurrent case + local-dynamo
  integration (detected thread survives re-run byte-identical on protected
  fields).
T7.2 `retractImported` contact delete: ATOMIC guard - the DeleteCommand
  gains ConditionExpression `attribute_not_exists(group_participation_at)`
  (closes the read-then-delete race against live detection), preceded by
  the origin-marker/roster report walk (ONE full-pagination pass of the
  group_open partition building a contactId Set, consulted per
  candidate). CCFE -> report skip reason. Tests: both refusal paths, the
  race (field written between read and delete), clean delete.
T7.3 app/src/services/groupConvert.ts
  `convertConnectingRelayGroupToGroupText(conversationId, opts)`:
  preconditions (relay_group + connecting + no pool_number; the single
  connect-flag field `import_connect_requested` does NOT refuse - it is
  reported in the result). The type transition is a CONDITIONAL WRITE
  with loser-reread - a concurrent bulk-vs-inbound-auto-convert test is
  REQUIRED. Rewrite: type group_text, status 'group_open', roster
  contactId backfill via contactIdForPhone, member contacts stamped
  `group_participation_at` where absent (consent_method NEVER touched),
  relay-only fields removed. Parity is checked ONLY by the bulk entry
  (T7.4); the core skips it when called without ownNumbers (the runtime
  inline path). Tests: converts / already-converted (short-circuits the
  TRANSITION only, never convergence - T7.4) / refuses open relay /
  refuses pool_number / flag reported / backfill / stamps; crash tests
  after each durable step.
T7.4 Bulk entry point (script per import convention): receives ownNumbers;
  EITHER-DIRECTION set-equality parity check vs the runtime exclusion set
  BEFORE anything (refuse all on mismatch). Then CONVERGES every expected
  imported id to the FULL END-STATE ON EVERY RUN - type group_text +
  every member group_participation_at stamp + ACTIVE rail + VERIFIED MB
  map - regardless of whether the type transition happened on this run
  ("already-converted" never skips stamps/rail/map). The rail step calls
  the S6 `ensureGroupRail` service SYNCHRONOUSLY per row (named injection
  point wired by T6.6(c); per-row 50407-class outcomes land in the
  report). Per-row results feed the HARDENED CUTOVER INVARIANT (spec 14).
  Tests: fixture set incl. rerun-after-partial-failure convergence
  (conversion succeeded, stamping or rail failed, rerun completes the
  rest).
Gates; commit.

## S3 - Inbound detection (spec 5, 4.4)

T3.1 Envelope parser `parseOtherRecipients(params)`: indexed 0..N,
  gap-tolerant, single unindexed form. Unit tests all shapes + absent.
T3.2 Branch insertion AFTER echo + pool branches, BEFORE the 1:1 pipeline;
  envelope-less inbound takes the 1:1 path with an UNCHANGED repo-call
  sequence (spy-based test).
T3.3 Group filing: groupIdentity() (WARN+metric on a pool number in the
  outside roster). MINIMUM ROSTER: <2 outside members after exclusion ->
  file into the sender's 1:1 + WARN + extraction marker (semantically a
  1:1; the body may reference other parties). Resolve cases:
  (a) not found -> create (T3.4);
  (b) found group_text -> file into it; AND if the thread has no active
      rail, (re-)enqueue groupRail.ensure (idempotent - closes the
      create->enqueue crash window);
  (c) found relay_group + connecting + no pool_number -> auto-convert
      inline via T7.3 (no ownNumbers), file as group, WARN metric;
  corrupt shape -> sender 1:1 + ERROR + extraction marker.
  Persist with the phone-scoped sender key (T3.4a); sid-pointer dedupe;
  unread; touchLastActivity (repo guard, no special parameters);
  ingestion updates `group_railed_inbound_last_at` when the thread is
  railed. SSE.
T3.4 Contact stubs + roster: contactIdForPhone ids + origin marker + the
  DISTINCT-FIELD basis `group_participation_at` (spec 5: NEVER
  consent_method - that field feeds hasSmsConsent's consumers
  (broadcastFanOut, placementNudges, tourReminders, both has-consent
  displays) and would make silent members proactively sendable; the
  distinct field leaves every consumer untouched and cannot mask a later
  genuine basis). Existing contacts gain the field when absent. NO
  per-call-site consent patches (smsCompliance single-predicate rule).
  Tests: group_participation_at PRESENT + consent_method ABSENT +
  broadcast/nudge/reminder/has-consent all still refuse or show false for
  a silent member; a later genuine inbound_text stamp lands normally;
  group send accepts the field. participants written once conditional;
  race-loser re-reads.
T3.4a MEMBER KEYS: group_text delivery + sender-attribution keys are
  PHONE-SCOPED (`phone#<E164>`), contactId carried as display metadata -
  relayMemberKey's contactId preference (messagesRepo.ts:150) would
  collapse two numbers of one contact into one slot. Test: one contact
  owning two member numbers gets two slots + distinct attribution.
T3.5 Consent/keywords (spec 4.4): shared seam refactor - contact-level
  plain-inbound stamp callable WITHOUT a conversation; the sender's 1:1
  materialized ONLY on opt-out/opt-in keywords (NOT HELP - the
  phantom-thread regression); reply usage suppressed; audit carries group
  context. NUMBER-SCOPED SUPPRESSION SEAM: one shared reader/writer
  module over the existing storage semantics - the contact-level flag for
  a contact's PRIMARY number, the number's own 1:1 conversation flag for
  SECONDARY numbers (the twilio.ts:664-671 precedent) - used by STOP,
  START, 21610 receipts (T5.3), and the roster chips (T4.3). Tests:
  4-case keyword matrix (created-conversation count 0 for plain/HELP) + a
  contact with primary AND secondary member numbers suppressed and
  restored independently. Sender touchPhoneLastSeen runs as on a 1:1.
T3.6 Media: the group branch calls the shared `mirrorInboundMedia`
  (twilio.ts:317-363) under the group conversationId. Unit test with
  MediaUrl params.
T3.7 Tripwire: MM + NumMedia=0 + no envelope -> file 1:1 with the
  extraction marker + rate-limited WARN `group-envelope-missing` +
  metric. app/src/jobs/extraction.ts transcript builder FILTERS
  marker-carrying messages out of EVERY window (:409 read path) - not
  just the trigger (which already excludes non-1:1 types; assert anyway).
  Red-first transcript-exclusion test.
T3.8 SSE: events.ts:87-104 builder gains a group_text branch (status +
  members); relay payload byte-identical (snapshot test).
Gates; commit. (Proceed directly to S4.)

## S4 - Dashboard read surfaces (spec 11, 3)

T4.0 Renderer extraction (own task): extract `relaySenderLabel`
  (dashboard/src/routes/contact/Timeline.tsx:286, module-private) and the
  presence-based per-member delivery renderers (Timeline.tsx:489-507)
  into shared modules; Timeline.tsx consumes the extracted versions
  (snapshot tests pin unchanged relay rendering).
T4.1 Server inbox third source (app/src/routes/inbox.ts): merge top-50
  from listGroupTexts into page one with relay-style `truncated`
  surfacing ("Showing latest 50 group texts - view all", NO exact
  total); row kind 'group_text' (:73), roster-derived title, unread
  count; `filter=groups` in InboxFilter (:69) + allowlist (:127-134,
  :702-712) + the T2.6 passesFilter case; the groups filter pages ONLY
  the group partition (contact pager off); NAMESPACED cursor tag, server
  400 on tag/filter mismatch, client drops the cursor on filter switch.
  UNREAD: under `filter=unread` the group source returns all unread group
  threads via the ACCEPTED FULL-PARTITION-WALK contract (spec 4.2) - the
  SAME contract the nav badge group read uses (no bounded-work claim
  anywhere; the walk IS the contract, documented with the >500-thread
  growth threshold). Unit tests: row shape, filters, cursor 400,
  truncation, unread walk.
T4.2 Dashboard inbox: types.ts:2548 InboxFilter union;
  inboxFilters.ts:12-16 tab ("Groups") + :19 emptyCopy; Inbox.tsx state;
  useInbox.ts:54 rowKey ('g:'+conversationId), :185-196 markRead group
  branch, InboxRow.tsx:31,34 deep link + "Group text" chip; UnreadContext
  badge includes group unread per the full-walk contract. Component tests
  per site.
T4.3 GroupTextView + read path: api.ts group_text branches on the header
  (:1575), messages (:1589), mark-read (:1789); new useGroupThread hook
  (modeled on useRelayThread incl. SSE refetch); GroupTextView renders:
  member panel with suppression chips READ THROUGH THE NUMBER-SCOPED
  SUPPRESSION SEAM (T3.5: contact flag for a primary number, the number's
  1:1 flag for a secondary - NEVER contact opt-out alone), sender chips +
  per-member delivery chips via the T4.0 extracted renderers
  (phone-scoped keys, T3.4a), unmasked-affordance header, >9 banner +
  member 1:1 links, DELETED-member state surfaced (T5.2 fence), composer
  (wired in S5). ConversationDetail.tsx:132-146 becomes a three-way
  branch. Component tests incl. the secondary-number suppression chip.
T4.4 Contact page "Group threads" card: bounded listGroupTexts read +
  roster filter, truncated flag surfaced, links to thread. Tests.
T4.5 READER/SENDER SWEEP - every site gets an explicit ruling; tests
  where behavior changes:
  READERS:
  - inbox.ts:309 contact unread SUM - unreachable (no participant
    phone/email keys); comment only.
  - inbox.ts:374-401 rowForConversation - unreachable by construction
    (group_open is not in the 'open' partition); comment only.
  - contactTimeline.ts:839 + contacts.ts:1164 - unreachable (same);
    comments.
  - usePlacementChannels.ts:117 AND useTourChannels.ts:116
    (byte-identical twins) - exclude group_text explicitly; tests.
  - useContactTimeline.ts:161-163 fallback - type guard + test (defense
    in depth; /api/conversations?status=open never returns group_open).
  - buildToday.ts: :61-67 label (compile); :130-135 ONE_TO_ONE Set -
    group NOT added; RULING: group threads are EXCLUDED from Today
    entirely (intake filter + test); :107-110 participantContactId
    unreachable after the filter (comment).
  - today.ts:514 unaffected by construction (comment); :524 + :593-596
    allowlists - group falls out, deliberate (comments).
  - api.ts:1562 - excluded by construction (comment).
  - twilio.ts:1447-1451 sms_unreachable - the pre-marker window can reach
    it for group SMxx; degradation logs once per sid; test.
  - relayGroups.ts:164,305,382,530 - positive guards already 404; audit
    comments.
  - contactThreads.ts - documented not-returned (the contact card is the
    group surface).
  SENDERS/MUTATORS:
  - sendMessage.ts:255-257 - explicit group_text refusal (own error, not
    relay's) + test. Its :275-area deleted-contact fence and :284-area
    consent gate remain 1:1 reads (group parity lives in T5.2) - comment.
  - sendEmailMessage.ts:351 - REAL HOLE: a group passes the relay guard
    and rosterHasContact matches members; add group_text refusal + test.
  - inboundEmail.ts:803 - excluded via status by construction; add the
    explicit type check anyway + test.
  - relayFanOut.ts:335-353 - pin the no-pool_number refusal with a test.
  - relayAnnouncements.ts:77,146; tourReminders.ts:873;
    relayNumberReady.ts:95 - ruling comments (+ tests where reachable).
  - dev.ts:667-672 replay-intros - relay-scoped via listRelayGroups;
    comment.
Gates; commit.

## S5-PRE - Spike addendum (Cameron-assisted; BEFORE any S5/S6 code)

T5.0 Run addendum items (a) webhook scope precedence and (b) classic
  status callbacks for Conversations sends, on the dev account using the
  spike scripts (`.superpowers/spike/scripts/`), snapshot/restore
  discipline; ~10 minutes of Cameron's handset time. Write results into
  the spec addendum section (commit). OUTCOMES GATE:
  - (a) both scopes deliver -> guardrail 2 proceeds; global silenced ->
    STOP, escalate to Cameron (guardrail redesign).
  - (b) callbacks absent -> T5.3 drops the marker write AND the
    parked-DLR path entirely; present -> T5.3 keeps both as specified.

## S5 - Outbound (spec 6, 7)

T5.1 app/src/adapters/groupConversations.ts implementing
  groupConversationsPort: createConversationWithParticipants (pinned
  MessagingServiceSid, unattached projected business number, member
  addresses, deterministic non-PII `UniqueName` = our conversationId;
  ConversationWithParticipants for 3-10 total, individual-add fallback),
  fetchByUniqueName, postGroupMessage (Author = the business number; NO
  X-Twilio-Webhook-Enabled header - receipts flow without it (spike
  A3/F3), and the header would add our own onMessageAdded echoes to the
  cross-check), fetchParticipants. Wiring: the SAME
  `createRedirectingHttpClient` + `config.twilioApiBaseUrl` seam as
  messaging.ts:561-569 (hermetic lanes hit fake-twilio); CONSOLE driver =
  logging no-op (threads stay rail-less); the SMS kill-switch enforced
  inside the adapter. Unit tests incl. kill-switch + console.
T5.2 app/src/services/groupSend.ts refusal checks, in order: >9 members
  (banner error); ANY member contact soft-DELETED (parity with
  sendMessage.ts:275; the error names the member; GroupTextView shows
  the state); ANY member lacking consent_method OR group_participation_at
  (names the member; unreachable once stamping lands - the test
  constructs the gap via a direct repo write and is labeled
  defense-in-depth); rail missing -> ensureGroupRail (T6.1) inline. Send
  = postGroupMessage; the message APPEND writes, IN ONE TRANSACTION: the
  message row with the `delivery_recipients` parent map pre-seeded with
  'queued' PHONE-SCOPED slots (setRecipientDelivery is CHILD-only,
  messagesRepo.ts:1554-1565, and cannot seed a parent), the per-message
  CHxx + MB->memberKey SNAPSHOT (late receipts stay mappable across rail
  recreation), and the STALENESS DUE-ROW in the deadline partition (a
  separate post-append enqueue has a crash window; the T6.3 sweep owns
  detection - T6.4). Send-intent = documented parity with existing sends
  (issue exactly-once-send-intent). Audit. Unit matrix incl.
  consent-blocked + deleted-member + transactional-append assertions.
T5.3 Receipts endpoint POST /webhooks/twilio/conversations/receipts:
  X-Twilio-Signature validation. IMxx -> message row via provider sid.
  UNKNOWN IMxx: PARK, keyed by IMxx + ParticipantSid (one IM produces
  per-participant callbacks; forward-only coalescing WITHIN a parked
  slot), short TTL, retry-drained after append (bounded); only then
  drop + counter. Status application through
  `updateRecipientDeliveryStatus` (messagesRepo.ts:1577) MODIFIED to:
  (a) accept a sid PARAMETER (slot fields sid/errorCode already exist,
  :141-148 - no new fields); (b) write CHILD FIELDS (status, errorCode,
  deliveredAt, sid) under the prior-status ConditionExpression - NEVER a
  whole-slot replace, which clobbers concurrent sid writes (concurrent
  same-member test REQUIRED); (c) DROP unmapped Conversations statuses
  with WARN + counter via an explicit status-mapping table (an unmapped
  value TypeErrors at :1590 -> 500 -> Twilio retry loop); (d) take a
  context label so group log lines are group-labeled (relay lines
  byte-identical - snapshot test). A duplicate-status receipt keeps the
  sid via a targeted slot.sid-if-absent child write. 21610 receipts ALSO
  perform idempotent NUMBER-SCOPED suppression bookkeeping + audit
  through the T3.5 seam (the syssid marker suppresses the classic path
  that would otherwise have done it; test: receipt-only suppression then
  START restores). MBxx mapping resolves from the per-message SNAPSHOT
  first, thread map fallback; refresh on recreate; known-IM/unknown-MB =
  WARN + counter. First receipt per member writes the syssid marker WITH
  expires_at (~30d; putSystemSidMarker gains optional expiresAt;
  tables.ts:184-189 comment updated) - subject to T5.0(b); if classic
  callbacks fire, parked classic DLRs use the SAME deadline-partition
  parking (keyed IM+participant, forward-only coalescing, drained on
  marker write; overdue -> alarm from the T6.3 sweep; TTL is cleanup
  only, never the alarm). Aggregate derivation. Tests: delivered->sent
  rejected, failed->sent rejected, duplicate keeps sid + idempotent,
  unmapped dropped, park-and-drain (multi-recipient, out-of-order,
  receipt-before-append), 21610 bookkeeping, signature, relay log
  snapshot.
T5.4 API route: POST /conversations/:conversationId/messages
  (api.ts:1049) gains a group_text branch -> groupSend (relay + 1:1
  branches unchanged). Route test.
T5.5 Composer wiring in GroupTextView + per-member chips + the consent/
  deleted blockers surfaced. Component tests.
Gates; commit.

## S6 - Guardrail jobs + rail service + wiring (spec 8, 6.1)

T6.1 `ensureGroupRail` service - the ONE authoritative rail path
  (detection job, migration bulk, send-time recovery ALL route through
  it; NOTHING calls the adapter's create directly): conditional
  `rail_creating` claim carrying OWNER TOKEN + timestamp before any
  Twilio call (loser re-reads; a claim older than the expiry window is
  RE-CLAIMABLE); UniqueName create; fetch-by-UniqueName adopt-or-create
  recovery; post-active participant fetch + MB-map VALIDATION against
  the roster; finalize via `setTwilioConversation(..., claimToken)` -
  CONDITIONAL on still owning the claim, so an expired claimant cannot
  overwrite a new claimant's rail; failed/closed attach -> rail-failed
  record; other failure -> rail-less + WARN + report. Job wrapper
  defineJobHandler('groupRail.ensure'). Tests: concurrent double-create,
  crash-retry recovery, EXPIRED-claim takeover + fenced finalize,
  closed-rail, recreation race, MB-map mismatch,
  crash-after-create/before-enqueue (healed by T3.3(b)'s rail-less
  re-enqueue).
T6.2 Cross-check endpoint POST /webhooks/twilio/conversations/events:
  signature-validated; processes ONLY `Source === 'SMS'` events whose
  author is an external member address - API/SDK-sourced events are
  counted and ignored (our own posts must never alarm; the fake emits
  both kinds). PERSIST + DEDUPE by IM SID: a point-readable per-IM
  marker row PLUS an entry in ONE queryable synthetic DEADLINE PARTITION
  (deadline-prefixed sort keys - the messages table has no GSI, so
  due-discovery must be a partition Query, never a scan). Matched events
  are cleared at filing time; the T6.3 sweep queries the overdue range
  and alarms ONCE per still-unmatched event past the grace deadline
  ("conversation-bound inbound missing from classic webhook").
  Documented as a liveness HEURISTIC (no deterministic SM/MM join).
  Updates `group_crosscheck_last_event_at`. Tests: both delivery orders,
  duplicate redelivery, rapid same-author messages, genuine miss,
  API-source ignored.
T6.3 Periodic duties on the worker-poller pattern (worker.ts:263-418)
  with `__dev` tick endpoints, CADENCED via last-run-at due state (one
  action per elapsed period, never per 60s poll): the cross-check
  grace-deadline sweep (T6.2) + the "cross-check channel quiet" liveness
  WARN (railed classic inbound in 24h while zero events recorded) + the
  7-day zero-group-inbound heartbeat WARN + the send-staleness sweep
  (T6.4) + the parked-DLR overdue check (T5.3, if live). Fake-clock
  tests assert exactly-once-per-period; tick tests.
T6.4 Send staleness detection: the due-row written ATOMICALLY with the
  message append (T5.2) is consumed by the T6.3 sweep - ERROR when ANY
  recipient slot is still non-terminal past the deadline (the seeded map
  is never empty; an empty-map condition is dead code); cleared when all
  slots reach terminal states. `__dev` seam invokes the check directly
  for a message id. Tests: partial receipt loss alarms; fully-delivered
  clears; crash-anywhere-after-append is still monitored (the due-row is
  transactional with the append).
T6.5 RUNBOOK ops checklist (spec 14) written; Cameron-executed at merge/
  cutover.
T6.6 WIRING (explicit tasks; edits S3/S5/S7-committed files, each with
  tests + a re-run of the touched slices' test files): (a) T3.3
  detection enqueues groupRail.ensure at thread create AND on rail-less
  inbound; (b) T5.2's send path calls ensureGroupRail inline; (c)
  T7.4's bulk injection point calls ensureGroupRail synchronously per
  row, outcomes into the report; (d) T3.3 ingestion updates
  group_railed_inbound_last_at.
Gates; commit.

## S8 - Dev seams, fake Twilio, seeds, e2e (spec 12) [FULL-E2E CHECKPOINT]

T8.0 Log-assertion seam: dev-only in-memory WARN+ERROR ring buffer at GET
  /__dev/logtail (works in hermetic lanes because jobs run in-process
  with the app - index.ts:64-93; dev-only, so the deployed app/worker
  split is irrelevant). Unit test.
T8.1 fake-twilio: inbound group MMS injection (OtherRecipients indexed +
  multi + media); minimal Conversations surface (create with UniqueName /
  participants / post -> fan-out to fake phones + onDeliveryUpdated to
  the receipts route, emitting BOTH Source kinds for cross-check tests);
  21610 per-member simulation; fake-phones UI group-send seam.
T8.2 Seeds: full +2 group_text threads; app/src/lib/seed/live.ts +1 demo
  thread; lean +1 group_text and +1 connecting relay_group (conversion
  fixture). Verification: RUN the full e2e suite (it enumerates perturbed
  assertions) + targeted review of first-page/row-order/Today assertions.
T8.3 e2e specs (accessibility-first): (1) group MMS -> group thread,
  members visible, no 1:1 filing; silent members show
  group_participation_at PRESENT + consent_method ABSENT + proactive
  gates still refuse; (2) dashboard reply-all -> all fake phones one
  send, per-member delivered chips, logtail shows NO unknown-SID ERROR;
  (3) group STOP -> suppression chip (primary AND secondary-number
  cases) + sender-1:1 flag + group thread NOT suppressed + partial
  delivery + START restores; (4) tripwire injection -> filed 1:1 +
  logtail WARN + transcript exclusion; (5) conversion: bulk converges
  (incl. rerun-after-partial-failure) + inbound auto-convert (case c);
  (6) cross-check: matched quiet / injected miss ERROR / API-source
  ignored; (7) groups filter + pagination + mark-read + deep link +
  unread walk.
FULL GATES: typecheck + npm test + npm run e2e (known-flake re-run rule).
Commit.

## S9 - Live self-QA + docs (Cameron-assisted)

T9.1 Live self-QA on dev: detected group + reply-all on real handsets;
  group STOP counted to EXACTLY ONE confirmation; 3-outside-member group
  (OtherRecipients1+) + media-bearing group inbound (third US handset).
T9.2 Docs: RUNBOOK finalized - rollback/forward-only conversion contract;
  PRODUCTION PREFLIGHT: capability check (create+delete one test group
  conversation on the prod account) + SIGNED WEBHOOK CANARY against the
  exact configured receipts + cross-check URLs + a PRODUCTION-SERVICE
  KEYWORD CANARY (STOP/START/HELP auto-reply behavior verified on the
  prod messaging service with a test handset BEFORE outbound enablement -
  the app deliberately sends no keyword copy on group paths and relies on
  Twilio's replies); MAU cost note. A2P docs gain the
  group_participation basis paragraph. `npm run issues`; GLOSSARY
  verified; memory + handback per the profile.
T9.3 Editorial pass: version labels consistent; no stale lazy-send or
  Option-B remnants in spec/plan.
Final: ONE main sync (main has advanced - the import branch merged
@a03bd4e6; S7's apply.ts edits land on top via this sync; report
conflicts rather than improvising), full gates, handback report.

## Post-merge / cutover obligations (NOT built; spec 14)

Env var values (from import ownNumbers) BEFORE deploy; deploy;
Conversations service webhook (receipts) + account-global webhook
(cross-check) config; production preflight (capability + signed webhook
canary + keyword canary); migration run (bulk CONVERGENCE: every retained
group = converted + member stamps + ACTIVE rail + VERIFIED MB map, or
explicitly adjudicated; zero unresolved rail failures; zero remaining
connecting rows); Twilio support ticket; MMS campaign gate. No schema
ops. All Cameron-executed.

## Watch items for the builder

- S5-PRE outcomes can STOP the line; they need Cameron's handset (~10
  min). S9 needs his handsets + a third US number.
- Two known flakes (tour-reminders-panel, conversationdetail-members):
  re-run once before blaming the branch; report both runs.
- Never touch the live stack (:5174/:8080); hermetic lanes only;
  Playwright only through the e2e workspace.
- Execute tasks in dependency order within slices.
