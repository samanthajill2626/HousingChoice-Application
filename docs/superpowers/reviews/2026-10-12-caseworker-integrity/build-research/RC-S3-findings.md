# RC - S3 live-tree drift check: findings

Reader: RC (read-only research), caseworker-integrity build mission, 2026-10-12.
Tree: `W:\tmp\caseworker-integrity` @670fb701 (branch `fix/caseworker-integrity`;
code identical to main @19607658 - the branch diff is docs only).
Scope: plan slice S3, Tasks 3.1-3.18 + slice gate (plan lines 5590-9228),
against plan sections 0-3, spec sections 1/4/5/8, the assembly rulings,
plan-review adjudications and S5-findings F1/F2.
Reference (quotes, caller lists, anchor table):
`.superpowers/sdd/research/RC-S3-reference.md`.

Headline: NO BLOCKER. 1 CORRECTION (comment-only), 3 NOTEs. All 52 S3
`old_string` anchors are verbatim and unique in the live files (one is the
intended `replace_all` x16; one exists only after Task 3.3 adds it). Every
symbol, harness option, FakeWorld field and dashboard test helper the new code
and tests use exists with the assumed name, path and shape. Every RED fails
for the stated reason and every GREEN passes as written, by reading. The W3
sweep is complete for app tests, dashboard tests and e2e.

---

## F1 - Task 3.2 - CORRECTION (comment-only, non-blocking): the fixture makes a test comment false

**Plan says.** Task 3.2 adds a file-local fixture to `app/test/toursApi.test.ts`
that puts every POSTed `tenantId` in the world as `{ contactId, type: 'tenant' }`
when absent (plan :6123-6151). It edits no other test in that file except 3c.

**Tree holds.** `app/test/toursApi.test.ts:2541-2557`, test
`returns the templated no-show check-in copy, greeting the tenant`, posts
`BASE_CREATE_BODY` at :2550 and its comment (:2545-2548) says
`'contact-tenant-1'` "is never seeded onto world.contacts, so the read finds
nothing and the copy takes the ABSENCE fallback". After Task 3.2 the fixture
seeds a NAMELESS tenant at that POST. The test stays green - a contact without
`firstName` resolves to no first name exactly like an absent one
(`app/src/lib/tourContacts.ts:73-77`, read at
`app/src/routes/tourReminders.ts:963-996`), so the body is still
"Hi there! Do you need to reschedule?" - but the comment becomes false in a
file this task edits.

**Correction.** Add a step 3g to Task 3.2 (same commit). Edit
`app/test/toursApi.test.ts` - old_string (verified unique):

```ts
    // the missing {tenantFirstName}). BASE_CREATE_BODY's 'contact-tenant-1' is
    // never seeded onto world.contacts, so the read finds nothing and the copy
    // takes the ABSENCE fallback - the "greets by name" half is pinned in
    // tourRemindersApi.test.ts, which seeds a named tenant.
```

new_string:

```ts
    // the missing {tenantFirstName}). BASE_CREATE_BODY's 'contact-tenant-1' is
    // put in the world by this file's tenant fixture (see the note above
    // authed()) WITHOUT a name, so the copy takes the no-name fallback - the
    // "greets by name" half is pinned in tourRemindersApi.test.ts, which seeds
    // a named tenant.
```

No assertion changes. (Audit of every other toursApi test that could depend
on an ABSENT tenant: only the 3c ladder test does; see the reference,
section 4.)

---

## F2 - Task 3.2 - NOTE: three inaccuracies in the sweep record (execution unaffected)

a. **Store-created ids listed as POSTed.** The toursApi row names `tenant-a`,
   `tenant-b`, `tenant-c`, `tenant-log-1`, `tenant-log-2` among ids that
   "post /api/tours". Those tours are created straight in the store
   (`world.toursRepo.create(tourInput(...))`, `app/test/toursApi.test.ts:5867-5869`,
   `:5967-5968`); neither the fixture nor I2 touches them.
b. **toursReopenApi has two seeding tests, not one.** Besides
   `seedTenantAndUnit` (`app/test/toursReopenApi.test.ts:156`), the test at
   `:249-252` pushes `{ contactId: TENANT, type: 'tenant', status: 'searching' }`
   before `createTour`. The plan's `some()` guard (plan :6214-6216) keeps that
   contact single - correct as written.
c. **The re-check grep is narrower than the claim.** The plan's grep (plan
   :6014) matches `'/api/tours'` exactly, so it cannot see tour PATCH
   revivals (`/api/tours/${tourId}`). Independently verified: tour PATCHes
   exist only in `toursApi.test.ts` (124), `toursReopenApi.test.ts` (9) and
   `scheduledUpdatedEvent.test.ts` (2); the only store-created tours that get
   PATCHed (`toursApi.test.ts:2128` toured -> outcome only, `:2183`
   canceled -> canceled) are not revivals; every other PATCHed tour is
   POST-created and so carries the fixture's tenant. The sweep's conclusion
   stands.

---

## F3 - mission-level - NOTE: main has moved since the base, and #19 is now deployed

`main` is at 794de277, two commits past the base 19607658:

- e27868bc `fix(flyer)` touches `app/src/repos/unitsRepo.ts`,
  `app/src/lib/unitFields.ts`, `app/test/unitFields.test.ts`,
  `app/test/publicIntake.test.ts`, `dashboard/src/routes/listing/listingFormat.ts`,
  `documentation/GLOSSARY.md`, an issue and an e2e spec;
- 794de277 (RUNBOOK.md only) rewrites the caseworkers heading
  (`RUNBOOK.md:450-452` on main): "DEPLOYED dev + prod 2026-10-12 (release 1.5.1)" and
  "`fix/caseworker-integrity` ... was not yet merged at this deploy and ships
  separately".

No S3 file is touched, so S3 executes unchanged. But the spec's premises
"merged to main but NOT deployed anywhere. This branch must merge before #19
deploys" (spec :19-20) and "#19 is not live anywhere" (spec section 2 item 7)
no longer hold: R2-ADV-1 is live in prod until this branch ships. For the
orchestrator: the final main sync will meet S4's files (`unitsRepo.ts`,
`unitFields.ts`) and S5's RUNBOOK edit (the caseworkers section was
rewritten). Whether the deploy changes any S1/L2 decision is Cameron's call.

---

## F4 - slice gate - NOTE: the lint baseline was confirmed statically, not by an eslint run

`npx eslint` is outside this reader's allowed commands, so it was not run. The
baseline holds by construction: all 21 existing files S3 edits are byte-identical to
the merge base (branch diff 19607658..670fb701 is docs only; main's two new
commits touch none of them). `dashboard/src/routes/tours/TourDetail.tsx:341`
still holds `new Date(tour.scheduledAt).getTime() <= Date.now()` in
`startPassed`, and `dashboard/src/routes/tours/ScheduleTourForm.tsx:241` still
holds `setTourType(DEFAULT_TOUR_TYPE);` inside the unit-picked `useEffect`
(:237). Tasks 3.12 and 3.14 each add one import line above them, so expect
:342 and :242 at the gate (the plan already says the numbers may move). By
reading, no S3 edit adds a lint error (the config is
`tseslint.configs.recommended` plus react-hooks for the dashboard: no
type-aware rules, no import-order rule; every new binding is used or
`_`-prefixed).
