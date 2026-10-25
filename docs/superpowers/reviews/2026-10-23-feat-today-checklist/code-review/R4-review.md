# R4 code review - feat/today-checklist (tracker #31)

Reviewer: R4 (fresh; Claude Opus 5.5), 2026-10-25. Tree `W:\tmp\today-checklist`,
branch `feat/today-checklist`, HEAD 8f352af6 (fix wave 3's last commit 5a52e978
plus one planner docs commit), base main @970a29b9. Scope: the FW3 diff
(9323507d..5a52e978), reviewed cold. Contract: spec r8
(`docs/superpowers/specs/2026-10-23-today-checklist-design.md`), sections 2.1,
2.3, 2.4, 3.1, 5.3, 6.3. Inputs read: R3-review.md, R3-adjudications.md (and
its loop rule), FW3-report.md, R2-adjudications.md, the R2-3 entry of
R2-review.md, the FW3 diff package (`.superpowers/review/r4/fw3-diff.txt`),
and the live source of `dashboard/src/routes/today/{Today,TodaySection}.tsx`,
`{buildToday,useToday,useTodayPastTours}.ts`, `dashboard/src/routes/tours/useTours.ts`
(usePastTours), `app/src/routes/today.ts` (mergeIdentifyRow, whoOfConversation)
and `e2e/performance/routes.ts` (TODAY_TERMINAL).

Method: every finding was reproduced with a throwaway test that FAILED on the
current code, run bare from the dashboard workspace (`cd
W:/tmp/today-checklist/dashboard && npx vitest run src/routes/today/<file>`),
quoted below, then deleted. To classify REGRESSION vs NOT A REGRESSION, the
same probes were also run against throwaway COPIES of the FW3 base modules
(`git show 9323507d:dashboard/src/routes/today/{Today.tsx,buildToday.ts}`,
saved beside the suite as zz-r4-base-* and imported by the probe; no existing
file was edited, and nothing else differs between base and HEAD under
dashboard/src/routes/today or dashboard/src/api). No suite, e2e session or dev
server was started; nothing was committed; every throwaway file is deleted.

Counts: HIGH 0, MEDIUM 0, LOW 1, INFO 1. REGRESSION 1, NOT A REGRESSION 1.
Nothing loses, duplicates, strands or misdirects a send.

---

## 1. Findings

### R4-1 - LOW - REGRESSION - CONFIRMED - FW3-3's distinct contact-less fallback rows share one React key, so a refetch leaves ghost Identify rows

Location:
- dashboard/src/routes/today/buildToday.ts:284-304 (FW3-3: a thread with no
  participant contact id always gets its own row; its refId is
  `unknown?phone=` + the encoded phone, '' for an email thread,
  :124-131)
- dashboard/src/routes/today/Today.tsx:93-95 (`rowKey` = refType:refId) and
  :147-152 (ItemsSection passes `itemKey={rowKey}`), rendered as
  `<Fragment key={itemKey(item)}>` at dashboard/src/routes/today/TodaySection.tsx:88-90
- pinned as expected output by dashboard/src/routes/today/buildToday.test.ts:258-272
  (two unlinked threads on one phone -> two rows with the same refId)

