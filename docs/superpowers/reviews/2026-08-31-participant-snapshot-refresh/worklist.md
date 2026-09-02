# Merged worklist - feat/participant-snapshot-refresh (M1)

Built 2026-09-01 from four read-only research passes (byte-exact quotes in
research-A/B/C/D-reference.md beside this file; findings committed at a32fa7ed;
decisions in docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/research-adjudications.md).
Code tree is byte-identical to b702a81c, so plan line numbers apply EXCEPT where
corrected below. Every implementer: read the plan task, then THIS file's section
for that task. Where they differ, this file wins (it was derived from the tree).

## Global (all slices)

- Chain: live contact name (non-deleted, non-empty) -> stored snapshot -> formatted phone.
- Batch = `contactsRepo.getDisplaysByIds`. Never `getById` per member; never `findByPhone` on a request path; never `requireComplete`.
- `participants[].phone` is never written. Do NOT edit jobs/relayFanOut.ts, services/relayAnnouncements.ts, lib/unreadFeed.ts, jobs/tourReminders.ts, api.ts GET /conversations/:id (handler :1996, res.json :2004) or GET /group-members (:2020). rosterEdits.ts: two docblocks only (Task 6).
- Repo facts (CONFIRMED): `ContactDisplayItem` = `{ contactId: string; firstName?: unknown; lastName?: unknown; phone?: string; deleted_at?: string }` (contactsRepo.ts:296-302). `isDeleted(x: Pick<ContactItem,'deleted_at'>)` (:309) accepts the projection. `getDisplaysByIds` (:1077-1079; impl :824-852) chunks by 100, de-dupes, 4 attempts, returns a SHORT map on a failed chunk and NEVER rejects. DISPLAY_PROJECTION (:855-865) includes deleted_at.
- Fake world (app/test/helpers/twilioWebhookHarness.ts): `world.contactsRepo` is a plain object literal typed ContactsRepo (:1667) - every method is a reassignable property; it ALREADY implements `getDisplaysByIds` (:1695) via `projectDisplay` (:1659-1665) which carries deleted_at. `listRelayGroups` filters `c.relay_status === 'relay_group#<status>'` (:777-781). `createRelayGroup` (:727) stores members verbatim (keeps `contactId: ''`).
- `ConversationParticipant` = `{ contactId: string; phone: string; name?: string }`. ConversationItem declares relay_status (:275), close_nag_next_at (:282), pool_number, unread_count, participant_phone, participant_display_name, created_at (:237), plus an index signature (:352).
- `nameFromContact` lives in services/relayMembers.ts:37 (importers: relayGroups.ts:39 -> used only at :491; rosterEdits.ts:77 -> :800).
- lib/groupTitle.ts: `groupThreadLabel(roster)` (:29) uses the FIRST token of each name; `relayMemberLabels` (:89) / `relayThreadLabel(conv)` (:142) use the FULL trimmed name; each falls back to that member's own formatted phone.
- Dashboard vitest must run from the dashboard dir (`cd <worktree>/dashboard && npx vitest run src/...`); app vitest from the app dir. `npm run typecheck` from the worktree root.
- Commit discipline: bare `git status` before every commit; explicit paths; never `git add -A`; ASCII-only in every new line; trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Slice report: SHORT, to docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/slice-T<n>-report.md, committed on its own (`docs(review): T<n> slice report`). Divergences from the plan, red/green evidence (quoted counts), open worries. No narration.

## T1 - participantNames + contactDisplayName (plan lines 43-332)

