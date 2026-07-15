---
id: schedule-tour-form-test-flake
title: ScheduleTourForm "initialUnitId pre-commits the Unit typeahead" test is flaky
type: debt
severity: low
status: open
area: dashboard
created: 2026-07-15
refs: dashboard/src/routes/tours/ScheduleTourForm.test.tsx:497
---

**Problem.** The unit test
`dashboard/src/routes/tours/ScheduleTourForm.test.tsx` -> "initialUnitId
pre-commits the Unit typeahead (read-only + Clear) and derives the tour type"
fails intermittently (~25% of runs). Verified 2026-07-15 on an UNTOUCHED base
during the unit-photos slice-2 gate run: with the feature changes stashed, the
ScheduleTourForm suite (26 tests) was run 4 times and produced 1 failure - so
this is pre-existing and UNRELATED to unit-photos.

The failure is in the `waitFor` that expects the Unit combobox to pre-commit to
the resolved address once the mount fetches settle:

```
await waitFor(() => expect(unitBox).toHaveValue('1450 Joseph E. Boone Blvd NW, Atlanta, GA'));
```

**Suspected cause.** An async race in the mount sequence: the `initialUnitId`
pre-commit depends on the mocked `getUnits`/`getContacts` roster promises
resolving and the derived-tour-type effect running. When the assertion window
loses the scheduling race the combobox is still empty (pre-commit not yet
applied), so the `toHaveValue` check fails before the effect lands. The other
25+ tests in the file are stable; only this pre-commit-on-mount path flakes,
which points at the initial roster-load -> pre-commit ordering rather than the
typeahead interaction paths (those drive user events that implicitly await).

Not blocking: it passes on re-run and is isolated to one assertion. Deferred
rather than fixed here (out of scope for unit-photos). A likely fix is to gate
the assertion on a settled-roster signal first (e.g. await the locked Tenant
label, as sibling tests do) before asserting the pre-committed unit value, or to
make the pre-commit effect deterministic w.r.t. the mount fetches.
