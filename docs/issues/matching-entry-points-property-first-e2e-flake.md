---
id: matching-entry-points-property-first-e2e-flake
title: matching-entry-points "Send a property" spec flakes - typeahead dropdown intercepts the unit-row click
type: bug
severity: med
status: open
area: e2e
created: 2026-07-21
updated: 2026-08-21
refs: e2e/tests/dashboard-next/matching-entry-points.spec.ts:265, dashboard/src/routes/broadcasts/BroadcastComposer.tsx
---

<!--
  MERGED 2026-08-21. `matching-entry-points-picker-click-flake` (low, filed the
  same day by a different mission) described this same spec line, this same
  interception signature, and this same fix. Its file was deleted and its
  distinct content - the verbatim failure text and the third sighting, which
  disproves the load-only theory - folded in below. Do not re-file it.
-->

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

The verbatim signature to match sightings against:

```
locator.click: Test timeout of 30000ms exceeded
- waiting for getByRole('button', { name: /887058 Matching Entry/ })
  - locator resolved to <button class="_unitRow_...">
- <li role="option" ... class="_option_...">887058 Matching Entry Ave...</li>
  from <div class="_pickerField_...">... subtree intercepts pointer events
- retrying click action
```

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

Further sightings from the merged issue, on unrelated branches (the picker
surface untouched by all of them), confirming it is not any one branch's
regression:

- unit-photo-transcode gate battery: failed 2x and passed 3x on the SAME tree
  within one hour; base commit `6d8eec0c` passes the test solo.
- final gate battery on the merged tip `f16285d4`: failed in the full run,
  passed 3/3 solo minutes later.
- planner gates on `0fd65de4`: **reproduced once in a SOLO 3-spec run.** This is
  the important one - the overlay race is INTRINSIC, not merely load-amplified,
  so "it only fails under full-suite load" is not a safe assumption when
  adjudicating a gate.

This is gate noise for every branch: a red full-suite run that is nobody's
regression. A real user can hit the same overlay, so the component-side fix
below is worth more than the spec-side one.

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
