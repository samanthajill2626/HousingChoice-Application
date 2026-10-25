# FW2 report - feat/today-checklist (tracker #31), fix wave 2

Implementer: the FW2 child (Claude Opus 5.5), 2026-10-25. Scope: exactly
FW2-1..FW2-3 of `R2-adjudications.md`. Base d102b5d3. Commits: 60944742
(FW2-1), a5ef2e2b (FW2-2), dee4f5ed (FW2-3), then this report. Strict TDD
per item: every new test was run RED first, for the reason stated below.

## FW2-1 (R2-1) - the triage pass merges into the one Identify row

Changed `app/src/routes/today.ts`:
- `emittedIdentifyContactIds` (a Set) becomes `emittedIdentifyRows`, a Map
  contactId -> { row, ownerResolved } (:782-789); the unread emit loop builds
  the Ranked row, pushes it and records it with `ownerResolved: owner !==
  undefined` (:1037-1051).
- The triage pass's skip becomes a MERGE (:1136-1148): `mergeIdentifyRow`
  (:1368-1399, with `EmittedIdentifyRow`) changes only `who` and the rank;
  refId, link, why and attention stay the unread row's.
  - who: an unresolved owner takes the contact's name (what a successful
    read shows), else keeps its thread-derived label; a still-blank who takes
    the triage row's label - name, else formatted phone, else the id.
  - rank: +Infinity takes createdAtRank(contact). The sort runs after both
    passes, so the field update is enough.
- The merge runs BEFORE the phone de-dupe (now :1149-1154), so a PHONE-thread
  row whose owner read failed is ranked too. No row is added or dropped: a
  contact the unread pass emitted was already suppressed (by phone or by id)
  before this change, and the phone de-dupe still governs every other contact.

Tests (`app/test/todayApi.test.ts`, describe "one Identify row per person,
merged (fix wave 2, R2-1)", :847):
- :895 R2's probe 1 (FW1-2's c-dupe fixture, email thread newest): the whole
  row pinned, who '(555) 010-8888'.
- :921 R2's probe 2 (c-old 'Olda' 2026-01-01 on an unread email thread, read
  failing once; c-new 'Newt' 2026-06-01): [refId, who] pinned as
  [c-old 'Olda'], [c-new 'Newt'], plus a failed-read count of 1 as the
  positive control.
- :943 the same on a PHONE thread (pins the merge-before-phone order).
- :965 an unresolved owner with no name keeps its thread display name
  ('Mae Mid', not the contact's phone) and still ranks by created_at.
RED (before the source edit): 4 failed, 116 passed - probe 1 "who": "" vs
"(555) 010-8888"; probe 2 received [ ['c-new','Newt'], ['c-old',''] ]
(R2's reason); the phone case [ ['c-new','Newt'], ['c-old','(555)
039-0001'] ]; the display-name case [ ['c-new','Newt'], ['c-mae','Mae Mid']
] (order only).
GREEN: todayApi.test.ts 120 passed; with todayUnmatchedNonRegression,
contactSoftDelete and aiRunVerdicts (the other /api/today suites) 4 files /
210 passed; app tsc (src, scripts, test) 0; eslint 0. FW1-2's tests (:743,
:791, :822 and the relay opt-out case, now :1541) are unchanged and green.

## FW2-2 (R2-2) - per-viewer state above the branches

Design picked: LIFT, with Quiet shares kept mounted.
- `dashboard/src/routes/today/TodaySection.tsx`: `ListExpansion` (:48);
  LimitedList's optional `expansion` prop (:66) makes it controlled
  (:79-81, the button calls `toggle`, :100); without it the list keeps its
  own state exactly as before (TodaySection.test is untouched).
- `dashboard/src/routes/today/Today.tsx`: one `expandedLists` Set keyed by
  the section label (unique on the page) and `expansionOf(label)` (:440-455);
  passed to every list on the page - Needs you now, Identify, Past tours,
  Tours to book, Relay groups to close, Placements (:526-560), Tours today
  and AI suggestions through AtAGlance (:376, :392, :417). Quiet shares is
  always rendered, `hidden={fallback}` (:546), instead of `fallback ? null`.
  The Tours to book slot (UnavailableSection vs ItemsSection) is unchanged:
  no state lives in it any more.
- `dashboard/src/routes/today/QuietShares.tsx`: `hidden` prop (:148); while
  hidden no properties are read (:152, so nothing seeds) and nothing renders
  (:169); its property-list Show all is its own `expanded` state (:158),
  passed as the list's expansion (:196). The seed and openByUnit stay where
  they were.

Why this design: every transition R2 named unmounts the LimitedList itself -
Tours to book swaps component types, Quiet shares' unavailable branch has no
list, and the fallback empties Tours to book, Relay groups to close and AI
suggestions (ItemsSection and the Relay slot render nothing on an empty
list). "Keep the components mounted" therefore still loses the expansion
unless each owner also holds it - ItemsSection, PastToursSection, AtAGlance
(two lists), Quiet shares, and the inline Relay slot, which would first have
to become a component. Holding it above the list is one optional prop on
LimitedList plus one Set in Today. Quiet shares is
the exception the adjudication named: its seed and choices are its own logic
(QuietShares.test drives them standalone), so it stays mounted (three lines)
rather than moving the seeding rule into Today.

Visible behavior otherwise unchanged: the unavailable copy (role="alert"
"We couldn't load tours to book." / "We couldn't load quiet shares."), the
fallback's single "Some sections can't load right now." line with no
per-section alert and no Quiet shares (spec 2.5, 3.1 - asserted during the
fallback load in the new probe 3), the first-arrival seeding rule (spec 6.3),
"Show all N" / "Show fewer", the FW1-1 refresh note. By construction an
expansion now also survives a section that empties and later refills (spec
2.1: lost only on reload).

