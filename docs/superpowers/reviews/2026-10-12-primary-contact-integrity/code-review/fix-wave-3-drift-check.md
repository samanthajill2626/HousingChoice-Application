# Fix wave 3 (planner fix wave) - drift check and base decision

Orchestrator record, 2026-10-14 (UTC). Findings list:
`planner-review/fix-wave-findings.md` (Cameron's rulings of 2026-10-13).

## Drift check (read-only, every anchor)

Every file:line the findings file names was read on tip `d9269547` before any
edit. All anchors matched byte-for-byte: `UnitContactView` and
`enrichRosterView` (routes/units.ts), `isAutoRoutingEligible` and
`readRosterContacts` (lib/propertyContact.ts), the box action and its comment
(ListingDetail.tsx), the three `noEligible` strings (the script), RUNBOOK
lines 506/511/512/516, selectors.md:88, the Scan predicate
(services/primaryHandoff.ts:86-88), `handOffPrimaryFrom`'s re-check
(repos/unitsRepo.ts:1739-1741), `landlordWasPrimary` (:865-868),
`batchGetByIds` / `getManyByIds` (contactsRepo.ts), the FakeWorld fakes, the
Delete-dialog sentence (ContactDetail.tsx:140-141) and its test pin. No spec
drift found; nothing in the findings contradicts the live tree.

Invariant sweep for F2 (who hands off on a contact delete): writers of the
decision are the service Scan, the repo re-check and the FakeWorld
`handOffPrimaryFrom` that mirrors it (`twilioWebhookHarness.ts`); readers are
the Delete dialog copy (F5b), the issue, spec 4.6 / 9.2, the comments in
`primaryHandoff.ts`, `unitsRepo.ts`, `routes/contacts.ts`, `ContactDetail.tsx`
and the GLOSSARY primary-contact bullet. The parity suite
(`primaryHandoffParity.integration.test.ts`) pins fake-vs-real agreement, so a
shared exported predicate is the only safe shape - the findings say so.

The e2e (a) and (b) cases create Mark with `createContact(req, 'landlord', ...)`
(typed landlord), and (c) seats a tenant plus two landlord-typed contacts, so
the four-case rule of F1 changes no e2e expectation. No e2e spec pins the
no-eligible line.

## Base decision: the ONE main sync happens BEFORE the build

`main` advanced 113 commits past the branch's merge-base (the last-heard-from
mission landed: +433 lines in `routes/units.ts`, plus `ListingDetail.tsx`,
`ListingDetail.test.tsx`, `ContactDetail.tsx`, `contactsRepo.ts`,
`twilioWebhookHarness.ts`, RUNBOOK, GLOSSARY, selectors.md - this wave's own
edit set). A `git merge-tree` preview showed six conflicting files. Merging at
the pre-handback step would have forced the implementers' fresh code through a
second conflict resolution and put the self-QA on a pre-merge shape, so the
single permitted sync was taken first: merge commit `ebdd025d` (0 behind
`main` 8bec5de1, 104 ahead). Six conflicts, both sides kept everywhere: the
two RUNBOOK backfill sections; `routes/dev.ts` (the zero-primary fixture and
the listing-send fixture with their imports and deps); `routes/units.ts` (two
import blocks; the Activity event-type list); `dashboard/src/api/types.ts` and
`listingFormat.ts` (the event list and labels); `ListingDetail.test.tsx` (the
primary-contact and the Sent-to describes). On the merged tree before the
commit: `npm run typecheck` exit 0, `npm run smoke` exit 0 (1705 specifiers /
296 files). On the merge commit: gate 5 eslint over the branch's 87 files
reports only `TourDetail.tsx:342:85 react-hooks/purity` (pre-existing on
`main`); `npm test` ran next (its result is in the fix-wave-3 handback). Any
later `main` drift is reported in the handback, not chased.

## Dispatch shape

Two SEQUENTIAL fresh foreground Opus implementers, each briefed with the
complete findings file and an explicit sub-scope: A = F1 + F3 (the box rule
and its copy across server, dashboard, script, RUNBOOK, spec 7.4 / 7.5 / 8,
selectors.md); B = F2 + F5a + F5b (the delete hand-off predicate, the
consistent restore read, the Delete-dialog sentence, the two issues, spec
4.2 / 4.6 / 7.6 / 9.2). The split follows the build's own lesson (the S2 / S4
/ S5 halves kept every child under budget with zero recoveries) and keeps the
two edit sets disjoint; it is still ONE fix wave before the planner's
re-review. Strict TDD, red and green logs under `.superpowers/sdd/fixwave3-*`,
explicit-path commits, reports to this directory as produced.
