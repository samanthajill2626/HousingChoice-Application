# Planner review (phase 6) - adjudications - feat/tour-list @ 1b896aa4

Planner: the feature-mission planner session, 2026-10-06. Inputs: the
orchestrator's handback (`../handback.md`), the planner's own gate run, a live
QA pass, and two independent read-only reviewers (opus):
`spec-conformance.md` (spec + work map) and `adversarial.md` (plan-blind).

## Planner's own evidence (before any fix)

Gates on 1b896aa4, run bare by the planner from a detached script, each exit
code captured on the line after its command and verdicts read from the logs:

1. `npm run typecheck` - exit 0.
2. `npm test` - exit 0: app 410 files / 8370 passed + 1 skipped (the by-design
   diagnostic), dashboard 220 / 3898, e2e workspace 22 / 503, fake-twilio
   34 / 275, fake-twilio-web 13 / 111; zero `[dynamoAdmin]` lines.
3. `npm run smoke` - exit 0.
4. `npm run e2e` (under `timeout 2700`) - exit 0: "315 passed (18.5m)";
   results.json expected 315, unexpected 0, flaky 0, skipped 0.
5. eslint over the branch's 53 lintable files - exit 1 as expected; by
   baseline comparison on the same paths at the merge base, 13 rows = 13 rows
   (11 errors, 2 warnings), ZERO new. Method note: the pre-existing
   `react-hooks/purity` message embeds a code frame with line numbers, so the
   comparison keys on the message's FIRST line (file|severity|rule|message);
   keyed on the whole message, the 14-line shift in `TourDetail.tsx` reads as
   7 false "new" rows.

Live QA (hermetic lane 7, `POST /__dev/reseed?profile=full`, Playwright MCP):
the All tab lists 17 tours, and `GET /api/tours/list?limit=3` walked to the
end (6 pages) returns exactly the union of the six per-status reads - no
missing id, no duplicate; dated rows latest first then the undated requests
reading "Needs booking"; the Needs booking chip alone lists the 3 requests
(`?status=requested`); When Past hides the chip, drops it from the URL and
lists 9 past tours latest first; opening the 4th row and pressing "Back to
tours" returns to `/tours/all?when=past` with that row focused; the Active
tab keeps its Upcoming / Needs booking sections, its 3 unbooked requests and
"+ New tour"; a request's tour page reads "Needs booking - ..." and no page
shows "Not booked"; the console held only the pre-login 401. Lane stopped,
ports 9701/9711/9721/9731 free.

## Reviewer verdicts

- Spec conformance: 159 items - 138 CONFORMS, 19 DEVIATES-RULED, 2 PARTIAL,
  0 DEVIATES-UNRULED, 0 MISSING; 0 BLOCKING / HIGH / MEDIUM; 2 LOW; one ruled
  deviation judged wrong (E-1); four notes.
- Plan-blind adversarial: 0 BLOCKING / HIGH / MEDIUM; 5 LOW (one PLAUSIBLE
  magnitude); 15 areas checked and sound.

## Rulings

### SC-F1 (LOW) Cmd- and Shift-click on a row are untested - ACCEPT

Verified: the case at `AllToursView.test.tsx:1179` clicks with Ctrl and Alt
only; the guard (`AllToursView.tsx:442`) covers all four. Add `metaKey` and
`shiftKey` clicks to that case (each writes nothing).

### SC-F2 (LOW) The first page is not de-duplicated - ACCEPT

Verified: `freshState` (`useAllTours.ts:97-116`) takes `page.tours` as-is;
only later pages go through `withPage`'s replace-in-place. A tour in both
phase D and a U phase of one request (a dated `requested` tour - no current
writer makes one) would render twice with a duplicate React key. Route the
first page through the same de-duplication; one hook test.

### E-1, judged wrong by the conformance reviewer (LOW) - ACCEPT

