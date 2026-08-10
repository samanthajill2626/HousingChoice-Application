# Native group texting - implementation plan

Status: DRAFT (pre plan-review). Spec: `../specs/2026-08-10-group-texting-design.md`
(v5, APPROVED @991ca360). Branch `feat/group-texting`, worktree
`W:\tmp\group-texting`. Cutover 2026-08-17.

RULES OF THE BUILD (from AGENTS.md + the spec; restated for a zero-context
builder):

- TDD per slice: red test first, then code. Every task names its tests.
- Gates after each slice from the worktree, bare: `npm run typecheck`,
  `npm test`; `npm run e2e` at the marked checkpoints (S1, S8) and at the
  end. Never pipe gates. Hard outer timeout for e2e (`timeout 1500`).
- ASCII-only added lines in specs/tests/copy/seeds. Commit per slice with
  explicit pathspecs, Co-Authored-By trailer, bare `git status` first.
- Vendor SDK calls only in `app/src/adapters`. Jobs via `jobs.enqueue()` /
  `defineJobHandler()`. Middleware order preserved. Message catalog for
  automated copy.
- ONE-TIME LOCAL SETUP before any e2e: delete this worktree's lane tables
  (`hc-local-<L>-*`) so the harness recreates them with the new GSI (S2).
  Also required in every OTHER worktree that later runs e2e on this branch.
- The two spike-addendum items (spec section 2) are Cameron-assisted and
  scheduled during the build; S5's status-callback subtask has a decision
  point gated on addendum (b).

## Slice map

- S1 Relay label rename ("Relay group") - frees the "Group text" vocabulary.
- S2 Schema + identity + config: byGroupStatus GSI, group_text type, id/
  exclusion plumbing, boot validation.
- S3 Inbound detection: envelope parse, thread create, filing, keywords/
  consent, tripwire, auto-convert branch.
- S4 Dashboard read surfaces: inbox third source + filter, GroupTextView,
  contact card, SSE, reader-exclusion sweep.
- S5 Outbound: groupConversationsPort, group send service, receipts
  endpoint, markers, delivery UI.
- S6 Guardrails + jobs: cross-check endpoint, heartbeat, staleness check,
  rail-create job.
- S7 Import seam: type-guard, retract guard, conversion + bulk runner
  (+ rails).
- S8 Fake Twilio + seeds + e2e suite. (checkpoint: full gates)
- S9 Live self-QA + spike addendum + RUNBOOK/GLOSSARY/docs.

Slices are ordered by dependency; S3 is buildable before S4/S5 because
filing is dashboard-independent. S7 is independent of S4-S6 except the
conversion's rail creation (needs S5's port) - build the guard/conversion
logic first, wire rails last.

## S1 - Relay label rename (spec 3)

T1.1 Sweep app+dashboard copy: InboxRow.tsx:47-49 chip -> "Relay group"
  (+ InboxRow.test.tsx:88); ConversationDetail.tsx:374,384 header;
  GroupTextsCard.tsx title/copy (component name may stay);
  RelayCloseAskDialog.tsx copy; inbox.ts:513-537 label fallback;
  buildToday.ts:60-67 relay label ("Relay group"); any other staff-facing
  "group text" string referring to relay (grep `-i "group text"` across
  app/src + dashboard/src; adjudicate each hit relay-vs-generic).
  Tests: update the named component tests in the same commit (red first by
  running them against the new expectation).
T1.2 Member-facing fragment: relayFanOut.ts:225 `joined this group text.` ->
  catalog-reviewed replacement ("joined this relay group." or
  catalog-consistent "group chat" phrasing - match catalog.ts:253-260 which
  already says "group chat"; pick ONE and note it in the commit). This is
  approved outbound-copy change; goes through the message catalog rules.
T1.3 GLOSSARY: update "Group text number" -> "Relay group number" (and
  related relay entries); ADD the new "Group text" (native, unmasked) entry
  now so S2+ code comments can cite it.
T1.4 e2e string sweep: ~88 occurrences under e2e/ + selectors.md. Update
  assertions; run the touched spec files locally.
CHECKPOINT: typecheck + unit + FULL e2e (this slice touches live relay
specs; prove green before building on top). Commit.

## S2 - Schema, identity, config (spec 4.1, 4.2)

T2.1 tables.ts: add `byGroupStatus` GSI (HASH group_status S, RANGE
  last_activity_at S) to the conversations table spec; mirror in
  infra Terraform (dynamo module) for dev/prod. Test: tables unit test
  asserting the GSI shape (pattern: existing GSI tests).
