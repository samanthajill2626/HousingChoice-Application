# Adjudications - adversarial review of feat/today-past-tours @82ea97a3

Planner rulings on `review-adversarial.md`. ACCEPT = fixed in the fix wave;
REJECT = no change, reason given; DEFER = filed to `docs/issues/`.

Decisions Cameron took on 2026-09-30 that bound these rulings: Today lists the
Past tab's rows minus no-shows; same window as the Past tab; up to five rows,
most recent first, with a "See all N on the Past tab" link; the section sits
after "Follow-ups due"; no badge or count elsewhere; reuse the Past tab's rule,
never a second copy.

| # | Ruling | Why |
|---|---|---|
| M1 | REJECT | The load-bearing premise is wrong for app-recorded outcomes. The Record outcome dialog closes the tour on "not a fit" in the same PATCH (`dashboard/src/routes/tours/TourDetail.tsx:541`) and the move-forward conversion closes it (`app/src/routes/placements.ts:772`), so the `status=toured` partition holds open work (undecided tours, failed conversions, API-only outcomes), not history. Assembling the section server-side is the second copy of the Past rule Cameron ruled out, and dropping the status=toured read drops the Past tab's off-range rows (a different rule). Reload volume is one small burst per human tour action, less than the `/api/today` refetch that already runs per placement/conversation event. The deleted-tenant skip mirrors the server's board rule by design (stated in the hook header); it is a display filter, not a selection rule. |
| M2 | ACCEPT | Real contract drift for `npm run perf:pages`. Add the new Today GETs to `TODAY_GETS` as conditional shapes, the new list to `TODAY_TERMINAL`, a background-refresh declaration for the tour.updated reload, and refresh the '/' ledger citations. |
| L1 | ACCEPT | Also fixes a pre-existing staleness: Tours today did not drop a canceled or toured tour until an unrelated event. `useToday` subscribes to `onTourUpdated`. |
| L2 | ACCEPT | Rewrite with fake timers: events in separate acts, no reload inside the window, exactly one after it. |
| L3 | ACCEPT | Count what the destination shows: `total` becomes the Past tab's full row count (no-shows and deleted tenants included), so "See all N on the Past tab" matches the Past tab. The link shows the count whenever the Past tab holds more than Today lists. |
| L4 | REJECT | Order is Cameron's ruling (the Past tab's order, most recent first). Off-range rows last is the Past tab's own rule (spec 4.2a); changing it is a Past-tab change. The "See all" link covers the rest. |
| L5 | ACCEPT | Show the Spinner while the page is otherwise empty and the section has not settled. |
| L6 | REJECT | A queue failure is the page's error state ("We couldn't load your queue. Please try again."); one error state is clearer than a partial page, and the case is rare. |
| L7 | DEFER | A Today-wide gap (`useToday` has it too), not introduced here. Filed `today-page-no-refetch-on-reconnect-or-midnight`. |
| L8 | ACCEPT | Track created ids at describe scope and decide them in `afterEach`. |
| L9 | DEFER | Already filed as `tours-scheduled-range-query-unpaginated`; the issue gains a note that Today now reads it too. |
| L10 | ACCEPT | Server "Tours today" rows also carry the back pointer, so every tour opened from Today returns to Today. |
| L11 | NO ACTION | Informational; no current collision (the reviewer's own sweep). The full e2e gate is the check. |
| P1 | ACCEPT (via M2) | The new list joins `TODAY_TERMINAL`'s populated set. |
| P2 | ACCEPT (confirmed live) | A 43-character tenant name at an 880px window (a 592px pane) ran into the date and pushed the property out of the row entirely. Past-tour rows now stack below a 760px pane (name, property, then the chips; name and property wrap) and the name ellipsizes rather than overlapping on a wide row. Verified clean at 360 / 700 / 880 / 960 / 1280 with the long name; the spec gains an 880px no-clipping check that fails on the old CSS. |
