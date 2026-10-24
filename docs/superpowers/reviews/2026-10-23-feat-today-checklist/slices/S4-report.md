# S4 slice report - the Today server (today-checklist, tracker #31)

Branch feat/today-checklist. S4_BASE = 5e8d6504 (the S3 report commit).
Commits, in order: 5026891d (S4.1), 839b0fe2 (S4.2), f1d420ee (S4.3),
1c9b875b (S4.4), 7913fc83 (S4.5), 1a042159 (S4.6), aed0a93e (S4.7), then
this report. Line numbers below are at aed0a93e.

## Where the tree and the plan differed

- S4.1 Step 3d (plan defect, fixed): the plan renamed the step-4 accumulator
  `items` to `rows`, but the loop under it destructures each unit's own
  `rows` (`for (const { unit, rows, toursByTenant } of perUnit)`), so the
  push went into the per-unit sends array: tsc TS2345 at followUps.ts:238 and
  16 red tests on the first GREEN run. The accumulator is named `waiting`
  (app/src/services/followUps.ts:203) and the core returns
  `{ rows: waiting, truncated }` (:242) - the planned return shape, the loop
  body untouched. No other anchor drifted; every quoted old text matched
  once S2's api.ts move was accounted for (the `createTodayRouter({` call is
  at app/src/routes/api.ts:1296).
- WL-7 (worklist wins): S4.5 Step 3g line 2 reads "The known-contact unread
  section is gone: ..." (app/src/routes/today.ts:892) and Step 3k line 2
  read "// AI-suggestions (spec 2026-10-23 2)." until S4.6 Step 3f replaced
  that order comment as planned (today.ts:1272-1274). Result: S4.5 Step 4's sweep printed
  nothing (exit 1); S4.8 Step 1's `unreplied` sweep over app/src and
  app/scripts found exactly ONE hit, app/scripts/seed-smoke.mjs:299.
- WL-8: the non-regression beforeAll also creates the AVAILABLE unit
  'unit-nonregression-avail' with no sends
  (app/test/todayUnmatchedNonRegression.test.ts:151). Mutation check: with
  the listing-sends injection switched to `createListingSendsRepo({ doc,
  logger })` (no suite prefix) the pin went RED - `expected { status:
  'unavailable' } to deeply equal { status: 'ok', ... }` at :173 - so a
  mis-wired listing-sends repo now fails the pin; reverted (byte-identical,
  `cmp`), green again.
- WL-9: the three D5 titles that kept naming needs_you_now were retitled in
  S4.4 (app/test/todayApi.test.ts:995, :1004, :1030).
