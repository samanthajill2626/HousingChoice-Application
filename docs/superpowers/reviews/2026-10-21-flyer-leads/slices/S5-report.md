# S5 slice report - flyer-leads (Tasks 5.1-5.3; worklist OR-1..OR-4)

Branch feat/flyer-leads. Commits, oldest first: 2a1cf758 (Task 5.1),
88e674f9 (Task 5.2), fb1e4aad (Task 5.3). They sit directly on S4b's report
commit c78283c4. Findings only; code cited by `file:line` at fb1e4aad.

## Contract deviations

None against plan 1.1 / 2.7, AR9 or the worklist. As built:
- dashboard/src/api/types.ts:2935 `'signed_up'` ends `TimelineMilestoneType`;
  :3155 `ListingSendOutcome` adds `'signed_up'`. Edited on top of S2's OR-7
  comments (:2570-2613), which are untouched.
- dashboard/src/routes/contact/Timeline.tsx:465 `milestoneVariant` files
  `signed_up` with the green family (`styles.green`, AR9 #3). No change to
  `milestoneHref` or `MilestonePin`: a refType `unit` pin links to
  `/listings/<unitId>`, a ref-less pin renders plain.
- dashboard/src/routes/contact/Card.tsx:
  - :274-276 the chip `Signed up` (`chipPositive`);
  - :351 `sentWords`, :371 `{sentWords} {sent.label}` - "Signed up from the
    flyer <date>" with the same `formatHeardFrom` label and title as
    "Sent <date>";
  - :357 `actionable` (no_reply / replied / signed_up) replaces `waiting`,
    used at :358 (Interested), :392 (Request a tour, still host-gated) and
    :402 (Not interested). The Undo gate is unchanged.
- dashboard/src/routes/listing/listingFormat.ts:352 `groupSendRows`: an
  eligible `signed_up` row files under Interested, else Not eligible; the
  `recipientMissing` rule above it still wins.
- No endpoint change (AR9 #2): dashboard/src/api/endpoints.ts:1179-1188 and
  :1530-1539 return rows as-is (PIN in endpoints.test.ts).

## Plan corrections

- Task 5.3 step 3c, the `ListingSendRow.tenantName` comment: the plan's text
  says "only the property Sent to rows carry it". The outcome route's
  `{ row }` answer carries it too - it is re-projected through
  app/src/routes/units.ts:287 `recipientLabelOf` - and the contact page
  applies that answer to its Properties sent row
  (dashboard/src/routes/contact/ContactDetail.tsx:705-708). The comment
  (dashboard/src/api/types.ts:3159-3165) says "attached only by the units
  recipients read and the outcome route's `{ row }` answer - the contact
  listings-sent read never carries it", mirroring the app wire comment
  (app/src/repos/listingSendsRepo.ts:137-144). Comment-only; the rest of
  the plan's text (formatted phone, AR13, absent when unresolved or with
  neither name nor phone) is kept. Nothing on the contact page reads
  `tenantName` (the one reader is ListingDetail.tsx:1343).
- Exit check step 4: the plan's log line is `echo "exit=$?"`; the brief and
  OR-4 bind `EXIT:$?`, which was used.
- OR-1: every S5 block was already at its target indent and was used
  verbatim. Every quoted anchor matched exactly once; no anchor, count or
  compile fix was needed. OR-2: `grep -F '\u'` over the added lines of all
  11 files finds no hit.
- Counts, each RED for the plan's stated reason:

  | Task | RED | GREEN |
  |---|---|---|
  | 5.1 | 2 failed / 164 skipped; typecheck TS2322 x2 (Timeline.test.tsx) | 1 file, 166 tests |
  | 5.2 | 7 failed / 251 passed (2 files failed, 2 passed); typecheck TS2322 x2 | 4 files, 258 tests; host regression (files.test.tsx, ListingDetail.test.tsx) 2 files, 189 tests |
  | 5.3 | 2 failed / 177 skipped; the AR13 PIN 1 passed alone | 2 files, 179 tests |

  - 5.1 RED: both `expected '_evt_c819bb _neutral_c819bb' to contain
    'green'`; the href assertion ahead of it passed (the generic unit link).
  - 5.2 RED: the 6 SendRosterRow cases and the ContactDetail case, each a
    TestingLibraryElementError (no "Signed up from the flyer" text, no
    "Signed up" chip, no Interested / Not interested button); the endpoints
    and FollowUpView PINs passed.
  - 5.3 RED: listingFormat `[ 'waiting', [ 'su-ok' ] ]`; ListingDetail
    `[ 'Waiting', 'Not eligible' ]`.
- Exit check (logs under .superpowers/sdd/):
  - the 8 slice files: 658 tests, EXIT:0 (S5-slice-files.log);
  - `npm run typecheck` (all five workspaces): EXIT:0 (S5-typecheck.log);
  - eslint on the 11 S5 files (exactly `git diff --name-only
    --diff-filter=d c78283c4..HEAD`): one error, the pre-existing one below
    (S5-eslint.log; baseline S5-eslint-baseline.log);
  - the FULL dashboard suite (background, `timeout 1200`,
    S5-dashboard-suite.log): `Test Files 264 passed (264)`,
    `Tests 5383 passed (5383)`, `EXIT:0`, 61.29 s - S2's 5369 plus S5's 14
    cases. No failure and no unhandled error.

## Risks and residuals

- OR-26b, as built (for Cameron): the row words key on the OUTCOME only
  (dashboard/src/routes/contact/Card.tsx:351). A flyer-latest pair that a
  decline, tour or reply outranks reads "Sent <date>" with the SIGN-UP date,
  for a property that may never have been texted. Spec D8 defines the words
  for `signed_up` only.
- AR9 #1, pinned: a Follow up Undo answered `signed_up` un-resolves the row
  (dashboard/src/routes/broadcasts/FollowUpView.tsx:83-85). Until the next
  load it shows its served waiting display - "No reply yet, N days",
  counted, with its actions (FollowUpView.tsx:128).
  `FollowUpItem.outcome` shares the union (dashboard/src/api/types.ts:3737),
  so the type admits `signed_up` on a served item, which the server never
  sends (D8, isWaiting).
- The derivation is type-blind (AR7 #3), so a pair keeps reading
  `signed_up` after staff re-type its contact. The row's actions follow the
  contact's CURRENT type:
  - `interestedSupported` (tenant) gates Interested;
  - the property page passes `requestTourTo` for a partner only
    (dashboard/src/routes/listing/ListingDetail.tsx:1359-1362);
  - so a re-typed partner's signed_up row offers Request a tour and Not
    interested, and a landlord's offers Not interested.
- Two nameless-contact labels differ by surface, unchanged by S5 (S3's
  note): the Sent to card shows the server's FORMATTED phone
  (ListingDetail.tsx:1343, the identity link and the action names), while
  Follow up's `name` is the RAW stored phone (app/src/services/followUps.ts:87-91).
- Watch (plan 9 E): the contact page's Schedule a tour default is
  `listingsSent.rows[0]` (dashboard/src/routes/contact/ContactDetail.tsx:1436,
  the newest sentAt). A flyer sign-up moves sentAt (D7), so the signed-up
  property becomes that default.
- D10: S5 stores no typed input. It renders the server's labels verbatim;
  no untrimmed path was found in the surfaces it touched.

## Pre-existing lint

dashboard/src/routes/contact/Timeline.tsx:1621:7
`react-hooks/set-state-in-effect` on `setNow(fresh);` - not S5's. The same
file at c78283c4 reports it at 1618:7 (stdin baseline); Task 5.1's three
added lines moved it. The other 10 S5 files lint clean.
