---
id: matching-entry-points-property-first-e2e-flake
title: matching-entry-points "Send a property" spec flakes - typeahead dropdown intercepts the unit-row click
type: bug
severity: med
status: open
area: e2e
created: 2026-07-21
refs: e2e/tests/dashboard-next/matching-entry-points.spec.ts:265, dashboard/src/routes/broadcasts/BroadcastComposer.tsx
---

**Problem.** The "Matching page 'Send a property': property-first step" test
(matching-entry-points.spec.ts:265) fails intermittently with a stable
signature: after the spec fills the Property combobox and presses Escape to
dismiss the typeahead, the click on the browsable unit-row button times out
because the typeahead's option `<li>` (`role=option`, `_option_...`) still
"intercepts pointer events" over the row - i.e. the dropdown is open again (or
never closed) when the click lands. The spec itself documents the overlay
hazard ("Dismiss the typeahead dropdown (it overlays the list)"), and the
plausible mechanism is a race: the fill() fires a search request, Escape closes
the list, then the late search RESPONSE re-opens it.

Evidence (2026-07-21, unit-media-cloudfront gate runs, all same signature):

- FAILS at the BASE commit 705a7e14 with no feature code present (detached
  run, 1 failed / 2 passed) - definitively pre-existing, not introduced by any
  current branch.
- Failed in 2/2 full-suite runs on the feature branch (181p/2f then 182p/1f);
  passed 2/3 pair-solo runs and failed the 3rd - so it is probabilistic solo
  too, and worse under machine load (another agent's e2e session was live).
- Earlier missions' ledgers record the same spec as half of this box's
  "contention pair" (with scheduled-visibility.spec.ts:131, whose
  reminder-count predicate misses only under full-suite load), needing
  repeated solo-evidence runs.

This is gate noise for every branch: a red full-suite run that is nobody's
regression.

**Suggested fix.** Two independent hardenings, either sufficient:

- Spec-side: after Escape, explicitly await the dropdown's disappearance
  (`await expect(page.getByRole('listbox')).toBeHidden()` or option count 0)
  before clicking the row - and if the component can re-open on a late
  response, wait for network idle on the search request first.
- Component-side (BroadcastComposer property picker): do not re-open the
  option list when a search response arrives after the field was
  escaped/blurred (track a "dismissed at" generation counter against the
  request), and/or render the browsable rows non-overlapped by the dropdown.

Until fixed, treat the pass-solo/fail-in-suite pattern with this exact
intercept signature as this issue, not the branch under test (verify solo
before blaming a change).
