# Planner review r3 (final) - spec conformance re-review (feat/tour-list @ 2243d9ef)

Reviewer: the same independent spec-conformance reviewer as rounds 1 and 2,
reporting to the planner (Claude Opus 5.5), 2026-10-07.

Tree: `feat/tour-list` @ 2243d9ef (code-final 8e101714; 1fc7626f and 2243d9ef
are records). The delta under review is `git diff fcdcf9a5..2243d9ef`:

- R2-1: f6b1bc88;
- R2-2: 21af7f10;
- R2-4 + R2-F3: 7db2fa5b;
- R2-5: 5c769c1e;
- R2-F2 + R2-F4: 75e7f0f4;
- R2-F5: 634bb77a;
- the ADV-F5 and R2-3 DEFERs: b8fb412d and 8e101714.

Inputs read in full: the delta; `fix-wave-2.md`, including the live
keyboard check; the "Round 2" section of `adjudications.md`; and
`adversarial-r2.md`. I then read every changed file at HEAD and traced each
focus branch by hand.

Read-only. No suite, server, lane, build, install, Docker or Playwright was
run (the planner's final gate run is live in this worktree); only read-only
`git` and grep. Line numbers below are at HEAD (`ATV` =
`dashboard/src/routes/tours/AllToursView.tsx`, `uAT` =
`dashboard/src/routes/tours/useAllTours.ts`). Final round: only a real
defect carries a severity; everything else is a note.

## 1. Summary

**After this round: 161 items - 145 CONFORMS, 16 DEVIATES-RULED,
0 DEVIATES-UNRULED, 0 PARTIAL, 0 MISSING.** Round 2 had 141 / 18 of 159.
The changes:

- two new rows for the amended 4.5 focus rule and its section-9 tests;
- the S1 and section-7 rows return to CONFORMS now that the spec says
  `queryLimit` (section 6).

**Findings: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 1 LOW.**

- **R3-F1 (LOW).** After a pressed Load more, Keep checking or Retry whose
  page adds no row and leaves no action control, the new focus hand-off
  moves focus AND scrolls the viewport to the count line at the TOP of the
  list.
  - **When it happens.** An empty page handed to the automatic follow, and
    the accepted phantom page of spec 5.4.
  - **Who it hits.** Keyboard users get back the long walk R2-1 fixed. Mouse
    users get a visible jump to the top that did not exist before this wave.
  - **Where the fault sits.** The amended spec prescribes this target ("else
    to the count line"), so the defect is in the amendment and the code
    together.

Everything else in the wave is correct (section 5). Seven wording notes and
one polish note (section 7); the coordinator's checklist is answered item by
item in section 3. Contested: R2-1's count-line fallback (= R3-F1).
Conceded: the R2-3 deferral. Nothing here blocks the merge.

## 2. What we all missed

### R3-F1 [LOW] An empty user-requested page sends focus, and the viewport, to the top of the list

**What happens.**

- The focus effect (`ATV:531-563`) settles a pressed Load more, Keep
  checking or Retry on `newRow ?? shown ?? count` (`ATV:557`).
- It then calls `focus({ preventScroll: true })` and
  `scrollIntoView({ block: 'nearest' })` on that target (`ATV:561-562`).
- When the page added no visible row and no action control is shown, the
  target is the count line.
- The count line sits ABOVE the list, under the filter bar
  (`ATV:710-718`). The user pressed a control BELOW the list.
- So `scrollIntoView` scrolls the page up to the top of the list.
- Spec 4.5's amended focus bullet prescribes exactly this target ("else to
  the count line"), so the code conforms. The rule is the defect.

**When it fires.** Traced in the code:

1. **Load more, Keep checking or Retry -> an EMPTY page with a cursor.**
   - The hook hands the list to the automatic follow (`uAT:249-251`), so
     `loader` is `follow` and the action area unmounts (`ATV:469-485`,
     `action` null). The pressed button leaves the DOM and `actionsRef` is
     null.
   - The effect settles on the count line and scrolls to it.
   - When the follow later lands rows at the bottom, nothing moves focus
     back (by design: "an automatic page moves nothing").
   - This is the D-to-U boundary of an Any time list at scale: the U phases
     scan dated rows to find a few undated ones. It also happens under any
     sparse filter, and on every Keep checking press (Keep checking only
     exists after 10 empty pages).
   - The view test `AllToursView.test.tsx:1509-1531` ("Keep checking ...
     focus goes to the count line") pins this target. jsdom has no layout,
     so the scroll itself is invisible to it.
2. **The same three controls -> an empty page with `nextCursor: null`.**
   - This is spec 5.4's accepted phantom Load more ("Either costs one empty
     page, which 4.5 absorbs"). The list completes, Load more unmounts
     (`!data.complete` false), and focus plus viewport jump to the top for
     a press that found nothing.
   - It is reachable today: a default list whose dated tours are an exact
     multiple of 50, with no undated tour, leaves a "start of U requested"
     cursor on its last full page.
3. **A related gap, same root.**
   - When a NEW row IS added, the effect still scrolls it into view even if
     the user scrolled the wheel or by touch while the request ran.
   - The hand-off guards only "where the user has put focus" (`ATV:551`).
   - Spec 4.9's anchor, by contrast, treats `wheel` and `touchstart` as
     user intent and then moves "neither scroll nor focus" (4.9, "a
     convenience, never a hijack").

**Who it hits.**

- **Keyboard users** land on the count line above possibly hundreds of rows.
  Getting back to the new rows or the next Load more is the long Tab walk
  R2-1 was ruled to remove.
- **Mouse users in Chrome** are hit because the clicked button had focus and
  then unmounts, so focus falls to `<body>`, which the guard allows.
  **Mouse users in Safari** are hit because the button is never focused and
  focus is `<body>` throughout, which the guard also allows. Both see the
  page jump from the bottom to the top of the list right after clicking.
- Before this wave the button simply vanished and the viewport stayed put.

**Smallest fix.** Code and spec, two lines of each:

- In the effect's `kind === 'more'` path, when no new visible row and no
  action control exists, target the LAST visible row's link (the row the
  user was just at). Fall back to the count line only when the list has no
  row.
  - After a follow hand-off, the keyboard user is then one Tab from the new
    rows.
  - After a phantom, focus stays at the end of the complete list.
  - The rebuild path (Start over, the first-page Retry) keeps the count
    line; the list restarts at the top there anyway.
- Optionally, guard the scroll as 4.9 does: skip `scrollIntoView` when a
  `wheel` or `touchstart` came after the press.
- Amend 4.5's focus bullet: "else to the last row's link, or the count line
  when the list has no row".
- Change the Keep checking case's expectation, and add a phantom case: an
  empty page with `nextCursor: null` after Load more.

**Corroboration.** The plan-blind reviewer found the same defect
independently, as R3-1 in `adversarial-r3.md` (read after this report was
drafted). It names the same two triggers - the count-line fallback, and a
user scroll during the request - and the same last-row fallback. Its
"drop `scrollIntoView` in the more path, keep it for rebuild" is compatible
with the fix above. Taking both gives the smallest complete change: last
row, else the count line, focused with `preventScroll` only in the more
path.

## 3. The changes, reviewed cold (the coordinator's checklist)

### 3.1 The new 4.5 text, against itself and the rest of the spec

- **D2** ("more loads only when the user asks (Load more / Keep checking) or
  returns"). Unaffected; the amendment changes visibility and focus, not what
  loads. Retry after a failed page is also "the user asks".
- **D3.** Unaffected: the busy Load more never runs a search walk, and a
  search typed during it still waits for it (4.5's unchanged "lets that
  request finish").
- **4.9's anchor.** No conflict. The focus effect acts only after a press
  (`pendingFocus` is written only in `requestMore` and `rebuild`,
  `ATV:399-421`), and no press is possible while the restore runs (Load
  more is hidden during an automatic loader). The two press paths that CAN
  occur during a return each come after the anchor has already resolved:
  - a first-page failure resolves `restoreOutcome` to `reached`
    (`uAT:335-342`, cursor null);
  - a failed restore page resolves it to `capped`.

  So the anchor and the hand-off never both hold focus.
- **"Hidden only during automatic loaders".** No rule contradicts it. Each
  rule I checked is consistent:
  - section 6 "While the walk runs, Load more is hidden" (spec `:704`; the
    walk is automatic);
  - section 9 "Load more hidden during the first-page load and the
    empty-page follow" (`:826`);
  - 4.5 "Keep checking ... shown INSTEAD of Load more ..., never beside it"
    (`:407`; "no other action control shows" while busy);
  - 4.9 "Load more continues" after a capped restore (`:487`);
  - D2 (`:33`).
- **Internal wording.** Three slips; none changes behavior (notes N1-N3).

### 3.2 Each section-9 test the amendment names exists and can fail

- **"The pressed control busy and focused while its own request runs, and
  where focus lands after each action control - one case per control".** Nine
  cases sit under the describe at `AllToursView.test.tsx:1480` - Load more,
  Load more adding no row, Keep checking, Retry after a failed page, Start
  over, the first-page Retry (two cases), focus moved by the user, and a
  filter change. They can fail:
  - `fix-wave-2.md` records seven RED on the old code;
  - the two hand-off guards each went RED under a hand mutant;
  - `expectBusyWithFocus` (`:1468-1479`) asserts the same element, focus,
    `aria-busy`, `aria-disabled`, no `disabled` attribute, and a second
    activation sending nothing.
- **"De-duplication (the newer copy wins)".** Two hook cases cover it:
  - the stale second copy is ignored (`useAllTours.test.ts:210-222`, RED
    first);
  - the same-age copy replaces in place (`:305`). A `>=` -> `>` mutant
    fails it.
- **Not pinned.** The first cursor 400 after a pressed control (the
  automatic restart) hands focus to the count line (fix-wave-2's table). The
  spec does not name this case separately (note N7).

### 3.3 Does the focus behavior match the amended text in every branch?

I traced each branch through `requestMore` / `rebuild` (`ATV:396-421`), the
`action` choice (`ATV:469-485`) and the effect (`ATV:531-563`):

| branch | amended text | built | match |
|---|---|---|---|
| Load more / Keep checking / Retry, request in flight | stays, busy, focused, ignores a second activation; no other control | same keyed element, `aria-busy` + `aria-disabled`; `requestMore` returns while `loader` is `more` | yes |
| ... lands, rows added | first newly added visible row | first `a[data-tour-id]` in DOM order among `rows.slice(rowsBefore)` | yes |
| ... lands, no row added, control still shown | the pressed one, in place | same element keeps focus (target === active, no move) | yes |
| ... fails (non-cursor) | the Retry that replaced it | `shown` = the Retry block's button | yes |
| ... second cursor 400 | the Start over that replaced it | `shown` = Start over | yes |
| ... first cursor 400 (automatic restart) | "else" -> count line | count line (settles while page 1 reloads) | yes |
| ... empty page -> follow, or empty final page | "else" -> count line | count line + scroll to it | yes - and that is R3-F1 |
| Start over / first-page Retry, press | count line at once | `rebuild` focuses it with `preventScroll` before the state change | yes |
| ... new page lands with rows / empty / fails | first row / stays on count line / stays, Retry next Tab stop | as stated; DOM order asserted at `AllToursView.test.tsx:1603-1605` | yes |
| a filter change meanwhile | never onto another list | `pending.listKey !== listKey` -> no move | yes |
| focus moved by the user | left where they put it | the `active` guard (`ATV:551`) | yes |
| Retry runs | failure sentence withdrawn, re-inserted on a second failure | `busy ? null : <p>` inside the keyed alert | yes |

The builder's one precision is the "fails" rows: a failed OWN request hands
focus to the Retry or Start over that replaced the control, not to the count
line. It is right - the replacement sits where the pressed control was, one
Enter from retrying - and the amended text now states it ("or the Retry or
Start over that replaced it when the request failed").

### 3.4 Does the newer-copy rule still serve the cross-page reschedule case?

Yes:

- `mergeRows` (`uAT:105-118`) replaces only when `r.updatedAt >=
  out[at].updatedAt`.
- A reschedule between two pages writes a newer `updatedAt`: every
  `toursRepo` writer sets `#updatedAt = :now` (`toursRepo.ts:482, 517, 534,
  560, 585, 613, 649, 694`) and create sets it (`:382`). So the later copy
  wins, in place, as before.
- A tie still goes to the later read (the `:305` case).
- Every seed sets `updatedAt` (`cast.ts:557, 818`; `live.ts:368, 381, 394`;
  `performance.ts:666`; matrix `updatedAt: createdAt`), so no comparison
  meets `undefined`.
- The stale-index case R2-2 describes is now also correct across pages: a
  stale U copy on a later page no longer overwrites the dated D copy.

### 3.5 Are the GLOSSARY, issue edits, comments and spec amendments accurate?

- **GLOSSARY** (`GLOSSARY.md:366-372`). It now says "Not booked" appeared on
  the tour page and the three tour lists, that Past and Today said
  "Undated", and that Closed showed a blank. That matches spec P7.
  `undatedTourLabel` is now "the one implementation ... every surface ...
  reads it" (spec 8). One vocabulary slip (N5).
- **Comments** (`tables.ts:519-522, 533-536`; `toursRepo.ts:13`). The reader
  list is exact. `git grep` finds `listByScheduledRange` called only at
  `routes/today.ts:550` and `routes/tours.ts:432`, and `queryListPhase` only
  through `services/tourListPage.ts`. No job reads the index.
- **Issues.**
  - `tours-all-server-side-search`: server-side search is preferred; the
    cache option is marked as needing a spec change plus per-tour
    invalidation; the TTL point is kept. Accurate.
  - The resolved `tours-scheduled-range-query-unpaginated` gains one line
    naming the rename (`:88`). Accurate.
  - The three `ATV` citations now name the `data.status === 'error'` branch,
    the `userActed` effect and `rowView` - each verified present (`ATV:732`,
    `:491`, `:233`).
  - The two new issues (`units-contacts-batchget-walk-duplicated`,
    `tour-list-date-inputs-half-typed-year`) are accurate.
  - The `TODO(units-contacts-batchget-walk-duplicated)` marker
    (`unitsRepo.ts:581`) follows AGENTS.md's `TODO(<issue-slug>):` form.
- **Spec amendments.** Section 7 (`:735-740`) and section 9 (`:805`) now say
  `queryLimit`, each marked ADV-F4, and match `toursRepo.ts:213` and
  `toursRepo.integration.test.ts:293`.
- Added lines are ASCII (0 non-ASCII bytes in the delta).

## 4. Contesting the rulings

- **R2-1's "else to the count line": contested.** This is R3-F1. The ruling
  fixed the focus drop but chose the one target that recreates the long walk,
  and adds a viewport jump, for the empty-page paths.
- **R2-3 DEFER (half-typed years): conceded.** The behavior follows spec
  4.3's letter (a From-after-To range shows the message and sends nothing).
  It is unconfirmed outside Chromium, and each fix trades something; a
  confirm-first issue is the right home.
- **Everything else** (R2-2, R2-4, R2-5, R2-F2..F5, ADV-F5 -> DEFER) took the
  position I argued; nothing left to contest.

## 5. Are the fixes correct, or merely plausible?

| item | verdict | basis |
|---|---|---|
| R2-1 busy control + focus hand-off | correct to the amended text in every branch (section 3.3) | the target for the empty-page branches is the defect - R3-F1 |
| R2-2 newer copy wins | correct | every writer and seed sets `updatedAt`, canonical ISO; ties to the later read; two discriminating cases |
| R2-4 + R2-F3 `queryLimit` in the spec | correct | sections 7 and 9 match code and test; the resolved issue names the rename; the plan stays a record (ruled) |
| R2-5 index comments | correct | reader list matches `git grep` |
| R2-F2 cache option | correct | marked as needing a spec change and invalidation |
| R2-F4 GLOSSARY | correct | one vocabulary slip (N5) |
| R2-F5 symbol citations | correct | three symbols verified present |
| ADV-F5 DEFER + TODO | correct | issue and marker in the house form |
| R2-3 DEFER | correct | confirm-first issue |

## 6. Verdict changes to the table (rounds 1 and 2)

| item | before | round 3 | evidence | note |
|---|---|---|---|---|
| S1 range read + Today warning | DEVIATES-RULED (ADV-F4) | CONFORMS | spec `:735-740` amended in place; `toursRepo.ts:213` | the contract now says `queryLimit` |
| 7 `listByScheduledRange` via `queryAll` + optional third argument | DEVIATES-RULED (ADV-F4) | CONFORMS | spec `:735-740`; `toursRepo.integration.test.ts:293` | as S1 |
| NEW: 4.5 keyboard focus after the action controls (amended, R2-1) | - | CONFORMS | `ATV:396-421, 469-485, 531-563`; section 3.3 | the amended rule's "else to the count line" target is R3-F1 |
| NEW: 9 dashboard "the pressed control busy and focused ... one case per control" | - | CONFORMS | `AllToursView.test.tsx:1480-1646` | nine cases, RED and mutant-proven |

Unchanged but re-checked against the amended text:

- 4.5 one loader at a time (now "hidden during an automatic loader, busy
  during the user's own") - CONFORMS.
- 4.5 Load more visibility - CONFORMS.
- 4.5 de-duplication (now "the newer copy") - CONFORMS.

Counts: 145 CONFORMS, 16 DEVIATES-RULED, 0 DEVIATES-UNRULED, 0 PARTIAL,
0 MISSING (161).

## 7. Notes (no severity)

- **N1.** 4.5's focus bullet says focus moves "never after the first page",
  yet two sentences earlier it moves focus to the first row "when the new
  first page lands" after Start over or the first-page Retry. Suggest "never
  after a first page the user did not ask for (arrival, a filter change)".
- **N2.** 4.5's de-duplication bullet still reads "on append". Since SC-F2
  the first page is de-duplicated too, and 5.3 relies on it.
- **N3.** Rows added but none visible under a search: the code hands focus
  to the action control (`ATV:556`). The text covers only "when no row was
  added".
- **N4.** The ONE LOADER bullet's list of loaders omits Retry after a failed
  page, Start over and the first-page Retry, which the next sentences then
  treat as the user's requests.
- **N5.** GLOSSARY `:369` says "the tenant, landlord and property files'
  tour lists". The house word, and the entry's own two sentences earlier,
  is "the property page".
- **N6.** The busy control shows no progress mark: it is only dimmed through
  `.button[aria-busy='true']` (`Button.module.css:16-21`). `Button`'s
  `loading` prop would add a spinner, but it also sets `disabled`
  (`Button.tsx:70-71`), which the amendment rightly avoids. Rendering
  `<Spinner size="sm" />` as a child keeps the house look without
  `disabled`. Polish.
- **N7.** The first-cursor-400 restart after a pressed control (focus to the
  count line) is in fix-wave-2's table but has no case. It is a sub-case of
  the "else" branch and unaffected by R3-F1's fix (the restarted list has
  no rows while it reloads).
