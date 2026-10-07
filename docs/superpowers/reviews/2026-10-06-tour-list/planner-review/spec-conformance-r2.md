# Planner review r2 - spec conformance re-review (feat/tour-list @ 7267b3be)

Reviewer: the same independent spec-conformance reviewer as round 1
(`spec-conformance.md`), reporting to the planner (Claude Opus 5.5),
2026-10-06.

Tree: `feat/tour-list` @ 7267b3be (code-final cab09c9c; 98376711 and
7267b3be are records), worktree `W:\tmp\tour-list`. The delta under review
is `git diff e666fae3..7267b3be` (SC-F2 a653d944, SC-F1 8d6a1377, ADV-F2
775f719f, ADV-F4 e84dfbfa + cab09c9c, E-1 a2ac6144, issue appends
0f6fc82b). Inputs read in full: the delta, `fix-wave.md`,
`adjudications.md`, `adversarial.md`; then the changed files in full at
HEAD, and a fresh pass over the rest of the branch for anything both
reviewers missed.

Contract: `docs/superpowers/specs/2026-10-06-tour-list-design.md` as
amended in place. Read-only: no suite, server, lane, build, install, Docker
or Playwright was run (the planner's final gate run is live in this
worktree). Read-only `git` and grep only, including a read of the parallel
branch's diff to test one adjudication's premise.

Line numbers below are at HEAD 7267b3be. Path abbreviations as in round 1
(`ATV` = `dashboard/src/routes/tours/AllToursView.tsx`, `uAT` =
`dashboard/src/routes/tours/useAllTours.ts`, `repo` =
`app/src/repos/toursRepo.ts`).

## 1. Summary

**After this round: 159 items - 141 CONFORMS, 18 DEVIATES-RULED,
0 DEVIATES-UNRULED, 0 PARTIAL, 0 MISSING** (round 1: 138 / 19 / 0 / 2 / 0;
seven verdicts changed, section 6).

Round-1 findings: F1, F2 and the E-1 GLOSSARY half are fixed, and each fix
is correct (section 5).

New findings: **0 BLOCKING, 0 HIGH, 0 MEDIUM, 5 LOW**:

- **R2-F1** (code, keyboard users; not a spec deviation): activating Load
  more, Keep checking, Retry or Start over drops keyboard focus to the page
  body.
- **R2-F2** (a trap in a deferred issue): the cache remedy the fix wave
  recorded would undo D9's "next one to work on".
- **R2-F3** (contract drift): the spec still names `pageLimit` in sections 7
  and 9. The branch's own R2-4 precedent says a ruling that changes the
  spec's letter is amended into the spec in place.
- **R2-F4** (docs): the GLOSSARY sentence the fix wave edited misstates how
  far "Not booked" reached, and the same paragraph inverts "reader".
- **R2-F5** (nit): three issue files' line refs into `ATV` are stale, two of
  them shifted again by this wave's memo.

Contested adjudications (section 4):

- **ADV-F1**: concede, with a sharper reason.
- **ADV-F3**: the deferral is right; the remedy text is not (R2-F2).
- **ADV-F5**: contest the rejection's premise and recommend FILE (low, debt)
  instead.
- **ADV-F2's deferred half**: concede.

Nothing here blocks the merge.

## 2. What we all missed (new findings, by importance)

### R2-F1 [LOW] Activating Load more, Keep checking, Retry or Start over drops keyboard focus to the page body

- **Spec position.** Not a spec deviation. Spec 4.5 says these buttons are
  "hidden" while a loader runs, and the view hides them by unmounting them.
  Neither review looked at where focus goes next.
