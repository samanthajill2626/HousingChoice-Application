# Plan research findings - E2E, perf registry and docs (tour list)

Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md` (DRAFT 6), checked
against branch `feat/tour-list` @ df76f00a, 2026-10-06. Read-only research.
Byte-exact quotations live in the reference file
`.superpowers/sdd/plan-research/e2e-docs-reference.md` (gitignored); this file
holds only the places where the spec is wrong or incomplete about the
code/tests/docs. Every other e2e/perf/docs citation in sections 4.2, 4.11, 9
and P7/P11/P12 was verified and holds (routes.test.ts:287, 376-385, 422-455;
routes.ts:282-290, 614-615, 724-725, 753-755, 778-779, 886-891;
tours-page.spec.ts:242; steps.ts:1147, 1176, 1854-1856; tours.spec.ts:417;
ToursPage.test.tsx:507-511; the lean world has no tours).

## F1 - P7 sends one listed comment to the wrong word (low)

P7 says the listed tests and e2e steps "move to 'Needs booking'", including
"the comments at `TourModals.tsx:203`". That comment is the docblock of
`MarkAlreadyTouredModal` (`dashboard/src/routes/tours/TourModals.tsx:195-207`):
supplying the optional date makes the Schedule card and date-range views show
a real date "instead of 'Not booked'". It describes a tour marked toured with
the date left blank - an undated TOURED tour, which reads "Undated" under D8
and P7, not "Needs booking". Every other listed site is a `requested` tour
(`TourDetail.test.tsx:302`, `files.test.tsx:272, 464`,
`ListingDetail.test.tsx:433`, `tours-page.spec.ts:226-242` (timeless create),
`steps.ts:1159` and `1853-1856`, `tours.spec.ts:417`), so "Needs booking" is
right for them.

Fix for the plan: `TourModals.tsx:203` moves to "Undated".

## F2 - P7's inventory of "Not booked" text misses three places (low)

P7 enumerates the assertions and the comments that say "Not booked". A phrase
grep finds those; it misses two comments that split the phrase across lines
and one living doc:

- `e2e/scenarios/steps.ts:1168-1169` - "the row reads "<address> . Not" /
  "booked"" (1168 carries a NON-ASCII middle dot; the comment already
  misdescribes the row, which renders "<unit> - ..." with an ASCII hyphen,
  `dashboard/src/routes/contact/TenantFile.tsx:334-338`). Touched, the line
  must become ASCII.
- `e2e/tests/dashboard-next/tours-page.spec.ts:238-239` - "plus a "Not" /
  "booked" facts line", the comment directly above the line-242 assertion P7
  does list.
- `documentation/sequence-diagram-to-test.md:262-263` - the living e2e method
  doc says requested rows "render 'Not booked'/'Not yet booked'" (263 carries a
  NON-ASCII em dash). Not a historical doc (it is under `documentation/`, not a
  dated `docs/superpowers/` record), so it goes stale with D8.

Optional: `tours-page.spec.ts:479` "(requested, not booked)" is lower-case
prose, accurate as English; leave or align.

The UI claim holds: the only product code that prints "Not booked" is
`TourDetail.tsx:312`, `TenantFile.tsx:337`, `LandlordFile.tsx:217`,
`ListingDetail.tsx:1084` - the four P7 names.

Also for the plan (AGENTS.md ASCII rule): the two test titles P7 renames,
`dashboard/src/routes/contact/files.test.tsx:266` and `:458`, each contain a
NON-ASCII em dash; a touched title must become ASCII.

## F3 - 4.11 widens the issue but not the two other places that state the gap (low)

4.11 adds `/tours/all` to the route-pin `excluded` set and widens
`docs/issues/perf-pages-tours-past-surface.md` to cover both routes. Two more
places describe the gap as `/tours/past` only and are not named:

- `e2e/README.md:83-86` - "Known gap: the Tours page's Past tab
  (`/tours/past`, added 2026-09-27) is not a registered destination yet ...
  excluded on purpose in `e2e/performance/routes.test.ts`".
- `e2e/performance/routes.ts:616-627` - the `TODO(perf-pages-tours-past-surface)`
  KNOWN GAP comment ("there is NO row for /tours/past ...").

(`routes.test.ts:381`, the comment above the excluded entry, is generic enough
to cover both.) The issue's slug must not change when it widens: the filename
is the id (`docs/issues/README.md:35-38`) and it is referenced at
`routes.ts:616`, `routes.ts:627`, `routes.test.ts:381` and `e2e/README.md:86`.

## F4 - a ledger citation this change moves is outside 4.11's refresh list (low, gate-neutral)

4.11 refreshes the `CONTRACT_SOURCE_LEDGER` citations "that the 4.2 split
moves" (724-725, 753-755, 778-779 and the App.tsx resolver at 803) - correct
for the split. But the change also edits `TourDetail.tsx` above the line the
ledger cites for the `/tours/:tourId` terminal: `e2e/performance/routes.ts:797`
cites `TourDetail.tsx:630` for the "Back to tours" link, while 4.8 edits
`BACK_TARGETS` / `backHref` (`TourDetail.tsx:113-124`) and P7 edits line 312.
That citation is ALREADY stale on main (line 630 is the closing `</Button>` of
Mark toured; the back link is `TourDetail.tsx:683`). Related pre-existing drift
the refresh may as well fix: `routes.ts:716` cites `useTours.ts:296-343` in a
340-line file (spec 3.1 puts the Past reads at 293-340), and
`ToursPage.tsx:643-647` (724-725) already points at the tail of
`crossRefError`, not the hooks (621-627, 635). `routes.ts:126`
(`CONTRACT_SOURCES.registry`) repeats the App.tsx citation, but nothing imports
`CONTRACT_SOURCES`. None of this can fail a gate: the citation test checks
format only (`routes.test.ts:423`), and the only exactly pinned ledger strings
are the `background` ones (`e2e/performance/collect.test.ts:366-379`), which
cite no tours-list file.