- WL-10: comment-only rewrites in app/src/lib/statusModel.ts:207-209 ("the
  triage queue and Today's Identify these contacts") and
  app/src/lib/unknownQueue.ts:64-68 (Identify these contacts; the unread
  pass's owner rule, not the removed Inactive skip). Committed in S4.5.
- WL-11: the today.ts header (app/src/routes/today.ts:33-48) says "Every list
  read but one is a bounded Query" and names Tours to book as the one
  exception: tours listByStatus('requested') pages the whole requested
  partition, uncapped by design (spec 5.4; prod 13), no cap, no WARN, no row
  dropped. No code added.
- WL-12: the route comment (today.ts:1220-1222) says listing sends is a
  base-table Query read WITHOUT ConsistentRead, so the Not interested
  drop-off can read the pre-decline row once - same residue class. No code
  change.
- PR62: no adjustment was needed - all eight pre-existing WI7 counts equalled
  the plan's expectation at the RED run (only the four S4 Follow up core
  counts were 0 there).

## Contradictions C1-C5 (plan section 8) - how each landed

- C1: the non-regression test injects `unitsRepo: createUnitsRepo(repoDeps)`
  (todayUnmatchedNonRegression.test.ts:108) and `listingSendsRepo:
  createListingSendsRepo(repoDeps)` (:110); TODAY_TABLES gains 'units' and
  'listing_sends'; before the flood it asserts `toursToBook === 'ok'` and
  `quietShares` = `{ status: 'ok', properties: [], truncated: false }`
  (:173). With WL-8 the listing-sends half is really exercised (above).
- C2: the throw-path WARNs carry `{ err, section }` (today.ts:750
  tours_to_book, :1244 quiet_shares) and `{ err, unitId }` (:533); the
  absent-unit WARN is exactly `{ unitId }` (:528). Every failure test asserts
  no seeded name in any WARN line ('Amy', 'Quinn', 'Rita').
- C3: the unread-pass cases that rode Unreplied rows were re-expressed on
  unknown_1to1 threads (list below); where the triage pass could rescue the
  live row by itself, the live owner is UNRESOLVED (no contact item).
- C4: the observed `world.recipientDisplayCalls` element is `{ contactIds,
  opts? }` (app/test/helpers/twilioWebhookHarness.ts:546-549, push :2328),
  as PR60 states. Every S4 assertion reads `call.opts?.*`:
  followUpsApi.test.ts:83 (WI1 pin: `opts?.requireComplete === true` and
  `opts?.consistentRead` undefined on every call) and todayApi.test.ts:2525
  (`recipientDisplayCalls[0]?.opts` matches `{ requireComplete: true,
  consistentRead: true }`).
- C5: `isOneToOneBucket` left the today.ts import (S4.5); the type filter
  `if (conv.type !== 'unknown_1to1') continue;` (today.ts:899) is strictly
  narrower. lib/unreadFeed.ts still exports it for the badge and the Inbox.

## Deliberate inversions (PR40), each named

1. "an unread unknown_1to1 thread from an ACTIVE team member emits NO Today
   row (Inbox only)" - todayApi.test.ts:1016. Was "PIN: an unread
   unknown_1to1 thread from an ACTIVE team member is still in needs_you_now
   (unchanged)".
2. "RED: more than TODAY_UNREAD_CAP Inactive unknown threads ahead of live
   work do not hide it (the owner test runs BEFORE the cap)" -
   todayApi.test.ts:1059. Its Active team member row (`c-live-team`) and its
   tenant_1to1 row (`c-live-ten`) are now asserted ABSENT; the
   no-second-source live row is an unresolved-owner thread (`c-live-unres`);
   expected identify ids `['c-live-nr', 'c-live-unres']`.
3. "a re-typed TENANT's unread unknown_1to1 thread (a second number triage
   never re-typed) emits NO Today row, before or after Inactive" -
   todayApi.test.ts:1110. Was "RED: an INACTIVE TENANT's unread unknown_1to1
   thread (a second number triage never re-typed) is emitted exactly as
   before".
4. "an INACTIVE CASEWORKER's unread unknown_1to1 thread emits NO Today row
   (Identify is type-unknown owners only)" - todayApi.test.ts:1157. Was "RED:
   an INACTIVE CASEWORKER's unread unknown_1to1 thread is still in
   needs_you_now, the row unchanged".

## Unreplied cases removed or re-pointed (PR59 / C3), by title

Re-pointed to "emits NO Today row" (a known contact's unread thread is Inbox
only, spec 4):
- "groups items into needs_you_now / tours_today / follow_ups with
  refType/refId and populated who/why; a known contact's unread thread is on
  none of them" (:289) - the `ct-pat` Unreplied assertion became an absence
  plus the exact group list.
- "a partner_1to1 conversation with unread emits NO Today row (Inbox only)"
  (A2, :719).
- "a relay_group conversation with unread emits NO Today row (nor does a
  known tenant_1to1 - Inbox only)" (FIX B, :1169).
- "an INACTIVE TENANT's unread tenant_1to1 thread emits NO Today row (the
  Inbox has it)" (D5 block, :1038-1040).

Re-expressed on unknown_1to1 threads, asserting identify rows:
- NEW-3: "an unknown contact with an unread PHONE thread AND an unread EMAIL
  thread yields exactly ONE identify row" (:743); "a duplicate thread does
  NOT consume one of the TODAY_UNREAD_CAP slots" (:783, unresolved owners).
- A9 x3: "a DELETED contact does NOT consume one of the TODAY_UNREAD_CAP
  slots" (:826), "applies the deleted-contact rule to EVERY walked item: 250
  deleted ahead of 5 live shows exactly the 5" (:867), "has NO
  deleted-contact lookup bound: 101 deleted ahead of 1 live shows exactly
  the 1, and announces the skips" (:915) - deleted unknown contacts ahead,
  unresolved live owners behind.
- byUnread block: "surfaces an unread 1:1 that ranks BEYOND the old 100-row
  open-partition window" (:1779), "caps at 100 kept conversations and WARNS
  with the unread threshold, not the group-fetch one" (:1843),
  "FILTER-THEN-CAP: a burst of unread group threads cannot starve the
  Identify rows" (:1866), "WARNS when the scan budget expires before the
  pass fills, instead of a silent short block" (:1930).
