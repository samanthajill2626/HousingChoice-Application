# R2 re-review - dashboard + e2e (fix/caseworker-integrity)

Reviewer: fresh round-2 re-reviewer, dashboard/ and e2e/ half, head d640cfb4
(base 19607658; fix range f11e46fb..d640cfb4). Inputs read: R1-adversarial-
dashboard.md, R1-adjudications.md, FW1-report.md, SA1-report.md, the packages
r2-fix-dashboard.diff / r2-fix-backend.diff / r2-full.diff, and the worktree
(dashboard, e2e and the app routes/repos the dashboard depends on). The spec
was opened only to check adjudication claims (section B). The plan was not
opened.

Gate context: no probe ran before `.superpowers/sdd/logs/p4-e2e.exit`
existed (exit=0, 345 passed, 22.3m). Every probe was one vitest file at a
time from `dashboard/`; mutants were applied only with the Edit tool and each
reverted byte-identically (sha256 log at the end). No git write, no npm test,
no e2e, no Docker.

Counts: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 2, INFO 5.

---

## (A) New findings

### A1. LOW - CONFIRMED - a property write that lands after a history move to another property leaves that property on a permanent spinner; FW-11 closes the dialog but not its in-flight restore

Location: `dashboard/src/routes/listing/useListing.ts:143-167` (`setUnit`
always writes `forId: unitId` of the id it was created for, :163) with
`:235` (`state.forId !== unitId` -> LOADING); reached through
`ListingDetail.tsx:1415-1418` (the restore dialog's `onRestored` ->
`applyRosterUnit` -> `setUnit`, :407-410) and `:1419-1433` (`onConflict`'s
re-read -> `applyRosterUnit`). The same hook is guarded on the contact page:
`dashboard/src/routes/contact/useContact.ts:51-53` (a setter held for an
earlier id is a no-op - its comment names exactly this "loading forever"
failure).

Scenario: deleted property A, the landlord dialog open, staff press "Restore
without a landlord" (or "Restore with this landlord"); while the POST is in
flight they press browser Back to property B. FW-11 resets `restoreNeeds`
and the dialog unmounts, B loads and renders. Then A's restore answers: the
dialog's `onRestored` closure (created on A's render) calls A's `setUnit`,
which stamps the hook state `forId: 'uA'` while the route is `uB`, so B's
page derives LOADING and shows the spinner forever (the fetch effect is keyed
on unitId and never re-runs). A was restored correctly; B is unusable until a
reload or another navigation. Window: A's write must answer after B's whole
page load. The pre-existing writers (banner Restore :374-375, status :276,
roster writes :433-437, the edit form :1340-1343) share the defect; the
branch adds the two dialog paths, and FW1-report "Noticed, not fixed" named it
unverified.

