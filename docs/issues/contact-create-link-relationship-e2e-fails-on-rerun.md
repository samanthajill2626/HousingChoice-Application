---
id: contact-create-link-relationship-e2e-fails-on-rerun
title: contact-create.spec "editing a contact can LINK an existing contact" fails on main when re-run on the same lane (no suggestions list)
type: bug
severity: med
status: open
area: e2e
created: 2026-09-30
refs: e2e/tests/dashboard-next/contact-create.spec.ts:157, dashboard/src/routes/contact/ContactDetail.tsx:514, dashboard/src/routes/contact/RelationshipsEditor.tsx
---

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
