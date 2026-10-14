# Planner review R2 - adversarial (plan-blind), the fix wave and two main merges

Branch `feat/primary-contact-integrity` at `a801d14a` (0 behind main
`e402a053`), worktree `W:\tmp\primary-contact-integrity`. Reviewed since
R1's tip `971c9551`: the code commits 7aea785a, 4d4f4a41, 2b133dab, 30005052,
f18ac75f, fc7607de and b5561c2c; both merges through `git show
--remerge-diff` (ebdd025d, a801d14a); and main's 113-commit range
(`16ca96cc..e402a053`), checked for new readers or writers of the roster, the
primary flag, `landlordId`, `primary_contact`, contact deletion and
`getManyByIds`. Read-only: nothing was run. Plan-blind: no spec, plan or
records worklist was read. The `docs/issues`, `RUNBOOK.md` and
`e2e/support/selectors.md` changes were read as repo artifacts.

Summary: **0 BLOCKING, 0 HIGH, 0 MEDIUM, 2 new LOW.** Both merge resolutions
keep both sides. The fixes are correct, not merely plausible, with one
inherited edge noted at R2-1.

---

## 1. What did we all miss? (new findings)

### R2-1. [LOW] The new delete predicate reads flags, not liveness: a DELETED contact still flagged elsewhere blocks the landlord-delete hand-off, although the property was using the landlord

**What is wrong.** `contactIsPrimaryToHandOff` (`app/src/repos/unitsRepo.ts:900-911`)
sends the landlord of record through `landlordWasPrimary`
(`unitsRepo.ts:876-879`). That rule answers false whenever ANY row is
flagged, live or not. But P1, the property-contact lookup, skips a deleted
flagged row and falls back to the landlord (`app/src/lib/propertyContact.ts:164-171`,
`:184-189`). So on a roster `[D (flagged, soft-deleted), L (landlord of
record, unflagged), PM (typed landlord)]`, P1 resolves to L. Deleting L then:

- the Scan does not target the unit (`app/src/services/primaryHandoff.ts:97`);
- after the delete P1 answers nobody (`deleted`);
- PM is never promoted.

This is the restore-side "shape 3" class
(`docs/issues/roster-liveness-read-eventual-consistency.md`) now carried onto
the delete path that F2 was meant to make agree.

**Reachable.** D stays flagged when its own delete hand-off found no heir,
answered `unknown`, or lost its retries. The common case is any primary
deleted BEFORE this branch deploys, because on main a delete touches no
roster: these are the very properties the branch exists for. Between the
deploy and the backfill apply, deleting the landlord of such a property
strands it. The backfill repairs it if it runs afterwards (flagged D is not
live, so `chooseHeir` picks PM). That self-heal is why this is LOW.