Proof: `listing/zz-review-r2d-listing-nav.test.tsx` (real `useListing`, API
mocked). Case 1 (`renderHook`: A's setter called after the hook moved to B)
failed as predicted at its first assertion: `expected 'loading' to be
'ready'`. Case 2 (the scenario above through `ListingDetail` and
`RestoreLandlordDialog`) failed as predicted at the LAST assertion (B's
heading gone; the DOM is the `role="status" aria-label="Loading"` spinner).
With the one-line guard below applied temporarily: both cases passed and
`useListing.test.tsx` stayed 9/9; reverted.

Fix: in `useListing.setUnit`, `setState((prev) => (prev.forId === unitId ?
{ ...prev, status: 'ready', unit: applied, forId: unitId } : prev))` - the
`useContact.setContact` precedent. It fixes every writer at once, including
the in-flight variants of the twins filed in
`listing-detail-dialogs-survive-property-navigation`. Regression test: the
two probe cases (both fail with the guard removed).

### A2. LOW - CONFIRMED (mechanism) - "Restore without a landlord" can leave the property with nobody reachable and says nothing; SA-1 only helps once a NEW contact is added

Location: `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:105-107`,
`:122` (the dialog's only sentence); server
`app/src/repos/unitsRepo.ts:1166-1202` (`restoreWithLandlord(next: null)`:
the old landlord's row dropped, `landlordId` and - when the old landlord was
the primary - `primary_contact` REMOVEd and every row non-primary); resolver
`app/src/lib/rosterResolution.ts:292-294` (primary row ?? landlordId);
auto-primary `unitsRepo.ts:836-839` (fires only for a NEW seat).

Scenario: a deleted property with James (landlord of record, primary) and
Dana (pm). James is re-typed, staff restore, the dialog opens, they choose
"Restore without a landlord". Afterwards the property has no landlordId and no
primary row; Dana stays non-primary, so the resolvers find no property
contact and calls / new relay groups for its tours reach no one - the exact
outage state R1 finding 1 (MEDIUM) was about, reached through the other
supported path. Nothing says so: not the dialog before the click, not the page
after it (the only signal is the absence of "(primary)"). SA-1 ends the
outage only when someone adds a NEW contact; with Dana already seated nobody
does. The same holds whenever no non-landlord row was already primary (the
landlord of record was the routing fallback), i.e. for most properties that
keep other contacts. The page's own rule for the other path is that silently
moving calls is not acceptable (`ListingDetail.tsx:1438-1440`).

Proof: `listing/zz-review-r2d-restore.test.tsx` case 2 passed on the branch:
the dialog contains no "primary contact / reach no one / calls" text, and
after "Restore without a landlord" (server answer built from
unitsRepo.ts:1166-1202) the Contacts card lists Dana with no "(primary)" and
no text anywhere says nobody is reachable.

Fix: needs a ruling - the dialog copy is the spec's (spec section 4,
:314-319). Directions: a consequence sentence under "Restore without a
landlord" when no non-landlord row is primary (the page knows its roster), or
a page notice after the restore reusing the ownerless sentence, or extending
auto-primary to this write (which row? - a design question). Regression test:
probe case 2 inverted (expect the sentence).

### A3. INFO - CONFIRMED (mutant) - FW-8's abort guard is load-bearing under StrictMode and unpinned

Location: `RestoreLandlordDialog.tsx:64` (`if (!ac.signal.aborted)` before
`setLandlordsFailed(true)`); the app runs under `<StrictMode>`
(`dashboard/src/main.tsx:15`), so every dev / e2e mount runs the effect twice
and the first read is aborted (`api/client.ts:125` rethrows AbortError).

Without the guard the first, aborted read sets the failure flag on the still
mounted dialog and "Couldn't load the landlords." shows on EVERY open in dev
and in the e2e lane, beside a list that loaded. Production (no double effect)
would only abort on unmount.

Proof: mutant M-B (guard removed, flag set unconditionally):
`RestoreLandlordDialog.test.tsx` 10/10 green (survives); probe
`zz-review-r2d-restore.test.tsx` case 3 (StrictMode, signal-aware mock,
`getAllContacts` called twice, Nora offered) red: `expected <p role="alert">
to be null`. Green on the branch. Fix: add probe case 3 to
`RestoreLandlordDialog.test.tsx`.

### A4. INFO - CONFIRMED (mutant) - FW-11's test pins the open-dialog move but not the late-409 property FW-11 claims, and its "never restores" assertion is vacuous

Location: `ListingDetail.test.tsx:1407-1458`; FW1-report divergences ("it
also drops a restore_needs_landlord 409 that resolves AFTER the move").

- The late-409 behavior is correct on the branch (probe
  `zz-review-r2d-restore.test.tsx` case 1 green: the 409 lands while on u2, no
  dialog on u2, none on Forward to u1), but nothing pins it: mutant M-D (the
  render-time reset replaced by `useEffect(() => setRestoreNeeds(null),
  [unitId])`, the alternative FW1 rejected) passes `ListingDetail.test.tsx`
  82/82; probe case 1 goes red (`expected document not to contain element`).
- `:1455-1457` ("restoreUnit never called with u2") hold with or without the
  fix: no step clicks a dialog action on u2. The test goes red on the real
  revert only through `:1448` (dialog still open).
Fix: add probe case 1 to `ListingDetail.test.tsx`; either drop the vacuous
assertions or click the dialog's action after the move under a mutant-proof
setup.

### A5. INFO - the ownerless notice and its doc comment omit a working remedy; the comment's "only" is false

Location: `ListingDetail.tsx:521-522` ("otherwise only making someone on the
contact list the primary contact restores the routing") and the sentence
`:532`. Re-roling a seated contact to Landlord on an ownerless property claims
the vacant slot (`unitsRepo.ts:814`, `:881`; SA1 decision 3: the claim is not
made primary) and the resolvers then fall back to that landlord of record
(`rosterResolution.ts:294`), so routing is restored without anyone being made
the primary contact or a new contact being added. The sentence ("until A or
B") is incomplete rather than false and is planner-ruled; the comment is
false. Fix: correct the comment ("...or a seated contact claims the empty
landlord slot"); optional copy follow-up. No test.

### A6. INFO - doc drift from the fix wave

- `e2e/support/selectors.md:136` (restore dialog row): "Its errors are one
  `role="alert"` inside it" - since FW-8 the dialog can hold two at once (the
  load error and a restore failure, `RestoreLandlordDialog.tsx:130-139`), so
  an unscoped `dialog.getByRole('alert')` is a strict-mode violation in that
  state. Fix: say up to two and match by text.
- `dashboard/src/api/endpoints.ts:1048-1059` (`addUnitContact` doc): no
  auto-primary rule (SA1 noted) AND its error list omits the branch's two new
  409s, `contact_list_caseworker` and `landlord_not_landlord`, which
  `runRosterWrite` maps (`ListingDetail.tsx:443-447`).

### A7. INFO - Activity reads "Property restored" for a restore that replaced or cleared the landlord of record

Location: `dashboard/src/routes/listing/listingFormat.ts:229-230`; the audit
carries `landlordReplaced { from, to }` / `landlordCleared { from }`
(`app/src/routes/units.ts:1690-1695`, spec section 4 "Audit"). Not false, but
the one place staff can later see that a restore changed ownership does not
say it. Optional: a sub line ("Landlord cleared" / "Landlord changed").

---

## (B) Adjudication challenges

1. D8 -> FW-11, FIX scope too narrow. The ruling was "reset its state when the
   unitId changes"; FW-11 does that, but the dialog's in-flight write still
   completes into the other property's page (A1, reproduced). The root is one
   unguarded setter that the contact page already guards. Proposed
   disposition: FIX the hook (one line, A1's two tests) - it is smaller than
   FW-11 and also closes the in-flight half of the filed twin issue; at least
   append A1 to `listing-detail-dialogs-survive-property-navigation`.
2. SA-1's rationale ("on a property with nobody reachable - e.g. after
   'Restore without a landlord' - staff add a PM and expect them to be the
   primary contact") is met only when the list is empty or someone adds a new
   contact. With other contacts kept, the post-restore outage is silent (A2).
   Proposed disposition: ASK / FILE (copy in a spec-approved dialog).

Checked and NOT challenged (the claim each ruling rests on holds): D2 (the
sentence is spec :211), D4 ("Any other failure keeps each site's current
copy", spec :366), D10 (dialog sentence is spec :314-319), D11 (spec D1 item
6, :151-156), and SA-1's "new seat" interpretation (spec revision 4 :333-341
says it in words).

---

## (C) FW-8..FW-13 and SA-1 (dashboard / e2e)

| Item | Verdict | Mutant evidence (this review) |
|---|---|---|
| FW-8 (D5) load-error alert | REAL (test gap A3) | M-A `setLandlordsFailed(true)` neutralized: RestoreLandlordDialog.test 1 failed / 10 (`Unable to find role="alert"`). M-B abort guard removed: 10/10 survive; probe case 3 red |
| FW-9 (D6) Unknown-card guards | REAL | M-G guard `ContactDetail.tsx:686` neutralized: 1 failed / 127 (case "lands AFTER the move"). M-H reset `:292` removed: 1 failed / 127 (case "does not survive the move") |
| FW-10 (D7) per-save reset | REAL | M-I `ContactEditForm.tsx:498` removed: 1 failed / 76 (the second-save case) |
| FW-11 (D8) dialog bound to its property | REAL as adjudicated; scope challenged (B1), late-409 unpinned (A4) | M-C reset `:225` removed: 1 failed / 82 at `ListingDetail.test.tsx:1448`. M-D effect-based reset: 82/82 survive; probe case 1 red. In-flight write not covered: probe A1 cases red on the branch |
| FW-12 (D9) reachable / defensive paths | REAL | M-J `PlacementsPage.tsx:98` mapping neutralized: 1 failed / 11 (Closed-view Lost case). M-K `TourDetail.tsx:383` mapping dropped: 1 failed / 128 (the DEFENSIVE case) |
| FW-13 (D1/Q3) ownerless sentence | REAL (superseded by SA-1's sentence) | M-E the Q3 sentence put back: 2 failed / 82 (both pins, :1835, :1856) |
| SA-1 dashboard (copy, render) | REAL | M-E above for the copy. M-F `runRosterWrite` success applies the answer with `setUnit` only: 4 failed / 82, including the auto-primary render test (:1572) |
| SA-1 e2e (`property-roster.spec.ts:412-434`) | REAL (by reading + SA1's recorded RED; not run here per brief) | SA1's MR1-before-boot run failed at `:425` (Make primary present). By reading: fails if the server stops auto-promoting; selectors are run-unique and scoped; the read-mode regex is `^`-anchored so the Activity row "Contact added <name>" cannot match |

---

## (D) Swept and clean

- FW-11's render-phase reset (`ListingDetail.tsx:225`): guarded (the reset
  makes its own condition false - no loop), above every early return
  (:283-299), idempotent under StrictMode double render, same-component
  update only; no React Compiler in this build (vite.config.ts); the late 409
  is dropped (probe case 1 green).
- FW-8: an aborted read never sets the flag (probe case 3 green under
  StrictMode); Cancel and "Restore without a landlord" stay live; the copy is
  the planner-confirmed one; `getAllContacts` fails whole (fetchAllPages), so
  there is no partial-list state.
- SA-1 Contacts card: every write applies the server answer
  (`applyRosterUnit`, :407-410) and `listingRoster` re-derives each row's
  primary flag and Make primary control from it (`buildListingFile.ts:49-62`);
  no optimistic primary state; the add still posts `primaryContact: false`
  (:540; pinned :1607). The `state.landlord` fallback row is unused after any
  roster or dialog write (each answer has a non-empty contacts[] or no
  landlordId).
- Ownerless notice vs the server in every state it renders: removeContact
  with no landlordId clears every primary flag and the scalar
  (`unitsRepo.ts:965-971`); the next NEW seat auto-primaries (:836-839);
  "made the primary contact" is the same upsert (:869-871). The `landlordId:
  ''` pin (`ListingDetail.test.tsx:1824`) is a state the real table cannot
  hold (GSI key), the only one where the dashboard and `hasLandlordId` would
  disagree.
- `ContactDetail.onTriage`'s unguarded success path (:681) is safe:
  `useContact.setContact` is forId-guarded. `triaging` not reset per contact
  (FW1 noted) is cosmetic.
- Consumers of the changed state: `restoreUnit` (two callers),
  `contactTypeErrorMessage` (11 call sites incl. the dialog's `run`, each
  keeping its own fallback), `typeChangeRefusalsFrom`
  (two consumers; the only type-PATCH callers are ContactEditForm and
  onTriage), `updateUnit` (ListingEditForm never sends landlordId), the only
  runtime caller of `unitsRepo.addContact` is the route (`units.ts:1149`),
  and the other e2e that posts to a property's contact list
  (`relay-intro-variants.spec.ts:108-121`) uses a property WITH a landlord of
  record, so auto-primary never fires there and its comment stays true.
- No stale ownerless wording ("until a contact is added", "or a landlord is
  added") left in dashboard, e2e, app, RUNBOOK or issues.
- SA-1 e2e: it does not read the POST body, so it cannot tell "server
  decided" from "page asked"; the unit pin (:1607) covers the page side -
  together sufficient.
- p4 `npm test` exit 1 is one app socket error (`connect ENOBUFS`,
  unitsApiRosterTypeChecks); the dashboard workspace was 237 files / 4467
  green. Not attributed to this branch here.

---

## Probe log

Throwaways (dashboard/src/routes/listing/, deleted by exact name before
handback, never committed):
- `zz-review-r2d-listing-nav.test.tsx` - branch: 2 failed / 2 (A1, as
  predicted); with the proposed `useListing.setUnit` guard: 2/2 green and
  `useListing.test.tsx` 9/9; guard reverted.
- `zz-review-r2d-restore.test.tsx` - branch: 3/3 green (case 1 FW-11 late
  409, case 2 A2 silence, case 3 FW-8 StrictMode). Red under M-B (case 3),
  M-C (case 1), M-D (case 1).

Mutants (Edit tool only; sha256 before = after, `git diff` of dashboard/ and
e2e/ empty after each):
- RestoreLandlordDialog.tsx a9c7c662... : M-A, M-B.
- ListingDetail.tsx 977bac86... : M-C, M-D (two edits), M-E, M-F.
- useListing.ts 1bdca179... : proposed fix (A1).
- ContactDetail.tsx 35d9a13f... : M-G, M-H.
- ContactEditForm.tsx e1350aaa... : M-I.
- PlacementsPage.tsx 5ad18ee6... : M-J.
- TourDetail.tsx f6f198b6... : M-K.
