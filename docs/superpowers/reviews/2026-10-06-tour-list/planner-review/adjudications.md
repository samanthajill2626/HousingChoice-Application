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