T2.2 conversationsRepo: `'group_text'` in ConversationType (:39 doc
  comment per GLOSSARY); fields `group_status?`, `twilio_conversation_sid?`,
  `twilio_participant_map?` (MBxx->memberKey), tripwire/extraction marker
  passthrough on messages if needed (see T3.6). New repo methods:
  `createGroupTextThread(roster, participants)` (conditional create, writes
  group_status='group_text#open'), `getGroupTextByRoster(id)` wrapper,
  `listGroupTexts({cursor, limit})` (byGroupStatus Query, LOUD on index
  errors - ERROR log + throw, never best-effort empty; namespaced LEK),
  `setTwilioConversation(convId, chxx, map)`.
  Tests: repo unit tests incl. index-error loudness (stub a
  ValidationException) + pagination.
T2.3 Mirror ConversationType in dashboard/src/api/types.ts:408 +
  events.ts:43 SSE type; buildToday.ts:60-67 gains `group_text: 'Group
  text'`. Typecheck is the test (exhaustive Record).
T2.4 Identity: export `groupIdentity(fromE164, otherRecipients, excluded)`
  in a new `app/src/services/groupIdentity.ts` importing
  `conversationIdForGroup` + `contactIdForPhone` from lib/import/ids.
  Golden-vector tests: pinned uuid outputs for BOTH functions (3 vectors
  each incl. dedupe/sort cases).
T2.5 config.ts: `GROUP_IDENTITY_EXCLUDED_NUMBERS` with the three-tier
  validation + `none` sentinel (spec 4.1); env templates (.env.example,
  .env.dev.example, .env.prod.example) gain the var UNCOMMENTED with the
  immutability warning comment. Tests: config unit tests for throw/warn
  tiers.
T2.6 Fingerprint: settings-record `group_identity_fingerprint`; boot check
  in deployed envs only, THROW on mismatch (spec 4.1). Test: unit with
  fake settings repo.
Gates; commit. NOTE: after this slice, delete local lane tables (rule at
top).

## S3 - Inbound detection (spec 5, 4.4)

T3.1 Envelope parser `parseOtherRecipients(params)` in the webhook module:
  indexed 0..N with gap tolerance + single unindexed form; unit tests for
  all shapes incl. absent.
T3.2 Main-number branch insertion point: in twilio.ts main handler AFTER
  echo + pool branches, BEFORE the existing 1:1 pipeline. Plain 1:1 path
  must be I/O-identical when no envelope params exist (invariant 2): the
  only addition is param inspection. Test: unit asserting the 1:1 path's
  repo-call sequence is unchanged (spy-based) for an envelope-less inbound.
T3.3 Group filing: roster/exclusion (cached pool list + env set; WARN
  metric on pool-number-in-roster), id, resolve cases (a)/(b)/(c)/corrupt
  per spec 5.3. Case (c) calls the S7 conversion function inline (import
  ordering: S7's conversion function is a service-level unit built in T7.3
  - if S3 lands first, stub the call behind an interface and wire in S7;
  builder may reorder T7.3 before T3.3 instead). Persist with
  relay_sender_key = sender memberKey; dedupe via existing sid-pointer
  transaction; unread/last-activity/SSE with group id.
  Tests: unit per case; e2e deferred to S8.
T3.4 Contact stubs: `contactIdForPhone` ids + origin marker field + NO
  consent fields; sender resolution order (existing contact by phone else
  stub). participants written once, conditional; race loser re-reads.
  Tests: unit incl. no-consent assertion + race simulation.
T3.5 Consent/keywords: extract the contact-level plain-inbound stamp from
  processInboundKeywords OR add lazy target thunk (builder's choice; spec
  4.4 constraints: no conversation created on plain inbound or HELP;
  sender's 1:1 materialized on opt-out/opt-in only; reply suppressed;
  audit carries group context; contact flag + sender-1:1 flag on STOP).
  touchPhoneLastSeen for the sender. Tests: the 4-case matrix (plain, HELP,
  STOP, START) asserting created-conversation count and flags.
T3.6 Tripwire: MM-prefix + NumMedia=0 + no envelope -> file 1:1 with
  extraction-suppression marker + rate-limited WARN `group-envelope-missing`
  + counter metric. Fact-extraction trigger checks the marker (and skips
  group_text threads entirely). Tests: unit for the marker + skip.
Gates; commit.

## S4 - Dashboard read surfaces (spec 11, 3)

T4.1 Inbox: third source (top-50 via listGroupTexts, truncated surfacing
  "Showing latest 50 group texts - view all"), row kind 'group_text',
  derived title, unread badge; `filter=groups` in the InboxFilter union +
  route allowlist (inbox.ts:69,127-134,709-712 + dashboard mirror
  inbox.ts:8), namespaced cursor (tag; server 400 on mismatch; client drops
  on filter switch; contact pager off under groups filter).
  Tests: route unit tests (row shape, filter, cursor 400) + dashboard
  component tests for the row.