**Suggested fix.** In the predicate's landlord branch, treat a flagged row as
"elsewhere" only when it is live. The Scan cannot read liveness cheaply, so
let it target every unit where `contactId === landlordId`, a cheap superset.
Then have `handOffPrimaryFrom`, which already reads liveness, answer
`not_primary` when a LIVE flagged row other than L exists. That costs one
batch read per such unit and no extra writes. Alternatively, accept it and
name the window in the RUNBOOK backfill section ("run the apply promptly
after the deploy").

**Related nit (not counted).** For L, `landlordWasPrimary` uses
`some(row is L and flagged)`. The non-landlord branch and P1 use the FIRST
flagged row (`find`). On a legacy roster with two flagged rows `[P, L]`,
deleting L targets the unit and can move the primary off P, the live contact
P1 was using. Multi-flag rosters should not exist since BE3/C3, hence no
finding.

### R2-2. [LOW] The box's one-click sends the row's stored role: a role-`landlord` row that is not the landlord of record gets a 409 with "reassign" copy, or, on an ownerless property, silently becomes the landlord of record

**What is wrong.** "Make <Name> primary" calls `onMakePrimaryContact(soleAutoEligible, ...)`
(`dashboard/src/routes/listing/ListingDetail.tsx:1104`), which posts
`role: row.role` (`:646-650`). In `addContact` (`app/src/repos/unitsRepo.ts:1216`, `:1243-1248`):

- with a landlord of record that is someone else: `role: 'landlord'` throws
  `LandlordReassignmentRequiredError`. The box then shows
  `LANDLORD_REASSIGNMENT_COPY`, "reassign it before choosing Landlord". The
  operator chose no role, and the dashboard has no landlord-reassign UI.
- on an ownerless property: the same post is a CLAIM. It sets `landlordId` to
  that contact as a side effect of a button that says only "make primary".

**Reachable?** Only API-only. `autoEligible` guarantees a live typed-landlord
row (`app/src/routes/units.ts:661`). A role-`landlord` row that is not the
landlord of record arises only after `PATCH /api/units/:id { landlordId }`
(`units.ts:2186-2205`; it never touches `contacts`), optionally followed by a
"Restore without a landlord" (which drops only the old landlord's row). No
dashboard screen PATCHes `landlordId`. Edit mode's per-row Make primary has
had the identical behavior since before this branch. LOW.

**Suggested fix.** For a primary-only change, send the row's role unless it is
`landlord` on a row that is not `unit.landlordId`. Or let the server ignore a
role it would refuse when the request only asks for `primaryContact: true` on
an existing seat.

### Swept and clean (no finding)

- **Consumers of `autoEligible`:** server `enrichRosterView` only, on the
  complete read (`units.ts:661`), so it is absent on an incomplete read and
  on restore answers (`enrichRoster`). Dashboard: `listingRoster` passes it
  through (`buildListingFile.ts`). The box is the only reader
  (`ListingDetail.tsx:542-544`). `PlacementDetail.setUnit` keeps the
  load-time rows, flags included. No client sends a row back. The People
  card suggestions ignore it.
- **Consumers of `contactIsPrimaryToHandOff`:** the Scan (`primaryHandoff.ts:97`),
  `handOffPrimaryFrom`'s re-check on every attempt (`unitsRepo.ts:1784`), so a
  lost write re-decides, and the FakeWorld mirror. It cannot target every
  no-flag unit: the landlord branch needs `contactId === landlordId`. An
  off-roster landlord of record on a no-flag stored list is targeted and
  `chooseHeir` excludes it, so the heir comes from the roster. A
  landlord-only (derived-row) unit is targeted and answers `unchanged` with no
  write. A soft-deleted unit is handled like a live one, and a later restore
  keeps the heir (`landlordWasPrimary` sees the heir flagged). The deleted
  contact can never be the heir: `exclude` applies at every step.
- **ConsistentRead (F5a):** `batchGetByIds` rebuilds `RequestItems` with
  `ConsistentRead: true` on every send, for each 100-key chunk and each
  `UnprocessedKeys` retry (`app/src/repos/contactsRepo.ts:1010-1020`).
  `getManyByIds` is the only implementation (`:1339-1344`). Both restore reads
  ask for it: `clearedLandlordHeir` (`units.ts:712`) and the per-attempt
  `readContacts` handed to `restoreWithLandlord` (`units.ts:2434`). Every
  other caller keeps the old default (`opts.consistentRead === true` is false
  on `undefined`).
- **Merge ebdd025d:** `units.ts` keeps both import blocks and the merged
  Activity type list. `toUnitActivityEvent` still lifts `reason` for
  `unit_primary_contact_assigned` only. Main's listing-outcome events carry
  no `reason`. `dev.ts` has both fixtures (zero-primary `:1350-1430`,
  listing-send `:1432`) and both deps. `types.ts` and `listingFormat.ts` have
  both event lists. `OUTCOME_LABELS` is consulted before the switch, but no
  outcome key collides with `unit_primary_contact_assigned`. The test file
  keeps both describes.
- **Merge a801d14a:** RUNBOOK only. Both backfill sections are present, with
  main's DONE text for last-heard-from.
- **Main's 113 commits:** add no roster, primary or `landlordId` writer. The
  importer change is last-heard-from stamping only, and it still never writes
  unit `contacts`, so R1's `updated_at` ownership reasoning holds. The new
  `getManyByIds(..., { requireComplete: true })` caller is
  signature-compatible. The DELETE contact route is unchanged by main.
- **Copy and docs:** no stale copy of the old box line, script lines or Delete
  sentence survives outside the gitignored `.superpowers/` drafts.
  `selectors.md` and RUNBOOK describe the four box cases as built.

---

## 2. The fix diffs, reviewed cold

- **F1 (7aea785a + 2b133dab + 30005052): correct.**
  - The flag is `isAutoRoutingEligible` on the same complete read, so it
    cannot drift from auto-primary or `chooseHeir`.
  - The box offers a one-click only for exactly one `autoEligible` row. That
    row is never the flagged primary and never a live landlord of record,
    since either would make P1 "found" and hide the box.
  - Two or more `autoEligible` rows, or none with a live non-caseworker row,
    show "Choose a primary". None with no such row shows the line only.
  - One-click writes the server can still refuse: a 409
    `primary_contact_deleted` if the contact was deleted since the page loaded
    (correct copy), and R2-2.
  - Hiding: with exactly one `autoEligible` row the box shows no "Choose a
    primary", so staff wanting a different person go through "Edit contacts".
    It is not hidden, so no finding.
- **F3 (4d4f4a41): correct.** "Add a property manager or owner" is true in
  every state the box shows: no live flagged primary and no live landlord of
  record, so a typed-landlord add with a non-landlord role is promoted. That
  holds except for the eventual-consistency staleness already filed. It also
  avoids the 409 that a Landlord-role add gets while a deleted contact holds
  `landlordId`.
- **F2 (f18ac75f): correct for every single-flag roster** (see the sweep
  above), with the inherited flag-not-liveness edge (R2-1).
- **F5a (fc7607de): correct and complete** for the two restore reads.
- **F5b (b5561c2c): accurate.** "when someone can" now matches `unchanged`.

---

## 3. Your adjudications of R1

- **R1-1 (MEDIUM):** closed as specified, verified above. The edit mode's
  type-agnostic per-row button is the human's ruling; not contested.
- **R1-2 (in-request Scan, no retry):** concede. F2 widens the targets to
  every no-flag unit the deleted landlord owns, but holdings stay small; no
  concrete harm to show today.
- **R1-3 (consistent reads, restore only):** concede. F4's interleaving fails
  even with consistent reads, so extending it buys little.
- **R1-4 (stale scalar), R1-5 (import cycle), R1-6 (duplication, ladder pin):**
  concede all three. Nothing routes on the scalar, there are no top-level
  reads, and the debt is filed.
- **R1-7 (backfill counts and audits unbroken no-flag units) and R1-9 (no
  route-level test with the real repos for the delete hand-off):** not in
  your adjudication list; both still stand as LOW. F2 added FakeWorld route
  tests and DynamoDB Local repo tests, but still no real-wiring route test.
- **R1-8 (Delete-dialog copy):** closed by F5b.

---

## 4. Verdict on the fixes

Correct, not merely plausible: each one is enforced at the decision point
the server and FakeWorld share, and re-decided on retry. The open points are
two LOW edges (R2-1, R2-2), neither reachable from the dashboard alone except
R2-1 in the window between deploy and the backfill apply.