Behavior: on a 404 fallback load, two unknown_1to1 threads that carry no
contact id and the same refId - two different people on unlinked email
threads (both `unknown?phone=`), or two unlinked threads on one phone - are now
two Identify rows (R3-2 (b)'s fix), but under ONE React key. React's keyed
reconciliation then mis-tracks them: on the next refetch that changes the
list ahead of them, one old row is neither reused nor deleted and stays in
the DOM. Concretely:
- fallback [Al (contact id), Xena (unlinked email), Yuri (unlinked email)],
  then a fallback refetch where Al was identified elsewhere -> the list shows
  Xena, Xena, Yuri (a duplicated row);
- the same first load, then the server answers again (Bea, Cal) -> the
  server's Identify list shows a stale fallback "Xena Mail" row above Bea and
  Cal. The ghost is outside React's tree, so it stays until the Identify
  section unmounts or the page reloads.
React also logs "Encountered two children with the same key" on render.

Why wrong / why a regression: R2-3 (the reason FW2-3 exists) was exactly
"listed twice under one React key"; FW2-3 closed it ("one row and one React
key per contact", verified real by R3), and at 9323507d no two Identify rows
could share a key (the refId de-dupe collapsed these shapes - wrongly for two
different people, R3-2 (b), but with unique keys). FW3-3 reopened the shared
key for contact-less rows. The rows on screen no longer match the load (spec
3.1 keeps the fallback's copy and its every-thread rule, not phantom rows),
and the stale row survives into the server's own list. FW3-report "Found that
the adjudication did not cover" item 1 names the shared key but frames it as
the benign pre-FW2-3 shape; the probe below shows it is a visible defect, and
the base passes the same probe. Severity: the fallback runs only on a 404
(effectively dead in prod), which alone would make it INFO; LOW because the
output is a visible duplicated/stale row that persists across loads. Not a
send.

Evidence:
- dashboard/src/routes/today/zz-r4-1.test.tsx (deleted): the real page with
  mocked useToday / useTodayPastTours, items from the REAL
  buildTodayFromSources, `rerender` for the refetch:

      x R4-1 ... > a fallback refetch that drops the first row lists the two unlinked people once each
        -> expected [ 'Xena Mail', 'Xena Mail', ...(1) ] to deeply equal [ 'Xena Mail', 'Yuri Mail' ]
      x R4-1 ... > a recovery from the fallback to the server load leaves no fallback row behind
        -> expected [ 'Xena Mail', 'Bea Server', ...(1) ] to deeply equal [ 'Bea Server', 'Cal Server' ]
      duplicate-key console errors: 2 Encountered two children with the same key, `%s`. Keys should be
        unique so that components maintain their identity across updates. Non-unique keys may cause chi...
      Tests  2 failed (2)

- dashboard/src/routes/today/zz-r4-1b.test.tsx (deleted): the invariant "the
  DOM lists exactly the load's Identify rows" across one fallback refetch,
  run with the HEAD builder and with the 9323507d builder copy:

      x ... - HEAD (FW3) > unlinked email threads: a fallback refetch that drops the first row
        -> expected [ 'Xena Mail', 'Xena Mail', ...(1) ] to deeply equal [ 'Xena Mail', 'Yuri Mail' ]
      x ... - HEAD (FW3) > unlinked threads on one phone: a fallback refetch that drops the first row
        -> expected [ 'Cy Phone', 'Cy Phone', 'Di Phone' ] to deeply equal [ 'Cy Phone', 'Di Phone' ]
      v ... - base 9323507d > unlinked email threads: a fallback refetch that drops the first row
      v ... - base 9323507d > unlinked threads on one phone: a fallback refetch that drops the first row
      Tests  2 failed | 2 passed (4)

Fix (keeps buildToday's FW3-3 output and buildToday.test.ts:244-272 as they
are): give every Identify row a unique render key. Smallest form, local to
Today.tsx: ItemsSection derives its keys once per render - rowKey(item), with
`#<n>` appended to the n-th repeat of a key - and passes `itemKey={(item) =>
keys.get(item) ?? rowKey(item)}` (a Map keyed by the item object, since
LimitedList slices the same objects). Checked on a throwaway copy of
Today.tsx (zz-r4-fix-Today.tsx + zz-r4-1c.test.tsx, deleted): the zz-r4-1b
probe passes 4/4 with it. Alternative: a client-only key field that
buildToday sets to the conversationId on contact-less rows and rowKey
prefers. Pin with a page-level test of the first probe (a fallback refetch
that drops a row ahead of two contact-less rows).

### R4-2 - INFO - NOT A REGRESSION - CONFIRMED - a recovered past-tours reload claims "All caught up" while it is still labeling the rows it brought

Location:
- dashboard/src/routes/tours/useTours.ts:328 (a good reload sets
  `reloadFailed: false` the moment the raw rows land)
- dashboard/src/routes/today/useTodayPastTours.ts:167-178 and :199 (the
  labeling runs AFTER that, asynchronously; until it lands the hook returns
  the PREVIOUS labeled rows with the new, cleared `reloadFailed`)
- dashboard/src/routes/today/Today.tsx:507-514 (`allCaughtUp` reads those
  stale rows and `!past.reloadFailed`)

Behavior: Today is empty ("All caught up"). A tour is marked toured and the
past-tours reload fails: FW3-1 now shows the section's heading and "Could not
refresh past tours..." and withholds "All caught up" (correct). The next
tour.updated reload succeeds and brings that tour: usePastTours clears
`reloadFailed` at once, useTodayPastTours still holds the old empty rows while
it point-reads the tenant and property, and for that round trip the page
reads "All caught up" again - the note gone, the row not yet shown. The same
window opens on any empty -> non-empty reload with no failure in between.

Why wrong: spec 2.3 ("the message waits for the past-tours section to settle
so it never flashes above rows about to appear") and spec 5.3 ("The 'All
caught up' settle wait covers this labeling") - the settle wait covers the
FIRST load only (`status: 'idle'` while `labeled === null`). For FW3-1 it means
the withhold lapses one round trip early: the unknown state persists until the
labels land, but `reloadFailed` does not. Transient (one parallel round trip,
then the row shows), hence INFO. Pre-existing: main's useTodayPastTours has
the same async labeling with the old rows kept (970a29b9 useTodayPastTours.ts:152-187),
and the base page fails the same control case (below).

Evidence:
- dashboard/src/routes/today/zz-r4-2.test.tsx (deleted): the REAL useToday and
  useTodayPastTours under the real page, api barrel mocked (getToday an empty
  queue; getTours [] -> 503 -> one toured tour; getContact held pending;
  every useEventStream subscriber hears tour.updated). Case 1's FW3-1
  assertion (note shown, All caught up withheld after the failure) PASSED;
  both cases then fail once labeling has started (getContact called):

      x R4-2 ... > failed reload, then a good reload bringing a tour: All caught up stays withheld until the row shows
        -> expected document not to contain element, found <p class="_emptyTitle_de976c">
           All caught up </p> instead      (zz-r4-2.test.tsx:81:53)
      x R4-2 ... > control (no failure): an empty load, then a good reload bringing a tour
        -> expected document not to contain element, found <p class="_emptyTitle_de976c">
           All caught up </p> instead      (zz-r4-2.test.tsx:98:53)
      Tests  2 failed (2)

- dashboard/src/routes/today/zz-r4-2b.test.tsx (deleted): the same file
  against the 9323507d Today.tsx copy: case 1 fails EARLIER, at the failure
  itself ("Unable to find an element with the text: Could not refresh past
  tours. Reload the page to see the latest." - R3-1 at the base), and the
  control fails at the same :98 assertion - the labeling window predates FW3.

Fix (to file, per the loop rule): useTodayPastTours remembers which `past`
array its `labeled` rows were built from and reports the section unsettled
(e.g. a `labeling: true` field, or keeping the previous `reloadFailed`) while
a newer array awaits labels; `allCaughtUp` also requires that it is settled.
The rows and the note keep their current timing.

---

## 2. Regression sweep of the FW3 diff (line by line)

- Today.tsx:507-514 (`allCaughtUp` + `!past.reloadFailed`): the only reader of
  the new clause. `settling` (:517) is unaffected - `reloadFailed` is only
  true with status 'ready' (useTodayPastTours.ts:197-199) and `settling`
  needs 'idle'. When rows exist the clause is redundant (rows already block
  the message). No regression.
- Today.tsx:319-343 (PastToursSection): the empty-and-failed branch renders the
  heading, no list and the existing note. With rows, the children are still
  [LimitedList, note] with the list in child slot 0, so no transition remounts
  the list; its Show all is lifted (expansionOf(PAST_TOURS_LABEL)) anyway. The
  first-load error branch (:307-318) is unchanged. Transitions walked: good
  (empty) -> failed -> good (empty): note, then hidden and "All caught up"
  (pinned at Today.test.tsx:917); good (rows) -> failed -> good: rows + note,
  then rows (unchanged); good (empty) -> failed -> good (rows): R4-2's window;
  Today's refetch AND the past reload both failing on an empty page: two
  alerts, no "All caught up" (consistent, both are real failures).
- Today.tsx:412-415, :472-478 (FW3-2): `collapseList` is the only new writer of
  `expandedLists`; only the AI line's toggle calls it, only when the line is
  open; it returns `prev` when the label is absent (no re-render). Probed
  (zz-r4-3, deleted, 3 passed): closing the AI line leaves Needs you now and
  Tours today expanded; a double-click on the open line ends open at 5 rows;
  close after Show all -> refetch to 9 rows -> open shows 5 and "Show all 9"
  (aria-expanded false). AtAGlance and its `aiOpen` stay mounted because
  useToday never leaves 'ready' after the first good load (useToday.ts:159,
  :168), so a refetch never resets the line and never calls collapseList.
- buildToday.ts:284-304 (FW3-3): `contactRefId` takes the participant contact
  id first (:124-131), so the Map key and the row's link always agree; the
  kept row is the same object pushed to `needs`, so the label fill is visible
  in the output; the fill takes `conversationWho` only while the kept label is
  '' - the server's test is the same `length > 0` (app/src/routes/today.ts:1395),
  so whitespace handling matches. The one regression is the render key (R4-1).
- Tests can fail: R3's three findings were re-driven by a throwaway
  verification (zz-r4-v1, deleted) against HEAD and against the base copies:
  HEAD 4 passed; base 4 failed ("expect(element).not.toBeInTheDocument()" for
  R3-1; "expected [ ...(7) ] to have a length of 5 but got 7" for R3-3;
  "expected [ [ 'ct-1', '' ] ] to deeply equal [ [ 'ct-1', '(404) 010-0007' ] ]"
  and "expected [ 'Ana Mail' ] to deeply equal [ 'Ana Mail', 'Bo Mail' ]" for
  R3-2). The new real-hooks test (Today.pastToursReload.test.tsx) fails safe
  if a future subscriber shares a handler set (its keyed Map would drop one
  hook's handlers and the getTours x4 wait would time out, not pass). The
  FW3-2 refetch pin (Today.refetch.test.tsx:343) would also catch a collapse
  on UNMOUNT (the fallback hides the line), not only the prop removal the
  FW3 report mutated.
- The committed today suite at HEAD: 8 files, 142 passed (`npx vitest run
  src/routes/today --exclude "**/zz-*"`), matching FW3-report.

---

## 3. Challenges to the adjudication and the fixer's choices

- R3-adjudications FW3-3 ("de-dupe only rows that carry a real contact id"):
  PARTLY DISAGREE. R3-2's own fix had two halves - do not de-dupe a refId that
  names no one, "key those by conversationId instead" - and the adjudication
  kept only the first. Without a unique render key the rule reopens R2-3's
  shared key for contact-less rows (R4-1), and the committed test
  buildToday.test.ts:258-272 now pins two rows with one refId as expected.
  The output rule is right; the render key must change with it (Today.tsx:93-95,
  :147-152; spec 3.1).
- FW3-report found-item 1 (shared React keys, "the pre-FW2-3 shape", left to
  the orchestrator): AGREE it is the pre-FW2-3 shape on main; DISAGREE that it
  is benign or residual - relative to the FW3 base it is new, and it produces
  ghost rows that survive into the server list (R4-1, base passes).
- FW3-report found-item 2 ("keep distinct" over "key by conversation"):
  AGREE - output-identical for buildToday, and neither form fixes the render
  key, which is where the defect lives.
- FW3-report found-item 3 (the empty-and-failed section has no Past tab link):
  AGREE - it is the existing reload note unchanged, no new copy, and the Past
  tab stays one click away in the nav.
- R3-adjudications FW3-1: AGREE with the rule and the section change; note
  that `reloadFailed` clears when the raw reload lands, before its rows are
  labeled, so the withhold lapses one round trip early (R4-2, pre-existing,
  spec 2.3 / 5.3).
- R3-adjudications FW3-2 (each opening starts at 5; a close is a viewer
  action, not a refetch): AGREE - spec 2.4 "Opening it shows the rows with the
  same 5-row limit and Show all"; FW2-2's refetch survival (spec 2.1) is kept
  and pinned.

---

## 4. FW3 verdicts

- FW3-1 (R3-1): REAL. The steady state is closed: an empty past-tours section
  whose reload failed shows its heading and note and the page withholds "All
  caught up" (verified against HEAD with mocked and real hooks; the base
  fails the same probe). Residue: R4-2 (the recovery's labeling window,
  pre-existing).
- FW3-2 (R3-3): REAL. Each opening starts at 5 rows; refetch survival intact
  (the fallback pin); no other list is touched (zz-r4-3).
- FW3-3 (R3-2): REAL for the builder - (a) the contact's one row takes the
  first non-blank label and keeps its first place; (b) two different
  unlinked people are two rows - but it regressed the render: R4-1.

---

## Swept, no finding

- "All caught up" vs every state reader: refreshFailed, past.reloadFailed,
  past.status error/idle, unavailable sections, the fallback; `settling`
  unchanged; the spinner never shows beside the empty-and-failed section.
- Perf terminal contract (e2e/performance/routes.ts:404-415): the
  empty-and-failed past section is not a first-load terminal (`reloadFailed`
  needs a prior good load), the same reasoning R2-adjudications applied to the
  refresh note.
- e2e readers: `aiLine` (e2e/support/today.ts:87) reads the AI line's name and
  today-past-tours.spec.ts reads the section's list, both unchanged by FW3; no
  e2e path fails a past-tours reload or drives the fallback with contact-less
  threads.
- Copy and ASCII: no new user-facing string (the note is the existing one);
  the pinned em dash in 'New inbound ... untriaged' is untouched; this record
  is ASCII-only.
- Server path: Identify rows stay one per contact id (FW1-2 / FW2-1), so the
  server's own keys stay unique; R4-1 needs a fallback load.
- The tree holds no throwaway file; `git status --short` shows only this
  record.
