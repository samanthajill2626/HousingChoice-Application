# R3 code review - feat/today-checklist (tracker #31)

Reviewer: R3 (fresh; Claude Opus 5.5), 2026-10-24. Tree `W:\tmp\today-checklist`,
branch `feat/today-checklist`, HEAD 03f9727f, base main @970a29b9. Contract:
spec r8 (`docs/superpowers/specs/2026-10-23-today-checklist-design.md`). Inputs
read: R1-spec-conformance.md, R1-adversarial.md, R1-adjudications.md,
FW1-report.md, R2-review.md, R2-adjudications.md, FW2-report.md, the FW2 diff
package (d102b5d3..03f9727f) and the live source of `app/src/routes/today.ts`,
`dashboard/src/routes/today/{Today,QuietShares,TodaySection}.tsx`,
`{useToday,useTodayPastTours,buildToday}.ts` and `dashboard/src/routes/tours/useTours.ts`
(usePastTours).

Method: every finding was reproduced with a throwaway test that FAILED on the
current code, run bare from its workspace (`cd W:/tmp/today-checklist/dashboard
&& npx vitest run src/routes/today/<file>`; `cd W:/tmp/today-checklist/app &&
npx vitest run test/<file>`), quoted here, then deleted. Verdicts on the FW2
items rest on the committed tests, two extra verification probes and one
mutation check (a throwaway mutant COPY of today.ts swapped in with `vi.mock`;
no existing file was edited). No suite, e2e session or dev server was started;
nothing was committed. At the end `git status --short` lists only this record.

Counts: HIGH 0, MEDIUM 0, LOW 1, INFO 2. Nothing loses, duplicates, strands or
misdirects a send.

---

## 1. What R2 missed

### R3-1 - LOW - CONFIRMED - "All caught up" while past tours could not be refreshed and their last good load listed nothing

Location:
- dashboard/src/routes/today/Today.tsx:483-484 (`allCaughtUp` reads
  `!refreshFailed` and `past.status === 'ready' && past.rows.length === 0`, never
  `past.reloadFailed`)
- dashboard/src/routes/today/Today.tsx:316 (`if (past.rows.length === 0) return
  null;`) ahead of :332-336 (the "Could not refresh past tours" note), so an
  empty section never shows its own reload failure
- dashboard/src/routes/today/useTodayPastTours.ts:199 (a failed reload returns
  `status: 'ready'`, the last labeled rows and `reloadFailed: true`);
  dashboard/src/routes/tours/useTours.ts:333-335 (the reload failure keeps the
  same `past` array, so the labeling effect at useTodayPastTours.ts:167-178 does
  not re-run)

Behavior: Today is empty and reads "All caught up". A tour is marked toured
(it now needs an outcome) and emits `tour.updated`; both hooks refetch. Today's
own refetch succeeds; the past-tours reload fails (any getTours error). The
past-tours hook keeps its empty rows and sets `reloadFailed`, the section is
not rendered (no rows, so no note), and the page keeps claiming "All caught up"
with nothing on screen saying a section could not be read - until the next
tour event or a reload. The tour that needs an outcome is exactly what the
section exists to show.

