# Native group texting - implementation plan (v2, post plan-review r1)

Spec: `../specs/2026-08-10-group-texting-design.md` (v6). Branch
`feat/group-texting`, worktree `W:\tmp\group-texting`. Cutover 2026-08-17.
Adjudications: `.superpowers/design-review/adjudications.md` (plan r1 section).

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
  (MBxx->memberKey record); `touchLastActivity` gains optional
  `statusValue` param (default 'open' - byte-identical 1:1 path; unit test
  asserts the default call's UpdateExpression is unchanged). New methods:
  `createGroupTextThread(...)` (conditional create; status 'group_open'),
  `listGroupTexts({cursor,limit})` (byLastActivity Query, partition
  'group_open', newest-first; query error -> ERROR log + THROW, never
  best-effort empty; returns tagged cursor + truncated flag),
  `setTwilioConversation(convId, chxx, map)`. Unit tests incl. loud-error
  and pagination.
T2.2 dashboard/src/api/types.ts:408 union + :431 ConversationSummary
  passthrough notes + :2558 inbox row `kind` union gains 'group_text'.
  Typecheck-visible sites compile; SILENT sites get explicit rulings +
  tests in T4.6 (buildToday ONE_TO_ONE etc. - listed there).
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
  last_activity_at advance (:736-750, CCFE swallowed) - the guard wraps
  the MAIN write only; the second write's status... the advance also
  updates `status`? VERIFY while implementing: if the second write touches
  `status`, it must not overwrite 'group_open' (add the same type
  condition). Tests: unit incl. simulated-CCFE concurrent case +
  local-dynamo integration: detected thread survives re-run byte-identical
  on protected fields.
T7.2 `retractImported` (apply.ts:425-470): contact delete refuses when the
  contact carries the detection origin marker OR appears on any group_text
  roster (roster check via listGroupTexts scan of participants - bounded,
  migration-time only); reports skip reason. Tests: both refusal paths +
  clean-delete case.
T7.3 app/src/services/groupConvert.ts
  `convertConnectingRelayGroupToGroupText(conversationId, opts)` per spec 9:
  preconditions (relay_group + connecting + no pool_number; flag does NOT
  refuse), rewrite (type, status 'group_open', roster contactId backfill
  via contactIdForPhone, relay-only fields removed), idempotent,
  result reports import_connect_requested when present. Rail creation is
  NOT here (S6 job; the bulk runner enqueues rails in T7.4 once S6 lands -
  see S6 note). Tests: unit matrix (converts / already-converted /
  refuses open relay / refuses pool_number / flag reported / backfill).
T7.4 Bulk entry point (script per import-mission convention): receives
  ownNumbers, performs the EITHER-DIRECTION set-equality parity check
  against the runtime exclusion set BEFORE any conversion (refuse all on
  mismatch), converts each, enqueues rail creation per converted thread
  (no-op until S6 registers the handler - acceptable: the bulk runner is
  only EXECUTED at migration, after the full branch is built), per-row
  results. Unit test over fixtures.
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
  sid-pointer dedupe; unread; touchLastActivity(conv, {statusValue:
  'group_open'}); SSE.
T3.4 Contact stubs: contactIdForPhone ids + origin marker + NO consent
  fields; sender resolved (existing-by-phone else stub); participants
  written once conditional, race-loser re-reads. Tests incl. no-consent
  + race.
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
  texts - view all" affordance data), row kind 'group_text',
  derived title from roster, unread count; `filter=groups` in InboxFilter
  (:69) + allowlist (:127-134, :702-712); groups filter pages ONLY the
  group partition (contact pager off), namespaced cursor tag, server 400
  on tag/filter mismatch. Unit tests: row shape, filter, cursor 400,
  truncation flag.
T4.2 Dashboard inbox: dashboard/src/api/types.ts:2548 InboxFilter union;
  dashboard/src/routes/inbox/inboxFilters.ts:12-16 INBOX_FILTERS tab
  ("Groups") + :19 emptyCopy case; Inbox.tsx state; useInbox.ts:54 rowKey
  ('g:'+conversationId), :185-196 markRead group branch (conversation
  mark-read route), InboxRow.tsx:31,34 deep link to /conversations/:id for
  group_text + "Group text" chip. Component tests per site.
T4.3 GroupTextView + read path: api.ts group_text branches on the header
  (:1575), messages (:1589), mark-read (:1789) routes; new
  dashboard/src/routes/conversation/useGroupThread.ts (modeled on
  useRelayThread incl. SSE refetch); GroupTextView rendering per spec 11
  (member panel + suppression chips from contact opt-out, sender chips via
  relaySenderLabel EXTRACTED from
  dashboard/src/routes/contact/Timeline.tsx:286 into a shared module,
  per-member delivery chips REUSING the extracted presence-based renderers
  (Timeline.tsx:489-507) - state this reuse, header unmasked affordance,
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
  - app/src/routes/inbox.ts:374-401 rowForConversation - group rows come
    from the third source; add explicit group_text skip (like relay :378)
    with test.
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
  MessagingServiceSid, unattached projected biz number, member addresses;
  ConversationWithParticipants for 3-10 total, individual-add fallback),
  postGroupMessage (Author=biz), fetchParticipants. Wiring: the SAME
  `createRedirectingHttpClient` + `config.twilioApiBaseUrl` seam the
  messaging adapter uses (app/src/adapters/messaging.ts:561-569) so
  hermetic lanes hit fake-twilio; CONSOLE driver gets a logging no-op
  implementation (no Twilio calls, threads stay rail-less); SMS
  kill-switch enforced inside the adapter. Unit tests incl. kill-switch +
  console behavior.
T5.2 app/src/services/groupSend.ts: thread checks (>9 -> refuse with the
  banner error; rail missing -> create-on-send backstop), persist with
  IMxx provider sid + delivery_recipients parent map seeded, audit. Unit
  matrix.
T5.3 Receipts endpoint POST /webhooks/twilio/conversations/receipts:
  X-Twilio-Signature; IMxx->row; MBxx->memberKey (map; refresh on
  recreate; known-IM/unknown-MB = WARN+counter); setRecipientDelivery;
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

T6.1 Rail-create job defineJobHandler('groupRail.create') called from T3.3
  thread creation (enqueue) + T7.4 bulk + T5.2 backstop; idempotent;
  failure -> rail-less + WARN + report. Unit tests.
T6.2 Cross-check endpoint POST /webhooks/twilio/conversations/events:
  signature; ack-then-enqueue compare job (conversation+author+window);
  miss -> ERROR; updates settings `group_crosscheck_last_event_at`;
  ingestion (T3.3) updates `group_railed_inbound_last_at`. Unit tests both
  directions.
T6.3 Periodic jobs, wired like the four existing worker pollers
  (app/src/worker.ts:263-418 pattern) EACH WITH a `__dev` tick endpoint
  (app/src/routes/dev.ts pattern): daily liveness sweep ("cross-check
  channel quiet" WARN) + 7-day heartbeat WARN. Unit tests with fake clock
  + tick-endpoint tests.
T6.4 Per-send staleness check: jobs.enqueue runAt +10min (within the 720s
  SQS DelaySeconds bound? 600s = 10min exactly at the bound - VERIFY
  jobs.ts MAX; if over, use the scheduler path or a 9-minute delay) ->
  ERROR if delivery_recipients still empty. Unit test + __dev tick.
T6.5 RUNBOOK ops checklist (spec 14) written; executed by Cameron at
  merge/cutover.
Gates; commit.

## S8 - Dev seams, fake Twilio, seeds, e2e (spec 12) [FULL-E2E CHECKPOINT]

T8.0 Log-assertion seam: dev-only in-memory ring buffer of WARN+ERROR
  structured lines exposed at GET /__dev/logtail (mounted with the other
  __dev routes; structurally absent in deployed envs). Unit test.
T8.1 fake-twilio: inbound group MMS injection (OtherRecipients indexed +
  multi + media); minimal Conversations API surface (create conversation/
  participants, post message -> fan-out to fake phones + onDeliveryUpdated
  POST to the receipts route); 21610 per-member simulation for STOPped
  fake phones; fake-phones UI group-send seam (send a group text to the
  business number from the fake handset UI).
T8.2 Seeds: full profile +2 group_text threads; lean +1 group_text and +1
  connecting relay_group (conversion fixture). Verification method: RUN
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
T9.2 Docs: RUNBOOK finalized; `npm run issues`; GLOSSARY verified; memory +
  handback per the profile.
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
- apply.ts merge coordination: the unmerged import branch also edits it;
  keep S7 changes tightly scoped; Cameron sequences merges.
- Two known flakes (tour-reminders-panel, conversationdetail-members):
  re-run once before blaming the branch; report both runs.
- Never touch the live stack (:5174/:8080); hermetic lanes only.
- T7.1 carries an inline VERIFY note (second-write status field) - resolve
  it while implementing, record in the slice report.
