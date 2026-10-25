# FW1 report - feat/today-checklist (tracker #31), fix wave 1

Implementer: the FW1 child (Claude Opus 5.5), 2026-10-25. Scope: exactly
FW1-1..FW1-6 of `R1-adjudications.md`. Base 8ddf72e5. Commits: c0364720
(FW1-1), 4e3a0cdc (FW1-2), b40285e8 (FW1-3), d65d8345 (FW1-4), 0b708fa1
(FW1-5 + FW1-6), then this report. Strict TDD per item: every test below
was run RED first (or, for a pin of behavior that already holds, proven
able to fail by a one-line temporary mutation run once and reverted).

## FW1-1 (R1A-2 = R1SC-1) - a failed live refetch keeps the last good load

Changed:
- `dashboard/src/routes/today/useToday.ts`: `refreshFailed: boolean` on
  TodayState (:51), omitted from TodayLoad (:63), initial false (:136); a
  good load sets it false (:159); a failed fetch keeps status 'ready', the
  last good data and sets it true when the previous status was 'ready', and
  is still status 'error' otherwise - the first-load failure is unchanged
  (:168).
- `dashboard/src/routes/today/Today.tsx`: destructures `refreshFailed`
  (default false, like the other optional fields, :408); `allCaughtUp`
  requires `!refreshFailed` (:438-439); ONE `<p role="alert">` (class
  `styles.error`, no CSS change) "We couldn't refresh Today. Reload the page
  to see the latest." first in the ready block, above the fallback line and
  every section (:461-468). The full-page error copy is unchanged.

Tests:
- NEW `dashboard/src/routes/today/Today.refetch.test.tsx` (:115, 5 cases):
  the REAL useToday under the real page (api barrel and useTodayPastTours
  mocked) - the reviewers' probes made permanent: quiet-share fold/open
  choices, a "Show all 7" expansion and the AI line's open state each
  survive one failed then one successful refetch; ONE refresh note and no
  "All caught up" while it failed, cleared by the next good load; a
  first-load failure still shows "We couldn't load your queue. Please try
  again." with no h2.
- `useToday.test.tsx` (:268, 4 cases): the hook contract - ready + last data
  + flag on a failed refetch; the next good load clears it; a first-load
  failure is 'error' with the flag false; a failed first load then a good
  refetch is ready with no flag.
- `Today.test.tsx` (:565, 4 cases): the page states - one alert above the
  first section with the rows kept; "All caught up" withheld; a rerender
  with the flag false clears the note and "All caught up" returns; the
  first-load error carries no note.

RED (before the source edit): 11 failed across the 3 files. Today.refetch:
the folded u1 read `aria-expanded="true"` (re-seeded), "expected [ ...(5) ]
to have a length of 7 but got 5", the AI line read `aria-expanded="false"`,
and the note case received "We couldn't load your queue. Please try again."
- the reviewers' reasons; its first-load pin was green. Today.test: 3x
"Unable to find an accessible element with the role "alert"" (its
first-load pin green). useToday.test: 4x "expected 'missing' to be ..."
(the state had no `refreshFailed`).
GREEN: 3 files, 68 tests; the whole `src/routes/today` dir 7 files, 130
tests; dashboard tsc 0; eslint 0.

Consumers: `git grep` of TodayState / TodayStatus / useToday in
`dashboard/src` finds only Today.tsx, its three test files and
QuietShares(.test).tsx (the QuietSharesState type only); all compile.

Existing tests changed (no assertion changed): `Today.test.tsx`
`renderToday()` now returns the render result and a new `todayTree()`
builds the same element, so a case can rerender; its mocked `state` type
gains an optional `refreshFailed`. `useToday.test.tsx`'s Probe gains a
`refresh-failed` span.

## FW1-2 (R1A-1) - one row per person

Changed `app/src/routes/today.ts`:
- `emittedIdentifyContactIds` declared beside `emittedUnknownPhones`
  (:775-787); the unread emit loop records each emitted contactId (:1034);
  the triage pass skips a contactId already emitted (:1137-1140), after the
  phone de-dupe, which stays (:1136).
- the relay opt-out block gains `optOutContactIds` (:788-795): an already
  emitted member is skipped before its reads (:815) and a member is
  recorded only when its row is emitted (:843), so a member a first group
  did not confirm is still judged by the next group.
