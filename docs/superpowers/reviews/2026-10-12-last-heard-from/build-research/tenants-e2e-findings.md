# Build research findings - tenants-e2e (plan S4, S8)

Date: 2026-10-13. Worktree W:\tmp\last-heard-from @25adc1ef (code identical to f6aba402).
Scope: plan v3 sections 0-3 (incl. 3.4 #9-#12), N1/N2, S4 Tasks 4.1-4.6, S8 Tasks
8.1-8.6, section 11. Byte-exact anchors and the full checklists live in the gitignored
worklist `.superpowers/sdd/worklist-tenants-e2e.md`.

Headline: no blocking finding. Every S4 anchor and every S8 helper exists with the
stated name and signature; the TenantSelection literal list is complete (20 sites, 0
missed); the only existing e2e spec that breaks is listing-activity, which the plan
already rewrites; the lean derived values (tenant-0001 = 2026-06-01T14:02:10.000Z,
landlord-0001 = 2026-06-01T13:45:00.000Z) are confirmed. All findings below are LOW.

## LOW

F1. The N1 title rule is honored by S4 only. N1 (plan :4851-4853) and 3.4 #9 say an
empty `title` from `formatHeardFrom` means "render no title attribute" and every
consumer spreads it only when non-empty. The S5, S6 and S7 slice code passes it
unconditionally: plan :6539, :6541 (SendRosterRow), :8993 (RecipientPreview cellHeard),
:10668, :10671 (FollowUpView). React renders `title=""` for a Never label. No test or
e2e asserts on it (only S4's ContactsList test at plan :5836 checks absence, on S4's own
row), so this is a contract inconsistency, not a failure. Builders of S5-S7 should
spread conditionally as S4 does (plan :5951, :6085).

F2. The perf terminal for `/contacts/tenants` has no alternative for the new status-hidden
empty state. `contactListTerminal('Tenants')` (e2e/performance/routes.ts:396-398, used
at :608) accepts the rows list or "No tenants yet". A world whose every tenant is
inactive or placed now renders "No tenants match the selected filters." - neither
alternative - the exact trap the units terminal already handles (routes.ts:399-410).
Unreachable in the lean and performance seeds (both have default-visible tenants), so
Task 4.6 (which rebinds only `resolveContactDetail`) is sufficient for the gates; noted
so a future perf world does not read it as a ready_timeout. Related and safe today: the
self-QA bound contact (app/src/lib/seed/performance.ts:1295, perf-contact-0001) is
`onboarding`, default-visible; nothing guards it if that fixture ever changes.

F3. Plan 3.4 #11 says "no e2e spec selects a checkbox by its accessible name"; one does.
e2e/scenarios/steps.ts:1079-1081 (`teamSendsListing`) selects the review checkbox by an
accessible-name PREFIX regex anchored on the first name. It survives the ASCII " - "
switch (only the suffix changes), so no edit is needed - but Task 8.3 Step 1's sweep grep
("already sent|consent not recorded") cannot see it, so the sweep's commit-body claim
should be worded "no e2e selector reads a checkbox name SUFFIX".

F4. `freshTenant(label).name` is not "<firstName> <lastName>". e2e/scenarios/steps.ts:86-93
returns `name: '<label> <stamp>-<seq>'` with lastName 'Tester'. Task 8.2 uses
`replied.name` only as the fake persona label (harmless); a builder must not use `.name`
for a row, link or option assertion in 8.2 (the row reads "<firstName> Tester"). The
shared `createTenant` helper (plan :11415-11434) does return the full name and is fine.

F5. Citation drift (text verbatim, line off; cosmetic):
- dashboard/src/routes/contacts/FilterChips.test.tsx existing cases are :13-25 and
  :27-50 (plan :5484-5485 says :13-27, :29-51).
- dashboard/src/routes/contacts/TenantFilters.test.tsx expected object is :168-172 (plan
  :5236 says :167-171).
- dashboard/src/routes/contacts/ContactsList.module.css `.porting` starts :236 (plan
  :5991 says :235-246).
- Plan :5110-5111 says `routes/tours/tourTime.ts` already shares inboxTime; it only cites
  the convention in a comment (tourTime.ts:80). lib/heardFrom.ts becomes the first
  non-test lib-to-routes runtime import of inboxTime (no lint rule forbids it).
- Plan :11620 cites "statusTransition.ts:610-622" for the ungated setTenantStatus: that
  is app/src/services/statusTransition.ts; the route file of the same name
  (app/src/routes/statusTransition.ts) is 349 lines.
- Spec section 8 (3) still says a hand-added declined row "shows unchecked"; spec 14.4
  (:1248, "G3 as amended") overrides it and plan 8.3 step 6 correctly follows 14.4.