- "participant names resolve on read (M1)" block (:1965, five cases) moved
  to the Identify vehicle: an unread unknown_1to1 thread owned by a
  type-unknown contact on the same phone (the triage pass de-dupes it). Why
  not tours_to_book: these cases pin whoOfConversation (contact name over the
  stored participant_display_name snapshot, the stored name when the contact
  read fails, the formatted phone for an unlinked thread, no extra read).
  tours_to_book rows name the tenant through resolveContactLabel, which never
  reads a conversation snapshot, so it cannot express any of those rules;
  the Identify rows from the unread pass are whoOfConversation's only
  remaining caller. The unlinked-thread PIN now asserts the thread defers to
  the triage row (`c-unlinked`) and emits no conversation ref.

Other app reader of the group list: app/scripts/seed-smoke.mjs:298-300
(comment rewritten; its asserts - tours_today >= 1, needs_you_now >= 1 from
the overdue RTA placement - are unaffected). The S4.8 sweeps found no other
reader: `git grep -i unreplied -- app/src app/scripts` = 1 hit (seed-smoke);
`git grep "'unreplied'" -- app` = 1 hit (todayApi.test.ts:2369, the
not.toContain in "Unreplied is gone"); the other -i hits in app/test are
history comments, the `conv-unreplied` fixture id (asserted absent) and that
title; `isOneToOneBucket` in today.ts = none.

## Watch items

- WI1: followUps.test.ts and followUpsApi.test.ts pass with S1's additive
  RECIPIENT_ATTRS change plus S4.1's batch-recording widening (pre-existing
  assertions untouched). Pins: "(PIN, WI1) buildFollowUps output is
  byte-identical whether or not the recipients carry last_reached_out_at"
  (followUps.test.ts:480) and "(PIN, WI1) a set last_reached_out_at changes
  NOTHING in the body; the tab reads contacts without consistentRead"
  (followUpsApi.test.ts:83). The tab's batch is exactly
  `{ requireComplete: true }` (followUps.test.ts:454, toStrictEqual). Both
  PINs were green on the unchanged code. Mutation [PR82/PR101]:
  `collectWaitingFollowUps(deps, { consistentRead: true })` in
  buildFollowUps made the followUpsApi pin fail `expected true to be
  undefined` at `call.opts?.consistentRead` (1 failed | 4 passed); reverted.