- **Evidence.**
  - The action area renders a button only while no loader runs
    (`ATV:663-692`). The buttons are Start over `:664-670`, Retry
    `:671-677`, Keep checking `:678-684` and Load more `:685-691`.
  - The first-page Retry lives inside the failure alert (`ATV:609-614`),
    which unmounts once the retry starts loading.
  - Each of these five removes itself on activation: the click sets
    `moreInFlight`, clears `moreFailed`, or starts a new list. The focused
    button leaves the DOM and focus falls back to `<body>`.
  - The view already handles this hazard for its two other self-unmounting
    controls:
    - the Status group's Clear moves focus first, with a comment naming
      the hazard ("Clear unmounts itself; hand keyboard focus ... so it
      does not fall back to the page body", `ATV:176-179`);
    - Clear filters focuses the When select (`ATV:352-357`).
  - The house paging lists keep the button mounted and `disabled` with
    "Loading...", so focus never leaves: `BroadcastsList.tsx:172-180`,
    `EmailTriage.tsx:368-376`, `MediaGallery.tsx:86-88`.
  - No test asserts focus after any of the five clicks.
- **Failure scenario.** A keyboard or screen-reader user tabs to Load more
  and presses Enter.
  - The button vanishes and focus is on `<body>`. The count line announces
    the new count, but nothing tells the user where they are.
  - The next Tab starts wherever the browser's sequential-navigation
    starting point fell. In a screen reader's browse mode that is the top
    of the page, above the filter bar and 50 to 1,000 row links, so getting
    back to the next Load more is a long walk.
  - Keep checking, Retry and Start over behave the same way.
- **Smallest fix.** Pick one, and add one view test per path asserting
  `document.activeElement` is not `<body>` after the click:
  - Keep the activated button mounted, `disabled` and reading "Loading...",
    while its OWN request runs (the house pattern). It still starts no
    second loader, so 4.5's one-loader rule holds; amend 4.5's "hidden" to
    "hidden or disabled".
  - Or, as the view's own Clear buttons do, hand focus to a surviving
    element before unmounting: the last row link (`listRef`) for Load more,
    Keep checking and Retry, and the When select for Start over.

### R2-F2 [LOW] The deferred issue now recommends a list cache that would undo D9's "next one to work on"

- **What the issue now says.** `docs/issues/tours-all-server-side-search.md:40-68`
  was appended in 0f6fc82b (ADV-F3's deferral). Its first bullet offers:
  keep the last list "in a short-TTL module cache keyed by the list key,
  and reuse it when a restore record for that list arrives" (`:54-55`).
- **Spec against it.**
  - Spec 4.9 makes restore pages "fresh reads, never a cache", and keeps
    the record "in history state, never module memory".
  - P14 sends the user, when the opened row "has left the list (the user
    marked, rescheduled, decided or canceled it), at the row now in its
    position - the next one to work on".
  - Cameron kept the restore at the spec gate for exactly that (D9:
    "scrolling down and finding the next one each time is kind of
    annoying").
- **Failure scenario.**
  1. Past + No show; the user opens the 4th row, records its outcome (the
     tour leaves the filter), and presses the back arrow.
  2. With the cached list, the opened row is still among the visible rows.
     The anchor prefers it whenever it is present (`ATV:429`), so focus
     returns to the row just handled - showing its old status - instead of
     the next one.
  3. Every other row's badge is stale too.
  4. A TTL does not help: the return comes seconds after the write.
- **Smallest fix (docs).**
  - Mark option (a) as needing a spec change (4.9, P14) and per-tour
    invalidation: any write from the tour page evicts or patches the cached
    row, or the cache is reused only if no tour was written since.
  - Or drop option (a) and keep option (b), server-side search, which keeps
    every read fresh.
  - The DEFER itself is right.

### R2-F3 [LOW] The contract and the resolved issue still name `pageLimit`

- **What still says `pageLimit`.** The rename (ADV-F4, e84dfbfa) is complete
  in code and tests (`git grep pageLimit -- app/src app/test dashboard/src
  e2e` hits only an unrelated local in `app/scripts`). Not renamed:
  - the spec, which is the contract: section 7 (`spec:706`, `:709`) and
    section 9 (`spec:774`, "the paged range read (`pageLimit: 1`)");
  - the RESOLVED issue's Resolution block
    (`docs/issues/tours-scheduled-range-query-unpaginated.md:66, :73`). This
    is the record a reader follows from the date-range fix, and its line
    refs (`toursRepo.ts:416-426`, docblock `:203-210`) moved too;
  - the plan (`plan:160, 176, 178, 191, 3213, 3324`).
- **Why the spec at least should change.** The fix-wave report left all of
  these as "historical records". That is fine for the plan, but not for the
  spec. This branch has already ruled on this exact gap:
  `code-review/r2-adjudications.md:30-31, :51` (R2-4) - "spec 5.5 and the
  section-9 bullet still state the per-request 400 rule - FIX ... both
  amended in place", and "AD-1's scope missed the spec amendment -
  ACCEPTED". A-7 was likewise amended into 5.4. ADV-F4 changes the spec's
  letter the same way.
- **Failure scenario.**
  - At merge the spec is stamped historical as the record of what shipped,
    and it names a parameter `toursRepo.ts` no longer has.
  - A later "bound the walk" change starting from section 7 searches for
    `pageLimit`, finds nothing, and either re-adds it - the misleading name
    ADV-F4 removed - or loses the docblock's warning that the knob is not a
    page cap.
- **Smallest fix.**
  - Amend spec sections 7 and 9 in place to `queryLimit` ("amended by the
    planner review, ADV-F4").
  - Add one line to the resolved issue's Resolution block naming the
    rename. The plan can stay historical.

### R2-F4 [LOW] The GLOSSARY sentence the fix wave edited misstates what "Not booked" was

- **What it says.** `documentation/GLOSSARY.md:367-368`: "These two labels
  retire "Not booked", the single label every undated tour used to show".
- **What it should say.** Per spec P7, "Not booked" was shown only on the
  tour page and the tenant, landlord and property tour lists. The Past rows
  and Today already read "Undated" (P7: `ToursPage.tsx:206`, "a literal
  'Undated' today" at `Today.tsx:215`), and the Closed tab showed an EMPTY
  date. The issue the sentence cites says so in its own title
  (`docs/issues/undated-tour-wording.md:4`: "... read "Not booked" on the
  tour page and contact/property tour lists but "Undated" on the Past and
  All rows").
- **A second wording slip in the same paragraph.** `:366-367` calls
  `undatedTourLabel` "the only reader of that wording rule". It is the
  rule's one implementation; spec 8 has every surface READ the missing date
  "through the one helper".
- **Smallest fix.**
  - "These two labels retire "Not booked", which the tour page and the
    tenant, landlord and property tour lists showed for every undated tour".
  - "is the one implementation of that wording rule; every surface reads
    it".

### R2-F5 [LOW, nit] Issue line refs into AllToursView.tsx are stale; this wave's memo shifted two of them

- **Stale refs.**
  - `docs/issues/tour-list-restore-anchor-trackpad-swipe.md:9,19` cites
    `ATV:394` for the guard listener. It is now `:409` (+7 from the memo
    block at `:386-393`; it was already `:402` before the wave).
  - `docs/issues/perf-pages-tours-past-surface.md:71` cites `ATV:574` for
    the first-page failure alert. It is now `:609`.
  - `docs/issues/undated-tour-wording.md:49` cites `ATV:214` for the date
    column. It is now `:218`; stale since fix waves 1-3.
- **Why it matters.** The wave refreshed the refs it noticed in one issue
  (`toursRepo.ts:417 -> :420`) but not the ones its own memo moved.
- **Fix.** Refresh the three refs, or cite the symbol (`rowView`, the
  `userActed` effect, the failure alert) instead of a line.

## 3. The fix-wave changes, reviewed cold

- **SC-F2, `mergeRows` (a653d944; `uAT:97-113`, used at `:119` and
  `:141`).**
  - One helper for both the first page and appends. It keeps the FIRST
    copy's position and writes the LATER copy's data there, so spec 4.5's
    "later copy wins in place" now holds on page 1 too.
  - Row order (4.4 / P6) is preserved. Within one request phase D precedes
    phase U, so for the one cause 5.3 names (a dated `requested` tour) the
    kept position is the D copy's, among the dated rows - where a row with
    a date belongs. The later copy's data is the same item read moments
    apart.
  - `lastPageEmpty` and `followCount` still count `page.tours` as sent, so
    the empty-page follow is unchanged.
  - The restore `depth` and the count line now count what the user sees,
    which is better.
  - The new hook case (`useAllTours.test.ts:197-208`) asserts one row per
    id, the later copy's data at index 1, and completeness; it was shown RED
    first. Correct.
- **SC-F1 (8d6a1377; `AllToursView.test.tsx:1179-1199`).**
  - Adds Cmd (meta) and Shift clicks and waits for four jsdom navigation
    reports.
  - Each click is unprevented, because react-router skips a modified click
    and so does `openRow` (`ATV:449`). The entry key, URL and null state
    assertions keep their teeth.
  - The mutant run in `fix-wave.md` (drop `metaKey` -> RED at `:1194`)
    proves the test discriminates. Correct.
- **ADV-F2, the memo (775f719f; `ATV:386-393`).**
  - `rowView` is a pure function of `(row, contacts, units)`: `whenLabel`
    and `formatDate` / `formatTime` use fixed `'en-US'` options and no
    relative words (`tourTime.ts:62-91`), and the label maps are constants.
  - The three deps are stable references between pages: the hook returns
    its state's arrays, or the module `EMPTY`, while loading or idle. So
    memoizing changes no rendered output.
  - The anchor layout effect (`ATV:419-441`) still runs on every change
    that can matter: `record`, `restoreOutcome`, and the views' identity on
    each landed page. The renders it no longer sees are ones where nothing
    it reads changed, and its early returns make those no-ops.
  - While searching, `visible` is still a fresh array every render, as
    before. No 4.9 behavior changes; e2e test 3 passed on the fix-wave lane
    as live proof.
  - Correct.
- **ADV-F4, `queryLimit` (e84dfbfa, cab09c9c; `repo:203-213`, `:420-434`).**
  - The interface, implementation, docblock and test (`toursRepo.integration.test.ts:244, 279, 293, 298`)
    are consistent.
  - The docblock correctly says the knob is not a page cap and that a small
    value reaches `queryAll`'s cap sooner and returns a prefix.
  - `{ logger: log }` routes `queryAll`'s page-cap WARN through the repo's
    logger, which is consistent with spec 7's "queryAll ... warns on its
    own".
  - Code: correct. Docs: incomplete (R2-F3).
- **E-1, GLOSSARY + README (a2ac6144, 7267b3be).**
  - The entry now names and retires "Not booked", so P12 is satisfied. It
    still records Requested (status), Needs booking (the work: the Active
    section, the All chip, the missing date - D8, D10) and Undated (P7).
  - The README's E-1 amendment narrows the grep to exclude
    `documentation/GLOSSARY.md` and `docs/issues/`.
  - The edited sentence misdescribes the old label (R2-F4).
  - No automated check greps documentation for the old label (`git grep`
    over tests and scripts), so nothing goes red.
- **Issue appends (0f6fc82b).**
  - `tours-date-range-reads-unbounded-span.md`: accurate. It matches the
    corrected docblock, and its `:420` refs are right.
  - `tours-all-server-side-search.md`: the walk-cost arithmetic and the
    formatter note are accurate. Option (a) is wrong for this feature
    (R2-F2).

Answers to the four questions asked:

- **Does the first-page de-dup keep "later copy wins in place" and the 4.4 /
  P6 order?** Yes, on both counts.
- **Does the memo change rendered output or the anchor?** No, on both
  counts.
- **Does the GLOSSARY still say what P7 / P12 / D8 / D10 require?** Yes for
  what it must record and retire, but it misstates the old label's reach
  (R2-F4).
- **Did the rename leave a doc or test inconsistent?** No test. Three docs
  did, the spec among them (R2-F3).

## 4. Contesting the adjudications

- **ADV-F1, REJECT: concede.** A sharper reason than the adjudication
  gives: the proposed complement (`attribute_not_exists(#sat) OR
  attribute_not_exists(#sp)` on the U phases) can never reach `scheduled`,
  which has no U phase (`tLQ:27`). Yet `scheduled` is exactly what spec
  3.6's "a seeded request that is booked" becomes (PATCH auto-advances to
  `scheduled`, adds a date, never stamps). So the fix would miss its own
  motivating case. Spec 8 I2 names phase D as a reader of the stamp, and the
  stamp is required on `TourItem` (`repo:80`).
- **ADV-F2, the formatter half DEFERRED: concede.** The cost needs thousands
  of loaded rows, and the shared helper (`tourTime.ts`) is the Active, Past,
  Closed and Today tabs' too.
- **ADV-F3, DEFER: agree with the deferral, contest the recorded remedy.**
  A return re-running the walk is what the spec requires today (4.9: "fresh
  reads, never a cache"). The cache option written into the issue would
  regress D9 / P14; see R2-F2.
- **ADV-F5, REJECT: contest the reason, and recommend FILE (low, debt).**
  - The rejection rests on "extracting a shared helper would edit
    `contactsRepo.ts`, which the parallel feat/clean-org-names branch also
    edits". That branch does edit the file, but
    `git diff main...feat/clean-org-names -- app/src/repos/contactsRepo.ts`
    shows its two hunks at `:805` (the interface) and `:1649+` (the end) -
    nowhere near `batchGetByIds` (`contactsRepo.ts:849-892`).
  - So an extraction there would not conflict textually, and the
    unitsRepo copy is this branch's own method.
  - The honest reasons not to refactor NOW are "no behavior change" and
    AGENTS.md's "Cleanup is separate work". Neither makes the drift risk go
    away: two copies of a retry walk (4 attempts, 25/50/100 ms, a thrown
    chunk counted unprocessed - `unitsRepo.ts:581-618` against
    `contactsRepo.ts:849-892`).
  - AGENTS.md's tier-2 registry exists for exactly this, so FILE it rather
    than drop it.
  - The path-constant and click-predicate halves: concede. Both are pinned
    (the TourDetail back-arrow cases, the e2e return; the row predicate now
    for all four modifiers, the tab predicate at `ToursPage.test.tsx:1396`).
- **SC-N1..N4, recorded without action: agree.** N1 and N3 are minor UX, N2
  is a spec-consistent choice, and N4 is house-wide. One addition to N2's
  record: R2-F2 shows why the spec's fresh read matters on the return path.

## 5. Are the fixes correct, or merely plausible?

| item | verdict | basis |
|---|---|---|
| SC-F2 first-page de-dup | correct | one helper, both paths; the semantics traced above; RED-then-GREEN case asserts position and data |
| SC-F1 Cmd / Shift row clicks | correct | discriminating (a mutant went RED); assertions unchanged |
| ADV-F2 memo | correct | pure derivation, stable deps; anchor triggers unchanged; e2e return green on the fix-wave lane |
| ADV-F4 rename + logger | correct in code and tests | the contract was not amended - R2-F3 |
| E-1 GLOSSARY + README | correct in substance | one inaccurate appositive and one inverted word - R2-F4 |
| issue appends | one accurate, one with a wrong remedy | R2-F2 |

## 6. Verdict changes to the round-1 table

Only the rows whose verdict changed; every other row of
`spec-conformance.md` stands.

| item | round 1 | round 2 | evidence | note |
|---|---|---|---|---|
| S1 range read + Today warning | CONFORMS | DEVIATES-RULED (ADV-F4) | `repo:203-213,420-434` | `queryLimit` where spec 7 says `pageLimit`; spec not amended (R2-F3) |
| S14 GLOSSARY + issues | DEVIATES-RULED (E-1, E-4, E-6) | CONFORMS | `GLOSSARY.md:355-373`; README E-1 amendment | E-4 / E-6 are filing hygiene, not departures from the spec's letter |
| P12 two staff words; GLOSSARY retires "Not booked" | DEVIATES-RULED (E-1) | CONFORMS | `GLOSSARY.md:367-368` | the appositive's inaccuracy is R2-F4, not a P12 gap |
| 5.3 client de-dup absorbs an I1 violation | PARTIAL | CONFORMS | `uAT:97-113,119,141`; `useAllTours.test.ts:197-208` | F2 fixed |
| 7 `listByScheduledRange` via `queryAll` + optional third argument | CONFORMS | DEVIATES-RULED (ADV-F4) | `repo:203-213,420-434`; `toursRepo.integration.test.ts:279-300` | same as S1 |
| 8 GLOSSARY records the words and retires "Not booked" | DEVIATES-RULED (E-1) | CONFORMS | `GLOSSARY.md:355-373` | as P12 |
| 9 dashboard: the return-restore bullets | PARTIAL | CONFORMS | `AllToursView.test.tsx:1179-1199` | Cmd and Shift now tested (F1 fixed) |

Unchanged but noted:

- S8 stays DEVIATES-RULED, on D-1 alone now.
- The 4.5 de-duplication row stays CONFORMS and now holds on the first page
  too.

Counts: 141 CONFORMS, 18 DEVIATES-RULED, 0 DEVIATES-UNRULED, 0 PARTIAL,
0 MISSING (159).
