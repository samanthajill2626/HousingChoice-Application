---
id: matching-entry-points-picker-click-flake
title: "matching-entry-points.spec.ts:265 unit-picker option list intercepts the unit-row click under load (intermittent)"
type: bug
severity: low
status: open
area: e2e
created: 2026-07-21
refs: e2e/tests/dashboard-next/matching-entry-points.spec.ts:265
---

**Observation (2026-07-21, during the unit-photo-transcode gate battery).**
The Matching-page "Send a property" test failed twice and passed three times on
the same tree (feat/unit-photo-transcode tip) within one hour:

    locator.click: Test timeout of 30000ms exceeded
    - waiting for getByRole('button', { name: /887058 Matching Entry/ })
      - locator resolved to <button class="_unitRow_...">
    - <li role="option" ... class="_option_...">887058 Matching Entry Ave...</li>
      from <div class="_pickerField_...">... subtree intercepts pointer events
    - retrying click action

The unit-search typeahead's OPEN option list overlays the unit row button and
intercepts the click; playwright retries until the 30s test budget dies.

Provenance points at a load-sensitive UI race, not a regression:
- Same commit: FAILED in a full-suite run and a 2-file solo run (busy box:
  another agent's persistent e2e:session live on the machine), then PASSED
  3x consecutively (full run1 + a --repeat-each=2 file run, 1.4-1.7s each).
- The base commit (main 6d8eec0c) passes the same test solo.
- The unit-photo-transcode diff touches ListingDetail photos only - no
  matching-page or unit-search code.

**Suggested fix.** In the test (or the picker), commit the typeahead selection
and wait for the option list to CLOSE (e.g. expect the listbox to be hidden)
before clicking the unit row; alternatively the picker could close its
dropdown on outside-pointer-down before the click is delivered (component
behavior worth a look - a real user can hit the same overlay).