T4.2 GroupTextView: ConversationDetail.tsx:132-146 branch becomes
  relay_group -> RelayGroupView, group_text -> GroupTextView, else the
  existing 1:1 redirect. GroupTextView: member panel (suppression chips
  from contact opt-out state), per-message sender chips
  (relay_sender_key + roster via relaySenderLabel), per-member delivery
  chips (existing delivery_recipients renderers), composer (S5; disabled
  pre-S5 behind the send service's absence is fine mid-build, but the
  SLICE-END state renders view-only until S5 lands), unmasked-affordance
  header, >9-member banner + member 1:1 links. Accessibility-first
  selectors. Tests: component tests per element.
T4.3 Contact page "Group threads" card: bounded byGroupStatus read,
  truncated flag surfaced, links to thread view. Test: component + route.
T4.4 SSE: events.ts:87-104 builder gains group_text branch (status +
  members in payload; relay payload byte-identical - assert with a
  snapshot test on a relay fixture).
T4.5 READER-EXCLUSION SWEEP (invariant 8; the enumerated inventory - each
  gets an explicit group_text ruling + a test where behavior changes):
  - app/src/routes/inbox.ts:309 contact unread SUM: exclude group_text.
  - app/src/routes/inbox.ts:374-401 rowForConversation: group_text rows
    come from the third source; rowForConversation must skip group_text
    (like relay) so byLastActivity pager chunks don't drop them silently.
  - dashboard usePlacementChannels.ts:117: EXCLUDE group_text explicitly
    (participants-matching; spec 11).
  - app/src/routes/contactTimeline.ts:839 + contacts.ts:1164: exclude
    group_text from 1:1 timeline walks (explicit `continue`).
  - app/src/routes/today.ts:524, api.ts:1110, placements.ts:1485,
    relayGroups.ts:164,305,382,530: audit each `relay_group` branch; add
    explicit group_text handling (exclude) where a fall-through would
    treat it as 1:1.
  - twilio.ts:1447-1451 sms_unreachable number-scope read: group threads
    have no participant_phone; ensure the degradation path logs once, not
    per event.
  - webhooks status route: no group_text reachable (S5 markers).
  - contactThreads.ts conversationsForContact: group threads intentionally
    NOT returned (documented; the contact card is the group surface).
  Tests: one unit per changed reader asserting the exclusion.
Gates; commit.

## S5 - Outbound (spec 6, 7)

T5.1 Adapter `app/src/adapters/groupConversations.ts` implementing
  groupConversationsPort: createConversationWithParticipants (pinned
  MessagingServiceSid, projected biz number no-identity, member addresses;
  ConversationWithParticipants for 3-10 shapes, individual-add fallback),
  postGroupMessage (Author=biz), fetchParticipants, deleteConversation
  (test cleanup only). SMS kill-switch enforced INSIDE the adapter
  (SmsSendingDisabledError, same predicate as messaging.ts). Unit tests
  with mocked twilio client incl. kill-switch.
T5.2 Group send service `app/src/services/groupSend.ts`: thread lookup,
  >9/rail-less handling (create-on-send backstop), message persist with
  IMxx provider sid + seeded delivery_recipients parent map, audit,
  catalog only for automated copy (none in v1). Tests: unit matrix
  (ok / disabled / no-rail-create / cap).
T5.3 Receipts endpoint POST /webhooks/twilio/conversations/receipts:
  X-Twilio-Signature validation, IMxx->row, MBxx->memberKey (stored map;
  refresh on recreate; unknown participant WARN+counter),
  setRecipientDelivery, first-receipt syssid marker WITH TTL
  (putSystemSidMarker gains optional expiresAt; update the tables.ts
  "sole expires_at writer" comment), aggregate derivation, unknown IMxx
  log+counter. Mounted per middleware-order rules. Tests: route unit
  (signature, idempotency, out-of-order, unknown cases, marker TTL).
T5.4 Status-callback interplay - DECISION GATED ON ADDENDUM (b): if classic
  callbacks do NOT fire for conversation sends, delete the marker write
  (keep the test asserting no unknown-SID ERROR in e2e); if they DO,
  measure the race in e2e, then either add the bounded second retry to the
  unknown-SID terminus or document the alarm string in RUNBOOK. Record the
  outcome in the slice report.
T5.5 Composer wiring in GroupTextView + per-member chips live. Component
  tests.
Gates; commit.

## S6 - Guardrails + jobs (spec 8, 6.1)

T6.1 Rail-create job `defineJobHandler('groupRail.create')`: called from
  detection (async) + conversion bulk + send backstop; idempotent; failure
  -> thread stays rail-less + WARN + report surface. Unit tests.