- No comparator changed: the 5.1 order and the 5.2 oldest-first order cases
  stay green.

Tests (`app/test/todayApi.test.ts`): "an unknown contact whose NEWEST
unread thread is its email thread is listed once" (:791), "an unknown
contact with ONLY an unread email thread is listed once" (:822), "a member
opted out of TWO open relay groups is listed once" (:1388). The
phone-newest pin (:743) is unchanged and green.
RED: 3 failed, exactly the reviewer's output - expected [ 'contact:c-dupe',
'contact:c-dupe' ] / [ 'contact:c-mail', 'contact:c-mail' ] / [
'contact:c-opt', 'contact:c-opt' ] to deeply equal the single key.
GREEN: todayApi.test.ts 113 passed; todayUnmatchedNonRegression 1 passed;
eslint 0; app tsc (src and test configs) 0.

## FW1-3 (R1SC-2) - no-stamp pins for four 7.3 writers

All five pins are behavioral (each drives its real writer); no structural
pin was needed. Mutation proofs: each one-line temporary mutation was run
once RED and reverted before commit b40285e8; afterwards `git diff --quiet
-- app/src` was true and no "TEMP MUTATION" string remained.

1. Reconcile share adoption - `app/test/sendReconcile.test.ts:466`, "2h %s:
   the adoption never stamps last_reached_out_at (PIN)", x2 (a dashboard
   share, adopted automated false; an automated share), beside the
   relay-leg and retry adoption pins: the adopted row (broadcast_id,
   automated, recipient_contact_id), the record done/adopted,
   `world.reachedOutTouches` [] and no contact.updated.
   Mutation: `sendReconcile.ts` adopt(), broadcast case, + `await
   c.contacts.touchLastReachedOut(r.key, m.createdAt);` - RED 2 of 2:
   "expected [ { contactId: 't-1', ...(2) } ] to deeply equal []" (outcome
   written).
2. Broadcast with no property - `app/test/broadcastFanOut.test.ts:290`: a
   dashboard broadcast with `unitId: undefined` through the real send
   wrapper; the outbound row (broadcast_id, automated false), no touch, no
   contact.updated.
   Mutation: the fan-out send input + `...(snapshot.unitId === undefined &&
   { staffOutreach: true as const })` - the new pin RED ("expected [ {
   contactId: 'c-alice', ...(2) } ] to deeply equal []") while the existing
   unit-share pin (:272) stayed GREEN: the new pin covers a branch the old
   one cannot.
3. Quo importer - `app/test/importApply.integration.test.ts:155`: runApply
   over DynamoDB Local, then paged Scans - outbound staff texts and calls
   were written, no contact carries `last_reached_out_at`.
   Mutation: `lib/import/apply.ts` + `await
   contactsRepo.touchLastReachedOut(contactId, at);` beside
   touchLastHeardFrom - RED: "expected [ ...(6) ] to deeply equal []".
4. Reseed, lean and full - `app/test/seedProfile.integration.test.ts:168`
   (lean) and `:200` (full, its own full seed, 240 s budget like its
   sibling; it asserts a cast contact is present so it can never pass on a
   lean-only table).
   Mutation (lean): `seed/lean.ts` contact-tenant-0001 + the field - both
   pins RED ("expected [ 'contact-tenant-0001' ] to deeply equal []").
   Mutation (full only): `seed/cast.ts` contact-cast-unknown-texter + the
   field - only the full pin RED ("expected [ 'contact-cast-unknown-texter'
   ] ..."), the lean pin GREEN.
5. Performance seed - `app/test/performanceSeed.integration.test.ts:355`:
   resetPerformanceData on its lane B (the lean base plus the generated
   world), then paged Scans - outbound teammate rows exist,
   perf-contact-00001 is present, no contact carries the field.
   Mutation: `seed/performance.ts` generated contact + `last_reached_out_at:
   at(anchorMs, -MINUTE_MS)` - RED: "expected [ 'perf-contact-00009',
   ...(21) ] to deeply equal []".

GREEN after the reverts: the four whole suites 332 passed; the performance
pin 1 passed; eslint 0; app test tsc 0.
Existing test changed: `importApply.integration.test.ts` import line only
(adds ScanCommand). No assertion changed.

## FW1-4 (R1SC-3) - three more drop-off rows