- Unit labels [PR86]: a present unit, soft-deleted included, shows its
  address with no WARN ("a soft-deleted unit still shows its address, with
  no WARN (PR86)", todayApi.test.ts:2106); only an absent unit ("an absent
  unit labels the row with its unitId and WARNs once per unit - never a 500
  (PR86)", :2117) or a throw (:2133) shows the unitId with ONE WARN per unit
  per request. No units `isDeleted` import (PR96).
- WI7, the committed counts object (todayApi.test.ts:2685, one load: three
  available properties, two with a share in the last 14 days, one requested
  and one today tour, both on u-1):
  `{ deadlinesDue: 1, placementsByStage: <non-terminal stages>,
  toursByRange: 1, relayOptOut: 1, unreadPages: 1, triagePages: 1,
  aiPending: 1, relayGroups: 1, toursRequested: 1, unitLabels: 1,
  unitsWalk: 1, sendsByUnit: 3, toursByUnit: 2, recipientBatch: 1 }`.
  Formula per load: 1 units byStatus page per 100 available properties; 1
  listing-sends Query per kept property; 1 tours byUnit Query per property
  with a share in the last 14 days; 1 contacts BatchGet (DynamoDB pages it
  per 100 keys); 1 requested-tours Query (paged to completion, uncapped -
  WL-11); 1 unit GetItem per distinct tour unit (memoized). No pre-existing
  count differed from the plan's expectation.
- WI7, the unread walk [PR92]: with the type filter first the walk keeps no
  typed thread, so on a busy index it no longer stops at its 100-row cap; it
  reads the byUnread index (pages of 100) up to its raw budget
  (UNREAD_WALK_LIMIT 2000 items, app/src/lib/unreadFeed.ts:46, :96), every
  load and every SSE refetch, and the "underfilled" WARN fires whenever the
  index exceeds that budget. Measured: the WI7 load read 1 unread page
  (`unreadPages: 1`); the S4.5 byUnread budget case (unreadWalkLimit 2, five
  unknown threads, todayApi.test.ts:1930) read 1 page (measured by a
  temporary spy, removed before the commit).
- WI8 [PR90, WL-12]: Today's contacts batch is consistent
  (`collectWaitingFollowUps(..., { consistentRead: true })`,
  today.ts:1232-1235; pinned by "quietShares groups by property in spec
  order; the contacts batch is read CONSISTENTLY", todayApi.test.ts:2525).
  The eventually consistent reads that matter are GSI Queries: the tours
  byStatus GSI (Tours to book, app/src/repos/toursRepo.ts:442-465), the
  tours byUnit GSI (toursRepo.ts:422-424) and the units byStatus GSI
  (app/src/repos/unitsRepo.ts:1407-1409) via the Follow up core. Listing
  sends is a base-table Query read WITHOUT ConsistentRead
  (app/src/repos/listingSendsRepo.ts:473-483), so the Not interested
  drop-off (no event; the remount refetch) can read the pre-decline row
  once - same residue class. A tour create's single refetch can miss a
  not-yet-propagated GSI; no mechanism is added (the same residue Today
  carries for conversation.updated over the byUnread GSI). DynamoDB Local is
  always consistent, so no test or e2e result is proof of prod liveness.

## Recorded residue (worklist, verbatim)

- R-3 (E1-5) Staff Do Not Contact toggle, phone add/edit/remove, the /status
  30005/30006/21610 flags and the share fan-out's unreachable flag make a
  quiet-share person ineligible with no event Today hears. Same reasoning as
  spec 8's Not interested ruling (made on the contact page; returning to
  Today remounts and refetches; another open tab catches up on its next
  refetch); no wrong send can follow (the send gates refuse). No event added.
  S4 report.
- R-4 (E1-6) A re-share of the same property updates the pair's sentAt after
  the share text's conversation.updated; an open Today can keep the row until
  its next refetch. Narrow race; re-share is unchecked by default. S4 report.

## The wire as built (for S5's mirror)

- `TodayGroup` = 'needs_you_now' | 'identify' | 'tours_to_book' |
  'tours_today' | 'follow_ups' | 'ai_suggestions' (today.ts:108).
- `TodayItem` gains `at?: string` and `unitLabel?: string`, tour rows only
  (today.ts:129, :131).
- `TodayResponse` = `{ items, relayCloseNags, quietShares, toursToBook,
  generatedAt }` (today.ts:188-200); `TodayQuietShares` (:179) =
  `{ status: 'ok'; properties: QuietShareProperty[]; truncated: boolean } |
  { status: 'unavailable' }`; QuietSharePerson (:157) / QuietShareProperty
  (:170) as spec 3 (no top-level `people`, PR103).
- identify rows: `{ group: 'identify', refType: 'contact', refId, who, why:
  'New unknown contact', attention: true }`; tours_to_book rows:
  `{ group: 'tours_to_book', refType: 'tour', refId: tourId, who, why:
  unitLabel, urgency: 'Requested today' | 'Requested 1 day ago' |
  'Requested N days ago', at: createdAt, unitLabel }`, no tag; tours_today
  rows keep `why: 'Tour today'`, `tag: 'Tour'` plus `at: scheduledAt`,
  `unitLabel`.
- Item order (today.ts:1275-1282): needs_you_now, identify, tours_to_book,
  tours_today, follow_ups, ai_suggestions.

## Gates run in S4 (fast gates only, as briefed)

- `npm run typecheck` (bare, root): exit 0 after every S4 commit and at S4.8.
  The dashboard typecheck stayed green (it does not import app types).
- eslint on the slice's 11 .ts files (followUps.ts, quietShares.ts,
  today.ts, api.ts, statusModel.ts, unknownQueue.ts and the five test
  files): exit 0, no output. app/scripts/seed-smoke.mjs is a .mjs file the
  config does not lint (the known hole in AGENTS.md gate 5).
- App workspace once (`cd app; npx vitest run`, redirected to a log): exit
  0; Test Files 532 passed (532); Tests 11358 passed | 1 skipped (11359);
  132.93s. No red file. No `[dynamoAdmin]` line (the only matches are the
  dynamoAdminRetry.test.ts file name and a case title).
- ASCII: `git diff -U0 5e8d6504 -- app | grep '^+' | tr ...` = 0; the two new
  files = 0. The STUCK_WHY em dash survived (count 1 in today.ts and 1 in
  todayApi.test.ts). The removed non-ASCII lines are comment lines replaced
  whole by ASCII (12 in today.ts, 3 in todayApi.test.ts). No `\u` escape in
  any touched file.
- WI9: no seed file touched.

## Notes

- Untrimmed input paths: none new (Today takes no new input).
- The Unreplied removal leaves `TODAY_UNREAD_CAP` counting only Identify
  candidates; with typed threads filtered first, a busy byUnread index costs
  the full raw walk budget per load (PR92 above) - for the S7 cost issue.