Why wrong: spec 2.3 ("A section that failed to load is not empty: it shows its
own error, and the page does not claim 'All caught up'"), and the rule fix wave
1 adopted for Today's own refetch (R1-adjudications FW1-1: "spec 2.3: an
unknown state is not 'done'"; Today.tsx:483 `!refreshFailed`). The past-tours
reload is the same unknown state, on the section that the new subtitle ("Clear
every section above the line and today's checklist is done") makes a promise
of. Pre-existing on main (970a29b9 Today.tsx:273 `noPastTours = past.status ===
'ready' && past.rows.length === 0`, same shape) - but the branch's FW1-1 rule
now makes the page withhold "done" for one refresh failure and assert it for
the other. R2 swept FW1-1's rule and the refresh note, not this sibling.

Evidence:
- dashboard/src/routes/today/zz-r3-1.test.tsx (deleted), the page with mocked
  hooks (Today.test.tsx's pattern) - a control case with Today's own
  `refreshFailed`, then the past-tours case:

      v control: Today's own failed refresh withholds All caught up (FW1-1)
      x a failed past-tours reload (nothing listed before it) also withholds All caught up and says so
        -> expected document not to contain element, found <p class="_emptyTitle_de976c">
           All caught up </p> instead      (zz-r3-1.test.tsx:46:53)
      Tests  1 failed | 1 passed (2)

- dashboard/src/routes/today/zz-r3-1b.test.tsx (deleted), the REAL useToday
  and the REAL useTodayPastTours (api barrel mocked: getToday answers an empty
  queue, getTours answers [] and then rejects 503; every useEventStream
  subscriber hears one `tour.updated`; the test waits for the extra getTours
  call and the second getToday):

      x R3-1 with the real hooks > a failed past-tours reload after an empty load: All caught up is withheld
        -> expected document not to contain element, found <p class="_emptyTitle_de976c">
           All caught up </p> instead      (zz-r3-1b.test.tsx:59:53)
      Test Files  1 failed (1)
           Tests  1 failed (1)

Fix: in Today.tsx, `allCaughtUp` also requires `!past.reloadFailed`, and
PastToursSection renders its heading plus the existing "Could not refresh past
tours. Reload the page to see the latest." note when `past.reloadFailed` is set
even with no rows (move the `rows.length === 0` return below that check). Pin
both with the probe above (mocked hook) and keep the existing rows+note case
(Today.test.tsx:874).

---

## 2. The FW2 diff, reviewed cold

### R3-2 - INFO - CONFIRMED - FW2-3's fallback de-dupe ("first thread wins", keyed by refId) can keep a blank row and can merge two people

Location: dashboard/src/routes/today/buildToday.ts:261 and :279-281 (the
`identifyRefIds` skip), :287 (`who: conversationWho(conv)`), :96-105
(`conversationWho` yields '' for a thread with no display name and no phone),
:122-129 (`contactRefId` falls back to `unknown?phone=` + the encoded phone, ''
for an email thread).

Behavior:
- (a) A contact whose FIRST thread in the fallback's order (newest activity
  first) is an email thread with no display name gets ONE row whose `who` is
  '', although the dropped phone thread names them by phone. This is R2-1's
  blank-row shape, which fix wave 2 closed on the server by MERGING (FW2-1),
  reintroduced on the fallback by SKIPPING. Before FW2-3 the person had two rows
  (one blank, one named); now the only row can be blank.
- (b) Two different people on unknown_1to1 email threads that carry neither a
  participant contact id nor a phone both key as `unknown?phone=` and collapse
  into one row (the second person's name disappears). Such threads exist when
  an email thread is minted without a contact (conversationsRepo.ts:1428-1433
  writes `participants` only when `opts.contactId` is given); how often they
  reach a fallback load is not verified. FW2-report item 5 names only the
  same-PHONE collapse, which is benign (one Unknown-list link).
The fallback runs only when GET /api/today 404s (effectively dead in prod),
hence INFO.

Why wrong: R2-adjudications FW2-1 (a person's one Identify row must name them,
spec 5.2 "who + ..."); spec 3.1 keeps the fallback's copy and unread rule, not a
rule that drops a name or a person.

Evidence: dashboard/src/routes/today/zz-r3-2.test.ts (deleted), pure
`buildTodayFromSources`:

    x a contact whose FIRST thread is an email thread with no display name is still named (its phone thread names it)
      -> expected [ [ 'ct-1', '' ] ] to deeply equal [ [ 'ct-1', '(404) 010-0007' ] ]
    x two DIFFERENT people on unlinked email threads (no contact id, no phone) are two rows
      -> expected [ 'Ana Mail' ] to deeply equal [ 'Ana Mail', 'Bo Mail' ]
    Tests  2 failed (2)

Fix: keep the first row but, when a later thread of the same refId has a
non-blank `who` and the kept row's is blank, take it (the server's merge rule,
in miniature); and do not de-dupe a refId that names no one (`unknown?phone=`
with an empty phone) - key those by conversationId instead. Or record both as
accepted fallback residue. Add case (a) beside buildToday.test.ts:167 (its
email thread carries a display name, so it cannot see this).

### R3-3 - INFO - CONFIRMED - FW2-2 makes the AI line remember "Show all" across a close and re-open

Location: dashboard/src/routes/today/Today.tsx:417 (`expansion={expansionOf(AI_LABEL)}`,
added by FW2-2) with :410-420 (the list mounts only while `aiOpen`) and
:445-455 (the page-level `expandedLists` Set, never reset).

Behavior: open the AI line, press "Show all 7", close the line, open it again:
it now opens with all 7 rows and "Show fewer". Before FW2-2 the list's own
state was dropped with the list, so every open started at 5 rows. A close and
re-open is a viewer action, not a live refetch, so it is outside what R2-2 and
FW2-2 set out to preserve; FW2-report item 4 does not mention it.

Why it matters: spec 2.4 ("Opening it shows the rows with the same 5-row limit
and Show all") reads most naturally as "each open starts at five"; spec 2.1
("per-viewer page state, lost on reload") can also be read to allow it. A
side effect nobody adjudicated, so it is recorded as a decision rather than a
defect.

Evidence: dashboard/src/routes/today/zz-r3-3.test.tsx (deleted), 7 AI rows,
mocked useToday:

    x R3-3 AI line re-open > re-opening the AI line shows the first 5 again, as the first open did
      -> expected [ ...(7) ] to have a length of 5 but got 7      (zz-r3-3.test.tsx:52:53)
    Tests  1 failed (1)

Fix (if each open should start at five): clear the AI_LABEL entry when the line
closes (AtAGlance's toggle), which keeps the refetch survival (aiOpen already
outlives every refetch because AtAGlance stays mounted). Otherwise state the
behavior in the Today.tsx header and pin it.

### Line-by-line notes on the FW2 diff (no further finding)

- today.ts:781-789, :1037-1051 (unread emit). `emittedIdentifyRows` is keyed by
  `oneToOneContactId(conv)`, the same id `unreadRowKeyOf` dedupes on (:1420-1425),
  so the unread pass records at most one row per contact; only the triage pass
  reads the Map. The pushed `Ranked` object is the one the Map holds, so a merge
  is visible to `identify.sort(byUrgency)` (:1298), which runs after both passes.
- today.ts:1144-1148 (merge) sits after the status check (:1113) and the
  group-detection belt (:1135), so a stub or a non-needs_review row never
  merges; before the phone test (:1154). For a contact the unread pass emitted,
  the old code skipped it either way (by phone or by id), so no row is added or
  dropped - the FW2-report claim holds.
- today.ts:1390-1399 (`mergeIdentifyRow`) never yields '': the last resort is the
  contactId and `formatPhoneForDisplay('')` is undefined (lib/phone.ts:73-77).
  The rank is replaced only when it is +Infinity.
- `ownerResolved` is an equivalent mutant except under a rename landing between
  the point read and the triage GSI read: for a resolved owner,
  `whoOfConversation` already returns `nameFromContact(owner)` first
  (today.ts:1359-1366), which is what `liveName` would add. Harmless; no test can
  pin it; no change needed.
- TodaySection.tsx:69-81: the controlled/uncontrolled switch is per render
  (`expansion?.expanded ?? ownExpanded`); every Today list passes `expansion`,
  TodaySection.test.tsx keeps the uncontrolled path. Labels are unique on the
  page (eight in the lifted Set, Quiet shares its own), so no two lists share an
  expansion.
- QuietShares.tsx:151-179: while `hidden`, `properties` is NO_PROPERTIES, so the
  seed cannot fire on a fallback load; the seed, `openByUnit` and `expanded`
  outlive an unavailable or hidden render because the component stays at its
  slot (Today.tsx:546).
- Tests can fail: FW2-1's four cases were RED before the fix (FW2-report) and
  the merge placement is pinned (mutation check below); FW2-2's four cases each
  wait for the dropped load's own copy and then its absence and assert getToday
  x3, so a missed refetch cannot pass; FW2-3's case asserts the single row in
  both input orders.

---

## 3. Challenges to adjudications and fixer divergences

FW2-report "Found that the adjudication did not cover":
1. Unresolved, nameless owner keeps its thread label (not the contact's phone):
   AGREE - it is what a successful read shows (whoOfConversation ranks the
   display name above the phone, today.ts:1359-1366), so a transient read
   failure no longer changes the row text; pinned by todayApi.test.ts:965.
2. No name and no phone -> the contactId: AGREE - it is the pre-FW1 triage row's
   own last resort (today.ts:1156); using the email would be a new display rule,
   and spec 5.2 says "Row text unchanged".
3. Merge before the phone de-dupe: AGREE - it closes the order defect for an
   unresolved owner on a PHONE thread with no new mechanism, and the committed
   case pins it (mutation M1 below).
4. The lift covers every list: AGREE with the mechanism (one optional prop and
   one Set; holding the state in each owner would have needed five owners);
   DISAGREE that it is free of side effects - it also changed the AI line's
   re-open, which is not a refetch (R3-3).
5. The refId key also collapses two no-contact threads on one phone: AGREE for
   that case (one Unknown-list link); DISAGREE with the key and the pick as a
   whole - `unknown?phone=` with no phone also collapses two different people,
   and "first thread wins" can keep a blank row (R3-2).

R2-adjudications:
- FW2-1 (merge, not skip): AGREE; verified real (section 4).
- FW2-2 (state above the branches): AGREE; verified real (section 4).
- FW2-3 ("first thread in the fallback's own order wins"): PARTLY DISAGREE -
  the server's merge reasoning that the same adjudication document applied in
  FW2-1 (one row that still names the person) applies here too; INFO only
  because the fallback is dead in prod (R3-2).
- Not changed (GSI propagation note to the handback; the perf terminal contract;
  the phone de-dupe as a handback note): AGREE. On the phone de-dupe: the owner
  test (spec 5.2) actually NARROWS its reach on this branch - a phone is
  recorded only from an emitted unread row, so a tenant's or team member's
  thread no longer suppresses a needs_review contact on the same number.
- R1 no-change rulings (R1A-3, R1A-4, R1A-6, R1SC-4) and FW1-5: AGREE, as R2 did;
  nothing new bears on them.
- FW1-1 scope, once more: R2 extended it to unavailable and fallback refetches;
  it still stops short of the past-tours reload (R3-1), the same "unknown state
  is not done" rule on its sibling.

---

## 4. FW2 verdicts

- FW2-1 (R2-1): REAL. The committed cases (todayApi.test.ts:895, :921, :943,
  :965) pass (the file: 120 passed). A mixed-world probe
  (app/test/zz-r3-v2.test.ts, deleted) - merged rows with resolved and
  unresolved owners on phone and email threads, a triage-only contact and an
  orphan thread - PASSED with the expected order and labels:
  `[c-b '(555) 040-0002'], [c-c 'Cal'], [c-a 'Ann'], [c-e 'Eve'], [c-d-orphan '(555) 040-0004']`.
  Mutation M1 (a throwaway copy of today.ts with the merge moved AFTER the
  phone test, swapped in by `vi.mock` from app/test/zz-r3-m1.test.ts, both
  deleted) turned the committed phone-thread case RED:
  `expected [ [ 'c-new', 'Newt' ], ...(1) ] to deeply equal [ [ 'c-old', 'Olda' ], ...(1) ]`.
  Residue (pre-existing, not raised): a resolved owner with no name on an email
  thread with no display name still reads '' when the triage read does not
  return the contact (past its 100 cap) - R2's cheaper partial fix
  (whoOfConversation falling back to the owner's phone) would close it.
- FW2-2 (R2-2): REAL. The committed cases pass (Today.refetch.test.tsx with
  buildToday, TodaySection and QuietShares: 4 files, 59 passed). A
  verification probe (dashboard/src/routes/today/zz-r3-v1.test.tsx, deleted) -
  Identify and Placements Show all, the AI line's open state and the Quiet
  shares choices across a 404 fallback that lists its OWN Identify row; and a
  Quiet shares section first seen empty, then unavailable, seeding on the first
  load that lists a property - PASSED (2 passed). Side effect: R3-3.
- FW2-3 (R2-3): REAL for what R2-3 raised (one row and one React key per
  contact; buildToday.test.ts:167 passes), with the residue R3-2.

---

## Swept, no finding

- Today route Identify: type filter, deleted skip and owner test all ahead of
  the unread cap; one kept thread per contact; unlinked threads deferred to the
  triage pass (their phone is not recorded, today.ts:1031-1036); the triage read
  hides soft-deleted contacts (contactsRepo.ts:1422-1428) and projects ALL, so the
  merge reads a live, named contact; ordering ties by refId with +Infinity last
  (`a.at !== b.at` guards Infinity - Infinity); the 100 + 100 caps; the relay
  opt-out one-row-per-member set (FW1-2). An unnamed person's label follows the
  per-source rules of spec 5.2 (their newest unread thread's display name, else
  the contact's phone - zz-r3-v2's c-b), unchanged by the fix waves.
- Dashboard transitions walked against the current code: good -> failed -> good
  (FW1-1; the abort checks at useToday.ts:158, :161 let only the newest request
  set or clear `refreshFailed`); ok -> unavailable -> ok for Tours to book (the
  slot still swaps UnavailableSection / ItemsSection, but no state lives there)
  and Quiet shares (always mounted); server -> fallback -> server (Quiet shares
  hidden, AtAGlance and its aiOpen always mounted, every list's Show all
  lifted); a section emptying and refilling (lifted Set; Quiet shares keeps
  `seeded`, so a refill opens nothing new, and a property that appears later
  starts folded - spec 6.3); a first-load failure followed by a good load mounts
  everything fresh; the refresh note and the fallback line occupy fixed child
  slots, so no section remounts when they appear or clear.
- "All caught up" and the settling spinner: withheld on the fallback, on an
  unavailable section, on a past-tours first-load error and on a failed Today
  refetch; the spinner beside the refresh note (FW1-report item 2) is harmless,
  as R2 found. The one gap is R3-1.
- e2e readers of Show all: today-past-tours.spec.ts:186-210 reloads before it
  counts, and `showAllIn` (e2e/support/today.ts:79-83) clicks a "Show all N"
  only when one is present, so a list the lift keeps expanded stays expanded -
  neither can be misled by the lifted state.
- Gate status, for the handback: FW2 ran 5 e2e specs (14 passed), not the full
  `npm run e2e` (gate 4); the full battery after the last code commit is S8's.
- This record is ASCII-only; the tree holds no throwaway file.
