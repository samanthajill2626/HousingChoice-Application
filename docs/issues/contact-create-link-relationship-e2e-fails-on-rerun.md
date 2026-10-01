---
id: contact-create-link-relationship-e2e-fails-on-rerun
title: contact-create.spec "editing a contact can LINK an existing contact" intermittently loses its suggestion list to a late-reported scroll (NOT lane state)
type: bug
severity: med
status: resolved
area: e2e
created: 2026-09-30
resolved: 2026-10-01
refs: e2e/tests/dashboard-next/contact-create.spec.ts:157, dashboard/src/routes/contact/ContactSearchField.tsx, dashboard/src/routes/contact/UnitSearchField.tsx, docs/superpowers/reviews/2026-10-01-search-scroll-prefill/diagnosis.md
---

**CORRECTION (2026-10-01): the lane-state hypothesis below is WRONG.** Every
`npm run e2e` wipes and reseeds the lane at startup, so nothing accumulates
between runs, and the roster always held Marcus Bell. The failure is a ~1-in-10
race in the search field's dismiss-on-scroll; see the Resolution at the end.

**Problem.** `e2e/tests/dashboard-next/contact-create.spec.ts:157` ("editing a
contact can LINK an existing contact as a relationship (not just free text)")
times out after 60s waiting for the relationship search's suggestions:
`getByRole('listbox', { name: 'Contact search 1 suggestions' })` never shows
an option for "Marcus Bell". The page snapshot shows the search box holding
"Marcus" and no listbox at all.

It reproduces ON MAIN, so it is not a branch regression. Evidence gathered
2026-09-30 while gating feat/today-past-tours (records in
`docs/superpowers/reviews/2026-09-30-today-past-tours/gate-runs.md`):

- main @f93b7381, the test ALONE (`npm run e2e -w e2e -- --grep "editing a
  contact can LINK"`), four consecutive runs in one worktree: pass, then
  fail, fail, fail - the same timeout each time.
- feat/today-past-tours, alone, two runs: pass, then fail.
- Full suites: failed in 2 of 3 branch runs, passed in main's one full run.

The pattern - the first run on a lane passes, re-runs fail - points at lane
state. The spec does not reseed, and each run creates another "Edie EditLink
<stamp>" tenant. UNVERIFIED hypothesis: the edit dialog's candidate roster
(`editCandidates` = `allContacts` minus self, `ContactDetail.tsx:514`) or the
search's match list stops including the seeded landlord once the lane holds
more contacts (a first-page read or a result cap), which would also be a real
product bug for large contact lists, not just a test problem.

AGENTS.md's named-flake list is empty, so this is a regression to diagnose,
not a flake to re-run.

**Suggested fix.** Diagnose first: in a lane where it fails, check whether
Marcus Bell is in `allContacts` (the network tab / the hook's source) and
whether the typeahead filters or caps matches. If the roster is truncated, fix
the read; separately, make the spec self-sufficient (reseed in beforeAll, or
create its own link target) so its result does not depend on lane history.

**Resolution (2026-10-01, fix/search-scroll-prefill).** `ContactSearchField`
dismissed its position:fixed list on ANY scroll. Browsers report a scroll at
the next rendering frame, so the edit dialog's scroll from the spec's
`fill('Caseworker')` was sometimes delivered just AFTER `fill('Marcus')` opened
the list - and closed a list that had been measured post-scroll and was
correctly placed. The spec types once and waits, so it never recovered.
Instrumented event order, roster checks, and the ruled-out hypotheses are in
`docs/superpowers/reviews/2026-10-01-search-scroll-prefill/diagnosis.md`.

Fix: `ContactSearchField` and `UnitSearchField` (same listener) record the
input's position when the list is measured and ignore a scroll that left it
there; a scroll that moved the input still dismisses. Unit tests cover both
directions in each field. No spec change was needed. Real spec
`--repeat-each 40`: main 36 pass / 4 fail, the fix 40 / 0
(`measurements.md` beside the diagnosis).
