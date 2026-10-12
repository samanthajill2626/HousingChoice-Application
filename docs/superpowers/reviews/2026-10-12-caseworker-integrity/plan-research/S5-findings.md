# S5 plan research - findings (caseworker integrity)

Plan-section writer for slice S5, 2026-10-12. Findings only; code is cited by
`file:line` on the tree at @54f9e6ed. Each finding changes a decision the spec
made (its copy-site list and its e2e ask), so it is recorded here as well as in
the S5 draft's CONTRACT ISSUES block.

## F1 - The tour dialogs answer every 409 with "This tour changed"

Spec section 4 "Dashboard copy for section 4" names the sites that must show
the new refusal sentences. For tours it names `TourDetail.tsx` status changes
(:382), Start placement / from-tour (:514) and outcome-then-from-tour (:589),
and `ScheduleTourForm.tsx:326`. It does not name the two dialogs that the
tour page actually uses for the two I2 tour checks a staff member can reach:

- Reopen (`POST /api/tours/:id/reopen`): `TourDetail.tsx:613-618` calls
  `reopenTour` from `ReopenTourModal` (`TourModals.tsx:439-490`), whose catch
  is `failureCopy` (`TourModals.tsx:41-46`, used at :461-462);
- revive (a canceled tour rescheduled, PATCH `{ scheduledAt, status:
  'scheduled' }`): `TourDetail.tsx:543-545` from `RescheduleTourModal`
  (`TourModals.tsx:177`), which is `DateTimeModal` with the same `failureCopy`
  catch (`TourModals.tsx:98-106`). Reschedule is offered on canceled tours
  (`RESCHEDULABLE_UI`, `TourDetail.tsx:106-109`).

`failureCopy` maps ANY `ApiError` 409 to `TOUR_CHANGED_COPY` ("This tour
changed since the page loaded - reload and try again.",
`TourModals.tsx:39`). So after S3 as specified, a reopen or revive refused
with 409 `contact_not_tenant` tells staff the tour changed and to reload -
false, and a reload changes nothing. The spec's "Any other failure keeps each
site's current copy" does not cover this: the 409 is new, not "other".

Proposed resolution (S3's scope): `failureCopy` returns
`contactTypeErrorMessage(err)` when it is non-null, before its 409 rule (W7
holds: null for every other error keeps today's copy). Add the two dialogs to
the copy-site list.

## F2 - No dashboard path reaches a tour I2 refusal at a site the spec lists

Spec section 8 asks the e2e for "a refused tour action shows its sentence".
On the tree no tour action reaches a refusal at a LISTED site:

- create: the pickers load tenants only (`ScheduleTourForm.tsx:179`, spec
  section 1 I2), and team members lose the buttons (spec section 4);
- from-tour (`TourDetail.tsx:514`, :589): the route requires
  `convertible === true` (`app/src/routes/placements.ts:652-655`), and
  `convertible` is written only by the exit gate on a `toured` tour
  (`app/src/routes/tours.ts:1286-1313`) - an OPEN status, so S2's PATCH rule
  refuses the re-type that would set the case up;
- status changes via `runDirect` (`TourDetail.tsx:374-401`) are moves between
  open statuses, which spec section 4 does not check;
- reopen and revive reach the refusal only through the dialogs in F1.

Resolution taken in the S5 draft: the e2e proves the tour refusals at the API
(reopen of a closed tour and revive of a canceled one whose tenant was
re-typed while neither was open) and proves the dashboard SENTENCE on the
placement path the spec does list - a Lost placement moved back from the
placement page (`PlacementDetail.tsx:402`, error bar `:560-563`). If F1 is
adopted in S3, its unit tests cover the dialogs' sentence.