Tests (`dashboard/src/routes/today/Today.refetch.test.tsx`, describe "Today
across a live refetch that drops a section (fix wave 2)", :252; the REAL
useToday, each case waiting on the dropped load's own copy and then its
absence, getToday x3):
- :253 Tours to book: Show all 7 survives one unavailable refetch.
- :278 Quiet shares: "Show all 7 properties" survives one unavailable refetch.
- :297 Quiet shares: open/folded choices survive one FALLBACK refetch (a 404).
- :321 Show all on Tours to book, Quiet shares and Relay groups to close
  survives one FALLBACK refetch (the expansion half of the fallback clause).
RED: 4 failed, 5 passed - "expected [ ...(5) ] to have a length of 7 but got
5" (Tours to book), "expected [ <button ...(5)>...(3)</button>, ...(4) ] to
have a length of 7 but got 5" (Quiet shares), toHaveAttribute("aria-expanded",
"false") received aria-expanded="true" (12 Oak St re-seeded) - R2's three
reasons - and the fallback Show all case "expected [ ...(5) ] to have a
length of 7 but got 5".
GREEN: the `src/routes/today` dir 7 files / 134 passed; dashboard tsc 0;
eslint 0.

Existing test changed (no assertion changed): Today.refetch.test.tsx's api
barrel mock gains `getAllPlacements`, `getAllConversations` and `getTours`
(:17-28), reset to resolve [] in beforeEach (:117-119), so a 404 can reach
the real fallback.

## FW2-3 (R2-3) - the fallback lists one Identify row per contact

`dashboard/src/routes/today/buildToday.ts`: an `identifyRefIds` Set (:261);
an unknown_1to1 thread whose refId was already emitted is skipped (:279-281),
so the first thread in the fallback's own order wins; copy and the
every-thread rule unchanged (spec 3.1). Header comment updated (:12-14).
Test: `buildToday.test.ts:167` - a contact with a phone thread and an email
thread is ONE identify row, in both input orders (the first thread's `who`
wins: '(404) 010-0007', then 'Dee Mail').
RED: 1 failed - "expected [ [ 'contact:ct-1', ...(1) ], ...(1) ] to deeply
equal [ Array(1) ]" (two contact:ct-1 rows, R2's reason).
GREEN: buildToday.test.ts 24 passed; the today dir 7 files / 135 passed;
dashboard tsc 0; eslint 0.

## Gates (after the last code commit, dee4f5ed)

- `npm run typecheck` (bare, root): exit 0, all 5 workspaces.
- App (`cd app; npx vitest run`): exit 0; Test Files 533 passed (533); Tests
  11406 passed | 1 skipped (11407); 152.50 s; no `[dynamoAdmin]` line.
  FW1: 11402 + 1 skipped; +4 = FW2-1.
- Dashboard (`cd dashboard; npx vitest run`): exit 0; Test Files 269 passed
  (269); Tests 5562 passed (5562); 61.53 s. FW1: 5557; +5 = FW2-2 4, FW2-3 1.
- eslint on the 8 .ts/.tsx files FW2 touched (`git diff --name-only
  --diff-filter=d d102b5d3..HEAD`): exit 0, no output. useTours.ts was not
  touched.
- ASCII: 0 non-ASCII bytes on every added line; no new `\u` escape. The
  pinned em dashes (today.ts, buildToday.ts 'New inbound ... untriaged') are
  untouched.
- e2e: `run-spec.sh fw2` (cold boot, lane 12, fresh dashboard build of the
  clean tree at dee4f5ed; today-checklist, today-past-tours,
  unknown-caller-triage, unknown-inactive, tours-page): exit 0, "14 passed
  (32.4s)". Then `npm run e2e:stop` exit 0 ("no running session found"); no
  listener on 10201 / 10211 / 10221 / 10231; no session.pid.

## Found that the adjudication did not cover

1. FW2-1 `who` - one reading, stated so it can be judged. The adjudication
   reads "(nameFromContact(contact), else the formatted contact phone)" for a
   blank OR unresolved row. For an unresolved owner whose contact has NO name
   but whose kept thread has a label (an email display name, or the thread's
   own phone), the code keeps that label instead of replacing it with the
   contact's phone: that is exactly what the same row shows when the read
   succeeds (whoOfConversation ranks the display name above the phone), so a
   transient read failure no longer changes the row text. Pinned by
   todayApi.test.ts:965; flipping it is the one `liveName ?? row.item.who`
   line in mergeIdentifyRow.
2. FW2-1 blank label with no name and no phone (an email-only unknown whose
   thread has no display name - FW1-2's c-mail fixture): the adjudication's
   rule has no value there, so the merge uses the triage row's own last
   resort, the contactId - what that person's triage row showed before FW1.
   The contact's email is never used as a Today label (neither row ever did);
   a better label would be a new display rule. Handback note.
3. FW2-1 phone-thread form: the order defect also hit an unresolved owner on
   a PHONE thread (the phone de-dupe skipped its triage row since the spec 5.2
   created_at order landed, before FW1). Running the merge before the phone
   de-dupe closes it with no new mechanism (todayApi.test.ts:943).
4. FW2-2 is wider than its two named transitions: on the fallback, Relay
   groups to close and AI suggestions lose their expansion as well (their
   lists empty), and any section that empties and refills did too. The lift
   covers every list on the page. The AI line's open state already survived
   (AtAGlance stays mounted).
5. FW2-3: the refId key also collapses two threads with no contact id on the
   same phone (the Unknown-list ref) - they shared one React key as well.
