---
id: tour-hold-reading-disagrees-with-tours-page
title: A blast's tour-hold label and the Tours page read a toured tour differently - a convertible tour with no outcome, or one carrying a conversion claim, gets two labels (label only; the tenant is held either way)
type: debt
severity: low
status: open
area: app/broadcasts, dashboard/tours
created: 2026-10-19
refs: app/src/lib/blastAudienceRules.ts:100-103, dashboard/src/api/types.ts:937-945, dashboard/src/routes/tours/useTours.ts:189-191, dashboard/src/routes/tours/useTours.ts:264-268, app/src/routes/tours.ts:1296, app/src/routes/tours.ts:1323-1327, dashboard/src/routes/tours/TourDetail.tsx:597-601, app/src/lib/toursModel.ts:201-205, docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:343-351
---

**Problem.** Two copies of "what state is this toured tour in" disagree.
The matching-blast-rules hold rule, `tourHoldOf`
(`app/src/lib/blastAudienceRules.ts:100-103`, its `toured` branch), checks
`convertible === true` BEFORE `outcome` and never reads
`convertedPlacementId` - exactly spec D4's table
(`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:343-351`).
The dashboard's readers of the same fields - `tourStatusLabel`
(`dashboard/src/api/types.ts:937-945`; the Tours page and the tour page) and
`needsPlacement` / `pastState`
(`dashboard/src/routes/tours/useTours.ts:189-191`, `:264-268`; the Past tab
and Today) - check `outcome === undefined` FIRST, and call a tour "needs
placement" only while it has no `convertedPlacementId`. Two shapes get two
different labels:

- A toured tour that is `convertible` with NO outcome. The API accepts an
  exit gate that sends only `moveForward: true` (`app/src/routes/tours.ts:1296`
  requires only status toured; `:1323-1327` sets `convertible` from it with no
  outcome). The Tours page and Today say "Toured - needs outcome" / "Needs
  outcome"; Review recipients labels the same tenant "Toured Oct 5, needs
  placement". The dashboard's own exit gate always sends both fields
  (`dashboard/src/routes/tours/TourDetail.tsx:597-601`), so only an API
  client reaches this today. The auto-close sweep skips convertible tours, so
  the tenant stays held under the disagreeing label until someone acts.
- A toured, convertible tour carrying a `convertedPlacementId` (the
  `pending:<uuid>` sentinel while a conversion claim runs, or a claim
  stranded until its release). `needsPlacement` is false, so the Tours page
  says "Toured"; `tourHoldOf` ignores the field and labels it "needs
  placement".

Effect: LABEL ONLY. Every shape above is a hold, so the tenant is left
unchecked either way and nobody is texted by default who should not be. The
risk is the duplicated rule itself: the copies already drift, and a third
reading of the same fields, `autoCloseDueAtMs`
(`app/src/lib/toursModel.ts:201-205`), has its own order again.

Found by the planner's plan-blind adversarial review of
`feat/matching-blast-rules` (PA-1,
`docs/superpowers/reviews/2026-10-14-matching-blast-rules/planner-review/adversarial.md`),
ruled FILE (low) in `planner-review/adjudications.md` (same folder).

**Suggested fix.** One shared reading of a tour's state: a single
classifier (server-side, with a dashboard mirror kept in step by tests, as
`authoritiesOf` is) that the hold rule, the Tours page / Today labels and the
auto-close clock all read. Which label wins is a product call, because spec
D4 checks `convertible` first on purpose and holds a claim in flight as
`needs_placement` (pinned in `app/test/blastAudienceRules.test.ts`): the
shared reading must keep both shapes HELD and only settle the words. Pin the
`moveForward`-only shape in `app/test/blastAudienceRules.test.ts` either way.
