# Planner review R2 - spec conformance (re-review of planner fix wave 3)

Date: 2026-10-13. Reviewer: the continued conformance reviewer (opus).
READ ONLY: git and file reads only. No npm, vitest, e2e, Docker or server
(the planner was running the gates in this worktree).

- Worktree `W:\tmp\primary-contact-integrity`, branch
  `feat/primary-contact-integrity`, tip a801d14a, 0 behind `main` e402a053.
- Contract for this wave: `planner-review/fix-wave-findings.md` (F1-F5,
  Cameron's rulings), and the spec as amended in this wave (0ae9096a,
  4e430a6e; spec 12 at a7eca276).
- Reviewed: fix commits 7aea785a 4d4f4a41 2b133dab 30005052 0ae9096a
  f18ac75f fc7607de b5561c2c 4e430a6e; merges ebdd025d and a801d14a
  (`git show --remerge-diff`); `handback-fixwave3.md`,
  `code-review/fix-wave-3A-report.md`, `fix-wave-3B-report.md`,
  `self-qa/self-qa-fixwave3.md`.
- Not verified here: test RESULTS and gate exits (not run). Test evidence is
  test file + title, read.

## Verdict

**46 rows: 44 CONFORMS / 2 PARTIAL / 0 MISSING / 0 DIVERGES.** Both PARTIAL
rows are LOW and docs-only: the spec's 9.2 and 10 were not brought along with
F2. The orchestrator's handback already lists both as "your eye" nits, so
neither is silent. Every F item matches the ruling and the amended spec. Both
merges keep both sides. I found no behavioral defect.

## 1. What did we all miss - the changed state, swept fresh

### 1a. Does the amended spec agree with itself, RUNBOOK and selectors.md?

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | 4.2: the new restore-consistency bullet vs the rest of 4.2 (excluded contact, unknown, accepted race) | CONFORMS (N-1) | spec :201-206; the "never read the just-deleted contact" bullet (:197-200) is still true of every other caller (default unchanged, contactsRepo.ts:1018 only when asked) |
| 2 | 4.4: the amended 470 Bolton sentence vs 7.4 | CONFORMS | spec :292-296 (line + "Choose a primary"; the line alone for a caseworker) = 7.4's third and fourth cases (:584-591) = LD.tsx:1112-1113 |
| 3 | 4.6 "Delete the contact" + last bullet vs the code | CONFORMS | spec :334-357, :376-386 = unitsRepo.ts:900-911 (predicate), :1784 (re-check), primaryHandoff.ts:97, :112, :131-132; landlordId is not in the hand-off patch (unitsRepo.ts:1795-1799) |
| 4 | 4.7 vs the amended 4.6 / 7.4 | CONFORMS (N-2) | :394-409. "After a contact delete, every unit whose primary was that contact" now takes 4.6's wider definition, so it still holds. Bullet 3's "the property box asks for a deliberate choice" is still true, though under F1 the box also asks for a property manager or owner |
| 5 | 7.4: the four cases, the line, edit mode type-agnostic | CONFORMS | spec :571-596 = LD.tsx:542-544, :1098-1131 |
| 6 | 7.5: the `autoEligible` per-row flag | CONFORMS | spec :621-627 = units.ts:388-392, :661 |
| 7 | 7.6: the "when someone can" sentence | CONFORMS | spec :666-671 = ContactDetail.tsx:146-147, rendered :1460 for non-tenants |
| 8 | 8: the `noEligible` bullet vs the script and RUNBOOK | CONFORMS | spec :695-700; script :330, :453, :467; RUNBOOK.md:506, :511-512, :516 |
| 9 | 9.2: the shared-rule paragraph vs the amended 4.6 | **PARTIAL [LOW]** | spec :796-803 names `landlordWasPrimary`'s users as "restoreWithLandlord, the restore route and the API-test fake" and describes it in restore terms only. The amended 4.6 (:337) sends the reader to "9.2" for the rule, and the delete hand-off now uses it too, through `contactIsPrimaryToHandOff` (unitsRepo.ts:900-911). Incomplete, not contradictory. F2 made 9.2 conditional ("if it repeats the asymmetry"); it does not repeat it, so the builder left it. Listed in the handback's "your eye" |
| 10 | 10: the test plan vs the wave | **PARTIAL [LOW]** | spec :836-838 lists the P3 delete cases without the F2 no-flag landlord case, while F1's box line was amended in (:846-849). The tests exist (row 19 below), but spec 10 does not name them. Listed in the handback's "your eye" |
| 11 | 12: the GLOSSARY bullet vs 4.4 / 4.6 / 4.7 | CONFORMS | spec :899-905 (fixed at a7eca276); GLOSSARY.md:250-283 lists no "deleting a no-flag landlord leaves nobody" path, so F2 needs no GLOSSARY change. This also closes my R1 row 83 (D-3) |
| 12 | RUNBOOK backfill section vs spec 7.4 / 8 and the script | CONFORMS | RUNBOOK.md:506 (`noEligible` meaning), :511-512 (the two strings, verbatim from script :453, :467), :516 (one-click only for a contact typed landlord; tenants -> the line + "Choose a primary"; caseworkers only -> no button). The step-4 claim "none of these properties has a live one" follows: `noEligible` is chooseHeir `no_eligible_candidate`, so no roster row is `autoEligible` |
| 13 | `e2e/support/selectors.md` vs 7.3 / 7.4 | CONFORMS | :87 (heir never a tenant or caseworker), :88 (the four cases, the new line, edit-mode make-primary type-agnostic) |

