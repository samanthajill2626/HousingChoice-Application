# S8 report - dashboard caseworkers

Date: 2026-10-08. Authorized Caseworkers feature mission, S8 only.
Worktree W:/tmp/caseworkers, feat/caseworkers, clean start e32fb777.
Binding dispatch, spec revision 15, plan sections 0-3 and S8, assembly/review
rulings, repository workflow and S7 handoff govern this slice. Parent owns
aggregate checkpoints and S10 browser proof. No aggregate/browser run here.
Raw commands, cwd, logs and exits are in .superpowers/sdd/S8/; the runner
owns a 600-second per-command timeout and awaits child completion.

## Task 8.1 - dashboard API and catalog

Mirrored conversion/preview/Possible types and Contact fields, added the four
endpoint functions, and moved both POST catalog entries and 118-to-120 pin
with their implementation. API types additions are type-only.
RED from dashboard: npx vitest run src/api/endpoints.test.ts, exit 1,
2 failed / 48 passed: missing listPossibleCaseworkers and makeCaseworker.
RED from e2e: npx vitest run performance/mutationCatalog.test.ts, exit 1,
1 failed / 3 passed: discovered 118 mutations instead of 120. The later
fingerprint comparison was not reached in RED.
GREEN: the same commands exit 0: 50 endpoint tests, 4 catalog tests.
Root npm run typecheck exited 0 across all five workspaces (8.1-typecheck).
No contract deviation. git diff --check passed.

## Task 8.2 - KindPicker Caseworker preset

Task 8.1 commit: bdd128a4. Added the host-gated Caseworker segment with the
exact preset role, filtered mentions from Other suggestions, and made its
placeholder ASCII. Typed custom roles and all existing five-segment hosts
remain supported. No CSS redesign.
RED: dashboard npx vitest run src/routes/contact/KindPicker.test.tsx,
exit 1, 5 failed / 11 passed: missing Caseworker segment, offered mentions,
and the old placeholder. GREEN: same command exit 0, 16 tests. Root bare
npm run typecheck exit 0, all five workspaces (8.2-typecheck).
No contract deviation. Task 8.1 and 8.2 added-line ASCII and diff checks pass.

## Task 8.3 - conversion dialog

Task 8.2 commit: 2321cf7a. Added CaseworkerDialog with preview/refusal links,
exact count/error/repair copy, typed organization settlement, carry-preserving
omission, clears and both-list new-name dialog. Added isCaseworkerContact
only to the leaf caseworkerRole module, preserving its import boundary.
RED: dashboard npx vitest run src/routes/contact/CaseworkerDialog.test.tsx,
exit 1: module import missing, no cases collected (genuine missing-module RED).
GREEN: dashboard npx vitest run src/routes/contact/CaseworkerDialog.test.tsx
src/routes/contact/caseworkerRoleMirror.test.ts, exit 0, initially 74 tests;
added an explicit untouched carried-value PIN, final 75 tests (23 + 52).
Scoped root npx eslint on CaseworkerDialog.tsx, CaseworkerDialog.test.tsx
and caseworkerRole.ts exited 0. Root bare npm run typecheck exited 0 across
all five workspaces. No contract deviation; picker indentation follows the
plan's note. No command remains active for this task.

## Task 8.4 - create form

Task 8.3 commit: 3f4530e1. New contacts can select Caseworker and send exactly
partner + Caseworker through existing creation. No Organization control added.
RED: dashboard npx vitest run src/routes/contact/ContactCreateForm.test.tsx,
exit 1: 1 failed / 15 passed, missing Caseworker button. GREEN: same command,
exit 0, 16 tests. Root npm run typecheck exit 0 across all five workspaces
(8.4-typecheck). No contract deviation; existing custom roles still pass.

## Task 8.5 - edit form organization and conversion gate

Task 8.4 commit: 37d6913e. Extended S7 orgSetters to a complete field-keyed
Record with organization, typed settlement and exact dirty comparison. Both
kinds land in organization, the existing single NewOrgDialog handles adds,
and 422s stay under their originating field. Stored contact gates the preset;
409 caseworker_use_conversion points to More actions > Make caseworker.
RED: dashboard npx vitest run src/routes/contact/ContactEditForm.test.tsx,
exit 1, 9 failed / 63 passed: no offered preset, no organization control and
old generic 409 copy. Later wire checks in cases stopped by the missing
control were not reached. GREEN: same command exit 0, 72 tests. Root bare
npm run typecheck exited 0 across five workspaces (8.5-typecheck).
Existing act warnings remain; no failure excused. ASCII/diff checks pass.
No contract deviation; redundant optional setter call removed once the map
became complete, and its stale two-field comments updated.

