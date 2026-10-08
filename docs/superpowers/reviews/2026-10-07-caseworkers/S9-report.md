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

## S9 handoff - implementation complete

| Task | Commit |
| --- | --- |
| 9.1 | 58f5886c |
| 9.2 | bb2dc582 |
| 9.3 | d6cd213d |
| 9.4 | 5c36155f |
| 9.5 | 5531719f |
| 9.6 | cf9fdb5d |

All six root typechecks exited 0. All 24 runner invocations have real exit
markers; none is pending or timed out. The first 9.1 quoted-filter run selected
zero cases and is excluded; each task has a separate genuine RED followed by
GREEN. Final focused proofs: listing family 270 tests, contact and broadcasts
families 1766 tests. These are separate runs, not a summed unique test total.
The 31-file scoped lint has zero new errors at the explicit merge base; the
four BroadcastComposer baseline diagnostics are recorded above.

The final audit byte-compared all six intentionally tenant-worded surfaces
against a95686e3: Add more tenants by filters, Add a tenant, No candidates,
the Couldn't add that tenant error sentence, the TenantFile Send action,
and audienceSummary's function body. All match. useContactFile.ts is
byte-unchanged. S8 Staff notes,
organization, and onContactUpdated wiring remain. No source contract drift.

### S10 selectors and wire contract

- Partner card heading: getByRole('heading', { name: /^Properties sent/ }).
  Its action: getByRole('button', { name: 'Send a property to this partner' }).
  It opens /broadcasts/new?contactId=<encoded id>; the composer keeps that
  partner in seedContactIds and names it in the banner. No new contact read
  was introduced by S9; the existing composer read resolves the banner.
- Card order: Details, Staff notes, Preferences & notes, Properties sent,
  Group threads, Media from comms. Partner send rows have property links and
  no tour chips, including stored tenant-era tour signals. Missing loaded
  units fall back to unitId; pending/empty slices retain the existing idiom.
- Property card heading: getByRole('heading', { name: /^Sent to\b/ }); do
  not require an exact heading because its action is inside the heading.
  Card action: getByRole('button', { name: 'Send this property', exact: true }).
  Kebab item: getByRole('menuitem', { name: 'Send this property', exact: true }).
- Recipient link names contain only the person's name (tenantName fallback
  contactId). A resolved non-tenant kind is sibling text: role trimmed through
  displayKind, otherwise Partner/Landlord/Team/Unknown. Tenant and unresolved
  rows have no kind label. ListingSendRow mirrors optional type?: ContactType
  and role?: string; S6 omits metadata for unresolved contacts and sends only
  nonblank trimmed roles. Persisted tenantName/tenantCount remain unchanged.
- Composer Send: /^Send to 1 recipient\b/ or /^Send to \d+ recipients?$/.
  Reach: Reaches 1 recipient / Reaches N recipients. Results/list reach:
  To 1 recipient / To N recipients. Results unresolved fallback: Recipient.
  Property Activity zero: No recipients reached. S6's stored timeline zero
  retains Sent to 0 recipients; only its recount uses No recipients reached.
- Thread Send must remain getByRole('button', { name: 'Send', exact: true });
  a substring match also finds the new partner Properties sent action.
  selectors.md now has exactly one Properties sent row, one Sent to row and
  the updated Thread send row. Task 10.9 verifies, never duplicates them.

### Browser pins already moved; execution remains S10-owned

- 9.1: broadcasts.spec.ts menu; scenarios/steps.ts menu; matching-entry-points
  card action and Sent to heading; listing-activity Sent to heading.
- 9.3: listing-activity Sent to 2 recipients; share-sent-outcome No recipients
  reached (including its title/comment).
- 9.4: broadcasts Send count; both matching-entry-points Send count locators;
  share-skip-fix flagged note and Send count; org-lists Reaches 1/2 recipients.
- S6 already owns landlord-activity's Sent to 2 recipients pin. Tenant-file
  send action and intentionally broad /^Send to/ pins remain unchanged.
- New partner-share.spec.ts remains entirely S10's: create a run-unique
  consented partner and never pre-open its conversation; send from its card,
  assert outbound share and a partner_1to1 conversation, then its property
  Sent to row and sibling Partner label. S9 does not create browser specs.
- S10 still owns GLOSSARY/sequence-diagram/RUNBOOK wording and the stale
  broadcasts.spec.ts header comment noted by Task 9.5.

This is an implementation handoff, not a mission completion or merge verdict.
Parent owns CP2 (bare root typecheck and npm test) and all browser/final gates.
No aggregate npm test, smoke, browser, profiler, seed, dependency, environment,
infra, deployment, main-sync, merge or cleanup command ran here. No block
remains; all owned commands are stopped and the source worktree is clean.
