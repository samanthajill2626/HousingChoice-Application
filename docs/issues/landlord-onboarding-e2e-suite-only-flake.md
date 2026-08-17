---
id: landlord-onboarding-e2e-suite-only-flake
title: landlord-onboarding "unit available" step fails in the full e2e suite but passes alone
type: bug
severity: low
status: open
area: e2e
created: 2026-08-17
refs: e2e/tests/scenarios/landlord-onboarding.spec.ts:95, e2e/scenarios/steps.ts:1559, dashboard/src/routes/listing/ListingDetail.tsx:742
---

**Problem.** On 2026-08-17 a full `npm run e2e` run failed one spec while the
other 232 passed:

    [chromium] tests\scenarios\landlord-onboarding.spec.ts:95:1
    cold call -> interested -> signed -> onboarded -> unit available -> handoff
    > App: unit available + flyer live + shown on property detail

    Error: expect(locator).toBeVisible() failed
    Locator: locator('section')
      .filter({ has: getByRole('heading', { name: 'Property details' }) })
      .getByText('Voucher size accepted')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found
      at e2e/scenarios/steps.ts:1559

The same spec FILE then passed 7/7 in isolation (45.6s), and a full-suite re-run
passed 233/233. That pass-alone / fail-in-suite signature is the same
cross-spec process-state shape this repo has hit before (see
`reseed-epoch-cache-bug`), not a defect in the code under test: the assertion
reads a detail row that `ListingDetail.tsx:742` renders only when
`unit.voucher_size_accepted` is set, so the most likely cause is the unit the
scenario just published being read back without that field - a seeding/reseed
ordering or cache interaction with whatever spec ran before it in that shard.

Observed exactly ONCE so far, which is why it is filed rather than added to the
known-flake list in `AGENTS.md`. If it recurs, add it there so future runs
re-run once before blaming the change under test.

Context: seen on branch `feat/inbound-message-push` immediately after syncing
`main` (51 commits, including the manual-extraction-trigger merge, which added a
new e2e spec and so changed spec ordering/sharding). The branch under test
touches nothing in the listing, unit, seed or scenario-steps code paths, and the
same suite was green on the same branch before the sync.

**Suggested fix.** Reproduce by running the scenarios directory as one shard in
the order the full suite uses, then determine whether the published unit is
missing `voucher_size_accepted` at read time (server-side) or merely not yet
rendered (client-side timing). If server-side, look for state carried across
specs in the same worker process; if client-side, the step needs to wait on the
detail row's data rather than its visibility.