The GLOSSARY's own convention names a retired term (`GLOSSARY.md:111, :300`);
the entry at `:367-369` retires "the single label every undated tour used to
show" without naming it, only to keep a repo-wide grep empty. Name "Not
booked" there as the retired label; the "not booked" grep check excludes
`documentation/GLOSSARY.md` (and `docs/issues/`).

### ADV-F1 (LOW) The undated filter is not the complement of the date index - REJECT

`_schedPartition` on every dated tour is an app-wide invariant that every
date-range reader already depends on - Today's tours, the reminder sweeps,
the Active and Past tabs all read byScheduledAt - and it is type-enforced
(`TourItem._schedPartition: 'tours'` is required), stamped by `create`, and
now by every seed profile (pinned). A read-side complement in ONE reader would
hide a data defect that silently breaks reminders and Today, and would list a
dated tour among the undated ones (and still miss it under a dated When). The
only real exposure is a local stack seeded before fa24547b; the remedy is a
reseed, noted for Cameron in the verdict.

### ADV-F2 (LOW, magnitude not measured) Every render re-derives every row - ACCEPT (the memo); DEFER (the formatter cache)

Verified (`AllToursView.tsx:386`; no React Compiler in the build, only its lint
rules). Memoize the row views on `[data.rows, data.contacts, data.units]` so a
keystroke stops re-formatting every loaded row. The remaining cost - each
landed walk page re-deriving every loaded row, `toLocale*` building a new
formatter per call - matters only at thousands of loaded rows; it is recorded
in `tours-all-server-side-search` with the module-level `Intl.DateTimeFormat`
option (a shared helper the Past and Closed tabs also use).

### ADV-F3 (LOW) A return to a searched All list re-runs the whole walk - DEFER

Real (the list dies with the view; `walk` outranks restore), and costly only
at thousands of tours. Appended to `docs/issues/tours-all-server-side-search.md`
with the reviewer's two options (a short-TTL module cache of the last list, the
Past batch store's precedent; or server-side search).

### ADV-F4 (LOW) `listByScheduledRange`'s `pageLimit` reads as a page cap - ACCEPT

Verified (`toursRepo.ts:208-210, :424`): it is each Query's Limit, so a later
"bound the walk" fix reaching for it would multiply round trips and truncate
at 100 pages. Rename it to `queryLimit` with a docblock saying it is NOT a page
cap (`queryAll`'s `maxPages` is), and pass `{ logger: log }` to that
`queryAll` call. `queryGsi`'s identical pattern is pre-existing and out of
scope. The unbounded-span issue gains the reviewer's severity note (at scale
one request can materialize ~100 MB in the API process).

### ADV-F5 (LOW) Duplicated logic - REJECT

The `getDisplaysByIds` BatchGet walk mirrors `contactsRepo`'s private
`batchGetByIds`; extracting a shared helper would edit `contactsRepo.ts`,
which the parallel feat/clean-org-names branch also edits - a refactor now
buys a merge conflict for no behavior. The `/tours/all` spellings and the
plain-primary-click predicate are one-liners, each pinned by tests (the
TourDetail back-arrow cases, the e2e return, the P15 and row-open cases).

### Notes (no ruling needed)

- SC-N1 (the 300 ms debounce shows "N matches so far - not the whole list"
  before "Searching...") and SC-N3 (a hidden Needs booking selection survives
  When changes but drops when another chip is toggled under a dated When) -
  spec-consistent; recorded for the verdict's minor-UX list.
- SC-N2 (a search typed then cleared during a return restore hands the list
  back to the restore) - fits spec 4.9, pinned at `AllToursView.test.tsx:1423`;
  recorded as a choice.