## Task 8.6 - Unknown card

Task 8.5 commit: cfdecbcd. Mark as Caseworker is fourth after Partner, opens
its dedicated callback, and shares the in-flight disable gate. Existing
triage PATCH callbacks retain their exact canonical kinds.
RED: dashboard npx vitest run src/routes/contact/UnknownFile.test.tsx,
exit 1, 4 failed / 7 passed: four-action order, missing button and old lede.
GREEN: same command exit 0, 11 tests. Root bare npm run typecheck exit 0,
all five workspaces (8.6-typecheck). No contract deviation.

## Task 8.7 - contact actions menu

Task 8.6 commit: ff1cd85a. Added the optional onMakeCaseworker menu handler;
its presence alone controls the item. Clicking it closes the menu and reports
to the host. RED: dashboard npx vitest run
src/routes/contact/ContactActionsMenu.test.tsx, exit 1: 1 failed / 18 passed,
missing Make caseworker menuitem. GREEN: same command exit 0, 19 tests.
Root bare npm run typecheck exit 0, five workspaces (8.7-typecheck).
No contract deviation; host eligibility remains Task 8.8.

## Task 8.8 - contact detail integration

Task 8.7 commit: 8ceedd7f. Added conversion entry points and organization-only
partner header facts. Preview remains dialog-open-only; Possible and org list
reads are absent at mount. Returned contact updates in place and refetches the
suggestions, timeline and file. RED: dashboard npx vitest run
src/routes/contact/ContactDetail.test.tsx, exit 1: 9 failed / 107 passed.
A draft assertion queried the second render before load; it now awaits its
Unknown action before inspecting the header. Initial GREEN: 116 tests.

Adjudication C4 (parent approved): the planned callback could close B's dialog
when A's pending conversion resolves after navigation, despite useContact
rejecting the stale data update. An added deferred-response regression failed
at the missing B dialog (8.8-navigation-red2, -t late.conversion, 1 failed /
116 skipped). The earlier quoted selector selected zero tests and is excluded
from evidence. Dialog state now carries the existing contact review generation;
old success callbacks return before closing or refetching. The regression also
asserts no stale suggestions/timeline/file reads. Final GREEN: same full
ContactDetail command, exit 0, 117 tests (8.8-green2). Root bare npm run
typecheck exited 0 across five workspaces; scoped eslint on ContactDetail.tsx
and its test exited 0. Existing act warnings remain; no failure excused.
No command remains active. Browser proof remains parent-owned.

## Task 8.9 - partner file

Task 8.8 commit: c064760e. Partner Details now show Role and Organization.
StaffNotesCard sits above Preferences & notes and receives setContact from
ContactDetail through the optional onContactUpdated prop. The S9 seam after
Preferences & notes and before Group threads is preserved. The issue retains
the open landlord half; the existing browser flow scopes its now-ambiguous
Partner assertion to Details.
RED: dashboard npx vitest run src/routes/contact/files.test.tsx, exit 1,
4 failed / 37 passed. GREEN: dashboard npx vitest run
src/routes/contact/files.test.tsx src/routes/contact/ContactDetail.test.tsx
src/routes/contact/TenantFile.test.tsx, exit 0, 161 tests across three files.
Root bare npm run typecheck exited 0 across five workspaces. Root npx eslint
e2e/tests/flows/conversation-fact-extraction.spec.ts exited 0. npm run issues
exited 0 (ignored index regenerated). Added-line ASCII/diff checks pass.
No contract deviation; browser execution remains parent-owned.

## Task 8.10 - shared filter chips

Task 8.9 commit: b0fc5518. Extracted Chip and ChipGroup to FilterChips,
keeping TenantFilters.module.css and TenantFilters' Porting useId. Scripted
comparison proved both function bodies unchanged apart from export.
RED: dashboard npx vitest run src/routes/contacts/FilterChips.test.tsx,
exit 1, missing module with zero cases collected. GREEN: dashboard npx vitest
run src/routes/contacts, exit 0, 94 tests in five files. Root bare npm run
typecheck exited 0 across five workspaces. Scoped root eslint on
FilterChips.tsx and TenantFilters.tsx exited 0. No contract deviation.

