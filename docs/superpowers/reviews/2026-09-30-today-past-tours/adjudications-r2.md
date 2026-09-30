# Adjudications - round-2 re-review of feat/today-past-tours @d955c00f

Planner rulings on `review-r2-adversarial.md`. The reviewer conceded all
three round-1 rejections (M1, L4, L6).

| # | Ruling | Why |
|---|---|---|
| N1 | REJECT the skeleton; ACCEPT a latency cut | A reserved-height placeholder cannot know the row count (0 to 5 rows, a link, sometimes nothing) until the load ends, so it would still shift - by the difference - and it would flash an empty section on the common "nothing qualifies" page. The honest lever is arriving sooner: the property lookups now start with the tenant lookups instead of after them, so the section lands one round trip after its tour reads rather than two. /api/today itself is the heavier call (a server-side fan-out), so the two usually land close together. |
| N2 | ACCEPT | Drop the todayPastTours background declaration and its ledger entry (the background count and fingerprint pin go back to 12), with a note in collect.ts saying why it is undeclared: its shapes are common detail reads, the declaration set is global, and perf samples block writes, so the reload never fires while sampling. |
| N3 | PARTIAL | ACCEPT the name cache: successful contact and property lookups persist across reloads for the hook's lifetime (failures are not cached, so a transient error retries on the next reload). REJECT the event filter: roster actions - the worker-emitted events in the scenario - act on scheduled tours, so a "listed tourId or status scheduled" filter passes them anyway and buys nearly nothing while adding a second rule about which tours matter. At Sam's scale (a few staff tabs) a burst of roster applies costs a few dozen extra reads. |
| N4 | ACCEPT | The close-nag "Open" link carries the back pointer when its owner is a tour. |
| N5 | ACCEPT | Each id joins the cleanup list right after its createTour. |
| N6 | ACCEPT | Pass `reloadFailed` through; the section shows a one-line "Could not refresh" note under the rows (the Past tab's pattern). |
| P-a | ACCEPT | The 880px check first asserts the pane is under 760px, so a changed sidebar default fails loudly instead of silently testing the one-line layout. |
| P-b | REJECT | App-wide and pre-existing: the dashboard's `request` helper has no timeout (`dashboard/src/api/client.ts:146`), so a stalled read leaves any page's spinner running - including Today's own /api/today, where it did before this branch. A timeout policy belongs to the client, not to one section. |