- SC-N4 (local-day tests depend on the runner's zone) - house-wide, not this
  branch.

## Fix wave

ONE findings list to the orchestrator (fresh foreground child): SC-F1, SC-F2,
E-1, ADV-F2 (memo), ADV-F4, and the two issue appends. Then the SAME two
reviewers re-review the fix diff (re-review charge), and the planner reruns
the full gate battery on the final commit.

## Round 2 (fix wave e666fae3..7267b3be; the SAME two reviewers, re-review charge)

Reports: `adversarial-r2.md` (1 MEDIUM, 4 LOW; F1 and F5 conceded) and
`spec-conformance-r2.md` (5 LOW; 159 items now 141 CONFORMS, 18
DEVIATES-RULED, 0 PARTIAL, 0 DEVIATES-UNRULED, 0 MISSING). Both reviewers
confirmed every round-1 fix correct. Both found the same new keyboard-focus
defect independently.

### Corrections to the round-1 record (ADV-F1)

The F1 rejection stands - both reviewers concede it - but two of its premises
were wrong and are corrected here: (1) the reminder sweeps do NOT read
byScheduledAt (the reminder poll reads `byDueAt` and fetches tours by id;
auto-close reads byStatus), so a dated tour without `_schedPartition` breaks
Today's tours and the Active, Past and All tabs - not reminders; (2) the type
did not enforce the stamp where it actually broke - the matrix and cast seed
rows were untyped (`Record<string, unknown>`), which is exactly why S2 pinned
them. A sharper reason for the rejection (conformance reviewer): the proposed
complement could never reach a `scheduled` tour, which has no U phase. The
stale index comments that misled the record are R2-5 below.

### R2-1 (MEDIUM, adversarial) = R2-F1 (LOW, conformance) - every action button drops keyboard focus to the body - ACCEPT (decision changed)

Verified (`AllToursView.tsx` action area and the first-page Retry): each
control renders only while no loader runs, so pressing it unmounts it and
focus falls to the page body; the view already hands focus over for its other
self-removing buttons, and no test checks focus after these presses. Spec 4.5
said Load more and Keep checking are HIDDEN while any loader runs - the defect
is in that rule, so 4.5 is amended: hidden while an AUTOMATIC loader runs
(the first page, the empty-page follow, the search walk, the return restore);
while the user's OWN request runs (Load more, Keep checking, Retry after a
failed page) the pressed control stays in place, busy, and keeps focus - via
`aria-disabled`, not the `disabled` attribute, which the focus fixup rule can
blur - and when the page lands focus moves to the first newly added row, or
stays on the control when no row was added. Start over and the first-page
Retry rebuild the list: when its first page lands, focus goes to the first
row (or to the count line, made programmatically focusable, when the list is
empty). One view test per control, asserting `document.activeElement`.

### R2-2 (LOW, adversarial) - the de-duplication keeps the later-READ copy, not the newer one - ACCEPT

Two copies of one tour in one page come from two indexes, and index reads can
lag: a booked tour can come back current from the date index and stale (still
`requested`) from the status index, and since a653d944 the stale copy wins.
`mergeRows` replaces a row only when the incoming copy's `updatedAt` is the
same or newer (ISO strings; a tie goes to the later read). The cross-page
reschedule case is unchanged (the later copy is newer). Spec 4.5's "later copy
replaces in place" becomes "the newer copy (by `updatedAt`) replaces in
place". One hook test for the stale-second-copy case.

### R2-3 (LOW, unconfirmed) - date inputs act on every half-typed year - DEFER

Plausible in Chromium (typing a year passes through 0002, 0020, 0202: each a
valid value, so each starts and aborts a list request, and a half-typed To
year flashes the range alert), but unconfirmed, and every fix trades
something (a debounce, or an "incomplete year" state that must not change the
list key). Filed as a low bug with a confirm-first step.

### R2-4 (adversarial) + R2-F3 (conformance) - `pageLimit` survives in the spec and the resolved issue - ACCEPT

Spec sections 7 and 9 are amended in place to `queryLimit`; the resolved
issue `tours-scheduled-range-query-unpaginated` gains one line naming the
rename. The plan is a dated build record and is left as written.

### R2-5 (LOW) - stale comments say reminders and a no-show sweep read the date index - ACCEPT

Comment-only, `toursRepo.ts` header and `tables.ts`' byScheduledAt notes:
name the readers that exist (verify by grep first: Today's tours, the Tours
tabs' range reads, the All tab's phase D).

