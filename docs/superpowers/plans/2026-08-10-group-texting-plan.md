# Native group texting - implementation plan (v6, post plan reviews r1-r3 + external design review + delta round)

Spec: `../specs/2026-08-10-group-texting-design.md` (v8). Branch
`feat/group-texting`, worktree `W:\tmp\group-texting`. Cutover 2026-08-17.
Adjudications: `.superpowers/design-review/adjudications.md` (plan r1-r3
+ external review + delta sections).

RULES OF THE BUILD (AGENTS.md + spec; for a zero-context builder):

- TDD per slice: red test first. Every task names its tests.
- Gates after each slice, bare, from the worktree: `npm run typecheck`,
  `npm test`; FULL `npm run e2e` at S1 and S8 checkpoints and at the end
  (hard outer `timeout 1500`). Never pipe gates.
- ASCII-only added lines. Commit per slice, explicit pathspecs,
  Co-Authored-By trailer, bare `git status` first.
- Vendor SDK calls only in `app/src/adapters`. Jobs via `jobs.enqueue()` /
  `defineJobHandler()`. Middleware order preserved. Message catalog rules.
- All paths below are repo-relative from the worktree root.
- NO schema changes in this plan (spec v6: group threads use the EXISTING
  byLastActivity GSI's `group_open` partition).
- SLICE ORDER IS LOAD-BEARING: S1 rename, S2 identity+config, S7 import
  guards + conversion core (BEFORE detection - no stubs), S3 detection,
  S4 dashboard, S5-PRE spike addendum, S5 outbound, S6 guardrail jobs,
  S8 fake+seeds+e2e, S9 live QA+docs. S3->S4 boundary is NOT a safe
  stopping point (threads persist with no UI until S4); note it in the
  ledger, do not pause there.

## S1 - Relay label rename (spec 3) [FULL-E2E CHECKPOINT]

T1.1 ENUMERATED staff-surface rename to "Relay group" (this list is the
  authoritative inventory; the exit audit in T1.5 catches strays):
  - dashboard/src/routes/inbox/InboxRow.tsx:47-49 chip + InboxRow.test.tsx:88
  - dashboard/src/routes/conversation/ConversationDetail.tsx:374,384 header,
    and :379 identityFacts `|| 'Group text'` fallback
  - dashboard/src/routes/contact/GroupTextsCard.tsx (title, :33 groupLabel
    fallback; component/file name may stay)
  - dashboard/src/routes/conversation/RelayCloseAskDialog.tsx copy
  - app/src/routes/inbox.ts:512-557 relayRowFor label precedence chain
    (final fallback 'Group text' -> 'Relay group')
  - dashboard/src/routes/today/buildToday.ts:61-67 relay label; Today.tsx
    :126-127,187-188 close-nag rows + h2/aria-label "Group texts to close"
  - dashboard/src/routes/shared/PeopleCard.tsx :89-90,102,373,444,578
    (muted-member reasons, confirm title, literal label)
  - dashboard/src/routes/placements/PlacementConversation.tsx :124 tab label
    + :206-243 occurrences
  - dashboard/src/routes/tours/TourDetail.tsx :274,356,398,747,749 (dialog
    titles/labels)
  - dashboard/src/routes/settings/NumbersSection.tsx :226,244,273 heading
    "Group text numbers" -> "Relay group numbers"
  - dashboard/src/routes/contact/Timeline.tsx relay copy (":303-314 reply
    fan-out note" and any relay-labeled affordances)
  - fake-twilio/web/src/ui/RosterRail.tsx:4 + its .test.tsx
  Component tests named above updated red-first.
T1.2 Member-facing fragment app/src/jobs/relayFanOut.ts:224-227: the
  `{joined}` VAR becomes `` `${who} joined this group chat.` `` - EXACTLY
  that string ("group chat" matches the existing member-facing vocabulary
  in app/src/messages/catalog.ts:253-260, keeping member copy internally
  consistent). Note: this is an interpolated VAR, not catalog body text -
  existing operator overrides of relay.member_added keep working; record
  that in the slice report.
T1.3 documentation/GLOSSARY.md: relay entries ("Group text number" ->
  "Relay group number", :209-211 usage), ADD the native "Group text" entry
  (unmasked, business-number, everyone-sees-everyone).
T1.4 e2e sweep: all "group text" assertions under e2e/ (~88) +
  e2e/support/selectors.md, updated to the surfaces' new strings.
T1.5 EXIT AUDIT (objective): `grep -rni "group text" app/src dashboard/src
  fake-twilio e2e` and produce an adjudication table in the slice report -
  every remaining hit is either GENERIC (non-relay prose), the NEW native
  vocabulary (none yet in S1), or a defect to fix. Zero unadjudicated hits
  is the slice exit criterion.
CHECKPOINT: typecheck + npm test + FULL npm run e2e. Commit.

## S2 - Identity, type, config (spec 4.1, 4.2)

T2.1 app/src/repos/conversationsRepo.ts: `'group_text'` in ConversationType
  (:39); fields `twilio_conversation_sid?`, `twilio_participant_map?`
  (MBxx->memberKey record); `touchLastActivity` REPO-LEVEL PARTITION GUARD
  (plan-r2/r3): the status write carries ConditionExpression
  `attribute_exists(conversationId) AND (attribute_not_exists(#type) OR
  #type <> :groupText)` (r3: the bare `<>` form is FALSE on a type-less
  legacy row, and dropping the existence check on retry would upsert a
  phantom row); on ConditionalCheckFailedException retry WITHOUT the
  status clause but WITH `attribute_exists(conversationId)` and the same
  `ReturnValues: 'ALL_NEW'`. Every call site - including the outbound send
  path app/src/routes/api.ts:1501 - is safe automatically. Red-first test:
  a group thread's status survives touchLastActivity; 1:1 tests: typed and
  legacy type-less rows keep today's reopen semantics; missing-row CCFE
  still surfaces (no phantom upsert).
  WRITER SWEEP RESULT (r3, verified by review): touchLastActivity is the
  ONLY conversation-status writer reachable by a group thread; the other
  three status writers are self-guarded by preconditions a group_open row
  cannot meet - record this in the T2.6 ruling table. New methods:
  `createGroupTextThread(...)` (conditional create; status 'group_open'),
  `listGroupTexts({cursor,limit})` (byLastActivity Query, partition
  'group_open', newest-first; query error -> ERROR log + THROW, never
  best-effort empty; returns tagged cursor + truncated flag),
  `setTwilioConversation(convId, chxx, map)`. Unit tests incl. loud-error
  and pagination.
T2.2 dashboard/src/api/types.ts:408 union + :431 ConversationSummary
  passthrough notes + :2558 inbox row `kind` union AND the server row-kind
  union app/src/routes/inbox.ts:73 gain 'group_text'. Typecheck-visible
  sites compile; SILENT sites get explicit rulings + tests in T4.5.
T2.6 STATUS-LITERAL SWEEP (plan-r2: `status` is a bare string in both
  declarations, so 'group_open' is typecheck-invisible): grep app/src +
  dashboard/src for status comparisons against 'open'/'connecting'/
  'closed' (`status ===`, `!==`, switch cases, Query values) and produce a
  per-site ruling table in the slice report; add tests where a ruling
  changes behavior. Known intended effects to confirm: inboundEmail
  not1to1 (group excluded), api.ts:1562 'open' page (group excluded),
  today.ts:514 (excluded), relay status displays (unaffected). Include
  the WRITER sweep result from T2.1 in the same table. Also the silent
  filter site app/src/routes/inbox.ts:355-366 `passesFilter`: its
  `default` arm swallows unknown filters - add an explicit 'groups' case
  and rulings for group rows under 'unknown'/needsTriage (groups are
  EXCLUDED from the unknown-triage filter; they have no needsTriage).
T2.3 app/src/services/groupIdentity.ts: `groupIdentity(from, others)` ->
  { roster, conversationId } - normalizes EVERY input via the importer's
  `normalizeToE164`, applies the exclusion set (business number + cached
  pool list + env list), derives id via `conversationIdForGroup`. Golden
  vectors for `conversationIdForGroup` AND `contactIdForPhone` (pinned
  uuids); parser/normalization variant tests ((404) 982-4978 vs +1404...,
  etc.).
T2.4 app/src/lib/config.ts: `GROUP_IDENTITY_EXCLUDED_NUMBERS` three-tier
  validation + `none` sentinel (spec 4.1); env templates updated with the
  immutability warning. Unit tests per tier.
T2.5 Fingerprint (deployed envs only, THROW on mismatch): settings record
  `group_identity_fingerprint`; boot check. Unit test with fake settings.
Gates; commit.

## S7 - Import guards + conversion core (spec 9) [BEFORE S3 - no stubs]

T7.1 app/src/lib/import/apply.ts `upsertConversation` group path:
  conditional-write + reduced-retry (ConditionExpression
  `attribute_not_exists(#type) OR #type <> :groupText`; on CCFE retry with
  reduced expression skipping relay_status, participants,
  import_connect_requested, imported_from, imported_at). NOTE the function
  issues TWO writes - the main UpdateCommand (:723-731) and the guarded
  last_activity_at advance (:736-750, CCFE swallowed). The second write
  touches ONLY last_activity_at (verified plan-r2) - safe as-is; note in
  the slice report that a re-run can advance group threads'
  last_activity_at and thus reorder the group partition (accepted).
  Tests: unit incl. simulated-CCFE concurrent case +
  local-dynamo integration: detected thread survives re-run byte-identical
  on protected fields.
T7.2 `retractImported` (apply.ts:425-470): contact delete refuses when the
  contact carries the detection origin marker OR appears on any group_text
  roster - the roster check walks the ENTIRE group_open partition ONCE
  with full pagination, building a Set of roster contactIds consulted per
  retract candidate (plan-r3: never O(contacts x partition)); reports skip
  reason. Tests: both refusal paths +
  clean-delete case.
T7.3 app/src/services/groupConvert.ts
  `convertConnectingRelayGroupToGroupText(conversationId, opts)` per spec 9:
  preconditions (relay_group + connecting + no pool_number; flag does NOT
  refuse), rewrite (type, status 'group_open', roster contactId backfill
  via contactIdForPhone, relay-only fields removed), idempotent,
  result reports import_connect_requested when present. Rail creation is
  NOT here (the bulk runner's named injection point, wired by T6.6(c)). Tests: unit matrix (converts / already-converted /
  refuses open relay / refuses pool_number / flag reported / backfill).
T7.4 Bulk entry point (script per import-mission convention): receives
  ownNumbers, performs the EITHER-DIRECTION set-equality parity check
  against the runtime exclusion set BEFORE any conversion (refuse all on
  mismatch), converts each (stamping member consent bases per spec 9),
  stamps member `group_participation_at` (spec 9 distinct-field basis),
  and creates rails SYNCHRONOUSLY per converted row (plan-r2: per-row
  50407-class outcomes must land in the migration report). The rail step
  depends on S5's adapter, so T7.4 lands the conversion+parity+reporting
  skeleton with the rail step as a NAMED INJECTION POINT, wired by S6 task
  T6.6(c); per-row results feed the HARDENED CUTOVER INVARIANT (spec 14:
  converted + rail ACTIVE + MB map VERIFIED per retained group, or
  explicitly adjudicated; zero unresolved rail failures is a hard gate). Unit test over fixtures.
Gates; commit.

## S3 - Inbound detection (spec 5, 4.4)

T3.1 Envelope parser in app/src/routes/webhooks/twilio.ts:
  `parseOtherRecipients(params)` - indexed 0..N, gap-tolerant, single
  unindexed form. Unit tests all shapes + absent.
T3.2 Branch insertion AFTER echo + pool branches, BEFORE the 1:1 pipeline;
  envelope-less inbound takes the 1:1 path with an UNCHANGED repo-call
  sequence (spy-based unit test).
T3.3 Group filing: groupIdentity() (T2.3; WARN+metric when a POOL number
  appears in the outside roster); resolve cases (a) create / (b) file /
  (c) auto-convert via T7.3 called inline WITHOUT ownNumbers, then file as
  group, WARN metric / corrupt-shape -> file to sender 1:1 + ERROR +
  extraction marker. Persist with relay_sender_key = sender memberKey;
  sid-pointer dedupe; unread; touchLastActivity (the repo guard keeps the
  partition; no special parameters); SSE.
T3.4 Contact stubs: contactIdForPhone ids + origin marker + the
  DISTINCT-FIELD basis `group_participation_at` (delta finding 2/3: NEVER
  consent_method - that field feeds hasSmsConsent's nine consumers
  (broadcastFanOut, placementNudges, tourReminders, both has-consent
  displays, etc.) and would make silent members proactively sendable;
  the distinct field leaves every existing consumer untouched and cannot
  mask a later genuine basis). Existing contacts also gain the field when
  absent. NO per-call-site consent patches anywhere (smsCompliance.ts
  single-predicate rule). Tests: silent member NOT broadcastable/nudgable/
  reminder-able and shows no has-consent; group send accepts the field;
  a later genuine inbound_text stamp lands normally. participants written
  once conditional, race-loser re-reads.
T3.5 Consent/keywords (spec 4.4): shared seam refactor - contact-level
  plain-inbound stamp callable without a conversation; sender's 1:1
  materialized ONLY on opt-out/opt-in keywords (NOT HELP); reply usage
  suppressed; audit carries group context; contact flag + sender-1:1 flag
  on STOP; sender touchPhoneLastSeen. Tests: 4-case matrix asserting
  created-conversation COUNT (0 for plain/HELP) and flags.
T3.6 Media: group branch calls the shared `mirrorInboundMedia` (helper at
  twilio.ts:317-363) under the group conversationId - explicit task, unit
  test with MediaUrl params.
T3.7 Tripwire: MM + NumMedia=0 + no envelope -> file 1:1 with
  extraction-suppression marker + rate-limited WARN `group-envelope-missing`
  + metric. app/src/jobs/extraction.ts: transcript builder FILTERS
  marker-carrying messages out of every window (:409 read path) - not just
  the trigger. Trigger gate already excludes non-1:1 types
  (twilio.ts:1166-1169); assert with a test anyway. Tests: marker filter
  red-first (a marked message in a thread whose next 1:1 message triggers
  extraction never appears in the built transcript).
T3.8 SSE: app/src/lib/events.ts:87-104 builder gains group_text branch
  (status + members); relay payload byte-identical (snapshot test).
Gates; commit. (S3->S4 boundary: threads exist with no UI - proceed
directly to S4.)

## S4 - Dashboard read surfaces (spec 11, 3)

T4.1 Server inbox third source: app/src/routes/inbox.ts - merge top-50 from
  listGroupTexts into page one (truncated -> "Showing latest 50 group
  texts - view all" affordance data), row kind 'group_text' (server union
  :73), derived title from roster, unread count; `filter=groups` in
  InboxFilter (:69) + allowlist (:127-134, :702-712); groups filter pages
  ONLY the group partition (contact pager off), namespaced cursor tag,
  server 400 on tag/filter mismatch. UNREAD RULING (plan-r2/r3): under
  `filter=unread` the group source returns ALL unread group threads (paged
  partition walk); the dashboard nav unread badge (UnreadContext) includes
  group unread BOUNDED by the same existing BADGE_LIMIT convention the 1:1
  badge uses (bounded read + saturation display; per-SSE-event refetch
  stays O(BADGE_LIMIT), never an unbounded walk) - tests for both. Unit tests: row
  shape, filters, cursor 400, truncation flag.
T4.2 Dashboard inbox: dashboard/src/api/types.ts:2548 InboxFilter union;
  dashboard/src/routes/inbox/inboxFilters.ts:12-16 INBOX_FILTERS tab
  ("Groups") + :19 emptyCopy case; Inbox.tsx state; useInbox.ts:54 rowKey
  ('g:'+conversationId), :185-196 markRead group branch (conversation
  mark-read route), InboxRow.tsx:31,34 deep link to /conversations/:id for
  group_text + "Group text" chip. Component tests per site.
T4.0 Renderer extraction (real cross-file refactor, own task, plan-r2):
  extract `relaySenderLabel` (dashboard/src/routes/contact/Timeline.tsx:286,
  module-private) and the presence-based per-member delivery renderers
  (Timeline.tsx:489-507) into shared modules; Timeline.tsx consumes the
  extracted versions (snapshot tests pin unchanged relay rendering).
T4.3 GroupTextView + read path: api.ts group_text branches on the header
  (:1575), messages (:1589), mark-read (:1789) routes; new
  dashboard/src/routes/conversation/useGroupThread.ts (modeled on
  useRelayThread incl. SSE refetch); GroupTextView rendering per spec 11
  (member panel + suppression chips from contact opt-out, sender chips +
  per-member delivery chips via the T4.0 extracted shared renderers,
  header unmasked affordance,
  >9 banner + member 1:1 links, composer placeholder until S5).
  ConversationDetail.tsx:132-146 becomes a three-way branch. Component
  tests per element; accessibility-first selectors.
T4.4 Contact page "Group threads" card: bounded listGroupTexts read +
  client-side roster filter, truncated flag surfaced, links to thread.
  Component + route tests.
T4.5 READER/SENDER SWEEP - every site below gets an explicit ruling and,
  where behavior changes or an invariant is pinned, a test:
  READERS:
  - app/src/routes/inbox.ts:309 contact unread SUM - UNREACHABLE for
    group_text (conversationsForContact resolves by participant phone/email
    which groups lack) - DOCUMENT in code comment, no test possible.
  - app/src/routes/inbox.ts:374-401 rowForConversation - UNREACHABLE for
    group threads by construction (status='group_open' keeps them out of
    the 'open' partition the pager reads); DOCUMENT with a comment, no
    tautological test (plan-r2).
  - app/src/routes/contactTimeline.ts:839 + contacts.ts:1164 - unreachable
    by construction (same reason); comment only.
  - dashboard/src/routes/placements/usePlacementChannels.ts:117 AND
    dashboard/src/routes/tours/useTourChannels.ts:116 (byte-identical
    twins) - exclude group_text explicitly; tests.
  - dashboard/src/routes/contact/useContactTimeline.ts:161-163 fallback -
    add type guard excluding group_text (defense in depth; primary
    protection is that /api/conversations?status=open never returns
    group_open threads); test.
  - dashboard/src/routes/today/buildToday.ts - :61-67 label (compile),
    :130-135 ONE_TO_ONE Set ruling: group_text NOT added (not 1:1) ->
    :284 is1to1 false -> takes the conversation-ref branch; RULING: group
    threads are EXCLUDED from Today build entirely (filter at intake) -
    explicit filter + test; :107-110 participantContactId unreachable
    after the filter (comment).
  - app/src/routes/today.ts:514 read - unaffected by construction
    (group_open not in 'open' partition; comment); :524 + :593-596
    allowlists - group_text falls out; comment stating deliberate.
  - app/src/routes/api.ts:1562 GET /conversations - returns 'open'
    partition only; group threads excluded by construction; comment.
  - twilio.ts:1447-1451 sms_unreachable scope - pre-marker window can
    reach it for group SMxx; ensure degradation logs once per sid (bounded)
    - test.
  - app/src/routes/relayGroups.ts:164,305,382,530 - positive relay guards
    already 404 group_text; audit comment only.
  - app/src/lib/contactThreads.ts - document group threads intentionally
    not returned (the contact card is the group surface).
  SENDERS/MUTATORS (spec 6.2 assignment):
  - app/src/services/sendMessage.ts:255-257 - add explicit
    `type === 'group_text'` refusal (own error, not relay's) + test.
  - app/src/services/sendEmailMessage.ts:351 - REAL HOLE: group passes the
    relay guard and rosterHasContact matches members; add group_text
    refusal + test.
  - app/src/services/inboundEmail.ts:803 - `status !== 'open'` now
    excludes group_open threads by construction; add type to the not1to1
    predicate anyway (explicit) + test.
  - app/src/jobs/relayFanOut.ts:335-353 - gates on pool_number presence;
    pin with a test that a group_text thread (no pool_number) is refused.
  - app/src/services/relayAnnouncements.ts:77,146;
    app/src/jobs/tourReminders.ts:873; app/src/jobs/relayNumberReady.ts:95
    - each gets a stated ruling comment (+ test where a group thread could
    reach it).
  - app/src/routes/dev.ts:667-672 replay-intros - relay-scoped by
    listRelayGroups; comment.
Gates; commit.

## S5-PRE - Spike addendum (Cameron-assisted; BEFORE S5/S6 code)

T5.0 Run addendum items (a) scope precedence and (b) classic status
  callbacks for Conversations sends, on the dev account using the spike
  scripts pattern (`.superpowers/spike/scripts/`), snapshot/restore
  discipline as before; ~10 minutes of Cameron's handset time. Write
  results into the spec's addendum section (commit). OUTCOMES GATE:
  - (a) both scopes deliver -> guardrail 2 proceeds as specced; global
    silenced -> STOP, escalate to Cameron (guardrail redesign needed).
  - (b) callbacks absent -> T5.3 drops the marker write; present -> keep
    markers + measure the race in S8 e2e and resolve per spec 7.

## S5 - Outbound (spec 6, 7)

T5.1 app/src/adapters/groupConversations.ts implementing
  groupConversationsPort: createConversationWithParticipants (pinned
  MessagingServiceSid, unattached projected biz number, member addresses,
  deterministic non-PII `UniqueName` = our conversationId - the
  idempotency key; ConversationWithParticipants for 3-10 total,
  individual-add fallback), fetchByUniqueName (crash recovery),
  postGroupMessage (Author=biz), fetchParticipants. Wiring: the SAME
  `createRedirectingHttpClient` + `config.twilioApiBaseUrl` seam the
  messaging adapter uses (app/src/adapters/messaging.ts:561-569) so
  hermetic lanes hit fake-twilio; CONSOLE driver gets a logging no-op
  implementation (no Twilio calls, threads stay rail-less); SMS
  kill-switch enforced inside the adapter. Unit tests incl. kill-switch +
  console behavior.
T5.2 app/src/services/groupSend.ts: thread checks (>9 -> refuse with the
  banner error; ANY member without a recorded consent basis -> refuse
  naming the blocking member (group_participation qualifies; spec 6.2);
  rail missing -> create-on-send backstop through the T6.1 claimed
  sequence), persist with IMxx provider sid + the delivery_recipients
  parent map WRITTEN AT APPEND TIME with 'queued' slots (the api.ts:1452
  pattern - delta finding 1: setRecipientDelivery is CHILD-only and
  throws ValidationException when the parent is absent; it cannot seed),
  audit. Unit matrix incl. the consent-blocked case (unreachable by
  construction once stamping lands - the test constructs the gap via a
  direct repo write and is labeled defense-in-depth).
T5.3 Receipts endpoint POST /webhooks/twilio/conversations/receipts:
  X-Twilio-Signature; IMxx->row; MBxx->memberKey (map; refresh on
  recreate; known-IM/unknown-MB = WARN+counter);
  `updateRecipientDeliveryStatus` (forward-only guarded, messagesRepo.ts:
  1577) with THREE delta-round corrections: (a) the slot TYPE already has
  `sid?` and `errorCode?` (messagesRepo.ts:141-148) - the method gains a
  sid PARAMETER, no new field; (b) the sid on a duplicate-status receipt
  is applied via a SEPARATE targeted child write (slot.sid if-absent) so
  the status race guard is never weakened and the sid is never dropped;
  (c) a Conversations status with no ALLOWED_PRIOR mapping is DROPPED with
  WARN + counter (an unmapped value currently TypeErrors at :1590 -> 500
  -> Twilio retry loop) via an explicit status-mapping table. Group
  callers pass a context label so log lines are group-labeled (relay
  callers byte-identical - invariant 6). NEVER setRecipientDelivery for
  receipts. Required tests: delivered->sent rejected, failed->sent
  rejected, duplicate receipt keeps sid + stays idempotent, unmapped
  status dropped, relay log snapshot unchanged;
  first-receipt syssid marker WITH expires_at (~30d;
  app/src/repos/messagesRepo.ts putSystemSidMarker gains optional
  expiresAt; update the tables.ts:184-189 TTL comment) - subject to
  T5.0(b); aggregate derivation; unknown IMxx log+counter. Route unit
  tests (signature, idempotency, out-of-order, unknown, TTL).
T5.4 API route: POST /conversations/:conversationId/messages
  (app/src/routes/api.ts:1049) gains a group_text branch -> groupSend
  (relay branch :1110 and 1:1 else-branch unchanged). Route test.
T5.5 Composer wiring in GroupTextView + per-member chips. Component tests.
Gates; commit.

## S6 - Guardrail jobs + rail creation (spec 8, 6.1)

T6.1 Rail-create job defineJobHandler('groupRail.create'); callers are
  wired in T6.6 (detection enqueue, send backstop direct, bulk sync).
  LIFECYCLE (spec 6.1, external review finding 2 + delta finding 6):
  conditional local `rail_creating` claim CARRYING ITS TIMESTAMP before
  any Twilio call (loser re-reads; a claim older than the expiry window
  is RE-CLAIMABLE - the dead-claimant cell - and recovery then runs
  fetch-by-UniqueName adopt-or-create so a crashed claimant can never
  strand a thread against the hardened cutover gate); deterministic
  UniqueName; post-active MB-map validation before compose enables;
  failed/closed attach -> rail-failed record; failure otherwise ->
  rail-less + WARN + report. Tests: concurrent double-create, crash-retry
  recovery, EXPIRED-claim takeover, closed-rail, recreation race, MB-map
  mismatch.
T6.2 Cross-check endpoint POST /webhooks/twilio/conversations/events:
  signature; PERSIST + DEDUPE by IM SID - stored as messages-table marker
  rows (`imevt#<IMsid>` partition, short TTL; the existing syssid#/sid#
  marker pattern, NO schema change - delta finding 7); the GRACE-DEADLINE
  reconciliation sweep FOLDS INTO the T6.3 daily-poller mechanism as a
  cadenced duty with its own last-run state (no undeclared third job)
  and alarms ONCE per still-unmatched event past the deadline; documented
  as a liveness HEURISTIC (no deterministic SM/MM join in the payload).
  Tests: both delivery orders, duplicate redelivery, rapid same-author
  messages, genuine miss. Updates settings
  `group_crosscheck_last_event_at`;
  ingestion (T3.3) updates `group_railed_inbound_last_at`. Unit tests both
  directions.
T6.3 Periodic jobs, wired like the four existing worker pollers
  (app/src/worker.ts:263-418 pattern) EACH WITH a `__dev` tick endpoint
  (app/src/routes/dev.ts pattern). CADENCE MECHANISM (r3: the 60s poller
  interval is not the cadence - due state is): each job keeps a
  last-run-at settings record and the poller invocation returns
  immediately unless 24h (liveness sweep) / the heartbeat's evaluation
  interval has elapsed - one WARN per elapsed period, never per poll.
  Unit tests with fake clock assert exactly-once-per-period + tick tests.
T6.4 Per-send staleness check: jobs.enqueue runAt +600s (verified within
  JOBS_SQS_MAX_DELAY_SECONDS = 720, jobs.ts:47) -> ERROR if
  delivery_recipients still empty. The `__dev` seam INVOKES THE CHECK
  FUNCTION DIRECTLY for a given message id (plan-r2: a delayed enqueue has
  no due row to tick; the endpoint bypasses the timer, prod keeps the
  enqueue). Unit test + seam test.
T6.5 RUNBOOK ops checklist (spec 14) written; executed by Cameron at
  merge/cutover.
T6.6 WIRING TASKS (plan-r2: these edit S3/S5/S7-committed files - explicit
  tasks with tests, not parentheticals): (a) T3.3 thread-create enqueues
  groupRail.create; (b) T5.2 backstop calls the port directly; (c) T7.4's
  bulk-runner rail injection point calls the port synchronously per row
  and folds outcomes into the report; (d) T3.3 ingestion updates
  group_railed_inbound_last_at. Each with a unit test; re-run the touched
  slices' test files after wiring.
Gates; commit.

## S8 - Dev seams, fake Twilio, seeds, e2e (spec 12) [FULL-E2E CHECKPOINT]

T8.0 Log-assertion seam: dev-only in-memory ring buffer of WARN+ERROR
  structured lines exposed at GET /__dev/logtail (mounted with the other
  __dev routes; structurally absent in deployed envs). Works in hermetic
  lanes because jobs run IN-PROCESS with the app there (app/src/index.ts:
  64-93); the deployed app/worker split is irrelevant to a dev-only seam
  (plan-r2). Unit test.
T8.1 fake-twilio: inbound group MMS injection (OtherRecipients indexed +
  multi + media); minimal Conversations API surface (create conversation/
  participants, post message -> fan-out to fake phones + onDeliveryUpdated
  POST to the receipts route); 21610 per-member simulation for STOPped
  fake phones; fake-phones UI group-send seam (send a group text to the
  business number from the fake handset UI).
T8.2 Seeds: full profile +2 group_text threads; app/src/lib/seed/live.ts
  +1 group_text demo thread (invariant-8 surface, plan-r2); lean +1
  group_text and +1 connecting relay_group (conversion fixture). Verification method: RUN
  the full e2e suite - it is the enumerator of perturbed assertions - plus
  targeted review of first-page/row-order/Today assertions (the connecting
  row enters the relay inbox source; expect inbox-order effects).
T8.3 e2e specs (accessibility-first): (1) group MMS -> group thread,
  members visible, no 1:1 filing, no consent stamp for silent members;
  (2) dashboard reply-all -> all fake phones one group send, per-member
  delivered chips, /__dev/logtail shows NO unknown-SID ERROR; (3) group
  STOP -> suppression chip + sender-1:1 flag + group thread NOT
  suppressed + partial delivery + START restore; (4) tripwire injection ->
  filed 1:1 + logtail WARN line + extraction-transcript exclusion;
  (5) conversion: lean fixture converts (bulk path) AND auto-converts on
  inbound (case c); (6) cross-check: matched quiet / injected-miss ERROR
  via logtail; (7) groups inbox filter + pagination + mark-read + deep
  link.
FULL GATES: typecheck + npm test + npm run e2e (known-flake re-run rule).
Commit.

## S9 - Live self-QA + docs (Cameron-assisted)

T9.1 Live self-QA on dev: detected group + reply-all on real handsets;
  group STOP counted to EXACTLY ONE confirmation; 3-outside-member group
  (OtherRecipients1+) + media-bearing group inbound (third US handset).
T9.2 Docs: RUNBOOK finalized (incl. the rollback/forward-only conversion
  contract, production preflight + signed webhook canary steps, MAU cost
  note); A2P compliance docs gain the group_participation basis paragraph;
  `npm run issues`; GLOSSARY verified; memory + handback per the profile.
T9.3 Editorial pass: version labels consistent; no stale lazy-send or
  Option-B remnants anywhere in spec/plan (external review cleanup).
Final: ONE main sync (merge main into branch), full gates, handback report.

## Post-merge / cutover obligations (NOT built; spec 14)

Env var values (from import ownNumbers) BEFORE deploy, deploy,
Conversations service webhook (receipts URL) + account-global webhook
(cross-check URL) config, migration run (bulk convert + rails +
zero-connecting check per the run-to-completion guarantee), support
ticket, MMS campaign gate. All Cameron-executed. No schema ops.

## Watch items for the builder

- S5-PRE outcomes can STOP the line (scope-precedence failure) - do not
  proceed past them unresolved; they need Cameron's handset (~10 min).
- Task numbering within S2/S4 reflects insertion history, not execution
  order - execute in dependency order (T2.6's sweep after T2.1/T2.2 land
  the type; T4.0 before T4.3).
- apply.ts merge coordination: the unmerged import branch also edits it;
  keep S7 changes tightly scoped; Cameron sequences merges.
- Two known flakes (tour-reminders-panel, conversationdetail-members):
  re-run once before blaming the branch; report both runs.
- Never touch the live stack (:5174/:8080); hermetic lanes only.
- T7.1 carries an inline VERIFY note (second-write status field) - resolve
  it while implementing, record in the slice report.


## Delta-2 corrections (external review round 2 - AUTHORITATIVE overrides;
read WITH the tasks they amend; spec section 15 is the contract)

- T5.1/T5.2: do NOT set X-Twilio-Webhook-Enabled on outbound posts
  (receipts flow without it - spike A3/F3; the header would add our own
  onMessageAdded echoes to the cross-check).
- T5.2: additional refusal - any member whose contact is soft-deleted
  (parity with sendMessage.ts:275 fence), naming the member; GroupTextView
  surfaces the state. Send-intent = parity with existing sends (no
  exactly-once; issue `exactly-once-send-intent` filed).
- T5.3: unknown-IM park-and-retry before drop; status transitions as CHILD
  FIELD writes under the prior-status condition (whole-slot replace is
  forbidden - it clobbers the targeted sid write; concurrent same-member
  test); per-message CHxx+MB map SNAPSHOT at send; 21610 receipts perform
  idempotent number-scoped suppression bookkeeping + audit (test:
  receipt-only suppression then START); delivery/attribution member keys
  are PHONE-SCOPED (phone#<E164>, contactId as metadata; test: one
  contact with two member numbers).
- T6.1 -> becomes `ensureGroupRail` (single authoritative service; all
  three callers route through it; claim = owner token + generation;
  conditional finalize; expired-claimant cannot overwrite; rail-less
  inbound re-enqueues ensure - closes the create->enqueue crash window;
  fencing-takeover + crash-matrix tests).
- T6.2/T6.4: pending events + parked DLRs live in ONE queryable synthetic
  deadline partition (deadline-prefixed SKs) + point-readable dedupe
  markers; the T6.3 poller queries the deadline range (never a scan); TTL
  is cleanup only; overdue items alarm from the sweep. Explicit parked-DLR
  repository + drain + fake callback + tests if addendum (b) keeps the
  parking path.
- T6.4: staleness alarm = ANY slot non-terminal past deadline (never
  empty-map, which is unreachable).
- T7.3/T7.4: conditional type transition with concurrent (bulk vs inbound)
  test; the bulk runner CONVERGES every expected id to
  type+stamps+rail+map on every run - already-converted never skips
  remaining steps; crash tests after each durable step. Retract delete
  conditioned on attribute_not_exists(group_participation_at).
- T4.1: badge group read = the accepted full-partition-walk contract (no
  O(BADGE_LIMIT) claim).
- T6.2: process ONLY Source==='SMS' + external-author events; count and
  ignore API/SDK; fake emits both kinds.
- T3.4/T8.3 test wording: assert group_participation_at PRESENT +
  consent_method ABSENT + proactive gates still refuse (not "no consent
  stamp").
- Mission block cutover line = the full hardened invariant (active rail +
  verified map + zero unresolved failures or explicit adjudication).
