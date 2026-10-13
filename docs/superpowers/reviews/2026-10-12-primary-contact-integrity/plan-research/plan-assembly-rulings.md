# Plan assembly - contract-issue rulings

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`.
Skeleton @f204106f; five opus section writers drafted S1-S5 against the
post-merge tree (main merged in at 0e565b86). 29 contract issues raised
(S1 5, S2 13, S3 6, S4 1 + 8 decisions, S5 4). Every one is ruled below; the
assembled plan's section 3.2 carries the same rulings for the builder.
Load-bearing cross-slice claims were re-checked in the drafts before ruling
(the shared `routes/units.ts` import, the two `res.json` lines S3 anchors on,
S3's handling of S1's optional field, S4's restore error paths, the e2e gate
cap against recent Windows gate runs).

| id | raised by | ruling |
|---|---|---|
| R1 | S1-1, S3-1 | ACCEPT. `ResolvedTourNames.propertyContact?: PropertyContactResult`, present exactly when a unit was passed. S3 already reads it as `PropertyContactResult | undefined`. |
| R2 | S1-2, S2-11, S3-3 | S1 KEEPS its alias import (`isAutoRoutingEligible as autoRoutingEligible`, call sites byte-identical) and drops the now-unused `isDeleted as isContactDeleted` import. S2 restores that import (its step (b)) and its import step (c) is AMENDED to anchor on S1's aliased block and replace it with the plain `import { isAutoRoutingEligible, readRosterContacts }` - safe because S2 replaces both regions that call `autoRoutingEligible` (the add handler and `soleLandlordToPromote`). S3 merges its names into whatever single propertyContact import exists (its own grep step) and must NOT re-add the contactsRepo import (S2 restored it). |
| R3 | S1-3, S2-12 | ACCEPT the `lib/propertyContact.ts <-> repos/unitsRepo.ts` runtime cycle under one rule: neither module reads the other's bindings at module top level. Watch item for the builder and reviewers. |
| R4 | S1-4 | ACCEPT both `applyPrimary` edges: throw on an heir with no row and `addLandlordRow` false; the appended landlord row carries no name/company (read-time enrichment is authoritative). |
| R5 | S1-5 | ACCEPT shared-function coverage: the four reminder-copy callers pass `resolved.names` unmodified; per-caller tests would re-test one function. |
| R6 | S2-1 | ACCEPT. Swap: REPO-computed per attempt (`opts.readContacts`), because the swap retries contacts-only races. Clear: ROUTE-decided `promote` via `chooseHeir`, applied only on `expectContacts`. Unknown liveness -> 503 `roster_read_failed`, nothing written, on both. |
| R7 | S2-2 | ACCEPT. `auto_on_add` derived from the written row (main's `autoPrimary` signal); handoffs reported once through `opts.onPrimaryHandoff` after the successful write; payload carries `actor` (house convention). A clear appends nothing. |
| R8 | S2-3 | ACCEPT the 409 decided twice (route + per attempt via `ContactListFacts.contactDeleted`), the caseworker-integrity FW2-1 pattern. |
| R9 | S2-4 | ACCEPT. Absent `readContacts` = unknown wherever liveness is needed; never a silent twin rule. |
| R10 | S2-5 | ACCEPT `decideAutoPrimary` as a shared pure function in `unitsRepo.ts`. X's own live flagged row counts as a live flagged primary, so an explicit API `primaryContact: false` on it still demotes (and the scalar is REMOVEd). Consistent with spec rev 6 (its re-add sentence was dropped in the reconciliation). |
| R11 | S2-6, S2-7, S2-8 | ACCEPT the `handOffPrimaryFrom` result shape (with `to`), `consistentRead` typed on `list` only (no GSI), and the new exports. |
| R12 | S2-9 | ACCEPT, and S4 gains a task: a 503 `roster_read_failed` from a landlord restore (`RestoreLandlordDialog`) shows "Couldn't check the other contacts - try again." (the remove copy). A plain restore never runs a handoff, so it never answers 503. |
| R13 | S2-10 | ACCEPT the relaxation: the restore's liveness read becomes the spec 4.2 batch read (one complete read, eventually consistent) instead of caseworker-integrity's per-row consistent `getById`. Spec 4.2 states and accepts that race (approved). The replaced caseworker pin is named in S2.8. |
| R14 | S2-13 | ACCEPT the `conversationsRepo.ts` comment fix as S2.13. |
| R15 | S3-2 | ACCEPT as binding on S1: `readRosterContacts` makes exactly ONE `getManyByIds(ids, { requireComplete: true })` call; `rosterContactIds` includes an off-roster `landlordId`. |
| R16 | S3-4 | CONFIRMED: S2 leaves the two contact-list `res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });` lines byte-identical (checked in the S2 draft). |
| R17 | S3-5 | ACCEPT - a real catch: `listing_status_changed` already stores staff FREE TEXT under `reason`. The Activity projection serves `reason` for `unit_primary_contact_assigned` ONLY. Spec 8 / plan C11 wording ("the whitelist gains reason") is narrowed accordingly. |
| R18 | S3-6 | ACCEPT. The restore response keeps today's enrichment (no flags, no block); the page re-reads (S4.10). |
| R19 | S3 F3 / D1-D7 | ACCEPT. A missing unit or no units repo takes the unit-failure rule; an empty settings answer is `lookup_failed`. |
| R20 | S4-1, S5-4 | ACCEPT. S5.7 updates `property-roster.spec.ts` step 4 and S5.8 `e2e/support/selectors.md` (incl. the two `role="status"` nodes in the dialog). |
| R21 | S4 P-1..P-8 | ACCEPT all. Staff-facing copy the spec did not give (P-2 Check again failure, P-3 Activity line) is shown to Cameron at the launch gate. |
| R22 | S5-1 | ACCEPT. S5 adds `UnitsRepo.assignPrimaryIfCurrent` additively (after `rewriteAcceptedAuthorities`, interface + implementation + fake), one attempt through the unchanged `updateRosterIfCurrent`. |
| R23 | S5-2 | ACCEPT the refined seam: the spec creates contacts through the real `POST /api/contacts`; the seam writes only the unit (`setup`, no landlord, no authorities, required run-unique street, 1-5 non-landlord rows). Replaces contract 2.7. |
| R24 | S5-3 | RULED: gate 4 runs under `timeout 2700`. Recent Windows full-suite runs took 22-34 minutes (caseworker-integrity 22.3-33.8m, join-housing-authority 24.6m), so 1500 cannot pass. Exit 124 is still a reported FAILURE. |
| R25 | S1 notes | The worktree has no `node_modules`: section 0 gains `npm ci` once before S1.1. |