### R2-F2 (LOW) - the cache remedy recorded in tours-all-server-side-search undoes D9 - ACCEPT

A cached list still holds the row just handled, so a return would focus it
with its old status instead of "the next one to work on", and spec 4.9 says
"fresh reads, never a cache". The issue text marks that option as needing a
spec change plus per-tour invalidation, and prefers server-side search.

### R2-F4 (LOW) - the GLOSSARY overstates where "Not booked" appeared - ACCEPT

It appeared on the tour page and the tenant, landlord and property files'
tour lists; the Past tab and Today already said "Undated" and the Closed tab
showed a blank. And `undatedTourLabel` is the rule's one implementation, not
its "only reader".

### R2-F5 (nit) - stale line citations into AllToursView in three issue files - ACCEPT

Cite by symbol name, written after this wave's code change.

### ADV-F5, contested by the conformance reviewer - REJECT becomes DEFER

The premise was wrong: feat/clean-org-names edits `contactsRepo.ts` far from
`batchGetByIds`. The duplicated BatchGet walk is real debt that will drift:
filed low (debt), with a `TODO(<slug>):` marker at `unitsRepo.getDisplaysByIds`
pointing to its twin. The route-path and click-predicate parts stay rejected
(conceded).

### Round verdict

A decision changed (spec 4.5's hidden-while-loading rule; the merge rule's
newest-wins), so this is not the terminal round: fix wave 2, then the same
two reviewers re-review it, then the planner reruns the full battery on the
final commit.

## Round 3 (fix wave 2, fcdcf9a5..2243d9ef; the SAME two reviewers) - TERMINAL

Reports: `adversarial-r3.md` (1 LOW) and `spec-conformance-r3.md` (1 LOW;
161 items - 145 CONFORMS, 16 DEVIATES-RULED, 0 PARTIAL, 0 DEVIATES-UNRULED,
0 MISSING). Both found the same one defect independently, introduced by
f6b1bc88; every other fix was traced correct in every branch (the anchor and
the focus move can never both hold focus; StrictMode, a filter change, an
unmount and the cursor-400 restart are all handled; `aria-disabled` lets
nothing through; the newer-copy rule keeps the cross-page reschedule case).
All other rulings conceded.

### R3-1 (adversarial) = R3-F1 (conformance), LOW - an empty user-requested page sends focus AND the page to the top - ACCEPT

When a pressed Load more, Keep checking or Retry adds no visible row and
leaves no action control, the fallback is the count line ABOVE the list, and
the move calls `scrollIntoView` (`AllToursView.tsx:557-562`): a jump to the
top - for mouse users too, since focus is already on the body. It fires on
spec 5.4's accepted empty last page (100 dated tours, no undated ones), on an
empty page handed to the automatic follow, and pulls back a user who scrolled
away during a slow request. Fix: on the user's own request path, focus with
`preventScroll` only (no `scrollIntoView`) and fall back to the LAST visible
row's link (the count line only when no row is visible); the rebuild path
(Start over, the first-page Retry) keeps its scroll to the new list's top.
Spec 4.5's focus bullet amended to match; a test for the empty-last-page case
and one for the follow hand-over.

### Notes folded in (precision)

- Spec 4.5 wording (conformance notes): "never after the first page" vs the
  rebuild clause, "on append" for a de-duplication that now covers the first
  page, added-but-not-visible rows, and the list of controls.
- GLOSSARY: "property files" -> "property page" (the house word; the slip
  was the planner's, in the round-2 brief).
- A test for focus after the automatic restart (the first cursor 400).
- NOT taken: a spinner inside the busy control (polish; a nested `Spinner`
  is itself a `role="status"` region).

### Round verdict

A refinement of the same rule, no decision changed: this is the TERMINAL
round. Fix wave 3 folds it in; the planner reviews that diff directly (no
round 4) and reruns the full battery on the final commit.
