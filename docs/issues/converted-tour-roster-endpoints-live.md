---
id: converted-tour-roster-endpoints-live
title: A converted tour's roster endpoints still mutate (and announce into) the placement's live group
type: decision
severity: med
status: open
area: app
created: 2026-08-05
refs: app/src/routes/tours.ts,app/src/jobs/rosterActions.ts
---

**Problem.** After a tour converts, the thread pointer moves to the placement
(rebindOwner) - but if the tour retains its pointer/page, the tour's
owner-scoped LIVE roster endpoints have no owner-liveness guard: an operator
on the (stale) tour page can add/remove members of what is now the
PLACEMENT's live group, announcements included. The deferral POLLER refuses
a converted owner (skip reason `converted`), so route and poller disagree
about whether a converted tour may still edit the roster. Found by the
contact-rosters adversarial review (PLAUSIBLE 2).

Blast radius is modest: the edit lands on the RIGHT conversation (the thread
is shared), the announcement is composed correctly, and the placement card
shows the result - the question is whether a converted tour's page should be
a write surface at all.

**Suggested fix.** Product decision first: either (a) freeze the tour People
card read-only after conversion (matching the poller's refusal and pushing
edits to the placement hub), or (b) bless the tour page as an alias surface
and remove the poller's `converted` skip asymmetry for LIVE adds. If (a),
the live endpoints should 409 `converted` with renderable copy.
