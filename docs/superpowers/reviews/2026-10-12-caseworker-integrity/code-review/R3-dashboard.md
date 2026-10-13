# R3 re-review - dashboard + e2e + docs (fix/caseworker-integrity, fix wave 2)

Reviewer: fresh round-3 (TERMINAL) re-reviewer for the dashboard/, e2e/ and
docs half. Head 2bbc6799; fix wave 2 range d640cfb4..2bbc6799; branch base
19607658. Inputs read: R2-adjudications.md (rows FW2-5..FW2-10 and "Cameron's
rulings on Q4 and Q5"), R2-dashboard.md, FW2b-report.md, FW2a-report.md
(HANDOFF), spec revision 5 section 4 "Restore" and "Contact list (I4)" only,
r3-fix-dashboard.diff, r3-fix-docs.diff, r3-fix-backend.diff (for the wire),
r3-full.diff, and the worktree. The plan and the other design records were
not opened.

Gate context: nothing was run or edited before
`.superpowers/sdd/logs/p5-e2e.exit` existed (exit=0, 345 passed, 22.0m).
Afterwards: one vitest file at a time from `dashboard/`; mutants applied only
with the Edit tool and each reverted byte-identically (sha256 log at the
end). No git write, no `npm test`, no e2e, no Docker.

Counts (new findings): BLOCKER 0, HIGH 0, MEDIUM 0, LOW 1, INFO 4.
No regression introduced by fix wave 2 was found. Every fix-wave-2 item in
this half is REAL (table B); FW2-5's ruling premise is challenged (C1, A1).

---

## (A) Findings

### A1. LOW - CONFIRMED (probe) - the restore dialog's late answer is still bound to no property: after a move to another property it replaces that property's Contacts-card roster (the next re-role then posts a stale primary flag) and closes that property's own restore dialog

Location: `dashboard/src/routes/listing/ListingDetail.tsx:407-410`
(`applyRosterUnit`: `setRosterUnit(updated)` at :408 is unguarded - FW2-5
bound only its `setUnit` half, :409); the dialog's callbacks `:1425-1428`
(`onRestored`: `setRestoreNeeds(null)` + `applyRosterUnit`) and `:1429-1443`
(`onConflict`: `applyRosterUnit(fresh)` :1435, `setRestoreNeeds(null)`
:1437); `:306-308` (a foreign `rosterUnit` is dropped and the card falls back
to the hook's LOAD-TIME `roster`, which `setUnit` never re-derives -
`useListing.ts:168`); `:471-478` (a re-role sends the row's displayed
`primaryContact`); server `app/src/repos/unitsRepo.ts:955-957`, `:971-973`
(an upsert writes the sent flag onto the existing row and, when true, demotes
every other row).

Scenario (reproduced): deleted property A (its landlord re-typed), the
landlord dialog open; staff press "Restore without a landlord" and the POST
stalls. They press browser Back to live property B (FW-11 closes the dialog,
FW2-5 keeps B rendered). On B they open Edit contacts and press Make primary
on Yara (Xavier was the primary); B's answer lands and the card shows "Yara
Pm (primary)". Then A's restore answers: A's `onRestored` runs
`applyRosterUnit(A')`, `setRosterUnit(A')` displaces B's own answer, the
unitId guard (:306) drops it, and B's card falls back to B's load-time roster
- "Xavier Pm (primary)" again and a "Make Yara Pm the primary contact"
button, while the server says Yara. The next ordinary action on that stale
card - changing Xavier's role - posts `{ contactId: 'pmX', role: 'owner',
primaryContact: true }`, which the server applies as "make Xavier primary,
demote Yara" (a re-role of Yara would post `false` and leave B with no
primary row, so routing falls back to the landlord of record). Second
consequence (reproduced): when B is itself deleted and its own plain restore
opened B's dialog, A's late `onRestored` (or a late `onConflict` re-read of a
live A) runs `setRestoreNeeds(null)` and closes B's dialog although B was not
restored; a pick there is lost and, if B's own write was in flight, its
refusal message is dropped with the unmounted dialog.

Reachability and severity - LOW, not MEDIUM: only the dialog's two paths can
do it. A roster write on A cannot, because `rosterBusy` carries across the
move and blocks B's roster writes until A's settles (:430; the buttons
:960-988); the dialog's write has its own `busy` (RestoreLandlordDialog.tsx:49)
and does not touch `rosterBusy` or `deleteBusy`. It needs A's restore to stay
in flight across a browser Back, B's whole page load AND a completed roster
write on B - a multi-second stall (the API client has no timeout; the dialog
cannot be closed while busy, RestoreLandlordDialog.tsx:97-99, so Back is the
way out of a stalled dialog) - and then a re-role on the stale card. The
wrong write is visible afterwards (its answer re-renders the card) and
audited (`unit_contact_added`); nothing is lost. Not a fix-wave-2 regression:
the unguarded `setRosterUnit` / `setRestoreNeeds(null)` are the original
build's (the dialog is new in this branch). Before FW2-5 the same sequence
ended on B's permanent spinner (R2 A1); FW2-5 leaves B interactive, which is
what lets staff act on the stale card - so the root cause
R2-adjudications.md:37 calls "closed at the root" is closed for the page's
unit only.

Proof: throwaway `dashboard/src/routes/listing/zz-review-r3d-roster-nav.test.tsx`
(real `useListing` + `ListingDetail`, API mocked; deleted). Case X2 (the
scenario above) and case X1 (B's dialog closed by A's late answer) both
PASSED on the branch, i.e. each asserted defect is present: X2 saw "Yara Pm
(primary)" before A's answer, "Xavier Pm (primary)" and a Make Yara primary
button after it, and `addUnitContact` last called with `('uB', { contactId:
'pmX', role: 'owner', primaryContact: true })`; X1 saw B's dialog (naming
Olive Owner) gone after A's answer, B's deleted banner still shown, and B's
only restore call the plain one.

Fix (FILED, per the terminal rule): bind the dialog's callbacks and the
roster state to the property they were created for - in both callbacks
`setRestoreNeeds((prev) => (prev?.unitId === unit.unitId ? null : prev))`,
and drop an `applyRosterUnit` answer whose `unitId` is not the route's
current one (or hold `rosterUnit` per unitId) - or the issue's own suggested
direction (key the `/listings/:unitId` element by unitId,
`dashboard/src/App.tsx:271`), which retires A1 and every leftover in A2 at
once. Regression test: the probe's two cases inverted (B's card keeps "Yara
Pm (primary)" and the re-role posts `primaryContact: false`; B's dialog stays
open). Disposition: append to
`docs/issues/listing-detail-dialogs-survive-property-navigation.md`.

### A2. INFO - the FW2-5 update to `listing-detail-dialogs-survive-property-navigation` overclaims "The IN-FLIGHT half of this class is fixed at the root"

Location: `docs/issues/listing-detail-dialogs-survive-property-navigation.md:39-50`.
Only the permanent spinner is fixed at the root. Still landing on the next
property after a move (by reading; each settles with its request, so none is
a stuck page): A1 (branch); late failure messages - `statusError`
(`ListingDetail.tsx:278`, shown on B's status pill), `photoError`
(`:663-674`, B's Photos), `rosterError` (`:445`, `:449`; keyed by contactId,
so it shows on B's row when the same contact - one PM, say - is seated on
both properties); busy flags carried across the move - `deleteBusy` (`:358`,
`:372`: B's Restore and Delete disabled, and an open Delete confirm on B reads
"Deleting..." `:1400`), `rosterBusy` (`:430`), `statusBusy` (`:270`),
`photoBusy`, `removeBusy`; a late delete success navigates B's page to the
Properties list (`:362-365`); late successes close B's open confirms and
forms (`setRemovingEntry(null)` `:697`, `setRemovingContact(null)` via
`:497`, `closeAddContact` via `:551`). All pre-existing except A1; FW2b's own
"Noticed, not fixed" names two, the issue text a reader acts on names none.
Fix: say "the permanent spinner is fixed at the root" and list what still
lands (or adopt the keyed route).

### A3. INFO - the selectors.md restore-dialog row's example second alert cannot show beside the load error

Location: `e2e/support/selectors.md:136` ("it can hold TWO at once - the
landlord list's load error `Couldn't load the landlords.` and a restore
failure (for example `Only a landlord can be a property's landlord of
record.` or ..."). When the landlords read fails, `landlords` stays empty
(`RestoreLandlordDialog.tsx:57-58`, `:126`), nothing can be picked, and
"Restore with this landlord" stays disabled (`:112-115`); "Restore without a
landlord" never answers `landlord_not_landlord` (the route checks a chosen
landlord's type only for a string choice, `app/src/routes/units.ts:1750-1766`).
So the only alerts that can sit beside the load error are `The property
contacts changed - try that change again.` and `Couldn't restore - please try
again.`. The strict-mode advice itself is right (D). Fix: use those two as
the examples.

### A4. INFO - `restoreUnit`'s doc was not brought to revision 5

Location: `dashboard/src/api/endpoints.ts:1029-1036`. It does not say that a
`{ landlordId: null }` restore can make the sole remaining landlord-typed
contact the primary contact (spec revision 5; the caller must render the
answer's roster, as ListingDetail does through `applyRosterUnit`), that its
409 `unit_roster_conflict` now also means "the contact list changed since the
route's read" (FW2-12), or that it can answer 404 `unit_not_found`. FW2-9
updated `addUnitContact`'s doc only (as ruled). Fix: two clauses.

### A5. INFO - the open issue FW2b edited keeps line references fix wave 2 moved

Location: `docs/issues/contact-type-refusal-copy-edge-cases.md` - frontmatter
refs (:9) `app/src/routes/units.ts:1626`, `:1645`, `:1702`; body (:36-45)
`units.ts:1594-1601`, `:1645`, `:1702`, `ListingDetail.tsx:1413-1416`,
`:1417-1431`; (:55) `ListingDetail.test.tsx:1381`; (:63)
`units.ts:1626-1628`. Each was right at d640cfb4; fix wave 2 moved them
(FW2a's insertions in units.ts, about 94 lines; FW2-8's comment in
ListingDetail.tsx, 10 lines; the FW2-7 / FW2-13 cases in the test). Today
`units.ts:1626` is a `} catch (err) {` in another route (the `landlordName`
line is :1720, the plain answer :1737), `ListingDetail.tsx:1413` is the Delete
confirm (`onRestored` is :1425), and the W7 pins are at
`ListingDetail.test.tsx:1450-1474`. FW2a re-pointed only the resolved issue
(17ff585a); FW2b appended FW2-10 to this file with current refs beside the
stale ones. Fix: re-point.

---

## (B) Fix wave 2 verdicts (dashboard / e2e / docs)

| Item | Verdict | Evidence (this review; each mutant reverted, sha256 = baseline) |
|---|---|---|
| FW2-5 (R2D-A1) `useListing.setUnit` forId guard | REAL (scope: A1, C1) | M1 guard reverted to the unguarded return: `useListing.test.tsx` 2 failed / 11 - renderHook case `expected 'loading' to be 'ready'`, page case `expected document not to contain element, found <span` (the Loading spinner). M1c "apply A's unit, keep B's forId": 2 failed / 11 (`expected 'uA' to be 'uB'`; B's heading `22 Elm St` gone). M1b "always a no-op": 2 failed / 11 (the new positive control `to match object { unitId: 'uB', status: 'occupied' }`, and the existing mediaDisplay case) |
| FW2-6 (R2D-A3) StrictMode abort guard pinned | REAL | M2 `RestoreLandlordDialog.tsx:64` guard removed (flag set unconditionally): `RestoreLandlordDialog.test.tsx` 1 failed / 11 - the StrictMode case, `found <p role="alert">` |
| FW2-7 (R2D-A4) late 409 pinned; the u2 check made falsifiable | REAL | M3 render-time reset `ListingDetail.tsx:225` removed: `ListingDetail.test.tsx` 2 failed / 84 - the FW-11 case at `:1529` (`expected [ 'u1', 'u2' ] to deeply equal [ 'u1' ]`, the held button now posts against u2) and the late-409 case at `:1599`. M4 effect-based reset (`useEffect(() => setRestoreNeeds(null), [unitId])` + import): 1 failed / 84 - the late-409 case at `:1599` only. M6 "hide unless it matches" (reset removed, render `restoreNeeds.unitId === unitId`): 2 failed / 84 - `:1535` and `:1604`, both the Forward step (FW2b's by-reading claim, now run) |
| FW2-8 (R2D-A5) comment above `promotionNotice` | REAL (comment; no test can pin it) | Each of its three ways checked against the code (D); the ruled sentence `:542` unchanged |
| FW2-9 (R2D-A6) selectors.md row + `addUnitContact` doc | REAL (docs) | Both true against the code (D); residue A3 (an impossible example) and A4 (the sibling `restoreUnit` doc) |
| FW2-10 (R2D-A7) FILE the Activity copy | REAL (filed) | The paragraph's refs and its projection claim are correct (`listingFormat.ts:229-230`, `units.ts:1799-1806`, `:221`); the issue's older refs are stale (A5) |
| FW2-13 (Q5 render) | REAL | M5 `onRestored` applies `setUnit(updated)` instead of `applyRosterUnit(updated)` (`:1427`): 2 failed / 84 - the new case at `:1406` (received `James Porter (primary)Landlord`) and the existing (PIN) roster case at `:1340` |

Baseline: on the unmutated head 2bbc6799 these files are green (the
orchestrator's p5 `npm test`, exit=0: useListing 11, RestoreLandlordDialog
11, ListingDetail 84; dashboard workspace 237 files / 4472 tests); under each
mutant every case other than the named kills stayed green (the pass counts
above).

---

## (C) Challenges

1. R2D-A1 -> FW2-5, the ruling's premise. `R2-adjudications.md:37` rules the
   one-line guard because "it closes the branch's new paths and the
   pre-existing writers at the root". It closes them for the page's UNIT
   only. The branch's two new paths - the restore dialog's `onRestored` and
   `onConflict` - also write `rosterUnit` (through `applyRosterUnit`,
   `ListingDetail.tsx:408`) and `restoreNeeds` (`:1426`, `:1437`), neither
   bound to its property (A1, reproduced). Not a call to reopen under the
   terminal rule: proposed disposition FILE (append A1 and A2's list to
   `listing-detail-dialogs-survive-property-navigation`, with the probe's two
   cases as the regression tests). The issue's own keyed-route direction
   would close all of it.
2. Cameron's Q5 ruling, the residual. Option (a) (`R2-adjudications.md:79-91`)
   promotes only when exactly ONE remaining row is landlord-typed. With two or
   more (a PM and an owner, say) or none, "Restore without a landlord" on a
   property whose landlord was the primary still leaves no primary row and no
   landlord of record - nobody reachable - and nothing says so: the dialog's
   only sentence is the spec's (`RestoreLandlordDialog.tsx:122`) and the page
   has no notice; the only signal is the absence of "(primary)". That is R2
   dashboard A2, narrowed. The ruling's substance is Cameron's and is not
   challenged; what is missing is a record of the residual: `docs/issues` has
   no entry for it (no match for "without a landlord" there). Proposed
   disposition: FILE it (a paragraph in
   `contact-type-refusal-copy-edge-cases`, which already holds the restore
   copy questions), so the copy question is not lost.

Checked and agreed (each ruling's premise holds): FW2-6 and FW2-7 as
test-only items (the mutants kill the new cases, table B); FW2-8 "fix the
comment, the sentence stays as ruled" (the comment is now true, D); FW2-9
(the `addUnitContact` doc is true; A3 / A4 are small residue); FW2-10 FILE
(the Activity projection whitelist really drops the fields, `units.ts:221`);
the orchestrator's copy note on "...or a new contact is added" after Q4 (the
comment states the precise rule).

---

## (D) Swept and clean

- FW2-5's guard (`useListing.ts:168`) in every interleaving constructed: (1)
  A's answer while B's first fetch is still in flight (`prev.forId` still
  'uA') applies to A's hidden state and B's fetch then commits over it -
  harmless; (2) once B has committed, a no-op; (3) A -> B -> A: an answer
  from A's first visit landing during A's re-fetch is dropped and the
  re-fetch commits (unguarded, it would briefly have shown A's unit over B's
  panels); (4) B's error state stays an error. Same-property writes are
  unaffected (`setUnit` is re-created per unitId and every handler captures
  the current one). Every writer FW2b lists goes through it (grep: :276,
  :375, :409, :648, :686, :696, :1351); `useListing` has no other consumer.
  It is the `useContact.setContact` precedent (`useContact.ts:51-53`).
- The new tests can each fail and each tests what it says (table B): the
  renderHook case's positive control kills an always-no-op setter (M1b) and
  its `unit.unitId === 'uB'` check kills "take A's unit, keep B's forId"
  (M1c); the page case checks B's own heading, not only the absence of a
  spinner; the StrictMode case asserts its premise (two reads, signals
  `[aborted, live]`); the held-button press reaches no handler under FW-11
  (the dialog's node is detached and React listens at the root) and reaches
  `run(null)` bound to u2 when the dialog survives (M3); the late-409 case is
  the only one that sees an effect-based reset (M4); the FW2-13 case's
  stateful `useListing` mock mirrors the real `setUnit` (unit replaced,
  load-time roster kept), so only the card's own roster state can show Dana
  (M5).
- The comment above `promotionNotice` (`ListingDetail.tsx:513-534`) against
  the code: resolvers take the primary row, else the landlord of record
  (`app/src/lib/rosterResolution.ts:292-294`, `app/src/lib/tourContacts.ts:124-129`,
  `app/src/services/rosterProvision.ts:233-234`, `:525`); auto-primary is a
  NEW seat, typed landlord, no `landlordId` attribute, no primary row
  (`app/src/repos/unitsRepo.ts:937-941`), a role-landlord claim included
  (`:901`, `:986`); a seated landlord-typed contact re-roled to Landlord
  claims the slot (`:901`, I3 `:917`) and is not made primary (auto-primary
  needs a new seat, `:939`; the page sends the row's current flag, `:476`).
  True as written; the ruled sentence (`:542`) is unchanged.
- `addUnitContact`'s doc (`endpoints.ts:1048-1071`) against the route and
  repo: pointer ids 404 `contact_not_found` (`units.ts:1159-1162`); both 409s
  from the pre-checks (`:1180-1192`) or the roster write (`:1210-1225`, repo
  `:916-917`); auto-primary as in the repo. "A contact of any other type
  joins non-primary" reads correctly in its context (a request without
  `primaryContact: true`).
- RUNBOOK's new contact-list sentences (r3-fix-docs.diff, `RUNBOOK.md:475`)
  against `unitsRepo.addContact` and `restoreWithLandlord`: true.
- FW2-10's paragraph refs (`listingFormat.ts:229-230`, `units.ts:1799-1806`,
  `:221`): correct; the projection keeps only top-level string `from` / `to`,
  so the nested objects are dropped, as it says.
- selectors.md's strict-mode advice: the dialog can hold two `role="alert"`
  paragraphs (`RestoreLandlordDialog.tsx:130-139`) - correct (A3 is about
  the example only). No e2e spec reads the restore dialog's alerts bare.
- The Contacts card after the restore promotion: the answer becomes
  `contactsUnit` (`:306`), Dana is the one "(primary)" with no Make primary,
  `landlordOfRecord` is '' (`:315`), so her Remove is enabled and its confirm
  reads the ownerless sentence - consistent with `removeContact` on a
  property with no landlordId (`unitsRepo.ts:1062-1074`). Out of edit mode
  the first link is hers (primary-first sort, `buildListingFile.ts:51-52`).
- The Contacts card after an auto-primary add: the add still posts
  `primaryContact: false` (`:550`), the answer's flag renders, and a later
  re-role of that row sends its current `true` (`:476`), so it stays primary.
- The restore dialog after FW2-12's new 409 (a contact-list change between
  the route's read and the write): `onConflict` re-reads into the page and
  the card (`:1429-1443`), the dialog keeps `The property contacts changed -
  try that change again.`; a retry is re-decided on the server's fresh read.
  The promoted answer arrives through the same `onRestored` ->
  `applyRosterUnit`.
- The Unknown card, the edit form and the tour / placement copy sites: fix
  wave 2 did not touch them; re-read the branch diff of `ContactDetail.tsx`,
  `UnknownFile.tsx`, `ContactEditForm.tsx`, `TourModals.tsx`,
  `TourDetail.tsx`, `PlacementDetail.tsx`, `PlacementsPage.tsx`,
  `PlacementCreateForm.tsx`, `ScheduleTourForm.tsx`, `TenantFile.tsx`: each
  typed mapping precedes its site's fallback, the Unknown card's error is
  reset per contact and guarded per generation, the edit form's refusals
  reset per kind change and per save; R2's mutant verdicts for FW-9 / FW-10 /
  FW-12 stand.
- e2e: fix wave 2 changed only `selectors.md`; `property-roster.spec.ts:372-435`
  (SA-1) is still true against the dashboard (its property keeps no other
  row, so Q5 never applies there). The p5 full e2e is green (345 passed).
- `deleteBusy` / `rosterBusy` across a move (FW2b noticed): cosmetic -
  controls on B stay disabled until A's request settles, never stuck (each is
  reset in `.finally`); listed in A2.

---

## Probe and mutant log

Throwaway (`dashboard/src/routes/listing/`, deleted by exact name before
handback, never committed):
- `zz-review-r3d-roster-nav.test.tsx` - branch: 2 passed / 2 (X2 and X1 -
  each asserts the defect, so passing confirms A1).

Mutants (Edit tool only; after each revert the sha256 equalled the baseline
and `git diff --stat` of the file was empty):
- `useListing.ts` 86aa248c...: M1 (guard reverted), M1c (A's unit kept on
  B), M1b (always a no-op).
- `RestoreLandlordDialog.tsx` a9c7c662...: M2 (abort guard removed).
- `ListingDetail.tsx` 19ad421d...: M3 (reset removed), M4 (effect-based reset
  + import, two edits), M6 (reset removed + render-time match, two edits), M5
  (`onRestored` applies `setUnit` only).

Final state: the three source files match their baselines; no `zz-review-r3d-*`
file remains. The worktree also holds the parallel app reviewer's files
(`app/test/zz-review-r3b-*`, a modified `app/test/helpers/twilioWebhookHarness.ts`),
not touched here.