## Task 8.11 - shared Contacts filter links

Task 8.10 commit: 465a5dfe. ContactsFilterTabs exports the shared link bar
in All, Tenants, Landlords, Caseworkers, Unknown, Deleted order. Existing
Tenants search carrying behavior is unchanged.
RED: dashboard npx vitest run src/routes/contacts/ContactsList.test.tsx,
exit 1, 1 failed / 31 passed: missing Caseworkers link. GREEN: same command,
exit 0, 32 tests. Root bare npm run typecheck exited 0 across five workspaces.
Scoped root eslint on ContactsList.tsx and its test exits 1 for one
react-hooks/set-state-in-effect error at setQuery(phoneParam). Same-file
ESLint lintText at merge base 1861e154e5c72ed8a60945ca425d26d35d89149b
(using git show content and the original filePath/config) produces the same
file/rule/message including code frame; only line positions differ. Current
and baseline each have that one error; no new diagnostics. Raw comparison is
8.11-lint-baseline.log, exit 0. Baseline debt preserved, no contract drift.

## Task 8.12 - Caseworkers page

Task 8.11 commit: 8de40dd3. Implemented the page with partner-only exact-role
filtering, normalized Organization chips and ghost-key pruning, and the Possible
review list with conversion and named irreversible-dismissal confirmation.
Both lists use named ul elements and one li per record. Conversion reloads both
lists; dismissal removes its row locally only after server success. All CSS
tokens exist; the page and new controls have no width cap.
RED: dashboard npx vitest run src/routes/contacts/CaseworkersList.test.tsx,
exit 1, missing module, zero cases collected. GREEN: dashboard npx vitest run
src/routes/contacts, exit 0, 109 tests in six files (15 new page tests).
The nav-only new test initially left async reads unsettled; it now awaits both
lists, and the final same-family run has no act warnings (8.12-green2).
Root bare npm run typecheck exited 0 across five workspaces. Scoped root eslint
on CaseworkersList.tsx and its test exited 0. No contract deviation.

## Task 8.13 - navigation, route and profiler pins

Task 8.12 commit: 1478bf27. Added the Caseworkers child after Landlords with
the partner dot and a static /contacts/caseworkers route. Profiler exclusion,
registry TODO, route test, new issue and README stay together. The existing
contact-create browser spec now scopes exact Caseworker to Relationships.
RED: dashboard npx vitest run src/app/AppFrame.test.tsx, exit 1: 2 failed /
12 passed, missing Caseworkers nav link. GREEN: dashboard npx vitest run
src/app src/App.test.tsx, exit 0, 57 tests in seven files. E2e workspace npx
vitest run performance/routes.test.ts performance/mutationCatalog.test.ts,
exit 0, 30 tests in two files (26 + 4). Root bare npm run typecheck exited 0
across five workspaces. npm run issues exited 0.

Scoped slice lint enumerated the 37 TypeScript files changed since S8 start
(e32fb777); eslint reported only the baseline-attributed ContactsList
react-hooks/set-state-in-effect diagnostic described in Task 8.11. No new
lint errors. Added-line ASCII since S8 start and git diff --check pass.
New issue/README/nav addition dates use 2026-10-08 (actual implementation).
The new issue follows the current README's hermetic profiler permission,
rather than repeating the draft's outdated human-only claim. No profiler
or browser command was run. The dispatch assigns aggregate slice gates to
the parent; this implementation worker has not run them.

## S8 handoff - implementation complete

| Task | Commit |
| --- | --- |
| 8.1 | bdd128a4 |
| 8.2 | 2321cf7a |
| 8.3 | 3f4530e1 |
| 8.4 | 37d6913e |
| 8.5 | cfdecbcd |
| 8.6 | ff1cd85a |
| 8.7 | 8ceedd7f |
| 8.8 | c064760e |
| 8.9 | b0fc5518 |
| 8.10 | 465a5dfe |
| 8.11 | 8de40dd3 |
| 8.12 | 1478bf27 |
| 8.13 | b1e10303 |

All 13 task root typechecks exited 0. All 55 owned runner invocations have
completion exit markers; none is pending or timed out. Genuine RED outcomes
and the excluded zero-selection attempt are documented above. Final focused
proofs: app 57, profiler routes/catalog 30, contacts 109, contact file/detail
families 161; these are separate runs, not a combined unique test count.
Scoped lint covered 37 S8 TypeScript paths and has no new error versus the
explicit merge base; the sole preserved diagnostic is ContactsList.tsx's
react-hooks/set-state-in-effect at setQuery(phoneParam). No aggregate,
smoke, e2e browser, profiler, live lane, infra or dependency command ran here.
Parent explicitly owns CP2 after S9 and the final mission gates.

