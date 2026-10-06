# Tour list - plan research: dashboard findings (spec vs code)

Reader: dashboard research reader, 2026-10-06, read-only, against
`W:\tmp\tour-list` @ df76f00a (spec DRAFT 6,
`docs/superpowers/specs/2026-10-06-tour-list-design.md`).

Scope: places where the spec is WRONG or INCOMPLETE about the current dashboard
code. Every other dashboard citation in sections 2, 3, 4, 6 and 9 was checked
and matches the code (line numbers included); the byte-exact reference is
`.superpowers/sdd/plan-research/dashboard-reference.md`.

## F1. [LOW] "Every surface that shows a tour's missing date" omits two surfaces

The spec claims one helper covers every missing-date surface: D8 ("aligned
EVERYWHERE in this change"), P7's reader list, and section 8 ("every surface
that shows a tour's missing date reads it through the one helper
`undatedTourLabel` - the All and Past rows, the tour page, and the tenant,
landlord and property tour lists"). The code has two more surfaces that show a
tour's missing date, and neither is in that list:

1. Today's past-tours row. `dashboard/src/routes/today/Today.tsx:198` builds the
   date with `whenLabel`, `:215` prints a literal "Undated" when it is empty,
   and `:201` puts ", undated" in the row's accessible name. Pinned by
   `dashboard/src/routes/today/Today.test.tsx:356-361`. Output would not change
   through the helper: Today lists the Past tab's rows (`Today.tsx:190-195`),
   which are never `requested` (`dashboard/src/routes/tours/useTours.ts:164-168`
   for the range rows, `:243` for the toured-only off-range rows). So this is
   only an omission from the "one helper" claim - but as written, a builder
   following P7 leaves a second hard-coded "Undated" literal in place.

2. The Closed tab's rows. `TourRow` with `timeDisplay="date"`
   (`dashboard/src/routes/tours/ToursPage.tsx:131-136`, rendered at `:155`; the
   Closed view passes `"date"` at `:804`) prints `formatDate(scheduledAt)`,
   which returns an empty string for an undated tour
   (`dashboard/src/routes/tours/tourTime.ts:72-77`). An undated `closed` or
   `canceled` tour - reachable, per spec 3.4 - therefore shows an EMPTY date
   column on the Closed tab: neither "Undated" nor the helper. D6 keeps Closed's
   behavior "(the one wording change of D8 aside)", and D8 says "EVERYWHERE",
   yet the Closed rows are not among P7's readers, so as specified the Closed
   tab stays blank while the same tour reads "Undated" on its All row and on
   its tour page.

Needs a ruling before the plan fixes its task list: either add both surfaces to
P7 / section 8 (Today through the helper with unchanged output; Closed rows
reading "Undated" - Closed never lists a requested tour - with a test for an
undated canceled row), or state explicitly that Today keeps its literal and the
Closed tab keeps its blank date column. Either way the "every surface" sentence
in section 8 should match what is built.