`app/test/todayApi.test.ts:2715-2717`: sms_unreachable, a tenant whose
status is placed, no phone - in the existing dropOffs table.
RED-proven the same way: a one-line temporary mutation of
`isEligibleRecipient` (`app/src/lib/listingSendOutcome.ts`: the unreachable
part of :117, the placed clause :120, the phone clause :118, each dropped in
turn) turned exactly that row RED ("expected { status: 'ok', ...(2) } to
deeply equal { status: 'ok', properties: [], ...(1) }") with the other 11
rows passing; reverted, app/src unchanged.
GREEN: todayApi.test.ts 116 passed.

## FW1-5 (R1A-5) - comment only

`app/src/routes/today.ts:721-727`: the byStatus-GSI consistency residue at
the Tours to book block (a create's or a booking's single refetch can miss
the new request or still list a just-booked one until the next refetch;
PR90 / WI8 accept it; no mechanism added).

## FW1-6 (R1A-4, R1A-6, R1A-3) - docs only

- `RUNBOOK.md:563`: "Three more" becomes "Five more differences from the
  live stamps, all accepted", adding (a) shared / moved number attribution
  (live W1 / W6 stamp the phone's current holder; a reply and the backfill
  name the thread's linked contact first, the backfill a text's recorded
  recipient when it has one) and (b) PR108's transition case (a pre-deploy
  failed "Send now" row has no system_copy, so a staff Retry of it - and a
  Retry of that Retry - stamps live, while the backfill excludes it because
  the text it retried matches a "Send now" text).
- `docs/issues/today-quiet-shares-read-cost.md`: `refs` gain
  `dashboard/src/routes/today/useTodayPastTours.ts`; a new paragraph (:67)
  records the past-tours labeling cost and its scale (prod about 23 rows at
  design time: about 23 + 23 reads per mount and about 23 per
  `tour.updated`; the review's 60-row probe: 60 + 60 and 60) and that spec
  5.3 accepts it. `npm run issues` exit 0 (the frontmatter parses; INDEX.md
  is gitignored).

## Gates (after the last code commit, 0b708fa1)

- `npm run typecheck` (bare, root): exit 0, all 5 workspaces.
- App (`cd app; npx vitest run`): exit 0; Test Files 533 passed (533);
  Tests 11402 passed | 1 skipped (11403); 145.10 s; no `[dynamoAdmin]`
  line. Before: 11389 + 1 skipped; +13 = FW1-2 3, FW1-3 7, FW1-4 3.
- Dashboard (`cd dashboard; npx vitest run`): exit 0; Test Files 269 passed
  (269); Tests 5557 passed (5557); 61.54 s. Before: 268 / 5544; +1 file,
  +13 cases.
- eslint on the 12 .ts/.tsx files FW1 touched (`git diff --name-only
  --diff-filter=d 8ddf72e5..HEAD`): exit 0, no output. useTours.ts was not
  touched.
- ASCII: 0 non-ASCII bytes on every added line and in the new test file; no
  new `\u` escape (sendReconcile.test.ts keeps its 3).
- e2e: `run-spec.sh fw1` (cold boot, lane 12, fresh dashboard build at
  0b708fa1; today-checklist, today-past-tours, unknown-caller-triage,
  unknown-inactive, relay-number-lifecycle): exit 0, "14 passed (1.1m)".
  Then `npm run e2e:stop` exit 0 ("no running session found"); no listener
  on 10201 / 10211 / 10221 / 10231; session.pid gone.

## Found that the adjudication did not cover

1. FW1-2 display residue: after the de-dupe the surviving Identify row for
   an unknown contact whose newest unread thread is an EMAIL thread is the
   unread pass's row, whose `who` is `whoOfConversation` (today.ts:1345):
   the contact's name, else the thread's participant_display_name, else the
   participant phone. For an unnamed contact on an email thread with no
   display name that is '' (pre-existing and documented: "email-only
   threads carry neither -> ''"), where the dropped triage duplicate showed
   the contact's phone or id. Narrow - an email thread usually carries a
   display name (`createOrGetByParticipantEmail` sets it when known). Not
   changed (scope); a fallback to the owner's phone in whoOfConversation
   would close it.
2. Today's `settling` spinner rule (Today.tsx:442) does not read
   `refreshFailed`: if a refetch fails while past tours are still loading
   on an otherwise empty page, the spinner shows beside the note until past
   tours settle. Harmless; left as is.