C4 is the only implementation correction beyond draft assertion settling and
current-date/documentation adjustments: conversion success is fenced by the
contact review generation so late A callbacks cannot close B's dialog or
refetch B. It was proved RED, approved by the parent, fixed and reverified.
The deferred staff-notes issue update date now reads 2026-10-08 and its updated
frontmatter matches; the genuine Cameron confirmation stays 2026-10-07.

### Downstream S9 seam

- PartnerFileProps (dashboard/src/routes/contact/PartnerFile.tsx:21) ends with
  optional onContactUpdated: (updated: Contact) => void, and the destructuring
  includes it last. ContactDetail's partner branch passes setContact at
  dashboard/src/routes/contact/ContactDetail.tsx:1142. Preserve that wiring.
- StaffNotesCard is keyed by contact.contactId above Preferences & notes.
  The S9 Properties sent insertion seam is AFTER that Preferences & notes
  Card and BEFORE the PLACEMENT RULING (C13) Group threads comment at
  dashboard/src/routes/contact/PartnerFile.tsx:130. No S9 props or card were
  added by S8; the partner branch currently receives no listingsSent props.
- useContactFile was not changed. ContactFileState.listingsSent is
  Slice<ListingSendRow> (useContactFile.ts:39); ready carries rows, other states
  are loading/pending/error. The hook already reads getContactListingsSent
  for every contact kind at useContactFile.ts:146. ContactFile.refetch is a
  stable callback and keeps committed same-contact state during reload.
  S9 should consume this existing slice, not introduce a new mount read.
- Conversion success already applies returned Contact and refreshes suggestions,
  timeline and file. The predicate lives in contact/caseworkerRole.ts;
  import isCaseworkerContact from that leaf, never from CaseworkerDialog.

### API and S10 contracts

- No new contact type: partner plus normalized exact caseworker role.
  KindPicker offerCaseworker yields exact { type: 'partner', role: 'Caseworker' }.
  Other suggestions filter role mentions; arbitrary typed custom roles survive.
- API exports: CaseworkerPreview, CaseworkerRefusal, OrganizationSource,
  PossibleSignal, PossibleCaseworkerRow. The API types file remains type-only.
  Endpoints: listPossibleCaseworkers(signal?) -> rows; previewCaseworker(id,
  signal?) -> preview; makeCaseworker(id, { organization? }) -> Contact;
  dismissPossibleCaseworker(id) -> Contact. IDs are encoded. Make/dismiss POST
  to /api/contacts/:contactId/caseworker-review with their own action values.
  Untouched organization is omitted; changed empty string clears.
- Preview is dialog-open-only. Possible list is Caseworkers-page-only.
  ContactDetail mount boundary PIN proves no preview, Possible or org-list read.
  Caseworkers page reads all live partners plus Possible, then re-reads both
  after make. Successful dismissal drops only its row without a re-read.
- Route /contacts/caseworkers; Workspace order Tenants, Landlords, Caseworkers,
  Unknown. Filter contacts order All, Tenants, Landlords, Caseworkers, Unknown,
  Deleted. Lists are ul named Caseworkers and Possible caseworkers, one li per
  row. Organization uses aria-pressed chips and repeated normalized org params.
- Entry names: More actions > Make caseworker; Unknown Mark as Caseworker;
  Possible row Make <name> a caseworker. Conversion dialog is Make <name> a
  caseworker with Make caseworker confirm. Dismiss action is <name> is not a
  caseworker; dialog Hide <name> from Possible caseworkers?; Hide / Cancel.
- Task 8.1 mutation catalog contains both POST functions with raw count 120;
  no profiler surface was added. Task 8.13 excludes /contacts/caseworkers,
  with matching registry TODO, issue and README. Routes/catalog tests pass.
- Browser pins already adjusted in their owning commits: contact-create uses
  exact Caseworker inside Relationships; conversation-fact-extraction uses
  exact Partner inside Details. Parent/S10 must execute browser proof, including
  six KindPicker segments at 375px and the new Caseworkers flows. Settings
  segments and Email triage entry points remain unchanged.

This is an implementation slice handoff, not a completed mission or merge
verdict. No block remains; all owned commands are stopped before handoff.
