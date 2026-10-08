# S9 report - shares dashboard

Date: 2026-10-08. Authorized Caseworkers feature mission, S9 Tasks 9.1-9.6.
Worktree W:/tmp/caseworkers, feat/caseworkers, clean start a95686e3.
Spec revision 15 D20/D22, plan sections 0-3 and S9, research/assembly/review
rulings and S6/S8 handoffs govern this slice. Parent owns CP2 and browser proof.
No aggregate, browser, infrastructure, dependency or environment changes here.
Raw command/cwd/log/exit evidence: .superpowers/sdd/S9/. The runner imposes a
600-second timeout and waits for real child completion.

## Task 9.1 - neutral property actions and card

Changed the property menu/card to Send this property and Sent to, with all
four owning e2e pins and the shared Card comment in the same task.
RED: dashboard npx vitest run src/routes/listing/ListingDetail.test.tsx,
exit 1, 2 failed / 66 passed: missing neutral action and old card heading.
The prior quoted -t command selected zero cases and is excluded from evidence.
GREEN: dashboard npx vitest run src/routes/listing, exit 0: 267 tests in
12 files. Root bare npm run typecheck exit 0 across all five workspaces.
Root npx eslint on broadcasts.spec.ts, e2e/scenarios/steps.ts,
matching-entry-points.spec.ts and listing-activity.spec.ts exit 0.
Existing act warnings remain; no failed check excused. No contract deviation.

## Task 9.2 - recipient kind labels

Task 9.1 commit: 58f5886c. Mirrored optional type/role on ListingSendRow,
added sendRowKindLabel using displayKind, and rendered kind outside the
identity link. Tenant and unresolved rows remain unlabelled; shared tenant
file rows stay unchanged. The server continues owning trimmed role metadata.
RED: dashboard npx vitest run src/routes/listing/listingFormat.test.ts
src/routes/listing/ListingDetail.test.tsx, exit 1: 3 failed / 100 passed,
missing helper and missing Caseworker sibling label.
GREEN: dashboard npx vitest run src/routes/listing
src/routes/contact/files.test.tsx, exit 0: 311 tests in 13 files.
Root bare npm run typecheck exit 0, five workspaces (9.2-typecheck).
Added-line ASCII and git diff --check pass. No contract deviation.

## Task 9.3 - property Activity recipient wording

Task 9.2 commit: bb2dc582. Activity says Sent to N recipient(s), and No
recipients reached for absent/zero count. Stored tenantCount is unchanged.
Moved listing-activity and share-sent-outcome browser pins with the copy.
RED: dashboard npx vitest run src/routes/listing/listingFormat.test.ts,
exit 1: 3 failed / 31 passed, old tenant and zero-reach labels.
GREEN: dashboard npx vitest run src/routes/listing, exit 0: 270 tests in
12 files. Root bare npm run typecheck exit 0 across five workspaces.
Root npx eslint e2e/tests/dashboard-next/listing-activity.spec.ts
e2e/tests/dashboard-next/share-sent-outcome.spec.ts exit 0.
Added-line ASCII and git diff --check pass. No contract deviation.
