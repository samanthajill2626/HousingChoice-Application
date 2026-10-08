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

## Task 9.4 - composer recipient wording

Task 9.3 commit: d6cd213d. Review Send, empty selection, flagged-recipient
note, singular/plural unresolved-seed note and reach line use plan 3.9 copy.
Tenant-only add/search/filter copy is preserved. Four e2e files move with it.
RED: dashboard npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx
src/routes/broadcasts/BroadcastComposer.test.tsx
src/routes/broadcasts/AudienceFilters.test.tsx, exit 1: 24 failed / 80 passed,
on old tenant wording and the prior empty-selection sentence.
GREEN: dashboard npx vitest run src/routes/broadcasts, exit 0: 221 tests in
12 files. Root bare npm run typecheck exit 0 across five workspaces.
Root npx eslint on broadcasts.spec.ts, matching-entry-points.spec.ts,
share-skip-fix.spec.ts and org-lists.spec.ts exit 0 (all e2e/tests/dashboard-next).
Added-line ASCII and git diff --check pass. No contract deviation.

## Task 9.5 - Matching list and results

Task 9.4 commit: 5c36155f. Matching reach/subtitle/empty state use recipients,
and unresolved results use Recipient. The audienceSummary tenant-only filter
wording is unchanged. Related comments reflect partner seeds.
RED: dashboard npx vitest run src/routes/broadcasts/broadcastFormat.test.ts
src/routes/broadcasts/BroadcastsList.test.tsx
src/routes/broadcasts/BroadcastResults.test.tsx, exit 1: 3 failed / 68 passed,
on old reach/subtitle/fallback copy (empty-state assertion follows subtitle).
GREEN: dashboard npx vitest run src/routes/broadcasts, exit 0: 222 tests in
12 files. Root bare npm run typecheck exit 0 across five workspaces.
Added-line ASCII and git diff --check pass. No contract deviation.

## Task 9.6 - partner Properties sent and seeded composer

Task 9.5 commit: 5531719f. PartnerFile consumes required units/listingsSent
props from the existing useContactFile slices. Properties sent sits after
Preferences & notes, before Group threads, and has no tour chips. Send opens
/broadcasts/new?contactId=<encoded id>. S8 Role/Organization, Staff notes and
onContactUpdated={setContact} wiring remain intact. No new GET or hook change.
All four PartnerFile call sites carry the required props. The three selector
rows are installed once: shared Properties sent, property Sent to, exact Send.
RED: dashboard npx vitest run src/routes/contact/files.test.tsx
src/routes/contact/ContactDetail.test.tsx
src/routes/broadcasts/BroadcastComposer.test.tsx, exit 1: 5 failed / 208 passed.
The failures are missing Properties sent/card action; the partner seed PIN
passes on existing composer behavior.
GREEN: dashboard npx vitest run src/routes/contact src/routes/broadcasts,
exit 0: 1766 tests in 86 files. This includes S8's PartnerFile notes and
ContactDetail conversion/mount-boundary regressions. Existing act warnings
remain; no failing case is excused. Root bare npm run typecheck exit 0 across
all five workspaces (9.6-typecheck).

Scoped slice lint: root npx eslint over the 31 TS/TSX paths changed since
S9 start, recorded in 9.6-lint.command.json, exits 1 for four existing
BroadcastComposer.tsx react-hooks/set-state-in-effect diagnostics:
setUnit(null) at 204, setMessage at 229 and 248, setFilter at 263.
Explicit baseline comparison uses git merge-base main HEAD =
1861e154e5c72ed8a60945ca425d26d35d89149b and ESLint.lintText for every same
path at that commit and now, with the same cwd, filePath and config. All four
rule/severity/full-message signatures, including code frames, match exactly;
no other diagnostic is present. Comparison exit 0, zero new errors. Raw
reference stays in 9.6-lint-baseline.log and lint-baseline.json (gitignored).
Added-line ASCII across the whole S9 slice and git diff --check pass.
No contract deviation and no command remains active for this task.
