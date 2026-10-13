# R2 re-review - feat/primary-contact-integrity @ e6fec584

Kind: CODE REVIEW, round 2 (fresh reviewer). Branch
`feat/primary-contact-integrity`, worktree `W:\tmp\primary-contact-integrity`,
tip e6fec584, merge base fa35f228. Reviewer: Claude Opus 5.5, read-only on the
repo except this file. Date: 2026-10-13.

Read: AGENTS.md; the spec (rev 6, all sections); plan sections 0-3 and the
rulings R1-R25; R1-conformance.md, R1-adversarial.md, R1-adjudications.md,
fix-wave-1-report.md; the full feature diff packages (app src, app test,
dashboard, e2e); the fix-wave packages (code, issues); the eight slice
reports' divergence and worry sections; and the tip sources around every
touched symbol, with repo-wide greps for the readers and writers of the
roster, the flag, `landlordId`, the scalar, `unitContacts`, the roster
writes, `softDelete`, `updateUnit`, `addUnitContact` and the unreachability
claims. Line numbers are at e6fec584.

## 0. Verdict

- New findings: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 3 LOW, 9 NOTE.
- Fix diff: the L2 test, every comment rewrite and the PRE-1 / L1 issue
  updates are REAL. The two new issue files are real with small citation
  drift and two misstatements (NOTEs). The selectors clause (N2's fix) is
  PARTLY WRONG and the N2 sweep is INCOMPLETE (R2-3).
- Adjudication challenges: one - N2's closure (section 3). No challenge to
  F1, F2, F3, F4, N4, N5 or D-1..D-9.
- Nothing found would block the merge. The server-side state machine
  (lookup, heir, P2, the three hand-offs, the script planner) held under
  every legacy shape and interleaving I walked; see section 1.5.

## 1. New findings

### R2-1 - LOW - CONFIRMED - the 470 Bolton shape recurs through the UI: a contact TYPE change makes a roster contact eligible but never promotes it, and spec 4.7 does not name this gap

- Where: P2 runs only inside the contact-list write
  (`app/src/repos/unitsRepo.ts:1222-1235`, `autoPrimaryLivenessIds` /
  `decideAutoPrimary`, fed by the route's `facts.autoPrimaryEligible` at
  `app/src/routes/units.ts:1399`). A type change goes through
  `PATCH /api/contacts/:id` (`app/src/routes/contacts.ts`), which touches no
  roster. The Unknown card's "Mark as Property Manager" is exactly such a
  PATCH: `dashboard/src/routes/contact/ContactDetail.tsx:694-701` ->
  `patchForSuggestedContactKind('property_manager')` = `{ type: 'landlord',
  role: PM_ROLE }` (`dashboard/src/routes/contact/contactProfile.ts:33`).
- Mechanism: on any property with no landlord of record (an imported one -
  the very population spec section 1 is about - or one restored without a
  landlord), "+ Add contact" of an UNKNOWN-, tenant- or partner-typed contact
  joins non-primary, correctly (not eligible, spec 4.3). Classifying that
  contact as a property manager or landlord later makes it eligible, but no
  roster write runs, so nothing promotes it. The property is then exactly the
  imported 470 Bolton shape: no `landlordId`, an ELIGIBLE live contact
  non-primary, no flagged row, P1 = nobody (`reason: 'none'`). New tours omit
  that contact from the default people list and every tour group opens with
  the general intro - the symptom this branch was opened for. The one-time
  backfill repairs it only if it runs after the classification.
- Not a code bug against the approved spec: spec 4.4 limits P2 to roster
  writes on purpose ("nothing outside the contact-list routes ... ever
  promotes anyone"), and G1 is "best effort, with the gaps named in P4". But
  P4 (spec 4.7, "Known gaps, by design") names only the importer's
  hard-delete retraction and the API PATCH reassign; this path is not named,
  and the docs say the opposite (R2-3). Backstops that DO work: the property
  box offers "Make <Name> primary" (`ListingDetail.tsx:478-481`), the
  open-group dialog explains and links to the fix.
- Repro: scratchpad `r2-rereview/r2Rereview.repro.test.ts`, describe
  "R2-N1" (FakeWorld, routes only): POST /api/units with a landlord, "+ Add
  contact" of an unknown-typed contact as pm (joins non-primary), DELETE the
  unit, re-type the landlord to tenant (allowed on a deleted property,
  `contactHoldings.ts:137-141` counts live properties only), POST restore ->
  409 -> restore `{ landlordId: null }` (heir pick: nobody eligible), PATCH
  the unknown contact to `type: 'landlord'`, GET -> no `landlordId`, the row
  `{ role: 'pm', primaryContact: false }` with no `deleted` / `caseworker`
  flag, `propertyContact` `{ contactId: null, reason: 'none',
  heirIfPrimaryRemoved: null }`. PASSES (the shape is reached). On an
  imported (already ownerless) property the restore steps are unnecessary.
- Recommended fix (pick per product call): (a) name it in spec 4.7's known
  gaps and in the GLOSSARY "primary contact" entry; (b) say in the RUNBOOK
  backfill section that the script is safe to re-run as a periodic sweep
  (idempotent, conditional writes); (c) ask Cameron whether a
  classification that makes a seated contact eligible should run P2 for the
  properties that contact sits on (one `contactHoldings.rosterUnitIds` Scan
  on a type change to landlord).

### R2-2 - LOW - CONFIRMED - the placement page's final-rent edit replaces the unit with the STORED roster, so deleted contacts are offered again in the People card

- Where: `dashboard/src/routes/placements/PlacementDetail.tsx:651-653`
  (`onRecordFinalRent` -> `updateUnit(...).then(setUnit)`), `:165-167`
  (`setUnit` replaces `unit` wholesale), `:261-275` (`rosterSuggestions`
  reads `unit?.contacts`); `app/src/routes/units.ts:1918` (PATCH answers
  `{ unit }` raw - no row flags, no block);
  `dashboard/src/routes/shared/rosterPeople.ts:110` (skips a row only on
  `deleted === true`).
- Mechanism: spec 7.5 promises the People card "never" offers a deleted
  contact for "+ Add" nor labels it "primary contact". The placement page
  gets the flags from its load-time GET, then the final-rent recorder (the
  Now card) swaps in the PATCH answer, whose rows never carry the
  response-only `deleted` flag. Until a reload or a `placement.updated`
  event (a unit PATCH emits none), every deleted roster contact is
  suggested again, and the flagged one is labeled "primary contact". One
  click puts a deleted contact on the placement plan, which is the filed
  `relay-provision-includes-deleted-contacts` path (provisioned and
  texted). The property page is immune (its card reads `rosterUnit` /
  `roster`, never `unit.contacts`) and the tour page never replaces its
  unit. Not a regression against `main` (which never filtered), a hole in
  the new guarantee that neither R1 reviewer swept (spec 7.5 lists only the
  property page's PATCH / status / photo replacements).
- Repro: describe "R2-L1" in the scratchpad file (GET marks the deleted row
  `deleted: true`; `PATCH { final_rent: 1500 }` answers the same row without
  it and without `propertyContact`) - PASSES; the dashboard half is the two
  lines cited above.
- Recommended fix: in PlacementDetail's `setUnit`, keep the previous
  `contacts` (and `propertyContact`) when applying a PATCH answer
  (`setLoaded((prev) => ({ ...prev, unit: { ...next, contacts:
  prev.unit?.contacts ?? next.contacts } }))`), or re-read with `getUnit`
  after the PATCH; one dashboard test that records a final rent and then
  asserts the deleted row is still not suggested.

### R2-3 - LOW - CONFIRMED - the "unreachable through the UI" claims survive in five places; README still says the exact sentence R1 N2 disproved

- Where:
  - `e2e/README.md:746` - "The only way to reach a property with no primary
    contact - the UI requires a landlord ..." (false per R1 N2 itself:
    Restore without a landlord, then add only tenants);
  - `e2e/support/selectors.md:88` (the fix wave's new clause) - "what it
    cannot build is the imported shape - an ELIGIBLE contact left
    non-primary";
  - `e2e/support/selectors.md:117` - "The only way to reach the state";
  - `app/src/routes/dev.ts:1269` - "It is the only way to reach that state";
  - `e2e/fixtures/primaryContact.ts:7` - "No UI path reaches that state";
  - `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts:7` - "The
    UI cannot reach that state".
- Mechanism: R2-1's repro reaches the imported shape through the routes the
  dashboard calls, so every one of these is false; the README line is false
  even for the weaker "no primary contact" claim. The fix wave changed one
  clause of one file (its own W2 noticed `:117` and left it). These are the
  files future agents read when writing e2e and reasoning about the seam.
- Fix: say why the seam exists without claiming impossibility - e.g. "the
  quickest deterministic way to build the imported shape (the UI reaches it
  only through a multi-step path: an ownerless property, an ineligible
  contact added, then re-typed)" - in all six places; leave spec section
  10's sentence for Cameron (approved text).

### 1.4 NOTEs

- R2-N1 (citation drift) - both new issue files cite
  `app/src/lib/propertyContact.ts` lines that moved by +2 at e6fec584 (the
  W1 header commit landed after the issue commit 9abe96ec):
  `primary-handoff-no-flag-landlord-delete-gap.md` "149-156" is now
  151-158 (`propertyContactCandidates`); `roster-liveness-read-eventual-
  consistency.md` "84-102" is now 86-104 (`readRosterContacts`). Every other
  citation in the two new files checks out (17 verified), and every one in
  the two updated files (17 more).
- R2-N2 (issue misstatements) - (a) the no-flag issue says a landlord-only
  unit "is handed off" because its derived row counts as flagged: it is a
  Scan TARGET, but its derived row is its only row, so `chooseHeir` answers
  none and `handOffPrimaryFrom` returns `unchanged` - nothing is ever moved.
  (b) the EC issue says the stale-image pick is something "spec 4.4
  forbids"; 4.4's refusal is the explicit-write 409, while an automatic pick
  on a stale read is spec 4.2's accepted-race class.
- R2-N3 (comment scope) - the fix-wave comment at
  `app/src/repos/unitsRepo.ts:1615-1622` sits on `oldWasPrimary`, which both
  restore branches share, and says a deleted flagged row elsewhere stays
  flagged "until the next eligible write or the script". On the SWAP branch
  the new landlord of record is live, so P2 can never promote (it needs no
  live landlord); only the script, an explicit Make primary or a removal
  clears it. True as written for the clear branch (and in
  `routes/units.ts:589-594`, clear only). Spec 4.7 uses the same phrase.
- R2-N4 (Check again race) - `TourDetail.tsx:470-482` and
  `PlacementDetail.tsx:335-347` guard the late answer only with `prev ===
  null`. Close the dialog while a Check again is in flight, reopen it (a
  fresh preview), and the older Check-again answer then replaces the newer
  preview. Same owner, small window; a request token (or comparing against
  the preview the check started from) would close it.
- R2-N5 (cleared draft is now sticky) - S4a W3, never adjudicated: an
  emptied textbox counts as edited (`draft !== seed`), so a Check again
  keeps it empty and shows "The intro changed.", while `run`
  (`RosterConfirmDialog.tsx:285`) treats an empty draft as untouched and
  posts no `introBody` - the group gets the server's composed intro under an
  empty box. Before this branch a new preview refilled the box. The send
  rule is pre-existing; the edited-draft rule makes the mismatch persist.
  Treating `draft.trim() === ''` as unedited in the seed comparison fixes it.
- R2-N6 (F10 extended) - with two flagged rows (legacy only), P1,
  `autoPrimaryLivenessIds`, the delete Scan, `handOffPrimaryFrom` and the
  script all read the FIRST flagged row. If the first is deleted and the
  second live: an eligible write for X promotes X and demotes the live
  second primary (`unitsRepo.ts:1222-1235`, `:1263-1265`), and the
  hand-off / backfill target paths flag `chooseHeir`'s pick, which can be an
  earlier eligible row, demoting the live second primary. No current writer
  makes two flags; accept with F10.
- R2-N7 (stale scalar survives) - the `unit-primary-contact-unchecked`
  resolution says the scalar "can no longer name a contact who holds no
  seat". A legacy stale scalar naming X (X's row not flagged) survives the
  removal of X's row (`removeContact` touches the scalar only for the
  primary row) and survives the script unless the unit becomes a target or
  has a live flagged primary. No runtime reader, so harmless; the sentence
  overclaims.
- R2-N8 (label) - three tests in
  `app/test/unitsApiRosterAutoPrimary.test.ts` carry the "(h)" label
  (`:182`, `:195`, and the new `:223`).
- R2-N9 (adjudication wording) - D-8's adjudication says the old landlord
  "was the derived primary". On a STORED no-flag list nothing is derived
  (`unitContacts` derives only for an absent or empty list); the old
  landlord was the lookup's landlord-of-record fallback. The ruling's
  outcome (`from` = old landlord) is fine.

### 1.5 Swept and sound (new code, beyond what R1 listed)

- Every roster mutator: only the three routes, the delete service and the
  script call `addContact` / `removeContact` / `restoreWithLandlord` /
  `handOffPrimaryFrom` / `assignPrimaryIfCurrent`; the only contact soft
  delete is `routes/contacts.ts:2254`; the only dashboard roster callers are
  in `ListingDetail.tsx`; no other code writes `contacts`, `primary_contact`
  or a roster-bearing `landlordId` (PATCH reassign and the importer are the
  named gaps).
- Legacy shapes through `planUnitPrimary`, `chooseHeir`, `applyPrimary`:
  an empty stored list (derived row), a `landlordId` naming no record, an
  off-roster landlord (row appended, never duplicated), empty-string ids
  (dropped from reads, skipped as candidates), a non-array `contacts`,
  scalar-only primaries (never read), landlord-only units (never written by
  the hand-off or the script, so the importer's `updated_at` line holds).
- Interleavings: P2 vs the delete hand-off (re-check answers not_primary
  or the hand-off moves to the new eligible row), two racing eligible
  writes, a hand-off vs an explicit Make primary, restores vs list changes
  (`expectContacts`), swap retries (per-attempt heir). All fenced by
  `updateRosterIfCurrent` on `landlordId` + `contacts`.
- The restricted-predicate recipe in the no-flag issue: walked flagged
  landlord, no-flag landlord, another row flagged (live or deleted),
  off-roster landlord with and without a flag, landlord-only unit, and the
  re-check after a concurrent P2 promotion. It targets exactly the intended
  units and the re-check terminates correctly. Sound.
- Relay intro: variant unchanged for every input (the new code only adds
  reads on degraded tours); `tenantFirstName` falls back to "there" inside
  `composeIntroBody`, so a missing tenant name never silently degrades to
  the general intro without a reason; reason order and `lookup_failed`
  rules match spec 5.1.
- Dashboard state: `setUnit` on the property page never clears the block or
  the roster rows; both restores re-read and REPLACE the roster source;
  unitId guards on every late re-read; the edited-draft rule's five
  sequences post what spec 7.2 says (tests discriminate both ways).
- Dev seam: structurally gated (`lib/devRoutes.ts:19`), `json()` scoped,
  ids-only logs. e2e (a)-(c) and the property-roster step 4 bind to server
  state and to the server's heir; none can pass with the box, the link or
  the heir missing.
- PII: every new log line carries ids, counts and reason codes; new response
  fields are staff-only.
- No runtime reader of `primary_contact` anywhere (app, dashboard, e2e,
  fake-twilio, infra, scripts); no caller sends it.

## 2. Fix-diff review (78e880bb..e6fec584)

| item | verdict | evidence |
|---|---|---|
| L2 - new PIN `unitsApiRosterAutoPrimary.test.ts:216-238` | REAL | Discriminates: `.superpowers/sdd/fixwave-item1-red.log` shows exactly this test failing under `if (autoPrimary)` -> `if (effectivePrimary)` while the old (h) PIN passed. Its premise holds: `seedContact` defaults to `type: 'landlord'` (`:39-43`), so on this shape the automatic rule's conditions are met and only the request flag separates the two. I re-ran the file: 20/20 green. Cannot pass for the wrong reason: the event is filtered by `event_type`, and the auto path appends it in sibling tests. |
| F3 comments `unitsRepo.ts:1615-1622`, `routes/units.ts:589-594` | REAL, TRUE | Match the code (`landlordWasPrimary` reads the flag only). Scope nuance for the swap branch: R2-N3. |
| F8 + W1 header `propertyContact.ts:11-19` | REAL, TRUE | Every automatic hand-off calls `chooseHeir`; auto-primary is `decideAutoPrimary` and shares only `isAutoRoutingEligible` (via `facts.autoPrimaryEligible`); landlord-of-record readers untouched. |
| N6 `rosterCopy.ts:1-4`, `useListing.ts:244-249` | REAL, TRUE | Both restores apply via `setUnit` (the dialog through `applyRosterUnit`) and then re-read. |
| test titles / block comment | REAL, TRUE | Wording only; assertions unchanged. |
| L1 update `relay-provision-includes-deleted-contacts.md` | REAL | Cites verified: `rosterResolution.ts:200-220`, `:587-601`, `:619`, `:660`; `rosterProvision.ts:107-121`; `relayAnnouncements.ts:64-101`, `:73`. |
| PRE-1 update `auto-routing-changes-not-named.md` | REAL | Cites verified: `ListingDetail.tsx:1106-1131`, `:569-577`; `routes/units.ts:1363-1369`, `:2001-2007`; `unitsRepo.ts:1173`, `:1192`, `:1281`, `:1343-1344`. The mechanism holds (a re-role sends the row's own flag, so the 409 never fires). |
| NEW `primary-handoff-no-flag-landlord-delete-gap.md` | REAL, minor defects | Mechanism and data shapes correct; recipe sound (section 1.5). Drift and one misstatement: R2-N1, R2-N2(a). |
| NEW `roster-liveness-read-eventual-consistency.md` | REAL, minor defects | Six callers and three shapes correct; the `ConsistentRead` recipe is valid (BatchGetItem takes it per table). Drift and one mis-cite: R2-N1, R2-N2(b). |
| N2 selectors clause `selectors.md:88` | PARTLY WRONG, INCOMPLETE | First half true; second half false (R2-1 repro); five sibling claims untouched, README the worst (R2-3). |
| repro run | REAL | `.superpowers/sdd/fixwave-repro.log`: 2 failed (F1, F3) / 6 passed, EXIT 1, as predicted. |
| gates | REAL | I re-ran `npm run typecheck`: EXIT 0, 0 `error TS`. |

## 3. Adjudication challenges

- N2 (ACCEPT, "selectors.md wording tightened") - CHALLENGE the closure.
  The tightening covered one of six statements, and the replacement clause
  is itself false. Rule instead: FIX - correct all six (R2-3) and flag spec
  section 10's sentence for Cameron.
- F1 (BY DESIGN) - no challenge. Spec 4.6's last bullet is explicit and
  approved; after the backfill flags every no-flag unit with a live
  landlord (F11), the shape needs an API demotion (R10) or a re-import, so
  exposure is small. The filed recipe is sound.
- F2 (ACCEPTED RACE) - no challenge to the ruling (R13 and spec 4.2 accept
  eventually consistent liveness). Recommend the filed `ConsistentRead`
  option when the issue is picked up: the restore pick was consistent on
  `main`, and the cost is a handful of keys per write.
- F3 (ACCEPTED STATE) - no challenge; spec 4.7 covers it and the box shows
  it.
- F4 (ACCEPTED RACE) - no challenge.
- N4 (double alert) - no challenge.
- N5 (two Activity rows) - no challenge: the rows say different things
  ("Property restored" and "Primary contact set automatically");
  `unit_restored.primaryPromoted` is not projected.
- D-1..D-9 - no challenge. D-8's stated reason is imprecise (R2-N9), not
  its outcome.
- F6, F7, F11, F12 - no challenge. F10 - no challenge, extended by R2-N6.

## 4. What I ran

All from the worktree, never `npm test`, `npm run e2e*` or `npm run dev`;
DynamoDB Local used, never started, stopped or restarted.

| command | result |
|---|---|
| `env \| grep '^AWS_'` (before every vitest run) | no output, grep exit 1 |
| `cd app && npx vitest run test/unitsApiRosterAutoPrimary.test.ts` | exit 0, 1 file, 20/20 |
| scratch repro copied to `app/test/r2Rereview.repro.test.ts`, `npx vitest run test/r2Rereview.repro.test.ts`, copy deleted | exit 0, 2/2 (both assert the reachable / unflagged outcome); `git status --short` empty afterwards |
| `npm run typecheck` (root, five workspaces) | EXIT 0, 0 `error TS` |
| `cd app && npx vitest run` propertyContactHeir, propertyContactLookup, contactDeletePrimaryHandoff, unitsApiPropertyContact, relayIntroFallback, assignPrimaryContacts.plan, unitsRestorePrimaryHandoff | exit 0, 7 files, 112/112 |
| `cd dashboard && npx vitest run` RosterConfirmDialog, rosterPeople, PlacementDetail | exit 0, 3 files, 109/109 |
| `git diff -U0 fa35f228..e6fec584` added lines in app, dashboard, e2e, docs, RUNBOOK vs non-ASCII | 0 |

Not run: the full suites, smoke, eslint (I changed no code), e2e.

## 5. Scratchpad

`C:\Users\Cameron\AppData\Local\Temp\claude\W--AI-Projects-Housing-Choice-HC-Application\31dd19d5-88f8-443e-a959-f9c3f41c0ab3\scratchpad\r2-rereview\`

- `r2Rereview.repro.test.ts` - describes "R2-N1" (R2-1 and R2-3) and
  "R2-L1" (R2-2). Run: copy to `app/test/`, then
  `cd W:/tmp/primary-contact-integrity/app && npx vitest run test/r2Rereview.repro.test.ts`,
  then delete the copy. Both PASS on e6fec584 (they assert the outcome the
  findings describe).
- `run1.log`, `typecheck.log`, `app-files.log`, `dash-files.log`,
  `r2-run-autoPrimary.log` - the runs above.