### 1b. Do the two merges keep both sides' intent?

| # | check | verdict | evidence |
|---|---|---|---|
| 14 | ebdd025d, the six conflicted files | CONFORMS | remerge-diff: RUNBOOK keeps both backfill sections. dev.ts keeps both imports, both deps fields and both fixtures (the zero-primary route closes with `});` before main's listing-send fixture). units.ts keeps both import blocks; its Activity doc list is the union. types.ts and listingFormat.ts keep the union of event lists and both maps (`PRIMARY_ASSIGNED_REASON`, `OUTCOME_LABELS`). ListingDetail.test.tsx keeps both describes. Merged `UnitActivityEvent` carries main's `contactName` and the branch's `reason` (types.ts); `describeUnitActivity` keeps `case 'unit_primary_contact_assigned'` (listingFormat.ts:256-262) and main's outcome labels (:213) |
| 15 | ebdd025d, auto-merged files both sides touched (contactsRepo, routes/contacts, ListingDetail, useListing, ContactDetail, harness, endpoints, GLOSSARY, selectors) | CONFORMS | Main's hunks there are last-heard-from: recipients / outcome rows, the `?tour=new` form, `setRecipientRow`, `touchLastHeardFrom`, and `getRecipientDisplaysByIds` requireComplete. None touches the roster, the box, the delete fan-out or `getManyByIds`. useListing still seeds `propertyContact` at load (:246). The delete route still calls the fan-out (contacts.ts:2304). `git grep` over app/src after the merge finds no new primary-then-landlord ladder reader from main (spec 4.1 still holds) |
| 16 | a801d14a (RUNBOOK only) | CONFORMS | remerge-diff takes main's "Last heard from ... DONE (release 1.5.4)" heading and body, and keeps the branch's backfill section intact. `git diff e402a053 HEAD -- RUNBOOK.md` = the branch's section + its caseworker-paragraph sentence, nothing else |

## 2. The F items, row by row (findings list + amended spec)

| # | item | verdict | code | test |
|---|---|---|---|---|
| 17 | F1 server flag: `autoEligible?: true` on `UnitContactView`, set in `enrichRosterView` from its complete read via `isAutoRoutingEligible`; absent otherwise; absent on an incomplete read; never stored | CONFORMS | units.ts:378-392, :661; the incomplete-read path returns `enrichRoster` rows with no flags (:654); the restore answer keeps `enrichRoster` (:2501); the dashboard never sends flags back (`addUnitContact` posts contactId/role/primaryContact) | `unitsApiPropertyContact.test.ts` describe at :276 (tenant, caseworker, deleted landlord-typed, phone/email routing records, tenant-typed landlord of record), :355-357 (absent on an incomplete read); `unitsApiPropertyContactWrites.test.ts:86`, :167-170; `unitsApiRoster.test.ts` exact-row pins |
| 18 | F1 dashboard row type + `listingRoster` pass-through | CONFORMS (built beyond the list's wording, recorded, necessary) | types.ts:3171-3176; buildListingFile.ts:40-44, :74 (listingRoster copies field by field; without this the box never sees the flag) | `buildListingFile.test.ts` "carries the server row flag autoEligible through" |
| 19 | F1 box: one `autoEligible` row -> `Make <Name> primary` (unchanged write) | CONFORMS | LD.tsx:542-543, :1098-1110 (`onMakePrimaryContact`) | ListingDetail "exactly one autoEligible row", "one autoEligible row next to a TENANT"; e2e (a)/(b) seat a landlord-typed Mark (spec :120/:166) |
| 20 | F1 box: two or more -> `Choose a primary`, no line | CONFORMS | LD.tsx:1112-1113 (line only at length 0) | "two or more autoEligible rows ... and no no-eligible line"; e2e (c) |
| 21 | F1 box: zero `autoEligible` + a live non-caseworker row -> the line AND `Choose a primary` | CONFORMS | LD.tsx:544, :1112-1129 | "a TENANT the only live row: no one-click - the no-eligible line AND Choose a primary, whose edit mode still offers the tenant by name" |
| 22 | F1 box: no live non-caseworker row -> the line only | CONFORMS | same branch, `hasHandPickableRow` false | "caseworkers only", "every row deleted", "a deleted row and a caseworker" |
| 23 | F1 edit mode's per-row Make primary stays type-agnostic | CONFORMS | edit-mode rows untouched by 2b133dab (only the box block and its consts changed) | tenant-only test asserts the edit-mode tenant control |
| 24 | F1 the comment at the box rewritten to the new rule | CONFORMS | LD.tsx:528-539 | - |
| 25 | F1 script: the three `noEligible` strings verbatim; header comment; run test | CONFORMS | script :330 (with the `assign-primary-contacts - ` prefix), :453 (two leading spaces), :467 - each character-identical to findings :54-57; header :29-33 | `assignPrimaryContacts.run.test.ts` (all three pinned) |
| 26 | F1 RUNBOOK :506 / :511 / :512 / :516 | CONFORMS | see row 12 | - |
| 27 | F1 spec 7.4 / 7.5 / 8 (and the orchestrator's 4.4 / 10 additions) | CONFORMS (4.4 / 10 additions beyond the list: recorded, needed for self-consistency) | rows 2, 5, 6, 8, 10 | - |
| 28 | F1 selectors.md :88 | CONFORMS | row 13 | - |
| 29 | F2 ONE exported predicate, gated on the landlord of record: non-empty `landlordId` === contact -> `landlordWasPrimary(unitContacts(unit), contactId)`, else the flagged row | CONFORMS | unitsRepo.ts:900-911 (next to `landlordWasPrimary` :876) | `landlordWasPrimary.test.ts` describe "contactIsPrimaryToHandOff" (no-flag on/off list, not-landlord, flag wins, flagged contact, derived row) |
| 30 | F2 used at all three call sites, no copies | CONFORMS | Scan primaryHandoff.ts:97; re-check unitsRepo.ts:1784 (each retry re-enters `attempt()`, so the re-check re-runs); fake twilioWebhookHarness.ts:3312. `git grep` shows no other flagged-only test in those paths | `primaryHandoffParity.integration.test.ts` (three new rows) |
| 31 | F2 unchanged: deleted contact EXCLUDED and never read; `applyPrimary`; `landlordId` NOT changed; audit `handoff_on_delete` with `from` = the deleted landlord; no heir -> nothing; unknown -> skip | CONFORMS | primaryHandoff.ts:110-113 (read filter), :126-133 (audit); unitsRepo.ts:1787-1799 (chooseHeir with `exclude`, `usable()` drops the excluded id at step 1 too, pc.ts:297-304; patch = contacts + scalar only) | `primaryHandoffService.test.ts` "deleting it hands off: ... landlordId kept, ONE audit row"; `contactDeletePrimaryHandoff.test.ts` route case |
| 32 | F2 negatives + retry re-check + DynamoDB Local | CONFORMS | - | service: "a no-flag unit whose landlord of record is SOMEONE ELSE is not a target", "a FLAGGED row other than the deleted landlord of record wins", "gained a flagged row between the Scan and the hand-off: ... not_primary"; `unitsRepoHandOffPrimary.integration.test.ts` "moved: the landlord of record of a NO-flag roster", "a lost write re-checks with the same rule" |
| 33 | F2 docs: spec 4.6 both bullets; issue resolved with a dated block naming the commit; comment sweep (service, repo, contacts route, ContactDetail) | CONFORMS (N-3) | spec :334-357, :376-386; `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md` `status: resolved`, Resolution names f18ac75f; comments in f18ac75f / b5561c2c (read) | - |
| 34 | F3 the new line everywhere it is live; the old one nowhere live | CONFORMS | spec :586-587; LD.tsx:156; ListingDetail.test.tsx:2646, :2747; selectors.md:88; RUNBOOK.md:516. `git grep` (excluding plans and records) finds none of the old strings: no "Add the landlord or property manager", "choose one on the property page", "open each one and choose a primary contact", or "takes over, and restoring them" | - |
| 35 | F4 no change | CONFORMS | no wave hunk in the contact type-change paths; spec 4.4 / 4.7 known gap text unchanged (:410-418) | - |
| 36 | F5a `getManyByIds(ids, { requireComplete?, consistentRead? })`; `ConsistentRead: true` in the table's `RequestItems` entry on every request of the walk, only when asked; default unchanged | CONFORMS | contactsRepo.ts:761, :996, :1012-1021, :1340-1343; `getRecipientDisplaysByIds` / display reads never pass it | `contactsRepoConsistentBatchRead.test.ts` (asked; second chunk + UnprocessedKeys retry; not asked / requireComplete alone / false; display reads never); `contactsRepo.integration.test.ts` DynamoDB Local acceptance |
| 37 | F5a `readRosterContacts(contacts, ids, logger?, opts?)` passes it through only when asked | CONFORMS | propertyContact.ts:92-112 | `propertyContact.test.ts` "passes consistentRead ... when asked - and only then" (four call shapes) |
| 38 | F5a ONLY the restore route's two reads ask; every other caller unchanged | CONFORMS | units.ts:708-713 (`clearedLandlordHeir`), :2434 (`readContacts` handed to `restoreWithLandlord`). Unchanged: :653 (GET), :1747 (add), :1858 (remove), primaryHandoff.ts:110, script :315 | `unitsRestoreLandlord.test.ts` PIN (`consistentRead: true`, one liveness read) and the swap case |
| 39 | F5a fakes mirror the signature | CONFORMS | twilioWebhookHarness.ts:2302-2306 (`_opts`, ignored: in-memory reads are complete and consistent) | - |
| 40 | F5a issue Update + refs, stays OPEN narrowed; spec 4.2 sentence | CONFORMS (N-1) | `roster-liveness-read-eventual-consistency.md` (dated Update, `status: open`, refs refreshed); spec :201-206 | - |
| 41 | F5b the sentence (spec 7.6, ContactDetail, test) | CONFORMS | spec :666-669; ContactDetail.tsx:146-147; ContactDetail.test.tsx:3115 - identical to findings :191 | - |

### Built beyond the list (all recorded; none silent)

- `buildListingFile.ts` pass-through (row 18). Necessary; 3A report, divergence 1.
- Spec 4.4 and 10 sentences amended to the F1 rule (row 27). Recorded as
  an orchestrator addition and justified by self-consistency.
- Extra pins: the tenant-typed landlord of record, the DELETE response's
  rows, the F2 predicate cases, the lib-level `readRosterContacts` pin and
  the DynamoDB Local acceptance case.
- The resolved issue's "What staff see meanwhile" paragraph was rewritten to
  the F1 box (N-3).
- The comment on the `DELETE_PRIMARY_HANDOFF_SENTENCE` constant names the
  F2 rule.

Nothing else outside the findings list was built. The plan and the earlier
review records are untouched (`git diff --stat 0867ba2d HEAD` on the plan and
both R1-conformance files is empty).

### 1c. Records

| # | check | verdict | evidence |
|---|---|---|---|
| 42 | Every claim in the handback's per-item table matches the code I read | CONFORMS | rows 17-41 |
| 43 | The F2 guard negatives are honest: they cannot go red on the old code | CONFORMS | 3B report divergence 2: shown against two deliberately wrong predicates, then restored. Accepted, because the old code targeted no no-flag unit |
| 44 | Self-QA covers the "done means" walk (tenant-only: line + Choose, no one-click; landlord-typed sole contact: one-click) | CONFORMS | `self-qa/self-qa-fixwave3.md` + five PNGs present; the wire is asserted by key presence |
| 45 | The gate claims in the handback have logs | CONFORMS (results UNVERIFIED) | handback names `.superpowers/sdd/fixwave3-gate*.log`; the coordinator is re-running the gates |
| 46 | My R1 rows still stand after the wave and the merges (spot check of the touched rows 24-25, 27-29, 46, 52-53, 66, 68, 83) | CONFORMS | R1 rows 46 (box) and 25 (delete fan-out) are superseded by F1 / F2 as ruled. Row 83 (D-3) is closed by a7eca276. D-1 (script logs contact ids) and D-4 (INFO line at compose time) are unchanged, as accepted |

## Non-CONFORMS rows

1. Row 9: spec 9.2, PARTIAL [LOW], docs. The `landlordWasPrimary`
   paragraph (spec :796-803) still lists only the restore users and
   describes the rule in restore terms. The amended 4.6 (:337) sends the
   reader there for the delete predicate. Suggest one clause: "and, through
   `contactIsPrimaryToHandOff`, the contact-delete hand-off of a landlord of
   record (4.6)".
2. Row 10: spec 10, PARTIAL [LOW], docs. The P3 "delete:" test list
   (:836-838) does not name the F2 case (a no-flag landlord of record is
   handed off; someone else's no-flag unit is not a target; a flag elsewhere
   wins; a retry re-checks). The tests exist (row 32).

## Notes (not defects)

- N-1 (rows 1, 40). Spec 4.2's new bullet says the restore read is
  consistent "as the per-row consistent `getById` it replaced was". That
  holds for "Restore without a landlord" only. `main`'s swap read no
  liveness at all; it flagged the new landlord unconditionally (spec 4.6
  :371-374). Precision only.
- N-2 (row 4). Spec 4.7 bullet 3 ("the property box asks for a deliberate
  choice") is still true. Under F1 the box also asks for a property manager
  or owner to be added.
- N-3 (row 33). In `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`,
  the "What staff see meanwhile" paragraph was edited in this wave. It now
  describes the F1 box, but still ends "The contact Delete dialog's
  sentence ... (`ContactDetail.tsx:140-141`) does not hold for this shape".
  That is the pre-fix state, with a stale line ref, and the Resolution block
  below says it now holds. Recorded (3B divergence 6). Readable as history,
  but the paragraph mixes tenses.
- N-4. The spec's status line still reads "rev 6 - APPROVED". It has now
  been amended on-branch in two waves (R1 N-3 repeats). Each amendment is
  dated inline and authorized by `fix-wave-findings.md`.
- N-5. The one-click rule is enforced in the UI only, by design. The server
  still accepts `primaryContact: true` for a tenant (the edit-mode hand
  pick). The handback says so.

## 3. Contesting the adjudications of my R1

Conceded, all three. D-1 (contact ids in script logs) is a PII-rule reading
I agree with. D-3 is fixed at a7eca276, and the spec now matches the
GLOSSARY (row 11). D-4 (INFO line at compose time) is observability only;
I have no file:line showing it misleads anyone. The 81 CONFORMS stand.

## 4. Correct, or merely plausible?

Correct, on the readings below. Each was checked against shapes that could
break it.

- **F1.** The box shows only when P1 finds nobody (spec 7.4 :561-563,
  LD.tsx:540-541). Then the flagged row and the landlord of record are both
  dead or absent, so every `autoEligible` row is some other live,
  landlord-typed row. The one-click therefore never names a tenant, never
  names a caseworker (always type `partner`, `lib/caseworkers.ts:86-88`),
  and never re-flags a live primary.
- **F1 flag contract.** Flags and block come from the same complete read,
  so a missing block and missing flags coincide: no "Make" button can
  appear without a block.
- **F2.** The landlord-of-record gate is what keeps one delete from
  targeting every no-flag unit, and the predicate implements exactly that.
  - Derived-row units still answer "unchanged", because the derived landlord
    row is the excluded contact.
  - An off-roster landlord is covered: step 2 picks from the stored list,
    `addLandlordRow` stays false, and `applyPrimary` never re-adds the
    deleted landlord.
  - A flag elsewhere, even a soft-deleted one, still wins. This is
    consistent with 4.7 and R1-adversarial F3 (accepted).
- **F5a.** `ConsistentRead` sits in the per-table `RequestItems` entry,
  which is where BatchGetItem accepts it, and it is applied on every chunk
  and retry. The only opt-in callers are the restore route's two reads.