- contactName.ts: import to delete is :7; docblock :50-64; function :66-73 (uses bracket access via ContactItem's index signature). Importers of `contactDisplayName`: webhooks/twilio.ts:97 (uses :314, :1042, :2284), webhooks/voice.ts:49 (uses :155), test/contactName.test.ts:5 - all pass a full ContactItem, so the widened `{ contactId: string; firstName?: unknown; lastName?: unknown }` compiles for them. Zero importers in app/scripts.
- `createLogger({ destination })` (lib/logger.ts:178) and `createLogCapture()` -> `{ stream }` (test/helpers/logCapture.ts:14) exist as the plan's test uses them. `export type { Logger }` at logger.ts:14.
- D-F5: the REAL getDisplaysByIds never rejects; keep the plan's "throwing batch" test but comment it as a contract guard (a fake or future repo may throw; the module must still never reject).

## T2 - Today (plan lines 336-518)

- All anchors MATCH: nameFromContact :222, getContact :357, index walk :742, deleted check :743, emit loop :777 with `const who = whoOfConversation(conv);` at :778 (the ONLY call site; not exported), close-nag :994-1002 (openGroups :987, close_nag_next_at :995, pool_number :998, memberNames :1000-1002), whoOfConversation docblock :1073-1074 + fn :1075-1080, oneToOneContactId :1086. In scope: contacts :311, log :306, nowIso :331, formatPhoneForDisplay :85, ContactItem/ContactsRepo :66-71; `../lib/` import block :79-86.
- todayApi.test.ts: authedGet :40, seedTenant :44, seedConversation :81 (takes a FULL ConversationItem; the plan's fixtures use only declared fields - no cast needed), iso :103, getItems :128, world :29, TodayResponse :24, top describe :27. RelayCloseNagItem.memberNames exists (today.ts:120). The harness citation in the plan's fixture comment should read twilioWebhookHarness.ts:777-781.
- formatPhoneForDisplay('+15550107777') === '(555) 010-7777' (lib/phone.ts:73-77).
- buildToday.ts:106: `formatPhone` is FILE-LOCAL (:95) - no import to add.
- Already-correct sibling (no action): today.ts:631-636 (relay opted-out members) already does nameFromContact -> entry.name -> phone.

## T3 - Inbox (plan lines 522-682)

- All anchors MATCH: aggregateInbox :709 (closes :2396), log :713, contacts :715, relayRowFor :1154, groupRowFor :1190, sites :1237 / :1418 / :2293 / :2358, comment :1391-1398. `ContactDisplayItem` is NOT yet imported (export at contactsRepo.ts:296). Labels from `../lib/groupTitle.js` (:56).
- LOAD-BEARING: :1237 and :2358 currently call `.map(groupRowFor)` point-free; with the 2-arg signature that would pass the array INDEX as `names`. The plan's arrow wrappers `(c) => groupRowFor(c, names)` are mandatory.
- inboxGroups.test.ts: Calls :35, makeDeps :40 (initialiser :41), contactsRepo fake :102-117 (no getDisplaysByIds - the cast is `as unknown as NonNullable<...>`, so a missing method is a RUNTIME TypeError that resolveRosterNames would swallow; adding it is necessary), groupConv :132 (default roster Ann Tenant +14045550111 / Marcus Landlord +14045550112 at :140-143), relay literals :396-406, ConversationItem import :19, seed.contacts shape `{ contactId; phone; name? }` :32.
- CORRECTED RED VALUES (A-F1/F2): group test red = `['With Ann & (404) 555-0112', 'With Ann & Marcus']` (gt-2 keeps the default roster) and displayBatches length 0; relay test red = `'With Ann Tenant'` (relayThreadLabel uses the FULL name). Green values unchanged: `['With Annika & Marc', 'With Annika & Marc']`, `'With Annika'`.
- inboxFeed.test.ts contactsRepo fake :196-224; inboxUnreadParity.test.ts :234-245; both cast `as unknown as NonNullable<...>` - adding `async getDisplaysByIds() { return new Map(); }` is type-safe.

## T4 - Contact cards (plan lines 686-809)

- contacts.ts: log :917, contacts :919 (plan said :918-919). Relay-groups replace region STARTS at :1188 (`for (const status of ...)`; :1189 is the listRelayGroups call); inner loop closes :1226, outer :1227, `groups.sort(` :1230. truncated warn :1190-1197 (its string is asserted by no test), isSelf :1181, relayMemberLabels :1204, tag :1205, otherMemberNames :1213, groups.push :1215. Group-threads: `const groups: GroupThreadRow[] = []` :1278 (keep), replaced lines :1279-1282, `title:` :1294. ConversationItem imported :66. `../lib/` imports are not contiguous (:17-37, :60-62, :72, :88) - insert the new import after :27 (groupTitle.js).
- contactRelayGroups.test.ts: TENANT :24, PHONE_A :25, LANDLORD_PHONE :27, authedGet :40, seedContact :43, seedRelay :57 (opts type :60-66, body to :99; sets relay_status itself at :89; `opts.status` is typed 'open'|'closed' only - no 'connecting'). world.contacts is ContactItem[] (type required; status/firstName/lastName optional).
- contactGroupThreads.test.ts: seedGroup :52 is async; OTHER_PHONE :24. B-F2: the plan's title assertion is VACUOUS (groupThreadLabel takes the first token, so 'Marcus Landlord' and 'Marcus Renamed' both give 'With Marcus'; :83 already pins it off the stored name). Use a contact whose FIRST name differs: firstName 'Marc', lastName 'Renamed' -> expect title 'With Marc' and otherMemberNames ['Marc Renamed'].

## T5 - Relay members + calls passthrough (plan lines 813-990)

- relayGroups.ts: import list :39 (nameFromContact's only use is :491; `resolveMemberName` at :422 is a different helper and STAYS). Members route is :469-507; the replace region is :481-506 (from `const members = await Promise.all(` through `res.json({ members });`); bare-phone :483 and the delete :489 are right. contacts :151, log :148 in scope.
- api.ts: log :558, contacts :635, GET /calls/:callId :2185, `res.json({ call, conversation })` :2201.
- relayApi.test.ts: ALICE/BOB :34-35; the two pins span :427-448 and :450-470 (titles verbatim as the plan quotes); `vi` is NOT imported - add it; authedHarness :209, SECRET :213. createRelayGroup fake stores participants verbatim, so the plan's expected arrays are exact.
- voiceWebhook.test.ts: seedRelay(world, overrides?) :31 with default roster c-bob / 'Bob' and NO contact seeded; inboundVoiceParams :53; the calls test is :898-916; plan's RED value 'Bob' is correct. relayGroupPreview.test.ts exists.
- Commit body MUST name the reversal of the 2026-07 ruling (two retitled pins).

## T6 - describeRoster precedence (plan lines 994-1069)

- rosterResolution.ts: removed :541, comment :557-562, `const name =` :563-564, `let sharesPhoneWithName` :565 (untouched), displayName :163, nonEmpty :170, contact read :530.
- rosterEdits.ts (COMMENTS ONLY): :440-441 as the plan quotes. The second phrase is SPLIT across :454/:455 ("and the" / "recipient list from `describeRoster` (backfilled names)") - rewrap the docblock :453-456 by hand; no literal find/replace. buildOpenPreview :545, buildAddPreview :719.
- rosterResolution.test.ts: describeRoster import :16, makeDeps :41, TOUR :74, contact :81 (contact('c-tenant', phone, 'Tina') -> display 'Tina Person' - plan correct), describeRosterActions :522, no existing describeRoster block.
- Preview pins: ZERO expectations move (swept rosterEdits/relayGroupPreview/toursApi/placementsApi/rosterActionsPoll - every stored roster name equals its contact's display name or is a bare-phone member). Body strings cannot move: buildOpenPreviewFromParts (rosterEdits.ts:501-518) composes the body from resolveRoster stored names (:556-564) while only `recipients` comes from describeRoster (:600-607); buildAddPreview's body uses candidate.name (:738). Still run the plan's Step 4 suites PLUS test/rosterActionsPoll.test.ts (B-F8) and report.

## T7 - push + voice labels (plan lines 1073-1232)

- twilio.ts:301-316 byte-for-byte; call sites :728 (relay) and :1814-1818 (group). Imports present: ContactItem :41, formatPhoneForDisplay :94, contactDisplayName :97.
- voice.ts: maskedPartyLabel :109-121; calleeLabel computed :983-986, callerLabel :991, call_party_label PERSISTED at :1011, whisper URL :1044, gather.say :1307; voiceMasking import block :79-86 already imports contactShortName (:82). ALSO rewrite the stale comment at :123-128 ("labels a roster MEMBER by its cached display name") to match the new chain (C-8).
- voiceMasking.ts: contactShortName :46-53 (hyphenated surname -> charAt(0), so 'Ada L.' is right). test/voiceMasking.test.ts does not exist - create it. founderTriage.test.ts and voiceOutbound.test.ts exist.
- inboundMessagePush.test.ts: the native-group describe spans :494-528. BLOCKING FIX (C-1): the plan's third RED test reads `world.conversations.get(GROUP_ID)!` BEFORE any post, but beforeEach (:158-174) seeds no conversations - the webhook creates the thread (twilio.ts ~:1526-1541). Redesign: (1) `signedTwilioPost(app, SMS_PATH, groupParams())` to create the thread (one push recorded); (2) mutate `world.conversations.get(GROUP_ID)!.participants` so the SENDER's member has `contactId: 'c-ana', name: 'Old Ana'`; (3) `world.contacts.push({ contactId: 'c-ana', type: 'tenant', phone: SENDER, firstName: 'Ana', lastName: 'Reyes' })` (status-less entries are what :513 already does); (4) post again with a DISTINCT sid: `groupParams({ MessageSid: 'MMgroup0002' })` (a redelivery of the same sid is deduped and emits no push); (5) assert the SECOND broadcast's payload body: `(world.pushBroadcasts[1]!.notification.payload as { body: string }).body` === 'Ana Reyes: hello, looking for a 2 bed' - do not use soleMessagePayload (it asserts exactly one). The sender contact is read via the roster contactId (twilio.ts:1668-1676: getById('c-ana', consistentRead)). RED must be 'Old Ana: hello, looking for a 2 bed' - if the test is not red before the change, STOP and report; do not force it.

## T8 - drift audit (plan lines 1236-1460)

- measure-unread-contact-coverage.ts: import block :32-38, repos `conversations`/`contacts` :90-91, auditDenorm :473, group skip :510, final console.log :554-588, auditTabVsPartition declared :763 (its :785 skip is NOT touched), CLI dispatch :963-966; the script requires `--confirm` (exits 2 without it) and reads the lane's DYNAMODB_ENDPOINT / TABLE_PREFIX / AWS_ACCESS_KEY_ID (DynamoDB Local keeps one database per access key - the lane key is `hclane<L>`).
- conversationsRepo.ts: listGroupTexts :948-951 (opts {limit, cursor} -> {items, nextCursor?, truncated}); listRelayGroups(status) :805-807 -> {items, truncated}. Both match collectGroupRosters as written.
- The LANE RUN (plan Step 5) is the ORCHESTRATOR's job during self-QA (needs an e2e session on a `full`-profile lane: `POST /__dev/reseed?profile=full`, dev.ts:311) - the T8 implementer builds and unit-tests only, and does NOT start an e2e session.
- Interpretation note for the audit numbers: app/src/lib/seed/performance.ts:842/:857-858/:890 bake synthetic roster names against real contacts (:890 is a template literal, invisible to a string grep), so a `full` lane WILL report nameDrift by construction.

## T9 - e2e (plan lines 1464-1564)

- steps.ts: teamTriagesUnknownToTenant :710 (plan :711), contactId() :3531, requireActiveTourGroup() :3765 returns `{ groupThreadId }`, expectGroupOnContactFile :1926 (asserts the other party's NAME on the card), openActiveContact :3956 / editTenantIdentity :3963 (private-but-callable from inside the class), tenantTexts texts APP_NUMBER (business number) -> an unread 1:1. `Contact` requires all four fields; freshContact.name is NOT first+' '+last, so the plan's hand-built `renamed.name` is right. ConversationDetail path is dashboard/src/routes/conversation/ (singular); :87, :212, :406 match.
- Single-spec command (from the worktree root; the root `npm run e2e -- --grep` form does NOT forward): `npm run e2e -w @housingchoice/e2e -- --grep "renaming a contact"`. It boots the hermetic lane itself (reuseExistingServer) - never a root/stray playwright. NEVER commit while it runs; wait for it to finish, then commit. Do not start it while any other e2e/session runs in this worktree.

## T10 - issues (plan lines 1568-1595)

- Valid statuses (scripts/issues.mjs:18): open | in-progress | deferred | resolved | wontfix. `closed` is INVALID. Closing = `status: resolved` + frontmatter `resolved: 2026-09-01` + the Resolution paragraph (_TEMPLATE.md:25-26).
- today-contact-hydration-fan-out: DEVIATION (C-5). Record N from the S1 harness as the spec asks, but LEAVE IT OPEN: the issue's own rule (:19-25) names `npm run perf:pages` against the imported dataset (a human-only target) and states no threshold; the plan's "N < 30" was invented. Stamp: the harness N, the S1 result (zero added reads), and that closure waits on Cameron's imported-dataset measurement.
- consolidate-contact-display-name-helpers: rewrite the census paragraph AND the frontmatter `title:` / `refs:` that still say "six".
- group-roster-name-snapshot-never-refreshed stamp: residue list must ALSO name `GET /api/conversations` (`toConversationSummary`, api.ts:453-465, consumed by dashboard endpoints.ts:512 -> Today's offline fallback buildToday.ts:103-107) and the SSE `conversation.updated` raw roster (lib/events.ts:103/110/117, no consumer today) - both adjudicated out of scope (D-F1/F2).
- Fixture grep: zero hits (confirmed) - say so in the commit body.
- Records path files (research-*.md, slice-T*-report.md) are NOT issues; leave them alone.