T6.2 Cross-check endpoint POST /webhooks/twilio/conversations/events:
  signature-validated, ack-then-enqueue; job compares event vs filed
  message (conversation+author+window); miss -> ERROR (suppression alarm);
  updates `group_crosscheck_last_event_at`. Ingestion updates
  `group_railed_inbound_last_at`. Unit tests both directions.
T6.3 Daily liveness sweep job + 7-day heartbeat WARN (zero group-origin
  inbound while any group_text active). Unit tests with fake clock.
T6.4 Per-send staleness check job (+10min; ERROR if delivery_recipients
  still empty). Unit test.
T6.5 Ops config documentation in RUNBOOK (the 14 checklist: GSI first, env
  var, deploy, service webhook, global webhook, checks) - written here,
  executed by Cameron at merge.
Gates; commit.

## S7 - Import seam (spec 9)

T7.1 Importer type-guard: upsertConversation group path becomes
  conditional-write + reduced-retry (spec 9 exact expressions; skip
  relay_status, participants, imported_from, imported_at on group_text
  rows). Tests: unit incl. the CONCURRENT case (simulate
  ConditionalCheckFailedException) + an integration test against local
  dynamo asserting a detected thread survives a re-run byte-identically on
  protected fields.
T7.2 Retract guard: retractImported contact delete refuses on origin
  marker OR group_text roster membership; reports skip reason. Tests: unit
  both refusal paths + the still-deletes-clean-case.
T7.3 `convertConnectingRelayGroupToGroupText`: preconditions, rewrite,
  parity check (set equality both directions vs caller ownNumbers), rail
  creation via T6.1 job (or inline call with the port), idempotency,
  refusal reporting. Tests: unit matrix (converts / already-converted /
  refuses open relay / refuses parity mismatch / flags connect_day_one in
  result). Wire T3.3's case-(c) call to this function.
T7.4 Bulk entry point (script/admin seam per import-mission convention;
  per-row results). Test: unit over a small fixture set.
Gates; commit.

## S8 - Fake Twilio, seeds, e2e (spec 12) [FULL-GATE CHECKPOINT]

T8.1 Fake Twilio: inbound group MMS injection (OtherRecipients indexed +
  multi + media), minimal conversations surface (create/participants/post
  -> fan-out to fake phones + onDeliveryUpdated to receipts route), 21610
  per-member simulation for STOPped fake phones, fake-phones UI group-send
  seam.
T8.2 Seeds: `full` +2 group_text threads (demo world); `lean` +1
  group_text + 1 connecting relay_group conversion fixture. Enumerate and
  update every byte-stable lean assertion the additions perturb (grep the
  e2e suite for seed-count assertions; list them in the slice report).
T8.3 e2e specs (accessibility-first selectors): the six scenarios of spec
  12 (detection incl. no-1:1-filing + no-consent-stamp; reply-all +
  delivered chips + no unknown-SID ERROR in app logs; group STOP
  suppression + partial delivery + START restore; tripwire injection;
  conversion fixture incl. auto-convert-on-inbound; cross-check
  matched-quiet + injected-miss ERROR).
FULL GATES: typecheck + npm test + npm run e2e (honor the two known flakes
per AGENTS.md re-run rule). Commit.

## S9 - Live QA + docs (spec 12; Cameron-assisted)

T9.1 Spike addendum (a) both-scope webhook precedence, (b) classic status
  callbacks for conversation sends - on the dev account, capture-function
  pattern from the spike scripts (`.superpowers/spike/scripts/`), restore
  after; write results into the spec addendum section + resolve T5.4.
T9.2 Live self-QA: detected group + reply-all on real handsets; group STOP
  = exactly ONE confirmation observed; 3-outside-member group
  (OtherRecipients1+) + media-bearing group inbound (needs Cameron + third
  US handset).
T9.3 Docs: RUNBOOK ops checklist finalized; `npm run issues` regenerate;
  memory/handback per the profile.
Final: main sync (ONE merge of main into branch at pre-handback), full
gates, handback report.

## Post-merge / cutover obligations (NOT built; restated from spec 14)

Terraform GSI apply (dev+prod, SCHEMA FIRST), env var values, deploy,
Conversations service webhook + global webhook config, migration run
(convert-or-delete guarantee + zero-connecting check), support ticket,
MMS campaign gate. All Cameron-executed.

## Watch items for the builder

- Spike addendum outcomes can change T5.4 and guardrail-2's status - do
  NOT skip them.
- apply.ts merge coordination: the unmerged import branch also edits it;
  Cameron sequences merges - keep S7 changes tightly scoped.
- lean seed changes ripple byte-stable e2e assertions - enumerate before
  changing.
- Known flakes: tour-reminders-panel-e2e-flake,
  conversationdetail-members-mock-suite-flake - re-run once before blaming
  the branch, report both runs.
- Never touch the live stack (:5174/:8080); hermetic lanes only; delete
  lane tables once for the GSI.
